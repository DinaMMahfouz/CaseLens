"""Machine-vs-human agreement per dimension against the golden set.

Golden files: golden/cases/<case_number>.json
  {"case_number": "...", "reviewer": "...", "scores": {
      "troubleshooting": 1-5, "communication": 1-5, "temperature": 1-5,
      "slo": "MET|BREACHED|INSUFFICIENT_DATA", "idle": "NO_SUPPORT_IDLE|SUPPORT_IDLE|INSUFFICIENT_DATA",
      "three_strike": "APPLIED_CORRECTLY|APPLIED_INCORRECTLY|NOT_APPLICABLE|INSUFFICIENT_DATA"}}
Use null for a dimension the human did not score.

Usage:  python -m scripts.golden_agreement [--run-id N] [--golden-dir golden/cases] [--json]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import select

from app.db import tables as t
from app.db.base import init_engine, session_scope
from app.settings import get_settings

NUMERIC = ("troubleshooting", "communication", "temperature")
CATEGORICAL = ("slo", "idle", "three_strike")


def machine_scores(audit: t.Audit) -> dict[str, Any]:
    llm = audit.llm or {}
    out: dict[str, Any] = {k: (llm.get(k) or {}).get("score") for k in NUMERIC}
    out["slo"] = (audit.slo or {}).get("status")
    out["idle"] = (audit.idle or {}).get("status")
    out["three_strike"] = (audit.three_strike or {}).get("status")
    return out


def agreement(golden: list[dict], machine: dict[str, dict]) -> dict[str, dict[str, Any]]:
    report: dict[str, dict[str, Any]] = {}
    for dim in NUMERIC + CATEGORICAL:
        pairs = []
        for g in golden:
            h = g.get("scores", {}).get(dim)
            m = machine.get(g["case_number"], {}).get(dim)
            if h is None or m is None:
                continue
            pairs.append((h, m))
        row: dict[str, Any] = {"n": len(pairs)}
        if pairs:
            if dim in NUMERIC:
                diffs = [abs(float(h) - float(m)) for h, m in pairs]
                row["exact"] = round(sum(d < 0.5 for d in diffs) / len(pairs), 3)
                row["within_1"] = round(sum(d <= 1 for d in diffs) / len(pairs), 3)
                row["mae"] = round(sum(diffs) / len(pairs), 3)
            else:
                row["exact"] = round(sum(h == m for h, m in pairs) / len(pairs), 3)
        report[dim] = row
    return report


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-id", type=int)
    p.add_argument("--golden-dir", default=None)
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    settings = get_settings()
    gdir = Path(args.golden_dir) if args.golden_dir else settings.root / "golden" / "cases"
    golden = [json.loads(f.read_text(encoding="utf-8")) for f in sorted(gdir.glob("*.json"))]
    if not golden:
        print(f"no golden cases in {gdir}")
        return 1
    init_engine(settings.database_url)
    with session_scope() as s:
        run = s.get(t.Run, args.run_id) if args.run_id else s.scalars(
            select(t.Run).where(t.Run.status == "done").order_by(t.Run.id.desc())).first()
        if not run:
            print("no completed run found")
            return 1
        machine = {c.case_number: machine_scores(c.audit)
                   for c in s.scalars(select(t.Case).where(t.Case.run_id == run.id)) if c.audit}
        run_id = run.id
    report = agreement(golden, machine)
    if args.json:
        print(json.dumps({"run_id": run_id, "golden_cases": len(golden), "dimensions": report}, indent=2))
        return 0
    print(f"Run {run_id} vs {len(golden)} golden case(s)")
    print(f"{'dimension':<16}{'n':>4}{'exact':>9}{'within1':>9}{'MAE':>7}")
    for dim, r in report.items():
        print(f"{dim:<16}{r['n']:>4}{r.get('exact', '-'):>9}{r.get('within_1', '-'):>9}{r.get('mae', '-'):>7}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
