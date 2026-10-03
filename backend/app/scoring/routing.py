"""Human review routing. Any matching rule routes the case and adds its reason (once)."""
from __future__ import annotations

from typing import Any, Optional


def route(state: str, overall: Optional[float], *, slo_status: Optional[str] = None,
          strike_status: Optional[str] = None, temp_start: Optional[float] = None,
          temp_end: Optional[float] = None, temp_peak: Optional[float] = None,
          data_completeness: Optional[float] = None, excluded_for_missing: Optional[list[str]] = None,
          disagreement: bool = False, cfg: dict[str, Any]) -> list[dict[str, str]]:
    rules = cfg["rules"]
    reasons: list[dict[str, str]] = []

    def on(name: str) -> bool:
        return bool(rules.get(name, {}).get("enabled", False))

    def add(code: str, detail: str):
        if code not in {r["code"] for r in reasons}:      # one chip per reason
            reasons.append({"code": code, "detail": detail})

    if state == "REDACTION_FAILED" and on("REDACTION_FAILED"):
        add("REDACTION_FAILED", "leak scanner blocked this case")
        return reasons
    if state == "EVAL_FAILED" and on("EVAL_FAILED"):
        add("EVAL_FAILED", "evaluation output invalid after retry")
    if on("LOW_SCORE") and overall is not None and overall < float(rules["LOW_SCORE"]["overall_below"]):
        add("LOW_SCORE", f"overall {overall:g} < {rules['LOW_SCORE']['overall_below']:g}")
    if on("RULE_BREACH"):
        rb = rules["RULE_BREACH"]
        details = []
        if rb.get("slo_breached", True) and slo_status == "BREACHED":
            details.append("SLO initial response breached")
        if rb.get("three_strike_incorrect", True) and strike_status == "APPLIED_INCORRECTLY":
            details.append("3-strike rule applied incorrectly")
        if details:
            add("RULE_BREACH", "; ".join(details))
    if on("HOT_CUSTOMER"):
        hc = rules["HOT_CUSTOMER"]
        if temp_peak is not None and temp_peak >= float(hc.get("peak_at_least", 4)):
            add("HOT_CUSTOMER", f"peak temperature {temp_peak:g}/5")
        elif hc.get("end_above_start", True) and temp_end is not None and temp_start is not None \
                and temp_end > temp_start:
            add("HOT_CUSTOMER", "customer ended hotter than they started")
    if on("INSUFFICIENT_DATA"):
        idr = rules["INSUFFICIENT_DATA"]
        missing = excluded_for_missing or []
        if idr.get("excluded_deterministic_dimension", True) and missing:
            add("INSUFFICIENT_DATA", f"excluded for missing data: {', '.join(missing)}")
        if data_completeness is not None and data_completeness < float(idr.get("data_completeness_below", 0.8)):
            add("INSUFFICIENT_DATA", f"data completeness {data_completeness:.0%}")
    if on("EVALUATOR_DISAGREEMENT") and disagreement:
        add("EVALUATOR_DISAGREEMENT", "evaluation runs disagree")
    return reasons
