import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// Agent scan v2: detects intro_stall, post_interview_followup, and batch_followup cards.
// Adds: email-based scheduling detection (intro_stall + post-interview suppression),
// 3-tier calendar matching (exact/fuzzy/LLM), client domain learning, batch follow-ups,
// suggested_followup_at enforcement (snooze until that time), and bigger pagination.

const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const BATCH_LIMIT = 15;
const CALENDAR_LOOKBACK_DAYS = 90;
const CALENDAR_LOOKAHEAD_DAYS = 45;
// Hard cap well under edge-runtime's 150s idle timeout. We return early and
// the client paginates via the returned cursor.
const PAGE_SOFT_TIMEOUT_MS = 90_000;

// Fetch with a hard timeout so external API stalls can't blow the page budget.
async function fetchWithTimeout(input: string, init: RequestInit = {}, ms = 12_000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const COMPANY_NOISE = new Set([
  "inc","llc","ltd","co","corp","company","labs","lab","ai","io","hq","the","a","technologies","tech",
]);
function companyKey(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !COMPANY_NOISE.has(t))
    .join("");
}
function companyTokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !COMPANY_NOISE.has(t));
}
function firstName(full: string): string {
  return (full || "").trim().split(/\s+/)[0] || full;
}
function lastName(full: string): string {
  const parts = (full || "").trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : "";
}
function inferDomainCandidates(client: string): string[] {
  const slug = companyKey(client);
  if (!slug) return [];
  return [
    `${slug}.com`,
    `${slug}.ai`,
    `${slug}.io`,
    `get${slug}.com`,
    `get${slug}.ai`,
    `${slug}.co`,
  ];
}

async function refreshGoogleAccess(refreshToken: string) {
  const r = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`google refresh: ${JSON.stringify(j)}`);
  return j as { access_token: string; expires_in: number };
}

interface CalEvent { summary: string; start: string; end?: string; attendees: string[] }

async function listCalendarEvents(token: string, fromIso: string, toIso: string): Promise<CalEvent[]> {
  const params = new URLSearchParams({
    timeMin: fromIso,
    timeMax: toIso,
    singleEvents: "true",
    maxResults: "1000",
    orderBy: "startTime",
  });
  const r = await fetchWithTimeout(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  if (!r.ok) throw new Error(`calendar list: ${JSON.stringify(j)}`);
  return (j.items ?? []).map((e: any) => ({
    summary: e.summary ?? "",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date,
    attendees: (e.attendees ?? []).map((a: any) => a.email).filter(Boolean),
  }));
}

interface GmailHit {
  id: string; from: string; to: string; subject: string; snippet: string; date: string; bodyText?: string;
}

async function gmailSearchIds(token: string, query: string, max = 10): Promise<string[]> {
  const r = await fetchWithTimeout(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  if (!r.ok) return [];
  return (j.messages ?? []).map((m: any) => m.id);
}

function decodeBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data) {
    try {
      const b64 = (payload.body.data as string).replace(/-/g, "+").replace(/_/g, "/");
      return atob(b64);
    } catch { /* ignore */ }
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/plain" || part.mimeType?.startsWith("text/")) {
      const t = decodeBody(part);
      if (t) return t;
    }
  }
  return "";
}

async function gmailFetch(token: string, id: string, withBody: boolean): Promise<GmailHit | null> {
  const fmt = withBody ? "full" : "metadata";
  const meta = withBody
    ? ""
    : "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
  const r = await fetchWithTimeout(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=${fmt}${meta}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  if (!r.ok) return null;
  const headers: any[] = j.payload?.headers ?? [];
  const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const bodyText = withBody ? decodeBody(j.payload).slice(0, 3000) : undefined;
  return {
    id,
    from: get("From"),
    to: get("To"),
    subject: get("Subject"),
    snippet: j.snippet ?? "",
    date: get("Date"),
    bodyText,
  };
}

async function searchGmailHits(token: string, query: string, max = 8, withBody = false): Promise<GmailHit[]> {
  const ids = await gmailSearchIds(token, query, max);
  const out: GmailHit[] = [];
  await Promise.all(ids.map(async (id) => {
    const h = await gmailFetch(token, id, withBody);
    if (h) out.push(h);
  }));
  return out;
}

// --- Domain learning ----------------------------------------------------------

async function learnClientDomain(args: {
  admin: any; userId: string; gmailToken: string | null; clientName: string;
}): Promise<string | null> {
  const { admin, userId, gmailToken, clientName } = args;
  // 1. cache hit
  const { data: cached } = await admin
    .from("client_domain_cache")
    .select("domain, confidence")
    .eq("user_id", userId).eq("client_name", clientName).maybeSingle();
  if (cached?.domain) return cached.domain;
  if (!gmailToken) return null;

  // 2. infer & probe
  for (const dom of inferDomainCandidates(clientName)) {
    const ids = await gmailSearchIds(gmailToken, `from:@${dom} OR to:@${dom} newer_than:180d`, 1);
    if (ids.length) {
      await admin.from("client_domain_cache").upsert({
        user_id: userId, client_name: clientName, domain: dom,
        source: "inferred", confidence: 0.7, learned_at: new Date().toISOString(),
      });
      return dom;
    }
  }

  // 3. LLM pick from recent senders
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return null;
  const recent = await searchGmailHits(gmailToken, `newer_than:60d`, 25, false);
  const domains = Array.from(new Set(
    recent.flatMap((h) => [h.from, h.to])
      .map((s) => (s.match(/@([\w.-]+)/)?.[1] || "").toLowerCase())
      .filter(Boolean)
      .filter((d) => !["gmail.com","yahoo.com","outlook.com","hotmail.com"].includes(d)),
  )).slice(0, 30);
  if (!domains.length) return null;

  try {
    const r = await fetchWithTimeout(LOVABLE_AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{
          role: "user",
          content: `Which of these email domains belongs to the company "${clientName}"?\nDomains: ${domains.join(", ")}\nReturn the single best match, or null if none plausible.`,
        }],
        tools: [{
          type: "function",
          function: {
            name: "pick_domain",
            parameters: {
              type: "object",
              properties: {
                domain: { type: ["string", "null"] },
                confidence: { type: "number" },
              },
              required: ["domain", "confidence"], additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "pick_domain" } },
      }),
    });
    const j = await r.json();
    const args = j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return null;
    const parsed = JSON.parse(args);
    if (parsed.domain) {
      await admin.from("client_domain_cache").upsert({
        user_id: userId, client_name: clientName, domain: parsed.domain,
        source: "llm", confidence: parsed.confidence ?? 0.6, learned_at: new Date().toISOString(),
      });
      return parsed.domain;
    }
  } catch (e) {
    console.error("learnClientDomain llm", e);
  }
  return null;
}

