import { Link } from "react-router-dom";
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api } from "../api";
import { Empty, ErrorState, Loading, Panel, ReasonPill, RunDetails, SampleTag, ScoreBadge, SeverityPill, ThresholdLegend, Time } from "../components/ui";
import { useAsync, useRun } from "../lib/hooks";
import { C, fmtDuration, plural } from "../lib/format";
import { CHECK_VOCAB, REASONS, RUN_SOURCE, lookup } from "../lib/labels";
import { band, bandColor, capByRelated, isLowSample, reviewRateBand, type Band } from "../lib/thresholds";

const axis = { stroke: C.muted, fontSize: 11, tickLine: false, axisLine: { stroke: C.line } };
const tooltipStyle = {
  contentStyle: { background: C.elevated, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12, color: C.text },
  labelStyle: { color: C.muted },
  cursor: { fill: "color-mix(in oklab, var(--color-text) 6%, transparent)" },
};

/** A KPI tile. With a sample size below the low-sample threshold the value is shown uncoloured with "n=… low sample". */
function Kpi({ label, value, sub, tone, n, title }: { label: string; value: string; sub?: string; tone?: Band; n?: number; title?: string }) {
  const low = n != null && isLowSample(n);
  const color = !tone || low ? C.text : bandColor(tone);
  return (
    <div className="panel px-4 py-3.5" title={title} data-testid={`kpi-${label}`}>
      <div className="panel-title">{label}</div>
      <div className="mono text-2xl font-semibold mt-1.5" style={{ color }}>{value}</div>
      <div className="text-xs text-muted mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        {sub && <span>{sub}</span>}
        {n != null && <SampleTag n={n} />}
      </div>
    </div>
  );
}

