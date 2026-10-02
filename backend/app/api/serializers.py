"""Response shaping. Only redacted fields ever leave the API."""
from __future__ import annotations

from typing import Any, Optional

from app.db import tables as t


def iso(dt) -> Optional[str]:
    return dt.isoformat() if dt else None


def run_out(r: t.Run) -> dict[str, Any]:
    return {
        "id": r.id, "status": r.status, "source": r.source, "upload_id": r.upload_id, "synthetic": r.synthetic,
        "total": r.total, "processed": r.processed, "failed": r.failed, "error_kind": r.error_kind,
        "created_at": iso(r.created_at), "started_at": iso(r.started_at), "finished_at": iso(r.finished_at),
        "as_of": iso(r.as_of), "config_hash": r.config_hash, "provider": r.provider, "model": r.model,
        "temperature": r.temperature, "prompt_versions": r.prompt_versions,
        "ingest_report": {k: v for k, v in (r.ingest_report or {}).items() if k != "columns"},
    }


def latest_review(a: Optional[t.Audit]) -> Optional[dict[str, Any]]:
    if not a or not a.review_actions:
        return None
    last = a.review_actions[-1]
    override = next((x.score_override for x in reversed(a.review_actions) if x.action == "override"), None)
    return {"action": last.action, "reviewer_name": last.reviewer_name, "at": iso(last.created_at),
            "score_override": override, "count": len(a.review_actions)}


def case_row(c: t.Case) -> dict[str, Any]:
    a = c.audit
    dims = {d["dimension"]: d.get("score") for d in (a.dimensions if a else [])}
    return {
        "id": c.id, "case_number": c.case_number, "severity": c.severity, "status": c.status,
        "state": c.state, "owner": c.owner_label, "account": c.account_label, "product": c.product,
        "opened_at": iso(c.opened_at), "closed_at": iso(c.closed_at), "subject": c.subject,
        "audit_id": a.id if a else None,
        "overall": a.overall if a else None,
        "confidence_level": a.confidence_level if a else None,
        "review_reasons": sorted({r["code"] for r in (a.review_reasons if a else [])}),
        "needs_review": bool(a and a.needs_review),
        "dimensions": dims,
        "slo": (a.slo or {}).get("status") if a else None,
        "idle": (a.idle or {}).get("status") if a else None,
        "three_strike": (a.three_strike or {}).get("status") if a else None,
        "temperature": a.temperature_value if a else None,
        "trajectory": a.trajectory if a else None,
        "review": latest_review(a),
    }


def review_out(x: t.ReviewAction) -> dict[str, Any]:
    return {"id": x.id, "action": x.action, "reviewer_name": x.reviewer_name, "score_override": x.score_override,
            "comment": x.comment, "created_at": iso(x.created_at)}


def llm_summary(llm: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for name, v in (llm or {}).items():
        if name == "closure_reason":
            out[name] = {"status": v.get("status"), "result": v.get("result")}
            continue
        primary = next((r["result"] for r in v.get("runs", []) if r.get("result")), None) or {}
        out[name] = {
            "status": v.get("status"), "score": v.get("score"), "trajectory": v.get("trajectory"),
            "disagreement": v.get("disagreement"), "run_scores": v.get("run_scores"),
            "summary": primary.get("summary", ""), "coaching_action": primary.get("coaching_action", ""),
            "runs": [{"run_index": r["run_index"], "status": r["status"], "retries": r["retries"],
                      "dropped_findings": r["dropped_findings"]} for r in v.get("runs", [])],
        }
    return out


def case_detail(c: t.Case) -> dict[str, Any]:
    a = c.audit
    row = case_row(c)
    row.update({
        "description": c.description, "resolution": c.resolution, "missing_fields": c.missing_fields,
        "run_id": c.run_id,
        "items": [{"ref_id": i.ref_id, "type": i.item_type, "direction": i.direction, "internal": i.internal,
                   "author_role": i.author_role, "occurred_at": iso(i.occurred_at), "subject": i.subject,
                   "body": i.body, "is_auto_ack": i.is_auto_ack} for i in c.items],
        "status_changes": [{"from": s.from_status, "to": s.to_status, "at": iso(s.at)} for s in c.status_changes],
        "audit": None if not a else {
            "id": a.id, "state": a.state, "overall": a.overall, "dimensions": a.dimensions,
            "slo": a.slo, "idle": a.idle, "three_strike": a.three_strike, "closure": a.closure,
            "llm": llm_summary(a.llm), "temperature_value": a.temperature_value, "trajectory": a.trajectory,
            "confidence_score": a.confidence_score, "confidence_level": a.confidence_level,
            "confidence_reasons": a.confidence_reasons, "review_reasons": a.review_reasons,
            "needs_review": a.needs_review, "unsupported_count": a.unsupported_count, "retry_count": a.retry_count,
            "provider": a.provider, "model": a.model, "temperature": a.temperature,
            "prompt_versions": a.prompt_versions, "error_kind": a.error_kind, "created_at": iso(a.created_at),
            "findings": [{"id": f.id, "dimension": f.dimension, "kind": f.kind, "text": f.text,
                          "evidence": f.evidence} for f in a.findings],
            "review_actions": [review_out(x) for x in a.review_actions],
        },
    })
    return row
