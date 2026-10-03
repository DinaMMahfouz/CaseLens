// Phase 3 comparison rules.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { resolveScope, type Run } from "../api";
import { ComparisonHeader, DeltaTag } from "../components/ui";
import { delta, periodRows, summarize } from "../lib/metrics";
import {
  compareAllowed, monthPeriod, parseSelection, periodLabel, previousPeriod, samePeriodLastYear, serializeSelection, withSelection,
  type Selection,
} from "../lib/scope";

const mkRun = (id: string, as_of: string, config_hash = "h1", kind = "normal"): Run => ({
  id, created_at: as_of, as_of, source: "fixtures", synthetic: true, total: 0, failed: 0, provider: "p", model: "m",
  temperature: null, config_hash, prompt_versions: {}, kind, label: kind === "config_test" ? "Synthetic · config test" : "",
});
const row = (id: string, run_id: string, case_number: string, closed_at: string | null, overall = 7, config_hash = "h1", status = "Closed") => ({
  id, run_id, case_number, status, closed_at, opened_at: "2026-08-01T00:00:00Z", severity: 3, state: "OK", subject: "",
  audits: [{ id: `a-${id}`, state: "OK", overall, config_hash, needs_review: false, review_reasons: [], dimensions: [], slo: { status: "MET" } }],
});

const jul = mkRun("r-jul", "2026-07-31T12:00:00Z");
const aug = mkRun("r-aug", "2026-08-31T12:00:00Z");
const sep = mkRun("r-sep", "2026-09-30T12:00:00Z");
const test = mkRun("r-test", "2026-09-30T11:00:00Z", "h2", "config_test");
const runs = [sep, test, aug, jul];

describe("period membership", () => {
  it("counts a case audited in 3 runs once in a monthly view (latest audit wins)", () => {
    const rows = [
      row("1", "r-jul", "C1", "2026-09-10T00:00:00Z", 5),
      row("2", "r-aug", "C1", "2026-09-10T00:00:00Z", 6),
      row("3", "r-sep", "C1", "2026-09-10T00:00:00Z", 8),
    ];
    const got = periodRows(rows, runs, monthPeriod(2026, 9));
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe("3");
    expect(summarize(got).cases).toBe(1);
  });

  it("never places an open case in a past period, only in the current one containing the data date", () => {
    const rows = [row("o", "r-sep", "OPEN1", null, 7, "h1", "In Progress"), row("c", "r-aug", "C2", "2026-08-15T00:00:00Z")];
    expect(periodRows(rows, runs, monthPeriod(2026, 8)).map((r) => r.id)).toEqual(["c"]);
    expect(periodRows(rows, runs, monthPeriod(2026, 8), { includeOpenOn: "2026-09-30" }).map((r) => r.id)).toEqual(["c"]);
    expect(periodRows(rows, runs, monthPeriod(2026, 9), { includeOpenOn: "2026-09-30" }).map((r) => r.id)).toEqual(["o"]);
  });

  it("ignores config-test runs in period views", () => {
    const rows = [row("t", "r-test", "C3", "2026-09-12T00:00:00Z", 9, "h2")];
    expect(periodRows(rows, runs, monthPeriod(2026, 9))).toHaveLength(0);
  });
});

describe("run comparison", () => {
  it("compares the latest run with the previous normal run (config-test runs are skipped)", () => {
    const rows = [row("s", "r-sep", "C1", "2026-09-10T00:00:00Z"), row("a", "r-aug", "C9", "2026-08-10T00:00:00Z")];
    const sc = resolveScope({ cur: { kind: "run", runId: "latest" }, cmp: { kind: "prev-run" } }, runs, rows);
    expect(sc.cur.run?.id).toBe("r-sep");
    expect(sc.cmp?.run?.id).toBe("r-aug");
    expect(sc.hashWarning).toBe(false);
  });
});