export default function Overview() {
  const { runId, tse, tseName, isManager, profile } = useRun();
  const { data, error, loading, reload } = useAsync(() => api.dashboard(runId, tse), [runId, tse]);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data || !data.run) {
    return <div className="panel"><Empty hint={isManager ? "Runs are pushed from the local worker; see Runs." : "Your manager hasn't published an audit run yet."}>No audit runs yet.</Empty></div>;
  }

  const k = data.kpis;
  const reviewTone = reviewRateBand(k.review_rate);
  const sloTone = band("slo_compliance", k.slo_compliance);
  const strikeOk = data.three_strike.APPLIED_CORRECTLY ?? 0;
  const strikeApplicable = strikeOk + (data.three_strike.APPLIED_INCORRECTLY ?? 0);
  const strikeRate = strikeApplicable ? strikeOk / strikeApplicable : null;
  const strikeTone = band("three_strike_compliance", strikeRate);
  // Average score may not read green while the review rate or a rule-compliance rate is red.
  const scoreTone = capByRelated(band("score", k.average_score), [reviewTone, sloTone, strikeTone]);
  const strikeData = [
    ["APPLIED_CORRECTLY", CHECK_VOCAB.met, C.success], ["APPLIED_INCORRECTLY", CHECK_VOCAB.breached, C.danger],
    ["INSUFFICIENT_DATA", CHECK_VOCAB.insufficient, C.warning], ["NOT_APPLICABLE", CHECK_VOCAB.na, C.line],
  ].map(([code, name, color]) => ({ name, color, value: data.three_strike[code] ?? 0 }));
  const dims = [...data.dimension_averages].sort((a, b) => a.average - b.average);
  const reasons = Object.entries(data.review_reasons).sort((a, b) => b[1] - a[1]);
  const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const run = data.run;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{isManager ? (tse ? `Overview · ${tseName}` : "Team overview") : `My audit overview · ${profile.display_name}`}</h1>
          <div className="text-sm text-muted mt-0.5 flex flex-wrap items-center gap-x-3">
            <span>{lookup(RUN_SOURCE, run.source)} · as of <Time iso={run.as_of} /></span>
            <RunDetails align="left" info={run} />
            <ThresholdLegend align="left" />
          </div>
        </div>
        {isManager && <Link to="/review" className="btn-primary">Open review queue ({k.review_queue})</Link>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi label="Cases audited" value={String(k.cases)} n={k.cases} />
        <Kpi label="Average score" value={k.average_score == null ? "—" : k.average_score.toFixed(1)} sub="out of 10" tone={scoreTone} n={k.scored}
             title={scoreTone !== band("score", k.average_score) ? "Held at amber because a related rate is red." : undefined} />
        <Kpi label="SLO compliance" value={pct(k.slo_compliance)} sub="initial response" tone={sloTone} n={k.slo_n}
             title="Share of cases with a determinable SLO outcome that met the target." />
        <Kpi label={isManager ? "Review queue" : "Flagged for review"} value={String(k.review_queue)} sub={`${pct(k.review_rate)} of cases`} tone={reviewTone} n={k.cases} />
        <Kpi label="Support-side idle" value={String(k.support_idle_cases)} sub="cases over the idle threshold" />
        <Kpi label="Blocked / failed" value={`${k.redaction_failed} / ${k.eval_failed}`} sub="redaction / evaluation" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="Score distribution (overall /10)" className="lg:col-span-2">
          {k.scored === 0 ? <Empty>No scored cases in this run.</Empty> : (
            <div className="h-56">
              <ResponsiveContainer>
                <BarChart data={data.score_distribution} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="bucket" {...axis} />
                  <YAxis allowDecimals={false} {...axis} />
                  <Tooltip {...tooltipStyle} formatter={(v: number) => [v, "cases"]} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={36}>
                    {data.score_distribution.map((b, i) => <Cell key={b.bucket} fill={bandColor(band("score", i + 0.5))} />)}
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
                const color = isLowSample(d.n) ? C.muted : bandColor(band("score", d.average));
                return (
                  <li key={d.dimension}>
                    <div className="flex justify-between text-sm">
                      <span>{d.label}</span>
                      <span className="mono" style={{ color: isLowSample(d.n) ? C.text : color }}>{d.average.toFixed(1)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-elevated mt-1 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${d.average * 10}%`, background: color }} />
                    </div>
                    <div className="text-[11px] text-muted mt-0.5 flex items-center gap-2">
                      {plural(d.n, "scored case")}{isLowSample(d.n) && <SampleTag n={d.n} />}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="SLO initial response by severity">
          {data.slo_by_severity.length === 0 ? <Empty>No SLO outcomes in this run.</Empty> : (
            <>
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={data.slo_by_severity.map((r) => ({ ...r, name: `SEV${r.severity}` }))} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
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
          <div className="flex items-baseline gap-2">
            <div className="mono text-3xl font-semibold" style={{ color: isLowSample(strikeApplicable) ? C.text : bandColor(strikeTone) }}>{pct(strikeRate)}</div>
            <SampleTag n={strikeApplicable} />
          </div>
          <div className="text-xs text-muted mb-3">correct among {plural(strikeApplicable, "non-response closure")}</div>
          <ul className="space-y-1.5 text-sm">
            {strikeData.map((s) => (
              <li key={s.name} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                <span className="flex-1 text-muted">{s.name}</span>
                <span className="mono">{s.value}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title={isManager ? "Review queue by reason" : "Flags on my cases"} action={isManager ? <Link to="/review" className="text-xs text-info hover:underline">Open queue →</Link> : null}>
          {reasons.length === 0 ? <Empty>Nothing to review.</Empty> : (
            <ul className="space-y-2">
              {reasons.map(([code, n]) => (
                <li key={code} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 min-w-0"><ReasonPill code={code} /><span className="text-xs text-muted hidden xl:inline truncate">{REASONS[code]?.hint}</span></span>
                  <span className="mono text-sm">{n}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 pt-3 border-t border-line">
            <div className="panel-title mb-2">Data completeness</div>
            <p className="text-xs text-muted">
              <span className="mono text-text">{data.low_completeness}</span> of {plural(k.cases, "case")} below 80% complete source data
            </p>
          </div>
        </Panel>
      </div>

      <Panel title="Cases with idle windows" action={<span className="text-xs text-muted">support-side idle counts against the score</span>}>
        {data.idle_cases.length === 0 ? <Empty>No idle windows above the threshold.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-medium">Case</th><th className="pr-3 font-medium">Severity</th>
                  <th className="pr-3 font-medium">Subject</th><th className="pr-3 font-medium text-right">Support idle</th>
                  <th className="pr-3 font-medium text-right">Customer idle</th><th className="font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {data.idle_cases.map((c) => (
                  <tr key={c.id} className="border-b border-line/60 last:border-0 hover:bg-elevated/50">
                    <td className="py-2 pr-3"><Link className="mono text-info hover:underline" to={`/cases/${c.id}`}>{c.case_number}</Link></td>
                    <td className="pr-3"><SeverityPill sev={c.severity} /></td>
                    <td className="pr-3 max-w-[420px] truncate text-muted">{c.subject}</td>
                    <td className="pr-3 text-right mono" style={{ color: c.support_idle_hours ? C.danger : C.muted }}>{fmtDuration(c.support_idle_hours * 60)}</td>
                    <td className="pr-3 text-right mono text-muted">{fmtDuration(c.customer_idle_hours * 60)}</td>
                    <td><ScoreBadge score={c.overall} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
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
