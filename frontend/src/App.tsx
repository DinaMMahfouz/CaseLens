import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { api, type Profile, type Run, type Tse } from "./api";
import { AppContext } from "./lib/hooks";
import { configured, initialAuthType, supabase } from "./lib/supabase";
import { ComparisonControl } from "./components/Comparison";
import { dataDate, latestRun, normalRuns } from "./lib/metrics";
import { parseSelection, withSelection, type Selection } from "./lib/scope";
import { Wordmark } from "./components/Mark";
import { Loading, SyntheticBanner } from "./components/ui";
import { Login, NoAccess, NotConfigured, SetPassword } from "./pages/Login";
import Overview from "./pages/Overview";
import Cases from "./pages/Cases";
import CaseDetailPage from "./pages/CaseDetail";
import ReviewQueue from "./pages/ReviewQueue";
import Runs from "./pages/Runs";
import ExportPage from "./pages/Export";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [needsPassword, setNeedsPassword] = useState(initialAuthType === "invite" || initialAuthType === "recovery");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setNeedsPassword(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) { setProfile(session === null ? null : undefined); return; }
    setProfile(undefined);
    api.profile(userId).then(setProfile).catch(() => setProfile(null));
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!configured) return <NotConfigured />;
  if (session === undefined) return <Loading />;
  if (!session) return <Login />;
  if (needsPassword) return <SetPassword onDone={() => { setNeedsPassword(false); window.history.replaceState(null, "", "/"); }} />;
  if (profile === undefined) return <Loading />;
  if (!profile) return <NoAccess email={session.user.email ?? ""} />;
  return <Shell profile={profile} />;
}

function Shell({ profile }: { profile: Profile }) {
  const isManager = profile.role === "manager";
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<unknown>(null);
  const [tses, setTses] = useState<Tse[]>([]);
  const [params, setParams] = useSearchParams();
  const sel = useMemo(() => parseSelection(params), [params]);
  const tse = isManager ? params.get("tse") ?? undefined : undefined;
  const setSel = useCallback((next: Selection) => setParams((cur) => withSelection(cur, next)), [setParams]);
  const setTse = useCallback((id: string | undefined) => setParams((cur) => {
    const next = new URLSearchParams(cur);
    if (id) next.set("tse", id); else next.delete("tse");
    return next;
  }), [setParams]);

  const reloadRuns = useCallback(() => {
    setRunsLoading(true);
    api.runs().then((r) => { setRuns(r); setRunsError(null); })
      .catch((e) => { setRuns([]); setRunsError(e); })
      .finally(() => setRunsLoading(false));
  }, []);
  useEffect(reloadRuns, [reloadRuns]);
  useEffect(() => {
    if (isManager) api.tses().then(setTses).catch(() => setTses([]));
  }, [isManager]);

  const scopeRuns = useMemo(() => {
    if (sel.cur.kind === "period") return normalRuns(runs);
    const id = sel.cur.runId;
    const run = id === "latest" ? latestRun(runs) : runs.find((r) => r.id === id);
    return run ? [run] : [];
  }, [sel, runs]);
  const ctx = useMemo(() => ({
    profile, isManager, runs, runsLoading, runsError, reloadRuns, sel, setSel, tse, setTse, tses,
    tseName: tse ? tses.find((t) => t.id === tse)?.display_name ?? "Selected TSE" : undefined,
    scopeRuns,
  }), [profile, isManager, runs, runsLoading, runsError, reloadRuns, sel, setSel, tse, setTse, tses, scopeRuns]);
  // Nav links carry the selection (cur/cmp/tse) and drop page-specific filters.
  const keep = useMemo(() => {
    const k = new URLSearchParams();
    ["cur", "cmp", "tse"].forEach((n) => { const v = params.get(n); if (v) k.set(n, v); });
    const q = k.toString();
    return q ? `?${q}` : "";
  }, [params]);

  const nav = isManager
    ? [
        { to: "/", label: "Overview", end: true }, { to: "/cases", label: "Cases" },
        { to: "/review", label: "Review queue" }, { to: "/runs", label: "Runs" }, { to: "/export", label: "Export" },
      ]
    : [{ to: "/", label: "My overview", end: true }, { to: "/cases", label: "My cases" }];

  return (
    <AppContext.Provider value={ctx}>
      <div className="min-h-screen flex flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
          <div className="mx-auto max-w-[1440px] px-4 sm:px-6 min-h-14 flex flex-wrap items-center gap-x-6">
            <NavLink to="/" className="flex items-center shrink-0" aria-label="CaseLens home">
              <Wordmark />
            </NavLink>
            <nav className="order-last w-full sm:order-none sm:w-auto flex items-center gap-1 overflow-x-auto [scrollbar-width:none] min-w-0 -mx-3 sm:mx-0" aria-label="Primary">
              {nav.map((n) => (
                <NavLink key={n.to} to={{ pathname: n.to, search: keep }} end={n.end}
                  className={({ isActive }) => `relative px-3 py-4 text-sm whitespace-nowrap transition-colors ${
                    isActive ? "text-text after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-accent after:rounded-full" : "text-muted hover:text-text"}`}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-xs py-2">
              {isManager && (
                <label className="flex items-center gap-2 text-muted">
                  <span className="hidden md:inline">TSE</span>
                  <select value={tse ?? ""} onChange={(e) => setTse(e.target.value || undefined)} aria-label="Select TSE"
                          className="text-xs py-1 max-w-[11rem]">
                    <option value="">All TSEs</option>
                    {tses.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
                  </select>
                </label>
              )}
              <ComparisonControl sel={sel} setSel={setSel} runs={runs} dataDate={dataDate(runs)} />
              <div className="flex items-center gap-2">
                <span className="flex flex-col items-end leading-tight">
                  <span className="text-text">{profile.display_name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted" data-testid="user-role">{isManager ? "Manager" : "TSE"}</span>
                </span>
                <button className="btn-ghost text-xs py-1" onClick={() => supabase.auth.signOut()}>Sign out</button>
              </div>
            </div>
          </div>
        </header>
        <main className="flex-1 mx-auto w-full max-w-[1440px] px-4 sm:px-6 py-6">
          <div className="mb-4 empty:hidden"><SyntheticBanner runs={scopeRuns} /></div>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/cases" element={<Cases />} />
            <Route path="/cases/:id" element={<CaseDetailPage />} />
            {isManager && <Route path="/review" element={<ReviewQueue />} />}
            {isManager && <Route path="/runs" element={<Runs />} />}
            {isManager && <Route path="/export" element={<ExportPage />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <footer className="border-t border-line py-4 text-center text-xs text-muted">
          CaseLens · decision support only · all case text is redacted · reviewer actions never overwrite machine results
        </footer>
      </div>
    </AppContext.Provider>
  );
}
