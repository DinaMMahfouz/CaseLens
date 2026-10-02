"""Dimension scores and the weighted overall /10."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from app.llm.evaluator import EvalRun
from app.rules.results import IdleResult, SloResult, ThreeStrikeResult

TRAJECTORY_RANK = {"improving": 0, "stable": 1, "worsening": 2}


@dataclass
class DimAgg:
    """Aggregate of the repeated runs of one LLM rubric."""
    rubric: str
    runs: list[EvalRun]
    status: str = "FAILED"            # OK | INSUFFICIENT_EVIDENCE | FAILED
    score: Optional[float] = None     # mean of OK runs (1-5)
    disagreement: bool = False
    trajectory: Optional[str] = None  # temperature only: worst of the runs
    run_scores: list[Optional[int]] = field(default_factory=list)


def aggregate(rubric: str, runs: list[EvalRun], max_gap: float) -> DimAgg:
    agg = DimAgg(rubric=rubric, runs=runs)
    if any(r.status == "FAILED" for r in runs):
        return agg
    ok = [r for r in runs if r.status == "OK"]
    agg.run_scores = [r.result.get("score") if r.result else None for r in runs]
    if not ok:
        agg.status = "INSUFFICIENT_EVIDENCE"
        return agg
    scores = [r.result["score"] for r in ok]
    agg.status = "OK"
    agg.score = round(sum(scores) / len(scores), 2)
    agg.disagreement = len(scores) > 1 and (max(scores) - min(scores)) > max_gap
    if rubric == "temperature":
        trajs = [r.result.get("trajectory") for r in ok if r.result.get("trajectory")]
        if trajs:
            agg.trajectory = max(trajs, key=lambda t: TRAJECTORY_RANK[t])
            if len(set(trajs)) > 1:
                agg.disagreement = True
    return agg


def normalize(score_1_5: float, mode: str) -> float:
    if mode == "times_two":
        return round(score_1_5 * 2, 2)
    return round((score_1_5 - 1) * 2.5, 2)


def compute_dimensions(slo: SloResult, idle: IdleResult, strike: ThreeStrikeResult,
                       llm: dict[str, DimAgg], cfg: dict[str, Any]) -> list[dict[str, Any]]:
    weights = cfg["weights"]
    mode = cfg.get("normalization", "linear_0_10")
    det = cfg.get("deterministic", {})
    dims: list[dict[str, Any]] = []

    def add(name, label, raw, score):
        dims.append({
            "dimension": name, "label": label, "input": raw,
            "status": "SCORED" if score is not None else "EXCLUDED",
            "score": score, "weight": float(weights.get(name, 0)), "effective_weight": 0.0,
        })

    for name, label in (("troubleshooting", "Troubleshooting"), ("communication", "Communication")):
        a = llm.get(name)
        if a and a.status == "OK":
            add(name, label, f"{a.score:g}/5", normalize(a.score, mode))
        else:
            add(name, label, a.status if a else "NOT_RUN", None)

    add("slo", "SLO initial response", slo.status, det.get("slo", {}).get(slo.status))
    add("idle", "Idle", idle.status, det.get("idle", {}).get(idle.status))
    add("three_strike", "3-strike rule", strike.status, det.get("three_strike", {}).get(strike.status))

    temp = llm.get("temperature")
    traj_scores = cfg.get("temperature_handling", {}).get("trajectory_scores", {})
    if temp and temp.status == "OK" and temp.trajectory in traj_scores:
        add("temperature_handling", "Temperature handling", temp.trajectory,
            normalize(float(traj_scores[temp.trajectory]), mode))
    else:
        add("temperature_handling", "Temperature handling", temp.status if temp else "NOT_RUN", None)

    total = sum(d["weight"] for d in dims if d["status"] == "SCORED")
    for d in dims:
        if d["status"] == "SCORED" and total > 0:
            d["effective_weight"] = round(d["weight"] / total, 4)
    return dims


def overall_score(dims: list[dict[str, Any]]) -> Optional[float]:
    scored = [d for d in dims if d["status"] == "SCORED" and d["weight"] > 0]
    total = sum(d["weight"] for d in scored)
    if not scored or total <= 0:
        return None
    return round(sum(d["score"] * d["weight"] for d in scored) / total, 2)
