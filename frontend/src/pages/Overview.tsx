import { Link } from "react-router-dom";
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api } from "../api";
import { ErrorNote, Loading, Panel, ReasonPill, ScoreBadge, SeverityPill, Empty } from "../components/ui";
import { useAsync, useRun } from "../lib/hooks";
import { C, REASON_META, fmtDate, fmtDuration, humanize, scoreColor } from "../lib/format";

const axis = { stroke: C.muted, fontSize: 11, tickLine: false, axisLine: { stroke: C.line } };
const tooltipStyle = {
  contentStyle: { background: C.elevated, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12, color: C.text },
  labelStyle: { color: C.muted },
  cursor: { fill: "color-mix(in oklab, var(--color-text) 6%, transparent)" },
};

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="panel px-4 py-3.5">
      <div className="panel-title">{label}</div>
      <div className="mono text-2xl font-semibold mt-1.5" style={{ color: color ?? C.text }}>{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

export default function Overview() {
  const { runId, tse, isManager, profile } = useRun();
  const { data, error, loading } = useAsync(() => api.dashboard(runId, tse), [runId, tse]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data || !data.run) return <Empty>No audit runs yet. Runs are pushed from the local worker (see Runs).</Empty>;

  const k = data.kpis;
  const sloPct = k.slo_compliance == null ? "—" : `${Math.round(k.slo_compliance * 100)}%`;
  const strikeData = ["APPLIED_CORRECTLY", "APPLIED_INCORRECTLY", "INSUFFICIENT_DATA", "NOT_APPLICABLE"].map((s) => ({
    name: humanize(s), value: data.three_strike[s] ?? 0,
    color: s === "APPLIED_CORRECTLY" ? C.success : s === "APPLIED_INCORRECTLY" ? C.danger : s === "INSUFFICIENT_DATA" ? C.warning : C.line,
  }));
  const strikeApplicable = (data.three_strike.APPLIED_CORRECTLY ?? 0) + (data.three_strike.APPLIED_INCORRECTLY ?? 0);
  const dims = [...data.dimension_averages].sort((a, b) => a.average - b.average);
  const reasons = Object.entries(data.review_reasons).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{isManager ? (tse ? `Overview · ${tse}` : "Team overview") : `My audit overview · ${profile.display_name}`}</h1>
          <p className="text-sm text-muted mt-0.5">
            {data.run.source} run · as of {fmtDate(data.run.as_of)} · model{" "}
            <span className="mono">{data.run.model}</span>
          </p>
        </div>
        {isManager && <Link to="/review" className="btn-primary">Open review queue ({k.review_queue})</Link>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi label="Cases audited" value={String(k.cases)} />
        <Kpi label="Average score" value={k.average_score == null ? "—" : k.average_score.toFixed(1)} sub="out of 10" color={scoreColor(k.average_score)} />
        <Kpi label="SLO compliance" value={sloPct} sub="initial response, determinable cases"
             color={k.slo_compliance == null ? undefined : k.slo_compliance >= 0.9 ? C.success : k.slo_compliance >= 0.7 ? C.warning : C.danger} />
        <Kpi label={isManager ? "Review queue" : "Flagged for review"} value={String(k.review_queue)} sub="cases needing a human" color={k.review_queue ? C.accent : undefined} />
        <Kpi label="Support-side idle" value={String(k.support_idle_cases)} sub="cases with idle > threshold" color={k.support_idle_cases ? C.warning : undefined} />
        <Kpi label="Blocked / failed" value={`${k.redaction_failed} / ${k.eval_failed}`} sub="redaction / evaluation"
             color={k.redaction_failed + k.eval_failed ? C.danger : undefined} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="Score distribution (overall /10)" className="lg:col-span-2">
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={data.score_distribution} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid stroke={C.line} strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="bucket" {...axis} />
                <YAxis allowDecimals={false} {...axis} />
                <Tooltip {...tooltipStyle} formatter={(v: number) => [v, "cases"]} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={36}>
                  {data.score_distribution.map((b, i) => <Cell key={b.bucket} fill={scoreColor(i + 0.5)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Average per dimension (/10)">
          <ul className="space-y-2.5">
            {dims.map((d) => (
              <li key={d.dimension}>
                <div className="flex justify-between text-sm">
                  <span>{d.label}</span>
                  <span className="mono" style={{ color: scoreColor(d.average) }}>{d.average.toFixed(1)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-elevated mt-1 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${d.average * 10}%`, background: scoreColor(d.average) }} />
                </div>
                <div className="text-[11px] text-muted mt-0.5">{d.n} scored case{d.n === 1 ? "" : "s"}</div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="SLO initial response by severity">
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={data.slo_by_severity.map((r) => ({ ...r, name: `SEV${r.severity}` }))} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid stroke={C.line} strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="name" {...axis} />
                <YAxis allowDecimals={false} {...axis} />
                <Tooltip {...tooltipStyle} />
                <Bar dataKey="MET" name="Met" stackId="s" fill={C.success} maxBarSize={40} />
                <Bar dataKey="BREACHED" name="Breached" stackId="s" fill={C.danger} maxBarSize={40} />
                <Bar dataKey="INSUFFICIENT_DATA" name="Insufficient data" stackId="s" fill={C.warning} radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Legend items={[["Met", C.success], ["Breached", C.danger], ["Insufficient data", C.warning]]} />
        </Panel>

        <Panel title="3-strike compliance">
          <div className="mono text-3xl font-semibold" style={{ color: strikeApplicable ? ((data.three_strike.APPLIED_CORRECTLY ?? 0) / strikeApplicable >= 0.9 ? C.success : C.warning) : C.muted }}>
            {strikeApplicable ? `${Math.round(((data.three_strike.APPLIED_CORRECTLY ?? 0) / strikeApplicable) * 100)}%` : "—"}
          </div>
          <div className="text-xs text-muted mb-3">correct among {strikeApplicable} non-response closure{strikeApplicable === 1 ? "" : "s"}</div>
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
                  <span className="flex items-center gap-2"><ReasonPill code={code} /><span className="text-xs text-muted hidden xl:inline">{REASON_META[code]?.hint}</span></span>
                  <span className="mono text-sm">{n}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 pt-3 border-t border-line">
            <div className="panel-title mb-2">Data completeness</div>
            <p className="text-xs text-muted">
              <span className="mono text-text">{data.low_completeness}</span> of {data.kpis.cases} cases below 80% complete source data
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
