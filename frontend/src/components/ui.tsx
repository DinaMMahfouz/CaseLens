import { DataError } from "../api";
import type { ReactNode } from "react";
import { C, REASON_META, humanize, outcomeColor, scoreColor, severityColor } from "../lib/format";

export function Pill({ color, children, title, solid = false }: { color: string; children: ReactNode; title?: string; solid?: boolean }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap"
      style={{
        color: solid ? "#fff" : color,
        background: solid ? color : `color-mix(in oklab, ${color} 14%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 35%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

export const SeverityPill = ({ sev }: { sev: number | null }) => (
  <Pill color={severityColor(sev)}>
    <span className="mono">{sev ? `SEV${sev}` : "SEV?"}</span>
  </Pill>
);

export const OutcomePill = ({ value, title }: { value: string | null | undefined; title?: string }) => (
  <Pill color={outcomeColor(value)} title={title}>{humanize(value)}</Pill>
);

export const ReasonPill = ({ code }: { code: string }) => {
  const m = REASON_META[code] ?? { label: humanize(code), color: C.muted, hint: "" };
  return <Pill color={m.color} title={m.hint}>{m.label}</Pill>;
};

export function ScoreBadge({ score, size = "md" }: { score: number | null | undefined; size?: "md" | "lg" }) {
  const color = scoreColor(score);
  if (size === "lg") {
    return (
      <div className="flex items-baseline gap-1">
        <span className="mono text-5xl font-semibold tracking-tight" style={{ color }}>{score == null ? "—" : score.toFixed(1)}</span>
        <span className="text-muted text-lg">/10</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 min-w-[92px]">
      <span className="mono text-sm font-semibold w-8 text-right" style={{ color }}>{score == null ? "—" : score.toFixed(1)}</span>
      <div className="h-1.5 w-12 rounded-full bg-elevated overflow-hidden" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${((score ?? 0) / 10) * 100}%`, background: color }} />
      </div>
    </div>
  );
}

export function Panel({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-4 ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between mb-3 gap-3">
          {title && <h2 className="panel-title">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-sm text-muted py-8 text-center">{children}</div>;
}

/** Only DataError messages (written by us) are shown; anything else becomes a generic message,
 *  so raw database/driver errors never reach the screen. */
export function safeMessage(error: unknown): string {
  return error instanceof DataError ? error.message : "Something went wrong. Please try again.";
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="panel border-danger/40 p-3 text-sm text-danger" role="alert">{safeMessage(error)}</div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="panel p-8 text-center max-w-lg mx-auto mt-10" role="alert">
      <p className="text-sm">{safeMessage(error)}</p>
      <button className="btn-ghost mt-4" onClick={onRetry}>Retry</button>
    </div>
  );
}

export function Loading() {
  return <div className="text-sm text-muted py-10 text-center animate-pulse">Loading…</div>;
}
