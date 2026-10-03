import { useState } from "react";
import { Empty, ErrorNote, ErrorState, Loading, Panel, Time } from "../components/ui";
import { useRun } from "../lib/hooks";
import { selectionLabel } from "../components/Comparison";
import { downloadExport } from "../lib/exportXlsx";

const SHEETS = [
  ["Summary", "Run metadata (model, prompt versions, config hash), averages and review-reason counts."],
  ["Cases", "One row per case: overall and every dimension score, SLO/idle/3-strike outcomes, data completeness and review reasons."],
  ["Findings", "Every LLM finding with its evidence reference, timestamp and a redacted excerpt of the cited message."],
  ["Review Actions", "The reviewer audit trail: approvals, overrides (beside the machine score) and comments."],
];

export default function ExportPage() {
  const { sel, runs, scopeRuns, tse, tseName, runsLoading, runsError, reloadRuns } = useRun();
  const run = scopeRuns[0];
  const label = selectionLabel(sel, runs);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await downloadExport(sel, runs, label, tse, tseName); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Export</h1>
        <p className="text-sm text-muted mt-0.5">Excel workbook of the selected run{tse ? ` for ${tseName}` : ""}. Contains redacted data only and is built in your browser.</p>
      </div>
      {runsError ? <ErrorState error={runsError} onRetry={reloadRuns} /> : runsLoading ? <Loading variant="table" /> : !run ? <div className="panel"><Empty>No runs to export.</Empty></div> : (
        <Panel title={<>Run as of <Time iso={run.as_of} />{tse ? ` · ${tseName}` : " · all TSEs"}</>}>
          <ul className="space-y-3 mb-5">
            {SHEETS.map(([name, desc]) => (
              <li key={name} className="flex gap-3"><span className="mono text-sm w-32 shrink-0">{name}</span><span className="text-sm text-muted">{desc}</span></li>
            ))}
          </ul>
          <button className="btn-primary" onClick={go} disabled={busy}>{busy ? "Building…" : "Download .xlsx"}</button>
          <span className="text-xs text-muted ml-3">Use the TSE and Run selectors in the top bar to change scope.</span>
          <div className="mt-3"><ErrorNote error={err} /></div>
        </Panel>
      )}
    </div>
  );
}
