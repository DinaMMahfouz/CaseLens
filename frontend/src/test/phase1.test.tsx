// Phase 1 UI correctness tests.
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ageDays, plural, runsSummary, temperatureLabel } from "../lib/format";
import { ClosedOrAge } from "../pages/Cases";

// ------------------------------------------------------------------ item 1: runs label
describe("LLM card run summary", () => {
  it("shows per-run scores and completed/requested runs, never the score as a run count", () => {
    const r = runsSummary({ run_scores: [4, 4], requested_runs: 2, completed_runs: 2 });
    expect(r.scores).toBe("4 · 4");
    expect(r.completed).toBe("2 of 2 runs completed");
    expect(r.completed).not.toContain("4");
  });
  it("reports a failed run as requested but not completed", () => {
    expect(runsSummary({ run_scores: [3, null], requested_runs: 2, completed_runs: 1 }).completed).toBe("1 of 2 runs completed");
  });
  it("uses the singular for one run", () => {
    expect(runsSummary({ run_scores: [5], requested_runs: 1, completed_runs: 1 }).completed).toBe("1 of 1 run completed");
  });
});

// ------------------------------------------------------------------ item 3: temperature labels, never x/5
describe("customer temperature labels", () => {
  it("maps 1-5 to Calm / Neutral / Frustrated / Angry", () => {
    expect([1, 2, 3, 4, 5].map(temperatureLabel)).toEqual(["Calm", "Neutral", "Frustrated", "Angry", "Angry"]);
    expect(temperatureLabel(2.5)).toBe("Frustrated");
    expect(temperatureLabel(null)).toBe("—");
    expect([1, 2, 3, 4, 5].map(temperatureLabel).join(" ")).not.toMatch(/\/5/);
  });
});

// ------------------------------------------------------------------ item 6: dates
describe("Closed / Age cell", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  it("shows the close date when the source has one (00100016: closed_at present, opened_at missing)", () => {
    render(<ClosedOrAge r={{ status: "Closed", closed_at: "2026-09-28T07:32:00Z", opened_at: null }} now={now} />);
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.getByText(/Sep 28, 2026/)).toBeInTheDocument();
  });
  it("shows age for open cases", () => {
    render(<ClosedOrAge r={{ status: "In Progress", closed_at: null, opened_at: "2026-09-27T12:00:00Z" }} now={now} />);
    expect(screen.getByText("3 days open")).toBeInTheDocument();
  });
  it("shows — with a tooltip when the date is missing", () => {
    render(<ClosedOrAge r={{ status: "Closed", closed_at: null, opened_at: null }} now={now} />);
    expect(screen.getByText("—")).toHaveAttribute("title", "No date in source");
  });
  it("computes whole days", () => {
    expect(ageDays("2026-09-29T13:00:00Z", now)).toBe(0);
    expect(ageDays(null, now)).toBeNull();
  });
});

// ------------------------------------------------------------------ item 9: plurals
describe("plurals", () => {
  it.each([
    [1, "call", "1 call"], [2, "call", "2 calls"], [1, "retry", "1 retry"], [3, "retry", "3 retries"],
    [0, "unsupported finding", "0 unsupported findings"], [1, "day", "1 day"], [2, "day", "2 days"],
  ])("plural(%i, %s) = %s", (n, w, out) => expect(plural(n as number, w as string)).toBe(out));
});

// ------------------------------------------------------------------ item 7: routing, 404, safe errors
const caseMock = vi.fn();
vi.mock("../api", async (orig) => {
  const actual = await orig<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, case: (...a: unknown[]) => caseMock(...a) } };
});
vi.mock("../lib/hooks", async (orig) => {
  const actual = await orig<typeof import("../lib/hooks")>();
  const ctx = { runs: [], isManager: true, profile: { display_name: "Test Manager" }, runId: undefined,
                     tse: undefined, tses: [], setRunId: () => {}, setTse: () => {} };
  return {
    ...actual,
    useRun: () => ctx,
  };
});

