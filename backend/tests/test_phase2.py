"""Phase 2: every text the worker stores for display is plain language, never a raw code."""
from __future__ import annotations

import re

import pytest

from app.llm.mock import MockProvider
from app.llm.prompts import load_prompts
from app.pipeline import AuditEngine
from app.scoring.routing import route
from tests.conftest import REFERENCE

RAW_CODE = re.compile(r"\b[A-Z]{2,}(?:_[A-Z]+)+\b")       # CUSTOMER_CONFIRMED, MISSING_FIELD, ...
ROUTING_CFG = {"rules": {
    "HOT_CUSTOMER": {"enabled": True, "peak_at_least": 4, "end_above_start": True},
    "INSUFFICIENT_DATA": {"enabled": True, "excluded_deterministic_dimension": True, "data_completeness_below": 0.8},
}}


@pytest.fixture(scope="module")
def audits(settings, redactor, ingest):
    engine = AuditEngine(settings, MockProvider(), redactor, load_prompts(settings.root / "prompts"))
    return {raw.case_number: engine.audit(raw, ingest.roster, REFERENCE) for raw in ingest.cases}


def _texts(a):
    yield a.slo.reason
    yield a.idle.reason
    yield a.three_strike.reason
    yield from (w.reason for w in a.idle.windows)
    yield from (r["detail"] for r in a.review_reasons)


def test_three_strike_reason_never_shows_the_closure_code(audits):
    confirmed = [a for a in audits.values() if a.three_strike.closure_reason == "CUSTOMER_CONFIRMED"]
    assert confirmed, "fixtures should include a customer-confirmed closure"
    for a in confirmed:
        assert "CUSTOMER_CONFIRMED" not in a.three_strike.reason
        assert "customer confirmed" in a.three_strike.reason


def test_no_stored_display_text_contains_a_raw_code(audits):
    for num, a in audits.items():
        for t in _texts(a):
            assert not RAW_CODE.search(t or ""), f"{num}: {t!r}"


def test_routing_details_are_plain_language():
    hot = route("OK", 7.0, temp_peak=4, temp_start=2, temp_end=2, cfg=ROUTING_CFG)
    assert hot[0]["detail"] == "customer peaked Angry"
    miss = route("OK", 7.0, excluded_for_missing=["slo", "idle"], cfg=ROUTING_CFG)
    assert miss[0]["detail"] == "not scored for missing source data: SLO initial response, Idle"
    assert "/5" not in hot[0]["detail"] and "slo" not in miss[0]["detail"]
