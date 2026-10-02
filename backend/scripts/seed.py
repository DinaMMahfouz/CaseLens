"""Seed: generate synthetic fixtures and run a full audit with the configured provider
(mock by default) so the UI is populated immediately.

Usage:  python -m scripts.seed [--if-empty]
"""
from __future__ import annotations

import argparse
import json
import sys

from sqlalchemy import func, select

from app.db import tables as t
from app.db.base import init_engine, session_scope
from app.jobs.runner import AuditService
from app.logsafe import configure_logging
from app.settings import get_settings
from scripts.gen_fixtures import generate


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--if-empty", action="store_true", help="skip when runs already exist")
    args = parser.parse_args(argv)
    configure_logging()
    settings = get_settings()
    if not settings.synthetic:
        print("refusing to seed: data_source.synthetic is false")
        return 1
    init_engine(settings.database_url)
    with session_scope() as s:
        existing = s.scalar(select(func.count()).select_from(t.Run))
    if args.if_empty and existing:
        print(f"seed skipped: {existing} run(s) already in the database")
        return 0
    fixture = settings.path(settings.app["data_source"]["fixtures_path"])
    manifest = generate(fixture)
    (fixture.parent / "pii_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    svc = AuditService(settings)
    run_id = svc.create_run("fixtures")
    svc.process_run(run_id)
    with session_scope() as s:
        run = s.get(t.Run, run_id)
        queue = s.scalar(select(func.count()).select_from(t.Audit).where(t.Audit.run_id == run_id, t.Audit.needs_review))
        print(f"seeded run {run.id}: status={run.status} cases={run.processed} failed={run.failed} "
              f"review_queue={queue} provider={run.provider}")
    svc.pool.shutdown(wait=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
