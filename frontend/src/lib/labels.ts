// The ONE place raw codes become human words. No component renders a raw enum.

export type CheckKind = "met" | "breached" | "insufficient" | "na";
export type CheckName = "slo" | "idle" | "three_strike";

/** Status vocabulary for deterministic checks. */
export const CHECK_VOCAB: Record<CheckKind, string> = {
  met: "Met", breached: "Breached", insufficient: "Insufficient data", na: "Not applicable",
};

const CHECK_KIND: Record<string, CheckKind> = {
  MET: "met", BREACHED: "breached",
  NO_SUPPORT_IDLE: "met", SUPPORT_IDLE: "breached",
  APPLIED_CORRECTLY: "met", APPLIED_INCORRECTLY: "breached",
  INSUFFICIENT_DATA: "insufficient", NOT_APPLICABLE: "na",
};

export const CHECK_NAME: Record<CheckName, string> = { slo: "SLO initial response", idle: "Idle", three_strike: "3-strike rule" };

const CHECK_TOOLTIP: Record<CheckName, Record<CheckKind, string>> = {
  slo: {
    met: "Met: support's first customer-facing response came within the SLO target.",
    breached: "Breached: the first response came after the SLO target, or there was none.",
    insufficient: "Insufficient data: the source lacks what is needed (severity, open time or response times).",
    na: "Not applicable to this case.",
  },
  idle: {
    met: "Met: no support-side gap longer than the idle threshold.",
    breached: "Breached: at least one support-side gap was longer than the idle threshold.",
    insufficient: "Insufficient data: some customer-facing messages have no timestamp, so gaps can't be ruled out.",
    na: "Not applicable to this case.",
  },
  three_strike: {
    met: "Met: closed for non-response after the required contact attempts.",
    breached: "Breached: closed for non-response with too few contact attempts.",
    insufficient: "Insufficient data: the closure reason or attempt times can't be determined.",
    na: "Not applicable: the case wasn't closed for customer non-response.",
  },
};

export function checkKind(raw: string | null | undefined): CheckKind | null {
  return raw ? CHECK_KIND[raw] ?? null : null;
}
export function checkLabel(raw: string | null | undefined): string {
  const k = checkKind(raw);
  return k ? CHECK_VOCAB[k] : "—";
}
export function checkTooltip(check: CheckName, raw: string | null | undefined): string {
  const k = checkKind(raw);
  return k ? CHECK_TOOLTIP[check][k] : "Not evaluated.";
}

export const AUDIT_STATE: Record<string, string> = {
  OK: "Scored", EVAL_FAILED: "Evaluation failed", REDACTION_FAILED: "Blocked by redaction check",
};
export const LLM_STATUS: Record<string, string> = {
  OK: "Scored", INSUFFICIENT_EVIDENCE: "Not enough evidence", FAILED: "Evaluation failed", NOT_RUN: "Not evaluated",
};
export const CLOSURE_REASON: Record<string, string> = {
  CUSTOMER_CONFIRMED: "Customer confirmed", CUSTOMER_NON_RESPONSE: "Customer didn't respond", OTHER: "Other reason",
};
export const TRAJECTORY: Record<string, string> = { improving: "Improving", stable: "Stable", worsening: "Worsening" };
export const ITEM_TYPE: Record<string, string> = {
  email: "Email", call: "Call", summary: "Case summary", handover: "Handover note", note: "Internal note",
};
export const DIRECTION: Record<string, string> = { inbound: "from customer", outbound: "from support" };
export const FIELD: Record<string, string> = {
  opened_at: "open time", closed_at: "close time", severity: "severity", owner: "case owner",
  item_timestamps: "message timestamps", call_direction: "call direction",
};
export const REVIEW_ACTION: Record<string, string> = { approve: "Approved", override: "Overridden", comment: "Commented" };
export const RUN_SOURCE: Record<string, string> = { fixtures: "Synthetic fixtures", upload: "Uploaded export" };
export const FINDING_KIND: Record<string, string> = {
  top_issues: "Top issues", missed_steps: "Missed steps", repeated_requests: "Repeated requests",
  shift_points: "Temperature shifts", handover_issues: "Handover issues",
};
export const DIMENSION: Record<string, string> = {
  troubleshooting: "Troubleshooting", communication: "Communication", slo: "SLO initial response",
  idle: "Idle", three_strike: "3-strike rule", temperature_handling: "Temperature handling",
  temperature: "Customer temperature",
};

/** Evidence reference ids: E#/C#/A# stay as-is; the two named refs get words. */
export function refLabel(ref: string): string {
  return ref === "DESC" ? "Case description" : ref === "RES" ? "Resolution" : ref;
}

export const REASONS: Record<string, { label: string; hint: string; tone: "danger" | "high" | "warning" }> = {
  REDACTION_FAILED: { label: "Redaction blocked", tone: "danger", hint: "The leak check blocked this case; nothing was evaluated." },
  EVAL_FAILED: { label: "Evaluation failed", tone: "danger", hint: "The evaluator's output stayed invalid after one retry." },
  RULE_BREACH: { label: "Rule breach", tone: "high", hint: "SLO initial response breached, or 3-strike rule applied incorrectly." },
  HOT_CUSTOMER: { label: "Hot customer", tone: "high", hint: "Customer peaked Angry, or ended hotter than they started." },
  LOW_SCORE: { label: "Low score", tone: "warning", hint: "Overall score below 4.0." },
  INSUFFICIENT_DATA: { label: "Insufficient data", tone: "warning", hint: "A check was excluded for missing source data, or data completeness is below 80%." },
  EVALUATOR_DISAGREEMENT: { label: "Evaluator disagreement", tone: "warning", hint: "Evaluation runs disagree: score range ≥ 2, or fewer than 75% give the same score." },
};

/** Fallback for an unexpected code: generic words, never the raw code. */
export function lookup(map: Record<string, string>, raw: string | null | undefined, fallback = "—"): string {
  if (!raw) return fallback;
  return map[raw] ?? "Other";
}

/** A dimension's input: "4/5" stays numeric; check outcomes use the status vocabulary; trajectories get words. */
export function dimensionInputLabel(input: string): string {
  if (/^\d\/5$/.test(input)) return input;
  if (checkKind(input)) return checkLabel(input);
  return TRAJECTORY[input] ?? LLM_STATUS[input] ?? "Other";
}
export const CLOCK: Record<string, string> = { "24x7": "24×7", business_hours: "Business hours" };
