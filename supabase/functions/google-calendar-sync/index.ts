import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { googleAccessToken, GoogleNotConnected } from "../_shared/google.ts";
import { sameCandidateName } from "../_shared/pure/nameMatch.ts";
import { companiesMatch } from "../_shared/pure/companyMatch.ts";
import {
  REMINDER_MINUTES,
  isValidTimeZone,
  localDateOf,
  parseSummary,
  reminderKey,
  reminderSummary,
  stableEventId,
  summaryMatches,
  zonedTimeToUtc,
} from "../_shared/pure/calendarReminder.ts";

// Day-of interview reminders (desktop app: "Google Calendar Sync").
//
// For every upcoming interview in the caller's filtered list, put a 30-minute
// "{First} x {Client}" event at REMINDER_TIME in the recruiter's timezone on
// the interview's local date — so they ask the client for feedback the same
// evening, while it's fresh. Rules that encode business judgment:
//   * Only the caller's own candidates. The org shares one Ashby pipeline, so
//     a stray "Everyone" filter must never schedule a teammate's interviews.
//     Ownership = credited_to_email equals the login email, else the saved
//     recruiter aliases; a BLANK credit passes only with a trusted tracked
//     match (one of the caller's own Slack submissions for the same person
//     at the same client).
//   * Dedup identity = (first-name token, exact normalized client, local
//     date). A lookup failure is an error, never "no duplicate".
//   * A deterministic event id closes the lookup/insert race; a 409 is
//     reported as a duplicate only after the existing event is confirmed
//     live and matching.
//   * dry_run reports what would happen without writing.

const REMINDER_TIME = "17:00";
const DEFAULT_TZ = "America/Los_Angeles";

interface InEvent {
  id: string;
  candidate_name?: string;
  company_name?: string;
  /** YYYY-MM-DD in the recruiter's timezone. Older clients send start_time only. */
  interview_date?: string;
  start_time?: string;
  interview_title?: string;
  credited_to?: string;
  credited_to_email?: string | null;
}

interface Outcome {
  id: string;
  title: string;
  date: string;
  outcome: "created" | "skipped_duplicate" | "skipped_not_mine" | "skipped_invalid" | "would_create" | "error";
  detail?: string;
}

