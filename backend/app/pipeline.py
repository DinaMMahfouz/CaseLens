"""Per-case audit pipeline: ingest -> redact -> leak check -> evaluate -> score.

Raw text and the pseudonym map exist only inside `AuditEngine.audit` for the duration
of one case. Nothing raw is returned.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from app.domain.models import RawCase, RedactedCase
from app.llm.evaluator import EvalRun, build_payload, payload_text_fields, run_evaluation, user_message
from app.llm.prompts import Prompt
from app.llm.providers import LLMProvider
from app.logsafe import log_event
from app.redaction.leak_scanner import scan_fields
from app.redaction.redactor import Redactor, keyed_label
from app.rules.idle import evaluate_idle
from app.rules.results import ClosureClassification, IdleResult, SloResult, ThreeStrikeResult
from app.rules.slo import evaluate_slo
from app.rules.three_strike import evaluate_three_strike
from app.scoring.quality import compute_quality
from app.scoring.routing import route
from app.scoring.score import DimAgg, aggregate, compute_dimensions, coverage, overall_score
from app.settings import Settings

LLM_RUBRICS = ("troubleshooting", "temperature", "communication")


@dataclass
class CaseAudit:
    case: RedactedCase                      # redacted (text-free when REDACTION_FAILED)
    state: str                              # OK | EVAL_FAILED | REDACTION_FAILED
    slo: Optional[SloResult] = None
    idle: Optional[IdleResult] = None
    three_strike: Optional[ThreeStrikeResult] = None
    closure: Optional[ClosureClassification] = None
    llm: dict[str, Any] = field(default_factory=dict)
    dimensions: list[dict[str, Any]] = field(default_factory=list)
    overall: Optional[float] = None
    scored_dimensions: int = 0
    applicable_dimensions: int = 0
    data_completeness: Optional[float] = None
    completeness_reasons: list[dict[str, Any]] = field(default_factory=list)
    run_agreement: Optional[float] = None
    agreement_details: dict[str, Any] = field(default_factory=dict)
    is_heuristic: bool = False
    audited_at: Optional[datetime] = None
    review_reasons: list[dict[str, str]] = field(default_factory=list)
    findings: list[dict[str, Any]] = field(default_factory=list)
    unsupported_count: int = 0
    retry_count: int = 0
    prompt_versions: dict[str, str] = field(default_factory=dict)
    error_kind: str = ""
    temperature_value: Optional[float] = None   # = temp_end (one source)
    trajectory: Optional[str] = None
    temp_start: Optional[float] = None
    temp_end: Optional[float] = None
    temp_peak: Optional[float] = None


def _fields(case: RedactedCase) -> dict[str, str]:
    f = {"subject": case.subject, "DESC": case.description, "RES": case.resolution}
    for it in case.items:
        f[f"{it.ref_id}.subject"] = it.subject
        f[f"{it.ref_id}.body"] = it.body
    return f


def _strings(obj: Any, prefix: str = "") -> dict[str, str]:
    out: dict[str, str] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k not in ("ref_id", "timestamp"):
                out.update(_strings(v, f"{prefix}.{k}"))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out.update(_strings(v, f"{prefix}[{i}]"))
    elif isinstance(obj, str):
        out[prefix] = obj
    return out


class AuditEngine:
    def __init__(self, settings: Settings, provider: LLMProvider, redactor: Redactor, prompts: dict[str, Prompt]):
        self.s = settings
        self.provider = provider
        self.redactor = redactor
        self.prompts = prompts
        self.runs = int(settings.app.get("llm", {}).get("runs_per_evaluation", 2))

    def _metadata_only(self, raw: RawCase) -> RedactedCase:
        show_acct = self.s.app.get("display", {}).get("show_account_name", False)
        show_eng = self.s.app.get("display", {}).get("show_engineer_names", False)
        return RedactedCase(
            case_number=raw.case_number, severity=raw.severity, status=raw.status, is_closed=raw.is_closed,
            opened_at=raw.opened_at, closed_at=raw.closed_at, product=raw.product,
            owner_label=raw.owner if show_eng else keyed_label("TSE", raw.owner, self.s.pseudonym_key),
            account_label=raw.account_name if show_acct else keyed_label("ACCT", raw.account_name, self.s.pseudonym_key),
        )

    def audit(self, raw: RawCase, roster: list[str], as_of: datetime) -> CaseAudit:
        t0 = time.monotonic()
        # 1. Redact --------------------------------------------------------------
        try:
            case, ctx = self.redactor.redact_case(raw, roster)
        except Exception as exc:  # fail closed
            log_event("redaction", case_number=raw.case_number, status="REDACTION_FAILED", error_kind=type(exc).__name__)
            return self._blocked(raw)
        # 2. Independent leak check --------------------------------------------------
        if self.redactor.enabled:
            hits = scan_fields(_fields(case), ctx.sensitive_values())
            payload = build_payload(case)
            hits += scan_fields(payload_text_fields(payload), ctx.sensitive_values())
            if hits:
                for det in sorted({h.detector for h in hits}):
                    log_event("leak_check", case_number=raw.case_number, status="blocked", detector=det)
                return self._blocked(raw)
        else:
            payload = build_payload(case)
        del raw  # raw text no longer needed

        # 3. Deterministic rules --------------------------------------------------------
        slo = evaluate_slo(case, self.s.rules, as_of)
        idle = evaluate_idle(case, self.s.rules, as_of)

        # 4. LLM evaluations ------------------------------------------------------------
        msg = user_message(payload)
        refs = case.ref_timestamps()
        redact = lambda text: self.redactor.redact_output(text, ctx)  # noqa: E731
        llm: dict[str, DimAgg] = {}
        for rubric in LLM_RUBRICS:
            runs = [run_evaluation(self.provider, self.prompts[rubric], msg, i, refs, redact)
                    for i in range(self.runs)]
            for r in runs:
                log_event("llm_eval", case_number=case.case_number, dimension=rubric, run_index=r.run_index,
                          status=r.status, retries=r.retries, error_kind=r.error_kind or None)
            llm[rubric] = aggregate(rubric, runs)

        closure_runs: list[EvalRun] = []
        closure: Optional[ClosureClassification] = None
        if case.is_closed:
            cr = run_evaluation(self.provider, self.prompts["closure_reason"], msg, 0, refs, redact)
            closure_runs.append(cr)
            log_event("llm_eval", case_number=case.case_number, dimension="closure_reason", run_index=0,
                      status=cr.status, retries=cr.retries)
            if cr.status == "FAILED":
                closure = ClosureClassification(status="FAILED")
            else:
                res = cr.result or {}
                closure = ClosureClassification(
                    status=res.get("status", "INSUFFICIENT_EVIDENCE"), reason=res.get("reason"),
                    evidence_refs=[e["ref_id"] for e in res.get("evidence", [])],
                    explanation=res.get("explanation", ""))
        strike = evaluate_three_strike(case, closure, self.s.rules)

        audit = CaseAudit(case=case, state="OK", slo=slo, idle=idle, three_strike=strike, closure=closure,
                          audited_at=datetime.now(timezone.utc), is_heuristic=self.provider.name == "mock")
        audit.prompt_versions = {k: p.version for k, p in self.prompts.items()}
        all_runs = [r for a in llm.values() for r in a.runs] + closure_runs
        audit.llm = {k: {"status": a.status, "score": a.score, "trajectory": a.trajectory,
                         "temp_start": a.temp_start, "temp_end": a.temp_end, "temp_peak": a.temp_peak,
                         "requested_runs": a.requested_runs, "completed_runs": a.completed_runs,
                         "run_scores": a.run_scores,
                         "runs": [{"run_index": r.run_index, "status": r.status, "retries": r.retries,
                                   "dropped_findings": r.dropped_findings, "error_kind": r.error_kind,
                                   "result": r.result} for r in a.runs]}
                     for k, a in llm.items()}
        if closure_runs:
            audit.llm["closure_reason"] = {"status": closure_runs[0].status, "result": closure_runs[0].result,
                                           "retries": closure_runs[0].retries}
        audit.unsupported_count = sum(r.dropped_findings for r in all_runs)
        audit.retry_count = sum(r.retries for r in all_runs)

        if any(r.status == "FAILED" for r in all_runs):
            audit.state = "EVAL_FAILED"
            audit.error_kind = next(r.error_kind for r in all_runs if r.status == "FAILED")

        # 5. Output leak check (LLM output was re-redacted; verify independently) ----------
        if self.redactor.enabled and audit.state == "OK":
            out_hits = scan_fields(_strings(audit.llm), ctx.sensitive_values())
            if out_hits:
                audit.state, audit.error_kind = "EVAL_FAILED", "output_leak"
                audit.llm = {k: {"status": "FAILED", "runs": []} for k in audit.llm}
                llm = {k: DimAgg(rubric=k, runs=[]) for k in llm}

        # 6. Scores, quality, routing ---------------------------------------------------------
        temp = llm.get("temperature")
        if temp and temp.status == "OK":
            audit.temp_start, audit.temp_end, audit.temp_peak = temp.temp_start, temp.temp_end, temp.temp_peak
            audit.temperature_value, audit.trajectory = temp.temp_end, temp.trajectory
        audit.dimensions = compute_dimensions(slo, idle, strike, llm, self.s.scoring)
        audit.scored_dimensions, audit.applicable_dimensions = coverage(audit.dimensions)
        audit.overall = overall_score(audit.dimensions) if audit.state == "OK" else None
        comms = sum(1 for i in case.items if i.customer_facing and not i.is_auto_ack)
        q = compute_quality(llm, case.missing_fields, comms, self.s.scoring, self.s.review)
        audit.data_completeness, audit.completeness_reasons = q.data_completeness, q.completeness_reasons
        audit.run_agreement, audit.agreement_details = q.run_agreement, q.agreement_details
        missing = [d["dimension"] for d in audit.dimensions
                   if d["status"] == "EXCLUDED" and d.get("missing_data")]
        audit.review_reasons = route(
            audit.state, audit.overall, slo_status=slo.status, strike_status=strike.status,
            temp_start=audit.temp_start, temp_end=audit.temp_end, temp_peak=audit.temp_peak,
            data_completeness=q.data_completeness, excluded_for_missing=missing,
            disagreement=q.disagreement, cfg=self.s.review)
        if audit.state == "OK":
            for name, agg in llm.items():
                primary = next((r for r in agg.runs if r.result), None)
                if not primary:
                    continue
                for kind in ("top_issues", "missed_steps", "repeated_requests", "shift_points", "handover_issues"):
                    for f in primary.result.get(kind, []):
                        audit.findings.append({"dimension": name, "kind": kind, "text": f["text"],
                                               "evidence": f["evidence"], "run_index": primary.run_index})
        log_event("case_audited", case_number=case.case_number, state=audit.state,
                  duration_ms=int((time.monotonic() - t0) * 1000))
        del ctx
        return audit

    def _blocked(self, raw: RawCase) -> CaseAudit:
        case = self._metadata_only(raw)
        audit = CaseAudit(case=case, state="REDACTION_FAILED", error_kind="leak_detected",
                          audited_at=datetime.now(timezone.utc), is_heuristic=self.provider.name == "mock")
        audit.review_reasons = route("REDACTION_FAILED", None, cfg=self.s.review)
        return audit
