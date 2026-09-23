// Thin Slack Web API helpers for the edge functions. Every call is one
// fetch with a timeout; `ok:false` responses are returned, not thrown, so
// callers decide what a failure means.
const SLACK_API = "https://slack.com/api";

export interface SlackResponse { ok: boolean; error?: string; [k: string]: unknown }

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await p(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function slackGet(method: string, token: string, params: Record<string, string>, timeoutMs = 8000): Promise<SlackResponse> {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal });
      return (await res.json()) as SlackResponse;
    }, timeoutMs);
  } catch (e) {
    return { ok: false, error: `fetch_failed: ${(e as Error)?.message ?? e}` };
  }
}

export async function slackPost(method: string, token: string, body: Record<string, unknown>, timeoutMs = 8000): Promise<SlackResponse> {
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal,
      });
      return (await res.json()) as SlackResponse;
    }, timeoutMs);
  } catch (e) {
    return { ok: false, error: `fetch_failed: ${(e as Error)?.message ?? e}` };
  }
}

/** Download a Slack-hosted file (url_private) as the user. Returns null on any failure. */
export async function slackDownload(urlPrivate: string, token: string, maxBytes: number, timeoutMs = 30000): Promise<{ bytes: Uint8Array; status: number; contentType: string } | null> {
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(urlPrivate, { headers: { Authorization: `Bearer ${token}` }, signal });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { bytes: buf.slice(0, maxBytes + 1), status: res.status, contentType: res.headers.get("content-type") ?? "" };
    }, timeoutMs);
  } catch {
    return null;
  }
}
