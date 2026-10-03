"""Phase 1 correctness tests. Each one failed against the pre-Phase-1 code."""
from __future__ import annotations

import json

import pytest

from app.llm.evaluator import EvalRun
from app.llm.mock import MockProvider
from app.llm.prompts import load_prompts
from app.pipeline import AuditEngine
from app.rules.idle import evaluate_idle
from app.scoring.quality import compute_quality
from app.scoring.routing import route
from app.scoring.score import aggregate, temperature_series
from tests.conftest import DAY, REFERENCE, item, make_case


# ------------------------------------------------------------------ helpers
def _temp_run(readings, idx=0, status="OK"):
    res = {"status": status, "score": readings[-1] if readings else None,
           "readings": [{"ref_id": f"E{i + 1}", "score": s} for i, s in enumerate(readings)]}
    return EvalRun(rubric="temperature", run_index=idx, status=status, result=res)


def _llm_run(rubric, score, idx=0, status="OK"):
    return EvalRun(rubric=rubric, run_index=idx, status=status, result={"status": status, "score": score})


@pytest.fixture(scope="module")
def audits(settings, redactor, ingest):
    engine = AuditEngine(settings, MockProvider(), redactor, load_prompts(settings.root / "prompts"))
    return {raw.case_number: engine.audit(raw, ingest.roster, REFERENCE) for raw in ingest.cases}


# ------------------------------------------------------------------ item 1: runs completed / requested
def test_llm_cards_store_completed_and_requested_runs(audits):
    a = audits["00100001"]
    t = a.llm["troubleshooting"]
    assert t["requested_runs"] == 2 and t["completed_runs"] == 2
    assert t["score"] == 5            # the score is a separate field, never the run count


def test_failed_run_counts_as_requested_not_completed(settings):
    runs = [_llm_run("troubleshooting", 4, 0), EvalRun("troubleshooting", 1, "FAILED")]
    agg = aggregate("troubleshooting", runs, 1)
    assert (agg.requested_runs, agg.completed_runs) == (2, 1)


# ------------------------------------------------------------------ item 2: missing data never inflates scores
def test_idle_with_untimed_customer_facing_items_is_insufficient(settings):
    case = make_case([item("E1", "email", "in", 0, body="x"), item("E2", minutes=None)],
                     closed_minutes=2 * DAY, opened=None)
    r = evaluate_idle(case, settings.rules, REFERENCE)
    assert r.status == "INSUFFICIENT_DATA" and r.missing_data


def test_fixture_00100016_not_idle_10_scored_partially_and_routed(audits):
    a = audits["00100016"]
    dims = {d["dimension"]: d for d in a.dimensions}
    assert dims["idle"]["status"] == "EXCLUDED" and dims["idle"]["score"] is None
    assert a.scored_dimensions < a.applicable_dimensions
    codes = [r["code"] for r in a.review_reasons]
    assert codes.count("INSUFFICIENT_DATA") == 1


def test_excluded_dimension_explains_why(audits):
    dims = {d["dimension"]: d for d in audits["00100016"].dimensions}
    assert "open time missing" in dims["slo"]["note"]
    assert dims["three_strike"]["note"] == "Not applicable"


# ------------------------------------------------------------------ items 3 + 4: temperature, one source; trajectory
@pytest.mark.parametrize("series,trajectory,hot", [
    ([1, 3, 1], "stable", False),
    ([1, 4, 1], "stable", True),       # peak >= 4
    ([2, 3], "worsening", True),       # end > start
    ([3, 1], "improving", False),
])
def test_trajectory_end_vs_start_and_hot_customer(settings, series, trajectory, hot):
    agg = aggregate("temperature", [_temp_run(series, 0), _temp_run(series, 1)], 1)
    assert agg.trajectory == trajectory
    assert (agg.temp_start, agg.temp_end, agg.temp_peak) == (series[0], series[-1], max(series))
    reasons = route("OK", 8.0, slo_status="MET", strike_status="NOT_APPLICABLE", temp_end=agg.temp_end,
                    temp_start=agg.temp_start, temp_peak=agg.temp_peak, cfg=settings.review)
    assert ("HOT_CUSTOMER" in [r["code"] for r in reasons]) is hot


