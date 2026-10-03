// Client-side Excel export (Summary, Cases, Findings, Review Actions). Redacted data only.
import { api } from "../api";
import { temperatureLabel } from "./format";
import { AUDIT_STATE, DIMENSION, FINDING_KIND, REASONS, REVIEW_ACTION, TRAJECTORY, checkLabel, lookup } from "./labels";

const reasonLabels = (rs: { code: string }[] | undefined) =>
  [...new Set((rs ?? []).map((r) => REASONS[r.code]?.label ?? "Other reason"))].sort().join(", ");

const DIMS = ["troubleshooting", "communication", "slo", "idle", "three_strike", "temperature_handling"];

export async function downloadExport(runId?: string, tse?: string, tseName?: string) {
  const [{ default: ExcelJS }, { run, cases }] = await Promise.all([import("exceljs"), api.exportRows(runId, tse)]);
  const wb = new ExcelJS.Workbook();
  wb.creator = "CaseLens";
  const sheet = (name: string, header: string[], rows: unknown[][]) => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(header).eachCell((c) => {
      c.font = { bold: true, color: { argb: "FFF2F2F4" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E1E24" } };
    });
    rows.forEach((r) => ws.addRow(r));
    ws.columns.forEach((col, i) => {
      const w = Math.max(header[i].length, ...rows.slice(0, 200).map((r) => String(r[i] ?? "").length));
      col.width = Math.min(60, Math.max(10, w + 2));
    });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const audit = (c: any) => (Array.isArray(c.audits) ? c.audits[0] : c.audits) ?? null;
  const audits = cases.map(audit).filter(Boolean);
  const scored = audits.map((a) => a.overall).filter((x: number | null) => x != null) as number[];
  const reasons: Record<string, number> = {};
  audits.forEach((a) => new Set<string>((a.review_reasons ?? []).map((r: { code: string }) => r.code)).forEach((k) => { reasons[k] = (reasons[k] ?? 0) + 1; }));

  sheet("Summary", ["Metric", "Value"], [
    ["Run as of (UTC)", run.as_of], ["Pushed (UTC)", run.created_at], ["Source", run.source === "fixtures" ? "Synthetic fixtures" : "Uploaded export"], ["Synthetic data", run.synthetic ? "Yes" : "No"],
    ["TSE filter", tseName ?? "All TSEs"], ["Provider", run.provider], ["Model", run.model],
    ["Temperature", run.temperature ?? "model default"], ["Config hash", run.config_hash],
    ["Prompt versions", Object.entries(run.prompt_versions ?? {}).map(([k, v]) => `${k}=${v}`).join(", ")],
    ["Cases", cases.length],
    ["Average overall /10", scored.length ? Math.round((scored.reduce((s, x) => s + x, 0) / scored.length) * 100) / 100 : null],
    ["In review queue", audits.filter((a) => a.needs_review).length],
    ...Object.entries(reasons).sort().map(([k, v]) => [`Review reason: ${REASONS[k]?.label ?? "Other reason"}`, v]),
  ]);

  sheet("Cases", ["Case", "Severity", "Status", "Audit state", "TSE", "Account", "Opened (UTC)", "Closed (UTC)", "Overall /10",
    "Troubleshooting /10", "Communication /10", "SLO /10", "Idle /10", "3-strike /10", "Temperature handling /10",
    "SLO result", "SLO actual min", "SLO target min", "Idle result", "Support idle hours", "3-strike result", "3-strike reason",
    "Customer temperature (end)", "Trajectory", "Data completeness", "Run agreement", "Scored dimensions", "Review reasons", "Model"],
  cases.map((c) => {
    const a = audit(c);
    const d = Object.fromEntries((a?.dimensions ?? []).map((x: { dimension: string }) => [x.dimension, x]));
    return [c.case_number, c.severity, c.status, lookup(AUDIT_STATE, c.state), (Array.isArray(c.tses) ? c.tses[0] : c.tses)?.display_name ?? "", c.account_label, c.opened_at, c.closed_at, a?.overall ?? null,
      ...DIMS.map((k) => (d[k] && d[k].status === "SCORED" ? d[k].score : "excluded")),
      checkLabel(a?.slo?.status), a?.slo?.actual_minutes, a?.slo?.target_minutes, checkLabel(a?.idle?.status), a?.idle?.support_idle_hours,
      checkLabel(a?.three_strike?.status), a?.three_strike?.reason, temperatureLabel(a?.temp_end), lookup(TRAJECTORY, a?.trajectory), a?.data_completeness, a?.run_agreement,
      a ? `${a.scored_dimensions} of ${a.applicable_dimensions}` : null,
      reasonLabels(a?.review_reasons), a?.model];
  }));

  const findingRows: unknown[][] = [];
  cases.forEach((c) => {
    const a = audit(c);
    const items = Object.fromEntries((c.items ?? []).map((i: { ref_id: string; body: string }) => [i.ref_id, i.body]));
    (a?.findings ?? []).forEach((f: { dimension: string; kind: string; text: string; evidence: { ref_id: string; timestamp: string | null }[] }) => {
      (f.evidence.length ? f.evidence : [{ ref_id: "", timestamp: null }]).forEach((ev) => {
        const excerpt = ev.ref_id === "RES" ? c.resolution : ev.ref_id === "DESC" ? c.description : items[ev.ref_id] ?? "";
        findingRows.push([c.case_number, lookup(DIMENSION, f.dimension), lookup(FINDING_KIND, f.kind), f.text, ev.ref_id, ev.timestamp, String(excerpt ?? "").slice(0, 300)]);
      });
    });
  });
  sheet("Findings", ["Case", "Dimension", "Kind", "Finding", "Evidence ref", "Evidence timestamp", "Evidence excerpt (redacted)"], findingRows);

  const reviewRows: unknown[][] = [];
  cases.forEach((c) => {
    const a = audit(c);
    [...(a?.review_actions ?? [])].sort((x: { created_at: string }, y: { created_at: string }) => x.created_at.localeCompare(y.created_at))
      .forEach((x: { action: string; score_override: number | null; reviewer_name: string; created_at: string; comment: string }) =>
        reviewRows.push([c.case_number, a.overall, lookup(REVIEW_ACTION, x.action), x.score_override, x.reviewer_name, x.created_at, x.comment]));
  });
  sheet("Review Actions", ["Case", "Machine overall /10", "Action", "Score override", "Reviewer", "At (UTC)", "Comment"], reviewRows);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `caselens-${(run.as_of ?? run.created_at).slice(0, 10)}${tse ? `-${tse.replace(/\s+/g, "_")}` : ""}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
