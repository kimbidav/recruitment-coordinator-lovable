// HTTP client for the Ashby extractor on Railway. Every call carries the
// shared secret; write calls also carry the recruiter's identity
// (X-Ashby-User: email) so the extractor uses THAT person's Ashby login.
// The shape of errors is kept identical to the desktop coordinator's
// _call_extractor so the shortcut views can be a straight port.

export type ExtractorResult<T> = { data: T; error: null } | { data: null; error: { status: number; body: Record<string, unknown> } };

const BASE = () => (Deno.env.get("ASHBY_AUTOMATION_API_BASE") ?? "https://ashby-automation-production.up.railway.app").replace(/\/$/, "");

export async function callExtractor<T = Record<string, unknown>>(
  path: string,
  payload: Record<string, unknown> | null,
  opts: { timeoutMs?: number; userEmail?: string; method?: "GET" | "POST" } = {},
): Promise<ExtractorResult<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  const secret = Deno.env.get("EXTRACTOR_SHARED_SECRET");
  if (secret) headers["X-Extractor-Secret"] = secret;
  if (opts.userEmail) headers["X-Ashby-User"] = opts.userEmail;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 90_000);
  try {
    const res = await fetch(`${BASE()}${path}`, {
      method: opts.method ?? "POST",
      headers,
      body: payload === null ? undefined : JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { detail: text.slice(0, 500) }; }
    if (res.ok) return { data: body as T, error: null };
    if (res.status === 401) {
      const err = String(body.error ?? "");
      // The recruiter's own Ashby login is missing/expired vs the extractor secret.
      const kind = err.startsWith("user_session") ? err : "ashby_session_dead";
      return { data: null, error: { status: 401, body: { error: kind, extractor_error: err, instructions: "Reconnect Ashby in Candidate Compass, then try again." } } };
    }
    // 404 unknown_org, 409 candidate_exists / wrong_org_context, 400, 423, 503 pass through verbatim.
    if ([400, 404, 409, 423, 503].includes(res.status)) return { data: null, error: { status: res.status, body } };
    return { data: null, error: { status: 502, body: { error: "extractor_error", status: res.status, detail: body.error ?? body.detail ?? text.slice(0, 500) } } };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return {
      data: null,
      error: {
        status: 503,
        body: aborted
          ? { error: "ashby_slow", detail: "The Ashby extractor did not answer in time. Nothing was written." }
          : { error: "extractor_unreachable", detail: String((e as Error)?.message ?? e), instructions: "The Ashby extractor on Railway isn't answering." },
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
