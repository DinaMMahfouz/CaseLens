// Phase 2 shared foundations: labels, status vocabulary, thresholds, low sample, run details, times, states.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ChecksCell, RunDetails, SampleTag, StatusPill, SyntheticBanner, Time } from "../components/ui";
import { CHECK_VOCAB, checkLabel, dimensionInputLabel, lookup, ITEM_TYPE } from "../lib/labels";
import { band, capByRelated, reviewRateBand } from "../lib/thresholds";
import type { Dashboard, Run } from "../api";

const RAW = /\b[A-Z]{2,}(?:_[A-Z]+)+\b/;
const CODES = ["MET", "BREACHED", "INSUFFICIENT_DATA", "NOT_APPLICABLE", "SUPPORT_IDLE", "NO_SUPPORT_IDLE", "APPLIED_CORRECTLY", "APPLIED_INCORRECTLY"];

const run: Run = {
  id: "r1", created_at: "2026-09-30T12:00:00Z", as_of: "2026-09-30T12:00:00Z", source: "fixtures", synthetic: true, total: 3, failed: 0,
  provider: "mock", model: "mock-heuristic-v1", temperature: null, config_hash: "abc123", prompt_versions: { troubleshooting: "v2" },
};

describe("status vocabulary", () => {
  it("maps every check outcome to Met / Breached / Insufficient data / Not applicable", () => {
    const vocab = new Set(Object.values(CHECK_VOCAB));
    CODES.forEach((c) => expect(vocab.has(checkLabel(c))).toBe(true));
    expect(Object.values(CHECK_VOCAB)).toEqual(["Met", "Breached", "Insufficient data", "Not applicable"]);
  });
  it("never shows n/d, n/a or OK in the compact checks cell", () => {
    const { container } = render(<ChecksCell slo="INSUFFICIENT_DATA" idle="NO_SUPPORT_IDLE" strike="NOT_APPLICABLE" />);
    expect(container.textContent).toBe("SLO · Insufficient data");
    expect(container.textContent).not.toMatch(/n\/d|n\/a|\bOK\b/);
    const all = render(<ChecksCell slo="MET" idle="NO_SUPPORT_IDLE" strike="APPLIED_CORRECTLY" />);
    expect(all.container.textContent).toBe("All met");
  });
  it("gives each status a defining tooltip", () => {
    render(<StatusPill check="idle" value="INSUFFICIENT_DATA" />);
    expect(screen.getByText("Insufficient data")).toHaveAttribute("title", expect.stringMatching(/^Insufficient data: .*timestamp/));
  });
});

describe("label mapping", () => {
  it("never returns a raw code, even for unknown values", () => {
    expect(lookup(ITEM_TYPE, "SOMETHING_NEW")).toBe("Other");
    expect(dimensionInputLabel("CUSTOMER_CONFIRMED")).not.toMatch(RAW);
    ["worsening", "stable", "4/5", ...CODES].forEach((v) => expect(dimensionInputLabel(v)).not.toMatch(RAW));
  });
});

describe("thresholds", () => {
  it("bands scores at 8 and 6", () => {
    expect([8, 7.9, 6, 5.9, null].map((v) => band("score", v))).toEqual(["good", "warn", "warn", "bad", "none"]);
  });
  it("bands SLO compliance at 90% and 75%", () => {
    expect([0.9, 0.89, 0.75, 0.74].map((v) => band("slo_compliance", v))).toEqual(["good", "warn", "warn", "bad"]);
  });
  it("never shows green while a related rate is red", () => {
    expect(capByRelated("good", [reviewRateBand(0.5)])).toBe("warn");
    expect(capByRelated("good", [reviewRateBand(0.1)])).toBe("good");
  });
});

describe("low sample", () => {
  it("marks n < 5 with n and a low-sample tag", () => {
    render(<SampleTag n={3} />);
    expect(screen.getByText("n=3")).toBeInTheDocument();
    expect(screen.getByText("low sample")).toBeInTheDocument();
  });
  it("shows nothing for an adequate sample", () => {
    const { container } = render(<SampleTag n={12} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("synthetic banner, run details, times", () => {
  it("shows an amber banner only for fixture runs", () => {
    render(<SyntheticBanner run={run} />);
    expect(screen.getByTestId("synthetic-banner")).toHaveTextContent("Synthetic data");
    const real = render(<SyntheticBanner run={{ ...run, source: "upload", synthetic: false }} />);
    expect(real.container).toBeEmptyDOMElement();
  });
  it("keeps provider and model inside the collapsible run details", () => {
    render(<RunDetails info={{ ...run, dropped_findings: 1, retries: 2 }} />);
    const d = screen.getByTestId("run-details");
    expect(d.tagName).toBe("DETAILS");
    expect(within(d).getByText("mock-heuristic-v1")).toBeInTheDocument();
    expect(within(d).getByText("1 unsupported finding")).toBeInTheDocument();
    expect(within(d).getByText("2 retries")).toBeInTheDocument();
  });
  it("renders local time with UTC on hover", () => {
    render(<Time iso="2026-09-28T07:32:00Z" />);
    expect(screen.getByText(/Sep 28, 2026/).closest("time")).toHaveAttribute("title", "2026-09-28 07:32 UTC");
  });
});

// ------------------------------------------------------------------ Overview: thresholds, low sample, "mock" containment
const dash: Dashboard = {
  run,
  kpis: { cases: 3, average_score: 8.4, scored: 3, slo_compliance: 1, slo_n: 3, review_queue: 2, review_rate: 2 / 3,
          eval_failed: 0, redaction_failed: 0, support_idle_cases: 0 },
  score_distribution: Array.from({ length: 10 }, (_, i) => ({ bucket: `${i}-${i + 1}`, count: i === 8 ? 3 : 0 })),
  slo_by_severity: [{ severity: 2, MET: 3, BREACHED: 0, INSUFFICIENT_DATA: 0 }],
  three_strike: { NOT_APPLICABLE: 3 }, idle: {}, idle_cases: [],
  dimension_averages: [{ dimension: "communication", label: "Communication", average: 8, n: 3 }],
  review_reasons: { INSUFFICIENT_DATA: 1, HOT_CUSTOMER: 1 }, low_completeness: 1,
};
vi.mock("../api", async (orig) => {
  const actual = await orig<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, dashboard: () => Promise.resolve(dash) } };
});
vi.mock("../lib/hooks", async (orig) => {
  const actual = await orig<typeof import("../lib/hooks")>();
  return { ...actual, useRun: () => ({ runs: [run], isManager: true, profile: { display_name: "Test Manager" }, runId: undefined,
    tse: "t-1", tseName: "Marta Lindqvist", tses: [], currentRun: run, setRunId: () => {}, setTse: () => {} }) };
});

describe("Overview", () => {
  it("names the selected TSE, marks low samples, and keeps 'mock' inside Run details", async () => {
    const { default: Overview } = await import("../pages/Overview");
    const { container } = render(<MemoryRouter><Overview /></MemoryRouter>);
    expect(await screen.findByText("Overview · Marta Lindqvist")).toBeInTheDocument();
    expect(within(screen.getByTestId("kpi-Average score")).getByText("low sample")).toBeInTheDocument();
    // "mock" appears nowhere outside the run-details popover
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[data-testid=run-details]").forEach((n) => n.remove());
    expect(clone.textContent).not.toMatch(/mock/i);
    expect(clone.textContent).not.toMatch(RAW);
  });
});
