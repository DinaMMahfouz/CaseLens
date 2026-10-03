import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type CaseRow } from "../api";
import { AuditStatePill, ChecksCell, Empty, ErrorState, Loading, Pill, ReasonPill, ScoreBadge, SeverityPill, Time } from "../components/ui";
import { useAsync, useRun } from "../lib/hooks";
import { C, NO_DATE_TITLE, ageDays, plural, reviewActionColor, severityColor } from "../lib/format";
import { AUDIT_STATE, REASONS, REVIEW_ACTION } from "../lib/labels";
import { band, bandColor } from "../lib/thresholds";

type SortKey = "case_number" | "severity" | "overall" | "opened_at";

export default function Cases() {
  const { runId, tse, tseName, isManager, profile } = useRun();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const filters = {
    severity: sp.getAll("severity").map(Number),
    score_min: sp.get("score_min") ?? "",
    score_max: sp.get("score_max") ?? "",
    review_reason: sp.get("review_reason") ?? "",
    status: sp.get("status") ?? "",
    state: sp.get("state") ?? "",
    sort: (sp.get("sort") as SortKey) ?? "case_number",
    order: (sp.get("order") as "asc" | "desc") ?? "asc",
  };
  const key = sp.toString();
  const { data, error, loading, reload } = useAsync(
    () => api.cases({ run_id: runId, tse, ...filters, q: sp.get("q") ?? "" }),
    [runId, tse, key],
  );

  // Debounced search into the URL.
  useEffect(() => {
    const h = setTimeout(() => set("q", q), 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function set(k: string, v: string | string[]) {
    const next = new URLSearchParams(sp);
    next.delete(k);
    (Array.isArray(v) ? v : [v]).filter(Boolean).forEach((x) => next.append(k, x));
    if (next.toString() !== sp.toString()) setSp(next, { replace: true });
  }
  const toggleSev = (s: number) => {
    const cur = new Set(filters.severity);
    if (cur.has(s)) cur.delete(s); else cur.add(s);
    set("severity", [...cur].sort().map(String));
  };
  const sortBy = (k: SortKey) => {
    const next = new URLSearchParams(sp);
    next.set("sort", k);
    next.set("order", filters.sort === k && filters.order === "asc" ? "desc" : "asc");
    setSp(next, { replace: true });
  };
  const activeCount = useMemo(
    () => [filters.severity.length, filters.score_min, filters.score_max, filters.review_reason, filters.status, filters.state, sp.get("q")].filter((x) => (Array.isArray(x) ? x.length : x)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{isManager ? (tse ? `Cases · ${tseName}` : "Cases · all TSEs") : `My cases · ${profile.display_name}`}</h1>
          <p className="text-sm text-muted mt-0.5">{data ? `${data.total} case${data.total === 1 ? "" : "s"}` : " "} {activeCount ? `· ${activeCount} filter${activeCount > 1 ? "s" : ""} active` : ""}</p>
        </div>
        {activeCount > 0 && <button className="btn-ghost" onClick={() => { setQ(""); setSp(new URLSearchParams(), { replace: true }); }}>Clear filters</button>}
      </div>

      <div className="panel p-3 flex flex-wrap items-center gap-3">
        <input
          type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search case number or subject" className="w-64" aria-label="Search cases"
        />
        <div className="flex items-center gap-1" role="group" aria-label="Severity">
          {[1, 2, 3, 4].map((s) => {
            const on = filters.severity.includes(s);
            return (
              <button key={s} onClick={() => toggleSev(s)} aria-pressed={on}
                className="mono text-xs rounded-md px-2 py-1.5 border transition-colors"
                style={{ borderColor: on ? severityColor(s) : "var(--color-line)", color: on ? severityColor(s) : "var(--color-muted)",
                         background: on ? `color-mix(in oklab, ${severityColor(s)} 12%, transparent)` : "var(--color-elevated)" }}>
                SEV{s}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 text-sm text-muted">
          Score
          <input type="number" min={0} max={10} step={0.5} value={filters.score_min} onChange={(e) => set("score_min", e.target.value)} className="w-16 mono" aria-label="Minimum score" />
          –
          <input type="number" min={0} max={10} step={0.5} value={filters.score_max} onChange={(e) => set("score_max", e.target.value)} className="w-16 mono" aria-label="Maximum score" />
        </div>
        <select value={filters.review_reason} onChange={(e) => set("review_reason", e.target.value)} aria-label="Review reason">
          <option value="">Any review reason</option>
          {Object.entries(REASONS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => set("status", e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {data?.facets.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filters.state} onChange={(e) => set("state", e.target.value)} aria-label="Audit state">
          <option value="">Any audit state</option>
          {Object.entries(AUDIT_STATE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      {error ? <ErrorState error={error} onRetry={reload} />
        : loading && !data ? <Loading variant="table" />
        : !data?.rows.length ? (
          <div className="panel"><Empty hint={activeCount ? "Try clearing a filter." : "Pick another run in the top bar."}>
            {activeCount ? "No cases match these filters." : "No cases in this run."}</Empty></div>
        ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <Th onClick={() => sortBy("case_number")} active={filters.sort === "case_number"} order={filters.order}>Case</Th>
                <Th onClick={() => sortBy("severity")} active={filters.sort === "severity"} order={filters.order}>Sev</Th>
                <th className="px-3 py-2.5 font-medium">Subject</th>
                <th className="px-3 py-2.5 font-medium">TSE</th>
                <th className="px-3 py-2.5 font-medium hidden 2xl:table-cell">Status</th>
                <Th onClick={() => sortBy("opened_at")} active={filters.sort === "opened_at"} order={filters.order} className="hidden 2xl:table-cell">Opened</Th>
                <th className="px-3 py-2.5 font-medium" title="Closed date, or age in days for open cases">Closed / Age</th>
                <Th onClick={() => sortBy("overall")} active={filters.sort === "overall"} order={filters.order}>Score</Th>
                <th className="px-3 py-2.5 font-medium" title="SLO initial response, Idle and 3-strike rule. Only checks that are breached or lack data are listed.">Checks</th>
                <th className="px-3 py-2.5 font-medium hidden 2xl:table-cell" title="How complete the source data is for scoring">Data</th>
                <th className="px-3 py-2.5 font-medium">Review</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => <Row key={r.id} r={r} onOpen={() => nav(`/cases/${r.id}`)} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, onClick, active, order, className = "" }: { children: string; onClick: () => void; active: boolean; order: string; className?: string }) {
  return (
    <th className={`px-3 py-2.5 font-medium ${className}`} aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <button onClick={onClick} className={`inline-flex items-center gap-1 hover:text-text ${active ? "text-text" : ""}`}>
        {children}<span className="text-[10px]">{active ? (order === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

export function DateCell({ iso }: { iso: string | null }) {
  return <Time iso={iso} withTime={false} />;
}

/** Closed cases show their close date; open cases show their age; a missing date is "—". */
export function ClosedOrAge({ r, now }: { r: Pick<CaseRow, "status" | "closed_at" | "opened_at"> & { is_closed?: boolean }; now?: Date }) {
  if (r.closed_at) return <DateCell iso={r.closed_at} />;
  const closed = /closed|resolved/i.test(r.status);
  if (closed) return <span title={NO_DATE_TITLE}>—</span>;
  const age = ageDays(r.opened_at, now);
  return age == null ? <span title={NO_DATE_TITLE}>—</span> : <span title="Open case age">{plural(age, "day")} open</span>;
}

export const ACTION_LABEL = REVIEW_ACTION;

function Row({ r, onOpen }: { r: CaseRow; onOpen: () => void }) {
  return (
    <tr
      onClick={onOpen}
      className="border-b border-line/60 last:border-0 hover:bg-elevated/60 cursor-pointer"
      style={{ boxShadow: `inset 3px 0 0 ${severityColor(r.severity)}` }}
    >
      <td className="px-3 py-2.5"><Link to={`/cases/${r.id}`} onClick={(e) => e.stopPropagation()} className="mono text-info hover:underline">{r.case_number}</Link></td>
      <td className="px-3"><SeverityPill sev={r.severity} /></td>
      <td className="px-3 max-w-[190px] xl:max-w-[300px] 2xl:max-w-[340px]"><div className="truncate" title={r.subject}>{r.state === "REDACTION_FAILED" ? <span className="text-danger">Blocked by redaction check</span> : r.subject}</div></td>
      <td className="px-3 text-xs text-muted whitespace-nowrap">{r.owner || "—"}</td>
      <td className="px-3 text-muted whitespace-nowrap hidden 2xl:table-cell">{r.status}</td>
      <td className="px-3 text-muted whitespace-nowrap hidden 2xl:table-cell"><DateCell iso={r.opened_at} /></td>
      <td className="px-3 text-muted whitespace-nowrap" data-testid="closed-cell"><ClosedOrAge r={r} /></td>
      <td className="px-3">{r.state === "OK" ? <ScoreBadge score={r.overall} /> : <AuditStatePill state={r.state} />}</td>
      <td className="px-3"><ChecksCell slo={r.slo} idle={r.idle} strike={r.three_strike} /></td>
      <td className="px-3 mono text-xs hidden 2xl:table-cell" style={{ color: band("data_completeness", r.data_completeness) === "good" ? C.muted : bandColor(band("data_completeness", r.data_completeness)) }}>
        {r.data_completeness == null ? "—" : `${Math.round(r.data_completeness * 100)}%`}
      </td>
      <td className="px-3">
        <div className="flex flex-wrap gap-1 max-w-[200px]">
          {r.review_reasons.map((x) => <ReasonPill key={x} code={x} />)}
          {r.review && <Pill color={reviewActionColor(r.review.action)} title={`by ${r.review.reviewer_name}`}>{ACTION_LABEL[r.review.action] ?? "Reviewed"}</Pill>}
        </div>
      </td>
    </tr>
  );
}
