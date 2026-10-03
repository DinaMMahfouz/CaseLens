"""Push REDACTED audit results from the local worker DB to Supabase.

Only rows already stored locally are pushed, and those contain redacted text only. Raw
exports never leave this machine. The only network endpoint is SUPABASE_URL.

Row IDs are UUIDs generated here, so the same payload can be sent through the REST
API (`push`) or rendered as SQL (`to_sql`) without FK remapping.
"""
from __future__ import annotations

import json
import os
import secrets
import uuid
from datetime import datetime
from typing import Any, Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.db import tables as t

TABLE_ORDER = ("runs", "cases", "items", "audits", "findings")


class SyncError(RuntimeError):
    pass


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


_FINDING_LISTS = {"top_issues", "missed_steps", "repeated_requests", "shift_points", "handover_issues"}


def _slim_llm(llm: dict[str, Any]) -> dict[str, Any]:
    """Drop per-run finding lists: findings are pushed once, in their own table."""
    out: dict[str, Any] = {}
    for name, dim in (llm or {}).items():
        dim = dict(dim)
        if isinstance(dim.get("runs"), list):
            dim["runs"] = [
                {**r, "result": ({k: v for k, v in r["result"].items() if k not in _FINDING_LISTS}
                                 if isinstance(r.get("result"), dict) else r.get("result"))}
                for r in dim["runs"]
            ]
        out[name] = dim
    return out


def push_key(run: t.Run) -> str:
    return f"{_iso(run.as_of)}#{run.id}#{run.config_hash}"


def build_payload(session: Session, run_id: int) -> dict[str, list[dict[str, Any]]]:
    run = session.get(t.Run, run_id)
    if run is None:
        raise SyncError(f"local run {run_id} not found")
    if run.status != "done":
        raise SyncError(f"local run {run_id} is {run.status}, not done")
    rid = str(uuid.uuid4())
    out: dict[str, Any] = {k: [] for k in TABLE_ORDER}
    # Case owner names from the export, resolved to tses.id at push time (ingestion is the
    # only place a name is mapped to an id; queries and access rules use ids only).
    out["case_owners"] = {}
    out["runs"].append({
        "id": rid, "push_key": push_key(run), "as_of": _iso(run.as_of), "source": run.source,
        "synthetic": run.synthetic, "total": run.total, "failed": run.failed, "provider": run.provider,
        "model": run.model, "temperature": run.temperature, "config_hash": run.config_hash,
        "prompt_versions": run.prompt_versions or {}, "kind": run.kind or "normal", "label": run.label or "",
    })
    cases = session.scalars(
        select(t.Case).where(t.Case.run_id == run_id)
        .options(selectinload(t.Case.items), selectinload(t.Case.audit).selectinload(t.Audit.findings))
    )
    for c in cases:
        cid = str(uuid.uuid4())
        out["cases"].append({
            "id": cid, "run_id": rid, "case_number": c.case_number, "subject": c.subject or "",
            "description": c.description or "", "severity": c.severity, "status": c.status or "",
            "is_closed": c.is_closed, "opened_at": _iso(c.opened_at), "closed_at": _iso(c.closed_at),
            "tse_id": None, "account_label": c.account_label or "", "product": c.product or "",
            "resolution": c.resolution or "", "missing_fields": c.missing_fields or [], "state": c.state,
        })
        if c.owner_label:
            out["case_owners"][cid] = c.owner_label
        for i in c.items:
            out["items"].append({
                "id": str(uuid.uuid4()), "case_id": cid, "position": i.position, "ref_id": i.ref_id,
                "item_type": i.item_type, "direction": i.direction, "internal": i.internal,
                "author_role": i.author_role, "occurred_at": _iso(i.occurred_at), "subject": i.subject or "",
                "body": i.body or "", "is_auto_ack": i.is_auto_ack,
            })
        a = c.audit
        if a is None:
            continue
        aid = str(uuid.uuid4())
        out["audits"].append({
            "id": aid, "case_id": cid, "run_id": rid, "state": a.state, "overall": a.overall,
            "dimensions": a.dimensions or [], "slo": a.slo, "idle": a.idle, "three_strike": a.three_strike,
            "closure": a.closure, "llm": _slim_llm(a.llm or {}), "temperature_value": a.temperature_value,
            "trajectory": a.trajectory, "temp_start": a.temp_start, "temp_end": a.temp_end,
            "temp_peak": a.temp_peak, "scored_dimensions": a.scored_dimensions,
            "applicable_dimensions": a.applicable_dimensions, "data_completeness": a.data_completeness,
            "completeness_reasons": a.completeness_reasons or [], "run_agreement": a.run_agreement,
            "agreement_details": a.agreement_details or {}, "is_heuristic": a.is_heuristic,
            "audited_at": _iso(a.audited_at), "config_hash": run.config_hash,
            "review_reasons": a.review_reasons or [], "needs_review": a.needs_review,
            "unsupported_count": a.unsupported_count, "retry_count": a.retry_count, "provider": a.provider,
            "model": a.model, "temperature": a.temperature, "prompt_versions": a.prompt_versions or {},
            "error_kind": a.error_kind or "",
        })
        for f in a.findings:
            out["findings"].append({"id": str(uuid.uuid4()), "audit_id": aid, "dimension": f.dimension,
                                    "kind": f.kind, "text": f.text, "evidence": f.evidence or []})
    return out


def _dollar(text: str) -> str:
    tag = "q" + secrets.token_hex(4)
    while f"${tag}$" in text:
        tag = "q" + secrets.token_hex(4)
    return f"${tag}${text}${tag}$"


