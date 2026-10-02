import { useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { api, type Profile, type Run } from "./api";
import { AppContext } from "./lib/hooks";
import { configured, initialAuthType, supabase } from "./lib/supabase";
import { fmtDate } from "./lib/format";
import { Mark } from "./components/Mark";
import { Loading } from "./components/ui";
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
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [tse, setTse] = useState<string | undefined>(undefined);
  const [tses, setTses] = useState<string[]>([]);

  useEffect(() => { api.runs().then(setRuns).catch(() => setRuns([])); }, []);
  useEffect(() => {
    if (isManager) api.tses(runId).then(setTses).catch(() => setTses([]));
  }, [isManager, runId]);

  const ctx = useMemo(() => ({ profile, isManager, runs, runId, setRunId, tse: isManager ? tse : undefined, setTse, tses }),
    [profile, isManager, runs, runId, tse, tses]);

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
            <NavLink to="/" className="flex items-center gap-2.5 shrink-0">
              <Mark />
              <span className="font-semibold tracking-tight">CaseLens</span>
            </NavLink>
            <nav className="order-last w-full sm:order-none sm:w-auto flex items-center gap-1 overflow-x-auto [scrollbar-width:none] min-w-0 -mx-3 sm:mx-0" aria-label="Primary">
              {nav.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end}
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
                    {tses.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2 text-muted">
                <span className="hidden md:inline">Run</span>
                <select value={runId ?? ""} onChange={(e) => setRunId(e.target.value || undefined)} aria-label="Select audit run"
                        className="mono text-xs py-1 max-w-[9.5rem] sm:max-w-none">
                  <option value="">Latest</option>
                  {runs.map((r) => <option key={r.id} value={r.id}>{fmtDate(r.created_at, false)} · {r.total} cases</option>)}
                </select>
              </label>
              <div className="flex items-center gap-2">
                <span className="hidden lg:flex flex-col items-end leading-tight">
                  <span className="text-text">{profile.display_name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted">{isManager ? "Manager" : "TSE"}</span>
                </span>
                <button className="btn-ghost text-xs py-1" onClick={() => supabase.auth.signOut()}>Sign out</button>
              </div>
            </div>
          </div>
        </header>
        <main className="flex-1 mx-auto w-full max-w-[1440px] px-4 sm:px-6 py-6">
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
