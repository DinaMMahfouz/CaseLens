// Formatting + semantic color helpers. Colors are CSS variables from index.css.

export const C = {
  bg: "var(--color-bg)",
  surface: "var(--color-surface)",
  elevated: "var(--color-elevated)",
  line: "var(--color-line)",
  text: "var(--color-text)",
  muted: "var(--color-muted)",
  accent: "var(--color-accent)",
  warning: "var(--color-warning)",
  success: "var(--color-success)",
  high: "var(--color-high)",
  info: "var(--color-info)",
  danger: "var(--color-danger)",
};

export const severityColor = (sev: number | null | undefined) =>
  sev === 1 ? C.danger : sev === 2 ? C.high : sev === 3 ? C.warning : sev === 4 ? C.info : C.muted;

export const scoreColor = (s: number | null | undefined) =>
  s == null ? C.muted : s >= 7 ? C.success : s >= 4 ? C.warning : C.danger;

export const outcomeColor = (o: string | null | undefined) => {
  switch (o) {
    case "MET": case "APPLIED_CORRECTLY": case "NO_SUPPORT_IDLE": case "HIGH": case "OK": case "approve":
      return C.success;
    case "BREACHED": case "APPLIED_INCORRECTLY": case "SUPPORT_IDLE": case "LOW":
    case "EVAL_FAILED": case "REDACTION_FAILED":
      return C.danger;
    case "MEDIUM": case "INSUFFICIENT_DATA": case "INSUFFICIENT_EVIDENCE": case "override":
      return C.warning;
    default:
      return C.muted;
  }
};

export const REASON_META: Record<string, { label: string; color: string; hint: string }> = {
  REDACTION_FAILED: { label: "Redaction failed", color: C.danger, hint: "Leak scanner blocked the case; nothing was evaluated." },
  EVAL_FAILED: { label: "Eval failed", color: C.danger, hint: "LLM output stayed invalid after one retry." },
  RULE_BREACH: { label: "Rule breach", color: C.high, hint: "SLO breached or 3-strike applied incorrectly." },
  HOT_CUSTOMER: { label: "Hot customer", color: C.high, hint: "Customer peaked Angry, or ended hotter than they started." },
  LOW_SCORE: { label: "Low score", color: C.warning, hint: "Overall score below threshold." },
  INSUFFICIENT_DATA: { label: "Insufficient data", color: C.warning, hint: "A check was excluded for missing source data, or data completeness is below 80%." },
  EVALUATOR_DISAGREEMENT: { label: "Evaluator disagreement", color: C.warning, hint: "Evaluation runs disagree (score range ≥ 2 or < 75% agree)." },
};

export const humanize = (s: string | null | undefined) =>
  (s ?? "—").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function fmtDate(iso: string | null | undefined, withTime = true) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" } : { timeZone: "UTC" }),
  });
}

export function fmtDuration(minutes: number | null | undefined) {
  if (minutes == null) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = minutes / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export const fmtScore = (s: number | null | undefined) => (s == null ? "—" : s.toFixed(1));

// ------------------------------------------------------------------ Phase 1 helpers

/** "1 call", "2 calls", "1 retry", "3 retries". */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : pluralForm ?? (singular.endsWith("y") && !/[aeiou]y$/.test(singular) ? singular.slice(0, -1) + "ies" : singular + "s")}`;
}

/** Customer temperature context labels — mirrors config/scoring.yaml customer_temperature.labels. */
const TEMP_LABELS: Record<number, string> = { 1: "Calm", 2: "Neutral", 3: "Frustrated", 4: "Angry", 5: "Angry" };
export function temperatureLabel(value: number | null | undefined): string {
  if (value == null) return "—";
  return TEMP_LABELS[Math.min(5, Math.max(1, Math.round(value)))];
}

/** LLM card run summary: the per-run scores and completed/requested runs, never conflated with the score. */
export function runsSummary(d: { run_scores?: (number | null)[]; requested_runs?: number; completed_runs?: number }) {
  const scores = (d.run_scores ?? []).map((s) => (s == null ? "–" : String(s))).join(" · ");
  const req = d.requested_runs ?? d.run_scores?.length ?? 0;
  const done = d.completed_runs ?? req;
  return { scores, completed: `${done} of ${plural(req, "run")} completed` };
}

export const NO_DATE_TITLE = "No date in source";

/** Whole days between two instants (age of an open case). */
export function ageDays(fromIso: string | null | undefined, now: Date = new Date()): number | null {
  if (!fromIso) return null;
  return Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 86_400_000));
}
