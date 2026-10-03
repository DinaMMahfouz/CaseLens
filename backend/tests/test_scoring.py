from __future__ import annotations

import copy

from app.llm.evaluator import EvalRun
from app.rules.results import IdleResult, SloResult, ThreeStrikeResult
from app.scoring.quality import compute_quality
from app.scoring.routing import route
from app.scoring.score import aggregate, compute_dimensions, coverage, normalize, overall_score


def _run(rubric, score, status="OK", idx=0):
    return EvalRun(rubric=rubric, run_index=idx, status=status, result={"status": status, "score": score})


def _temp(series, idx=0):
    res = {"status": "OK", "score": series[-1],
           "readings": [{"ref_id": f"E{i}", "score": s} for i, s in enumerate(series)]}
    return EvalRun(rubric="temperature", run_index=idx, status="OK", result=res)


def _llm(t=(4, 4), c=(3, 3), temp=(2, 2)):
    return {
        "troubleshooting": aggregate("troubleshooting", [_run("troubleshooting", s, idx=i) for i, s in enumerate(t)]),
        "communication": aggregate("communication", [_run("communication", s, idx=i) for i, s in enumerate(c)]),
        "temperature": aggregate("temperature", [_temp(list(temp), 0), _temp(list(temp), 1)]),
    }


SLO_MET = SloResult(status="MET")
IDLE_OK = IdleResult(status="NO_SUPPORT_IDLE", threshold_days=5)
STRIKE_NA = ThreeStrikeResult(status="NOT_APPLICABLE", required=3)


def test_normalization_modes():
    assert normalize(1, "linear_0_10") == 0 and normalize(3, "linear_0_10") == 5 and normalize(5, "linear_0_10") == 10
    assert normalize(3, "times_two") == 6


def test_weighted_overall_with_not_applicable_renormalized(settings):
    dims = compute_dimensions(SLO_MET, IDLE_OK, STRIKE_NA, _llm(), settings.scoring)
    by = {d["dimension"]: d for d in dims}
    assert by["three_strike"]["status"] == "EXCLUDED" and by["three_strike"]["note"] == "Not applicable"
    # temperature series [2, 2] -> stable -> 3/5 -> 5.0 (current formula)
    expected = (7.5 * 30 + 5 * 20 + 10 * 20 + 10 * 15 + 5 * 5) / 90
    assert overall_score(dims) == round(expected, 2)
    assert abs(sum(d["effective_weight"] for d in dims) - 1) < 0.001
    assert coverage(dims) == (5, 5)


def test_breach_and_incorrect_score_zero(settings):
    dims = compute_dimensions(SloResult(status="BREACHED"), IdleResult(status="SUPPORT_IDLE", threshold_days=5),
                              ThreeStrikeResult(status="APPLIED_INCORRECTLY", required=3), _llm(), settings.scoring)
    by = {d["dimension"]: d for d in dims}
    assert by["slo"]["score"] == 0 and by["idle"]["score"] == 0 and by["three_strike"]["score"] == 0


def test_insufficient_data_excluded_with_reason(settings):
    slo = SloResult(status="INSUFFICIENT_DATA", reason="case open time missing", missing_data=True)
    dims = {d["dimension"]: d for d in compute_dimensions(slo, IDLE_OK, STRIKE_NA, _llm(), settings.scoring)}
    assert dims["slo"]["status"] == "EXCLUDED" and dims["slo"]["missing_data"]
    assert dims["slo"]["note"] == "Insufficient data – case open time missing"


def test_temperature_handling_modes(settings):
    worsening = _llm(temp=(1, 3))          # end > start
    by = {d["dimension"]: d for d in compute_dimensions(SLO_MET, IDLE_OK, STRIKE_NA, worsening, settings.scoring)}
    assert by["temperature_handling"]["input"] == "worsening" and by["temperature_handling"]["score"] == 0
    cfg = copy.deepcopy(settings.scoring)
    cfg["temperature_handling"]["mode"] = "outcome_based"
    stable_high = _llm(temp=(4, 4))
    by = {d["dimension"]: d for d in compute_dimensions(SLO_MET, IDLE_OK, STRIKE_NA, stable_high, cfg)}
    assert by["temperature_handling"]["score"] == normalize(2, "linear_0_10")


def test_data_completeness(settings):
    q = compute_quality(_llm(), [], 5, settings.scoring, settings.review)
    assert q.data_completeness == 1.0 and q.run_agreement == 1.0 and not q.disagreement
    q = compute_quality(_llm(), ["severity"], 2, settings.scoring, settings.review)
    assert q.data_completeness == 0.7
    assert [r["code"] for r in q.completeness_reasons] == ["MISSING_FIELD", "SHORT_CASE"]


def test_routing_reasons(settings):
    r = route("OK", 3.5, slo_status="BREACHED", strike_status="APPLIED_INCORRECTLY", temp_start=2,
              temp_end=4.5, temp_peak=4.5, cfg=settings.review)
    assert [x["code"] for x in r] == ["LOW_SCORE", "RULE_BREACH", "HOT_CUSTOMER"]
    assert "SLO" in r[1]["detail"] and "3-strike" in r[1]["detail"]
    assert route("OK", 8, slo_status="MET", strike_status="NOT_APPLICABLE", temp_start=2, temp_end=2,
                 temp_peak=2, cfg=settings.review) == []
    assert [x["code"] for x in route("EVAL_FAILED", None, cfg=settings.review)] == ["EVAL_FAILED"]
    assert [x["code"] for x in route("REDACTION_FAILED", None, cfg=settings.review)] == ["REDACTION_FAILED"]