// --- Candidate email cache ----------------------------------------------------

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com","yahoo.com","outlook.com","hotmail.com","icloud.com",
  "me.com","aol.com","proton.me","protonmail.com","live.com","msn.com",
]);

function extractEmail(s: string): string | null {
  if (!s) return null;
  const m = s.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}
function emailDomain(e: string | null): string | null {
  if (!e) return null;
  const m = e.match(/@([\w.-]+)/);
  return m ? m[1].toLowerCase() : null;
}

async function loadCandidateEmail(args: {
  admin: any; userId: string; slackSubmissionId: string;
}): Promise<string | null> {
  const { data } = await args.admin
    .from("candidate_emails")
    .select("email, confidence")
    .eq("user_id", args.userId)
    .eq("slack_submission_id", args.slackSubmissionId)
    .order("confidence", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.email ?? null;
}

async function saveCandidateEmail(args: {
  admin: any; userId: string; slackSubmissionId: string;
  email: string; source: string; confidence: number;
}) {
  if (!args.email) return;
  await args.admin.from("candidate_emails").upsert({
    user_id: args.userId,
    slack_submission_id: args.slackSubmissionId,
    email: args.email.toLowerCase(),
    source: args.source,
    confidence: args.confidence,
    learned_at: new Date().toISOString(),
  }, { onConflict: "user_id,slack_submission_id,email" });
}

/**
 * Pick the most likely candidate email from a calendar event's attendees:
 * exclude the user's own email, exclude the client's domain (those are
 * interviewers), and prefer a non-public domain if the candidate has a work
 * email; otherwise fall back to a public-domain (gmail/etc) address.
 */
function pickCandidateEmailFromEvent(
  ev: { attendees: string[] },
  opts: { ownEmail: string | null; clientDomain: string | null },
): string | null {
  const own = (opts.ownEmail ?? "").toLowerCase();
  const cd = (opts.clientDomain ?? "").toLowerCase();
  const candidates = ev.attendees
    .map((a) => extractEmail(a))
    .filter((e): e is string => !!e)
    .filter((e) => e !== own)
    .filter((e) => !cd || !e.endsWith(`@${cd}`));
  if (!candidates.length) return null;
  const personal = candidates.find((e) => PUBLIC_EMAIL_DOMAINS.has(emailDomain(e) ?? ""));
  const work = candidates.find((e) => !PUBLIC_EMAIL_DOMAINS.has(emailDomain(e) ?? ""));
  return work ?? personal ?? candidates[0];
}

// --- LLM signal detectors -----------------------------------------------------


interface SchedulingSignal {
  outcome: "scheduled" | "scheduling_in_progress" | "interview_completed" | "not_scheduled" | "ambiguous";
  scheduled_time: string | null;
  suggested_followup_at: string | null;
  candidate_email: string | null;
  evidence: string;
}

async function llmDetectScheduling(args: {
  candidateName: string;
  company: string;
  calendar: CalEvent[];
  gmail: GmailHit[];
  context: "intro_stall" | "post_interview";
  meetingTimeIso?: string | null;
  knownCandidateEmail?: string | null;
  clientDomain?: string | null;
}): Promise<SchedulingSignal> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return { outcome: "not_scheduled", scheduled_time: null, suggested_followup_at: null, candidate_email: null, evidence: "no_llm" };

  const isPostInterview = args.context === "post_interview";
  const scopeNote = isPostInterview
    ? `An interview already happened on ${args.meetingTimeIso ?? "(unknown date)"}. Decide whether a NEXT round / NEXT meeting is scheduled, actively being scheduled, or already completed via email.`
    : `Decide whether ANY meeting between the candidate and someone at the company is scheduled, actively being scheduled, or already happened — calendar event OR an email exchange.`;

  const firstName = (args.candidateName.trim().split(/\s+/)[0] || "").toLowerCase();
  const attributionNote = `IMPORTANT: Emails between the client and the candidate usually do NOT include the candidate's full name. They often use only the first name ("Hi ${firstName || "<first name>"},"), or no name at all. Attribute by EMAIL ADDRESS, not by name in the body:
- If a known candidate email is provided below, any email from/to that address IS the candidate.
- Otherwise, a thread between the client domain (${args.clientDomain ?? "unknown"}) and an external address whose first name plausibly matches "${firstName}" should be treated as the candidate.
- Do NOT require the candidate's last name to appear anywhere.`;

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are detecting interview scheduling signals between a candidate and a client/hiring company.
Today: ${today}
Candidate: ${args.candidateName}
Company: ${args.company}
Known candidate email: ${args.knownCandidateEmail ?? "(unknown — infer if possible)"}
Client email domain: ${args.clientDomain ?? "(unknown)"}

${attributionNote}



${scopeNote}

Calendar events (${CALENDAR_LOOKBACK_DAYS}d back → ${CALENDAR_LOOKAHEAD_DAYS}d forward):
${args.calendar.slice(0, 30).map((e, i) => `${i + 1}. "${e.summary}" @ ${e.start} attendees=${e.attendees.join(",")}`).join("\n") || "(none)"}

Recent emails (with body excerpts):
${args.gmail.slice(0, 12).map((h, i) =>
  `${i + 1}. ${h.date} | From:${h.from} To:${h.to} | Subj:${h.subject}\n   Body: ${(h.bodyText || h.snippet || "").slice(0, 500)}`
).join("\n") || "(none)"}

Output:
- outcome (pick ONE):
  • "scheduled" = a specific date/time is confirmed (calendar event matching, OR an email like "I set up a time on your schedule for Monday at 10:30 am", "confirmed for Thursday 2pm", or a calendar invite acceptance).
  • "scheduling_in_progress" = scheduling is actively in motion but no specific time confirmed yet. Examples:
      - Client sent a Calendly / Ashby / scheduling link AND the candidate replied positively ("I'll grab some time this week", "thanks, will book a slot", "looking forward to it").
      - Candidate said they will book ("I'll grab time", "I'll find a slot this week").
      - Client said "please grab a time here: [link]" within the last 7 days and candidate has not yet declined.
    Treat these as "in progress" — do NOT nag yet.
  • "interview_completed" = an email indicates the meeting already happened ("Ken and I spoke today", "great chatting yesterday", "thanks for the time today"). Use this even without a calendar event.
  • "ambiguous" = vague language only ("let me circle back", "happy to chat sometime") — no link sent, no commitment.
  • "not_scheduled" = nothing matching at all.
- scheduled_time: ISO 8601 if a specific time is known (resolve relative phrasing like "next Thursday" against the email Date header). Else null.
- suggested_followup_at: ISO 8601 date when we SHOULD re-check this candidate. Required for "scheduling_in_progress" — pick a date 5–10 business days after the most recent scheduling email (give the candidate time to book). Else null.
- candidate_email: best guess of the candidate's email from headers (not the recruiter), else null.
- evidence: one short sentence quoting the snippet that drove your decision.`;

  const body = {
    model: "google/gemini-2.5-pro",
    messages: [{ role: "user", content: prompt }],
    tools: [{
      type: "function",
      function: {
        name: "report_scheduling",
        parameters: {
          type: "object",
          properties: {
            outcome: { type: "string", enum: ["scheduled", "scheduling_in_progress", "interview_completed", "not_scheduled", "ambiguous"] },
            scheduled_time: { type: ["string", "null"] },
            suggested_followup_at: { type: ["string", "null"] },
            candidate_email: { type: ["string", "null"] },
            evidence: { type: "string" },
          },
          required: ["outcome", "scheduled_time", "suggested_followup_at", "candidate_email", "evidence"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "report_scheduling" } },
  };

  const r = await fetchWithTimeout(LOVABLE_AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error("llm err", r.status, await r.text());
    return { outcome: "not_scheduled", scheduled_time: null, suggested_followup_at: null, candidate_email: null, evidence: "llm_error" };
  }
  const j = await r.json();
  const tc = j.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc) return { outcome: "not_scheduled", scheduled_time: null, suggested_followup_at: null, candidate_email: null, evidence: "no_tool_call" };
  try {
    const parsed = JSON.parse(tc.function.arguments);
    return { suggested_followup_at: null, ...parsed };
  }
  catch { return { outcome: "not_scheduled", scheduled_time: null, suggested_followup_at: null, candidate_email: null, evidence: "parse_error" }; }
}

async function llmPickCalendarEvents(args: {
  candidateName: string; company: string; events: CalEvent[];
}): Promise<number[]> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey || !args.events.length) return [];
  try {
    const r = await fetchWithTimeout(LOVABLE_AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{
          role: "user",
          content: `Which of these calendar events look like an interview between candidate "${args.candidateName}" and someone at "${args.company}"? Titles often use formats like "Yi x Altara", "Fan / Decagon", initials, or nicknames.\n\n${
            args.events.slice(0, 15).map((e, i) => `${i}. "${e.summary}" @ ${e.start} (${e.attendees.slice(0,3).join(",")})`).join("\n")
          }`,
        }],
        tools: [{
          type: "function",
          function: {
            name: "pick_events",
            parameters: {
              type: "object",
              properties: {
                indices: { type: "array", items: { type: "integer" } },
              },
              required: ["indices"], additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "pick_events" } },
      }),
    });
    const j = await r.json();
    const a = j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!a) return [];
    const parsed = JSON.parse(a);
    return Array.isArray(parsed.indices) ? parsed.indices.filter((n: any) => Number.isInteger(n)) : [];
  } catch (e) {
    console.error("llmPickCalendarEvents", e);
    return [];
  }
}

// --- Calendar matching --------------------------------------------------------

function calendarMatches(args: {
  candidateName: string; company: string; calendar: CalEvent[];
}): { matches: CalEvent[]; tier: "exact" | "fuzzy" | "none" } {
  const fn = firstName(args.candidateName).toLowerCase();
  const ln = lastName(args.candidateName).toLowerCase();
  const cKey = companyKey(args.company);
  const cToks = companyTokens(args.company);
  const exact: CalEvent[] = [];
  const fuzzy: CalEvent[] = [];

  for (const e of args.calendar) {
    const t = (e.summary || "").toLowerCase();
    const att = e.attendees.join(" ").toLowerCase();
    const tKey = companyKey(t);
    const attKey = companyKey(att);
    const hasFirst = fn && fn.length >= 2 && new RegExp(`\\b${fn}\\b`).test(t);
    const hasLast = ln && ln.length >= 2 && new RegExp(`\\b${ln}\\b`).test(t);
    const hasCompany = cKey && (tKey === cKey || tKey.includes(cKey) || attKey.includes(cKey));
    // Title patterns: "X x Y", "X / Y", "X × Y", "X | Y"
    const sepPattern = new RegExp(`\\b${fn}\\b\\s*[x×\\/|]\\s*\\b(${cToks.join("|") || "__none__"})\\b`, "i");
    const sepMatch = fn && cToks.length && sepPattern.test(t);

    // Strict: require BOTH a candidate-name token AND a company signal.
    // Avoids attributing e.g. "Vishu x Auctor" to a different Auctor candidate.
    if ((hasFirst && hasCompany) || sepMatch) exact.push(e);
    else if ((hasFirst || hasLast) && hasCompany) fuzzy.push(e);
  }

  if (exact.length) return { matches: exact, tier: "exact" };
  if (fuzzy.length) return { matches: fuzzy, tier: "fuzzy" };
  return { matches: [], tier: "none" };
}

// --- Misc helpers -------------------------------------------------------------

async function fetchSlackThread(token: string, channelId: string, ts: string) {
  const r = await fetchWithTimeout(
    `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${ts}&limit=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  if (!j.ok) return { messages: [] as any[] };
  return { messages: j.messages ?? [] };
}

