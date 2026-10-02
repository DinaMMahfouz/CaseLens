import { useCallback, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Audit, type CaseDetail, type Evidence, type Finding, type Item } from "../api";
import Timeline from "../components/Timeline";
import { Empty, ErrorNote, Loading, OutcomePill, Panel, Pill, ReasonPill, ScoreBadge, SeverityPill } from "../components/ui";
import { useAsync, useRun } from "../lib/hooks";
import { C, fmtDate, fmtDuration, fmtScore, humanize, outcomeColor, scoreColor } from "../lib/format";
import { ACTION_LABEL } from "./Cases";

const KIND_LABEL: Record<string, string> = {
  top_issues: "Top issues", missed_steps: "Missed steps", repeated_requests: "Repeated requests",
  shift_points: "Temperature shifts", handover_issues: "Handover issues",
};
const DIM_LABEL: Record<string, string> = { troubleshooting: "Troubleshooting", temperature: "Customer temperature", communication: "Communication" };

export default function CaseDetailPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useAsync(() => api.case(id ?? ""), [id]);
  const { runs, isManager, profile } = useRun();
  const run = runs.find((r) => r.id === data?.run_id) ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState(0);


  const select = useCallback((ref: string) => {
    setSelected(ref);
    setFlashKey((k) => k + 1);
    requestAnimationFrame(() => document.getElementById(`msg-${ref}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }, []);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const a = data.audit;

  return (
    <div className="space-y-5">
      <Header c={data} />
      {data.state === "REDACTION_FAILED" ? (
        <Panel title="Blocked by the leak scanner">
          <p className="text-sm text-muted">
            Redaction could not be verified for this case, so it was blocked (fail closed). No text was stored, displayed or
            sent to the LLM. Only metadata is shown. Review the redaction configuration and re-run.
          </p>
        </Panel>
      ) : (
        <>
          <Panel title="Communication timeline" action={<span className="text-xs text-muted">click a marker to open the redacted message</span>}>
            <div className="overflow-x-auto">
              <Timeline items={data.items} openedAt={data.opened_at} closedAt={data.closed_at} asOf={run?.as_of ?? null}
                        audit={a} selected={selected} onSelect={select} />
            </div>
          </Panel>
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)] gap-5 items-start">
            <div className="space-y-5 min-w-0">
              {a && <ScorePanel a={a} />}
              {a && <ChecksPanel a={a} onSelect={select} />}
              {a && <LlmPanel a={a} onSelect={select} />}
            </div>
            <div className="space-y-5 xl:sticky xl:top-20">
              <Thread c={data} selected={selected} flashKey={flashKey} />
            </div>
          </div>
        </>
      )}
      {a && (isManager ? <ReviewerPanel a={a} reviewer={profile.display_name} onDone={reload} /> : <ReviewTrail a={a} />)}
    </div>
  );
}

// ------------------------------------------------------------------ header
function Header({ c }: { c: CaseDetail }) {
  const a = c.audit;
  return (
    <div className="panel p-5" style={{ boxShadow: `inset 3px 0 0 var(--color-line)` }}>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <Link to="/cases" className="text-xs text-muted hover:text-text">← Cases</Link>
          <div className="flex flex-wrap items-center gap-2.5 mt-1">
            <h1 className="mono text-2xl font-semibold tracking-tight">{c.case_number}</h1>
            <SeverityPill sev={c.severity} />
            <Pill color={C.muted}>{c.status || "—"}</Pill>
            {c.state !== "OK" && <OutcomePill value={c.state} />}
            {c.review && <Pill color={outcomeColor(c.review.action)}>{ACTION_LABEL[c.review.action]} by {c.review.reviewer_name}</Pill>}
          </div>
          <p className="mt-2 text-[15px] max-w-3xl">{c.subject || <span className="text-muted">No subject</span>}</p>
          <dl className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-6 gap-y-2 text-sm">
            <Meta k="Engineer"><span className="mono text-xs">{c.owner || "—"}</span></Meta>
            <Meta k="Account"><span className="mono text-xs">{c.account || "—"}</span></Meta>
            <Meta k="Product">{c.product || "—"}</Meta>
            <Meta k="Opened">{fmtDate(c.opened_at)}</Meta>
            <Meta k="Closed">{fmtDate(c.closed_at)}</Meta>
          </dl>
          {c.missing_fields.length > 0 && (
            <div className="mt-3 text-xs text-warning">Missing fields: {c.missing_fields.map(humanize).join(", ")}</div>
          )}
        </div>
        {a && (
          <div className="flex items-start gap-6">
            <div>
              <div className="panel-title mb-1">Overall</div>
              <ScoreBadge score={a.overall} size="lg" />
              {c.review?.score_override != null && (
                <div className="text-xs text-warning mt-1">Reviewer override: <span className="mono">{c.review.score_override.toFixed(1)}</span></div>
              )}
            </div>
            <div>
              <div className="panel-title mb-1.5">Confidence</div>
              <OutcomePill value={a.confidence_level} />
              <div className="mono text-xs text-muted mt-1">{a.confidence_score?.toFixed(2)}</div>
            </div>
            <div className="max-w-[220px]">
              <div className="panel-title mb-1.5">Review routing</div>
              {a.review_reasons.length ? (
                <div className="flex flex-wrap gap-1">{[...new Set(a.review_reasons.map((r) => r.code))].map((r) => <ReasonPill key={r} code={r} />)}</div>
              ) : <span className="text-xs text-muted">Not routed</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const Meta = ({ k, children }: { k: string; children: ReactNode }) => (
  <div><dt className="text-[11px] text-muted">{k}</dt><dd className="mt-0.5">{children}</dd></div>
);

// ------------------------------------------------------------------ score breakdown
function ScorePanel({ a }: { a: Audit }) {
  const scored = a.dimensions.filter((d) => d.status === "SCORED");
  return (
    <Panel title="Score breakdown" action={<span className="text-xs text-muted">weighted average of scored dimensions · excluded weights renormalized</span>}>
      <div className="flex h-3 rounded-full overflow-hidden bg-elevated" aria-hidden>
        {scored.map((d) => (
          <div key={d.dimension} title={`${d.label}: ${fmtScore(d.score)} × ${(d.effective_weight * 100).toFixed(0)}%`}
               style={{ width: `${d.effective_weight * 100}%`, background: scoreColor(d.score),
                        opacity: 0.35 + ((d.score ?? 0) / 10) * 0.65 }} className="border-r border-bg last:border-0" />
        ))}
      </div>
      <table className="w-full text-sm mt-3">
        <thead className="text-xs text-muted text-left">
          <tr className="border-b border-line">
            <th className="py-2 font-medium">Dimension</th><th className="font-medium">Input</th>
            <th className="font-medium text-right">Score /10</th><th className="font-medium text-right">Weight</th>
            <th className="font-medium text-right">Effective</th><th className="font-medium text-right">Contribution</th>
          </tr>
        </thead>
        <tbody>
          {a.dimensions.map((d) => (
            <tr key={d.dimension} className={`border-b border-line/50 last:border-0 ${d.status === "EXCLUDED" ? "text-muted" : ""}`}>
              <td className="py-2">{d.label}</td>
              <td>{d.input.includes("/5") ? <span className="mono text-xs">{d.input}</span> : <OutcomePill value={d.input} />}</td>
              <td className="text-right mono" style={{ color: d.status === "SCORED" ? scoreColor(d.score) : undefined }}>{d.status === "SCORED" ? fmtScore(d.score) : "excluded"}</td>
              <td className="text-right mono">{d.weight}</td>
              <td className="text-right mono">{d.status === "SCORED" ? `${(d.effective_weight * 100).toFixed(0)}%` : "—"}</td>
              <td className="text-right mono">{d.status === "SCORED" ? ((d.score ?? 0) * d.effective_weight).toFixed(2) : "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line">
            <td className="py-2 font-medium" colSpan={5}>Overall</td>
            <td className="text-right mono font-semibold" style={{ color: scoreColor(a.overall) }}>{a.overall == null ? "—" : a.overall.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
      {a.state === "EVAL_FAILED" && <p className="text-xs text-danger mt-2">LLM evaluation failed ({a.error_kind}); no overall score is produced. Deterministic checks remain valid.</p>}
      <div className="mt-4 pt-3 border-t border-line">
        <div className="panel-title mb-2">Confidence reasons</div>
        {a.confidence_reasons.length === 0 ? <p className="text-xs text-muted">No penalties applied.</p> : (
          <ul className="text-sm space-y-1">
            {a.confidence_reasons.map((r, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span><span className="mono text-xs text-warning mr-2">{r.code}</span>{r.detail}</span>
                <span className="mono text-xs text-muted">−{r.penalty.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted mt-2">
          Computed, not self-reported · provider <span className="mono">{a.provider}</span> · model <span className="mono">{a.model}</span> ·
          temperature <span className="mono">{a.temperature == null ? "model default" : a.temperature}</span>
        </p>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ deterministic checks
function Ref({ id, onSelect }: { id: string | null | undefined; onSelect: (r: string) => void }) {
  if (!id || id === "NOW") return <span className="mono text-xs text-muted">{id ?? "—"}</span>;
  return (
    <button onClick={() => onSelect(id)} className="mono text-xs rounded px-1.5 py-0.5 bg-elevated border border-line hover:border-info text-info">
      {id}
    </button>
  );
}

function ChecksPanel({ a, onSelect }: { a: Audit; onSelect: (r: string) => void }) {
  const s = a.slo, idle = a.idle, ts = a.three_strike;
  return (
    <Panel title="Deterministic checks">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-line p-3">
          <div className="flex items-center justify-between"><span className="text-sm font-medium">SLO initial response</span><OutcomePill value={s?.status} /></div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="mono text-2xl" style={{ color: outcomeColor(s?.status) }}>{fmtDuration(s?.actual_minutes)}</span>
            <span className="text-sm text-muted">vs target {fmtDuration(s?.target_minutes)}</span>
          </div>
          <div className="text-xs text-muted mt-1">Clock {s?.clock ?? "—"} · first response <Ref id={s?.response_ref} onSelect={onSelect} /></div>
          <p className="text-xs text-muted mt-2">{s?.reason}</p>
        </div>
        <div className="rounded-lg border border-line p-3">
          <div className="flex items-center justify-between"><span className="text-sm font-medium">Idle (&gt; {idle?.threshold_days}d)</span><OutcomePill value={idle?.status} /></div>
          {idle?.windows.length ? (
            <ul className="mt-3 space-y-2">
              {idle.windows.map((w, i) => (
                <li key={i} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <Pill color={w.side === "SUPPORT_SIDE" ? C.danger : C.warning}>{w.side === "SUPPORT_SIDE" ? "Support" : "Customer"}</Pill>
                    <span className="mono">{fmtDuration(w.duration_hours * 60)}</span>
                    <Ref id={w.start_ref} onSelect={onSelect} /> → <Ref id={w.end_ref} onSelect={onSelect} />
                  </div>
                  <div className="text-muted mt-0.5">{fmtDate(w.start)} → {w.end_ref === "NOW" ? "now" : fmtDate(w.end)} · {w.reason}</div>
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-muted mt-3">No gaps above the threshold.</p>}
        </div>
        <div className="rounded-lg border border-line p-3">
          <div className="flex items-center justify-between"><span className="text-sm font-medium">3-strike rule</span><OutcomePill value={ts?.status} /></div>
          <div className="text-xs text-muted mt-3">
            Closure reason: <span className="text-text">{humanize(ts?.closure_reason ?? a.closure?.reason ?? null)}</span>
            {a.closure?.evidence_refs?.length ? <> · {a.closure.evidence_refs.map((r) => <Ref key={r} id={r} onSelect={onSelect} />)}</> : null}
          </div>
          {ts?.last_customer_ref && <div className="text-xs text-muted mt-1">Last customer reply <Ref id={ts.last_customer_ref} onSelect={onSelect} /></div>}
          {ts && ts.attempts.length > 0 && (
            <ol className="mt-2 space-y-1 text-xs">
              {ts.attempts.map((x, i) => (
                <li key={x.ref_id} className="flex items-center gap-2">
                  <span className="h-4 w-4 rounded-full bg-accent text-white text-[10px] grid place-items-center font-bold">{i + 1}</span>
                  <Ref id={x.ref_id} onSelect={onSelect} /><span className="text-muted">{x.kind} · {fmtDate(x.at)}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="text-xs text-muted mt-2">{ts?.reason}</p>
        </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ LLM findings
function EvidenceChips({ ev, onSelect }: { ev: Evidence[]; onSelect: (r: string) => void }) {
  return (
    <span className="inline-flex flex-wrap gap-1 ml-1 align-middle">
      {ev.map((e, i) => (
        <button key={i} onClick={() => onSelect(e.ref_id)} title={e.timestamp ? fmtDate(e.timestamp) : "no timestamp"}
                className="mono text-[11px] rounded px-1.5 py-0.5 bg-elevated border border-line hover:border-info text-info">
          {e.ref_id}{e.timestamp ? ` · ${new Date(e.timestamp).toISOString().slice(5, 16).replace("T", " ")}` : ""}
        </button>
      ))}
    </span>
  );
}

function LlmPanel({ a, onSelect }: { a: Audit; onSelect: (r: string) => void }) {
  const byDim: Record<string, Finding[]> = {};
  a.findings.forEach((f) => { (byDim[f.dimension] ??= []).push(f); });
  return (
    <Panel title="LLM evaluations" action={<span className="text-xs text-muted">{a.unsupported_count} unsupported finding(s) dropped · {a.retry_count} retry(ies)</span>}>
      <div className="space-y-4">
        {(["troubleshooting", "communication", "temperature"] as const).map((dim) => {
          const d = a.llm[dim];
          if (!d) return null;
          const groups: Record<string, Finding[]> = {};
          (byDim[dim] ?? []).forEach((f) => { (groups[f.kind] ??= []).push(f); });
          return (
            <div key={dim} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{DIM_LABEL[dim]}</span>
                {d.status === "OK" ? (
                  <span className="mono text-sm" style={{ color: dim === "temperature" ? ((d.score ?? 0) >= 4 ? C.danger : (d.score ?? 0) >= 3 ? C.warning : C.success) : scoreColor(((d.score ?? 1) - 1) * 2.5) }}>
                    {d.score}/5
                  </span>
                ) : <OutcomePill value={d.status} />}
                {d.trajectory && <Pill color={d.trajectory === "worsening" ? C.danger : d.trajectory === "improving" ? C.success : C.muted}>{d.trajectory}</Pill>}
                <span className="text-[11px] text-muted ml-auto">runs: <span className="mono">{d.run_scores?.map((x) => x ?? "–").join(" / ")}</span>
                  {d.disagreement && <span className="text-warning ml-1">disagree</span>}</span>
              </div>
              {d.summary && <p className="text-sm text-muted mt-2">{d.summary}</p>}
              {Object.entries(groups).map(([kind, fs]) => (
                <div key={kind} className="mt-2.5">
                  <div className="text-[11px] uppercase tracking-wider text-muted mb-1">{KIND_LABEL[kind] ?? kind}</div>
                  <ul className="space-y-1.5">
                    {fs.map((f) => <li key={f.id} className="text-sm">{f.text}<EvidenceChips ev={f.evidence} onSelect={onSelect} /></li>)}
                  </ul>
                </div>
              ))}
              {d.coaching_action && (
                <div className="mt-3 text-sm rounded-md bg-elevated px-3 py-2"><span className="text-[11px] uppercase tracking-wider text-muted mr-2">Coaching</span>{d.coaching_action}</div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ redacted thread
function Thread({ c, selected, flashKey }: { c: CaseDetail; selected: string | null; flashKey: number }) {
  const entries: { ref: string; title: string; when: string | null; body: string; tone: string; item?: Item }[] = [
    { ref: "DESC", title: "Case description", when: c.opened_at, body: c.description, tone: C.info },
    ...c.items.map((it) => ({
      ref: it.ref_id,
      title: `${humanize(it.type)}${it.direction ? ` · ${it.direction}` : ""}${it.is_auto_ack ? " · auto-ack" : ""}${it.internal ? " · internal" : ""}`,
      when: it.occurred_at, body: [it.subject, it.body].filter(Boolean).join("\n\n"),
      tone: it.internal || !["email", "call"].includes(it.type) ? C.muted : it.direction === "inbound" ? C.info : it.is_auto_ack ? C.muted : C.success,
      item: it,
    })),
    ...(c.resolution ? [{ ref: "RES", title: "Resolution", when: c.closed_at, body: c.resolution, tone: C.muted }] : []),
  ];
  const ordered = [entries[0], ...entries.slice(1).sort((x, y) => (x.when ? +new Date(x.when) : Infinity) - (y.when ? +new Date(y.when) : Infinity))];
  return (
    <Panel title={`Redacted thread · ${c.items.length} items`}>
      <div className="max-h-[78vh] overflow-y-auto pr-1 -mr-1 space-y-2">
        {ordered.map((e) => (
          <article id={`msg-${e.ref}`} key={e.ref + (selected === e.ref ? flashKey : "")}
                   className={`rounded-lg border p-3 scroll-mt-24 ${selected === e.ref ? "border-info flash" : "border-line"}`}
                   style={{ boxShadow: `inset 3px 0 0 ${e.tone}` }}>
            <header className="flex items-center gap-2 text-xs text-muted">
              <span className="mono text-text">{e.ref}</span><span>{e.title}</span>
              <span className="ml-auto">{e.when ? fmtDate(e.when) : <span className="text-warning">no timestamp</span>}</span>
            </header>
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed">{e.body || <span className="text-muted">(empty)</span>}</pre>
          </article>
        ))}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ reviewer
function ReviewerPanel({ a, reviewer, onDone }: { a: Audit; reviewer: string; onDone: () => void }) {
  const [action, setAction] = useState<"approve" | "override" | "comment">("approve");
  const [score, setScore] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.review(a.id, { action, comment,
        score_override: action === "override" ? Number(score) : undefined });
      setComment(""); setScore("");
      onDone();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  return (
    <Panel title="Reviewer" action={<span className="text-xs text-muted">actions are appended to the audit trail; the machine result is never modified</span>}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form ref={formRef} onSubmit={submit} className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <div className="text-sm flex flex-col gap-1">Reviewer
              <span className="py-1.5 text-muted">{reviewer}</span>
            </div>
            <fieldset className="text-sm flex flex-col gap-1">
              <legend className="mb-1">Action</legend>
              <div className="flex rounded-md border border-line overflow-hidden">
                {(["approve", "override", "comment"] as const).map((x) => (
                  <button type="button" key={x} onClick={() => setAction(x)} aria-pressed={action === x}
                          className={`px-3 py-1.5 text-sm ${action === x ? "bg-elevated text-text" : "text-muted hover:text-text"}`}>
                    {humanize(x)}
                  </button>
                ))}
              </div>
            </fieldset>
            {action === "override" && (
              <label className="text-sm flex flex-col gap-1">Score override /10
                <input required type="number" min={0} max={10} step={0.1} value={score} onChange={(e) => setScore(e.target.value)} className="w-28 mono" />
              </label>
            )}
          </div>
          <label className="text-sm flex flex-col gap-1">Comment {action === "comment" && <span className="text-muted text-xs">(required)</span>}
            <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} required={action === "comment"}
                      placeholder="Do not paste unredacted customer data here." />
          </label>
          <div className="flex items-center gap-3">
            <button className="btn-primary" disabled={busy}>{busy ? "Saving…" : `Record ${action}`}</button>
            <span className="text-xs text-muted">Machine overall: <span className="mono">{fmtScore(a.overall)}</span></span>
          </div>
          <ErrorNote error={err} />
        </form>
        <div>
          <div className="panel-title mb-2">Audit trail</div>
          {a.review_actions.length === 0 ? <Empty>No reviewer actions yet.</Empty> : (
            <ol className="relative border-l border-line ml-2 space-y-3">
              {a.review_actions.map((r) => (
                <li key={r.id} className="ml-4">
                  <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full" style={{ background: outcomeColor(r.action) }} />
                  <div className="text-sm"><span className="font-medium">{ACTION_LABEL[r.action]}</span> by {r.reviewer_name}
                    {r.score_override != null && <span className="mono text-warning"> → {r.score_override.toFixed(1)}</span>}</div>
                  <div className="text-xs text-muted">{fmtDate(r.created_at)}</div>
                  {r.comment && <p className="text-sm mt-1 text-muted whitespace-pre-wrap">{r.comment}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ReviewTrail({ a }: { a: Audit }) {
  return (
    <Panel title="Manager review" action={<span className="text-xs text-muted">read-only</span>}>
      {a.review_actions.length === 0 ? <Empty>No manager review yet.</Empty> : (
        <ol className="relative border-l border-line ml-2 space-y-3">
          {a.review_actions.map((r) => (
            <li key={r.id} className="ml-4">
              <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full" style={{ background: outcomeColor(r.action) }} />
              <div className="text-sm"><span className="font-medium">{ACTION_LABEL[r.action]}</span> by {r.reviewer_name}
                {r.score_override != null && <span className="mono text-warning"> → {r.score_override.toFixed(1)}</span>}</div>
              <div className="text-xs text-muted">{fmtDate(r.created_at)}</div>
              {r.comment && <p className="text-sm mt-1 text-muted whitespace-pre-wrap">{r.comment}</p>}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
