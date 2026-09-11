// Best-effort transactional-email logging. Call right after a Resend POST.
// NEVER throws and NEVER blocks the caller — a logging failure must not
// break sending an email. Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// from the function env (present in every Edge Function by default).

interface LogArgs {
  to: string;
  subject?: string;
  template?: string;
  resendId?: string | null;
  status?: "accepted" | "failed";
  error?: string | null;
  meta?: Record<string, unknown>;
}

export async function logEmail(a: LogArgs): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    await fetch(`${url}/rest/v1/email_log`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        to_addr: a.to,
        subject: a.subject ?? null,
        template: a.template ?? null,
        resend_id: a.resendId ?? null,
        status: a.status ?? "accepted",
        error: a.error ?? null,
        meta: a.meta ?? {},
      }),
    });
  } catch {
    // swallow — logging is never allowed to break the send
  }
}

// Convenience: given a Resend `fetch` Response (already awaited to .json()),
// derive status + id + error and log in one call.
export async function logResend(
  resp: Response,
  parsed: any,
  base: Omit<LogArgs, "status" | "resendId" | "error">,
): Promise<void> {
  const ok = resp.ok && parsed && parsed.id;
  await logEmail({
    ...base,
    status: ok ? "accepted" : "failed",
    resendId: ok ? parsed.id : null,
    error: ok ? null : JSON.stringify(parsed?.error ?? parsed ?? `HTTP ${resp.status}`).slice(0, 400),
  });
}
