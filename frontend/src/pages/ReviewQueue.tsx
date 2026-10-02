import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type CaseRow } from "../api";
import { Empty, ErrorNote, Loading, Pill, ReasonPill, ScoreBadge, SeverityPill } from "../components/ui";
import { useAsync, useRun } from "../lib/hooks";
import { REASON_META, outcomeColor, severityColor } from "../lib/format";
import { ACTION_LABEL } from "./Cases";

export default function ReviewQueue() {
  const { runId, tse } = useRun();
  const [sort, setSort] = useState<"severity" | "score" | "case_number">("severity");
  const [only, setOnly] = useState<string>("");
  const { data, error, loading, reload } = useAsync(() => api.queue(runId, sort, tse), [runId, sort, tse]);

  const groups = (data?.groups ?? []).filter((g) => !only || g.reason === only);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Review queue{tse ? ` · ${tse}` : ""}</h1>
          <p className="text-sm text-muted mt-0.5">{data ? `${data.total} case${data.total === 1 ? "" : "s"} routed for human review` : " "} · a case appears under every reason it matches</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-muted">Reason
            <select value={only} onChange={(e) => setOnly(e.target.value)}>
              <option value="">All</option>
              {Object.entries(REASON_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-muted">Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="severity">Severity</option>
              <option value="score">Score (lowest first)</option>
              <option value="case_number">Case number</option>
            </select>
          </label>
        </div>
      </div>
      <ErrorNote error={error} />
      {loading && !data ? <Loading /> : groups.length === 0 ? <Empty>The review queue is empty.</Empty> : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.reason} className="panel overflow-hidden">
              <header className="flex items-center gap-3 px-4 py-3 border-b border-line bg-elevated/40">
                <ReasonPill code={g.reason} />
                <span className="text-sm text-muted">{REASON_META[g.reason]?.hint}</span>
                <span className="ml-auto mono text-sm">{g.cases.length}</span>
              </header>
              <ul>
                {g.cases.map((c) => <QueueRow key={`${g.reason}-${c.id}`} c={c} onDone={reload} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function QueueRow({ c, onDone }: { c: CaseRow; onDone: () => void }) {
  const [mode, setMode] = useState<"idle" | "override">("idle");
  const [score, setScore] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = async (action: "approve" | "override") => {
    if (!c.audit_id) return;
    setBusy(true); setErr(null);
    try {
      await api.review(c.audit_id, { action, score_override: action === "override" ? Number(score) : undefined });
      setMode("idle"); setScore(""); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-b border-line/60 last:border-0 hover:bg-elevated/40"
        style={{ boxShadow: `inset 3px 0 0 ${severityColor(c.severity)}` }}>
      <Link to={`/cases/${c.id}`} className="mono text-info hover:underline w-24">{c.case_number}</Link>
      <SeverityPill sev={c.severity} />
      <div className="flex-1 min-w-[200px] truncate text-sm" title={c.subject}>{c.state === "REDACTION_FAILED" ? <span className="text-danger">Blocked by leak scanner</span> : c.subject}</div>
      <span className="mono text-xs text-muted">{c.owner}</span>
      <ScoreBadge score={c.overall} />
      <div className="flex flex-wrap gap-1 w-56">{c.review_reasons.map((r) => <ReasonPill key={r} code={r} />)}</div>
      <div className="flex items-center gap-2 ml-auto">
        {c.review && <Pill color={outcomeColor(c.review.action)} title={`by ${c.review.reviewer_name}`}>{ACTION_LABEL[c.review.action]}{c.review.score_override != null ? ` · ${c.review.score_override.toFixed(1)}` : ""}</Pill>}
        {mode === "override" ? (
          <>
            <input type="number" min={0} max={10} step={0.1} value={score} onChange={(e) => setScore(e.target.value)}
                   className="w-20 mono" placeholder="0–10" aria-label="Override score" autoFocus />
            <button className="btn-primary" disabled={busy || score === ""} onClick={() => act("override")}>Save</button>
            <button className="btn-ghost" onClick={() => setMode("idle")}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn-ghost" disabled={busy || !c.audit_id} onClick={() => act("approve")}>Approve</button>
            <button className="btn-ghost" disabled={busy || !c.audit_id} onClick={() => setMode("override")}>Override</button>
            <Link className="btn-ghost" to={`/cases/${c.id}`}>Open</Link>
          </>
        )}
      </div>
      {err && <div className="basis-full text-xs text-danger">{err}</div>}
    </li>
  );
}
