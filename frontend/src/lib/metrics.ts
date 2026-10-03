// Pure aggregation over case rows (a case row from Supabase with its embedded audit).
import displayCfg from "../config/display.json";
import { inPeriod, ymd, type Period } from "./scope";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export interface RunLike { id: string; as_of: string | null; created_at: string; kind?: string; config_hash: string }

export const MEMBERSHIP_FIELD: "closed_at" | "opened_at" =
  (displayCfg as { period_membership?: string }).period_membership === "opened_at" ? "opened_at" : "closed_at";

export const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
export const isOpenCase = (c: Row) => !c.closed_at && !/closed|resolved/i.test(c.status ?? "");

// ------------------------------------------------------------------ runs
const runTime = (r: RunLike) => r.as_of ?? r.created_at;
/** Normal runs (config-test runs excluded), newest first. */
export const normalRuns = <R extends RunLike>(runs: R[]): R[] =>
  runs.filter((r) => (r.kind ?? "normal") === "normal").sort((a, b) => runTime(b).localeCompare(runTime(a)));
export const latestRun = <R extends RunLike>(runs: R[]): R | null => normalRuns(runs)[0] ?? null;
export function previousRun<R extends RunLike>(runs: R[], run: R): R | null {
  return normalRuns(runs).find((r) => r.id !== run.id && runTime(r) < runTime(run)) ?? null;
}
/** "Today" for period views: the as-of date of the latest normal run (falls back to the real date). */
export const dataDate = (runs: RunLike[], now = new Date()) => {
  const r = latestRun(runs);
  return r ? ymd(new Date(runTime(r))) : ymd(now);
};

// ------------------------------------------------------------------ period membership
/** Cases in a period: latest audit per case across normal runs, placed by the membership date.
 *  Open cases count only when the period is the current one and contains the data date. */
export function periodRows(rows: Row[], runs: RunLike[], period: Period,
                           opts: { includeOpenOn?: string | null; field?: "closed_at" | "opened_at" } = {}): Row[] {
  const field = opts.field ?? MEMBERSHIP_FIELD;
  const byId = new Map(runs.map((r) => [r.id, r]));
  const latest = new Map<string, { row: Row; t: string }>();
  for (const row of rows) {
    const run = byId.get(row.run_id);
    if (!run || (run.kind ?? "normal") !== "normal") continue;
    const t = runTime(run);
    const prev = latest.get(row.case_number);
    if (!prev || t > prev.t) latest.set(row.case_number, { row, t });
  }
  const out: Row[] = [];
  for (const { row } of latest.values()) {
    if (field === "closed_at" && isOpenCase(row)) {
      if (opts.includeOpenOn && inPeriod(period, opts.includeOpenOn)) out.push(row);
      continue;
    }
    const at = row[field];
    if (at && inPeriod(period, ymd(new Date(at)))) out.push(row);
  }
  return out.sort((a, b) => String(a.case_number).localeCompare(String(b.case_number)));
}

/** Distinct scoring config hashes behind a set of rows. */
export const configHashes = (rows: Row[]) =>
  [...new Set(rows.map((r) => one(r.audits)?.config_hash).filter((h): h is string => Boolean(h)))].sort();

export function hashesDiffer(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  return a.length !== b.length || a.some((h, i) => h !== b[i]);
}

