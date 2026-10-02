"""CaseLens local worker CLI.

  python -m scripts.caselens audit --file data/export.xlsx --push   # redact + audit locally, push redacted results
  python -m scripts.caselens audit --fixtures --push                # same with synthetic fixtures
  python -m scripts.caselens push --run-id 3 [--replace]            # push an existing local run
  python -m scripts.caselens push --run-id 3 --emit-sql out.sql     # write SQL instead of calling the API
  python -m scripts.caselens invite --email a@b.com --name "Ann B" --role manager
  python -m scripts.caselens invite --email t@b.com --name "Marta L" --role tse --tse-name "Marta Lindqvist"

Network: only SUPABASE_URL (and the configured LLM endpoint during audits).
"""
from __future__ import annotations

import argparse
import shutil
import secrets
import sys
from pathlib import Path

from app.db import tables as t
from app.db.base import init_engine, session_scope
from app.logsafe import configure_logging
from app.settings import get_settings
from app.sync.supabase import SupabaseClient, SyncError, build_payload, push, to_sql


def _audit(args, settings) -> int:
    from app.jobs.runner import AuditService

    svc = AuditService(settings)
    if args.fixtures:
        if not settings.synthetic:
            print("--fixtures requires data_source.synthetic: true")
            return 1
        from scripts.gen_fixtures import generate
        generate(settings.path(settings.app["data_source"]["fixtures_path"]))
        run_id = svc.create_run("fixtures")
    else:
        src = Path(args.file)
        if not src.exists() or src.suffix.lower() != ".xlsx":
            print("--file must be an existing .xlsx export")
            return 1
        folder = settings.path(settings.app["data_source"]["uploads_dir"])
        folder.mkdir(parents=True, exist_ok=True)
        name = f"{secrets.token_hex(12)}.xlsx"
        shutil.copyfile(src, folder / name)
        with session_scope() as s:
            up = t.Upload(size_bytes=src.stat().st_size, stored_name=name, structure={})
            s.add(up)
            s.flush()
            upload_id = up.id
        run_id = svc.create_run("upload", upload_id)
    svc.process_run(run_id)
    svc.pool.shutdown(wait=False)
    with session_scope() as s:
        run = s.get(t.Run, run_id)
        print(f"local run {run_id}: status={run.status} cases={run.processed} failed={run.failed}")
        if run.status != "done":
            return 1
    if args.push:
        return _push(argparse.Namespace(run_id=run_id, replace=False, emit_sql=None))
    return 0


def _push(args) -> int:
    with session_scope() as s:
        payload = build_payload(s, args.run_id)
    if args.emit_sql:
        Path(args.emit_sql).write_text(to_sql(payload), encoding="utf-8")
        print(f"wrote SQL for {len(payload['cases'])} cases to {args.emit_sql}")
        return 0
    remote = push(SupabaseClient(), payload, replace=args.replace)
    print(f"pushed local run {args.run_id} -> supabase run {remote}: {len(payload['cases'])} cases, "
          f"{len(payload['findings'])} findings")
    return 0


def _invite(args) -> int:
    if args.role == "tse" and not args.tse_name:
        print("--tse-name is required for role tse (must match the Case Owner name in the export)")
        return 1
    client = SupabaseClient()
    user_id = client.invite(args.email, redirect_to=args.redirect_to)
    client.insert("profiles", [{
        "id": user_id, "email": args.email, "display_name": args.name, "role": args.role,
        "tse_name": args.tse_name if args.role == "tse" else None,
    }], upsert=True)
    print(f"{args.role} access granted to {args.email}; an invite email was sent if the account is new")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="caselens")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("audit", help="redact and audit an export locally")
    src = a.add_mutually_exclusive_group(required=True)
    src.add_argument("--file")
    src.add_argument("--fixtures", action="store_true")
    a.add_argument("--push", action="store_true", help="push redacted results to Supabase when done")
    pu = sub.add_parser("push", help="push a completed local run to Supabase")
    pu.add_argument("--run-id", type=int, required=True)
    pu.add_argument("--replace", action="store_true")
    pu.add_argument("--emit-sql")
    inv = sub.add_parser("invite", help="invite a user and grant a role")
    inv.add_argument("--email", required=True)
    inv.add_argument("--name", required=True)
    inv.add_argument("--role", choices=["manager", "tse"], required=True)
    inv.add_argument("--tse-name")
    inv.add_argument("--redirect-to", help="CaseLens URL to land on after accepting the invite")
    args = p.parse_args(argv)

    configure_logging()
    settings = get_settings()
    init_engine(settings.database_url)
    try:
        return {"audit": lambda: _audit(args, settings), "push": lambda: _push(args), "invite": lambda: _invite(args)}[args.cmd]()
    except SyncError as exc:
        print(f"error: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