async function renderDetail(path: string) {
  const { default: CaseDetailPage } = await import("../pages/CaseDetail");
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/cases/:id" element={<CaseDetailPage />} /><Route path="/cases" element={<p>cases list</p>} /></Routes>
    </MemoryRouter>,
  );
}

describe("case route", () => {
  beforeEach(() => caseMock.mockReset());

  it("accepts a case number and passes it through for resolution", async () => {
    caseMock.mockResolvedValue(null);
    await renderDetail("/cases/00100016");
    await waitFor(() => expect(caseMock).toHaveBeenCalledWith("00100016", undefined, []));
  });

  it("shows a 404 page with a back link for an unknown id", async () => {
    caseMock.mockResolvedValue(null);
    await renderDetail("/cases/does-not-exist");
    expect(await screen.findByText("Case not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to cases/i })).toHaveAttribute("href", "/cases");
  });

  it("never renders a raw database error and offers Retry", async () => {
    const { DataError } = await import("../api");
    caseMock.mockRejectedValueOnce(new Error('relation "cases" does not exist (SQLSTATE 42P01)'));
    await renderDetail("/cases/00100016");
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(screen.queryByText(/SQLSTATE|relation/)).toBeNull();
    caseMock.mockRejectedValueOnce(new DataError("unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Something went wrong while loading data.")).toBeInTheDocument();
  });
});

describe("uuid detection", () => {
  it("distinguishes uuids from case numbers", async () => {
    const { isUuid } = await import("../api");
    expect(isUuid("67c3d913-d9b1-495a-be91-ba0cd2956c2f")).toBe(true);
    expect(isUuid("00100016")).toBe(false);
  });
});

// ------------------------------------------------------------------ item 2: idle card never claims "no gaps" on missing data
describe("idle check card", () => {
  beforeEach(() => caseMock.mockReset());
  it("explains an insufficient-data idle check instead of saying there are no gaps", async () => {
    caseMock.mockResolvedValue({
      id: "x", case_number: "00100016", severity: 3, status: "Closed", state: "OK", owner: "Marta Lindqvist", tse_id: "t",
      account: "ACCT-1", product: "P", opened_at: null, closed_at: "2026-09-25T21:00:00Z", subject: "s", audit_id: "a",
      overall: 7.73, data_completeness: 0.7, scored_dimensions: 3, applicable_dimensions: 5, is_heuristic: true,
      review_reasons: ["INSUFFICIENT_DATA"], needs_review: true, dimensions: {}, slo: "INSUFFICIENT_DATA",
      idle: "INSUFFICIENT_DATA", three_strike: "NOT_APPLICABLE", temperature: 1, trajectory: "stable", review: null,
      description: "d", resolution: "r", missing_fields: ["opened_at", "item_timestamps"], run_id: "r", items: [],
      audit: {
        id: "a", state: "OK", overall: 7.73, dimensions: [], findings: [], review_actions: [], llm: {},
        slo: { status: "INSUFFICIENT_DATA", reason: "case open time missing" },
        idle: { status: "INSUFFICIENT_DATA", threshold_days: 5, windows: [], support_idle_hours: 0, customer_idle_hours: 0,
                reason: "2 customer-facing communications have no timestamp" },
        three_strike: { status: "NOT_APPLICABLE", required: 3, attempts: [], reason: "" }, closure: null,
        review_reasons: [{ code: "INSUFFICIENT_DATA", detail: "" }], completeness_reasons: [], agreement_details: {},
        scored_dimensions: 3, applicable_dimensions: 5, data_completeness: 0.7, run_agreement: 1, is_heuristic: true,
        unsupported_count: 0, retry_count: 0,
      },
    });
    await renderDetail("/cases/00100016");
    expect(await screen.findByTestId("idle-reason")).toHaveTextContent("2 customer-facing communications have no timestamp");
    expect(screen.queryByText("No gaps above the threshold.")).toBeNull();
    expect(screen.getByText(/Scored on 3 of 5 dimensions/)).toBeInTheDocument();
  });
});
