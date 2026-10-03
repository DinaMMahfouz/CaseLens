import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { Profile, Run, Tse } from "../api";
import type { Selection } from "./scope";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => { if (id === seq.current) { setData(d); setError(null); } })
      .catch((e) => { if (id === seq.current) setError(e); })
      .finally(() => { if (id === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload };
}

export interface AppCtx {
  profile: Profile;
  isManager: boolean;
  runs: Run[];
  runsLoading: boolean;
  runsError: unknown;
  reloadRuns: () => void;
  /** Current / Compare-to selection, kept in the URL (?cur=&cmp=). */
  sel: Selection;
  setSel: (sel: Selection) => void;
  /** Selected TSE id (managers, ?tse=). For TSE users RLS already limits rows; this stays undefined. */
  tse: string | undefined;
  setTse: (id: string | undefined) => void;
  tses: Tse[];
  /** Display name of the selected TSE (never the id). */
  tseName: string | undefined;
  /** Runs the current selection draws on (one run, or the normal runs behind a period). */
  scopeRuns: Run[];
}

export const AppContext = createContext<AppCtx | null>(null);
export const useRun = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppContext missing");
  return ctx;
};

const SCOPE_PARAMS = ["cur", "cmp", "tse"];
/** Build an in-app link that keeps the selection (cur/cmp/tse) and adds page filters. */
export function scopedHref(search: string, path: string, extra: Record<string, string> = {}) {
  const cur = new URLSearchParams(search);
  const next = new URLSearchParams();
  SCOPE_PARAMS.forEach((k) => { const v = cur.get(k); if (v) next.set(k, v); });
  Object.entries(extra).forEach(([k, v]) => next.set(k, v));
  const q = next.toString();
  return q ? `${path}?${q}` : path;
}
export function useScopedHref() {
  const { search } = useLocation();
  return useCallback((path: string, extra?: Record<string, string>) => scopedHref(search, path, extra), [search]);
}
