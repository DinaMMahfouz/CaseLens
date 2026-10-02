from __future__ import annotations

import json
import pickle
import re

import pytest

from app.domain.models import RawCase, RawCommunication, Direction
from app.redaction.leak_scanner import scan_fields, scan_text
from app.redaction.strip import strip_text
from app.settings import ConfigError, load_settings


def _redact_one(redactor, body, **case_kw):
    raw = RawCase(case_number="X1", communications=[
        RawCommunication(kind="email", direction=Direction.INBOUND, occurred_at=None, body=body)
    ], **case_kw)
    case, ctx = redactor.redact_case(raw, [])
    return case.items[0].body, ctx


# ------------------------------------------------------------------ strip
def test_strip_removes_signature_disclaimer_and_quoted_chain(settings):
    cfg = settings.redaction["strip"]
    text = ("Hi team,\n\nThe agent crashes on start.\n\nBest regards,\nJane Roe\nCEO\n+1 555 123 4567\n\n"
            "On Mon, Sep 7, 2026 at 9:00 AM Bob <bob@x.com> wrote:\n> old text")
    out = strip_text(text, cfg, is_email=True)
    assert out == "Hi team,\n\nThe agent crashes on start."


def test_strip_removes_outlook_header_chain_and_disclaimer(settings):
    cfg = settings.redaction["strip"]
    text = ("Logs attached.\n\nThis email is confidential and intended only for the intended recipient. "
            "If you have received this in error please notify the sender.\n\n"
            "From: Someone Else <s@else.com>\nSent: Monday\nTo: me\n\nOlder content")
    assert strip_text(text, cfg, is_email=True) == "Logs attached."


# ------------------------------------------------------------------ entity coverage
@pytest.mark.parametrize("secret,token", [
    ("jane.roe@example-corp.com", "EMAIL"),
    ("10.1.2.3", "IP"),
    ("2001:db8:85a3::8a2e:370:7334", "IP"),
    ("00:1A:2B:3C:4D:5E", "MAC"),
    ("app01.example-corp.local", "HOST"),
    ("CN=Jane Roe,OU=Users,DC=example,DC=local", "DN"),
    ("\\\\fs01\\share\\jroe", "PATH"),
    ("C:\\Users\\jroe\\AppData\\log.txt", "PATH"),
    ("/home/jroe/agent.log", "PATH"),
    ("CORP\\jroe", "USERNAME"),
    ("ACC-123456", "ACCOUNT_ID"),
    ("EMP-55512", "EMPLOYEE_ID"),
    ("123456789012", "SERIAL"),
    ("ABCD1-EFGH2-IJKL3-MNOP4", "LICENSE_KEY"),
    ("https://portal.example-corp.com/x?u=jroe", "URL"),
    ("+1 415 555 0101", "PHONE"),
])
def test_technical_identifiers_redacted(redactor, secret, token):
    body, _ = _redact_one(redactor, f"Details: {secret} please check.")
    assert secret.lower() not in body.lower()
    assert re.search(rf"\[{token}_\d+\]", body), body


@pytest.mark.parametrize("text,leak", [
    ("password: Hunter2!x", "Hunter2!x"),
    ("api_key=FAKEkey9Zx2qW7eR4tY8uI3oP6aS1dF5", "FAKEkey9Zx2qW7eR4tY8uI3oP6aS1dF5"),
    ("session id: 0f9e8d7c", "0f9e8d7c"),
    ("token serial: 000555666777", "000555666777"),
    ("-----BEGIN CERTIFICATE-----\nMIIBabc\n-----END CERTIFICATE-----", "MIIBabc"),
    ("seed = 3f8a9b2c7d", "3f8a9b2c7d"),
])
def test_secrets_redacted(redactor, text, leak):
    body, _ = _redact_one(redactor, text)
    assert leak not in body


def test_person_names_and_greetings_redacted(redactor):
    body, _ = _redact_one(redactor, "Hi Johanna,\n\nI spoke with Marcus Feldman from the network team about it.")
    assert "Johanna" not in body and "Marcus" not in body and "Feldman" not in body


