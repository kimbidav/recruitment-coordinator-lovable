// Gmail side of the candidate email resolver: run the surname-anchored query
// plan against the recruiter's mailbox, fetch metadata in parallel chunks,
// pull the full body only for Calendly notices whose snippet lacks the
// invitee email, then score. Pure logic lives in pure/emailResolver.ts.
import {
  DEFAULT_INTERNAL_DOMAINS,
  bodyText,
  buildQueries,
  isCalendlySender,
  parseCandidateName,
  parseMessageDate,
  scoreCandidateMessages,
  splitAddress,
  summarizeResolution,
  type ResolveResult,
  type ResolverMessage,
} from "./pure/emailResolver.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmailGet(accessToken: string, path: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: ctl.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gmail ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    return json as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a candidate's personal email from the recruiter's Gmail with a
 * confidence. `ownEmail` is the recruiter's address (never a candidate).
 * Returns `email` only at high/medium confidence.
 */
export async function resolveCandidateEmail(
  accessToken: string,
  ownEmail: string,
  candidateName: string,
  opts: { internalDomains?: readonly string[]; maxResultsPerQuery?: number; maxMessageGets?: number } = {},
): Promise<ResolveResult> {
  const parsed = parseCandidateName(candidateName);
  const internal = (opts.internalDomains ?? DEFAULT_INTERNAL_DOMAINS).map((d) => d.toLowerCase());
  const own = [ownEmail.trim().toLowerCase()].filter(Boolean);
  const plan = buildQueries(parsed, internal);
  const queries = plan.map((q) => q.q);
  if (!parsed.surname || !plan.length) return summarizeResolution(parsed, queries, { candidates: [], supporting: [] });

  const maxPer = opts.maxResultsPerQuery ?? 15;
  const maxGets = opts.maxMessageGets ?? 60;
  const errors: string[] = [];

  // 1. List message ids per query (precise queries first).
  const wanted = new Map<string, { anchor: boolean }>();
  const lists = await Promise.allSettled(
    plan.map((q) => gmailGet(accessToken, `/messages?maxResults=${maxPer}&q=${encodeURIComponent(q.q)}`)),
  );
  lists.forEach((res, i) => {
    if (res.status === "rejected") {
      errors.push(`${plan[i].q}: ${String(res.reason?.message ?? res.reason)}`);
      return;
    }
    for (const ref of (res.value.messages as Array<{ id?: string }> | undefined) ?? []) {
      if (!ref.id) continue;
      const prev = wanted.get(ref.id);
      if (prev) prev.anchor = prev.anchor || plan[i].anchor;
      else if (wanted.size < maxGets) wanted.set(ref.id, { anchor: plan[i].anchor });
    }
  });

  // 2. Metadata in chunks of 10 (parallel).
  const ids = Array.from(wanted.keys());
  const fetched = new Map<string, Record<string, unknown>>();
  const META = "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date";
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const results = await Promise.allSettled(chunk.map((id) => gmailGet(accessToken, `/messages/${id}${META}`)));
    results.forEach((r, j) => {
      if (r.status === "fulfilled") fetched.set(chunk[j], r.value);
      else errors.push(`get ${chunk[j]}: ${String(r.reason?.message ?? r.reason)}`);
    });
  }

  // 3. Normalise; full body for Calendly notices missing the invitee email.
  const messages: ResolverMessage[] = [];
  let calendlyBudget = 5;
  for (const id of ids) {
    const m = fetched.get(id);
    if (!m) continue;
    const payload = (m.payload ?? {}) as { headers?: Array<{ name?: string; value?: string }> };
    const headers: Record<string, string> = {};
    for (const h of payload.headers ?? []) {
      const k = (h.name ?? "").toLowerCase();
      if (k === "from") headers.From = h.value ?? "";
      else if (k === "to") headers.To = h.value ?? "";
      else if (k === "cc") headers.Cc = h.value ?? "";
      else if (k === "subject") headers.Subject = h.value ?? "";
      else if (k === "date") headers.Date = h.value ?? "";
    }
    const item: ResolverMessage = {
      id,
      threadId: String(m.threadId ?? ""),
      headers,
      snippet: String(m.snippet ?? ""),
      date: parseMessageDate(headers, m.internalDate as string | undefined),
      anchor: wanted.get(id)?.anchor ?? false,
      body: "",
    };
    const [, fromAddr] = splitAddress(headers.From ?? "");
    if (isCalendlySender(fromAddr) && !item.snippet.toLowerCase().includes("invitee email") && calendlyBudget > 0) {
      calendlyBudget--;
      try {
        const full = await gmailGet(accessToken, `/messages/${id}?format=full`, 20_000);
        item.body = bodyText(full.payload as Record<string, unknown>).slice(0, 4000);
      } catch (e) {
        errors.push(`full ${id}: ${String((e as Error)?.message ?? e)}`);
      }
    }
    messages.push(item);
  }

  const scored = scoreCandidateMessages(messages, parsed, { internalDomains: internal, ownAddresses: own });
  return summarizeResolution(parsed, queries, scored, errors);
}
