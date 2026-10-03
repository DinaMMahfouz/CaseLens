import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api } from "../api";
import {
  ComparisonHeader, DeltaTag, Empty, ErrorState, Loading, Panel, ReasonPill, RunDetails, SampleTag, ScoreBadge, SeverityPill, ThresholdLegend,
} from "../components/ui";
import { useAsync, useRun, useScopedHref } from "../lib/hooks";
import { C, fmtDuration, plural } from "../lib/format";
import { CHECK_VOCAB, REASONS } from "../lib/labels";
import { dataDate, delta, type Summary } from "../lib/metrics";
import { lastPeriods } from "../lib/scope";
import { band, bandColor, capByRelated, isLowSample, reviewRateBand, type Band } from "../lib/thresholds";

const axis = { stroke: C.muted, fontSize: 11, tickLine: false, axisLine: { stroke: C.line } };
const tooltipStyle = {
  contentStyle: { background: C.elevated, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12, color: C.text },
  labelStyle: { color: C.muted },
  cursor: { fill: "color-mix(in oklab, var(--color-text) 6%, transparent)" },
};
const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);

type TrendPoint = { label: string; value: number | null; n: number };
type KpiKey = "cases" | "score" | "slo" | "review" | "idle" | "blocked";

/** Small KPI trend line. Low-sample points are drawn hollow; empty periods leave a gap. */
function Sparkline({ points, color }: { points: TrendPoint[]; color: string }) {
  return (
    <div className="h-10 mt-2" data-testid="sparkline">
      <ResponsiveContainer>
        <LineChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <Tooltip {...tooltipStyle} formatter={(v: number, _n, p) => [`${v} (n=${(p.payload as TrendPoint).n})`, ""]} labelFormatter={(_, p) => p?.[0]?.payload?.label ?? ""} />
          <Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} connectNulls={false} isAnimationActive={false}
                dot={(props: { cx?: number; cy?: number; payload?: TrendPoint; index?: number }) => {
                  if (props.cx == null || props.cy == null || props.payload?.value == null) return <g key={props.index} />;
                  const low = isLowSample(props.payload.n);
                  return <circle key={props.index} cx={props.cx} cy={props.cy} r={2.6} stroke={color} strokeWidth={1.3}
                                 fill={low ? "var(--color-surface)" : color} data-low={low ? "yes" : "no"} />;
                }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Kpi({ label, value, sub, tone, n, title, to, deltaNode, trend }: {
  label: string; value: string; sub?: string; tone?: Band; n?: number; title?: string; to?: string; deltaNode?: React.ReactNode; trend?: TrendPoint[] | null;
}) {
  const low = n != null && isLowSample(n);
  const color = !tone || low ? C.text : bandColor(tone);
  const body = (
    <>
      <div className="panel-title">{label}</div>
      <div className="flex items-baseline gap-2 mt-1.5">
        <span className="mono text-2xl font-semibold" style={{ color }}>{value}</span>
        {deltaNode}
      </div>
      <div className="text-xs text-muted mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        {sub && <span>{sub}</span>}
        {n != null && <SampleTag n={n} />}
      </div>
      {trend && <Sparkline points={trend} color={tone && !low ? bandColor(tone) : C.muted} />}
    </>
  );
  return to
    ? <Link to={to} className="panel px-4 py-3.5 block hover:border-muted transition-colors" title={title} data-testid={`kpi-${label}`}>{body}</Link>
    : <div className="panel px-4 py-3.5" title={title} data-testid={`kpi-${label}`}>{body}</div>;
}

export default function Overview() {
  const { sel, runs, tse, tseName, isManager, profile } = useRun();
  const href = useScopedHref();
  const { data, error, loading, reload } = useAsync(() => api.dashboard(sel, runs, tse, 2), [sel, runs, tse]);
  const [grain, setGrain] = useState<"off" | "day" | "week" | "month">("off");
  const trend = useAsync(
    () => (grain === "off" ? Promise.resolve(null) : api.trend(lastPeriods(grain, dataDate(runs), 12), runs, tse)),
    [grain, runs, tse],
  );

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data || !runs.length) {
    return <div className="panel"><Empty hint={isManager ? "Runs are pushed from the local worker." : "Your manager hasn't published an audit run yet."}>No audit runs yet.</Empty></div>;
  }

  const { scope } = data;
  const k = data.cur, b = data.cmp;
  const baseLabel = scope.cmp?.label ?? null;
  const baseEmpty = Boolean(scope.cmp && scope.cmp.rows.length === 0);
  const lowPair = (n: number, m?: number) => isLowSample(n) || (b != null && isLowSample(m ?? 0));
  const reviewTone = reviewRateBand(k.review_rate);
  const sloTone = band("slo_compliance", k.slo_compliance);
  const strikeTone = band("three_strike_compliance", k.strike_rate);
  const scoreTone = capByRelated(band("score", k.average_score), [reviewTone, sloTone, strikeTone]);
  const series = (f: (s: Summary) => number | null, n: (s: Summary) => number): TrendPoint[] | null =>
    trend.data ? trend.data.map((t) => ({ label: t.label, value: t.summary.cases ? f(t.summary) : null, n: n(t.summary) })) : null;
  const tr: Record<KpiKey, TrendPoint[] | null> = {
    cases: series((s) => s.cases, (s) => s.cases),
    score: series((s) => s.average_score, (s) => s.scored),
    slo: series((s) => (s.slo_compliance == null ? null : Math.round(s.slo_compliance * 100)), (s) => s.slo_n),
    review: series((s) => (s.review_rate == null ? null : Math.round(s.review_rate * 100)), (s) => s.cases),
    idle: series((s) => s.support_idle_cases, (s) => s.cases),
    blocked: series((s) => s.redaction_failed + s.eval_failed, (s) => s.cases),
  };
  const strikeData = [
    ["APPLIED_CORRECTLY", CHECK_VOCAB.met, C.success], ["APPLIED_INCORRECTLY", CHECK_VOCAB.breached, C.danger],
    ["INSUFFICIENT_DATA", CHECK_VOCAB.insufficient, C.warning], ["NOT_APPLICABLE", CHECK_VOCAB.na, C.line],
  ].map(([code, name, color]) => ({ name, color, value: k.three_strike[code] ?? 0 }));
  const dims = [...k.dimension_averages].sort((a, z) => a.average - z.average);
  const reasons = Object.entries(k.review_reasons).sort((a, z) => z[1] - a[1]);
  const title = isManager ? (tse ? `Overview · ${tseName}` : "Team overview") : `My audit overview · ${profile.display_name}`;
  const cRun = scope.cur.run;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <ComparisonHeader scope={scope} count={k.cases} />
          <div className="flex flex-wrap items-center gap-x-3 text-sm">
            {cRun && <RunDetails align="left" info={cRun} />}
            <ThresholdLegend align="left" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted">Trend
            <select value={grain} onChange={(e) => setGrain(e.target.value as typeof grain)} aria-label="Trend period" className="text-xs py-1">
              <option value="off">Off</option><option value="day">Last 12 days</option><option value="week">Last 12 weeks</option><option value="month">Last 12 months</option>
            </select>
          </label>
          {isManager && <Link to={href("/review")} className="btn-primary">Open review queue ({k.review_queue})</Link>}
        </div>
      </div>

      {k.cases === 0 ? (
        <div className="panel"><Empty hint="Choose another period or run in the top bar.">No cases in {scope.cur.label}.</Empty></div>
      ) : (<>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi label="Cases audited" value={String(k.cases)} n={k.cases} to={href("/cases")} trend={tr.cases}
             deltaNode={<DeltaTag d={delta(k.cases, b?.cases ?? null, "count")} baseLabel={baseLabel} baseEmpty={baseEmpty} low />} />
        <Kpi label="Average score" value={k.average_score == null ? "—" : k.average_score.toFixed(1)} sub="out of 10" tone={scoreTone} n={k.scored}
             to={href("/cases", { sort: "overall", order: "asc" })} trend={tr.score}
             title={scoreTone !== band("score", k.average_score) ? "Held at amber because a related rate is red." : undefined}
             deltaNode={<DeltaTag d={delta(k.average_score, b?.average_score ?? null, "score")} baseLabel={baseLabel} baseEmpty={baseEmpty} low={lowPair(k.scored, b?.scored)} />} />
        <Kpi label="SLO compliance" value={pct(k.slo_compliance)} tone={sloTone} n={k.slo_n}
             sub={`${k.slo_met} of ${k.slo_n} met${k.slo_insufficient ? ` · ${k.slo_insufficient} insufficient data` : ""}`}
             title="Initial response, among cases with a determinable SLO outcome." to={href("/cases", { check: "slo" })} trend={tr.slo}
             deltaNode={<DeltaTag d={delta(k.slo_compliance, b?.slo_compliance ?? null, "rate")} baseLabel={baseLabel} baseEmpty={baseEmpty} low={lowPair(k.slo_n, b?.slo_n)} />} />
        <Kpi label={isManager ? "Review queue" : "Flagged for review"} value={String(k.review_queue)} sub={`${pct(k.review_rate)} of cases`} tone={reviewTone} n={k.cases}
             to={href("/cases", { review_reason: "any" })} trend={tr.review}
             deltaNode={<DeltaTag d={delta(k.review_rate, b?.review_rate ?? null, "rate", false)} baseLabel={baseLabel} baseEmpty={baseEmpty} low={lowPair(k.cases, b?.cases)} />} />
        <Kpi label="Support-side idle" value={String(k.support_idle_cases)} sub="cases over the idle threshold" to={href("/cases", { check: "idle" })} trend={tr.idle}
             deltaNode={<DeltaTag d={delta(k.support_idle_cases, b?.support_idle_cases ?? null, "count", false)} baseLabel={baseLabel} baseEmpty={baseEmpty} low={lowPair(k.cases, b?.cases)} />} />
        <Kpi label="Blocked / failed" value={`${k.redaction_failed} / ${k.eval_failed}`} sub="redaction / evaluation" trend={tr.blocked}
             to={href("/cases", { state: "failed" })} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="Score distribution (overall /10)" className="lg:col-span-2">
          {k.scored === 0 ? <Empty>No scored cases.</Empty> : (
            <div className="h-56">
              <ResponsiveContainer>
                <BarChart data={k.score_distribution} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="bucket" {...axis} />
                  <YAxis allowDecimals={false} {...axis} />
                  <Tooltip {...tooltipStyle} formatter={(v: number) => [v, "cases"]} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={56}>
                    {k.score_distribution.map((bk, i) => <Cell key={bk.bucket} fill={bandColor(band("score", i * 2 + 1))} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Average per dimension (/10)">
          {dims.length === 0 ? <Empty>No scored dimensions.</Empty> : (
            <ul className="space-y-2.5">
              {dims.map((d) => {
                const low = isLowSample(d.n);
                const color = low ? C.muted : bandColor(band("score", d.average));
                const prev = b?.dimension_averages.find((x) => x.dimension === d.dimension);
                return (
                  <li key={d.dimension}>
                    <div className="flex justify-between gap-2 text-sm">
                      <span>{d.label} <span className="text-muted text-xs">· weight {d.weight}%</span></span>
                      <span className="flex items-baseline gap-2">
                        <DeltaTag d={delta(d.average, prev?.average ?? null, "score")} baseLabel={baseLabel} baseEmpty={baseEmpty} low={low || isLowSample(prev?.n ?? 0)} />
                        <span className="mono" style={{ color: low ? C.text : color }}>{d.average.toFixed(1)}</span>
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-elevated mt-1 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${d.average * 10}%`, background: color }} />
                    </div>
                    <div className="text-[11px] text-muted mt-0.5 flex items-center gap-2">{plural(d.n, "scored case")}{low && <SampleTag n={d.n} />}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="SLO initial response by severity">
          {k.slo_by_severity.length === 0 ? <Empty>No SLO outcomes.</Empty> : (
            <>
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={k.slo_by_severity.map((r) => ({ ...r, name: `SEV${r.severity}` }))} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid stroke={C.line} strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="name" {...axis} />
                    <YAxis allowDecimals={false} {...axis} />
                    <Tooltip {...tooltipStyle} />
                    <Bar dataKey="MET" name={CHECK_VOCAB.met} stackId="s" fill={C.success} maxBarSize={40} />
                    <Bar dataKey="BREACHED" name={CHECK_VOCAB.breached} stackId="s" fill={C.danger} maxBarSize={40} />
                    <Bar dataKey="INSUFFICIENT_DATA" name={CHECK_VOCAB.insufficient} stackId="s" fill={C.warning} radius={[4, 4, 0, 0]} maxBarSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Legend items={[[CHECK_VOCAB.met, C.success], [CHECK_VOCAB.breached, C.danger], [CHECK_VOCAB.insufficient, C.warning]]} />
            </>
          )}
        </Panel>

        <Panel title="3-strike compliance">
          {k.strike_n === 0 ? <Empty>No non-response closures in this period.</Empty> : (<>
            <div className="flex items-baseline gap-2">
              <div className="mono text-3xl font-semibold" style={{ color: isLowSample(k.strike_n) ? C.text : bandColor(strikeTone) }}>{pct(k.strike_rate)}</div>
              <DeltaTag d={delta(k.strike_rate, b?.strike_rate ?? null, "rate")} baseLabel={baseLabel} baseEmpty={baseEmpty} low={lowPair(k.strike_n, b?.strike_n)} />
              <SampleTag n={k.strike_n} />
            </div>
            <div className="text-xs text-muted mb-3">correct among {plural(k.strike_n, "non-response closure")}</div>
            <ul className="space-y-1.5 text-sm">
              {strikeData.map((s) => (
                <li key={s.name} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                  <span className="flex-1 text-muted">{s.name}</span>
                  <span className="mono">{s.value}</span>
                </li>
              ))}
            </ul>
          </>)}
        </Panel>

        <Panel title={isManager ? "Review queue by reason" : "Flags on my cases"} action={isManager ? <Link to={href("/review")} className="text-xs text-info hover:underline">Open queue →</Link> : null}>
          {reasons.length === 0 ? <Empty>Nothing flagged.</Empty> : (
            <ul className="space-y-2">
              {reasons.map(([code, n]) => (
                <li key={code} className="flex items-center justify-between gap-2">
                  <Link to={href("/cases", { review_reason: code })} className="flex items-center gap-2 min-w-0 hover:opacity-80">
                    <ReasonPill code={code} /><span className="text-xs text-muted hidden xl:inline truncate">{REASONS[code]?.hint}</span>
                  </Link>
                  <span className="mono text-sm">{n}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 pt-3 border-t border-line">
            <div className="panel-title mb-2">Data completeness</div>
            <p className="text-xs text-muted"><span className="mono text-text">{k.low_completeness}</span> of {plural(k.cases, "case")} below 80% complete source data</p>
          </div>
        </Panel>
      </div>

      <Panel title="Cases with support-side idle" action={<span className="text-xs text-muted">matches the Support-side idle count; idle counts against the score</span>}>
        {data.idle_cases.filter((c) => c.support_idle_hours > 0).length === 0 ? <Empty>No support-side idle windows above the threshold.</Empty> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="py-2 pr-3 font-medium">Case</th><th className="pr-3 font-medium">Severity</th>
                <th className="pr-3 font-medium">Subject</th><th className="pr-3 font-medium text-right">Support idle</th>
                <th className="pr-3 font-medium text-right">Customer idle</th><th className="font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {data.idle_cases.filter((c) => c.support_idle_hours > 0).map((c) => (
                <tr key={c.id} className="border-b border-line/60 last:border-0 hover:bg-elevated/50">
                  <td className="py-2 pr-3"><Link className="mono text-info hover:underline" to={href(`/cases/${c.id}`)}>{c.case_number}</Link></td>
                  <td className="pr-3"><SeverityPill sev={c.severity} /></td>
                  <td className="pr-3 max-w-[420px] truncate text-muted" title={c.subject}>{c.subject}</td>
                  <td className="pr-3 text-right mono" style={{ color: C.danger }}>{fmtDuration(c.support_idle_hours * 60)}</td>
                  <td className="pr-3 text-right mono text-muted">{fmtDuration(c.customer_idle_hours * 60)}</td>
                  <td><ScoreBadge score={c.overall} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      </>)}
    </div>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="flex flex-wrap gap-3 mt-2 text-xs text-muted">
      {items.map(([l, c]) => (
        <span key={l} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />{l}</span>
      ))}
    </div>
  );
}
