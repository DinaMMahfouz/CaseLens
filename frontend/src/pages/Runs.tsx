import { Empty, Panel, Pill } from "../components/ui";
import { useRun } from "../lib/hooks";
import { C, fmtDate } from "../lib/format";

export default function Runs() {
  const { runs } = useRun();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
        <p className="text-sm text-muted mt-0.5">Audit runs pushed from the local worker. Raw exports never leave the worker machine; only redacted results appear here.</p>
      </div>
      <Panel title="How to add a run">
        <ol className="text-sm space-y-1.5 list-decimal list-inside text-muted">
          <li>Put the Excel export on the worker machine (for example in <span className="mono text-text">data/</span>, which git ignores).</li>
          <li>Run <span className="mono text-text">python -m scripts.caselens audit --file data/export.xlsx --push</span> from <span className="mono text-text">backend/</span>.</li>
          <li>The worker redacts, leak-checks, evaluates, and pushes the redacted audit here. Refresh this page.</li>
        </ol>
      </Panel>
      <Panel title="Pushed runs">
        {runs.length === 0 ? <Empty>No runs pushed yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted text-left">
                <tr className="border-b border-line">
                  <th className="py-2 font-medium">Pushed</th><th className="font-medium">As of</th><th className="font-medium">Source</th>
                  <th className="font-medium text-right">Cases</th><th className="font-medium text-right">Failed</th>
                  <th className="font-medium pl-4">Provider / model</th><th className="font-medium">Config</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-line/60 last:border-0">
                    <td className="py-2.5">{fmtDate(r.created_at)}</td>
                    <td className="text-muted">{fmtDate(r.as_of)}</td>
                    <td>{r.source} {r.synthetic && <Pill color={C.muted}>synthetic</Pill>}</td>
                    <td className="text-right mono">{r.total}</td>
                    <td className="text-right mono" style={{ color: r.failed ? C.warning : undefined }}>{r.failed}</td>
                    <td className="pl-4 mono text-xs">{r.provider} · {r.model}</td>
                    <td className="mono text-xs text-muted" title={Object.entries(r.prompt_versions).map(([k, v]) => `${k}: ${v}`).join("\n")}>{r.config_hash}</td>
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
