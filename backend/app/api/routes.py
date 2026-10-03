"""REST API. Read-only toward source systems; reviewer actions are append-only."""
from __future__ import annotations

import secrets
from collections import Counter, defaultdict
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.adapters.excel import ExcelAdapter
from app.api import serializers as ser
from app.db import tables as t
from app.db.base import get_session
from app.export.xlsx import build_export
from app.logsafe import log_event

router = APIRouter(prefix="/api")
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def service(request: Request):
    return request.app.state.service


def _run_or_latest(s: Session, run_id: Optional[int]) -> Optional[t.Run]:
    if run_id:
        run = s.get(t.Run, run_id)
        if not run:
            raise HTTPException(404, "run not found")
        return run
    return (s.scalars(select(t.Run).where(t.Run.status == "done").order_by(t.Run.id.desc())).first()
            or s.scalars(select(t.Run).order_by(t.Run.id.desc())).first())


def _cases(s: Session, run: Optional[t.Run]) -> list[t.Case]:
    if not run:
        return []
    return list(s.scalars(
        select(t.Case).where(t.Case.run_id == run.id)
        .options(selectinload(t.Case.audit).selectinload(t.Audit.review_actions))
        .order_by(t.Case.case_number)
    ))


# ------------------------------------------------------------------ meta
@router.get("/health")
def health(svc=Depends(service)):
    return {"status": "ok", "provider": svc.provider.name, "model": svc.provider.model,
            "redaction_enabled": svc.settings.redaction_enabled, "synthetic": svc.settings.synthetic}


@router.get("/config")
def config(svc=Depends(service)):
    return svc.settings.public_view()


@router.get("/mapping")
def mapping(svc=Depends(service)):
    m = svc.settings.mapping
    return {"default_timezone": m.get("default_timezone"), "sheets": m.get("sheets", {}),
            "values": m.get("values", {}), "detection": m.get("detection", {})}


# ------------------------------------------------------------------ uploads & runs
@router.post("/uploads")
async def upload(file: UploadFile = File(...), svc=Depends(service), s: Session = Depends(get_session)):
    if not svc.settings.redaction_enabled:
        raise HTTPException(403, "uploads are refused while redaction is disabled")
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(400, "only .xlsx files are accepted")
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "file too large")
    folder = svc.settings.path(svc.settings.app["data_source"]["uploads_dir"])
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{secrets.token_hex(12)}.xlsx"        # original filename is not stored
    path = folder / name
    path.write_bytes(data)
    try:
        report = ExcelAdapter(svc.settings.mapping).inspect(path)
    except Exception as exc:
        path.unlink(missing_ok=True)
        log_event("upload_rejected", error_kind=type(exc).__name__)
        raise HTTPException(400, "file could not be read as an Excel workbook")
    row = t.Upload(size_bytes=len(data), stored_name=name, structure=report.to_dict())
    s.add(row)
    s.flush()
    log_event("upload_stored", upload_id=row.id, count=len(report.sheets_found))
    return {"id": row.id, "size_bytes": row.size_bytes, "structure": row.structure}


@router.get("/uploads/{upload_id}")
def get_upload(upload_id: int, s: Session = Depends(get_session)):
    row = s.get(t.Upload, upload_id)
    if not row:
        raise HTTPException(404, "upload not found")
    return {"id": row.id, "size_bytes": row.size_bytes, "structure": row.structure, "created_at": ser.iso(row.created_at)}


class RunIn(BaseModel):
    source: Literal["fixtures", "upload"]
    upload_id: Optional[int] = None

    @model_validator(mode="after")
    def _need_upload(self):
        if self.source == "upload" and not self.upload_id:
            raise ValueError("upload_id required for source=upload")
        return self


@router.post("/runs", status_code=202)
def start_run(body: RunIn, svc=Depends(service), s: Session = Depends(get_session)):
    if body.source == "upload" and not s.get(t.Upload, body.upload_id):
        raise HTTPException(404, "upload not found")
    try:
        run_id = svc.create_run(body.source, body.upload_id)
    except PermissionError as exc:
        raise HTTPException(403, str(exc))
    svc.submit(run_id)
    return {"id": run_id, "status": "queued"}


@router.get("/runs")
def list_runs(s: Session = Depends(get_session)):
    return [ser.run_out(r) for r in s.scalars(select(t.Run).order_by(t.Run.id.desc()).limit(100))]


