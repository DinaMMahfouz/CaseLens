// Data layer: reads REDACTED audit results from Supabase. Row-level security limits
// TSE users to their own cases; this module never needs to enforce that itself.
import { supabase } from "./lib/supabase";
import { fmtDate } from "./lib/format";
import {
  MEMBERSHIP_FIELD, configHashes, dataDate, hashesDiffer, latestRun, one, periodRows, previousRun, summarize,
  type Row, type Summary,
} from "./lib/metrics";
import {
  formatPeriodKey, membershipTooltip, periodLabel, previousPeriod, samePeriodLastYear, type Period, type Selection,
} from "./lib/scope";

export type Severity = 1 | 2 | 3 | 4 | null;

export interface Run {
  id: string;
  created_at: string;
  as_of: string | null;
  source: string;
  synthetic: boolean;
  total: number;
  failed: number;
  provider: string;
  model: string;
  temperature: number | null;
  config_hash: string;
  prompt_versions: Record<string, string>;
  /** normal | config_test (config-test runs are shown only when explicitly selected). */
  kind: string;
  label: string;
}

export interface ReviewSummary {
  action: string;
  reviewer_name: string;
  at: string;
  score_override: number | null;
  count: number;
}

export interface CaseRow {
  id: string;
  case_number: string;
  severity: Severity;
  status: string;
  state: "OK" | "EVAL_FAILED" | "REDACTION_FAILED";
  owner: string;
  account: string;
  product: string;
  opened_at: string | null;
  closed_at: string | null;
  subject: string;
  audit_id: string | null;
  overall: number | null;
  tse_id: string | null;
  data_completeness: number | null;
  scored_dimensions: number;
  applicable_dimensions: number;
  is_heuristic: boolean;
  review_reasons: string[];
  needs_review: boolean;
  dimensions: Record<string, number | null>;
  slo: string | null;
  idle: string | null;
  three_strike: string | null;
  temperature: number | null;
  trajectory: string | null;
  review: ReviewSummary | null;
}

export interface Evidence { ref_id: string; timestamp: string | null }
export interface Finding { id: string; dimension: string; kind: string; text: string; evidence: Evidence[] }
export interface Dimension {
  dimension: string; label: string; input: string; status: "SCORED" | "EXCLUDED";
  score: number | null; weight: number; effective_weight: number; note?: string; missing_data?: boolean;
}
export interface ReviewAction {
  id: string; action: string; reviewer_name: string; score_override: number | null; comment: string; created_at: string;
}
export interface IdleWindow {
  start: string; end: string; duration_hours: number; side: "SUPPORT_SIDE" | "CUSTOMER_SIDE";
  start_ref: string; end_ref: string; reason: string;
}
export interface Item {
  ref_id: string; type: "email" | "call" | "summary" | "handover" | "note"; direction: "inbound" | "outbound" | null;
  internal: boolean; author_role: "customer" | "support" | "system"; occurred_at: string | null;
  subject: string; body: string; is_auto_ack: boolean;
}
export interface LlmDim {
  status: string; score: number | null; trajectory: string | null; run_scores: (number | null)[];
  requested_runs: number; completed_runs: number;
  temp_start: number | null; temp_end: number | null; temp_peak: number | null;
  summary: string; coaching_action: string;
  runs: { run_index: number; status: string; retries: number; dropped_findings: number }[];
}
export interface Audit {
  id: string; state: string; overall: number | null; dimensions: Dimension[];
  slo: {
    status: string; severity: number | null; clock: string | null; target_minutes: number | null;
    actual_minutes: number | null; opened_at: string | null; response_ref: string | null;
    response_at: string | null; deadline_at: string | null; reason: string;
  } | null;
  idle: { status: string; threshold_days: number; windows: IdleWindow[]; support_idle_hours: number; customer_idle_hours: number; reason: string } | null;
  three_strike: {
    status: string; required: number; attempts: { ref_id: string; at: string; kind: string }[];
    closure_reason: string | null; last_customer_ref: string | null; last_customer_at: string | null;
    closed_at: string | null; reason: string;
  } | null;
  closure: { status: string; reason: string | null; evidence_refs: string[]; explanation: string } | null;
  llm: Record<string, LlmDim>;
  temperature_value: number | null; trajectory: string | null;
  temp_start: number | null; temp_end: number | null; temp_peak: number | null;
  scored_dimensions: number; applicable_dimensions: number;
  data_completeness: number | null;
  completeness_reasons: { code: string; field?: string; communications?: number; penalty: number }[];
  run_agreement: number | null;
  agreement_details: Record<string, { scores: number[]; range: number; modal_share: number; disagreement: boolean }>;
  is_heuristic: boolean; audited_at: string | null; config_hash: string;
  review_reasons: { code: string; detail: string }[];
  needs_review: boolean; unsupported_count: number; retry_count: number;
  provider: string; model: string; temperature: number | null; prompt_versions: Record<string, string>;
  error_kind: string; created_at: string; findings: Finding[]; review_actions: ReviewAction[];
}
export interface CaseDetail extends CaseRow {
  description: string; resolution: string; missing_fields: string[]; run_id: string;
  items: Item[]; audit: Audit | null;
}
/** One side of a comparison, resolved to concrete rows. */
export interface Side {
  key: string;                 // URL key of this side (for links/tests)
  label: string;               // "Sep 2026", "Latest run", "Run Aug 31, 2026"
  detail: string;              // tooltip: membership rule or run date
  kind: "run" | "period";
  run: Run | null;             // run sides only
  period: Period | null;       // period sides only
  rows: Row[];
  hashes: string[];
}
export interface ScopeData { cur: Side; cmp: Side | null; hashWarning: boolean; dataDate: string; latest: Run | null }
export interface Dashboard { scope: ScopeData; cur: Summary; cmp: Summary | null; idle_cases: (CaseRow & { support_idle_hours: number; customer_idle_hours: number })[] }
export interface Profile { id: string; email: string; display_name: string; role: "manager" | "tse" }
export interface Tse { id: string; display_name: string; active: boolean }

