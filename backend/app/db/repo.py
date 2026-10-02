"""Persistence of audit results (redacted data only)."""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.db import tables as t
from app.pipeline import CaseAudit


def _dump(model) -> Any:
    return model.model_dump(mode="json") if model is not None else None


def save_case_audit(session: Session, run: t.Run, audit: CaseAudit, provider: str, model: str,
                    temperature) -> t.Audit:
    c = audit.case
    blocked = audit.state == "REDACTION_FAILED"
    case = t.Case(
        run_id=run.id, case_number=c.case_number,
        subject="" if blocked else c.subject, description="" if blocked else c.description,
        severity=c.severity, status=c.status, is_closed=c.is_closed, opened_at=c.opened_at,
        closed_at=c.closed_at, owner_label=c.owner_label, account_label=c.account_label,
        product=c.product, resolution="" if blocked else c.resolution,
        missing_fields=c.missing_fields, state=audit.state,
    )
    if not blocked:
        for pos, it in enumerate(c.items):
            case.items.append(t.Item(
                position=pos, ref_id=it.ref_id, item_type=it.item_type,
                direction=it.direction.value if it.direction else None, internal=it.internal,
                author_role=it.author_role, occurred_at=it.occurred_at, subject=it.subject,
                body=it.body, is_auto_ack=it.is_auto_ack,
            ))
        for sc in c.status_changes:
            case.status_changes.append(t.StatusChange(from_status=sc.from_status, to_status=sc.to_status, at=sc.at))
    session.add(case)
    session.flush()
    row = t.Audit(
        case_id=case.id, run_id=run.id, state=audit.state, overall=audit.overall,
        dimensions=audit.dimensions, slo=_dump(audit.slo), idle=_dump(audit.idle),
        three_strike=_dump(audit.three_strike), closure=_dump(audit.closure), llm=audit.llm,
        temperature_value=audit.temperature_value, trajectory=audit.trajectory,
        confidence_score=audit.confidence_score, confidence_level=audit.confidence_level,
        confidence_reasons=audit.confidence_reasons, review_reasons=audit.review_reasons,
        needs_review=bool(audit.review_reasons), unsupported_count=audit.unsupported_count,
        retry_count=audit.retry_count, provider=provider, model=model, temperature=temperature,
        prompt_versions=audit.prompt_versions, error_kind=audit.error_kind,
    )
    for f in audit.findings:
        row.findings.append(t.Finding(dimension=f["dimension"], kind=f["kind"], text=f["text"],
                                      evidence=f["evidence"], run_index=f["run_index"]))
    session.add(row)
    session.flush()
    return row
