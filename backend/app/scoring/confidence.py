"""Computed confidence. Never self-reported by the LLM."""
from __future__ import annotations

from typing import Any, Optional

from app.llm.evaluator import EvalRun
from app.scoring.score import DimAgg


def compute_confidence(llm: dict[str, DimAgg], closure_runs: list[EvalRun], missing_fields: list[str],
                       communications: int, cfg: dict[str, Any]) -> tuple[float, str, list[dict[str, Any]]]:
    c = cfg["confidence"]
    p = c["penalties"]
    reasons: list[dict[str, Any]] = []

    def hit(code: str, detail: str, penalty: float):
        reasons.append({"code": code, "detail": detail, "penalty": round(penalty, 3)})

    all_runs: list[EvalRun] = [r for a in llm.values() for r in a.runs] + list(closure_runs)
    for name, agg in llm.items():
        if agg.disagreement:
            scores = ", ".join(str(s) for s in agg.run_scores)
            hit("RUN_DISAGREEMENT", f"{name}: runs differ ({scores})", p["run_disagreement"])
    for r in all_runs:
        if r.status == "INSUFFICIENT_EVIDENCE":
            hit("INSUFFICIENT_EVIDENCE", f"{r.rubric} run {r.run_index + 1}", p["insufficient_evidence"])
    dropped = sum(r.dropped_findings for r in all_runs)
    if dropped:
        hit("UNSUPPORTED_FINDINGS", f"{dropped} finding(s) dropped for missing evidence",
            p["unsupported_finding"] * dropped)
    retries = sum(r.retries for r in all_runs)
    if retries:
        hit("SCHEMA_RETRY", f"{retries} retry(ies) after invalid output", p["schema_retry"] * retries)
    for f in missing_fields:
        hit("MISSING_FIELD", f, p["missing_key_field"])
    if communications < int(c.get("min_communications", 3)):
        hit("SHORT_CASE", f"{communications} customer-facing communication(s)", p["short_case"])

    score = max(0.0, round(float(c.get("start", 1.0)) - sum(r["penalty"] for r in reasons), 3))
    levels = c["levels"]
    level = "HIGH" if score >= levels["HIGH"] else "MEDIUM" if score >= levels["MEDIUM"] else "LOW"
    return score, level, reasons