function batchSlackMessage(candidates: string[]): string {
  const lines = candidates.map((n) => `– ${n}`).join("\n");
  return `Quick status check on:\n${lines}\nAny updates?`;
}

// --- Main handler -------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startTime = Date.now();
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let runId: string | undefined;
  let userId: string | undefined;
  let cardsCreated = 0;
  let cardsResolved = 0;
  let processed = 0;
  let hasMore = false;
  let nextCursor: string | null = null;
  let gmailScopeMissing = false;
  let scanError: string | null = null;
  let totalEligible: number | null = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const tz: string = body.tz ?? "America/Los_Angeles";
    const cursor: string | null = body.cursor ?? null;
    const reuseRunId: string | undefined = body.run_id;

    // settings
    const { data: settings } = await admin
      .from("agent_settings").select("*").eq("user_id", userId).maybeSingle();
    const introStallMinDays: number = settings?.intro_stall_min_days ?? 3;
    const batchThreshold: number = settings?.batch_followup_threshold ?? 3;

    if (reuseRunId) {
      runId = reuseRunId;
    } else {
      const { data: runRow } = await admin
        .from("agent_scan_runs")
        .insert({ user_id: userId, started_at: new Date().toISOString() })
        .select("id").single();
      runId = runRow?.id;
    }

    const { data: slackTok } = await admin
      .from("slack_tokens").select("access_token").eq("user_id", userId).maybeSingle();

    const { data: gTok } = await admin
      .from("google_calendar_tokens").select("*").eq("user_id", userId).maybeSingle();
    const ownGoogleEmail: string | null = (gTok?.google_email ?? null) as string | null;

    let googleAccess: string | null = gTok?.access_token ?? null;
    if (gTok) {
      gmailScopeMissing = !((gTok.scope ?? "") as string).includes("gmail.readonly");
      const exp = gTok.expires_at ? new Date(gTok.expires_at).getTime() : 0;
      if (!googleAccess || Date.now() > exp - 60_000) {
        try {
          const refreshed = await refreshGoogleAccess(gTok.refresh_token);
          googleAccess = refreshed.access_token;
          await admin.from("google_calendar_tokens").update({
            access_token: googleAccess,
            expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("user_id", userId);
        } catch (e) {
          console.error("google refresh failed", e);
        }
      }
    } else {
      gmailScopeMissing = true;
    }

    // Calendar window
    let calendar: CalEvent[] = [];
    if (googleAccess) {
      const now = new Date();
      const from = new Date(now.getTime() - CALENDAR_LOOKBACK_DAYS * 86400000);
      const to = new Date(now.getTime() + CALENDAR_LOOKAHEAD_DAYS * 86400000);
      try {
        calendar = await listCalendarEvents(googleAccess, from.toISOString(), to.toISOString());
      } catch (e) { console.error("calendar fetch", e); }
    }

    const eligibilityCutoff = new Date(Date.now() - introStallMinDays * 86400000).toISOString();

    // Total count once on first invocation
    if (!cursor) {
      const { count } = await admin
        .from("slack_submissions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "accepted")
        .lte("submitted_at", eligibilityCutoff);
      totalEligible = count ?? null;
    }

    let q = admin
      .from("slack_submissions")
      .select("id, channel_id, message_ts, client_name, candidate_name, status, submitted_at, permalink, linkedin_url")
      .eq("user_id", userId)
      .eq("status", "accepted")
      .lte("submitted_at", eligibilityCutoff)
      .order("submitted_at", { ascending: true })
      .limit(BATCH_LIMIT + 1);
    if (cursor) q = q.gt("submitted_at", cursor);
    const { data: subsRaw } = await q;
    const subs = subsRaw ?? [];
    hasMore = subs.length > BATCH_LIMIT;
    const batch = hasMore ? subs.slice(0, BATCH_LIMIT) : subs;

    const isFirstInvocation = !cursor;
    const existingByKey = new Map<string, { id: string; status: string }>();
    if (isFirstInvocation) {
      const { data: existingCards } = await admin
        .from("agent_action_cards")
        .select("id, slack_submission_id, kind, status")
        .eq("user_id", userId)
        .in("status", ["open", "snoozed"]);
      for (const c of existingCards ?? []) {
        existingByKey.set(`${c.slack_submission_id}::${c.kind}`, { id: c.id, status: c.status });
      }
    } else {
      const ids = batch.map((s) => s.id);
      if (ids.length) {
        const { data: existingCards } = await admin
          .from("agent_action_cards")
          .select("id, slack_submission_id, kind, status")
          .eq("user_id", userId)
          .in("slack_submission_id", ids)
          .in("status", ["open", "snoozed"]);
        for (const c of existingCards ?? []) {
          existingByKey.set(`${c.slack_submission_id}::${c.kind}`, { id: c.id, status: c.status });
        }
      }
    }
    const stillRelevant = new Set<string>();
    // Track sub-level outcomes for batch grouping at the end
    const stallsByClient = new Map<string, Array<{
      sub: typeof batch[number]; cardPayload: Record<string, unknown>;
    }>>();

    for (const sub of batch) {
      // Soft timeout: stop early if we're close to the limit
      if (Date.now() - startTime > PAGE_SOFT_TIMEOUT_MS) {
        hasMore = true;
        break;
      }
      processed++;
      nextCursor = sub.submitted_at;
      const candidateName = sub.candidate_name || "";
      const company = sub.client_name || "";

      try {
        if (!candidateName) {
          await admin.from("agent_scan_items").insert({
            user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
            candidate_name: candidateName, client_name: company,
            outcome: "skipped_no_name", reason: "no candidate_name",
          });
          continue;
        }

        // 3-tier calendar matching
        let { matches: calMatches, tier } = calendarMatches({
          candidateName, company, calendar,
        });
        if (tier === "none" && calendar.length) {
          // LLM tiebreak — only when no exact/fuzzy match
          const sample = calendar.slice(-15);
          const idxs = await llmPickCalendarEvents({
            candidateName, company, events: sample,
          });
          calMatches = idxs.map((i) => sample[i]).filter(Boolean);
          if (calMatches.length) tier = "fuzzy";
        }

        // Domain learning + candidate-email-aware Gmail retrieval
        let clientDomain: string | null = null;
        let gmailHits: GmailHit[] = [];
        let knownCandidateEmail: string | null = null;
        if (googleAccess && !gmailScopeMissing && company) {
          try {
            clientDomain = await learnClientDomain({
              admin, userId, gmailToken: googleAccess, clientName: company,
            });
          } catch (e) { console.error("domain", e); }

          // 1. cached candidate email (strongest signal)
          try {
            knownCandidateEmail = await loadCandidateEmail({
              admin, userId, slackSubmissionId: sub.id,
            });
          } catch (e) { console.error("load candidate email", e); }

          // 2. learn from any matched calendar event attendees
          if (!knownCandidateEmail && calMatches.length) {
            for (const ev of calMatches) {
              const guess = pickCandidateEmailFromEvent(ev, {
                ownEmail: ownGoogleEmail, clientDomain,
              });
              if (guess) {
                knownCandidateEmail = guess;
                try {
                  await saveCandidateEmail({
                    admin, userId, slackSubmissionId: sub.id,
                    email: guess, source: "calendar", confidence: 0.85,
                  });
                } catch (e) { console.error("save cand email cal", e); }
                break;
              }
            }
          }

          // 3. multi-tier Gmail retrieval — every tier must include the client domain,
          // otherwise we cross-contaminate signals from other clients the candidate
          // is also interviewing with (e.g. a Phonic thread attributed to an Auctor card).
          try {
            const firstName = (candidateName.trim().split(/\s+/)[0] || "").replace(/[^A-Za-z'-]/g, "");
            const queries: string[] = [];
            const domainClause = clientDomain ? `(from:@${clientDomain} OR to:@${clientDomain} OR cc:@${clientDomain})` : "";
            if (clientDomain && knownCandidateEmail) {
              queries.push(`(from:${knownCandidateEmail} OR to:${knownCandidateEmail} OR cc:${knownCandidateEmail}) ${domainClause} newer_than:120d`);
            }
            if (clientDomain && firstName.length >= 2) {
              queries.push(`"${firstName}" ${domainClause} newer_than:60d`);
            }
            if (clientDomain) {
              queries.push(`(calendly OR "grab time" OR "find a time" OR "set up a time" OR "scheduling link" OR "confirmed for" OR "look forward to") ${domainClause} newer_than:30d`);
              queries.push(`${domainClause} newer_than:60d`);
            }
            if (clientDomain) {
              queries.push(`"${candidateName.replace(/"/g, "")}" ${domainClause} newer_than:120d`);
            }

            const seen = new Set<string>();
            for (const qstr of queries) {
              const hits = await searchGmailHits(googleAccess, qstr, 8, true);
              for (const h of hits) {
                if (!seen.has(h.id)) { seen.add(h.id); gmailHits.push(h); }
              }
              if (gmailHits.length >= 15) break;
            }
          } catch (e) { console.error("gmail search", e); }
        }


        // Slack thread activity
        let lastThreadTs = parseFloat(sub.message_ts) * 1000;
        let threadExcerpt = "";
        let threadMessages: { ts: string; user?: string; text: string; at: string }[] = [];
        if (slackTok?.access_token) {
          try {
            const t = await fetchSlackThread(slackTok.access_token, sub.channel_id, sub.message_ts);
            for (const m of t.messages) {
              const tsMs = parseFloat(m.ts) * 1000;
              if (tsMs > lastThreadTs) lastThreadTs = tsMs;
            }
            threadExcerpt = (t.messages.slice(-2).map((m: any) => m.text).join(" • ") || "").slice(0, 400);
            threadMessages = t.messages.slice(-8).map((m: any) => ({
              ts: m.ts,
              user: m.user || m.username || m.bot_id || undefined,
              text: (m.text || "").slice(0, 1000),
              at: new Date(parseFloat(m.ts) * 1000).toISOString(),
            }));
          } catch (e) { console.error("slack thread", e); }
        }

        const subMs = parseFloat(sub.message_ts) * 1000;
        const pastCalMatch = calMatches.find((e) => {
          const ts = e.start ? new Date(e.start).getTime() : NaN;
          return !isNaN(ts) && ts < Date.now();
        });
        const upcomingCal = calMatches
          .map((e) => ({ e, ts: e.start ? new Date(e.start).getTime() : NaN }))
          .filter((x) => !isNaN(x.ts) && x.ts >= Date.now())
          .sort((a, b) => a.ts - b.ts)[0];
        const pastCals = calMatches
          .map((e) => ({ e, ts: e.start ? new Date(e.start).getTime() : NaN }))
          .filter((x) => !isNaN(x.ts) && x.ts < Date.now())
          .sort((a, b) => b.ts - a.ts);

        // Decide which scheduling check to run
        const daysSinceThreadActivity = (Date.now() - lastThreadTs) / 86400000;
        const threadActiveRecently = lastThreadTs > subMs && daysSinceThreadActivity < 3;

        // Run scheduling detection
        const signal = await llmDetectScheduling({
          candidateName, company,
          calendar: calMatches.length ? calMatches : calendar.slice(0, 25),
          gmail: gmailHits,
          context: pastCalMatch ? "post_interview" : "intro_stall",
          meetingTimeIso: pastCalMatch?.start ?? null,
          knownCandidateEmail,
          clientDomain,
        });

        // Persist any new candidate email the LLM inferred
        if (signal.candidate_email) {
          const inferred = extractEmail(signal.candidate_email);
          const cd = (clientDomain ?? "").toLowerCase();
          const ownE = (ownGoogleEmail ?? "").toLowerCase();
          if (
            inferred && inferred !== ownE &&
            (!cd || !inferred.endsWith(`@${cd}`)) &&
            inferred !== (knownCandidateEmail ?? "").toLowerCase()
          ) {
            try {
              await saveCandidateEmail({
                admin, userId, slackSubmissionId: sub.id,
                email: inferred, source: "llm", confidence: 0.7,
              });
            } catch (e) { console.error("save cand email llm", e); }
          }
        }


        // Build signals timeline
        type Signal = {
          kind: "introduced" | "scheduled" | "interviewed" | "upcoming" | "last_reply" | "email";
          label: string; at: string; source: string;
        };
        const signals: Signal[] = [];
        signals.push({
          kind: "introduced", label: "Introduced in Slack",
          at: new Date(subMs).toISOString(), source: "Slack",
        });
        if (signal.outcome === "scheduled" && signal.scheduled_time) {
          const t = new Date(signal.scheduled_time).getTime();
          if (!isNaN(t)) {
            signals.push({
              kind: "scheduled",
              label: upcomingCal?.e.summary
                ? `Scheduled: ${upcomingCal.e.summary}`
                : (pastCals[0]?.e.summary ? `Scheduled: ${pastCals[0].e.summary}` : "Interview scheduled"),
              at: new Date(t).toISOString(),
              source: signal.evidence?.startsWith("calendar") ? "Google Calendar" : "Detected via email",
            });
          }
        }
        if (upcomingCal) signals.push({
          kind: "upcoming", label: `Upcoming: ${upcomingCal.e.summary || "(untitled)"}`,
          at: new Date(upcomingCal.ts).toISOString(), source: "Google Calendar",
        });
        if (pastCals[0]) signals.push({
          kind: "interviewed", label: `Interviewed: ${pastCals[0].e.summary || "(untitled)"}`,
          at: new Date(pastCals[0].ts).toISOString(), source: "Google Calendar",
        });
        const recentGmail = gmailHits
          .map((g) => ({ g, ts: g.date ? new Date(g.date).getTime() : NaN }))
          .filter((x) => !isNaN(x.ts))
          .sort((a, b) => b.ts - a.ts)[0];
        if (recentGmail) signals.push({
          kind: "email", label: `Email: ${(recentGmail.g.subject || "(no subject)").slice(0, 80)}`,
          at: new Date(recentGmail.ts).toISOString(),
          source: `Gmail · ${recentGmail.g.from || "unknown sender"}`,
        });
        if (lastThreadTs > subMs) signals.push({
          kind: "last_reply", label: "Last Slack reply",
          at: new Date(lastThreadTs).toISOString(), source: "Slack thread",
        });
        signals.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
        const lastEvent = signals[0]
          ? { ...signals[0], detail: threadExcerpt ? threadExcerpt.slice(0, 160) : undefined }
          : null;

        let kind: "intro_stall" | "post_interview_followup" | null = null;
        let payload: Record<string, unknown> = {};
        let snoozeUntil: string | null = null;
        let suppressedReason: string | null = null;

        if (!pastCalMatch) {
          // intro_stall path
          if (signal.outcome === "scheduled") {
            suppressedReason = `scheduled_via_${signal.evidence?.toLowerCase().includes("calendar") ? "calendar" : "email"}`;
            // If future scheduled time exists, schedule a re-check
            if (signal.scheduled_time) {
              const t = new Date(signal.scheduled_time).getTime();
              if (!isNaN(t) && t > Date.now()) {
                snoozeUntil = new Date(t + 86400000).toISOString();
              }
            }
          } else if (signal.outcome === "interview_completed") {
            // Interview already happened per email — snooze for a few days to give client time to respond
            suppressedReason = "interview_completed_via_email";
            snoozeUntil = new Date(Date.now() + 3 * 86400000).toISOString();
          } else if (signal.outcome === "scheduling_in_progress") {
            suppressedReason = "scheduling_in_progress";
            const fu = signal.suggested_followup_at ? new Date(signal.suggested_followup_at).getTime() : NaN;
            snoozeUntil = !isNaN(fu) && fu > Date.now()
              ? new Date(fu).toISOString()
              : new Date(Date.now() + 7 * 86400000).toISOString();
          } else if (signal.outcome === "ambiguous") {
            suppressedReason = "ambiguous_signal";
          } else if (threadActiveRecently) {
            suppressedReason = "thread_active";
          } else {
            kind = "intro_stall";
            payload = {
              signal_summary: signal.evidence || "No scheduled meeting found in calendar or recent emails.",
              candidate_email: signal.candidate_email,
              suggested_followup_at: signal.suggested_followup_at ?? undefined,
              slack_permalink: sub.permalink,
              thread_excerpt: threadExcerpt,
              thread_messages: threadMessages,
              last_event: lastEvent,
              signals,
            };
          }
        } else {
          // post-interview path
          // 1. If there's a future calendar event matching this candidate, treat it as next round scheduled
          if (upcomingCal) {
            suppressedReason = "next_round_scheduled_via_calendar";
            snoozeUntil = new Date(upcomingCal.ts + 86400000).toISOString();
          } else if (signal.outcome === "scheduled" && signal.scheduled_time) {
            const t = new Date(signal.scheduled_time).getTime();
            if (!isNaN(t) && t > Date.now()) {
              // Next round scheduled via email — suppress + snooze until day after
              suppressedReason = "next_round_scheduled_via_email";
              snoozeUntil = new Date(t + 86400000).toISOString();
            }
          } else if (signal.outcome === "scheduling_in_progress") {
            suppressedReason = "next_round_scheduling_in_progress";
            const fu = signal.suggested_followup_at ? new Date(signal.suggested_followup_at).getTime() : NaN;
            snoozeUntil = !isNaN(fu) && fu > Date.now()
              ? new Date(fu).toISOString()
              : new Date(Date.now() + 7 * 86400000).toISOString();
          }
          if (!suppressedReason) {
            const meetingMs = new Date(pastCalMatch.start).getTime();
            const daysSinceThread = (Date.now() - lastThreadTs) / 86400000;
            if (daysSinceThread >= 3) {
              kind = "post_interview_followup";
              payload = {
                signal_summary: `Interview took place ${new Date(meetingMs).toLocaleDateString()}; no Slack activity for ${Math.round(daysSinceThread)} days.`,
                candidate_email: signal.candidate_email,
                meeting_time: new Date(meetingMs).toISOString(),
                slack_permalink: sub.permalink,
                thread_excerpt: threadExcerpt,
                thread_messages: threadMessages,
                last_event: lastEvent,
                signals,
              };
            } else {
              suppressedReason = "thread_active_post_interview";
            }
          }
        }

        if (!kind && !snoozeUntil) {
          await admin.from("agent_scan_items").insert({
            user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
            candidate_name: candidateName, client_name: company,
            outcome: suppressedReason ? "suppressed" : "no_signal_needed",
            reason: suppressedReason || "no card needed",
            signal,
          });
          continue;
        }

        // If we have a snooze (suppression with a future re-check), create/update a snoozed card
        if (!kind && snoozeUntil) {
          const snoozeKind: "intro_stall" | "post_interview_followup" =
            pastCalMatch ? "post_interview_followup" : "intro_stall";
          const fnNm = firstName(candidateName);
          const slackMsg = snoozeKind === "intro_stall"
            ? `Hey — wanted to see if ${fnNm} got scheduled, or do I need to bump?`
            : `Hey — any feedback on ${fnNm} from the interview? Happy to share notes from our side too.`;
          const snoozePayload = {
            candidate_name: candidateName,
            company_name: company,
            channel_id: sub.channel_id,
            message_ts: sub.message_ts,
            signal_summary: signal.evidence,
            suggested_followup_at: snoozeUntil,
            slack_permalink: sub.permalink,
            thread_excerpt: threadExcerpt,
            thread_messages: threadMessages,
            last_event: lastEvent,
            signals,
            suggested_slack_message: slackMsg,
          };
          stillRelevant.add(`${sub.id}::${snoozeKind}`);
          const existing = existingByKey.get(`${sub.id}::${snoozeKind}`);
          if (existing) {
            await admin.from("agent_action_cards").update({
              payload: snoozePayload, status: "snoozed", snooze_until: snoozeUntil,
              updated_at: new Date().toISOString(),
            }).eq("id", existing.id);
          } else {
            await admin.from("agent_action_cards").insert({
              user_id: userId, slack_submission_id: sub.id, kind: snoozeKind,
              status: "snoozed", snooze_until: snoozeUntil, payload: snoozePayload,
            });
          }
          await admin.from("agent_scan_items").insert({
            user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
            candidate_name: candidateName, client_name: company,
            outcome: "snoozed_until_scheduled",
            reason: suppressedReason ?? "scheduled_future",
            signal,
          });
          continue;
        }

        const fnNm = firstName(candidateName);
        const suggested_slack_message = kind === "intro_stall"
          ? `Hey — wanted to see if ${fnNm} got scheduled, or do I need to bump?`
          : `Hey — any feedback on ${fnNm} from the interview? Happy to share notes from our side too.`;
        payload = {
          ...payload,
          candidate_name: candidateName,
          company_name: company,
          channel_id: sub.channel_id,
          message_ts: sub.message_ts,
          suggested_slack_message,
        };

        // Hold intro_stall for batching
        if (kind === "intro_stall" && company) {
          const k = companyKey(company);
          if (!stallsByClient.has(k)) stallsByClient.set(k, []);
          stallsByClient.get(k)!.push({ sub, cardPayload: payload });
          // We'll write the card below tentatively; batch sweep may roll it up.
        }

        stillRelevant.add(`${sub.id}::${kind}`);
        const existing = existingByKey.get(`${sub.id}::${kind}`);
        let outcome: string;
        if (existing) {
          await admin.from("agent_action_cards").update({
            payload, status: "open", snooze_until: null,
            updated_at: new Date().toISOString(),
          }).eq("id", existing.id);
          outcome = "card_updated";
        } else {
          await admin.from("agent_action_cards").insert({
            user_id: userId, slack_submission_id: sub.id,
            kind, status: "open", payload,
          });
          cardsCreated++;
          outcome = "card_created";
        }

        await admin.from("agent_scan_items").insert({
          user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
          candidate_name: candidateName, client_name: company,
          outcome, reason: kind, signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("agent-scan iteration error", sub.id, msg);
        await admin.from("agent_scan_items").insert({
          user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
          candidate_name: candidateName, client_name: company,
          outcome: "error", reason: msg,
        });
      }
    }

    // --- Batch follow-ups: roll up clients with ≥ batchThreshold stalls ---
    for (const [cKey, items] of stallsByClient) {
      if (items.length < batchThreshold) continue;
      // Most recent submission's channel
      const sorted = [...items].sort((a, b) =>
        new Date(b.sub.submitted_at).getTime() - new Date(a.sub.submitted_at).getTime());
      const channel_id = sorted[0].sub.channel_id;
      const message_ts = sorted[0].sub.message_ts;
      const clientName = sorted[0].sub.client_name;
      const candNames = sorted.map((s) => s.sub.candidate_name);
      const slackMsg = batchSlackMessage(candNames);

      // Synthetic submission key for the batch card
      const batchKey = sorted[0].sub.id; // anchor on most recent
      const payload = {
        candidate_name: `${candNames.length} candidates`,
        company_name: clientName,
        channel_id, message_ts,
        client_name: clientName,
        candidates: sorted.map((s) => ({
          submission_id: s.sub.id,
          name: s.sub.candidate_name,
          submitted_at: s.sub.submitted_at,
          message_ts: s.sub.message_ts,
        })),
        suggested_slack_message: slackMsg,
        signal_summary: `${candNames.length} candidates at ${clientName} have no scheduling signal.`,
      };

      // Resolve the individual intro_stall cards we just wrote
      for (const it of sorted) {
        const k = `${it.sub.id}::intro_stall`;
        const existing = existingByKey.get(k);
        if (existing) {
          await admin.from("agent_action_cards").update({
            status: "resolved", updated_at: new Date().toISOString(),
          }).eq("id", existing.id);
        } else {
          // Just-inserted card: delete it in favor of batch
          await admin.from("agent_action_cards")
            .delete()
            .eq("user_id", userId)
            .eq("slack_submission_id", it.sub.id)
            .eq("kind", "intro_stall");
        }
        stillRelevant.delete(k);
        await admin.from("agent_scan_items").insert({
          user_id: userId, scan_run_id: runId, slack_submission_id: it.sub.id,
          candidate_name: it.sub.candidate_name, client_name: clientName,
          outcome: "rolled_into_batch", reason: cKey,
        });
      }

      stillRelevant.add(`${batchKey}::batch_followup`);
      const existingBatch = existingByKey.get(`${batchKey}::batch_followup`);
      if (existingBatch) {
        await admin.from("agent_action_cards").update({
          payload, status: "open", snooze_until: null,
          updated_at: new Date().toISOString(),
        }).eq("id", existingBatch.id);
      } else {
        await admin.from("agent_action_cards").insert({
          user_id: userId, slack_submission_id: batchKey,
          kind: "batch_followup", status: "open", payload,
        });
        cardsCreated++;
      }
    }

    // Auto-resolve cards no longer relevant — only on final page
    if (!hasMore) {
      if (isFirstInvocation) {
        for (const [key, c] of existingByKey) {
          if (!stillRelevant.has(key)) {
            await admin.from("agent_action_cards").update({
              status: "resolved", updated_at: new Date().toISOString(),
            }).eq("id", c.id);
            cardsResolved++;
          }
        }
      } else if (runId && userId) {
        const { data: openCards } = await admin
          .from("agent_action_cards")
          .select("id, slack_submission_id, kind")
          .eq("user_id", userId)
          .in("status", ["open", "snoozed"]);
        const { data: items } = await admin
          .from("agent_scan_items")
          .select("slack_submission_id, outcome, reason")
          .eq("scan_run_id", runId);
        const seen = new Set<string>();
        for (const it of items ?? []) {
          if (it.outcome === "card_created" || it.outcome === "card_updated" || it.outcome === "snoozed_until_scheduled") {
            seen.add(`${it.slack_submission_id}::${it.reason === "scheduled_future" || it.reason?.startsWith("scheduled") || it.reason?.startsWith("next_round") ? (it.reason?.includes("post_interview") ? "post_interview_followup" : "intro_stall") : it.reason}`);
          }
        }
        for (const c of openCards ?? []) {
          if (!seen.has(`${c.slack_submission_id}::${c.kind}`)) {
            await admin.from("agent_action_cards").update({
              status: "resolved", updated_at: new Date().toISOString(),
            }).eq("id", c.id);
            cardsResolved++;
          }
        }
      }
    }
  } catch (e) {
    scanError = e instanceof Error ? e.message : "Unknown error";
    console.error("agent-scan fatal", scanError);
  } finally {
    if (runId) {
      const finishPatch: Record<string, unknown> = {
        cards_created: cardsCreated,
        cards_resolved: cardsResolved,
      };
      if (!hasMore) finishPatch.finished_at = new Date().toISOString();
      if (scanError) finishPatch.error = scanError;
      await admin.from("agent_scan_runs").update(finishPatch).eq("id", runId);
    }
  }

  return new Response(JSON.stringify({
    ok: !scanError,
    error: scanError,
    run_id: runId,
    processed,
    cards_created: cardsCreated,
    cards_resolved: cardsResolved,
    has_more: hasMore,
    next_cursor: hasMore ? nextCursor : null,
    gmail_scope_missing: gmailScopeMissing,
    total_eligible: totalEligible,
  }), {
    status: scanError ? 500 : 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