@router.get("/runs/{run_id}")
def get_run(run_id: int, s: Session = Depends(get_session)):
    run = s.get(t.Run, run_id)
    if not run:
        raise HTTPException(404, "run not found")
    return ser.run_out(run)


# ------------------------------------------------------------------ dashboard
@router.get("/dashboard")
def dashboard(run_id: Optional[int] = None, s: Session = Depends(get_session)):
    run = _run_or_latest(s, run_id)
    cases = _cases(s, run)
    audits = [c.audit for c in cases if c.audit]
    buckets = [{"bucket": f"{i}-{i + 1}", "count": 0} for i in range(10)]
    for a in audits:
        if a.overall is not None:
            buckets[min(9, int(a.overall))]["count"] += 1
    slo_by_sev: dict[int, Counter] = defaultdict(Counter)
    for c in cases:
        if c.audit and c.audit.slo:
            slo_by_sev[c.severity or 0][c.audit.slo["status"]] += 1
    dims: dict[str, list[float]] = defaultdict(list)
    labels: dict[str, str] = {}
    for a in audits:
        for d in a.dimensions:
            labels[d["dimension"]] = d["label"]
            if d["status"] == "SCORED":
                dims[d["dimension"]].append(d["score"])
    reasons = Counter(r["code"] for a in audits for r in {x["code"]: x for x in a.review_reasons}.values())
    idle_cases = [ser.case_row(c) | {"support_idle_hours": c.audit.idle.get("support_idle_hours", 0),
                                     "customer_idle_hours": c.audit.idle.get("customer_idle_hours", 0)}
                  for c in cases if c.audit and c.audit.idle and c.audit.idle.get("windows")]
    scored = [a.overall for a in audits if a.overall is not None]
    slo_total = sum(v for cnt in slo_by_sev.values() for k, v in cnt.items() if k != "INSUFFICIENT_DATA")
    slo_met = sum(cnt["MET"] for cnt in slo_by_sev.values())
    return {
        "run": ser.run_out(run) if run else None,
        "kpis": {
            "cases": len(cases),
            "average_score": round(sum(scored) / len(scored), 2) if scored else None,
            "slo_compliance": round(slo_met / slo_total, 3) if slo_total else None,
            "review_queue": sum(1 for a in audits if a.needs_review),
            "eval_failed": sum(1 for a in audits if a.state == "EVAL_FAILED"),
            "redaction_failed": sum(1 for a in audits if a.state == "REDACTION_FAILED"),
            "support_idle_cases": sum(1 for a in audits if (a.idle or {}).get("status") == "SUPPORT_IDLE"),
        },
        "score_distribution": buckets,
        "slo_by_severity": [{"severity": sev, "MET": cnt["MET"], "BREACHED": cnt["BREACHED"],
                             "INSUFFICIENT_DATA": cnt["INSUFFICIENT_DATA"]} for sev, cnt in sorted(slo_by_sev.items())],
        "three_strike": dict(Counter((a.three_strike or {}).get("status", "N/A") for a in audits)),
        "idle": dict(Counter((a.idle or {}).get("status", "N/A") for a in audits)),
        "idle_cases": sorted(idle_cases, key=lambda r: -r["support_idle_hours"]),
        "dimension_averages": [{"dimension": k, "label": labels[k], "average": round(sum(v) / len(v), 2), "n": len(v)}
                               for k, v in dims.items()],
        "review_reasons": dict(reasons),
        "data_completeness_below_80": sum(1 for a in audits if (a.data_completeness or 0) < 0.8),
    }


# ------------------------------------------------------------------ cases
SORTABLE = {"case_number", "severity", "overall", "opened_at", "data_completeness", "status"}


@router.get("/cases")
def list_cases(
    run_id: Optional[int] = None, severity: Optional[list[int]] = Query(None),
    score_min: Optional[float] = None, score_max: Optional[float] = None,
    review_reason: Optional[str] = None, status: Optional[str] = None, state: Optional[str] = None,
    engineer: Optional[str] = None, needs_review: Optional[bool] = None, q: Optional[str] = None,
    sort: str = "case_number", order: Literal["asc", "desc"] = "asc",
    s: Session = Depends(get_session),
):
    run = _run_or_latest(s, run_id)
    rows = []
    for c in _cases(s, run):
        r = ser.case_row(c)
        if severity and c.severity not in severity:
            continue
        if score_min is not None and (r["overall"] is None or r["overall"] < score_min):
            continue
        if score_max is not None and (r["overall"] is None or r["overall"] > score_max):
            continue
        if review_reason and review_reason not in r["review_reasons"]:
            continue
        if status and c.status.lower() != status.lower():
            continue
        if state and c.state != state:
            continue
        if engineer and c.owner_label != engineer:
            continue
        if needs_review is not None and r["needs_review"] != needs_review:
            continue
        if q:
            needle = q.lower()
            if needle not in c.case_number.lower() and needle not in (c.subject or "").lower():
                continue
        rows.append(r)
    key = sort if sort in SORTABLE else "case_number"
    rows.sort(key=lambda r: (r[key] is None, r[key] if r[key] is not None else 0), reverse=(order == "desc"))
    if order == "desc":   # keep None last
        rows.sort(key=lambda r: r[key] is None)
    return {
        "run_id": run.id if run else None, "total": len(rows), "rows": rows,
        "facets": {
            "engineers": sorted({c.owner_label for c in _cases(s, run) if c.owner_label}),
            "statuses": sorted({c.status for c in _cases(s, run) if c.status}),
        },
    }