/** Thrown for any data-access failure. Its message is always safe to show; the raw error is
 *  logged to the browser console for developers and recorded in the Supabase API logs. */
export class DataError extends Error {
  constructor(public kind: "unavailable" | "forbidden") {
    super(kind === "forbidden" ? "You don't have access to this data." : "Something went wrong while loading data.");
  }
}

// ------------------------------------------------------------------ helpers
function check<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    console.error("[CaseLens] data error", res.error);   // never rendered
    throw new DataError(res.error.code === "42501" ? "forbidden" : "unavailable");
  }
  return res.data as T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);


const LIST_AUDIT = "id,state,overall,dimensions,slo,idle,three_strike,temperature_value,trajectory,data_completeness,scored_dimensions,applicable_dimensions,is_heuristic,review_reasons,needs_review,config_hash,review_actions(action,reviewer_name,created_at,score_override)";
const CASE_COLS = "id,run_id,case_number,severity,status,state,tse_id,tses(display_name),account_label,product,opened_at,closed_at,subject";

function latestReview(actions: Row[] | undefined): ReviewSummary | null {
  if (!actions?.length) return null;
  const sorted = [...actions].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const last = sorted[sorted.length - 1];
  const override = [...sorted].reverse().find((x) => x.action === "override")?.score_override ?? null;
  return { action: last.action, reviewer_name: last.reviewer_name, at: last.created_at, score_override: override, count: sorted.length };
}

function toRow(c: Row): CaseRow {
  const a = one(c.audits) as Row | null;
  const dims: Record<string, number | null> = {};
  (a?.dimensions ?? []).forEach((d: Dimension) => { dims[d.dimension] = d.score; });
  return {
    id: c.id, case_number: c.case_number, severity: c.severity, status: c.status, state: c.state,
    owner: one(c.tses)?.display_name ?? "", tse_id: c.tse_id ?? null, account: c.account_label, product: c.product, opened_at: c.opened_at, closed_at: c.closed_at,
    subject: c.subject, audit_id: a?.id ?? null, overall: a?.overall ?? null, data_completeness: a?.data_completeness ?? null,
    scored_dimensions: a?.scored_dimensions ?? 0, applicable_dimensions: a?.applicable_dimensions ?? 0,
    is_heuristic: Boolean(a?.is_heuristic),
    review_reasons: [...new Set<string>((a?.review_reasons ?? []).map((r: { code: string }) => r.code))].sort(),
    needs_review: Boolean(a?.needs_review), dimensions: dims,
    slo: a?.slo?.status ?? null, idle: a?.idle?.status ?? null, three_strike: a?.three_strike?.status ?? null,
    temperature: a?.temperature_value ?? null, trajectory: a?.trajectory ?? null,
    review: latestReview(a?.review_actions),
  };
}