describe("config hash warning", () => {
  it("warns when the two sides were scored under different rules", () => {
    const rows = [row("s", "r-sep", "C1", "2026-09-10T00:00:00Z"), row("t", "r-test", "C1", "2026-09-10T00:00:00Z", 9, "h2")];
    const sc = resolveScope({ cur: { kind: "run", runId: "r-test" }, cmp: { kind: "run", runId: "r-sep" } }, runs, rows);
    expect(sc.hashWarning).toBe(true);
    render(<ComparisonHeader scope={sc} count={1} />);
    expect(screen.getByTestId("config-warning")).toHaveTextContent("Scoring rules changed between these periods; part of the delta comes from the rule change.");
  });
  it("does not warn for Sep vs Aug under the same rules", () => {
    const rows = [row("s", "r-sep", "C1", "2026-09-10T00:00:00Z"), row("a", "r-aug", "C9", "2026-08-10T00:00:00Z")];
    const sc = resolveScope({ cur: { kind: "period", period: monthPeriod(2026, 9) }, cmp: { kind: "prev-period" } }, runs, rows);
    expect(sc.cur.label).toBe("Sep 2026");
    expect(sc.cmp?.label).toBe("Aug 2026");
    expect(sc.hashWarning).toBe(false);
  });
});

describe("deltas", () => {
  it("uses absolute points for scores and pp for rates, never relative %", () => {
    expect(delta(7.18, 6.74, "score")?.text).toBe("▲ 0.4");
    expect(delta(0.72, 0.78, "rate")?.text).toBe("▼ 6 pp");
    expect(delta(0.72, 0.78, "rate")?.text).not.toMatch(/%/);
  });
  it("does not colour a delta when n < 5", () => {
    render(<DeltaTag d={delta(8, 6, "score")} baseLabel="Aug 2026" low />);
    expect(screen.getByTestId("delta")).toHaveAttribute("data-coloured", "no");
  });
  it("shows 'No data for <period>' for an empty baseline, never 0", () => {
    render(<DeltaTag d={delta(5, 0, "count")} baseLabel="Jul 2026" baseEmpty />);
    expect(screen.getByTestId("delta-nodata")).toHaveTextContent("No data for Jul 2026");
    expect(screen.queryByTestId("delta")).toBeNull();
  });
});

describe("selection in the URL", () => {
  const cases: [string, Selection][] = [
    ["cur=2026-09&cmp=2026-08", { cur: { kind: "period", period: monthPeriod(2026, 9) }, cmp: { kind: "period", period: monthPeriod(2026, 8) } }],
    ["", { cur: { kind: "run", runId: "latest" }, cmp: { kind: "prev-run" } }],
    ["cur=2026-Q3&cmp=yoy", { cur: { kind: "period", period: { grain: "quarter", from: "2026-07-01", to: "2026-09-30" } }, cmp: { kind: "yoy" } }],
    ["cur=2026-09-01..2026-09-07&cmp=none", { cur: { kind: "period", period: { grain: "custom", from: "2026-09-01", to: "2026-09-07" } }, cmp: { kind: "none" } }],
  ];
  it.each(cases)("round-trips %s", (qs, sel) => {
    const parsed = parseSelection(new URLSearchParams(qs));
    expect(parsed).toEqual(sel);
    expect(parseSelection(withSelection(new URLSearchParams(), parsed))).toEqual(sel);
    expect(serializeSelection(parsed).cur).toBe(new URLSearchParams(qs).get("cur") ?? "latest");
  });
  it("rejects mixing a run with a period", () => {
    expect(compareAllowed({ kind: "run", runId: "latest" }, { kind: "prev-period" })).toBe(false);
    expect(parseSelection(new URLSearchParams("cur=latest&cmp=2026-08")).cmp).toEqual({ kind: "prev-run" });
  });
  it("computes previous and year-ago periods", () => {
    expect(periodLabel(previousPeriod(monthPeriod(2026, 1)))).toBe("Dec 2025");
    expect(periodLabel(samePeriodLastYear(monthPeriod(2026, 9)))).toBe("Sep 2025");
  });
});
