import { useState } from "react";
import { supabase } from "../lib/supabase";
import { Wordmark } from "../components/Mark";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-6 justify-center">
          <Wordmark size="lg" />
        </div>
        <div className="panel p-6">
          <h1 className="text-base font-semibold mb-4">{title}</h1>
          {children}
        </div>
        <p className="text-center text-xs text-muted mt-4">Access is by invitation. Ask your manager if you need an account.</p>
      </div>
    </div>
  );
}

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [forgot, setForgot] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    if (forgot) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "If that address has an account, a reset link is on its way." });
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg({ ok: false, text: "Sign-in failed. Check your email and password." });
    }
    setBusy(false);
  };

  return (
    <Shell title={forgot ? "Reset your password" : "Sign in"}>
      <form onSubmit={submit} className="space-y-3">
        <label className="flex flex-col gap-1 text-sm">Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {!forgot && (
          <label className="flex flex-col gap-1 text-sm">Password
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "Please wait…" : forgot ? "Send reset link" : "Sign in"}</button>
        {msg && <p className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`} role="status">{msg.text}</p>}
        <button type="button" className="text-xs text-info hover:underline" onClick={() => { setForgot(!forgot); setMsg(null); }}>
          {forgot ? "Back to sign in" : "Forgot password?"}
        </button>
      </form>
    </Shell>
  );
}

export function SetPassword({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 10) return setErr("Use at least 10 characters.");
    if (pw !== pw2) return setErr("Passwords do not match.");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) setErr(error.message); else onDone();
  };
  return (
    <Shell title="Set your password">
      <form onSubmit={submit} className="space-y-3">
        <label className="flex flex-col gap-1 text-sm">New password
          <input type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Confirm password
          <input type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </label>
        <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? "Saving…" : "Save password"}</button>
        {err && <p className="text-sm text-danger" role="alert">{err}</p>}
      </form>
    </Shell>
  );
}

export function NoAccess({ email }: { email: string }) {
  return (
    <Shell title="No CaseLens role yet">
      <p className="text-sm text-muted">You are signed in as <span className="text-text">{email}</span>, but no role has been assigned to this account. Ask a manager to grant you manager or TSE access.</p>
      <button className="btn-ghost mt-4" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </Shell>
  );
}

export function NotConfigured() {
  return (
    <Shell title="Configuration needed">
      <p className="text-sm text-muted">Set <span className="mono">VITE_SUPABASE_URL</span> and <span className="mono">VITE_SUPABASE_PUBLISHABLE_KEY</span> (see README), then rebuild.</p>
    </Shell>
  );
}
