"""Idle detection between consecutive customer-facing communications.

Side rule (agreed with the business owner):
  * CUSTOMER_SIDE only when the customer asked support to wait - detected in the most
    recent inbound communication at or before the start of the gap.
  * Otherwise SUPPORT_SIDE (support should have followed up within the threshold).
Internal notes never reset the clock. Auto-acknowledgements are not communications.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Optional

from app.domain.models import Direction, RedactedCase
from app.rules.results import IdleResult, IdleWindow


@dataclass
class _Event:
    ref: str
    at: datetime
    inbound: bool
    text: str


def _norm(text: str) -> str:
    return text.lower().replace("’", "'").replace("‘", "'")


def _events(case: RedactedCase, include_opened: bool) -> list[_Event]:
    evs: list[_Event] = []
    if include_opened and case.opened_at is not None:
        evs.append(_Event("DESC", case.opened_at, True, case.description))
    for it in case.items:
        if not it.customer_facing or it.is_auto_ack or it.occurred_at is None:
            continue
        evs.append(_Event(it.ref_id, it.occurred_at, it.direction == Direction.INBOUND,
                          f"{it.subject}\n{it.body}"))
    evs.sort(key=lambda e: e.at)
    return evs


def evaluate_idle(case: RedactedCase, rules: dict[str, Any], as_of: datetime) -> IdleResult:
    cfg = rules["idle"]
    days = float(cfg.get("threshold_days", 5))
    threshold = timedelta(days=days)
    phrases = [_norm(p) for p in cfg.get("customer_wait_phrases", [])]
    events = _events(case, bool(cfg.get("include_case_opened_event", True)))
    if not events:
        return IdleResult(status="INSUFFICIENT_DATA", threshold_days=days,
                          reason="no timestamped customer-facing communications")

    pairs: list[tuple[_Event, Optional[_Event], datetime]] = [
        (a, b, b.at) for a, b in zip(events, events[1:])
    ]
    if not case.is_closed:
        pairs.append((events[-1], None, as_of))

    windows: list[IdleWindow] = []
    for a, b, end in pairs:
        gap = end - a.at
        if gap <= threshold:
            continue
        last_in = next((e for e in reversed(events) if e.inbound and e.at <= a.at), None)
        wait = last_in is not None and any(p in _norm(last_in.text) for p in phrases)
        if wait:
            side, reason = "CUSTOMER_SIDE", f"customer asked support to wait in {last_in.ref}"
        else:
            side, reason = "SUPPORT_SIDE", "no customer wait request; support follow-up due"
        windows.append(IdleWindow(
            start=a.at, end=end, duration_hours=round(gap.total_seconds() / 3600, 2), side=side,
            start_ref=a.ref, end_ref=b.ref if b else "NOW", reason=reason,
        ))
    support = sum(w.duration_hours for w in windows if w.side == "SUPPORT_SIDE")
    customer = sum(w.duration_hours for w in windows if w.side == "CUSTOMER_SIDE")
    return IdleResult(
        status="SUPPORT_IDLE" if support > 0 else "NO_SUPPORT_IDLE",
        threshold_days=days, windows=windows,
        support_idle_hours=round(support, 2), customer_idle_hours=round(customer, 2),
        reason=f"{len(windows)} idle window(s) over {days:g} days",
    )
