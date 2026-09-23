import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { sameCandidateName } from "../_shared/pure/nameMatch.ts";
import { normalizeLinkedin } from "../_shared/pure/slackText.ts";
import { ashbyIsScheduled, runLiveArchiveCheck, selectApplications, type Row as SnapRow } from "../_shared/pure/liveCheck.ts";
import type { ArchiveVerdict } from "../_shared/pure/ashbyMerge.ts";
import { callExtractor } from "../_shared/extractor.ts";
import { normalizeFollowupToFriday as fridayOfWeek } from "../_shared/pure/friday.ts";
import { localDateOf, zonedTimeToUtc, isValidTimeZone } from "../_shared/pure/calendarReminder.ts";
import { canonicalCompany } from "../_shared/pure/companyMatch.ts";
import {
  ambiguousCalendarCandidates,
  emailSignalForClient,
  mayLearnDomain,
  pickShownEvents,
  queueSectionFor,
  unscheduledFollowupGroups,
} from "../_shared/pure/agentRules.ts";

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

// Shared with src/lib/companyMatch.ts — keep these two in sync.
const COMPANY_NOISE = new Set([
  "inc","llc","ltd","co","corp","company","labs","lab","ai","io","hq","the","a",
  "technologies","tech","research","legal","engineering","engineers","eng","ds",
]);
const TRAILING_SUFFIXES = ["labs","lab","legal","technologies","tech","research","engineering","engineers","eng","ds"];
function companyTokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !COMPANY_NOISE.has(t));
}
function companyKey(s: string): string {
  return companyTokens(s).join("");
}
function companyAliases(s: string): Set<string> {
  const tokens = companyTokens(s);
  const aliases = new Set<string>();
  const collapsed = tokens.join("");
  if (collapsed) aliases.add(collapsed);
  if (tokens[0] && tokens[0].length >= 4) aliases.add(tokens[0]);
  if (tokens.length >= 2) aliases.add(tokens.slice(0, 2).join(""));
  if (tokens.length === 1) {
    const single = tokens[0];
    for (const suffix of TRAILING_SUFFIXES) {
      if (single.endsWith(suffix) && single.length - suffix.length >= 4) {
        aliases.add(single.slice(0, -suffix.length));
      }
    }
  }
  return aliases;
}
// Deliberately-separate clients: exact-match only, never fuzzy-collapsed.
// Mirrors SEPARATE_CLIENTS in src/lib/companyMatch.ts — keep in sync.
const SEPARATE_CLIENTS = new Set(["anterior vpe cto"]);
function rawNameKey(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");
}
function companiesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aRaw = rawNameKey(a);
  const bRaw = rawNameKey(b);
  if (SEPARATE_CLIENTS.has(aRaw) || SEPARATE_CLIENTS.has(bRaw)) return aRaw === bRaw;
  const aA = companyAliases(a);
  const bA = companyAliases(b);
  for (const x of aA) if (bA.has(x)) return true;
  const aKey = companyKey(a);
  const bKey = companyKey(b);
  if (aKey && bKey) {
    const shorter = Math.min(aKey.length, bKey.length);
    if (shorter >= 5 && (aKey.startsWith(bKey) || bKey.startsWith(aKey))) return true;
  }
  const [aF] = companyTokens(a);
  const [bF] = companyTokens(b);
  return !!aF && aF === bF && aF.length >= 5;
}
/**
 * Friday-EOW rule for ambiguous scheduling emails ("grabbed a time", no
 * date): follow up on the FRIDAY of the email's week; emails sent Fri-Sun
 * roll to the next Friday. Deterministic — LLM drift can't break the rule.
 * Port of the desktop app's _normalize_followup_to_friday.
 */
/**
 * Friday-EOW rule in the recruiter's timezone (shared pure rule): the
 * follow-up is the Friday of the anchor email's week (Fri–Sun roll to the
 * next Friday), due at 9am local. A Friday already past means the follow-up
 * is due — re-check tomorrow.
 */
