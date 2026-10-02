from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters.excel import ExcelAdapter  # noqa: E402
from app.domain.models import Direction, RedactedCase, TimelineItem  # noqa: E402
from app.redaction.redactor import Redactor  # noqa: E402
from app.settings import load_settings  # noqa: E402
from scripts.gen_fixtures import generate  # noqa: E402

REFERENCE = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="session")
def settings():
    return load_settings()


@pytest.fixture(scope="session")
def fixture_bundle(tmp_path_factory):
    out = tmp_path_factory.mktemp("fx") / "synthetic_cases.xlsx"
    manifest = generate(out, REFERENCE)
    return out, manifest


@pytest.fixture(scope="session")
def ingest(settings, fixture_bundle):
    return ExcelAdapter(settings.mapping).load(fixture_bundle[0])


@pytest.fixture(scope="session")
def redactor(settings):
    return Redactor(settings.redaction, settings.app, settings.pseudonym_key)


@pytest.fixture(scope="session")
def redacted(ingest, redactor):
    out = {}
    for raw in ingest.cases:
        case, ctx = redactor.redact_case(raw, ingest.roster)
        out[raw.case_number] = (case, ctx)
    return out


# ------------------------------------------------------------------ builders
T0 = datetime(2026, 9, 1, 9, 0, tzinfo=timezone.utc)


def item(ref, kind="email", direction="out", minutes=0.0, body="", internal=False, auto=False):
    d = {"in": Direction.INBOUND, "out": Direction.OUTBOUND, None: None}[direction]
    role = "system" if auto else ("customer" if direction == "in" and kind == "email" else "support")
    return TimelineItem(
        ref_id=ref, item_type=kind, direction=d if kind in ("email", "call") else None,
        internal=internal, author_role=role,
        occurred_at=None if minutes is None else T0 + timedelta(minutes=minutes),
        body=body, is_auto_ack=auto,
    )


def make_case(items, severity=2, closed_minutes=None, opened=T0, description="help", **kw):
    return RedactedCase(
        case_number="T-1", severity=severity, opened_at=opened, description=description,
        is_closed=closed_minutes is not None,
        closed_at=None if closed_minutes is None else T0 + timedelta(minutes=closed_minutes),
        items=items, owner_label="TSE-x", **kw,
    )


DAY = 24 * 60
