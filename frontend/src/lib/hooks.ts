import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Profile, Run, Tse } from "../api";

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
  runId: string | undefined;
  setRunId: (id: string | undefined) => void;
  /** Selected TSE id (managers). For TSE users RLS already limits rows; this stays undefined. */
  tse: string | undefined;
  setTse: (id: string | undefined) => void;
  tses: Tse[];
  /** Display name of the selected TSE (never the id). */
  tseName: string | undefined;
  /** The run in view: the selected one, or the latest. */
  currentRun: Run | null;
  runsLoading: boolean;
  runsError: unknown;
  reloadRuns: () => void;
}

export const AppContext = createContext<AppCtx | null>(null);
export const useRun = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppContext missing");
  return ctx;
};