function normalizeFollowupToFriday(anchorIso: string | null, tz: string): string {
  const now = new Date();
  const anchorDate = anchorIso ? localDateOf(anchorIso, tz) : null;
  const friday = fridayOfWeek(null, anchorDate || null, now, tz);
  const due = zonedTimeToUtc(friday, "09:00", tz);
  if (due.getTime() <= now.getTime()) return new Date(now.getTime() + 86400000).toISOString();
  return due.toISOString();
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
      // A guessed domain is used for THIS scan; it is only remembered when
      // the model is confident, so a wrong guess can't poison future scans.
      if ((parsed.confidence ?? 0) >= 0.8) {
        await admin.from("client_domain_cache").upsert({
          user_id: userId, client_name: clientName, domain: parsed.domain,
          source: "llm", confidence: parsed.confidence ?? 0.8, learned_at: new Date().toISOString(),
        });
      }
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
  about_this_client?: "true" | "false" | "unclear";
  mentioned_company?: string;
  client_email_domain?: string | null;
  confidence?: "high" | "medium" | "low";
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
- evidence: one short sentence quoting the snippet that drove your decision.
- about_this_client: "true" | "false" | "unclear" — are the emails you based the outcome on about ${args.company} SPECIFICALLY? A candidate often interviews at several companies at once; if the emails concern a different company, set "false", name it in mentioned_company, and answer "not_scheduled" for this company. Never attribute another company's interview or offer to ${args.company}.
- mentioned_company: the company those emails are actually about, if identifiable (empty string if unclear).
- client_email_domain: the email domain of the people at ${args.company} in these emails (e.g. "acme.com"), or null.
- confidence: "high" | "medium" | "low" in the outcome.`;

  const makeBody = (model: string) => ({
    model,
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
            about_this_client: { type: "string", enum: ["true", "false", "unclear"] },
            mentioned_company: { type: "string" },
            client_email_domain: { type: ["string", "null"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["outcome", "scheduled_time", "suggested_followup_at", "candidate_email", "evidence", "about_this_client", "mentioned_company", "client_email_domain", "confidence"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "report_scheduling" } },
  });

  const callModel = (model: string) => fetchWithTimeout(LOVABLE_AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(makeBody(model)),
  });

  let r = await callModel("google/gemini-2.5-pro");
  if (!r.ok && (r.status === 429 || r.status >= 500)) {
    console.warn("scheduling llm primary failed", r.status, "— retrying with gemini-2.5-flash");
    await new Promise((res) => setTimeout(res, 500));
    r = await callModel("google/gemini-2.5-flash");
  }
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
    let tz: string = body.tz ?? "America/Los_Angeles";
    const cursor: string | null = body.cursor ?? null;
    const reuseRunId: string | undefined = body.run_id;

    // settings
    const { data: settings } = await admin
      .from("agent_settings").select("*").eq("user_id", userId).maybeSingle();
    const introStallMinDays: number = settings?.intro_stall_min_days ?? 3;
    if (settings?.timezone && isValidTimeZone(settings.timezone)) tz = settings.timezone;
    // The signed-in recruiter's email is the strongest ownership signal:
    // snapshot rows now carry credited_to_email straight from Ashby, so a
    // row is "mine" when the emails match, with recruiter_aliases as the
    // fallback for legacy rows that only carry a display name.
    let userEmail = "";
    try {
      const { data: userData } = await admin.auth.admin.getUserById(userId);
      userEmail = (userData?.user?.email ?? "").trim().toLowerCase();
    } catch (e) {
      console.warn("agent-scan: could not resolve user email", e);
    }
    // 2+ stale unscheduled candidates at one client is the pattern that means
    // the client has gone quiet (never below 2).
    const batchThreshold: number = Math.max(2, settings?.batch_followup_threshold ?? 2);

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
    // 60-day ACTIVITY window: a loop stays in scope while its last thread
    // activity is inside the window, however old the intro.
    const LOOKBACK_DAYS = 60;
    const windowIso = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const inWindow = `last_activity_at.gte.${windowIso},submitted_at.gte.${windowIso}`;

    // Total count once on first invocation
    if (!cursor) {
      const { count } = await admin
        .from("slack_submissions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "accepted")
        .lte("submitted_at", eligibilityCutoff)
        .or(inWindow);
      totalEligible = count ?? null;
    }

    let q = admin
      .from("slack_submissions")
      .select("id, channel_id, message_ts, client_name, candidate_name, status, submitted_at, permalink, linkedin_url, last_activity_at")
      .eq("user_id", userId)
      .eq("status", "accepted")
      .lte("submitted_at", eligibilityCutoff)
      .or(inWindow)
      .order("submitted_at", { ascending: true })
      .limit(BATCH_LIMIT + 1);
    if (cursor) q = q.gt("submitted_at", cursor);
    const { data: subsRaw } = await q;
    const subs = subsRaw ?? [];
    hasMore = subs.length > BATCH_LIMIT;
    const batch = hasMore ? subs.slice(0, BATCH_LIMIT) : subs;

    const isFirstInvocation = !cursor;
    const existingByKey = new Map<string, { id: string; status: string }>();
    // Cards the user explicitly dismissed/resolved. Without this, every scan
    // re-created an open card for a submission the user just dismissed — the
    // "cards keep coming back" bug. Dismissed = never recreate; resolved =
    // recreate only after a cooldown (the stall may genuinely re-emerge).
    const userClosedByKey = new Map<string, { status: string; updated_at: string }>();
    const indexCards = (cards: Array<{ id: string; slack_submission_id: string | null; kind: string; status: string; updated_at: string }> | null) => {
      for (const c of cards ?? []) {
        // Ashby-derived cards are keyed by (company, candidate) pair and
        // managed by their own pass below — keep them out of the
        // slack_submission_id-keyed index and its auto-resolve sweep.
        if (c.kind.startsWith("ashby_")) continue;
        const key = `${c.slack_submission_id}::${c.kind}`;
        if (c.status === "open" || c.status === "snoozed") {
          existingByKey.set(key, { id: c.id, status: c.status });
        } else if (c.status === "dismissed" || c.status === "resolved") {
          const prev = userClosedByKey.get(key);
          if (!prev || new Date(c.updated_at).getTime() > new Date(prev.updated_at).getTime()) {
            userClosedByKey.set(key, { status: c.status, updated_at: c.updated_at });
          }
        }
      }
    };
    if (isFirstInvocation) {
      const { data: existingCards } = await admin
        .from("agent_action_cards")
        .select("id, slack_submission_id, kind, status, updated_at")
        .eq("user_id", userId);
      indexCards(existingCards);
    } else {
      const ids = batch.map((s) => s.id);
      if (ids.length) {
        const { data: existingCards } = await admin
          .from("agent_action_cards")
          .select("id, slack_submission_id, kind, status, updated_at")
          .eq("user_id", userId)
          .in("slack_submission_id", ids);
        indexCards(existingCards);
      }
    }
    const RESOLVED_RECREATE_COOLDOWN_MS = 3 * 86400000;
    const userSuppression = (key: string): string | null => {
      const closed = userClosedByKey.get(key);
      if (!closed) return null;
      if (closed.status === "dismissed") return "user_dismissed";
      if (Date.now() - new Date(closed.updated_at).getTime() < RESOLVED_RECREATE_COOLDOWN_MS) {
        return "recently_resolved_by_user";
      }
      return null;
    };
    const stillRelevant = new Set<string>();

    // Clients (company_name) tracked in Ashby — we still produce cards for them,
    // but tag them so the UI can show a separate "Ashby pipeline" view and flag
    // candidates with no recent Ashby movement.
    const ASHBY_STALE_DAYS = 3;
    // Normalize company names so "Reducto AI" matches "Reducto", "Foo Inc." matches "Foo", etc.
    const COMPANY_STOPWORDS = new Set([
      "the", "inc", "incorporated", "llc", "ltd", "limited", "co", "corp", "corporation",
      "labs", "lab", "ai", "technologies", "technology", "tech", "research", "io", "app",
      "company", "studios", "studio", "group", "holdings",
    ]);
    // Internal Ashby pipelines that aren't real clients — never produce follow-ups for these.
    const INTERNAL_PIPELINES = new Set([
      "eng candidate review",
      "eng recruiting general",
      "onsites and offers",
    ]);
    const basicNorm = (raw: string) => (raw || "")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
    const isInternalPipeline = (raw: string): boolean => {
      const cleaned = basicNorm(raw);
      return !!cleaned && INTERNAL_PIPELINES.has(cleaned);
    };
    // Load user-defined client aliases (alias → canonical). Applied before normalization
    // so renamed/merged companies (e.g. Climatix → Causal Labs) collapse to one key.
    const aliasMap = new Map<string, string>();
    {
      const { data: aliasRows } = await admin
        .from("client_aliases")
        .select("alias,canonical")
        .eq("user_id", userId);
      for (const r of (aliasRows ?? []) as Array<{ alias: string; canonical: string }>) {
        const k = basicNorm(r.alias);
        if (k && r.canonical) aliasMap.set(k, r.canonical);
      }
    }
    const resolveAlias = (raw: string): string => {
      if (!raw) return raw;
      return aliasMap.get(basicNorm(raw)) ?? raw;
    };
    const normalizeCompany = (raw: string): string => {
      const resolved = resolveAlias(raw);
      if (!resolved) return "";
      const cleaned = basicNorm(resolved);
      const tokens = cleaned.split(" ").filter((t) => t && !COMPANY_STOPWORDS.has(t));
      return tokens.join(" ");
    };
    // Per-(client, candidate) loop routing. The candidates table is the source of truth:
    // a row with ashby_candidate_id set → that specific loop is tracked in Ashby (BOTH or ASHBY-only);
    // a row without ashby_candidate_id → SLACK-only loop for that person at that client.
    // The same candidate can appear in both buckets across different clients.
    const ashbyByCompany = new Map<string, number | null>(); // normalized client -> latest ms, for batch fallback
    const ashbyRawNames: string[] = []; // raw company names ever seen as Ashby (deduped)
    const ashbyRawSeen = new Set<string>();
    const ashbyByPair = new Map<string, { tracked: boolean; latest: number | null }>(); // `${normCompany}::${normName}`
    const normalizeName = (raw: string): string => {
      if (!raw) return "";
      return raw
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    };
    const pairKey = (company: string, name: string) => `${normalizeCompany(company)}::${normalizeName(name)}`;
    const aliasNorms = ((settings?.recruiter_aliases ?? []) as string[])
      .map((a) => normalizeName(a))
      .filter(Boolean);
    // Ownership of a snapshot row. Email from Ashby's creditedTo user wins;
    // recruiter_aliases cover legacy rows. Unattributed rows are NOBODY's —
    // otherwise every teammate gets nagged about the same unowned candidate.
    const isMineRow = (credited: string, email: string): boolean => {
      const e = (email || "").trim().toLowerCase();
      if (e && userEmail) return e === userEmail;
      const c = normalizeName(credited || "");
      if (!c || c === "unknown") return false;
      return aliasNorms.includes(c);
    };
    const mergeAshby = (rawName: string, latest: number | null) => {
      const key = normalizeCompany(rawName);
      if (!key) return;
      const prev = ashbyByCompany.get(key);
      if (prev === undefined) ashbyByCompany.set(key, latest);
      else if (latest != null && (prev == null || latest > prev)) ashbyByCompany.set(key, latest);
      const trimmed = (rawName || "").trim();
      if (trimmed && !ashbyRawSeen.has(trimmed)) {
        ashbyRawSeen.add(trimmed);
        ashbyRawNames.push(trimmed);
      }
    };
    {
      const { data: candRows } = await admin
        .from("candidates")
        .select("company_name,candidate_name,ashby_candidate_id,last_activity_at,current_stage_date,latest_feedback_date")
        .eq("user_id", userId);
      for (const r of (candRows ?? []) as Array<{
        company_name?: string;
        candidate_name?: string;
        ashby_candidate_id?: string | null;
        last_activity_at?: string | null;
        current_stage_date?: string | null;
        latest_feedback_date?: string | null;
      }>) {
        if (!r.company_name || !r.candidate_name) continue;
        const tracked = !!r.ashby_candidate_id;
        const tsList = [r.last_activity_at, r.current_stage_date, r.latest_feedback_date]
          .map((s) => (s ? new Date(s).getTime() : NaN))
          .filter((n) => !isNaN(n));
        const latest = tsList.length ? Math.max(...tsList) : null;
        const k = pairKey(r.company_name, r.candidate_name);
        const prev = ashbyByPair.get(k);
        if (!prev) {
          ashbyByPair.set(k, { tracked, latest });
        } else {
          ashbyByPair.set(k, {
            tracked: prev.tracked || tracked,
            latest: latest != null && (prev.latest == null || latest > prev.latest) ? latest : prev.latest,
          });
        }
        // EVERY company that has an Ashby-sourced candidate row counts as an Ashby
        // company — even if the SPECIFIC pair (company, candidate) wasn't tracked.
        // This is what makes Slack-only candidates at known Ashby companies route
        // to the Ashby pipeline.
        if (tracked) mergeAshby(r.company_name, latest);
      }
    }
    // Also include any client ever seen in an Ashby fetch, even with no current candidates.
    {
      const { data: knownRows } = await admin
        .from("ashby_known_clients")
        .select("client_name")
        .eq("user_id", userId);
      for (const r of (knownRows ?? []) as Array<{ client_name?: string }>) {
        if (r.client_name && !isInternalPipeline(r.client_name)) mergeAshby(r.client_name, null);
      }
    }
    // Org-shared truth (primary, once populated): the authoritative org list
    // covers zero-candidate orgs, and stage_type-bearing snapshot rows give
    // real per-pair coverage + activity. These also feed the Ashby-derived
    // cards and the archived prune below.
    type SnapshotScanRow = {
      ashby_candidate_id: string;
      ashby_job_id: string;
      candidate_name: string;
      company_name: string;
      job_title: string | null;
      pipeline_stage: string | null;
      stage_type: string;
      decision_status: string | null;
      stage_progress: string | null;
      current_stage_index: number;
      total_stages: number;
      days_in_stage: number;
      needs_scheduling: boolean;
      credited_to: string | null;
      feedback_count: number;
      latest_recommendation: string | null;
      latest_feedback_author: string | null;
      latest_feedback_date: string | null;
      current_stage_avg_score: number | null;
      current_stage_date: string | null;
      current_stage_interviews: string | null;
      interview_history_summary: string | null;
      last_activity_at: string | null;
      archived_reason: string | null;
      interview_events: unknown;
      application_id: string | null;
      org_id: string | null;
      linkedin_url: string | null;
      credited_to_email: string | null;
      access_restricted: boolean | null;
      org_status: string | null;
      status_verified_live: string | null;
      status_verified_live_at: string | null;
    };
    const DONE_DECISIONS = new Set(["archived", "hired", "closed", "rejected"]);
    let snapshotRows: SnapshotScanRow[] = [];
    try {
      const { data: orgRows } = await admin.from("ashby_orgs").select("org_name");
      for (const r of (orgRows ?? []) as Array<{ org_name?: string }>) {
        if (r.org_name && !isInternalPipeline(r.org_name)) mergeAshby(r.org_name, null);
      }
      const { data: snapRows } = await admin
        .from("ashby_snapshot_candidates")
        .select(
          "ashby_candidate_id,ashby_job_id,candidate_name,company_name,job_title,pipeline_stage,stage_type,decision_status,stage_progress,current_stage_index,total_stages,days_in_stage,needs_scheduling,credited_to,feedback_count,latest_recommendation,latest_feedback_author,latest_feedback_date,current_stage_avg_score,current_stage_date,current_stage_interviews,interview_history_summary,last_activity_at,archived_reason,interview_events,application_id,org_id,linkedin_url,credited_to_email,access_restricted,org_status,status_verified_live,status_verified_live_at",
        )
        .limit(5000);
      snapshotRows = (snapRows ?? []) as SnapshotScanRow[];

      // Live Ashby archive check (desktop Step 1). The snapshot only changes
      // when a sweep PERSISTS, and sweeps get lost; an Ashby follow-up card
      // should only exist when Ashby agrees there is something to follow up.
      // Verify this recruiter's live applications against Ashby right now
      // (team session, confirm-or-skip) BEFORE the archived/scheduled
      // suppression and Step 5b read the rows. First page only; capped so
      // it fits the edge-function budget (~2s per org switch).
      if (isFirstInvocation && (Deno.env.get("ASHBY_LIVE_ARCHIVE_CHECK") ?? "1") !== "0") {
        try {
          const maxApps = Number(Deno.env.get("ASHBY_LIVE_CHECK_MAX_APPS") ?? 60);
          const apps = selectApplications(
            snapshotRows as unknown as SnapRow[],
            (r) => isMineRow(String(r.credited_to ?? ""), String(r.credited_to_email ?? "")),
            { maxApps },
          );
          if (apps.length) {
            const res = await runLiveArchiveCheck(snapshotRows as unknown as SnapRow[], apps, async (batch) => {
              const r = await callExtractor<{ results?: ArchiveVerdict[] }>(
                "/api/applications/archive-status",
                { applications: batch },
                { timeoutMs: 120_000 },
              );
              if (r.error) throw new Error(String(r.error.body.error ?? r.error.body.detail ?? r.error.status));
              return r.data.results ?? [];
            });
            for (const row of res.changed as unknown as SnapshotScanRow[]) {
              const stamped = row as unknown as Record<string, unknown>;
              await admin.from("ashby_snapshot_candidates").update({
                decision_status: stamped.decision_status ?? null,
                archived_reason: stamped.archived_reason ?? null,
                archived_reason_type: stamped.archived_reason_type ?? null,
                archived_inferred: stamped.archived_inferred ?? null,
                archived_detected_at: stamped.archived_detected_at ?? null,
                archived_verified_live_at: stamped.archived_verified_live_at ?? null,
                status_verified_live: stamped.status_verified_live ?? null,
                status_verified_live_at: stamped.status_verified_live_at ?? null,
                updated_at: new Date().toISOString(),
              }).eq("ashby_candidate_id", row.ashby_candidate_id).eq("ashby_job_id", row.ashby_job_id);
            }
            console.log(
              `[agent-scan] live archive check: ${res.requested} app(s) / ${res.orgs} org(s), answered ${res.answered}, ` +
                `archived ${res.archived.length}, hired ${res.hired.length}, status synced ${res.status_synced.length}, ` +
                `unverifiable ${res.unverifiable}${res.errors.length ? `, errors: ${res.errors.join("; ")}` : ""}`,
            );
            for (const line of [...res.archived.map((l) => `archived: ${l}`), ...res.hired.map((l) => `hired: ${l}`), ...res.status_synced]) {
              console.log(`[agent-scan]   ${line}`);
            }
          }
        } catch (e) {
          // Couldn't check is not evidence — the saved snapshot stands.
          console.warn("[agent-scan] live archive check skipped:", e);
        }
      }

      for (const r of snapshotRows) {
        if (!r.stage_type || !r.company_name) continue; // placeholders never count
        // An org we no longer have access to is not an Ashby client for
        // routing: a card there promises an ATS panel that cannot refresh.
        if (r.org_status === "retired") continue;
        const tsList = [r.last_activity_at, r.current_stage_date, r.latest_feedback_date]
          .map((s) => (s ? new Date(s).getTime() : NaN))
          .filter((n) => !isNaN(n));
        const latest = tsList.length ? Math.max(...tsList) : null;
        mergeAshby(r.company_name, latest);
        if (r.candidate_name) {
          const k = pairKey(r.company_name, r.candidate_name);
          const prev = ashbyByPair.get(k);
          if (!prev) {
            ashbyByPair.set(k, { tracked: true, latest });
          } else {
            ashbyByPair.set(k, {
              tracked: true,
              latest: latest != null && (prev.latest == null || latest > prev.latest) ? latest : prev.latest,
            });
          }
        }
      }
    } catch (e) {
      // Snapshot tables may not exist yet (migration pending) — legacy
      // per-user sources above still drive routing.
      console.error("snapshot routing load failed", e);
    }
    // Archived / scheduled suppression is FUZZY: LinkedIn URL first, then the
    // nickname-tolerant name match, always with a company match (identity is
    // person-level; one candidate runs parallel loops). Exact-name lookups
    // used to leak archived candidates back into the queue (Sai Xiao @
    // Reducto) and whitespace tokenization leaked scheduled ones (Robert Hu @
    // Luminai). An active sibling row always outranks archived history
    // (Charles Lin @ Reducto: archived on one job, live on a no-access one).
    const doneSnapshotRows = snapshotRows.filter(
      (r) => !!r.stage_type && DONE_DECISIONS.has((r.decision_status ?? "").trim().toLowerCase()),
    );
    const liveSnapshotRows = snapshotRows.filter(
      (r) => !!r.stage_type && !DONE_DECISIONS.has((r.decision_status ?? "").trim().toLowerCase()) && r.org_status !== "retired",
    );
    const findSnapshotRow = (pool: SnapshotScanRow[], company: string, name: string, linkedin?: string | null) => {
      const li = normalizeLinkedin(linkedin ?? "");
      return pool.find(
        (r) =>
          companiesMatch(company, r.company_name) &&
          ((!!li && !!r.linkedin_url && normalizeLinkedin(r.linkedin_url) === li) || sameCandidateName(r.candidate_name, name)),
      );
    };
    const isArchivedInAshby = (company: string, name: string, linkedin?: string | null): boolean =>
      !!findSnapshotRow(doneSnapshotRows, company, name, linkedin) && !findSnapshotRow(liveSnapshotRows, company, name, linkedin);
    const scheduledSnapshotRow = (company: string, name: string, linkedin?: string | null): SnapshotScanRow | null => {
      const r = findSnapshotRow(liveSnapshotRows, company, name, linkedin);
      return r && ashbyIsScheduled(r as unknown as SnapRow) ? r : null;
    };
    // Renamed Ashby clients (Forge -> Poetic): a Slack channel keeps the old
    // name, so canonicalize through the alias table before any Ashby lookup.
    const orgAliases: Record<string, string> = {};
    try {
      const { data: aliasRows } = await admin.from("ashby_org_aliases").select("stale_name,current_name,source");
      for (const a of [...((aliasRows ?? []) as Array<{ stale_name: string; current_name: string; source: string }>)].sort((x, y) => (x.source === "manual" ? 1 : 0) - (y.source === "manual" ? 1 : 0))) {
        orgAliases[a.stale_name.trim().toLowerCase()] = a.current_name;
      }
    } catch { /* migration pending */ }
    const lookupAshbyClient = (rawCompanyIn: string): number | null | undefined => {
      const rawCompany = canonicalCompany(rawCompanyIn, orgAliases);
      const key = normalizeCompany(rawCompany);
      if (!key) return undefined;
      // 1. Exact normalized-key hit
      if (ashbyByCompany.has(key)) return ashbyByCompany.get(key)!;
      // 2. Centralized fuzzy match against every raw Ashby client name
      for (const raw of ashbyRawNames) {
        if (companiesMatch(rawCompany, raw)) {
          const k2 = normalizeCompany(raw);
          if (ashbyByCompany.has(k2)) return ashbyByCompany.get(k2)!;
        }
      }
      return undefined;
    };
    const buildFlags = (last: number | null) => {
      const days = last == null ? null : Math.floor((Date.now() - last) / 86400000);
      const stale = last == null ? true : days! >= ASHBY_STALE_DAYS;
      return {
        ashby_tracked: true,
        ashby_last_activity_at: last == null ? null : new Date(last).toISOString(),
        ashby_stale: stale,
        ashby_days_since_activity: days,
      };
    };
    const NOT_TRACKED = { ashby_tracked: false, ashby_last_activity_at: null, ashby_stale: false, ashby_days_since_activity: null } as const;
    // queue_section is authoritative for routing and computed once here.
    const sectionFor = (companyName: string, candidateName?: string) =>
      queueSectionFor(ashbyFlagsFor(companyName, candidateName).ashby_tracked);
    const ashbyFlagsFor = (companyName: string, candidateName?: string): {
      ashby_tracked: boolean;
      ashby_last_activity_at: string | null;
      ashby_stale: boolean;
      ashby_days_since_activity: number | null;
    } => {
      // COMPANY-LEVEL classification first: if this company is known to Ashby
      // (any past fetch ever included it, or there's any Ashby-tracked candidate
      // row for it) then EVERY candidate at this company routes to the Ashby
      // pipeline, including Slack-only submissions. This matches the dashboard.
      const companyHit = lookupAshbyClient(companyName);
      const companyIsAshby = companyHit !== undefined;

      if (candidateName) {
        // Per-pair override: if we have an Ashby row for THIS exact pair, use
        // its real latest-activity timestamp. Otherwise fall back to the
        // company-level decision above.
        const pair = ashbyByPair.get(pairKey(companyName, candidateName));
        if (pair?.tracked) return buildFlags(pair.latest);
        if (companyIsAshby) return buildFlags(companyHit ?? null);
        return { ...NOT_TRACKED };
      }
      // Batch case (no single candidate): company-level only.
      if (companyIsAshby) return buildFlags(companyHit ?? null);
      return { ...NOT_TRACKED };
    };

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
        if (isInternalPipeline(company)) {
          await admin.from("agent_scan_items").insert({
            user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
            candidate_name: candidateName, client_name: company,
            outcome: "skipped_internal_pipeline", reason: "internal Ashby pipeline, not a client",
          });
          continue;
        }
        if (!candidateName) {
          await admin.from("agent_scan_items").insert({
            user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
            candidate_name: candidateName, client_name: company,
            outcome: "skipped_no_name", reason: "no candidate_name",
          });
          continue;
        }
        // Ashby already decided this process is over (Archived/Hired/etc.) —
        // surfacing follow-ups for it would be noise.
        const subLinkedin = (sub as { linkedin_url?: string | null }).linkedin_url ?? null;
        if (isArchivedInAshby(company, candidateName, subLinkedin)) {
          await admin.from("agent_scan_items").insert({
            user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
            candidate_name: candidateName, client_name: company,
            outcome: "suppressed", reason: "archived_in_ashby",
          });
          continue;
        }
        // Ashby already has the next round on the calendar (a future
        // interview event, or a freshly live-verified "Scheduled") — nudging
        // the client to schedule would be noise.
        {
          const sched = scheduledSnapshotRow(company, candidateName, subLinkedin);
          if (sched) {
            await admin.from("agent_scan_items").insert({
              user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
              candidate_name: candidateName, client_name: company,
              outcome: "suppressed", reason: "scheduled_in_ashby",
              signal: { decision_status: sched.decision_status, status_verified_live_at: sched.status_verified_live_at },
            });
            continue;
          }
        }


        // 3-tier calendar matching
        let { matches: calMatches, tier } = calendarMatches({
          candidateName, company, calendar,
        });
        if (tier === "none" && calendar.length) {
          // LLM tiebreak — only when no exact/fuzzy match, and only over the
          // events that carry SOME signal (company token, initial/prefix);
          // it may only pick from the list it was shown.
          const sample = ambiguousCalendarCandidates(calendar, candidateName, company);
          if (sample.length) {
            const idxs = await llmPickCalendarEvents({ candidateName, company, events: sample });
            calMatches = pickShownEvents(sample, idxs);
            if (calMatches.length) tier = "fuzzy";
          }
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

        // Email signals must be about THIS client (the Akshaya Dinesh case):
        // a verdict explicitly about another company is no signal here, and
        // a scheduled verdict needs a current-or-future date.
        {
          const verdict = emailSignalForClient(signal, { clientName: company, scoped: !!clientDomain });
          if (verdict.suppressed) {
            signal.outcome = "not_scheduled";
            signal.scheduled_time = null;
            signal.suggested_followup_at = null;
            signal.candidate_email = null;
            signal.evidence = `Ignored: ${verdict.reason}`;
          } else if (verdict.outcome !== signal.outcome) {
            signal.outcome = verdict.outcome as SchedulingSignal["outcome"];
            signal.evidence = `${signal.evidence} (${verdict.reason})`;
          }
          // Learn the client's domain only when the model is explicit these
          // emails are about this client, at high confidence — this is how
          // the desktop's domain map accumulated cross-wired entries.
          if (!clientDomain && !verdict.suppressed && mayLearnDomain(signal, signal.client_email_domain)) {
            try {
              await admin.from("client_domain_cache").upsert({
                user_id: userId, client_name: company, domain: String(signal.client_email_domain).toLowerCase(),
                source: "email_high", confidence: 0.9, learned_at: new Date().toISOString(),
              });
            } catch (e) { console.error("learn domain", e); }
          }
        }

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
            // Friday-EOW rule, anchored on the most recent email in the
            // thread (falls back to now). Deterministic override of whatever
            // the LLM suggested.
            const anchor = gmailHits
              .map((g) => g.date)
              .filter(Boolean)
              .sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0] ?? null;
            snoozeUntil = normalizeFollowupToFriday(anchor, tz);
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
            // Same Friday-EOW rule as the intro_stall path.
            const anchor = gmailHits
              .map((g) => g.date)
              .filter(Boolean)
              .sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0] ?? null;
            snoozeUntil = normalizeFollowupToFriday(anchor, tz);
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
            ...ashbyFlagsFor(company, candidateName),
          };
          const snoozeKey = `${sub.id}::${snoozeKind}`;
          const existing = existingByKey.get(snoozeKey);
          const closedReason = existing ? null : userSuppression(snoozeKey);
          if (closedReason) {
            await admin.from("agent_scan_items").insert({
              user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
              candidate_name: candidateName, client_name: company,
              outcome: "suppressed", reason: closedReason, signal,
            });
            continue;
          }
          stillRelevant.add(snoozeKey);
          if (existing) {
            await admin.from("agent_action_cards").update({
              payload: snoozePayload, status: "snoozed", snooze_until: snoozeUntil, queue_section: sectionFor(company, candidateName),
              updated_at: new Date().toISOString(),
            }).eq("id", existing.id);
          } else {
            await admin.from("agent_action_cards").insert({
              user_id: userId, slack_submission_id: sub.id, kind: snoozeKind,
              status: "snoozed", snooze_until: snoozeUntil, payload: snoozePayload, queue_section: sectionFor(company, candidateName),
            });
          }
          await admin.from("agent_scan_items").insert({
            user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
            candidate_name: candidateName, client_name: company,
            outcome: "snoozed_until_scheduled",
            reason: suppressedReason ?? "scheduled_future",
            // card_kind makes the final-page auto-resolve able to reconstruct
            // the exact card key (the reason string is not reliable for that).
            signal: { ...signal, card_kind: snoozeKind },
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
          ...ashbyFlagsFor(company, candidateName),
        };

        const cardKey = `${sub.id}::${kind}`;
        const existing = existingByKey.get(cardKey);
        // Respect the user's dismiss/resolve: don't resurrect the card.
        const closedReason = existing ? null : userSuppression(cardKey);
        if (closedReason) {
          await admin.from("agent_scan_items").insert({
            user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
            candidate_name: candidateName, client_name: company,
            outcome: "suppressed", reason: closedReason, signal,
          });
          continue;
        }

        stillRelevant.add(cardKey);
        let outcome: string;
        if (existing) {
          await admin.from("agent_action_cards").update({
            payload, status: "open", snooze_until: null, queue_section: sectionFor(company, candidateName),
            updated_at: new Date().toISOString(),
          }).eq("id", existing.id);
          outcome = "card_updated";
        } else {
          await admin.from("agent_action_cards").insert({
            user_id: userId, slack_submission_id: sub.id,
            kind, status: "open", payload, queue_section: sectionFor(company, candidateName),
          });
          cardsCreated++;
          outcome = "card_created";
        }

        await admin.from("agent_scan_items").insert({
          user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
          candidate_name: candidateName, client_name: company,
          outcome, reason: kind, signal: { ...signal, card_kind: kind },
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

    // --- Unscheduled follow-ups: one card PER CANDIDATE (desktop Step 5) ---
    //
    // Unresponded (not-yet-✅) intros are lower priority and only surface
    // when a client has 2+ stale, quiet, unscheduled candidates — that
    // pattern usually means the CLIENT has gone quiet. Replaces the single
    // "N candidates" batch card: each candidate gets their own card so the
    // reply lands in their own thread. No Slack call here — thread activity
    // comes from the sync's last_activity_at.
    if (isFirstInvocation) {
      try {
        const { data: submittedRows } = await admin
          .from("slack_submissions")
          .select("id, channel_id, message_ts, client_name, candidate_name, status, submitted_at, permalink, linkedin_url, last_activity_at")
          .eq("user_id", userId)
          .eq("status", "submitted")
          .lte("submitted_at", eligibilityCutoff)
          .or(inWindow)
          .limit(2000);
        type SubRow = { id: string; channel_id: string; message_ts: string; client_name: string; candidate_name: string; status: string; submitted_at: string; permalink: string | null; linkedin_url: string | null; last_activity_at: string | null };
        const pool = ((submittedRows ?? []) as SubRow[]).filter((r) => !isInternalPipeline(r.client_name || ""));
        const groups = unscheduledFollowupGroups(pool, {
          threshold: batchThreshold, stallDays: introStallMinDays, quietDays: 3,
          isSuppressed: (r) => isArchivedInAshby(r.client_name, r.candidate_name, (r as SubRow).linkedin_url) || !!scheduledSnapshotRow(r.client_name, r.candidate_name, (r as SubRow).linkedin_url),
        });
        for (const [client, members] of groups) {
          for (const m of members as SubRow[]) {
            const key = `${m.id}::unscheduled_followup`;
            const existing = existingByKey.get(key);
            const closedReason = existing ? null : userSuppression(key);
            if (closedReason) {
              await admin.from("agent_scan_items").insert({
                user_id: userId, scan_run_id: runId, slack_submission_id: m.id,
                candidate_name: m.candidate_name, client_name: m.client_name,
                outcome: "suppressed", reason: closedReason, signal: { card_kind: "unscheduled_followup" },
              });
              continue;
            }
            const fnNm = firstName(m.candidate_name);
            const payload = {
              candidate_name: m.candidate_name,
              company_name: m.client_name,
              channel_id: m.channel_id,
              message_ts: m.message_ts,
              slack_permalink: m.permalink,
              signal_summary: `${members.length} candidates at ${client} have no scheduling signal and the client hasn't responded to ${fnNm}'s intro.`,
              suggested_slack_message: `Hey — wanted to check in on ${fnNm} — any update on next steps? Let me know if I need to bump.`,
              unscheduled_group: { client, count: members.length },
              ...ashbyFlagsFor(m.client_name, m.candidate_name),
            };
            stillRelevant.add(key);
            if (existing) {
              await admin.from("agent_action_cards").update({
                payload, status: "open", snooze_until: null, queue_section: sectionFor(m.client_name, m.candidate_name), updated_at: new Date().toISOString(),
              }).eq("id", existing.id);
            } else {
              await admin.from("agent_action_cards").insert({
                user_id: userId, slack_submission_id: m.id, kind: "unscheduled_followup", status: "open", payload, queue_section: sectionFor(m.client_name, m.candidate_name),
              });
              cardsCreated++;
            }
            await admin.from("agent_scan_items").insert({
              user_id: userId, scan_run_id: runId, slack_submission_id: m.id,
              candidate_name: m.candidate_name, client_name: m.client_name,
              outcome: existing ? "card_updated" : "card_created", reason: "unscheduled_followup", signal: { card_kind: "unscheduled_followup", group: client, count: members.length },
            });
          }
        }
      } catch (e) {
        console.error("unscheduled follow-up pass failed", e);
      }
    }

    // --- Ashby-derived follow-ups (desktop app Step 5b) -----------------------
    //
    // Scan the org-shared snapshot for THIS user's candidates (recruiter
    // aliases) and surface: ashby_needs_scheduling (flagged by Ashby, or 3+
    // days in stage with no upcoming interview) and ashby_missing_feedback
    // (completed interviews with unsubmitted scorecards, date-anchored).
    // Cards carry the full ATS context block and refresh it on every scan
    // (enrichment back-fill), keyed by (company,candidate) pair for dedup.
    if (isFirstInvocation) {
      try {
        const isMine = (credited: string | null, email?: string | null): boolean => isMineRow(credited ?? "", email ?? "");

        // Slack cross-link pool: the user's submissions, matched by fuzzy
        // name+company so the card gets an inline thread.
        const { data: allSubs } = await admin
          .from("slack_submissions")
          .select("id, candidate_name, client_name, channel_id, message_ts, permalink")
          .eq("user_id", userId);
        const subPool = (allSubs ?? []) as Array<{
          id: string; candidate_name: string | null; client_name: string | null;
          channel_id: string; message_ts: string; permalink: string | null;
        }>;
        const findSlackFor = (name: string, company: string) =>
          subPool.find(
            (s) =>
              normalizeName(s.candidate_name ?? "") === normalizeName(name) &&
              companiesMatch(s.client_name ?? "", company),
          ) ?? null;

        // Existing ashby cards, keyed by `${pair}::${kind}`.
        const { data: ashbyCards } = await admin
          .from("agent_action_cards")
          .select("id, kind, status, updated_at, ashby_pair_key")
          .eq("user_id", userId)
          .in("kind", ["ashby_needs_scheduling", "ashby_missing_feedback"]);
        const existingAshby = new Map<string, { id: string; status: string }>();
        const closedAshby = new Map<string, { status: string; updated_at: string }>();
        for (const c of (ashbyCards ?? []) as Array<{ id: string; kind: string; status: string; updated_at: string; ashby_pair_key: string | null }>) {
          if (!c.ashby_pair_key) continue;
          const key = `${c.ashby_pair_key}::${c.kind}`;
          if (c.status === "open" || c.status === "snoozed") {
            existingAshby.set(key, { id: c.id, status: c.status });
          } else if (c.status === "dismissed" || c.status === "resolved") {
            const prev = closedAshby.get(key);
            if (!prev || new Date(c.updated_at).getTime() > new Date(prev.updated_at).getTime()) {
              closedAshby.set(key, { status: c.status, updated_at: c.updated_at });
            }
          }
        }
        const ashbySuppression = (key: string): string | null => {
          const closed = closedAshby.get(key);
          if (!closed) return null;
          if (closed.status === "dismissed") return "user_dismissed";
          if (Date.now() - new Date(closed.updated_at).getTime() < RESOLVED_RECREATE_COOLDOWN_MS) {
            return "recently_resolved_by_user";
          }
          return null;
        };

        const fmtDate = (iso: string) =>
          new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric" });
        const fmtUpcoming = (ev: Record<string, unknown>): string => {
          const title = String(ev.interview_title ?? "Interview");
          const start = String(ev.start_time ?? "");
          const t = Date.parse(start);
          const when = Number.isFinite(t)
            ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
            : "";
          const interviewers = Array.isArray(ev.interviewers) ? (ev.interviewers as Array<Record<string, unknown>>) : [];
          const who = interviewers.length ? ` with ${String(interviewers[0].name ?? "").split(" ")[0]}` : "";
          return `${title}${when ? ` on ${when}` : ""}${who}`;
        };

        const relevantAshby = new Set<string>();
        for (const r of snapshotRows) {
          if (!r.stage_type || !r.candidate_name || !r.company_name) continue;
          if (DONE_DECISIONS.has((r.decision_status ?? "").trim().toLowerCase())) continue;
          if (isInternalPipeline(r.company_name)) continue;
          if (!isMine(r.credited_to, r.credited_to_email)) continue;
          // Restricted-access applications are invisible-not-missing: their
          // events and scheduling status cannot be seen, so "N days in stage
          // with no events" would be a false claim. Retired orgs cannot
          // refresh at all. The Slack/calendar/email steps own those pairs.
          if (r.access_restricted || r.org_status === "retired") continue;

          const events = Array.isArray(r.interview_events)
            ? (r.interview_events as Array<Record<string, unknown>>)
            : [];
          const now = Date.now();
          const timed = events
            .map((ev) => ({ ev, t: Date.parse(String(ev.start_time ?? "")) }))
            .filter((x) => Number.isFinite(x.t));
          const upcoming = timed.filter((x) => x.t > now).sort((a, b) => a.t - b.t)[0];
          const past = timed.filter((x) => x.t <= now).sort((a, b) => b.t - a.t);

          const fnNm = firstName(r.candidate_name);
          const stageLabel = r.pipeline_stage || "their current stage";
          let kind: "ashby_needs_scheduling" | "ashby_missing_feedback" | null = null;
          let summary = "";
          let slackMsg = "";

          const missingFeedback =
            past.length > 0 &&
            past.some((x) =>
              Array.isArray(x.ev.interviewers) &&
              (x.ev.interviewers as Array<Record<string, unknown>>).some(
                (iv) => iv && iv.feedback_submitted === false,
              ),
            );
          if (missingFeedback) {
            kind = "ashby_missing_feedback";
            summary = `${r.candidate_name} has completed interviews with missing feedback. Last interview on ${fmtDate(new Date(past[0].t).toISOString())}.`;
            slackMsg = `Hey team! ${fnNm} has interviews completed but feedback is still missing in Ashby — any chance we can get scorecards in? Happy to help chase.`;
          } else if (!upcoming && !ashbyIsScheduled(r as unknown as SnapRow) && (r.needs_scheduling || r.days_in_stage >= 3)) {
            kind = "ashby_needs_scheduling";
            summary = r.needs_scheduling
              ? `Ashby flags ${r.candidate_name} as needing scheduling in ${stageLabel}.`
              : `${r.candidate_name} has been in ${stageLabel} for ${r.days_in_stage} days with no upcoming interview.`;
            slackMsg = `Hey team! ${fnNm} has been in ${stageLabel} for ${r.days_in_stage} days — anything I can do to help get the next step scheduled?`;
          }
          if (!kind) continue;

          const pk = pairKey(r.company_name, r.candidate_name);
          const cardKey = `${pk}::${kind}`;
          if (relevantAshby.has(cardKey)) continue; // one card per pair+kind
          relevantAshby.add(cardKey);

          const slack = findSlackFor(r.candidate_name, r.company_name);
          const ashbyContext = {
            job_title: r.job_title,
            pipeline_stage: r.pipeline_stage,
            stage_progress: r.stage_progress || (r.total_stages > 0 ? `${r.current_stage_index}/${r.total_stages}` : null),
            decision_status: r.decision_status,
            days_in_stage: r.days_in_stage,
            feedback_count: r.feedback_count,
            avg_score: r.current_stage_avg_score,
            latest_recommendation: r.latest_recommendation,
            upcoming_interview: upcoming ? fmtUpcoming(upcoming.ev) : null,
            current_stage_interviews: r.current_stage_interviews,
            latest_feedback:
              r.latest_feedback_author || r.latest_feedback_date
                ? {
                    author: r.latest_feedback_author,
                    date: r.latest_feedback_date,
                    recommendation: r.latest_recommendation,
                  }
                : null,
            interview_history: r.interview_history_summary,
          };
          const payload = {
            candidate_name: r.candidate_name,
            company_name: r.company_name,
            channel_id: slack?.channel_id,
            message_ts: slack?.message_ts,
            slack_permalink: slack?.permalink ?? undefined,
            signal_summary: summary,
            suggested_slack_message: slackMsg,
            ashby_context: ashbyContext,
            ...ashbyFlagsFor(r.company_name, r.candidate_name),
          };

          const existing = existingAshby.get(cardKey);
          if (existing) {
            // Enrichment back-fill: keep the ATS context fresh every scan.
            await admin.from("agent_action_cards").update({
              payload, queue_section: "ashby", updated_at: new Date().toISOString(),
            }).eq("id", existing.id);
            continue;
          }
          const closedReason = ashbySuppression(cardKey);
          if (closedReason) {
            await admin.from("agent_scan_items").insert({
              user_id: userId, scan_run_id: runId, slack_submission_id: slack?.id ?? null,
              candidate_name: r.candidate_name, client_name: r.company_name,
              outcome: "suppressed", reason: closedReason, signal: { card_kind: kind },
            });
            continue;
          }
          await admin.from("agent_action_cards").insert({
            user_id: userId, slack_submission_id: slack?.id ?? null,
            kind, status: "open", payload, ashby_pair_key: pk, queue_section: "ashby",
          });
          cardsCreated++;
          await admin.from("agent_scan_items").insert({
            user_id: userId, scan_run_id: runId, slack_submission_id: slack?.id ?? null,
            candidate_name: r.candidate_name, client_name: r.company_name,
            outcome: "card_created", reason: kind, signal: { card_kind: kind },
          });
        }

        // Lifecycle: open/snoozed ashby cards whose trigger no longer holds
        // (archived, scheduled, feedback submitted, not mine anymore) resolve.
        for (const [key, c] of existingAshby) {
          if (!relevantAshby.has(key)) {
            await admin.from("agent_action_cards").update({
              status: "resolved", updated_at: new Date().toISOString(),
            }).eq("id", c.id);
            cardsResolved++;
          }
        }
      } catch (e) {
        // ashby_pair_key column or snapshot tables may not exist yet
        // (migrations pending) — the Slack-side scan is unaffected.
        console.error("ashby card pass failed", e);
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
          .select("slack_submission_id, outcome, reason, signal")
          .eq("user_id", userId)
          .eq("scan_run_id", runId);
        const seen = new Set<string>();
        for (const it of items ?? []) {
          if (it.outcome === "card_created" || it.outcome === "card_updated" || it.outcome === "snoozed_until_scheduled") {
            // card_kind is stamped into the signal at every card-write site;
            // reconstructing the kind from the reason string mis-keyed snoozed
            // and batch cards and auto-resolved them right after creating them.
            const ck = (it.signal as { card_kind?: string } | null)?.card_kind;
            const kindGuess = ck ?? (it.reason?.includes("post_interview") ? "post_interview_followup" : "intro_stall");
            seen.add(`${it.slack_submission_id}::${kindGuess}`);
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
      let runUpdate = admin.from("agent_scan_runs").update(finishPatch).eq("id", runId);
      // run_id comes from the request body on paginated calls — scope to the
      // authed user so a forged run_id can't touch another user's run row.
      if (userId) runUpdate = runUpdate.eq("user_id", userId);
      await runUpdate;
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
