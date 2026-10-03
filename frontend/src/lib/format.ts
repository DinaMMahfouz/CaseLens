// Formatting + semantic color helpers. Colors are CSS variables from index.css.
import { REASONS, checkKind } from "./labels";
import { band, bandColor } from "./thresholds";

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

export const scoreColor = (s: number | null | undefined) => bandColor(band("score", s));

/** Colour for a deterministic-check outcome (Met / Breached / Insufficient data / Not applicable). */
export const checkColor = (raw: string | null | undefined) => {
  const k = checkKind(raw);
  return k === "met" ? C.success : k === "breached" ? C.danger : k === "insufficient" ? C.warning : C.muted;
};
export const reviewActionColor = (a: string | null | undefined) =>
  a === "approve" ? C.success : a === "override" ? C.warning : C.muted;
export const auditStateColor = (s: string | null | undefined) => (s === "OK" ? C.success : C.danger);

export const reasonColor = (code: string) => {
  const tone = REASONS[code]?.tone;
  return tone === "danger" ? C.danger : tone === "high" ? C.high : tone === "warning" ? C.warning : C.muted;
};

/** Display times are in the viewer's local timezone; <Time> shows the UTC instant on hover. */
export function fmtDate(iso: string | null | undefined, withTime = true) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short" } : {}),
  });
}
export function fmtUtc(iso: string) {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
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
