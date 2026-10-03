import { DataError, type Run, type ScopeData } from "../api";
import type { Delta } from "../lib/metrics";
import { Fragment, type ReactNode } from "react";
import { C, auditStateColor, checkColor, fmtDate, fmtUtc, plural, reasonColor, scoreColor, severityColor } from "../lib/format";
import { AUDIT_STATE, CHECK_NAME, REASONS, checkKind, checkLabel, checkTooltip, lookup, type CheckName } from "../lib/labels";
import { LOW_SAMPLE_BELOW, THRESHOLD_LEGEND, isLowSample } from "../lib/thresholds";

export function Pill({ color, children, title, solid = false }: { color: string; children: ReactNode; title?: string; solid?: boolean }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap"
      style={{
        color: solid ? "#fff" : color,
        background: solid ? color : `color-mix(in oklab, ${color} 14%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 35%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

export const SeverityPill = ({ sev }: { sev: number | null }) => (
  <Pill color={severityColor(sev)} title={sev ? `Severity ${sev}` : "Severity missing in source"}>
    <span className="mono">{sev ? `SEV${sev}` : "SEV?"}</span>
  </Pill>
);

/** Deterministic check outcome in the shared vocabulary, with a tooltip that defines it. */
export const StatusPill = ({ check, value }: { check: CheckName; value: string | null | undefined }) =>
  value ? <Pill color={checkColor(value)} title={checkTooltip(check, value)}>{checkLabel(value)}</Pill>
        : <span className="text-muted" title="Not evaluated">—</span>;

export const AuditStatePill = ({ state }: { state: string | null | undefined }) => (
  <Pill color={auditStateColor(state)}>{lookup(AUDIT_STATE, state)}</Pill>
);

export const ReasonPill = ({ code }: { code: string }) => {
  const m = REASONS[code];
  return <Pill color={reasonColor(code)} title={m?.hint}>{m?.label ?? "Other reason"}</Pill>;
};

/** Low-sample marker: shows n and a muted tag; callers must also drop status colouring. */
export function SampleTag({ n, always = false }: { n: number; always?: boolean }) {
  const low = isLowSample(n);
  if (!low && !always) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted" title={low ? `Fewer than ${LOW_SAMPLE_BELOW} cases: not enough to judge, so no status colour.` : undefined}>
      <span className="mono">n={n}</span>
      {low && <span className="rounded px-1 border border-line">low sample</span>}
    </span>
  );
}

export function ScoreBadge({ score, size = "md", neutral = false }: { score: number | null | undefined; size?: "md" | "lg"; neutral?: boolean }) {
  const color = neutral ? C.text : scoreColor(score);
  if (size === "lg") {
    return (
      <div className="flex items-baseline gap-1">
        <span className="mono text-5xl font-semibold tracking-tight" style={{ color }}>{score == null ? "—" : score.toFixed(1)}</span>
        <span className="text-muted text-lg">/10</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 min-w-[92px]">
      <span className="mono text-sm font-semibold w-8 text-right" style={{ color }}>{score == null ? "—" : score.toFixed(1)}</span>
      <div className="h-1.5 w-12 rounded-full bg-elevated overflow-hidden" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${((score ?? 0) / 10) * 100}%`, background: color }} />
      </div>
    </div>
  );
}

/** Local time on screen, UTC on hover. A missing date is "—" with an explanation. */
export function Time({ iso, withTime = true, className = "" }: { iso: string | null | undefined; withTime?: boolean; className?: string }) {
  if (!iso) return <span title="No date in source" className={className}>—</span>;
  return <time dateTime={iso} title={fmtUtc(iso)} className={className}>{fmtDate(iso, withTime)}</time>;
}

export function Panel({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-4 ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          {title && <h2 className="panel-title">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="text-sm text-muted py-8 text-center" role="status">
      <p>{children}</p>
      {hint && <p className="text-xs mt-1.5">{hint}</p>}
    </div>
  );
}

/** Only DataError messages (written by us) are shown; anything else becomes a generic message,
 *  so raw database/driver errors never reach the screen. */
export function safeMessage(error: unknown): string {
  return error instanceof DataError ? error.message : "Something went wrong. Please try again.";
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="panel border-danger/40 p-3 text-sm text-danger" role="alert">{safeMessage(error)}</div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="panel p-8 text-center max-w-lg mx-auto mt-10" role="alert">
      <p className="text-sm">{safeMessage(error)}</p>
      <button className="btn-ghost mt-4" onClick={onRetry}>Retry</button>
    </div>
  );
}

