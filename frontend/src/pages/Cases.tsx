import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type CaseRow } from "../api";
import { Empty, ErrorNote, Loading, OutcomePill, Pill, ReasonPill, ScoreBadge, SeverityPill } from "../components/ui";
import { useAsync, useRun } from "../lib/hooks";
import { C, REASON_META, fmtDate, humanize, outcomeColor, severityColor } from "../lib/format";

type SortKey = "case_number" | "severity" | "overall" | "opened_at";

export default function Cases() {
  const { runId, tse, isManager, profile } = useRun();
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
  const { data, error, loading } = useAsync(
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
          <h1 className="text-xl font-semibold tracking-tight">{isManager ? (tse ? `Cases · ${tse}` : "Cases · all TSEs") : `My cases · ${profile.display_name}`}</h1>
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
          {Object.entries(REASON_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => set("status", e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {data?.facets.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filters.state} onChange={(e) => set("state", e.target.value)} aria-label="Audit state">
          <option value="">Any audit state</option>
          {["OK", "EVAL_FAILED", "REDACTION_FAILED"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </select>
      </div>

      <ErrorNote error={error} />
      {loading && !data ? <Loading /> : !data?.rows.length ? <Empty>No cases match these filters.</Empty> : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <Th onClick={() => sortBy("case_number")} active={filters.sort === "case_number"} order={filters.order}>Case</Th>
                <Th onClick={() => sortBy("severity")} active={filters.sort === "severity"} order={filters.order}>Sev</Th>
                <th className="px-3 py-2.5 font-medium">Subject</th>
                <th className="px-3 py-2.5 font-medium">TSE</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <Th onClick={() => sortBy("overall")} active={filters.sort === "overall"} order={filters.order}>Score</Th>
                <th className="px-3 py-2.5 font-medium">SLO</th>
                <th className="px-3 py-2.5 font-medium">Idle</th>
                <th className="px-3 py-2.5 font-medium">3-strike</th>
                <th className="px-3 py-2.5 font-medium">Confidence</th>
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

function Th({ children, onClick, active, order }: { children: string; onClick: () => void; active: boolean; order: string }) {
  return (
    <th className="px-3 py-2.5 font-medium" aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <button onClick={onClick} className={`inline-flex items-center gap-1 hover:text-text ${active ? "text-text" : ""}`}>
        {children}<span className="text-[10px]">{active ? (order === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

export const ACTION_LABEL: Record<string, string> = { approve: "Approved", override: "Overridden", comment: "Commented" };

const SHORT: Record<string, string> = {
  MET: "Met", BREACHED: "Breach", INSUFFICIENT_DATA: "n/d", NO_SUPPORT_IDLE: "OK", SUPPORT_IDLE: "Idle",
  APPLIED_CORRECTLY: "OK", APPLIED_INCORRECTLY: "Wrong", NOT_APPLICABLE: "n/a",
};

function Mini({ v }: { v: string | null }) {
  if (!v) return <span className="text-muted">—</span>;
  const color = v === "NOT_APPLICABLE" ? C.muted : outcomeColor(v);
  return <Pill color={color} title={humanize(v)}>{SHORT[v] ?? humanize(v)}</Pill>;
}

function Row({ r, onOpen }: { r: CaseRow; onOpen: () => void }) {
  return (
    <tr
      onClick={onOpen}
      className="border-b border-line/60 last:border-0 hover:bg-elevated/60 cursor-pointer"
      style={{ boxShadow: `inset 3px 0 0 ${severityColor(r.severity)}` }}
    >
      <td className="px-3 py-2.5"><Link to={`/cases/${r.id}`} onClick={(e) => e.stopPropagation()} className="mono text-info hover:underline">{r.case_number}</Link></td>
      <td className="px-3"><SeverityPill sev={r.severity} /></td>
      <td className="px-3 max-w-[340px]"><div className="truncate" title={r.subject}>{r.state === "REDACTION_FAILED" ? <span className="text-danger">Blocked by leak scanner</span> : r.subject}</div></td>
      <td className="px-3 text-xs text-muted whitespace-nowrap">{r.owner || "—"}</td>
      <td className="px-3 text-muted whitespace-nowrap">{r.status}<div className="text-[11px]">{fmtDate(r.opened_at, false)}</div></td>
      <td className="px-3">{r.state === "OK" ? <ScoreBadge score={r.overall} /> : <OutcomePill value={r.state} />}</td>
      <td className="px-3"><Mini v={r.slo} /></td>
      <td className="px-3"><Mini v={r.idle} /></td>
      <td className="px-3"><Mini v={r.three_strike} /></td>
      <td className="px-3"><OutcomePill value={r.confidence_level} /></td>
      <td className="px-3">
        <div className="flex flex-wrap gap-1 max-w-[220px]">
          {r.review_reasons.map((x) => <ReasonPill key={x} code={x} />)}
          {r.review && <Pill color={outcomeColor(r.review.action)} title={`by ${r.review.reviewer_name}`}>{ACTION_LABEL[r.review.action] ?? r.review.action}</Pill>}
        </div>
      </td>
    </tr>
  );
}