// ------------------------------------------------------------------ summary
export interface Summary {
  cases: number;
  average_score: number | null; scored: number;
  slo_compliance: number | null; slo_n: number; slo_met: number; slo_breached: number; slo_insufficient: number;
  review_queue: number; review_rate: number | null;
  hot_customers: number; rule_breaches: number;
  eval_failed: number; redaction_failed: number; support_idle_cases: number;
  strike_rate: number | null; strike_n: number;
  score_distribution: { bucket: string; count: number }[];
  slo_by_severity: { severity: number; MET: number; BREACHED: number; INSUFFICIENT_DATA: number }[];
  three_strike: Record<string, number>;
  dimension_averages: { dimension: string; label: string; average: number; n: number; weight: number }[];
  review_reasons: Record<string, number>;
  low_completeness: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const count = (vals: string[]) => vals.reduce<Record<string, number>>((acc, v) => { acc[v] = (acc[v] ?? 0) + 1; return acc; }, {});
const codes = (a: Row) => new Set<string>((a.review_reasons ?? []).map((r: { code: string }) => r.code));

export function summarize(rows: Row[], bucketWidth = 1): Summary {
  const pairs = rows.map((c) => ({ c, a: one(c.audits) as Row | null }));
  const audits = pairs.map((x) => x.a).filter(Boolean) as Row[];
  const nb = Math.round(10 / bucketWidth);
  const buckets = Array.from({ length: nb }, (_, i) => ({ bucket: `${i * bucketWidth}–${(i + 1) * bucketWidth}`, count: 0 }));
  audits.forEach((a) => { if (a.overall != null) buckets[Math.min(nb - 1, Math.floor(a.overall / bucketWidth))].count += 1; });
  const slo = new Map<number, { MET: number; BREACHED: number; INSUFFICIENT_DATA: number }>();
  pairs.forEach(({ c, a }) => {
    const st = a?.slo?.status;
    if (!st || !["MET", "BREACHED", "INSUFFICIENT_DATA"].includes(st)) return;
    const k = c.severity ?? 0;
    const cur = slo.get(k) ?? { MET: 0, BREACHED: 0, INSUFFICIENT_DATA: 0 };
    cur[st as "MET"] += 1;
    slo.set(k, cur);
  });
  const dims = new Map<string, { label: string; v: number[]; weight: number }>();
  audits.forEach((a) => (a.dimensions ?? []).forEach((d: Row) => {
    const cur = dims.get(d.dimension) ?? { label: d.label as string, v: [] as number[], weight: (d.weight ?? 0) as number };
    if (d.status === "SCORED" && d.score != null) cur.v.push(d.score);
    dims.set(d.dimension, cur);
  }));
  const scored = audits.map((a) => a.overall).filter((x): x is number => x != null);
  let met = 0, breached = 0, insufficient = 0;
  slo.forEach((v) => { met += v.MET; breached += v.BREACHED; insufficient += v.INSUFFICIENT_DATA; });
  const strike = count(audits.map((a) => a.three_strike?.status ?? "NOT_APPLICABLE"));
  const strikeOk = strike.APPLIED_CORRECTLY ?? 0, strikeN = strikeOk + (strike.APPLIED_INCORRECTLY ?? 0);
  const queue = audits.filter((a) => a.needs_review).length;
  const totalWeight = [...dims.values()].reduce((s, d) => s + d.weight, 0) || 1;
  return {
    cases: rows.length,
    average_score: scored.length ? round2(scored.reduce((s, x) => s + x, 0) / scored.length) : null,
    scored: scored.length,
    slo_compliance: met + breached ? met / (met + breached) : null,
    slo_n: met + breached, slo_met: met, slo_breached: breached, slo_insufficient: insufficient,
    review_queue: queue,
    review_rate: audits.length ? queue / audits.length : null,
    hot_customers: audits.filter((a) => codes(a).has("HOT_CUSTOMER")).length,
    rule_breaches: audits.filter((a) => codes(a).has("RULE_BREACH")).length,
    eval_failed: audits.filter((a) => a.state === "EVAL_FAILED").length,
    redaction_failed: audits.filter((a) => a.state === "REDACTION_FAILED").length,
    support_idle_cases: audits.filter((a) => a.idle?.status === "SUPPORT_IDLE").length,
    strike_rate: strikeN ? strikeOk / strikeN : null, strike_n: strikeN,
    score_distribution: buckets,
    slo_by_severity: [...slo.entries()].sort((a, b) => a[0] - b[0]).map(([severity, v]) => ({ severity, ...v })),
    three_strike: strike,
    dimension_averages: [...dims.entries()].filter(([, v]) => v.v.length)
      .map(([dimension, v]) => ({ dimension, label: v.label, average: round2(v.v.reduce((s, x) => s + x, 0) / v.v.length), n: v.v.length,
                                   weight: Math.round((v.weight / totalWeight) * 100) })),
    review_reasons: count(audits.flatMap((a) => [...codes(a)])),
    low_completeness: audits.filter((a) => a.data_completeness != null && a.data_completeness < 0.8).length,
  };
}

// ------------------------------------------------------------------ deltas
export type DeltaKind = "score" | "rate" | "count";
export interface Delta { text: string; direction: "up" | "down" | "flat"; better: boolean | null }

/** Absolute change for scores and counts, percentage points for rates. Never relative %.
 *  `higherIsBetter` decides `better`; null when either side is missing. */
export function delta(cur: number | null, base: number | null, kind: DeltaKind, higherIsBetter = true): Delta | null {
  if (cur == null || base == null) return null;
  const raw = kind === "rate" ? (cur - base) * 100 : cur - base;
  const v = kind === "score" ? Math.round(raw * 10) / 10 : Math.round(raw);
  if (v === 0) return { text: kind === "rate" ? "0 pp" : kind === "score" ? "0.0" : "0", direction: "flat", better: null };
  const mag = kind === "rate" ? `${Math.abs(v)} pp` : kind === "count" ? String(Math.abs(v)) : Math.abs(v).toFixed(1);
  const up = v > 0;
  return { text: `${up ? "▲" : "▼"} ${mag}`, direction: up ? "up" : "down", better: up === higherIsBetter };
}