// ------------------------------------------------------------------ skeletons
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`rounded-md bg-elevated animate-pulse ${className}`} aria-hidden />;
}

export function Loading({ variant = "page" }: { variant?: "page" | "table" | "detail" }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      <span className="sr-only">Loading…</span>
      {variant === "page" && (
        <>
          <Skeleton className="h-7 w-64" />
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4"><Skeleton className="h-64 lg:col-span-2" /><Skeleton className="h-64" /></div>
        </>
      )}
      {variant === "table" && (
        <div className="panel p-3 space-y-2.5">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-7" />)}</div>
      )}
      {variant === "detail" && (
        <>
          <Skeleton className="h-36" />
          <Skeleton className="h-24" />
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_460px] gap-5"><Skeleton className="h-80" /><Skeleton className="h-80" /></div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ banners & popovers
export function SyntheticBanner({ runs }: { runs: Run[] }) {
  const synthetic = runs.filter((r) => r.source === "fixtures" || r.synthetic);
  if (!synthetic.length) return null;
  const configTest = runs.some((r) => r.kind === "config_test");
  return (
    <div className="rounded-lg px-3 py-2 text-sm flex flex-wrap items-center gap-x-2" role="note" data-testid="synthetic-banner"
         style={{ color: C.warning, background: `color-mix(in oklab, ${C.warning} 12%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${C.warning} 40%, transparent)` }}>
      <span className="font-semibold">Synthetic data</span>
      <span className="text-muted">
        {configTest ? "Config test run: the September fixtures re-scored with changed rules. Not part of normal reporting."
          : synthetic.length === runs.length ? "This data was generated from test fixtures, not real support cases."
          : "Part of this data was generated from test fixtures."}
      </span>
    </div>
  );
}

function Popover({ label, children, align = "right", testId }: { label: ReactNode; children: ReactNode; align?: "left" | "right"; testId?: string }) {
  return (
    <details className="relative inline-block text-left group" data-testid={testId}>
      <summary className="list-none cursor-pointer select-none text-xs text-muted hover:text-text inline-flex items-center gap-1 [&::-webkit-details-marker]:hidden">
        {label}<span className="text-[9px] transition-transform group-open:rotate-180" aria-hidden>▼</span>
      </summary>
      <div className={`absolute z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] panel p-3 shadow-xl text-xs ${align === "right" ? "right-0" : "left-0"}`}>
        {children}
      </div>
    </details>
  );
}

export interface RunDetailsInfo {
  provider: string; model: string; config_hash: string; temperature: number | null;
  prompt_versions?: Record<string, string>; dropped_findings?: number; retries?: number;
}

/** The only place provider and model identifiers are shown. */
export function RunDetails({ info, align }: { info: RunDetailsInfo; align?: "left" | "right" }) {
  const rows: [string, ReactNode][] = [
    ["Provider", info.provider], ["Model", info.model], ["Config hash", info.config_hash || "—"],
    ["Temperature", info.temperature == null ? "Model default" : String(info.temperature)],
  ];
  if (info.dropped_findings != null) rows.push(["Dropped findings", plural(info.dropped_findings, "unsupported finding")]);
  if (info.retries != null) rows.push(["Retries", plural(info.retries, "retry")]);
  Object.entries(info.prompt_versions ?? {}).forEach(([k, v]) => rows.push([`Prompt · ${k}`, v]));
  return (
    <Popover label="Run details" align={align} testId="run-details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        {rows.map(([k, v]) => (<Fragment key={k}><dt className="text-muted">{k}</dt><dd className="mono break-all">{v}</dd></Fragment>))}
      </dl>
    </Popover>
  );
}

export function ThresholdLegend({ align }: { align?: "left" | "right" }) {
  return (
    <Popover label="Colour thresholds" align={align} testId="threshold-legend">
      <table className="w-full">
        <thead className="text-muted text-left"><tr><th className="font-medium pb-1">Metric</th>
          <th className="font-medium pb-1" style={{ color: C.success }}>Green</th>
          <th className="font-medium pb-1" style={{ color: C.warning }}>Amber</th>
          <th className="font-medium pb-1" style={{ color: C.danger }}>Red</th></tr></thead>
        <tbody>
          {THRESHOLD_LEGEND.map((r) => (
            <tr key={r.name} className="border-t border-line/60"><td className="py-1 pr-2">{r.name}</td>
              <td className="mono">{r.good}</td><td className="mono">{r.warn}</td><td className="mono">{r.bad}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted mt-2">A metric is never green while a related breach or review rate is red. Fewer than {LOW_SAMPLE_BELOW} cases: no colour, marked “low sample”.</p>
    </Popover>
  );
}

/** Compact SLO / Idle / 3-strike cell: lists only what needs attention, tooltip has all three. */
export function ChecksCell({ slo, idle, strike }: { slo: string | null; idle: string | null; strike: string | null }) {
  const all: [CheckName, string | null][] = [["slo", slo], ["idle", idle], ["three_strike", strike]];
  const title = all.map(([c, v]) => `${CHECK_NAME[c]}: ${checkLabel(v)}`).join("\n");
  const flagged = all.filter(([, v]) => { const k = checkKind(v); return k === "breached" || k === "insufficient"; });
  if (!flagged.length) {
    const any = all.some(([, v]) => v);
    return <span className="text-xs text-muted" title={title}>{any ? "All met" : "—"}</span>;
  }
  const SHORT_NAME: Record<CheckName, string> = { slo: "SLO", idle: "Idle", three_strike: "3-strike" };
  return (
    <div className="flex flex-wrap gap-1" title={title}>
      {flagged.map(([c, v]) => <Pill key={c} color={checkColor(v)}>{SHORT_NAME[c]} · {checkLabel(v)}</Pill>)}
    </div>
  );
}

// ------------------------------------------------------------------ comparison
/** A delta vs the baseline: "▲ 0.4" for scores, "▼ 6 pp" for rates. Low sample on either side
 *  shows the delta uncoloured; an empty baseline says so instead of showing 0. */
export function DeltaTag({ d, low = false, baseLabel, baseEmpty = false }: { d: Delta | null; low?: boolean; baseLabel?: string | null; baseEmpty?: boolean }) {
  if (baseLabel == null) return null;
  if (baseEmpty) return <span className="text-[11px] text-muted" data-testid="delta-nodata">No data for {baseLabel}</span>;
  if (!d) return <span className="text-[11px] text-muted" title={`No value for ${baseLabel}`}>—</span>;
  const color = low || d.better == null ? C.muted : d.better ? C.success : C.danger;
  return (
    <span className="mono text-[11px] whitespace-nowrap" style={{ color }} data-testid="delta"
          data-coloured={!low && d.better != null ? "yes" : "no"}
          title={`vs ${baseLabel}${low ? " · low sample, not coloured" : ""}`}>
      {d.text}
    </span>
  );
}

/** The comparison line under a page title, with the rule-change warning when hashes differ. */
export function ComparisonHeader({ scope, count, noun = "case" }: { scope: ScopeData; count: number; noun?: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted flex flex-wrap items-center gap-x-1.5" data-testid="comparison-line">
        <span title={scope.cur.detail} className="underline decoration-dotted decoration-line underline-offset-4">{scope.cur.label}</span>
        {scope.cmp && <>vs <span title={scope.cmp.detail} className="underline decoration-dotted decoration-line underline-offset-4">{scope.cmp.label}</span></>}
        <span>· {plural(count, noun)}</span>
      </p>
      {scope.hashWarning && (
        <div role="note" data-testid="config-warning" className="rounded-lg px-3 py-2 text-sm"
             style={{ color: C.warning, background: `color-mix(in oklab, ${C.warning} 12%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${C.warning} 40%, transparent)` }}>
          Scoring rules changed between these periods; part of the delta comes from the rule change.
        </div>
      )}
    </div>
  );
}