@router.get("/cases/{case_id}")
def get_case(case_id: int, s: Session = Depends(get_session)):
    c = s.get(t.Case, case_id)
    if not c:
        raise HTTPException(404, "case not found")
    return ser.case_detail(c)


# ------------------------------------------------------------------ review
@router.get("/review-queue")
def review_queue(run_id: Optional[int] = None, sort: Literal["severity", "score", "case_number"] = "severity",
                 s: Session = Depends(get_session)):
    run = _run_or_latest(s, run_id)
    rows = [ser.case_row(c) for c in _cases(s, run) if c.audit and c.audit.needs_review]
    keyf = {
        "severity": lambda r: (r["severity"] or 9, r["overall"] if r["overall"] is not None else -1),
        "score": lambda r: (r["overall"] if r["overall"] is not None else -1, r["severity"] or 9),
        "case_number": lambda r: r["case_number"],
    }[sort]
    rows.sort(key=keyf)
    groups: dict[str, list] = defaultdict(list)
    for r in rows:
        for code in r["review_reasons"]:
            groups[code].append(r)
    order = ["REDACTION_FAILED", "EVAL_FAILED", "RULE_BREACH", "HOT_CUSTOMER", "LOW_SCORE",
             "INSUFFICIENT_DATA", "EVALUATOR_DISAGREEMENT"]
    return {"run_id": run.id if run else None, "total": len(rows),
            "groups": [{"reason": k, "cases": groups[k]} for k in order if groups.get(k)]}


class ReviewIn(BaseModel):
    action: Literal["approve", "override", "comment"]
    reviewer_name: str = Field(min_length=1, max_length=128)
    score_override: Optional[float] = Field(default=None, ge=0, le=10)
    comment: str = Field(default="", max_length=4000)

    @model_validator(mode="after")
    def _check(self):
        if self.action == "override" and self.score_override is None:
            raise ValueError("score_override required for override")
        if self.action != "override" and self.score_override is not None:
            raise ValueError("score_override only allowed for override")
        if self.action == "comment" and not self.comment.strip():
            raise ValueError("comment text required")
        return self


@router.post("/audits/{audit_id}/review-actions", status_code=201)
def add_review(audit_id: int, body: ReviewIn, s: Session = Depends(get_session)):
    audit = s.get(t.Audit, audit_id)
    if not audit:
        raise HTTPException(404, "audit not found")
    action = t.ReviewAction(audit_id=audit_id, action=body.action, reviewer_name=body.reviewer_name.strip(),
                            score_override=body.score_override, comment=body.comment.strip())
    s.add(action)
    s.flush()
    log_event("review_action", audit_id=audit_id, status=body.action)
    return ser.review_out(action)


@router.get("/audits/{audit_id}/review-actions")
def list_reviews(audit_id: int, s: Session = Depends(get_session)):
    audit = s.get(t.Audit, audit_id)
    if not audit:
        raise HTTPException(404, "audit not found")
    return [ser.review_out(x) for x in audit.review_actions]


# ------------------------------------------------------------------ export
@router.get("/export.xlsx")
def export(run_id: Optional[int] = None, svc=Depends(service), s: Session = Depends(get_session)):
    run = _run_or_latest(s, run_id)
    if not run:
        raise HTTPException(404, "no runs")
    data = build_export(run, _cases(s, run))
    out_dir = svc.settings.path(svc.settings.app["data_source"].get("output_dir", "output"))
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"caselens-run-{run.id}.xlsx"
    (out_dir / name).write_bytes(data)
    log_event("export", run_id=run.id, count=len(data))
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
