import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const configured = Boolean(url && key);

// Captured before the client consumes the URL hash: invite and recovery links must
// lead to "set your password" rather than straight into the app.
export const initialAuthType: string | null =
  typeof window !== "undefined" ? new URLSearchParams(window.location.hash.slice(1)).get("type") : null;

// The publishable key is safe in the browser: every table is protected by row-level
// security, and clients can only read (managers can also append review actions).
export const supabase = createClient(url ?? "http://localhost", key ?? "missing", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
});