function normalizePersonName(s: string): string {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Tokens from the caller's email local-part, the legacy identity fallback. */
function emailIdentityMatches(email: string, credited: string): boolean {
  const local = (email.split("@")[0] || "").toLowerCase();
  if (!local) return false;
  const tokens = credited.split(" ");
  const parts = local.split(/[._\-+]/).filter(Boolean);
  return (
    (parts.length > 1 && parts.every((p) => tokens.includes(p))) ||
    (parts.length === 1 && tokens.length >= 2 && local.length > 2 && tokens[0].startsWith(local[0]) && local.slice(1) === tokens[tokens.length - 1]) ||
    tokens.includes(local)
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;
    const userEmail = (userData.user.email ?? "").toLowerCase();

    const body = (await req.json()) as { events?: InEvent[]; timezone?: string; dry_run?: boolean };
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length === 0) return json({ error: "No events provided" }, 400);
    const dryRun = body.dry_run === true;

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Timezone: explicit choice (saved for next time) > saved > default.
    const { data: settings } = await admin.from("agent_settings").select("recruiter_aliases,timezone").eq("user_id", userId).maybeSingle();
    const saved = (settings as { recruiter_aliases?: string[]; timezone?: string | null } | null) ?? {};
    let timeZone = DEFAULT_TZ;
    if (typeof body.timezone === "string" && isValidTimeZone(body.timezone)) {
      timeZone = body.timezone;
      if (saved.timezone !== timeZone && !dryRun) {
        await admin.from("agent_settings").upsert({ user_id: userId, timezone: timeZone, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      }
    } else if (saved.timezone && isValidTimeZone(saved.timezone)) {
      timeZone = saved.timezone;
    }
    const aliases = (saved.recruiter_aliases ?? []).map(normalizePersonName).filter(Boolean);

    // Trusted tracked pairs: the caller's own Slack submissions.
    const { data: subs } = await admin.from("slack_submissions").select("candidate_name, client_name").eq("user_id", userId);
    const tracked = ((subs ?? []) as Array<{ candidate_name: string | null; client_name: string | null }>).filter((s) => s.candidate_name && s.client_name);
    const trustedTracked = (name: string, company: string) =>
      tracked.some((s) => sameCandidateName(s.candidate_name!, name) && companiesMatch(s.client_name!, company));

    const isMine = (ev: InEvent): boolean => {
      const email = (ev.credited_to_email ?? "").trim().toLowerCase();
      if (email && userEmail) return email === userEmail;
      const credited = normalizePersonName(ev.credited_to ?? "");
      if (!credited || credited === "unknown") return trustedTracked(ev.candidate_name ?? "", ev.company_name ?? "");
      if (aliases.length > 0) return aliases.includes(credited);
      return emailIdentityMatches(userEmail, credited);
    };

    // Normalise every event into (title, local date) first.
    type Planned = { ev: InEvent; title: string; date: string; key: string; candidate: string; client: string };
    const outcomes: Outcome[] = [];
    const planned: Planned[] = [];
    for (const ev of events) {
      const parsedTitle = ev.interview_title ? parseSummary(ev.interview_title) : null;
      const candidate = (ev.candidate_name ?? parsedTitle?.[0] ?? "").trim();
      const client = (ev.company_name ?? parsedTitle?.[1]?.replace(/\s*\(.*\)\s*$/, "") ?? "").trim();
      const date = localDateOf(ev.interview_date ?? ev.start_time ?? "", timeZone);
      const title = reminderSummary(candidate, client);
      if (!candidate || !client || !date) {
        outcomes.push({ id: ev.id, title: ev.interview_title ?? title, date, outcome: "skipped_invalid", detail: "missing candidate, client or date" });
        continue;
      }
      if (!isMine(ev)) {
        outcomes.push({ id: ev.id, title, date, outcome: "skipped_not_mine", detail: "Not credited to you" });
        continue;
      }
      planned.push({ ev, title, date, key: reminderKey(candidate, client, date), candidate, client });
    }
    const skippedNotMine = outcomes.filter((o) => o.outcome === "skipped_not_mine").length;
    if (planned.length === 0) {
      return json({
        success: true, created: 0, skipped: 0, skipped_not_mine: skippedNotMine, total: events.length, errors: [], timezone: timeZone, results: outcomes,
        message: skippedNotMine ? `No events created — all ${skippedNotMine} selected interviews belong to other recruiters.` : "No valid events to create.",
      });
    }

    let token: Awaited<ReturnType<typeof googleAccessToken>>;
    try {
      token = await googleAccessToken(admin, userId);
    } catch (e) {
      if (e instanceof GoogleNotConnected) return json({ error: "Google Calendar not connected", code: "google_not_connected" }, 401);
      throw e;
    }
    const accessToken = token.access_token;
    const gcal = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

    // Duplicate lookup over the whole date range. Failure here is an error
    // for every planned event — "couldn't check" is not "no duplicate".
    const existingKeys = new Set<string>();
    const times = planned.map((p) => zonedTimeToUtc(p.date, "00:00", timeZone).getTime());
    const timeMin = new Date(Math.min(...times) - 86_400_000).toISOString();
    const timeMax = new Date(Math.max(...times) + 2 * 86_400_000).toISOString();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", maxResults: "2500", showDeleted: "false" });
      if (pageToken) params.set("pageToken", pageToken);
      const listRes = await fetch(`${gcal}?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!listRes.ok) {
        const t = await listRes.text();
        return json({ error: `Calendar lookup failed (${listRes.status}): ${t.slice(0, 200)}. Nothing was created.` }, 502);
      }
      const listJson = await listRes.json();
      for (const item of listJson.items ?? []) {
        if (item.status === "cancelled") continue;
        const summary: string = item.summary ?? "";
        const start: string = item.start?.dateTime ?? item.start?.date ?? "";
        const parsed = parseSummary(summary);
        if (!parsed || !start) continue;
        const [cand, cli] = parsed;
        const day = localDateOf(start, timeZone);
        existingKeys.add(reminderKey(cand, cli, day));
        existingKeys.add(reminderKey(cand, cli.replace(/\s*\(.*\)\s*$/, ""), day));
      }
      pageToken = listJson.nextPageToken;
    } while (pageToken);

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const p of planned) {
      if (existingKeys.has(p.key)) {
        skipped++;
        outcomes.push({ id: p.ev.id, title: p.title, date: p.date, outcome: "skipped_duplicate", detail: "Already on your calendar" });
        continue;
      }
      if (dryRun) {
        outcomes.push({ id: p.ev.id, title: p.title, date: p.date, outcome: "would_create" });
        continue;
      }
      const start = zonedTimeToUtc(p.date, REMINDER_TIME, timeZone);
      const end = new Date(start.getTime() + REMINDER_MINUTES * 60_000);
      const eventId = await stableEventId(p.candidate, p.client, p.date);
      try {
        const res = await fetch(gcal, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            id: eventId,
            summary: p.title,
            start: { dateTime: start.toISOString(), timeZone },
            end: { dateTime: end.toISOString(), timeZone },
            extendedProperties: { private: { candidate_compass: "interview_reminder", candidate: p.candidate, client: p.client, date: p.date } },
          }),
        });
        if (res.status === 409) {
          // Same id already exists: a concurrent insert or an earlier run.
          // Only a live, matching event counts as a duplicate.
          const got = await fetch(`${gcal}/${eventId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
          const existing = got.ok ? await got.json() : null;
          if (existing && existing.status !== "cancelled" && summaryMatches(existing.summary ?? "", p.candidate, p.client)) {
            skipped++;
            existingKeys.add(p.key);
            outcomes.push({ id: p.ev.id, title: p.title, date: p.date, outcome: "skipped_duplicate", detail: "Already on your calendar" });
          } else {
            const why = existing?.status === "cancelled" ? "a deleted reminder with the same identity blocks the id" : "event id conflict with an unrelated event";
            errors.push(`${p.title} (${p.date}): ${why}`);
            outcomes.push({ id: p.ev.id, title: p.title, date: p.date, outcome: "error", detail: why });
          }
          continue;
        }
        if (!res.ok) {
          const t = await res.text();
          errors.push(`${p.title} (${p.date}): ${res.status} ${t.slice(0, 120)}`);
          outcomes.push({ id: p.ev.id, title: p.title, date: p.date, outcome: "error", detail: `${res.status}` });
          continue;
        }
        const createdJson = await res.json();
        if (!createdJson?.id) {
          errors.push(`${p.title} (${p.date}): Google returned no event id`);
          outcomes.push({ id: p.ev.id, title: p.title, date: p.date, outcome: "error", detail: "no event id" });
          continue;
        }
        created++;
        existingKeys.add(p.key);
        outcomes.push({ id: p.ev.id, title: p.title, date: p.date, outcome: "created" });
      } catch (err) {
        const m = err instanceof Error ? err.message : "err";
        errors.push(`${p.title} (${p.date}): ${m}`);
        outcomes.push({ id: p.ev.id, title: p.title, date: p.date, outcome: "error", detail: m });
      }
    }

    const wouldCreate = outcomes.filter((o) => o.outcome === "would_create").length;
    const notMineNote = skippedNotMine > 0 ? `, ${skippedNotMine} other recruiters' skipped` : "";
    const message = dryRun
      ? `Preview: ${wouldCreate} reminder${wouldCreate === 1 ? "" : "s"} would be created, ${skipped} already exist${notMineNote}.`
      : skipped > 0
        ? `Created ${created} reminder${created === 1 ? "" : "s"} (${skipped} already existed${notMineNote})`
        : `Created ${created}/${planned.length} reminder${planned.length === 1 ? "" : "s"}${notMineNote}`;
    return json({ success: true, dry_run: dryRun, created, would_create: wouldCreate, skipped, skipped_not_mine: skippedNotMine, total: events.length, errors, timezone: timeZone, results: outcomes, message });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return json({ error: msg }, 500);
  }
});
