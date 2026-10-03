// Data layer: reads REDACTED audit results from Supabase. Row-level security limits
// TSE users to their own cases; this module never needs to enforce that itself.
import { supabase } from "./lib/supabase";

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
export interface Dashboard {
  run: Run | null;
  kpis: {
    cases: number; average_score: number | null; slo_compliance: number | null; review_queue: number;
    eval_failed: number; redaction_failed: number; support_idle_cases: number;
  };
  score_distribution: { bucket: string; count: number }[];
  slo_by_severity: { severity: number; MET: number; BREACHED: number; INSUFFICIENT_DATA: number }[];
  three_strike: Record<string, number>;
  idle: Record<string, number>;
  idle_cases: (CaseRow & { support_idle_hours: number; customer_idle_hours: number })[];
  dimension_averages: { dimension: string; label: string; average: number; n: number }[];
  review_reasons: Record<string, number>;
  low_completeness: number;
}
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
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const LIST_AUDIT = "id,state,overall,dimensions,slo,idle,three_strike,temperature_value,trajectory,data_completeness,scored_dimensions,applicable_dimensions,is_heuristic,review_reasons,needs_review,review_actions(action,reviewer_name,created_at,score_override)";
const CASE_COLS = "id,case_number,severity,status,state,tse_id,tses(display_name),account_label,product,opened_at,closed_at,subject";

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

async function resolveRun(runId?: string): Promise<Run | null> {
  const q = supabase.from("runs").select("*").order("created_at", { ascending: false }).limit(1);
  const data = check(runId ? await supabase.from("runs").select("*").eq("id", runId).limit(1) : await q) as Run[];
  return data[0] ?? null;
}

