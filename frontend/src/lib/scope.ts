// Comparison selection: what "Current" is and what it is compared to. Pure functions only.
//
// URL form (applies to every page and Export):
//   cur = latest | run:<id> | 2026 | 2026-Q3 | 2026-09 | 2026-W39 | 2026-09-15 | 2026-09-01..2026-09-30
//   cmp = prev | none | run:<id> | prev-period | yoy | <any period form above>
// Runs and periods never mix: a run is compared to a run, a period to a period.

export type Grain = "day" | "week" | "month" | "quarter" | "year" | "custom";
export interface Period { grain: Grain; from: string; to: string }   // inclusive UTC dates, YYYY-MM-DD

export type Current = { kind: "run"; runId: "latest" | string } | { kind: "period"; period: Period };
export type Compare =
  | { kind: "none" }
  | { kind: "prev-run" }
  | { kind: "run"; runId: string }
  | { kind: "prev-period" }
  | { kind: "yoy" }
  | { kind: "period"; period: Period };
export interface Selection { cur: Current; cmp: Compare }

export const DEFAULT_SELECTION: Selection = { cur: { kind: "run", runId: "latest" }, cmp: { kind: "prev-run" } };

// ------------------------------------------------------------------ dates (UTC, YYYY-MM-DD)
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseYmd = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => { const d = parseYmd(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const daysBetween = (a: string, b: string) => Math.round((+parseYmd(b) - +parseYmd(a)) / 86_400_000);
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1-based

/** ISO week (Monday start): [year, week]. */
export function isoWeek(s: string): [number, number] {
  const d = parseYmd(s);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);                                     // Thursday of this week
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((+d - +firstThu) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return [d.getUTCFullYear(), week];
}
function isoWeekStart(year: number, week: number): string {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  return ymd(monday);
}

// ------------------------------------------------------------------ period constructors
export const dayPeriod = (s: string): Period => ({ grain: "day", from: s, to: s });
export function weekPeriod(year: number, week: number): Period {
  const from = isoWeekStart(year, week);
  return { grain: "week", from, to: addDays(from, 6) };
}
export const monthPeriod = (y: number, m: number): Period =>
  ({ grain: "month", from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` });
export function quarterPeriod(y: number, q: number): Period {
  const m0 = (q - 1) * 3 + 1;
  return { grain: "quarter", from: `${y}-${pad(m0)}-01`, to: `${y}-${pad(m0 + 2)}-${pad(lastDayOfMonth(y, m0 + 2))}` };
}
export const yearPeriod = (y: number): Period => ({ grain: "year", from: `${y}-01-01`, to: `${y}-12-31` });
export const customPeriod = (from: string, to: string): Period => (from <= to ? { grain: "custom", from, to } : { grain: "custom", from: to, to: from });

/** The period of the given grain containing date s. */
export function periodContaining(grain: Exclude<Grain, "custom">, s: string): Period {
  const d = parseYmd(s);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  switch (grain) {
    case "day": return dayPeriod(s);
    case "week": { const [wy, w] = isoWeek(s); return weekPeriod(wy, w); }
    case "month": return monthPeriod(y, m);
    case "quarter": return quarterPeriod(y, Math.ceil(m / 3));
    case "year": return yearPeriod(y);
  }
}

// ------------------------------------------------------------------ period arithmetic
/** The preceding period: calendar-previous for calendar grains, equal length immediately before for custom. */
export function previousPeriod(p: Period): Period {
  if (p.grain === "custom") {
    const len = daysBetween(p.from, p.to);
    const to = addDays(p.from, -1);
    return { grain: "custom", from: addDays(to, -len), to };
  }
  return periodContaining(p.grain, addDays(p.from, -1));
}

/** Same period one year earlier. */
export function samePeriodLastYear(p: Period): Period {
  if (p.grain === "week") { const [y, w] = isoWeek(p.from); return weekPeriod(y - 1, Math.min(w, 52)); }
  const shift = (s: string) => {
    const d = parseYmd(s);
    const y = d.getUTCFullYear() - 1, m = d.getUTCMonth() + 1;
    return `${y}-${pad(m)}-${pad(Math.min(d.getUTCDate(), lastDayOfMonth(y, m)))}`;
  };
  if (p.grain === "month") { const d = parseYmd(p.from); return monthPeriod(d.getUTCFullYear() - 1, d.getUTCMonth() + 1); }
  return { grain: p.grain, from: shift(p.from), to: shift(p.to) };
}

export const inPeriod = (p: Period, s: string) => s >= p.from && s <= p.to;

// ------------------------------------------------------------------ URL serialisation
export function formatPeriodKey(p: Period): string {
  const d = parseYmd(p.from);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  switch (p.grain) {
    case "day": return p.from;
    case "week": { const [wy, w] = isoWeek(p.from); return `${wy}-W${pad(w)}`; }
    case "month": return `${y}-${pad(m)}`;
    case "quarter": return `${y}-Q${Math.ceil(m / 3)}`;
    case "year": return `${y}`;
    case "custom": return `${p.from}..${p.to}`;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s: string) { return DATE.test(s) && ymd(parseYmd(s)) === s; }

export function parsePeriodKey(s: string): Period | null {
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})$/))) return yearPeriod(+m[1]);
  if ((m = s.match(/^(\d{4})-Q([1-4])$/))) return quarterPeriod(+m[1], +m[2]);
  if ((m = s.match(/^(\d{4})-W(\d{2})$/)) && +m[2] >= 1 && +m[2] <= 53) return weekPeriod(+m[1], +m[2]);
  if ((m = s.match(/^(\d{4})-(\d{2})$/)) && +m[2] >= 1 && +m[2] <= 12) return monthPeriod(+m[1], +m[2]);
  if (validDate(s)) return dayPeriod(s);
  if ((m = s.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/)) && validDate(m[1]) && validDate(m[2])) return customPeriod(m[1], m[2]);
  return null;
}

const RUN_ID = /^[0-9a-f-]{8,64}$/i;

export function serializeSelection(sel: Selection): { cur: string; cmp: string } {
  const cur = sel.cur.kind === "run" ? (sel.cur.runId === "latest" ? "latest" : `run:${sel.cur.runId}`) : formatPeriodKey(sel.cur.period);
  const c = sel.cmp;
  const cmp = c.kind === "none" ? "none" : c.kind === "prev-run" ? "prev" : c.kind === "run" ? `run:${c.runId}`
    : c.kind === "prev-period" ? "prev-period" : c.kind === "yoy" ? "yoy" : formatPeriodKey(c.period);
  return { cur, cmp };
}

/** Parse ?cur=&cmp=. Unknown or invalid values fall back to defaults; an invalid run/period mix
 *  falls back to the default comparison for the current kind. */
export function parseSelection(params: URLSearchParams): Selection {
  const curRaw = params.get("cur") ?? "latest";
  let cur: Current = DEFAULT_SELECTION.cur;
  if (curRaw.startsWith("run:") && RUN_ID.test(curRaw.slice(4))) cur = { kind: "run", runId: curRaw.slice(4) };
  else if (curRaw !== "latest") { const p = parsePeriodKey(curRaw); if (p) cur = { kind: "period", period: p }; }

  const cmpRaw = params.get("cmp");
  let cmp: Compare | null = null;
  if (cmpRaw === "none") cmp = { kind: "none" };
  else if (cmpRaw === "prev") cmp = { kind: "prev-run" };
  else if (cmpRaw === "prev-period") cmp = { kind: "prev-period" };
  else if (cmpRaw === "yoy") cmp = { kind: "yoy" };
  else if (cmpRaw?.startsWith("run:") && RUN_ID.test(cmpRaw.slice(4))) cmp = { kind: "run", runId: cmpRaw.slice(4) };
  else if (cmpRaw) { const p = parsePeriodKey(cmpRaw); if (p) cmp = { kind: "period", period: p }; }
  if (!cmp || !compareAllowed(cur, cmp)) cmp = defaultCompare(cur);
  return { cur, cmp };
}

export const defaultCompare = (cur: Current): Compare => (cur.kind === "run" ? { kind: "prev-run" } : { kind: "prev-period" });

/** Runs compare to runs, periods to periods; "none" is always allowed. */
export function compareAllowed(cur: Current, cmp: Compare): boolean {
  if (cmp.kind === "none") return true;
  const runSide = cmp.kind === "prev-run" || cmp.kind === "run";
  return cur.kind === "run" ? runSide : !runSide;
}

/** Write the selection into existing search params (other params untouched). Defaults are omitted. */
export function withSelection(params: URLSearchParams, sel: Selection): URLSearchParams {
  const next = new URLSearchParams(params);
  const { cur, cmp } = serializeSelection(sel);
  const dflt = serializeSelection({ cur: sel.cur, cmp: defaultCompare(sel.cur) });
  if (cur === "latest") next.delete("cur"); else next.set("cur", cur);
  if (cmp === dflt.cmp) next.delete("cmp"); else next.set("cmp", cmp);
  return next;
}

// ------------------------------------------------------------------ labels
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (s: string) => { const d = parseYmd(s); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };

export function periodLabel(p: Period): string {
  const d = parseYmd(p.from);
  const y = d.getUTCFullYear();
  switch (p.grain) {
    case "day": return `${short(p.from)}, ${y}`;
    case "week": { const [wy, w] = isoWeek(p.from); return `Week ${w}, ${wy}`; }
    case "month": return `${MONTHS[d.getUTCMonth()]} ${y}`;
    case "quarter": return `Q${Math.ceil((d.getUTCMonth() + 1) / 3)} ${y}`;
    case "year": return `${y}`;
    case "custom": {
      const y2 = parseYmd(p.to).getUTCFullYear();
      return y === y2 ? `${short(p.from)} – ${short(p.to)}, ${y}` : `${short(p.from)}, ${y} – ${short(p.to)}, ${y2}`;
    }
  }
}

export const membershipTooltip = (p: Period, field: "closed_at" | "opened_at") =>
  `Cases ${field === "closed_at" ? "closed" : "opened"} between ${short(p.from)}, ${parseYmd(p.from).getUTCFullYear()} and ${short(p.to)}, ${parseYmd(p.to).getUTCFullYear()}`;

// ------------------------------------------------------------------ presets (relative to the data date)
export interface Preset { id: string; label: string; sel: Selection }
export function presets(dataDate: string): Preset[] {
  const month = periodContaining("month", dataDate), quarter = periodContaining("quarter", dataDate), year = periodContaining("year", dataDate);
  const last7 = customPeriod(addDays(dataDate, -6), dataDate);
  return [
    { id: "prev-run", label: "Latest run vs previous run", sel: DEFAULT_SELECTION },
    { id: "7d", label: "Last 7 days vs prior 7", sel: { cur: { kind: "period", period: last7 }, cmp: { kind: "prev-period" } } },
    { id: "month", label: "This month vs last month", sel: { cur: { kind: "period", period: month }, cmp: { kind: "prev-period" } } },
    { id: "quarter", label: "This quarter vs last quarter", sel: { cur: { kind: "period", period: quarter }, cmp: { kind: "prev-period" } } },
    { id: "year", label: "This year vs last year", sel: { cur: { kind: "period", period: year }, cmp: { kind: "prev-period" } } },
  ];
}

/** The last n periods of a grain ending with the one containing dataDate (oldest first). */
export function lastPeriods(grain: "day" | "week" | "month", dataDate: string, n = 12): Period[] {
  const out: Period[] = [periodContaining(grain, dataDate)];
  while (out.length < n) out.unshift(previousPeriod(out[0]));
  return out;
}
