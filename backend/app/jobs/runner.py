"""Background audit jobs: in-process worker pool, state persisted in the DB."""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select

from app.adapters.excel import ExcelAdapter
from app.db import tables as t
from app.db.base import session_scope
from app.db.repo import save_case_audit
from app.llm.prompts import load_prompts
from app.llm.providers import LLMProvider, build_provider
from app.logsafe import log_event
from app.pipeline import AuditEngine
from app.redaction.redactor import Redactor
from app.settings import Settings


class AuditService:
    def __init__(self, settings: Settings, provider: Optional[LLMProvider] = None):
        self.settings = settings
        self.provider = provider or build_provider(settings.app)
        self.redactor = Redactor(settings.redaction, settings.app, settings.pseudonym_key)
        self.prompts = load_prompts(settings.root / "prompts")
        self.engine = AuditEngine(settings, self.provider, self.redactor, self.prompts)
        self.pool = ThreadPoolExecutor(max_workers=int(settings.app.get("jobs", {}).get("workers", 1)),
                                       thread_name_prefix="audit")
        self._lock = threading.Lock()
        self._source_override: dict[int, str] = {}

    # ------------------------------------------------------------------ lifecycle
    def recover_interrupted(self) -> None:
        with session_scope() as s:
            for run in s.scalars(select(t.Run).where(t.Run.status.in_(["queued", "running"]))):
                run.status, run.error_kind = "failed", "interrupted"

    def create_run(self, source: str, upload_id: Optional[int] = None, as_of: Optional[datetime] = None,
                   source_path: Optional[str] = None, kind: str = "normal", label: str = "") -> int:
        """as_of fixes "now" for idle/SLO checks (deterministic fixture runs);
        source_path overrides the configured fixture file for this run only."""
        if source == "upload" and not self.settings.redaction_enabled:
            raise PermissionError("uploads are refused while redaction is disabled")
        with session_scope() as s:
            run = t.Run(
                source=source, upload_id=upload_id, status="queued",
                synthetic=(source == "fixtures" and self.settings.synthetic),
                as_of=as_of or datetime.now(timezone.utc), config_hash=self.settings.config_hash,
                kind=kind, label=label,
                provider=self.provider.name, model=self.provider.model,
                temperature=self.provider.effective_temperature,
                prompt_versions={k: p.version for k, p in self.prompts.items()},
            )
            s.add(run)
            s.flush()
            if source_path:
                self._source_override[run.id] = source_path
            return run.id

    def submit(self, run_id: int):
        return self.pool.submit(self.process_run, run_id)

    # ------------------------------------------------------------------ work
    def _source_path(self, run: t.Run, s) -> str:
        if run.id in self._source_override:
            return self._source_override[run.id]
        if run.source == "fixtures":
            return str(self.settings.path(self.settings.app["data_source"]["fixtures_path"]))
        upload = s.get(t.Upload, run.upload_id)
        return str(self.settings.path(self.settings.app["data_source"]["uploads_dir"]) / upload.stored_name)

    def process_run(self, run_id: int) -> None:
        with self._lock:
            with session_scope() as s:
                run = s.get(t.Run, run_id)
                run.status, run.started_at = "running", datetime.now(timezone.utc)
                path, as_of = self._source_path(run, s), run.as_of
            log_event("run_started", run_id=run_id)
            try:
                result = ExcelAdapter(self.settings.mapping).load(path)
            except Exception as exc:
                with session_scope() as s:
                    run = s.get(t.Run, run_id)
                    run.status, run.error_kind = "failed", type(exc).__name__
                    run.finished_at = datetime.now(timezone.utc)
                log_event("run_failed", run_id=run_id, error_kind=type(exc).__name__)
                return
            with session_scope() as s:
                run = s.get(t.Run, run_id)
                run.total = len(result.cases)
                run.ingest_report = result.report.to_dict()
            for raw in result.cases:
                try:
                    audit = self.engine.audit(raw, result.roster, as_of)
                except Exception as exc:  # unexpected - record without raw text
                    log_event("case_error", run_id=run_id, case_number=raw.case_number, error_kind=type(exc).__name__)
                    audit = self.engine._blocked(raw)
                    audit.state, audit.error_kind = "EVAL_FAILED", type(exc).__name__
                    audit.review_reasons = [{"code": "EVAL_FAILED", "detail": "unexpected processing error"}]
                with session_scope() as s:
                    run = s.get(t.Run, run_id)
                    save_case_audit(s, run, audit, self.provider.name, self.provider.model,
                                    self.provider.effective_temperature)
                    run.processed += 1
                    if audit.state != "OK":
                        run.failed += 1
            result.cases.clear()
            with session_scope() as s:
                run = s.get(t.Run, run_id)
                run.status, run.finished_at = "done", datetime.now(timezone.utc)
            log_event("run_done", run_id=run_id, status="done")
