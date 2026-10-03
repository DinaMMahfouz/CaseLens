import { useEffect, useMemo, useRef, useState } from "react";
import type { Audit, Item } from "../api";
import { C, fmtDate, fmtDuration } from "../lib/format";
import { ITEM_TYPE } from "../lib/labels";

interface Props {
  items: Item[];
  openedAt: string | null;
  closedAt: string | null;
  asOf: string | null;
  audit: Audit | null;
  selected: string | null;
  onSelect: (ref: string) => void;
}

const LANES = [
  { key: "customer", label: "Customer" },
  { key: "support", label: "Support" },
  { key: "internal", label: "Internal notes" },
] as const;
type Lane = (typeof LANES)[number]["key"];

const LANE_H = 54;
const TOP = 34;
const LEFT = 112;
const RIGHT = 24;

function laneOf(it: Item): Lane {
  if (it.internal || !["email", "call"].includes(it.type)) return "internal";
  return it.direction === "inbound" ? "customer" : "support";
}

export default function Timeline({ items, openedAt, closedAt, asOf, audit, selected, onSelect }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(560, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const timed = items.filter((i) => i.occurred_at);
  const untimed = items.filter((i) => !i.occurred_at);
  const windows = audit?.idle?.windows ?? [];
  const slo = audit?.slo;
  const attempts = new Map((audit?.three_strike?.attempts ?? []).map((a, i) => [a.ref_id, i + 1]));
  const isOpen = !closedAt;

  const [t0, t1] = useMemo(() => {
    const ts: number[] = timed.map((i) => +new Date(i.occurred_at!));
    if (openedAt) ts.push(+new Date(openedAt));
    if (closedAt) ts.push(+new Date(closedAt));
    windows.forEach((w) => { ts.push(+new Date(w.start), +new Date(w.end)); });
    if (slo?.deadline_at) ts.push(+new Date(slo.deadline_at));
    if (isOpen && asOf) ts.push(+new Date(asOf));
    if (!ts.length) return [0, 1];
    const lo = Math.min(...ts), hi = Math.max(...ts);
    const pad = Math.max((hi - lo) * 0.03, 30 * 60 * 1000);
    return [lo - pad, hi + pad];
  }, [timed, openedAt, closedAt, windows, slo, isOpen, asOf]);

  const x = (iso: string) => LEFT + ((+new Date(iso) - t0) / (t1 - t0)) * (width - LEFT - RIGHT);
  const laneY = (l: Lane) => TOP + LANES.findIndex((x) => x.key === l) * LANE_H + LANE_H / 2;
  const height = TOP + LANES.length * LANE_H + 34;

  const ticks = useMemo(() => {
    const span = t1 - t0;
    const day = 86400000;
    const step = span > 40 * day ? 7 * day : span > 10 * day ? 2 * day : span > 2 * day ? day : span > day / 2 ? 6 * 3600000 : 3600000;
    const out: number[] = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
    return { out, step };
  }, [t0, t1]);
  const tickLabel = (t: number) => {
    const d = new Date(t);
    return ticks.step >= 86400000
      ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
      : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  };

  if (!timed.length && !openedAt) {
    return <div className="text-sm text-muted py-6 text-center">No timestamped activity to draw.</div>;
  }

  return (
    <div ref={wrap} className="w-full">
      <svg width={width} height={height} role="img" aria-label="Case communication timeline" className="block select-none">
        {/* lanes */}
        {LANES.map((l, i) => (
          <g key={l.key}>
            <rect x={LEFT} y={TOP + i * LANE_H} width={width - LEFT - RIGHT} height={LANE_H}
                  fill={i % 2 ? "transparent" : "color-mix(in oklab, var(--color-elevated) 55%, transparent)"} />
            <text x={LEFT - 12} y={TOP + i * LANE_H + LANE_H / 2 + 4} textAnchor="end" fontSize={12} fill={C.muted}>{l.label}</text>
          </g>
        ))}
        {/* ticks */}
        {ticks.out.map((t) => {
          const xx = LEFT + ((t - t0) / (t1 - t0)) * (width - LEFT - RIGHT);
          return (
            <g key={t}>
              <line x1={xx} x2={xx} y1={TOP} y2={TOP + LANES.length * LANE_H} stroke={C.line} strokeDasharray="2 4" />
              <text x={xx} y={height - 12} textAnchor="middle" fontSize={10.5} fill={C.muted}>{tickLabel(t)}</text>
            </g>
          );
        })}
        {/* idle windows */}
        {windows.map((w, i) => {
          const x1 = x(w.start), x2 = x(w.end);
          const col = w.side === "SUPPORT_SIDE" ? C.danger : C.warning;
          return (
            <g key={i}>
              <rect x={x1} y={TOP} width={Math.max(2, x2 - x1)} height={LANE_H * 2}
                    fill={`color-mix(in oklab, ${col} 13%, transparent)`} stroke={col} strokeOpacity={0.55} strokeDasharray="4 3" rx={4} />
              <text x={(x1 + x2) / 2} y={TOP - 8} textAnchor="middle" fontSize={11} fontWeight={600} fill={col}>
                {fmtDuration(w.duration_hours * 60)} idle · {w.side === "SUPPORT_SIDE" ? "support" : "customer"}
              </text>
              <title>{`${w.side === "SUPPORT_SIDE" ? "Support-side" : "Customer-side"} idle ${w.start_ref} → ${w.end_ref}: ${w.reason}`}</title>
            </g>
          );
        })}
        {/* opened / closed / now */}
        {openedAt && <Marker x={x(openedAt)} h={height} label="Opened" color={C.muted} />}
        {closedAt && <Marker x={x(closedAt)} h={height} label="Closed" color={C.muted} />}
        {isOpen && asOf && <Marker x={x(asOf)} h={height} label="Now" color={C.info} />}
        {/* SLO deadline */}
        {slo?.deadline_at && (
          <g>
            <line x1={x(slo.deadline_at)} x2={x(slo.deadline_at)} y1={TOP + LANE_H} y2={TOP + LANE_H * 2}
                  stroke={slo.status === "MET" ? C.success : C.danger} strokeWidth={2} />
            <text x={x(slo.deadline_at) + 4} y={TOP + LANE_H + 11} fontSize={10} fill={slo.status === "MET" ? C.success : C.danger}>
              SLO {fmtDuration(slo.target_minutes)}
            </text>
          </g>
        )}
        {/* case opened as customer event */}
        {openedAt && (
          <g onClick={() => onSelect("DESC")} className="cursor-pointer">
            <rect x={x(openedAt) - 6} y={laneY("customer") - 6} width={12} height={12} rx={2}
                  fill={selected === "DESC" ? C.text : C.surface} stroke={C.info} strokeWidth={2} />
            <title>DESC · case description</title>
          </g>
        )}
        {/* items */}
        {timed.map((it) => {
          const cx = x(it.occurred_at!), cy = laneY(laneOf(it));
          const sel = selected === it.ref_id;
          const lane = laneOf(it);
          const color = lane === "customer" ? C.info : lane === "support" ? (it.is_auto_ack ? C.muted : C.success) : C.muted;
          const n = attempts.get(it.ref_id);
          return (
            <g key={it.ref_id} onClick={() => onSelect(it.ref_id)} className="cursor-pointer" tabIndex={0}
               onKeyDown={(e) => { if (e.key === "Enter") onSelect(it.ref_id); }} role="button" aria-label={`${it.ref_id} ${ITEM_TYPE[it.type] ?? "Message"}`}>
              {sel && <circle cx={cx} cy={cy} r={13} fill="none" stroke={C.text} strokeOpacity={0.7} />}
              {it.type === "call" ? (
                <rect x={cx - 6} y={cy - 6} width={12} height={12} transform={`rotate(45 ${cx} ${cy})`} fill={color} />
              ) : it.type === "email" ? (
                <circle cx={cx} cy={cy} r={6.5} fill={it.is_auto_ack ? "transparent" : color} stroke={color} strokeWidth={2} />
              ) : (
                <rect x={cx - 5.5} y={cy - 5.5} width={11} height={11} rx={2} fill={it.type === "handover" ? C.warning : color} />
              )}
              <text x={cx} y={cy + 20} textAnchor="middle" fontSize={9.5} fill={sel ? C.text : C.muted} className="mono">{it.ref_id}</text>
              {n && (
                <g>
                  <circle cx={cx + 9} cy={cy - 11} r={7} fill={C.accent} />
                  <text x={cx + 9} y={cy - 7.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff">{n}</text>
                </g>
              )}
              <title>{`${it.ref_id} · ${ITEM_TYPE[it.type] ?? "Message"}${it.is_auto_ack ? " (automatic acknowledgement)" : ""} · ${fmtDate(it.occurred_at)}${n ? ` · 3-strike attempt ${n}` : ""}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-[11px] text-muted">
        <Key shape="circle" color={C.info} label="Customer email" />
        <Key shape="circle" color={C.success} label="Support email" />
        <Key shape="ring" color={C.muted} label="Automatic acknowledgement" />
        <Key shape="diamond" color={C.success} label="Logged call" />
        <Key shape="square" color={C.muted} label="Note / summary" />
        <Key shape="square" color={C.warning} label="Handover" />
        <Key shape="badge" color={C.accent} label="3-strike attempt" />
        <Key shape="band" color={C.danger} label="Support-side idle" />
        <Key shape="band" color={C.warning} label="Customer-side idle" />
        {untimed.length > 0 && (
          <span className="ml-auto text-warning">
            Untimed: {untimed.map((u) => (
              <button key={u.ref_id} className="mono underline decoration-dotted ml-1" onClick={() => onSelect(u.ref_id)}>{u.ref_id}</button>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function Marker({ x, h, label, color }: { x: number; h: number; label: string; color: string }) {
  return (
    <g>
      <line x1={x} x2={x} y1={TOP - 4} y2={h - 26} stroke={color} strokeOpacity={0.6} />
      <text x={x} y={TOP - 20} textAnchor="middle" fontSize={10} fill={color}>{label}</text>
    </g>
  );
}

function Key({ shape, color, label }: { shape: "circle" | "ring" | "diamond" | "square" | "badge" | "band"; color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="14" height="12" aria-hidden>
        {shape === "circle" && <circle cx="7" cy="6" r="4.5" fill={color} />}
        {shape === "ring" && <circle cx="7" cy="6" r="4" fill="none" stroke={color} strokeWidth="1.8" />}
        {shape === "diamond" && <rect x="3.5" y="2.5" width="7" height="7" transform="rotate(45 7 6)" fill={color} />}
        {shape === "square" && <rect x="2.5" y="1.5" width="9" height="9" rx="1.5" fill={color} />}
        {shape === "badge" && <circle cx="7" cy="6" r="5" fill={color} />}
        {shape === "band" && <rect x="0.5" y="1.5" width="13" height="9" rx="2" fill={`color-mix(in oklab, ${color} 18%, transparent)`} stroke={color} strokeDasharray="2 2" />}
      </svg>
      {label}
    </span>
  );
}
