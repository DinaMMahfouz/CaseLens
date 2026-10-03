"""Integration checks against the LOCAL Supabase stack (skipped when it isn't running).

Phase 1 item 8: the demo TSE login maps to Marta Lindqvist's tses row; the TSE sees only
cases whose tse_id is that row's id (no name matching), and titles use her display name.
"""
from __future__ import annotations

import shutil
import subprocess

import pytest

CONTAINER = "supabase_db_caselens-local"


def _psql(sql: str) -> list[list[str]]:
    out = subprocess.run(["docker", "exec", CONTAINER, "psql", "-U", "postgres", "-tA", "-F", "|", "-c", sql],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(out.stderr[:200])
    return [line.split("|") for line in out.stdout.strip().splitlines() if line]


def _stack_up() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return bool(_psql("select count(*) from public.cases"))
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _stack_up(), reason="local Supabase stack not running")


def _as_user(email: str, query: str) -> list[list[str]]:
    return _psql(f"""
      begin;
      select set_config('request.jwt.claims',
        json_build_object('sub', (select id from auth.users where email = '{email}'), 'role', 'authenticated')::text, true);
      set local role authenticated;
      {query};
      rollback;""")[:-1]    # drop the ROLLBACK status line


def test_demo_tse_login_maps_to_marta_by_id():
    rows = _psql("""select p.display_name, t.display_name from auth.users u
                    join public.profiles p on p.id = u.id join public.tses t on t.auth_user_id = u.id
                    where u.email = 'dina@caselens.test'""")
    assert rows == [["Marta Lindqvist", "Marta Lindqvist"]]


def test_tse_sees_only_own_cases_by_tse_id():
    seen = _as_user("dina@caselens.test", "select count(*), count(distinct tse_id) from public.cases")
    marta = _psql("""select count(*) from public.cases c join public.tses t on t.id = c.tse_id
                     where t.display_name = 'Marta Lindqvist'""")
    assert seen[-1] == [marta[0][0], "1"] and int(marta[0][0]) > 0


def test_manager_sees_everything():
    seen = _as_user("manager@caselens.test", "select count(*) from public.cases")
    assert seen[-1] == _psql("select count(*) from public.cases")[0]


def test_no_owner_name_column_remains():
    cols = _psql("""select column_name from information_schema.columns
                    where table_schema = 'public' and table_name = 'cases' and column_name = 'owner_name'""")
    assert cols == []