async function runCases(runId?: string, tse?: string): Promise<{ run: Run | null; rows: Row[] }> {
  const run = await resolveRun(runId);
  if (!run) return { run: null, rows: [] };
  let q = supabase.from("cases")
    .select(`${CASE_COLS},audits(${LIST_AUDIT})`)
    .eq("run_id", run.id).order("case_number");
  if (tse) q = q.eq("tse_id", tse);
  return { run, rows: check(await q) as Row[] };
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

  async dashboard(runId?: string, tse?: string): Promise<Dashboard> {
    const { run, rows } = await runCases(runId, tse);
    const cases = rows.map((c) => ({ c, a: one(c.audits) as Row | null }));
    const audits = cases.map((x) => x.a).filter(Boolean) as Row[];
    const buckets = Array.from({ length: 10 }, (_, i) => ({ bucket: `${i}-${i + 1}`, count: 0 }));
    audits.forEach((a) => { if (a.overall != null) buckets[Math.min(9, Math.floor(a.overall))].count += 1; });
    const slo = new Map<number, { MET: number; BREACHED: number; INSUFFICIENT_DATA: number }>();
    cases.forEach(({ c, a }) => {
      if (!a?.slo) return;
      const k = c.severity ?? 0;
      const cur = slo.get(k) ?? { MET: 0, BREACHED: 0, INSUFFICIENT_DATA: 0 };
      cur[a.slo.status as "MET"] += 1;
      slo.set(k, cur);
    });
    const dims = new Map<string, { label: string; v: number[] }>();
    audits.forEach((a) => (a.dimensions ?? []).forEach((d: Dimension) => {
      const cur = dims.get(d.dimension) ?? { label: d.label, v: [] };
      if (d.status === "SCORED" && d.score != null) cur.v.push(d.score);
      dims.set(d.dimension, cur);
    }));
    const count = (vals: string[]) => vals.reduce<Record<string, number>>((acc, v) => { acc[v] = (acc[v] ?? 0) + 1; return acc; }, {});
    const scored = audits.map((a) => a.overall).filter((x): x is number => x != null);
    let sloMet = 0, sloTotal = 0;
    slo.forEach((v) => { sloMet += v.MET; sloTotal += v.MET + v.BREACHED; });
    return {
      run,
      kpis: {
        cases: rows.length,
        average_score: scored.length ? Math.round((scored.reduce((s, x) => s + x, 0) / scored.length) * 100) / 100 : null,
        slo_compliance: sloTotal ? sloMet / sloTotal : null,
        review_queue: audits.filter((a) => a.needs_review).length,
        eval_failed: audits.filter((a) => a.state === "EVAL_FAILED").length,
        redaction_failed: audits.filter((a) => a.state === "REDACTION_FAILED").length,
        support_idle_cases: audits.filter((a) => a.idle?.status === "SUPPORT_IDLE").length,
      },
      score_distribution: buckets,
      slo_by_severity: [...slo.entries()].sort((a, b) => a[0] - b[0]).map(([severity, v]) => ({ severity, ...v })),
      three_strike: count(audits.map((a) => a.three_strike?.status ?? "N/A")),
      idle: count(audits.map((a) => a.idle?.status ?? "N/A")),
      idle_cases: cases.filter(({ a }) => a?.idle?.windows?.length)
        .map(({ c, a }) => ({ ...toRow(c), support_idle_hours: a!.idle.support_idle_hours ?? 0, customer_idle_hours: a!.idle.customer_idle_hours ?? 0 }))
        .sort((x, y) => y.support_idle_hours - x.support_idle_hours),
      dimension_averages: [...dims.entries()].filter(([, v]) => v.v.length)
        .map(([dimension, v]) => ({ dimension, label: v.label, average: Math.round((v.v.reduce((s, x) => s + x, 0) / v.v.length) * 100) / 100, n: v.v.length })),
      review_reasons: count(audits.flatMap((a) => [...new Set<string>((a.review_reasons ?? []).map((r: { code: string }) => r.code))])),
      low_completeness: audits.filter((a) => a.data_completeness != null && a.data_completeness < 0.8).length,
    };
  },

  async cases(params: {
    run_id?: string; tse?: string; severity?: number[]; score_min?: string; score_max?: string; review_reason?: string;
    status?: string; state?: string; q?: string; sort?: string; order?: "asc" | "desc";
  }) {
    const { run, rows } = await runCases(params.run_id, params.tse);
    let out = rows.map(toRow);
    const min = params.score_min ? Number(params.score_min) : null;
    const max = params.score_max ? Number(params.score_max) : null;
    out = out.filter((r) =>
      (!params.severity?.length || params.severity.includes(r.severity ?? 0)) &&
      (min == null || (r.overall != null && r.overall >= min)) &&
      (max == null || (r.overall != null && r.overall <= max)) &&
      (!params.review_reason || r.review_reasons.includes(params.review_reason)) &&
      (!params.status || r.status.toLowerCase() === params.status.toLowerCase()) &&
      (!params.state || r.state === params.state) &&
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
    return { run_id: run?.id ?? null, total: out.length, rows: out, facets: { statuses: [...new Set(rows.map((r) => r.status as string))].filter(Boolean).sort() } };
  },

  /** Accepts a case UUID or a case number (resolved in the given run, else the latest run).
   *  Returns null when no such case exists or it isn't visible to the signed-in user. */
  async case(idOrNumber: string, runId?: string): Promise<CaseDetail | null> {
    let q = supabase.from("cases").select("*, tses(display_name), items(*), audits(*, findings(*), review_actions(*))");
    if (isUuid(idOrNumber)) {
      q = q.eq("id", idOrNumber);
    } else {
      const run = await resolveRun(runId);
      if (!run || !/^[\w-]{1,64}$/.test(idOrNumber)) return null;
      q = q.eq("case_number", idOrNumber).eq("run_id", run.id);
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

  async queue(runId?: string, sort: "severity" | "score" | "case_number" = "severity", tse?: string) {
    const { run, rows } = await runCases(runId, tse);
    const list = rows.map(toRow).filter((r) => r.needs_review);
    const ov = (r: CaseRow) => (r.overall ?? -1);
    list.sort(sort === "score" ? (a, b) => ov(a) - ov(b) || (a.severity ?? 9) - (b.severity ?? 9)
      : sort === "case_number" ? (a, b) => a.case_number.localeCompare(b.case_number)
      : (a, b) => (a.severity ?? 9) - (b.severity ?? 9) || ov(a) - ov(b));
    const order = ["REDACTION_FAILED", "EVAL_FAILED", "RULE_BREACH", "HOT_CUSTOMER", "LOW_SCORE", "LOW_CONFIDENCE"];
    return {
      run_id: run?.id ?? null, total: list.length,
      groups: order.map((reason) => ({ reason, cases: list.filter((r) => r.review_reasons.includes(reason)) })).filter((g) => g.cases.length),
    };
  },

  async review(auditId: string, body: { action: string; score_override?: number | null; comment?: string }) {
    // reviewer_id / reviewer_name / created_at are stamped server-side from the session.
    check(await supabase.from("review_actions").insert({
      audit_id: auditId, action: body.action, comment: body.comment ?? "",
      score_override: body.action === "override" ? body.score_override : null,
    }));
  },

  async exportRows(runId?: string, tse?: string) {
    const run = await resolveRun(runId);
    if (!run) throw new Error("No runs to export");
    let q = supabase.from("cases").select("*, tses(display_name), items(ref_id,body), audits(*, findings(*), review_actions(*))").eq("run_id", run.id).order("case_number");
    if (tse) q = q.eq("tse_id", tse);
    return { run, cases: check(await q) as Row[] };
  },
};

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