def test_deny_list_from_case_fields_and_consistent_pseudonyms(redactor):
    raw = RawCase(
        case_number="X2", account_name="Bluefinch Robotics Ltd", contact_name="Ilse Vandermeer",
        contact_email="ilse.v@bluefinch-robotics.com", account_number="ACCT-99812",
        communications=[
            RawCommunication(kind="email", direction=Direction.INBOUND, occurred_at=None,
                             body="Ilse here from Bluefinch. Mail ilse.v@bluefinch-robotics.com."),
            RawCommunication(kind="email", direction=Direction.OUTBOUND, occurred_at=None,
                             body="Hello Ilse Vandermeer, Bluefinch Robotics Ltd account ACCT-99812 noted. "
                                  "Copying ilse.v@bluefinch-robotics.com."),
        ])
    case, ctx = redactor.redact_case(raw, [])
    blob = " ".join(i.body for i in case.items)
    for value in ("Ilse", "Vandermeer", "Bluefinch", "bluefinch-robotics", "ACCT-99812"):
        assert value.lower() not in blob.lower()
    first_email = re.findall(r"\[EMAIL_\d+\]", case.items[0].body)
    second_email = re.findall(r"\[EMAIL_\d+\]", case.items[1].body)
    assert first_email == second_email  # same address -> same pseudonym
    person = re.findall(r"\[PERSON_\d+\]", blob)
    assert len(set(person)) == 1        # first name and full name share one pseudonym


def test_account_label_is_keyed_pseudonym_and_engineer_name_follows_flag(settings):
    from app.redaction.redactor import Redactor
    raw = RawCase(case_number="X3", account_name="Bluefinch", owner="Ada Quist",
                  communications=[RawCommunication(kind="email", direction=Direction.OUTBOUND, occurred_at=None,
                                                   body="Handing over to Ada Quist tomorrow.")])
    for show in (True, False):
        app = json.loads(json.dumps(settings.app))
        app["display"]["show_engineer_names"] = show
        case, _ = Redactor(settings.redaction, app, settings.pseudonym_key).redact_case(raw, ["Ada Quist"])
        assert case.account_label.startswith("ACCT-") and "Bluefinch" not in case.account_label
        assert case.owner_label == ("Ada Quist" if show else case.owner_label)
        if not show:
            assert case.owner_label.startswith("TSE-")
        assert "Ada" not in case.items[0].body      # engineer names in case text stay redacted


def test_context_never_serializes(redactor):
    _, ctx = _redact_one(redactor, "Mail jane@example-corp.com")
    with pytest.raises(TypeError):
        pickle.dumps(ctx)
    assert "jane" not in repr(ctx)


# ------------------------------------------------------------------ leak scanner
def test_leak_scanner_detects_and_ignores_tokens():
    assert scan_text("[EMAIL_1] on [IP_2] via [HOST_1]", "x", []) == []
    assert {h.detector for h in scan_text("mail a.b@corp.com from 10.0.0.1", "x", [])} >= {"email", "ipv4"}
    hits = scan_text("Contact Ilse today", "E1.body", ["Ilse"])
    assert hits and hits[0].detector == "deny_list" and hits[0].location == "E1.body"
    assert scan_text("password: [SECRET_1].", "x", []) == []


# ------------------------------------------------------------------ fixtures end to end
def test_fixture_cases_have_no_planted_pii_after_redaction(redacted, fixture_bundle):
    pii = [p.lower() for p in fixture_bundle[1]["pii"]]
    for number, (case, ctx) in redacted.items():
        blob = json.dumps(case.model_dump(mode="json")).lower()
        leaked = [p for p in pii if p in blob]
        assert not leaked, f"{number} leaked {len(leaked)} planted value(s)"


def test_fixture_cases_pass_leak_scanner(redacted):
    for number, (case, ctx) in redacted.items():
        fields = {"description": case.description, "subject": case.subject, "resolution": case.resolution}
        for it in case.items:
            fields[f"{it.ref_id}.body"] = it.body
            fields[f"{it.ref_id}.subject"] = it.subject
        assert scan_fields(fields, ctx.sensitive_values()) == [], number


def test_prompt_injection_text_is_kept_as_data(redacted):
    case, _ = redacted["00100018"]
    assert any("IGNORE ALL PREVIOUS INSTRUCTIONS" in i.body for i in case.items)


# ------------------------------------------------------------------ guardrail
def test_refuses_to_start_with_redaction_off_on_real_data(settings):
    app = json.loads(json.dumps(settings.app))
    app["redaction"]["enabled"] = False
    app["data_source"]["synthetic"] = False
    with pytest.raises(ConfigError):
        load_settings(app=app)


def test_allows_redaction_off_only_for_synthetic(settings):
    app = json.loads(json.dumps(settings.app))
    app["redaction"]["enabled"] = False
    app["data_source"]["synthetic"] = True
    assert load_settings(app=app).redaction_enabled is False