def test_temperature_series_orders_by_reading(settings):
    assert temperature_series({"readings": [{"ref_id": "E1", "score": 2}, {"ref_id": "E2", "score": 4}]}) == [2, 4]


def test_case_00100002_temperature_one_source(audits):
    a = audits["00100002"]
    t = a.llm["temperature"]
    dims = {d["dimension"]: d for d in a.dimensions}
    # Card and table read the same stored values.
    assert (t["temp_start"], t["temp_end"], t["temp_peak"]) == (a.temp_start, a.temp_end, a.temp_peak)
    assert t["trajectory"] == "stable" and dims["temperature_handling"]["input"] == "stable"
    assert dims["temperature_handling"]["score"] == 5.0   # current formula: stable -> 3/5 -> 5.0
    assert "HOT_CUSTOMER" not in [r["code"] for r in a.review_reasons]


# ------------------------------------------------------------------ item 5: completeness, agreement, heuristic
def test_quality_split_and_heuristic_flag(audits):
    a = audits["00100016"]
    assert a.data_completeness == pytest.approx(0.70)
    assert a.is_heuristic is True
    assert audits["00100001"].data_completeness == 1.0


@pytest.mark.parametrize("scores,disagree", [
    ([3, 5], True),          # range >= 2
    ([4, 5], True),          # 1 of 2 runs share the mode -> 50% < 75%
    ([4, 4, 5, 4], False),   # 75% agree, range 1
    ([4, 4], False),
])
def test_evaluator_disagreement_with_synthetic_runs(settings, scores, disagree):
    llm = {"troubleshooting": aggregate("troubleshooting",
                                        [_llm_run("troubleshooting", s, i) for i, s in enumerate(scores)], 1)}
    q = compute_quality(llm, [], 5, settings.scoring, settings.review)
    assert q.disagreement is disagree
    reasons = route("OK", 8.0, slo_status="MET", strike_status="NOT_APPLICABLE",
                    disagreement=q.disagreement, cfg=settings.review)
    assert ("EVALUATOR_DISAGREEMENT" in [r["code"] for r in reasons]) is disagree


def test_low_completeness_and_excluded_dimension_give_one_chip(settings):
    reasons = route("OK", 8.0, slo_status="INSUFFICIENT_DATA", strike_status="NOT_APPLICABLE",
                    data_completeness=0.5, excluded_for_missing=["slo", "idle"], cfg=settings.review)
    assert [r["code"] for r in reasons] == ["INSUFFICIENT_DATA"]


# ------------------------------------------------------------------ item 9: plurals
def test_summaries_use_correct_plurals(audits):
    text = json.dumps({k: a.llm for k, a in audits.items()})
    for bad in ("1 calls", "1 emails", "1 support emails", "1 repeated request types", "(s)"):
        assert bad not in text


# ------------------------------------------------------------------ acceptance numbers + queue
def test_queue_has_8_cases_and_tse_extremes(audits):
    queued = sorted(n for n, a in audits.items() if a.review_reasons)
    assert queued == ["00100002", "00100004", "00100005", "00100006", "00100011", "00100013",
                      "00100015", "00100016"]
    by_owner: dict[str, list[float]] = {}
    for a in audits.values():
        by_owner.setdefault(a.case.owner_label, []).append(a.overall)
    avg = {k: sum(v) / len(v) for k, v in by_owner.items()}
    assert min(avg, key=avg.get) == "Daniel Osei" and abs(avg["Daniel Osei"] - 5.6) <= 0.1
    assert max(avg, key=avg.get) == "Marta Lindqvist" and avg["Marta Lindqvist"] > 8.2
