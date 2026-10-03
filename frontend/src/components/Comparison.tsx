import { useEffect, useRef, useState } from "react";
import { runName, type Run } from "../api";
import { latestRun, normalRuns } from "../lib/metrics";
import {
  compareAllowed, customPeriod, dayPeriod, defaultCompare, isoWeek, monthPeriod, parsePeriodKey, periodLabel,
  presets, previousPeriod, quarterPeriod, samePeriodLastYear, weekPeriod, yearPeriod,
  type Compare, type Current, type Grain, type Period, type Selection,
} from "../lib/scope";
import { fmtDate } from "../lib/format";

// ------------------------------------------------------------------ labels
export function sideLabels(sel: Selection, runs: Run[]): { cur: string; cmp: string | null } {
  const c = sel.cur;
  const cur = c.kind === "run" ? (c.runId === "latest" ? "Latest run" : (() => { const r = runs.find((x) => x.id === c.runId); return r ? runName(r) : "Unknown run"; })())
    : periodLabel(c.period);
  const m = sel.cmp;
  let cmp: string | null = null;
  if (m.kind === "prev-run") cmp = "previous run";
  else if (m.kind === "run") { const r = runs.find((x) => x.id === m.runId); cmp = r ? runName(r) : "Unknown run"; }
  else if (c.kind === "period" && m.kind === "prev-period") cmp = periodLabel(previousPeriod(c.period));
  else if (c.kind === "period" && m.kind === "yoy") cmp = periodLabel(samePeriodLastYear(c.period));
  else if (m.kind === "period") cmp = periodLabel(m.period);
  return { cur, cmp };
}
export const selectionLabel = (sel: Selection, runs: Run[]) => {
  const l = sideLabels(sel, runs);
  return l.cmp ? `${l.cur} vs ${l.cmp}` : l.cur;
};

// ------------------------------------------------------------------ period picker
type PKind = Exclude<Grain, never>;
const GRAINS: [PKind, string][] = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"], ["custom", "Custom range"]];

