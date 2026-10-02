"""Human review routing. Any matching rule routes the case and adds its reason."""
from __future__ import annotations

from typing import Any, Optional


def route(state: str, overall: Optional[float], confidence_level: Optional[str], slo_status: Optional[str],
          strike_status: Optional[str], temperature: Optional[float], trajectory: Optional[str],
          cfg: dict[str, Any]) -> list[dict[str, str]]:
    rules = cfg["rules"]
    reasons: list[dict[str, str]] = []

    def on(name: str) -> bool:
        return bool(rules.get(name, {}).get("enabled", False))

    if state == "REDACTION_FAILED" and on("REDACTION_FAILED"):
        reasons.append({"code": "REDACTION_FAILED", "detail": "leak scanner blocked this case"})
        return reasons
    if state == "EVAL_FAILED" and on("EVAL_FAILED"):
        reasons.append({"code": "EVAL_FAILED", "detail": "LLM output invalid after retry"})
    if on("LOW_SCORE") and overall is not None and overall < float(rules["LOW_SCORE"]["overall_below"]):
        reasons.append({"code": "LOW_SCORE", "detail": f"overall {overall:g} < {rules['LOW_SCORE']['overall_below']:g}"})
    if on("LOW_CONFIDENCE") and confidence_level in rules["LOW_CONFIDENCE"].get("levels", ["LOW"]):
        reasons.append({"code": "LOW_CONFIDENCE", "detail": f"confidence {confidence_level}"})
    if on("RULE_BREACH"):
        rb = rules["RULE_BREACH"]
        if rb.get("slo_breached", True) and slo_status == "BREACHED":
            reasons.append({"code": "RULE_BREACH", "detail": "SLO initial response breached"})
        if rb.get("three_strike_incorrect", True) and strike_status == "APPLIED_INCORRECTLY":
            reasons.append({"code": "RULE_BREACH", "detail": "3-strike rule applied incorrectly"})
    if on("HOT_CUSTOMER"):
        hc = rules["HOT_CUSTOMER"]
        if temperature is not None and temperature >= float(hc.get("temperature_at_least", 4)):
            reasons.append({"code": "HOT_CUSTOMER", "detail": f"temperature {temperature:g}/5"})
        elif hc.get("trajectory_worsening", True) and trajectory == "worsening":
            reasons.append({"code": "HOT_CUSTOMER", "detail": "temperature trajectory worsening"})
    return reasons
