from __future__ import annotations

import copy
from datetime import timedelta

import pytest

from app.rules.idle import evaluate_idle
from app.rules.results import ClosureClassification
from app.rules.slo import evaluate_slo
from app.rules.three_strike import evaluate_three_strike
from tests.conftest import DAY, REFERENCE, T0, item, make_case

AS_OF = T0 + timedelta(days=60)
NON_RESPONSE = ClosureClassification(status="OK", reason="CUSTOMER_NON_RESPONSE", evidence_refs=["RES"])
CONFIRMED = ClosureClassification(status="OK", reason="CUSTOMER_CONFIRMED", evidence_refs=["RES"])


# ------------------------------------------------------------------ SLO
@pytest.mark.parametrize("sev,target", [(1, 30), (2, 180), (3, 240), (4, 720)])
def test_slo_exact_target_is_met_and_one_minute_over_is_breached(settings, sev, target):
    met = evaluate_slo(make_case([item("E1", minutes=target)], severity=sev), settings.rules, AS_OF)
    assert met.status == "MET" and met.actual_minutes == target
    late = evaluate_slo(make_case([item("E1", minutes=target + 1)], severity=sev), settings.rules, AS_OF)
    assert late.status == "BREACHED"


def test_slo_ignores_auto_ack_and_internal_notes(settings):
    case = make_case([
        item("E1", minutes=1, auto=True),
        item("A1", kind="note", direction=None, minutes=5, internal=True),
        item("E2", minutes=200),
    ], severity=2)
    r = evaluate_slo(case, settings.rules, AS_OF)
    assert r.status == "BREACHED" and r.response_ref == "E2"


def test_slo_logged_call_counts_as_response(settings):
    r = evaluate_slo(make_case([item("C1", kind="call", minutes=25), item("E1", minutes=90)], severity=1),
                     settings.rules, AS_OF)
    assert r.status == "MET" and r.response_ref == "C1"


def test_slo_no_response_open_case(settings):
    within = evaluate_slo(make_case([], severity=4), settings.rules, T0 + timedelta(minutes=60))
    assert within.status == "INSUFFICIENT_DATA"
    beyond = evaluate_slo(make_case([], severity=4), settings.rules, T0 + timedelta(minutes=721))
    assert beyond.status == "BREACHED"


def test_slo_missing_fields_insufficient(settings):
    assert evaluate_slo(make_case([item("E1", minutes=5)], severity=None), settings.rules, AS_OF).status == "INSUFFICIENT_DATA"
    assert evaluate_slo(make_case([item("E1", minutes=5)], opened=None), settings.rules, AS_OF).status == "INSUFFICIENT_DATA"
    untimed = make_case([item("E1", minutes=None)], severity=2)
    assert evaluate_slo(untimed, settings.rules, AS_OF).status == "INSUFFICIENT_DATA"


def test_slo_business_hours_clock(settings):
    rules = copy.deepcopy(settings.rules)
    rules["slo"]["initial_response"]["clock"][3] = "business_hours"
    # Opened Tuesday 2026-09-01 16:30 UTC; business hours 09-17 -> 30 min left today.
    opened = T0.replace(hour=16, minute=30)
    case = make_case([item("E1", minutes=0)], severity=3, opened=opened)
    case.items[0].occurred_at = opened + timedelta(hours=17)   # Wed 09:30 -> 60 business minutes
    r = evaluate_slo(case, rules, AS_OF)
    assert r.status == "MET" and r.actual_minutes == 60


# ------------------------------------------------------------------ Idle
def test_idle_exactly_threshold_is_not_idle(settings):
    case = make_case([item("E1", "email", "in", 0), item("E2", minutes=5 * DAY)], closed_minutes=5 * DAY,
                     opened=None)
    assert evaluate_idle(case, settings.rules, AS_OF).windows == []


def test_idle_just_over_threshold_is_support_side(settings):
    case = make_case([item("E1", "email", "in", 0, body="logs attached"), item("E2", minutes=5 * DAY + 1)],
                     closed_minutes=5 * DAY + 1, opened=None)
    r = evaluate_idle(case, settings.rules, AS_OF)
    assert r.status == "SUPPORT_IDLE"
    assert len(r.windows) == 1 and r.windows[0].side == "SUPPORT_SIDE"
    assert r.windows[0].start_ref == "E1" and r.windows[0].end_ref == "E2"


def test_idle_support_asked_question_and_customer_silent_is_still_support_side(settings):
    case = make_case([item("E1", "email", "in", 0, body="broken"), item("E2", minutes=60, body="send logs?"),
                      item("E3", "email", "in", 7 * DAY, body="here")], closed_minutes=7 * DAY, opened=None)
    r = evaluate_idle(case, settings.rules, AS_OF)
    assert [w.side for w in r.windows] == ["SUPPORT_SIDE"]


def test_idle_customer_requested_wait_is_customer_side(settings):
    case = make_case([item("E1", "email", "in", 0, body="Change freeze, please wait, I'll get back to you."),
                      item("E2", minutes=60, body="Sure"),
                      item("E3", "email", "in", 9 * DAY, body="back now")], closed_minutes=9 * DAY, opened=None)
    r = evaluate_idle(case, settings.rules, AS_OF)
    assert r.status == "NO_SUPPORT_IDLE"
    assert [w.side for w in r.windows] == ["CUSTOMER_SIDE"]
    assert "E1" in r.windows[0].reason


def test_idle_internal_notes_do_not_reset_clock(settings):
    case = make_case([item("E1", "email", "in", 0, body="x"),
                      item("A1", kind="note", direction=None, minutes=3 * DAY, internal=True),
                      item("E2", minutes=6 * DAY)], closed_minutes=6 * DAY, opened=None)
    assert evaluate_idle(case, settings.rules, AS_OF).status == "SUPPORT_IDLE"


