"""Seed the LOCAL Supabase stack (supabase start) for development, tests and screenshots.

  python -m scripts.local_stack            # users + fixture runs into the local stack

Safety:
  * Refuses to run unless the API URL is localhost / 127.0.0.1 (never the hosted project).
  * Test credentials are generated on first run and stored only in the repo-root
    .env.local (gitignored). They are never printed.
  * Uses the LOCAL stack's service key from `supabase status`, never a hosted key.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
ENV_LOCAL = ROOT / ".env.local"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

# Fixture runs loaded into the local stack: (label, reference/as-of, kind, case prefix, config tweak)
FIXTURE_RUNS = [
    ("Sep 2026", datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc), "normal", "001", None),
]


def local_status() -> dict[str, str]:
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        sys.exit("npx not found; install Node.js")
    out = subprocess.run([npx, "--yes", "supabase@latest", "status", "-o", "json"], cwd=ROOT,
                         capture_output=True, text=True, check=True).stdout
    data = json.loads(out[out.index("{"):])
    url = data.get("API_URL", "")
    if urlparse(url).hostname not in LOCAL_HOSTS:
        sys.exit("refusing: the Supabase API URL is not a local stack")
    return data


def read_env_local() -> dict[str, str]:
    values: dict[str, str] = {}
    if ENV_LOCAL.exists():
        for line in ENV_LOCAL.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip()
    return values


def ensure_credentials() -> dict[str, str]:
    env = read_env_local()
    changed = False
    defaults = {
        "LOCAL_MANAGER_EMAIL": "manager@caselens.test",
        "LOCAL_TSE_EMAIL": "dina@caselens.test",
    }
    for k, v in defaults.items():
        if not env.get(k):
            env[k], changed = v, True
    for k in ("LOCAL_MANAGER_PASSWORD", "LOCAL_TSE_PASSWORD"):
        if not env.get(k):
            env[k], changed = secrets.token_urlsafe(18), True
    if changed:
        lines = ["# LOCAL Supabase stack test accounts (generated; never commit; never used for hosted)"]
        lines += [f"{k}={v}" for k, v in env.items()]
        ENV_LOCAL.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return env


def write_frontend_env(status: dict[str, str]) -> None:
    """Vite mode `localstack` -> frontend/.env.localstack (gitignored)."""
    key = status.get("PUBLISHABLE_KEY") or status.get("ANON_KEY", "")
    (ROOT / "frontend" / ".env.localstack").write_text(
        f"VITE_SUPABASE_URL={status['API_URL']}\nVITE_SUPABASE_PUBLISHABLE_KEY={key}\n", encoding="utf-8")


def create_users(client, env: dict[str, str]) -> None:
    for role in ("MANAGER", "TSE"):
        r = client.http.post("/auth/v1/admin/users", json={
            "email": env[f"LOCAL_{role}_EMAIL"], "password": env[f"LOCAL_{role}_PASSWORD"], "email_confirm": True})
        if r.status_code not in (200, 201, 422):
            sys.exit(f"could not create local {role.lower()} user: HTTP {r.status_code}")


def main() -> int:
    status = local_status()
    service_key = status.get("SECRET_KEY") or status.get("SERVICE_ROLE_KEY")
    env = ensure_credentials()
    write_frontend_env(status)

    # Point the worker at a separate local SQLite file and the local stack only.
    os.environ["DATABASE_URL"] = f"sqlite:///{(ROOT / 'var' / 'localstack.db').as_posix()}"
    os.environ["SUPABASE_URL"] = status["API_URL"]
    os.environ["SUPABASE_SECRET_KEY"] = service_key

    from app.db.base import init_engine, session_scope
    from app.jobs.runner import AuditService
    from app.logsafe import configure_logging
    from app.settings import get_settings
    from app.sync.supabase import SupabaseClient, build_payload, push
    from scripts.gen_fixtures import generate

    configure_logging()
    settings = get_settings()
    init_engine(os.environ["DATABASE_URL"])
    client = SupabaseClient(status["API_URL"], service_key)
    create_users(client, env)

    for label, reference, kind, prefix, _tweak in FIXTURE_RUNS:
        path = ROOT / "var" / f"localstack_{prefix}.xlsx"
        generate(path, reference)
        svc = AuditService(settings)
        run_id = svc.create_run("fixtures", as_of=reference, source_path=str(path))
        svc.process_run(run_id)
        svc.pool.shutdown(wait=False)
        with session_scope() as s:
            payload = build_payload(s, run_id)
        push(client, payload, replace=True)
        print(f"local stack: pushed {label} ({len(payload['cases'])} cases)")
    print("local stack ready; credentials are in .env.local")
    return 0


if __name__ == "__main__":
    sys.exit(main())
