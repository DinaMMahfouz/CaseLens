"""SLO: initial response time per severity."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from app.domain.models import Direction, RedactedCase, TimelineItem
from app.rules.clock import elapsed_minutes
from app.rules.results import SloResult


def _is_response(item: TimelineItem, any_direction_calls: bool) -> bool:
    if item.internal or item.is_auto_ack:
        return False
    if item.item_type == "email":
        return item.direction == Direction.OUTBOUND
    if item.item_type == "call":
        return any_direction_calls or item.direction == Direction.OUTBOUND
    return False


def evaluate_slo(case: RedactedCase, rules: dict[str, Any], as_of: datetime) -> SloResult:
    cfg = rules["slo"]["initial_response"]
    if case.severity is None:
        return SloResult(status="INSUFFICIENT_DATA", reason="severity missing", missing_data=True)
    target = cfg["targets_minutes"].get(case.severity)
    if target is None:
        return SloResult(status="INSUFFICIENT_DATA", severity=case.severity, reason="no target configured")
    clock = cfg.get("clock", {}).get(case.severity, "24x7")
    bh = cfg.get("business_hours", {})
    base = SloResult(status="INSUFFICIENT_DATA", severity=case.severity, clock=clock,
                     target_minutes=float(target), opened_at=case.opened_at)
    if case.opened_at is None:
        base.reason = "case open time missing"
        base.missing_data = True
        return base
    if clock == "24x7":
        base.deadline_at = case.opened_at + timedelta(minutes=float(target))

    any_dir = bool(cfg.get("count_logged_calls_any_direction", True))
    candidates = [i for i in case.items if _is_response(i, any_dir)]
    timed = sorted((i for i in candidates if i.occurred_at is not None), key=lambda i: i.occurred_at)
    if timed:
        first = timed[0]
        actual = elapsed_minutes(case.opened_at, first.occurred_at, clock, bh)
        base.actual_minutes = round(actual, 2)
        base.response_ref = first.ref_id
        base.response_at = first.occurred_at
        # Untimed candidates could have been earlier; only a MET verdict is at risk.
        if actual <= float(target):
            base.status = "MET"
            base.reason = f"first response {first.ref_id} within target"
        elif any(i.occurred_at is None for i in candidates):
            base.reason = "response candidates without timestamps; cannot determine"
            base.missing_data = True
        else:
            base.status = "BREACHED"
            base.reason = f"first response {first.ref_id} after target"
        return base

    if candidates:
        base.reason = "response candidates without timestamps; cannot determine"
        base.missing_data = True
        return base
    end = case.closed_at or as_of
    if elapsed_minutes(case.opened_at, end, clock, bh) > float(target):
        base.status = "BREACHED"
        base.reason = "no customer-facing response from support within target"
    else:
        base.reason = "no response yet, still within target"
    return base
