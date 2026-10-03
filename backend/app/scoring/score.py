"""Dimension scores and the weighted overall /10."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from app.llm.evaluator import EvalRun
from app.rules.results import IdleResult, SloResult, ThreeStrikeResult


@dataclass
class DimAgg:
    """Aggregate of the repeated runs of one LLM rubric."""
    rubric: str
    runs: list[EvalRun]
    status: str = "FAILED"            # OK | INSUFFICIENT_EVIDENCE | FAILED
    score: Optional[float] = None     # mean of OK runs (1-5)
    requested_runs: int = 0
    completed_runs: int = 0           # runs that returned a valid result (OK or INSUFFICIENT_EVIDENCE)
    run_scores: list[Optional[int]] = field(default_factory=list)
    # Temperature only: one source for the context label and the handling dimension.
    temp_start: Optional[float] = None
    temp_end: Optional[float] = None
    temp_peak: Optional[float] = None
    trajectory: Optional[str] = None


def temperature_series(result: dict[str, Any]) -> list[int]:
    """Chronological per-message temperature readings (already validated and ordered)."""
    return [int(r["score"]) for r in (result or {}).get("readings", [])]


def _trajectory(start: float, end: float) -> str:
    """Trajectory = end vs start. The peak is tracked separately and never sets the trajectory."""
    if end > start:
        return "worsening"
    if end < start:
        return "improving"
    return "stable"


def aggregate(rubric: str, runs: list[EvalRun], max_gap: float = 1) -> DimAgg:
    agg = DimAgg(rubric=rubric, runs=runs, requested_runs=len(runs))
    agg.completed_runs = sum(1 for r in runs if r.status != "FAILED")
    agg.run_scores = [r.result.get("score") if r.result else None for r in runs]
    if any(r.status == "FAILED" for r in runs):
        return agg
    ok = [r for r in runs if r.status == "OK"]
    if not ok:
        agg.status = "INSUFFICIENT_EVIDENCE"
        return agg
    agg.status = "OK"
    if rubric == "temperature":
        series = [temperature_series(r.result) for r in ok]
        series = [s for s in series if s]
        if not series:
            agg.status = "INSUFFICIENT_EVIDENCE"
            return agg
        n = len(series)
        agg.temp_start = round(sum(s[0] for s in series) / n, 2)
        agg.temp_end = round(sum(s[-1] for s in series) / n, 2)
        agg.temp_peak = round(sum(max(s) for s in series) / n, 2)
        agg.trajectory = _trajectory(agg.temp_start, agg.temp_end)
        agg.score = agg.temp_end
        return agg
    scores = [r.result["score"] for r in ok]
    agg.score = round(sum(scores) / len(scores), 2)
    return agg


def normalize(score_1_5: float, mode: str) -> float:
    if mode == "times_two":
        return round(score_1_5 * 2, 2)
    return round((score_1_5 - 1) * 2.5, 2)


def handling_score(temp: DimAgg, cfg: dict[str, Any]) -> Optional[float]:
    """Temperature handling on the 1-5 scale. Default mode = current formula (trajectory map)."""
    th = cfg.get("temperature_handling", {})
    mode = th.get("mode", "trajectory_map")
    if temp.status != "OK" or temp.trajectory is None:
        return None
    if mode == "outcome_based":
        o = th.get("outcome_scores", {})
        calm_max = float(th.get("calm_at_most", 2))
        if temp.trajectory == "improving":
            return float(o.get("de_escalated", 5))
        if temp.trajectory == "worsening":
            return float(o.get("escalated", 1))
        return float(o.get("stable_calm", 5) if temp.temp_end <= calm_max else o.get("stable_elevated", 2))
    scores = th.get("trajectory_scores", {})
    return float(scores[temp.trajectory]) if temp.trajectory in scores else None


def _exclusion_note(status: str, reason: str = "") -> str:
    if status == "NOT_APPLICABLE":
        return "Not applicable"
    if status == "INSUFFICIENT_EVIDENCE":
        return "Not enough evidence in the case"
    if status == "INSUFFICIENT_DATA":
        return f"Insufficient data – {reason}" if reason else "Insufficient data"
    if status in ("FAILED", "NOT_RUN"):
        return "Evaluation failed"
    return ""


def compute_dimensions(slo: SloResult, idle: IdleResult, strike: ThreeStrikeResult,
                       llm: dict[str, DimAgg], cfg: dict[str, Any]) -> list[dict[str, Any]]:
    weights = cfg["weights"]
    mode = cfg.get("normalization", "linear_0_10")
    det = cfg.get("deterministic", {})
    dims: list[dict[str, Any]] = []

    def add(name, label, raw, score, note="", missing_data=False):
        dims.append({
            "dimension": name, "label": label, "input": raw,
            "status": "SCORED" if score is not None else "EXCLUDED",
            "score": score, "weight": float(weights.get(name, 0)), "effective_weight": 0.0,
            "note": "" if score is not None else note, "missing_data": missing_data,
        })

    for name, label in (("troubleshooting", "Troubleshooting"), ("communication", "Communication")):
        a = llm.get(name)
        if a and a.status == "OK":
            add(name, label, f"{a.score:g}/5", normalize(a.score, mode))
        else:
            st = a.status if a else "NOT_RUN"
            add(name, label, st, None, _exclusion_note(st))

    for name, label, res in (("slo", "SLO initial response", slo), ("idle", "Idle", idle),
                             ("three_strike", "3-strike rule", strike)):
        score = det.get(name, {}).get(res.status)
        add(name, label, res.status, score, _exclusion_note(res.status, res.reason), res.missing_data)

    temp = llm.get("temperature")
    hs = handling_score(temp, cfg) if temp else None
    if hs is not None:
        add("temperature_handling", "Temperature handling", temp.trajectory, normalize(hs, mode))
    else:
        st = temp.status if temp else "NOT_RUN"
        add("temperature_handling", "Temperature handling", st, None, _exclusion_note(st))

    total = sum(d["weight"] for d in dims if d["status"] == "SCORED")
    for d in dims:
        if d["status"] == "SCORED" and total > 0:
            d["effective_weight"] = round(d["weight"] / total, 4)
    return dims


def coverage(dims: list[dict[str, Any]]) -> tuple[int, int]:
    """(scored, applicable): 'Scored on X of Y dimensions'. Not-applicable dimensions don't count."""
    applicable = [d for d in dims if d["input"] != "NOT_APPLICABLE" and d["weight"] > 0]
    return sum(1 for d in applicable if d["status"] == "SCORED"), len(applicable)


def overall_score(dims: list[dict[str, Any]]) -> Optional[float]:
    scored = [d for d in dims if d["status"] == "SCORED" and d["weight"] > 0]
    total = sum(d["weight"] for d in scored)
    if not scored or total <= 0:
        return None
    return round(sum(d["score"] * d["weight"] for d in scored) / total, 2)
