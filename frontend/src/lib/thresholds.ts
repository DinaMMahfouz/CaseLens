// Status colours from the single threshold config (src/config/display.json).
import cfg from "../config/display.json";

export type Band = "good" | "warn" | "bad" | "none";
export type HigherIsBetter = "score" | "slo_compliance" | "three_strike_compliance" | "data_completeness";

export const BAND_COLOR: Record<Band, string> = {
  good: "var(--color-success)", warn: "var(--color-warning)", bad: "var(--color-danger)", none: "var(--color-muted)",
};

export function band(metric: HigherIsBetter, value: number | null | undefined): Band {
  if (value == null || Number.isNaN(value)) return "none";
  const t = cfg[metric];
  return value >= t.good_at_least ? "good" : value >= t.warn_at_least ? "warn" : "bad";
}

/** Review rate: lower is better. */
export function reviewRateBand(rate: number | null | undefined): Band {
  if (rate == null || Number.isNaN(rate)) return "none";
  const t = cfg.review_rate;
  return rate <= t.good_at_most ? "good" : rate <= t.warn_at_most ? "warn" : "bad";
}

/** A KPI may never show green while a related breach or review rate is red. */
export function capByRelated(own: Band, related: Band[]): Band {
  return own === "good" && related.includes("bad") ? "warn" : own;
}

export const bandColor = (b: Band) => BAND_COLOR[b];
export const LOW_SAMPLE_BELOW: number = cfg.low_sample_below;
export const isLowSample = (n: number | null | undefined) => n != null && n < LOW_SAMPLE_BELOW;

const pct = (x: number) => `${Math.round(x * 100)}%`;
export const THRESHOLD_LEGEND: { name: string; good: string; warn: string; bad: string }[] = [
  { name: "Score /10", good: `≥ ${cfg.score.good_at_least}`, warn: `${cfg.score.warn_at_least}–${(cfg.score.good_at_least - 0.1).toFixed(1)}`, bad: `< ${cfg.score.warn_at_least}` },
  { name: "SLO compliance", good: `≥ ${pct(cfg.slo_compliance.good_at_least)}`, warn: `${pct(cfg.slo_compliance.warn_at_least)}–${pct(cfg.slo_compliance.good_at_least - 0.01)}`, bad: `< ${pct(cfg.slo_compliance.warn_at_least)}` },
  { name: "3-strike compliance", good: `≥ ${pct(cfg.three_strike_compliance.good_at_least)}`, warn: `${pct(cfg.three_strike_compliance.warn_at_least)}–${pct(cfg.three_strike_compliance.good_at_least - 0.01)}`, bad: `< ${pct(cfg.three_strike_compliance.warn_at_least)}` },
  { name: "Review rate", good: `≤ ${pct(cfg.review_rate.good_at_most)}`, warn: `${pct(cfg.review_rate.good_at_most + 0.01)}–${pct(cfg.review_rate.warn_at_most)}`, bad: `> ${pct(cfg.review_rate.warn_at_most)}` },
  { name: "Data completeness", good: `≥ ${pct(cfg.data_completeness.good_at_least)}`, warn: `${pct(cfg.data_completeness.warn_at_least)}–${pct(cfg.data_completeness.good_at_least - 0.01)}`, bad: `< ${pct(cfg.data_completeness.warn_at_least)}` },
];