def test_idle_open_case_counts_gap_to_now(settings):
    case = make_case([item("E1", "email", "in", 0, body="x")], opened=None)
    r = evaluate_idle(case, settings.rules, T0 + timedelta(days=6))
    assert r.status == "SUPPORT_IDLE" and r.windows[0].end_ref == "NOW"
    closed = make_case([item("E1", "email", "in", 0, body="x")], opened=None, closed_minutes=10)
    assert evaluate_idle(closed, settings.rules, T0 + timedelta(days=6)).windows == []


def test_idle_includes_case_opened_event(settings):
    case = make_case([item("E1", minutes=6 * DAY)], closed_minutes=6 * DAY)
    r = evaluate_idle(case, settings.rules, AS_OF)
    assert r.windows and r.windows[0].start_ref == "DESC"


# ------------------------------------------------------------------ 3-strike
def _strike_case(attempts, closed_after_days=8):
    items = [item("E1", minutes=30), item("E2", "email", "in", 1 * DAY, body="will look")] + attempts
    return make_case(items, severity=3, closed_minutes=closed_after_days * DAY)


def test_three_strike_three_emails_correct(settings):
    case = _strike_case([item("E3", minutes=3 * DAY), item("E4", minutes=5 * DAY), item("E5", minutes=7 * DAY)])
    r = evaluate_three_strike(case, NON_RESPONSE, settings.rules)
    assert r.status == "APPLIED_CORRECTLY" and [a.ref_id for a in r.attempts] == ["E3", "E4", "E5"]
    assert r.last_customer_ref == "E2"


def test_three_strike_two_emails_one_call_correct(settings):
    case = _strike_case([item("E3", minutes=3 * DAY), item("C1", kind="call", minutes=5 * DAY),
                         item("E4", minutes=7 * DAY)])
    r = evaluate_three_strike(case, NON_RESPONSE, settings.rules)
    assert r.status == "APPLIED_CORRECTLY" and {a.kind for a in r.attempts} == {"email", "call"}


def test_three_strike_two_attempts_incorrect(settings):
    case = _strike_case([item("E3", minutes=3 * DAY), item("E4", minutes=7 * DAY)])
    r = evaluate_three_strike(case, NON_RESPONSE, settings.rules)
    assert r.status == "APPLIED_INCORRECTLY"
    assert "only 2 of 3" in r.reason and "E3" in r.reason and "E4" in r.reason


def test_three_strike_ignores_attempts_before_last_reply_and_auto_acks(settings):
    case = _strike_case([item("E3", minutes=3 * DAY, auto=True), item("E4", minutes=5 * DAY)])
    r = evaluate_three_strike(case, NON_RESPONSE, settings.rules)
    assert r.status == "APPLIED_INCORRECTLY" and [a.ref_id for a in r.attempts] == ["E4"]


def test_three_strike_not_applicable_cases(settings):
    closed = _strike_case([item("E3", minutes=3 * DAY)])
    assert evaluate_three_strike(closed, CONFIRMED, settings.rules).status == "NOT_APPLICABLE"
    open_case = make_case([item("E1", minutes=5)])
    assert evaluate_three_strike(open_case, NON_RESPONSE, settings.rules).status == "NOT_APPLICABLE"
    unknown = ClosureClassification(status="INSUFFICIENT_EVIDENCE")
    assert evaluate_three_strike(closed, unknown, settings.rules).status == "INSUFFICIENT_DATA"


def test_three_strike_min_spacing(settings):
    rules = copy.deepcopy(settings.rules)
    rules["three_strike"]["min_spacing_hours"] = 24
    case = _strike_case([item("E3", minutes=3 * DAY), item("E4", minutes=3 * DAY + 60),
                         item("E5", minutes=5 * DAY)])
    r = evaluate_three_strike(case, NON_RESPONSE, rules)
    assert r.status == "APPLIED_INCORRECTLY" and [a.ref_id for a in r.attempts] == ["E3", "E5"]


def test_three_strike_closure_notice_excluded_when_configured(settings):
    rules = copy.deepcopy(settings.rules)
    rules["three_strike"]["closure_notice_counts_as_attempt"] = False
    case = _strike_case([item("E3", minutes=3 * DAY), item("E4", minutes=5 * DAY),
                         item("E5", minutes=7 * DAY, body="We are closing this case.")])
    assert evaluate_three_strike(case, NON_RESPONSE, rules).status == "APPLIED_INCORRECTLY"
    assert evaluate_three_strike(case, NON_RESPONSE, settings.rules).status == "APPLIED_CORRECTLY"


# ------------------------------------------------------------------ fixture expectations
def test_fixture_expectations(settings, redacted, fixture_bundle):
    expected = fixture_bundle[1]["expected"]
    for number, (case, _) in redacted.items():
        exp = expected[number]
        slo = evaluate_slo(case, settings.rules, REFERENCE)
        idle = evaluate_idle(case, settings.rules, REFERENCE)
        closure = NON_RESPONSE if "No Response" in case.status else CONFIRMED
        strike = evaluate_three_strike(case, closure, settings.rules)
        assert slo.status == exp["slo"], (number, slo.reason)
        assert idle.status == exp["idle"], (number, idle.windows)
        assert strike.status == exp["three_strike"], (number, strike.reason)
        if "slo_actual_minutes" in exp:
            assert slo.actual_minutes == exp["slo_actual_minutes"]
        if "customer_idle_windows" in exp:
            assert sum(w.side == "CUSTOMER_SIDE" for w in idle.windows) == exp["customer_idle_windows"]
        if "support_idle_windows" in exp:
            assert sum(w.side == "SUPPORT_SIDE" for w in idle.windows) == exp["support_idle_windows"]
