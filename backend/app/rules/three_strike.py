"""3-strike rule for closures due to customer non-response.

The closure reason may come from an LLM classification of the resolution field (with
evidence); the attempt count itself is always deterministic.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any, Optional

from app.domain.models import Direction, RedactedCase, TimelineItem
from app.rules.results import Attempt, ClosureClassification, ThreeStrikeResult



# Plain-language explanation when the rule does not apply (never the raw closure code).
CLOSURE_TEXT = {
    "CUSTOMER_CONFIRMED": "the customer confirmed the resolution, so the rule does not apply",
    "OTHER": "closed for a reason other than customer non-response, so the rule does not apply",
}

def _inbound(i: TimelineItem) -> bool:
    return i.customer_facing and not i.is_auto_ack and i.direction == Direction.INBOUND


def _outbound(i: TimelineItem) -> bool:
    return i.customer_facing and not i.is_auto_ack and i.direction == Direction.OUTBOUND


def evaluate_three_strike(case: RedactedCase, closure: Optional[ClosureClassification],
                          rules: dict[str, Any]) -> ThreeStrikeResult:
    cfg = rules["three_strike"]
    required = int(cfg.get("required_attempts", 3))
    res = ThreeStrikeResult(status="NOT_APPLICABLE", required=required, closed_at=case.closed_at)
    if not case.is_closed:
        res.reason = "case is not closed"
        return res
    if closure is None or closure.status != "OK" or closure.reason is None:
        res.status = "INSUFFICIENT_DATA"
        res.reason = "closure reason could not be determined"
        return res
    res.closure_reason = closure.reason
    if closure.reason != "CUSTOMER_NON_RESPONSE":
        res.reason = CLOSURE_TEXT.get(closure.reason, "closed for a reason other than customer non-response")
        return res
    if case.closed_at is None:
        res.status = "INSUFFICIENT_DATA"
        res.reason = "closed time missing"
        res.missing_data = True
        return res

    closed = case.closed_at
    inbound = [i for i in case.items if _inbound(i) and i.occurred_at and i.occurred_at <= closed]
    if inbound:
        last = max(inbound, key=lambda i: i.occurred_at)
        res.last_customer_ref, res.last_customer_at = last.ref_id, last.occurred_at
    elif case.opened_at is not None:
        res.last_customer_ref, res.last_customer_at = "DESC", case.opened_at
    else:
        res.status = "INSUFFICIENT_DATA"
        res.reason = "no timestamped customer contact to count from"
        res.missing_data = True
        return res

    after = res.last_customer_at
    outbound = [i for i in case.items if _outbound(i)]
    untimed = [i for i in outbound if i.occurred_at is None]
    cands = sorted((i for i in outbound if i.occurred_at and after < i.occurred_at <= closed),
                   key=lambda i: i.occurred_at)

    if not cfg.get("closure_notice_counts_as_attempt", True) and cands:
        phrases = [p.lower() for p in cfg.get("closure_notice_phrases", [])]
        last = cands[-1]
        if any(p in f"{last.subject}\n{last.body}".lower() for p in phrases):
            cands = cands[:-1]

    spacing = timedelta(hours=float(cfg.get("min_spacing_hours", 0) or 0))
    counted: list[TimelineItem] = []
    for c in cands:
        if counted and spacing and c.occurred_at - counted[-1].occurred_at < spacing:
            continue
        counted.append(c)
    res.attempts = [Attempt(ref_id=c.ref_id, at=c.occurred_at, kind=c.item_type) for c in counted]

    if len(counted) >= required:
        res.status = "APPLIED_CORRECTLY"
        res.reason = f"{len(counted)} contact attempts after the customer's last reply ({res.last_customer_ref})"
    elif untimed:
        res.status = "INSUFFICIENT_DATA"
        res.missing_data = True
        res.reason = (f"{len(counted)} timed {'attempt' if len(counted) == 1 else 'attempts'}; "
                      f"{len(untimed)} outbound {'contact lacks a timestamp' if len(untimed) == 1 else 'contacts lack timestamps'}")
    else:
        res.status = "APPLIED_INCORRECTLY"
        refs = ", ".join(a.ref_id for a in res.attempts) or "none"
        res.reason = (f"only {len(counted)} of {required} required contact attempts after the customer's "
                      f"last reply ({res.last_customer_ref}); attempts: {refs}")
    return res