// ------------------------------------------------------------------ case cache + scope resolution
// Every view works from one fetch of the visible case rows (RLS limits a TSE to their own cases).
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; rows: Promise<Row[]> }>();
export function invalidateCases() { cache.clear(); }

function allCases(tse?: string): Promise<Row[]> {
  const key = tse ?? "*";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  let q = supabase.from("cases").select(`${CASE_COLS},audits(${LIST_AUDIT})`).order("case_number");
  if (tse) q = q.eq("tse_id", tse);
  const rows = (async () => check(await q) as Row[])();
  rows.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

const RUN_DATE = (r: Run) => fmtDate(r.as_of ?? r.created_at, false);
export const runName = (r: Run) => r.label || `Run ${RUN_DATE(r)}`;

function runSide(run: Run | null, rows: Row[], label: string, key: string): Side {
  const mine = run ? rows.filter((r) => r.run_id === run.id) : [];
  return { key, label, detail: run ? `Audit run as of ${RUN_DATE(run)}` : "No earlier run", kind: "run", run,
           period: null, rows: mine, hashes: run?.config_hash ? [run.config_hash] : [] };
}

function periodSide(period: Period, rows: Row[], runs: Run[], openOn: string | null, key: string): Side {
  const mine = periodRows(rows, runs, period, { includeOpenOn: openOn });
  const tip = membershipTooltip(period, MEMBERSHIP_FIELD) + (openOn ? "; open cases are included" : "");
  return { key, label: periodLabel(period), detail: tip, kind: "period", run: null, period, rows: mine, hashes: configHashes(mine) };
}

/** Resolve a selection into Current and Compare sides (pure apart from the cached fetch). */
export function resolveScope(sel: Selection, runs: Run[], rows: Row[]): ScopeData {
  const latest = latestRun(runs);
  const today = dataDate(runs);
  let cur: Side;
  let cmp: Side | null = null;
  if (sel.cur.kind === "run") {
    const id = sel.cur.runId;
    const run = id === "latest" ? latest : runs.find((r) => r.id === id) ?? null;
    cur = runSide(run, rows, id === "latest" ? "Latest run" : run ? runName(run) : "Unknown run", id === "latest" ? "latest" : `run:${id}`);
    if (sel.cmp.kind === "prev-run") {
      const prev = run ? previousRun(runs, run) : null;
      cmp = runSide(prev, rows, "previous run", "prev");
    } else if (sel.cmp.kind === "run") {
      const other = runs.find((r) => r.id === (sel.cmp as { runId: string }).runId) ?? null;
      cmp = runSide(other, rows, other ? runName(other) : "Unknown run", `run:${sel.cmp.runId}`);
    }
  } else {
    const p = sel.cur.period;
    cur = periodSide(p, rows, runs, today, formatPeriodKey(p));
    const base = sel.cmp.kind === "prev-period" ? previousPeriod(p) : sel.cmp.kind === "yoy" ? samePeriodLastYear(p)
      : sel.cmp.kind === "period" ? sel.cmp.period : null;
    if (base) cmp = periodSide(base, rows, runs, null, formatPeriodKey(base));
  }
  return { cur, cmp, hashWarning: cmp ? hashesDiffer(cur.hashes, cmp.hashes) : false, dataDate: today, latest };
}

async function scope(sel: Selection, runs: Run[], tse?: string): Promise<ScopeData> {
  return resolveScope(sel, runs, await allCases(tse));
}

// ------------------------------------------------------------------ API
export const api = {
  async profile(userId: string): Promise<Profile | null> {
    const data = check(await supabase.from("profiles").select("*").eq("id", userId).limit(1)) as Profile[];
    return data[0] ?? null;
  },

  async runs(): Promise<Run[]> {
    return check(await supabase.from("runs").select("*").order("created_at", { ascending: false }).limit(100)) as Run[];
  },

  async tses(): Promise<Tse[]> {
    return check(await supabase.from("tses").select("id,display_name,active").eq("active", true).order("display_name")) as Tse[];
  },

  async dashboard(sel: Selection, runs: Run[], tse?: string, bucketWidth = 1): Promise<Dashboard> {
    const sc = await scope(sel, runs, tse);
    return {
      scope: sc,
      cur: summarize(sc.cur.rows, bucketWidth),
      cmp: sc.cmp ? summarize(sc.cmp.rows, bucketWidth) : null,
      idle_cases: sc.cur.rows.map((c) => ({ c, a: one(c.audits) as Row | null }))
        .filter(({ a }) => a?.idle?.windows?.length)
        .map(({ c, a }) => ({ ...toRow(c), support_idle_hours: a!.idle.support_idle_hours ?? 0, customer_idle_hours: a!.idle.customer_idle_hours ?? 0 }))
        .sort((x, y) => y.support_idle_hours - x.support_idle_hours),
    };
  },

  /** KPI series over consecutive periods (oldest first), for the Overview trend lines. */
  async trend(periods: Period[], runs: Run[], tse?: string) {
    const rows = await allCases(tse);
    const today = dataDate(runs);
    return periods.map((p) => ({ period: p, label: periodLabel(p), summary: summarize(periodRows(rows, runs, p, { includeOpenOn: today })) }));
  },

  async cases(sel: Selection, runs: Run[], params: {
    tse?: string; severity?: number[]; score_min?: string; score_max?: string; review_reason?: string;
    status?: string; state?: string; check?: string; q?: string; sort?: string; order?: "asc" | "desc";
  }) {
    const sc = await scope(sel, runs, params.tse);
    const rows = sc.cur.rows;
    let out = rows.map(toRow);
    const min = params.score_min ? Number(params.score_min) : null;
    const max = params.score_max ? Number(params.score_max) : null;
    out = out.filter((r) =>
      (!params.severity?.length || params.severity.includes(r.severity ?? 0)) &&
      (min == null || (r.overall != null && r.overall >= min)) &&
      (max == null || (r.overall != null && r.overall <= max)) &&
      (!params.review_reason || (params.review_reason === "any" ? r.needs_review : r.review_reasons.includes(params.review_reason))) &&
      (!params.status || r.status.toLowerCase() === params.status.toLowerCase()) &&
      (!params.state || (params.state === "failed" ? r.state !== "OK" : r.state === params.state)) &&
      matchesCheck(r, params.check) &&
      (!params.q || r.case_number.toLowerCase().includes(params.q.toLowerCase()) || r.subject.toLowerCase().includes(params.q.toLowerCase())),
    );
    const key = (["case_number", "severity", "overall", "opened_at"].includes(params.sort ?? "") ? params.sort : "case_number") as keyof CaseRow;
    const dir = params.order === "desc" ? -1 : 1;
    out.sort((a, b) => {
      const x = a[key] as string | number | null, y = b[key] as string | number | null;
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    return { scope: sc, total: out.length, rows: out, facets: { statuses: [...new Set(rows.map((r) => r.status as string))].filter(Boolean).sort() } };
  },

  /** Accepts a case UUID or a case number (resolved to the latest audit of that case in the
   *  current selection, else in any run). Returns null when no such case exists or it isn't visible. */
  async case(idOrNumber: string, sel?: Selection, runs: Run[] = []): Promise<CaseDetail | null> {
    let q = supabase.from("cases").select("*, tses(display_name), items(*), audits(*, findings(*), review_actions(*))");
    if (isUuid(idOrNumber)) {
      q = q.eq("id", idOrNumber);
    } else {
      if (!/^[\w-]{1,64}$/.test(idOrNumber)) return null;
      const rows = await allCases();
      const inScope = sel ? resolveScope(sel, runs, rows).cur.rows.find((r) => r.case_number === idOrNumber) : null;
      const anyRun = periodRows(rows.filter((r) => r.case_number === idOrNumber), runs,
                                { grain: "custom", from: "0000-01-01", to: "9999-12-31" }, { includeOpenOn: "0000-01-01" })[0];
      const hit = inScope ?? anyRun ?? rows.find((r) => r.case_number === idOrNumber);
      if (!hit) return null;
      q = q.eq("id", hit.id);
    }
    const data = check(await q.order("position", { referencedTable: "items" }).limit(1)) as Row[];
    const c = data[0];
    if (!c) return null;
    const a = one(c.audits) as Row | null;
    const base = toRow(c);
    return {
      ...base, description: c.description, resolution: c.resolution, missing_fields: c.missing_fields ?? [], run_id: c.run_id,
      items: (c.items ?? []).map((i: Row) => ({ ...i, type: i.item_type })) as Item[],
      audit: a ? {
        ...(a as Audit),
        llm: llmSummary(a.llm ?? {}),
        findings: a.findings ?? [],
        review_actions: [...(a.review_actions ?? [])].sort((x: Row, y: Row) => x.created_at.localeCompare(y.created_at)),
      } : null,
    };
  },

  async queue(sel: Selection, runs: Run[], sort: "severity" | "score" | "case_number" = "severity", tse?: string) {
    const sc = await scope(sel, runs, tse);
    const rows = sc.cur.rows;
    const list = rows.map(toRow).filter((r) => r.needs_review);
    const ov = (r: CaseRow) => (r.overall ?? -1);
    list.sort(sort === "score" ? (a, b) => ov(a) - ov(b) || (a.severity ?? 9) - (b.severity ?? 9)
      : sort === "case_number" ? (a, b) => a.case_number.localeCompare(b.case_number)
      : (a, b) => (a.severity ?? 9) - (b.severity ?? 9) || ov(a) - ov(b));
    const order = ["REDACTION_FAILED", "EVAL_FAILED", "RULE_BREACH", "HOT_CUSTOMER", "LOW_SCORE", "INSUFFICIENT_DATA", "EVALUATOR_DISAGREEMENT"];
    return {
      scope: sc, total: list.length,
      groups: order.map((reason) => ({ reason, cases: list.filter((r) => r.review_reasons.includes(reason)) })).filter((g) => g.cases.length),
    };
  },

  async review(auditId: string, body: { action: string; score_override?: number | null; comment?: string }) {
    // reviewer_id / reviewer_name / created_at are stamped server-side from the session.
    invalidateCases();
    check(await supabase.from("review_actions").insert({
      audit_id: auditId, action: body.action, comment: body.comment ?? "",
      score_override: body.action === "override" ? body.score_override : null,
    }));
  },

  async exportRows(sel: Selection, runs: Run[], tse?: string) {
    const sc = await scope(sel, runs, tse);
    const ids = sc.cur.rows.map((r) => r.id);
    if (!ids.length) return { scope: sc, cases: [] as Row[] };
    const q = supabase.from("cases").select("*, tses(display_name), items(ref_id,body), audits(*, findings(*), review_actions(*))").in("id", ids).order("case_number");
    return { scope: sc, cases: check(await q) as Row[] };
  },
};

/** Cases-page "check" filter: slo / idle / three_strike = breached; insufficient = any check lacking data. */
export function matchesCheck(r: CaseRow, check?: string): boolean {
  switch (check) {
    case "slo": return r.slo === "BREACHED";
    case "idle": return r.idle === "SUPPORT_IDLE";
    case "three_strike": return r.three_strike === "APPLIED_INCORRECTLY";
    case "insufficient": return [r.slo, r.idle, r.three_strike].includes("INSUFFICIENT_DATA");
    default: return true;
  }
}

function llmSummary(llm: Row): Record<string, LlmDim> {
  const out: Record<string, LlmDim> = {};
  for (const [name, v] of Object.entries(llm)) {
    const primary = (v.runs ?? []).find((r: Row) => r.result)?.result ?? v.result ?? {};
    const runs = v.runs ?? [];
    out[name] = {
      status: v.status, score: v.score ?? null, trajectory: v.trajectory ?? null,
      requested_runs: v.requested_runs ?? runs.length,
      completed_runs: v.completed_runs ?? runs.filter((r: Row) => r.status !== "FAILED").length,
      temp_start: v.temp_start ?? null, temp_end: v.temp_end ?? null, temp_peak: v.temp_peak ?? null,
      run_scores: v.run_scores ?? [], summary: primary.summary ?? primary.explanation ?? "", coaching_action: primary.coaching_action ?? "",
      runs: (v.runs ?? []).map((r: Row) => ({ run_index: r.run_index, status: r.status, retries: r.retries, dropped_findings: r.dropped_findings })),
    };
  }
  return out;
}