function PeriodInput({ value, onChange, grain, idPrefix }: { value: Period; onChange: (p: Period) => void; grain: PKind; idPrefix: string }) {
  const y = Number(value.from.slice(0, 4));
  const q = Math.ceil(Number(value.from.slice(5, 7)) / 3);
  const set = (p: Period | null) => { if (p) onChange(p); };
  switch (grain) {
    case "day": return <input type="date" aria-label="Day" value={value.from} onChange={(e) => set(e.target.value ? dayPeriod(e.target.value) : null)} />;
    case "week": {
      const [wy, w] = isoWeek(value.from);
      return <input type="week" aria-label="Week" value={`${wy}-W${String(w).padStart(2, "0")}`}
                    onChange={(e) => { const m = e.target.value.match(/^(\d{4})-W(\d{2})$/); set(m ? weekPeriod(+m[1], +m[2]) : null); }} />;
    }
    case "month": return <input type="month" aria-label="Month" value={value.from.slice(0, 7)} onChange={(e) => set(parsePeriodKey(e.target.value))} />;
    case "quarter": return (
      <span className="flex gap-2">
        <select aria-label="Quarter" value={q} onChange={(e) => set(quarterPeriod(y, +e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>Q{n}</option>)}</select>
        <input type="number" aria-label="Year" className="w-24 mono" value={y} min={2000} max={2100} onChange={(e) => set(+e.target.value >= 2000 ? quarterPeriod(+e.target.value, q) : null)} />
      </span>
    );
    case "year": return <input type="number" aria-label="Year" className="w-24 mono" value={y} min={2000} max={2100} onChange={(e) => set(+e.target.value >= 2000 ? yearPeriod(+e.target.value) : null)} />;
    case "custom": return (
      <span className="flex flex-wrap items-center gap-2">
        <input id={`${idPrefix}-from`} type="date" aria-label="From" value={value.from} onChange={(e) => set(e.target.value ? customPeriod(e.target.value, value.to) : null)} />
        <span className="text-muted">to</span>
        <input type="date" aria-label="To" value={value.to} onChange={(e) => set(e.target.value ? customPeriod(value.from, e.target.value) : null)} />
      </span>
    );
  }
}

function convert(p: Period, grain: PKind): Period {
  switch (grain) {
    case "day": return dayPeriod(p.to);
    case "week": { const [y, w] = isoWeek(p.to); return weekPeriod(y, w); }
    case "month": return monthPeriod(+p.to.slice(0, 4), +p.to.slice(5, 7));
    case "quarter": return quarterPeriod(+p.to.slice(0, 4), Math.ceil(+p.to.slice(5, 7) / 3));
    case "year": return yearPeriod(+p.to.slice(0, 4));
    case "custom": return customPeriod(p.from, p.to);
  }
}

// ------------------------------------------------------------------ control
export function ComparisonControl({ sel, setSel, runs, dataDate }: { sel: Selection; setSel: (s: Selection) => void; runs: Run[]; dataDate: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Selection>(sel);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setDraft(sel); }, [open, sel]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  const latest = latestRun(runs);
  const fallbackPeriod = monthPeriod(+dataDate.slice(0, 4), +dataDate.slice(5, 7));
  const curKind = draft.cur.kind === "run" ? (draft.cur.runId === "latest" ? "latest" : "run") : draft.cur.period.grain;
  const curPeriod = draft.cur.kind === "period" ? draft.cur.period : fallbackPeriod;
  const setCur = (cur: Current) => setDraft((d) => ({ cur, cmp: compareAllowed(cur, d.cmp) ? d.cmp : defaultCompare(cur) }));
  const setCmp = (cmp: Compare) => setDraft((d) => ({ ...d, cmp }));
  const cmpKind = draft.cmp.kind === "period" ? `period:${draft.cmp.period.grain}` : draft.cmp.kind;
  const cmpPeriod = draft.cmp.kind === "period" ? draft.cmp.period : previousPeriod(curPeriod);
  const sortedRuns = [...normalRuns(runs), ...runs.filter((r) => r.kind === "config_test")];
  const otherRuns = sortedRuns.filter((r) => draft.cur.kind !== "run" || r.id !== (draft.cur.runId === "latest" ? latest?.id : draft.cur.runId));
  const apply = (s: Selection) => { setSel(s); setOpen(false); };

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" data-testid="comparison-chip"
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1 text-xs hover:border-muted max-w-[22rem]">
        <span className="truncate">{selectionLabel(sel, runs)}</span><span className="text-[9px] text-muted" aria-hidden>▼</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Choose comparison" className="absolute right-0 z-50 mt-2 w-[26rem] max-w-[calc(100vw-2rem)] panel p-4 shadow-2xl text-sm space-y-4">
          <div>
            <div className="panel-title mb-2">Presets</div>
            <div className="flex flex-wrap gap-1.5">
              {presets(dataDate).map((p) => (
                <button key={p.id} type="button" className="rounded-full border border-line px-2.5 py-1 text-xs hover:border-muted" onClick={() => apply(p.sel)}>{p.label}</button>
              ))}
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="panel-title mb-2">Current</legend>
            <select aria-label="Current" value={curKind} className="w-full" onChange={(e) => {
              const v = e.target.value;
              if (v === "latest") setCur({ kind: "run", runId: "latest" });
              else if (v === "run") setCur({ kind: "run", runId: sortedRuns[0]?.id ?? "latest" });
              else setCur({ kind: "period", period: convert(curPeriod, v as PKind) });
            }}>
              <option value="latest">Latest run</option>
              <option value="run">Specific run</option>
              {GRAINS.map(([g, l]) => <option key={g} value={g}>{l}</option>)}
            </select>
            {curKind === "run" && draft.cur.kind === "run" && (
              <select aria-label="Run" className="w-full" value={draft.cur.runId} onChange={(e) => setCur({ kind: "run", runId: e.target.value })}>
                {sortedRuns.map((r) => <option key={r.id} value={r.id}>{runName(r)}{r.kind === "config_test" ? "" : ` · ${r.total} cases`}</option>)}
              </select>
            )}
            {draft.cur.kind === "period" && <PeriodInput value={curPeriod} grain={curPeriod.grain} idPrefix="cur" onChange={(p) => setCur({ kind: "period", period: p })} />}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="panel-title mb-2">Compare to</legend>
            <select aria-label="Compare to" value={cmpKind} className="w-full" onChange={(e) => {
              const v = e.target.value;
              if (v === "none") setCmp({ kind: "none" });
              else if (v === "prev-run") setCmp({ kind: "prev-run" });
              else if (v === "run") setCmp({ kind: "run", runId: otherRuns[0]?.id ?? "" });
              else if (v === "prev-period") setCmp({ kind: "prev-period" });
              else if (v === "yoy") setCmp({ kind: "yoy" });
              else setCmp({ kind: "period", period: convert(cmpPeriod, v.slice(7) as PKind) });
            }}>
              {/* Runs compare to runs and periods to periods; the other kind is disabled. */}
              <option value="prev-run" disabled={draft.cur.kind !== "run"}>Previous run</option>
              <option value="run" disabled={draft.cur.kind !== "run" || !otherRuns.length}>Specific run</option>
              <option value="prev-period" disabled={draft.cur.kind !== "period"}>Previous period</option>
              <option value="yoy" disabled={draft.cur.kind !== "period"}>Same period last year</option>
              {GRAINS.map(([g, l]) => <option key={g} value={`period:${g}`} disabled={draft.cur.kind !== "period"}>Specific {l.toLowerCase()}</option>)}
              <option value="none">None</option>
            </select>
            {draft.cmp.kind === "run" && (
              <select aria-label="Compare run" className="w-full" value={draft.cmp.runId} onChange={(e) => setCmp({ kind: "run", runId: e.target.value })}>
                {otherRuns.map((r) => <option key={r.id} value={r.id}>{runName(r)}</option>)}
              </select>
            )}
            {draft.cmp.kind === "period" && <PeriodInput value={cmpPeriod} grain={cmpPeriod.grain} idPrefix="cmp" onChange={(p) => setCmp({ kind: "period", period: p })} />}
          </fieldset>

          <div className="flex items-center justify-between gap-3 pt-1 border-t border-line">
            <span className="text-xs text-muted pt-3">Data as of {fmtDate(`${dataDate}T12:00:00Z`, false)}</span>
            <div className="flex gap-2 pt-3">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn-primary" onClick={() => apply(draft)} data-testid="comparison-apply">Apply</button>
            </div>
          </div>
          <p className="sr-only" aria-live="polite">{selectionLabel(draft, runs)}</p>
        </div>
      )}
    </div>
  );
}
