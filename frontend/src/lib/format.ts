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
  HOT_CUSTOMER: { label: "Hot customer", color: C.high, hint: "Temperature ≥ 4 or worsening trajectory." },
  LOW_SCORE: { label: "Low score", color: C.warning, hint: "Overall score below threshold." },
  LOW_CONFIDENCE: { label: "Low confidence", color: C.warning, hint: "Computed confidence is LOW." },
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
