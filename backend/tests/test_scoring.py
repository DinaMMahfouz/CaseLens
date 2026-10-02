from __future__ import annotations

from app.llm.evaluator import EvalRun
from app.rules.results import IdleResult, SloResult, ThreeStrikeResult
from app.scoring.confidence import compute_confidence
from app.scoring.routing import route
from app.scoring.score import aggregate, compute_dimensions, normalize, overall_score


def _run(rubric, score, status="OK", idx=0, retries=0, dropped=0, trajectory=None):
    res = {"status": status, "score": score}
    if trajectory:
        res["trajectory"] = trajectory
    return EvalRun(rubric=rubric, run_index=idx, status=status, result=res, retries=retries, dropped_findings=dropped)


def _llm(t=(4, 4), c=(3, 3), temp=(2, 2), traj="stable"):
    return {
        "troubleshooting": aggregate("troubleshooting", [_run("troubleshooting", s, idx=i) for i, s in enumerate(t)], 1),
        "communication": aggregate("communication", [_run("communication", s, idx=i) for i, s in enumerate(c)], 1),
        "temperature": aggregate("temperature", [_run("temperature", s, idx=i, trajectory=traj) for i, s in enumerate(temp)], 1),
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
    assert by["three_strike"]["status"] == "EXCLUDED"
    # weights 30,20,20,15,5 (three_strike 10 excluded) -> total 90
    expected = (7.5 * 30 + 5 * 20 + 10 * 20 + 10 * 15 + 5 * 5) / 90
    assert overall_score(dims) == round(expected, 2)
    assert abs(sum(d["effective_weight"] for d in dims) - 1) < 0.001


def test_breach_and_incorrect_score_zero(settings):
    dims = compute_dimensions(SloResult(status="BREACHED"), IdleResult(status="SUPPORT_IDLE", threshold_days=5),
                              ThreeStrikeResult(status="APPLIED_INCORRECTLY", required=3), _llm(), settings.scoring)
    by = {d["dimension"]: d for d in dims}
    assert by["slo"]["score"] == 0 and by["idle"]["score"] == 0 and by["three_strike"]["score"] == 0


def test_insufficient_data_excluded(settings):
    dims = compute_dimensions(SloResult(status="INSUFFICIENT_DATA"), IDLE_OK, STRIKE_NA, _llm(), settings.scoring)
    assert {d["dimension"]: d["status"] for d in dims}["slo"] == "EXCLUDED"


def test_temperature_handling_uses_worse_trajectory(settings):
    llm = _llm()
    llm["temperature"] = aggregate("temperature", [_run("temperature", 3, trajectory="stable"),
                                                   _run("temperature", 3, idx=1, trajectory="worsening")], 1)
    assert llm["temperature"].trajectory == "worsening" and llm["temperature"].disagreement
    by = {d["dimension"]: d for d in compute_dimensions(SLO_MET, IDLE_OK, STRIKE_NA, llm, settings.scoring)}
    assert by["temperature_handling"]["score"] == 0


def test_confidence_starts_high_and_drops(settings):
    score, level, reasons = compute_confidence(_llm(), [], [], 5, settings.scoring)
    assert (score, level, reasons) == (1.0, "HIGH", [])
    score, level, reasons = compute_confidence(_llm(t=(2, 5)), [], ["severity"], 2, settings.scoring)
    codes = {r["code"] for r in reasons}
    assert codes == {"RUN_DISAGREEMENT", "MISSING_FIELD", "SHORT_CASE"}
    assert score == 0.5 and level == "MEDIUM"


def test_confidence_counts_retries_dropped_and_insufficient(settings):
    llm = _llm()
    llm["communication"] = aggregate("communication", [_run("communication", None, status="INSUFFICIENT_EVIDENCE"),
                                                       _run("communication", None, status="INSUFFICIENT_EVIDENCE", idx=1)], 1)
    llm["troubleshooting"].runs[0].retries = 1
    llm["troubleshooting"].runs[0].dropped_findings = 2
    score, level, reasons = compute_confidence(llm, [], [], 5, settings.scoring)
    assert round(score, 3) == round(1 - 0.2 - 0.1 - 0.1, 3) and level == "MEDIUM"


def test_routing_reasons(settings):
    r = route("OK", 3.5, "LOW", "BREACHED", "APPLIED_INCORRECTLY", 4.5, "worsening", settings.review)
    assert [x["code"] for x in r] == ["LOW_SCORE", "LOW_CONFIDENCE", "RULE_BREACH", "RULE_BREACH", "HOT_CUSTOMER"]
    assert route("OK", 8, "HIGH", "MET", "NOT_APPLICABLE", 2, "stable", settings.review) == []
    assert [x["code"] for x in route("OK", 8, "HIGH", "MET", None, 2, "worsening", settings.review)] == ["HOT_CUSTOMER"]
    assert [x["code"] for x in route("EVAL_FAILED", None, "HIGH", "MET", None, None, None, settings.review)] == ["EVAL_FAILED"]
    assert [x["code"] for x in route("REDACTION_FAILED", None, None, None, None, None, None, settings.review)] == ["REDACTION_FAILED"]