def sql_statements(payload: dict[str, Any], max_bytes: int = 0) -> list[str]:
    """INSERT statements via jsonb_populate_recordset, optionally split to about max_bytes each."""
    out: list[str] = []
    owners: dict[str, str] = payload.get("case_owners", {})
    names = sorted(set(owners.values()))
    if names:
        out.append("insert into public.tses (display_name) select unnest(array["
                   + ", ".join(_dollar(n) for n in names) + "]) on conflict (display_name) do nothing;")
    for table in TABLE_ORDER:
        if table == "items" and names:
            for name in names:
                ids = ", ".join(f"'{cid}'" for cid, n in owners.items() if n == name)
                out.append(f"update public.cases set tse_id = (select id from public.tses where display_name = "
                           f"{_dollar(name)}) where id = any(array[{ids}]::uuid[]);")
        rows = payload[table]
        if not rows:
            continue
        cols = ", ".join(rows[0].keys())
        batches: list[list[dict[str, Any]]] = [[]]
        size = 0
        for row in rows:
            n = len(json.dumps(row, ensure_ascii=False).encode())
            if max_bytes and batches[-1] and size + n > max_bytes:
                batches.append([])
                size = 0
            batches[-1].append(row)
            size += n
        for batch in batches:
            blob = json.dumps(batch, ensure_ascii=False)
            tag = "j" + secrets.token_hex(6)
            while f"${tag}$" in blob:
                tag = "j" + secrets.token_hex(6)
            out.append(f"insert into public.{table} ({cols}) select {cols} from "
                       f"jsonb_populate_recordset(null::public.{table}, ${tag}${blob}${tag}$::jsonb);")
    return out


def to_sql(payload: dict[str, Any]) -> str:
    """Render the payload as one transaction of INSERT statements."""
    return "\n".join(["begin;", *sql_statements(payload), "commit;"])


class SupabaseClient:
    """Minimal PostgREST/Auth-admin client using the SECRET key (worker side only)."""

    def __init__(self, url: Optional[str] = None, key: Optional[str] = None, transport=None):
        import httpx

        self.url = (url or os.environ.get("SUPABASE_URL", "")).rstrip("/")
        key = key or os.environ.get("SUPABASE_SECRET_KEY", "")
        if not self.url or not key:
            raise SyncError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)")
        headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        self.http = httpx.Client(base_url=self.url, headers=headers, timeout=60, transport=transport)

    def _check(self, r, what: str):
        if r.status_code >= 300:
            # Status and PostgREST error code only - never echo row data.
            code = ""
            try:
                code = r.json().get("code", "") or r.json().get("error_code", "")
            except Exception:
                pass
            raise SyncError(f"{what} failed: HTTP {r.status_code} {code}".strip())
        return r

    def select(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        return self._check(self.http.get(f"/rest/v1/{table}", params=params), f"select {table}").json()

    def insert(self, table: str, rows: Iterable[dict[str, Any]], upsert: bool = False, chunk: int = 500,
               on_conflict: Optional[str] = None, ignore_duplicates: bool = False) -> None:
        rows = list(rows)
        prefer = "return=minimal" + (",resolution=merge-duplicates" if upsert else "")             + (",resolution=ignore-duplicates" if ignore_duplicates else "")
        params = {"on_conflict": on_conflict} if on_conflict else None
        for i in range(0, len(rows), chunk):
            self._check(self.http.post(f"/rest/v1/{table}", json=rows[i:i + chunk], params=params,
                                       headers={"Prefer": prefer}), f"insert {table}")

    def delete(self, table: str, params: dict[str, str]) -> None:
        self._check(self.http.delete(f"/rest/v1/{table}", params=params), f"delete {table}")

    # -------------------------------------------------------------- auth admin
    def invite(self, email: str, redirect_to: Optional[str] = None) -> str:
        params = {"redirect_to": redirect_to} if redirect_to else None
        r = self.http.post("/auth/v1/invite", json={"email": email}, params=params)
        if r.status_code == 422:      # already registered
            return self.find_user(email)
        return self._check(r, "invite").json()["id"]

    def find_user(self, email: str) -> str:
        page = 1
        while True:
            r = self._check(self.http.get("/auth/v1/admin/users", params={"page": page, "per_page": 200}), "list users")
            users = r.json().get("users", [])
            for u in users:
                if (u.get("email") or "").lower() == email.lower():
                    return u["id"]
            if len(users) < 200:
                raise SyncError("user not found")
            page += 1


def resolve_tses(client: SupabaseClient, payload: dict[str, Any]) -> None:
    """Map export owner names to tses ids (creating missing TSE rows) and set cases.tse_id."""
    owners: dict[str, str] = payload.get("case_owners", {})
    names = sorted(set(owners.values()))
    if not names:
        return
    client.insert("tses", [{"display_name": n} for n in names], on_conflict="display_name", ignore_duplicates=True)
    quoted = ",".join('"' + n.replace('"', '\\"') + '"' for n in names)
    rows = client.select("tses", {"select": "id,display_name", "display_name": f"in.({quoted})"})
    ids = {r["display_name"]: r["id"] for r in rows}
    for c in payload["cases"]:
        name = owners.get(c["id"])
        c["tse_id"] = ids.get(name) if name else None


def push(client: SupabaseClient, payload: dict[str, Any], replace: bool = False) -> str:
    key = payload["runs"][0]["push_key"]
    existing = client.select("runs", {"select": "id", "push_key": f"eq.{key}"})
    if existing:
        if not replace:
            raise SyncError("this run was already pushed; use --replace to overwrite it "
                            "(this also deletes reviewer actions recorded on it)")
        client.delete("runs", {"push_key": f"eq.{key}"})
    resolve_tses(client, payload)
    for table in TABLE_ORDER:
        if payload[table]:
            client.insert(table, payload[table])
    return payload["runs"][0]["id"]
