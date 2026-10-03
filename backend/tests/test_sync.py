"""Supabase sync: payload shape, no PII, idempotency, SQL rendering (no network)."""
from __future__ import annotations

import json

import httpx
import pytest

from app.db.base import session_scope
from app.sync.supabase import SupabaseClient, SyncError, TABLE_ORDER, build_payload, push, to_sql


@pytest.fixture(scope="module")
def payload(env):
    client, run_id, _, _ = env
    with session_scope() as s:
        return build_payload(s, run_id)


from tests.test_api import env  # noqa: E402,F401  (reuse the populated API fixture)


def test_payload_shape_and_links(payload):
    assert len(payload["runs"]) == 1 and len(payload["cases"]) == 19
    case_ids = {c["id"] for c in payload["cases"]}
    assert all(i["case_id"] in case_ids for i in payload["items"])
    audit_ids = {a["id"] for a in payload["audits"]}
    assert all(f["audit_id"] in audit_ids for f in payload["findings"])
    assert set(payload["case_owners"].values()) >= {"Marta Lindqvist", "Daniel Osei"}
    assert set(payload["case_owners"]) <= case_ids and all(c["tse_id"] is None for c in payload["cases"])


def test_payload_has_no_customer_pii(payload, fixture_bundle):
    blob = json.dumps(payload).lower()
    leaked = [p for p in fixture_bundle[1]["pii"] if p.lower() in blob]
    assert leaked == []


def test_engineer_names_only_in_owner_mapping(payload, fixture_bundle):
    text = json.dumps({k: v for k, v in payload.items() if k != "case_owners"}).lower()
    assert [e for e in fixture_bundle[1]["engineers"] if e.lower() in text] == []


def test_sql_rendering(payload):
    sql = to_sql(payload)
    assert sql.startswith("begin;") and sql.endswith("commit;")
    assert "insert into public.tses" in sql and "update public.cases set tse_id" in sql
    for table in TABLE_ORDER:
        assert f"insert into public.{table}" in sql


def test_push_inserts_in_order_and_refuses_duplicates(payload):
    calls = []
    state = {"exists": False}

    def handler(request: httpx.Request):
        calls.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path.endswith("/tses"):
            names = sorted(set(payload["case_owners"].values()))
            return httpx.Response(200, json=[{"id": f"tse-{i}", "display_name": n} for i, n in enumerate(names)])
        if request.method == "GET":
            return httpx.Response(200, json=[{"id": "x"}] if state["exists"] else [])
        if request.method == "POST":
            body = json.loads(request.content)
            assert isinstance(body, list) and body
            return httpx.Response(201)
        return httpx.Response(204)

    client = SupabaseClient("https://example.supabase.co", "sb_secret_test", transport=httpx.MockTransport(handler))
    push(client, payload)
    posted = [p.rsplit("/", 1)[-1] for m, p in calls if m == "POST"]
    assert posted[:2] == ["tses", "runs"]
    assert posted.index("cases") < posted.index("items") < posted.index("audits") < posted.index("findings")
    assert all(str(c["tse_id"]).startswith("tse-") for c in payload["cases"])
    state["exists"] = True
    with pytest.raises(SyncError):
        push(client, payload)
    calls.clear()
    push(client, payload, replace=True)
    assert calls[1][0] == "DELETE"


def test_errors_never_echo_row_data():
    def handler(request):
        return httpx.Response(409, json={"code": "23505", "message": "duplicate key value Priya Raman"})
    client = SupabaseClient("https://example.supabase.co", "k", transport=httpx.MockTransport(handler))
    with pytest.raises(SyncError) as e:
        client.insert("cases", [{"a": 1}])
    assert "Priya" not in str(e.value) and "23505" in str(e.value)
