import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// Agent scan: looks at accepted Slack submissions and produces follow-up cards.
// Card kinds:
//   - intro_stall: accepted ≥ 2 days ago, no scheduling signal in calendar or Gmail
//   - post_interview_followup: meeting happened, no Slack thread activity for 3+ days
// Detection uses Lovable AI (google/gemini-3-flash-preview) for calendar + email scan.

const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

const COMPANY_NOISE = new Set([
  "inc","llc","ltd","co","corp","company","labs","lab","ai","io","hq","the","a",
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
function firstName(full: string): string {
  return (full || "").trim().split(/\s+/)[0] || full;
}

async function refreshGoogleAccess(refreshToken: string) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
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
    maxResults: "250",
    orderBy: "startTime",
  });
  const r = await fetch(
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

interface GmailHit { from: string; to: string; subject: string; snippet: string; date: string }

async function searchGmail(token: string, query: string, max = 8): Promise<GmailHit[]> {
  const lr = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const lj = await lr.json();
  if (!lr.ok) throw new Error(`gmail list: ${JSON.stringify(lj)}`);
  const ids: string[] = (lj.messages ?? []).map((m: any) => m.id);
  const hits: GmailHit[] = [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const r = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const j = await r.json();
        if (!r.ok) return;
        const headers: any[] = j.payload?.headers ?? [];
        const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
        hits.push({
          from: get("From"),
          to: get("To"),
          subject: get("Subject"),
          snippet: j.snippet ?? "",
          date: get("Date"),
        });
      } catch { /* ignore */ }
    }),
  );
  return hits;
}

async function llmDetectSignal(args: {
  candidateName: string;
  company: string;
  calendar: CalEvent[];
  gmail: GmailHit[];
}): Promise<{ scheduled: boolean; scheduled_time: string | null; candidate_email: string | null; reason: string }> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return { scheduled: false, scheduled_time: null, candidate_email: null, reason: "no_llm" };

  const prompt = `Determine if a meeting has been scheduled between the recruiter and the candidate.
Candidate: ${args.candidateName}
Company: ${args.company}

Upcoming calendar events (next 30 days):
${args.calendar.slice(0, 40).map((e, i) => `${i + 1}. "${e.summary}" @ ${e.start} attendees=${e.attendees.join(",")}`).join("\n") || "(none)"}

Recent Gmail threads:
${args.gmail.slice(0, 20).map((h, i) => `${i + 1}. From:${h.from} To:${h.to} Subj:${h.subject} | ${h.snippet}`).join("\n") || "(none)"}

Decide:
- scheduled = true ONLY if there is a clear scheduled meeting between the candidate and someone at the company (calendar event matching candidate first name + company, OR an email confirming a specific date/time).
- scheduled_time = ISO 8601 if known, else null.
- candidate_email = best guess of the candidate's email from the From/To headers (not the recruiter), else null.`;

  const body = {
    model: "google/gemini-3-flash-preview",
    messages: [{ role: "user", content: prompt }],
    tools: [{
      type: "function",
      function: {
        name: "report_signal",
        description: "Report whether a meeting is scheduled.",
        parameters: {
          type: "object",
          properties: {
            scheduled: { type: "boolean" },
            scheduled_time: { type: ["string", "null"] },
            candidate_email: { type: ["string", "null"] },
            reason: { type: "string" },
          },
          required: ["scheduled", "scheduled_time", "candidate_email", "reason"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "report_signal" } },
  };

  const r = await fetch(LOVABLE_AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("llm err", r.status, t);
    return { scheduled: false, scheduled_time: null, candidate_email: null, reason: "llm_error" };
  }
  const j = await r.json();
  const tc = j.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc) return { scheduled: false, scheduled_time: null, candidate_email: null, reason: "no_tool_call" };
  try {
    return JSON.parse(tc.function.arguments);
  } catch {
    return { scheduled: false, scheduled_time: null, candidate_email: null, reason: "parse_error" };
  }
}

async function llmDraft(args: {
  kind: "intro_stall" | "post_interview_followup";
  candidateName: string;
  company: string;
  recruiterName: string;
  threadExcerpt: string;
}): Promise<{ slack_message: string; email_subject: string; email_body: string }> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  const fallback = {
    slack_message: args.kind === "intro_stall"
      ? `Following up on ${args.candidateName} — wanted to make sure they got connected. Let me know if you need anything from my side to get a call scheduled.`
      : `Checking in on ${args.candidateName} — how did the conversation go? Happy to discuss next steps.`,
    email_subject: args.kind === "intro_stall"
      ? `Following up — ${args.company}`
      : `How did your ${args.company} conversation go?`,
    email_body: args.kind === "intro_stall"
      ? `Hi ${firstName(args.candidateName)},\n\nJust checking in to make sure you've been able to connect with the team at ${args.company}. Let me know if there's anything I can help unblock on scheduling.\n\nBest,\n${args.recruiterName}`
      : `Hi ${firstName(args.candidateName)},\n\nWanted to check in after your conversation with ${args.company}. How did it go? Happy to share feedback or talk through next steps.\n\nBest,\n${args.recruiterName}`,
  };
  if (!apiKey) return fallback;

  const prompt = `Write a short, warm, professional Slack reply and a short follow-up email.
Context:
- Recruiter: ${args.recruiterName}
- Candidate: ${args.candidateName}
- Company: ${args.company}
- Card type: ${args.kind === "intro_stall" ? "candidate was introduced but never scheduled a first call" : "interview happened, need to follow up for feedback"}
- Recent Slack thread excerpt: ${args.threadExcerpt || "(none)"}

Slack message: ≤2 sentences, addresses the company contact in the thread.
Email: addressed to the candidate, ≤4 short sentences, signed by the recruiter.`;

  const body = {
    model: "google/gemini-3-flash-preview",
    messages: [{ role: "user", content: prompt }],
    tools: [{
      type: "function",
      function: {
        name: "draft",
        parameters: {
          type: "object",
          properties: {
            slack_message: { type: "string" },
            email_subject: { type: "string" },
            email_body: { type: "string" },
          },
          required: ["slack_message", "email_subject", "email_body"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "draft" } },
  };
  try {
    const r = await fetch(LOVABLE_AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return fallback;
    const j = await r.json();
    const tc = j.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc) return fallback;
    return { ...fallback, ...JSON.parse(tc.function.arguments) };
  } catch {
    return fallback;
  }
}

function fridayFivePmAfter(iso: string, tz: string): string {
  // Compute Friday 5pm of the week AFTER `iso`, expressed in tz, returned as ISO UTC.
  const d = new Date(iso);
  // Move to next week's Friday 17:00 in tz. Approximation: use date math in UTC then return.
  const day = d.getUTCDay(); // 0..6 (Sun..Sat)
  const daysUntilNextFri = ((5 - day + 7) % 7) + 7; // at least next week
  const target = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilNextFri, 17 + 8, 0, 0,
  ));
  // 17 + 8 = approx PT->UTC offset; we don't have a true tz lib, this is "good enough"
  // for surfacing a recommended timestamp. Client renders with its own locale.
  void tz;
  return target.toISOString();
}

async function fetchSlackThread(token: string, channelId: string, ts: string) {
  const r = await fetch(
    `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${ts}&limit=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  if (!j.ok) return { messages: [] as any[] };
  return { messages: j.messages ?? [] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

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
    const userId = userData.user.id;
    const recruiterEmail = userData.user.email ?? "";
    const recruiterName = recruiterEmail.split("@")[0] || "Me";

    const body = await req.json().catch(() => ({}));
    const tz: string = body.tz ?? "America/Los_Angeles";

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Start scan run
    const { data: runRow } = await admin
      .from("agent_scan_runs")
      .insert({ user_id: userId, started_at: new Date().toISOString() })
      .select("id")
      .single();
    const runId = runRow?.id;

    // Load accepted Slack submissions
    const { data: subs } = await admin
      .from("slack_submissions")
      .select("id, channel_id, message_ts, client_name, candidate_name, status, submitted_at, permalink, linkedin_url")
      .eq("user_id", userId)
      .eq("status", "accepted")
      .order("submitted_at", { ascending: false })
      .limit(80);

    // Load slack token
    const { data: slackTok } = await admin
      .from("slack_tokens").select("access_token").eq("user_id", userId).maybeSingle();

    // Load google token + refresh if needed
    const { data: gTok } = await admin
      .from("google_calendar_tokens").select("*").eq("user_id", userId).maybeSingle();

    let googleAccess: string | null = gTok?.access_token ?? null;
    if (gTok) {
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
    }

    // Pre-fetch calendar window
    let calendar: CalEvent[] = [];
    if (googleAccess) {
      const now = new Date();
      const to = new Date(now.getTime() + 30 * 86400000);
      try {
        calendar = await listCalendarEvents(googleAccess, now.toISOString(), to.toISOString());
      } catch (e) {
        console.error("calendar fetch", e);
      }
    }

    let cardsCreated = 0;
    let cardsResolved = 0;

    // Load existing open cards for this user to detect resolutions
    const { data: existingCards } = await admin
      .from("agent_action_cards")
      .select("id, slack_submission_id, kind, status")
      .eq("user_id", userId)
      .in("status", ["open", "snoozed"]);
    const existingByKey = new Map<string, { id: string; status: string }>();
    for (const c of existingCards ?? []) {
      existingByKey.set(`${c.slack_submission_id}::${c.kind}`, { id: c.id, status: c.status });
    }
    const stillRelevant = new Set<string>();

    for (const sub of subs ?? []) {
      const ageMs = Date.now() - new Date(sub.submitted_at).getTime();
      const ageDays = ageMs / 86400000;
      if (ageDays < 2) continue;

      const candidateName = sub.candidate_name || "";
      const company = sub.client_name || "";
      if (!candidateName) continue;

      // Filter calendar events by simple substring match before LLM
      const fn = firstName(candidateName).toLowerCase();
      const cKey = companyKey(company);
      const calMatches = calendar.filter((e) => {
        const t = (e.summary || "").toLowerCase();
        const att = e.attendees.join(" ").toLowerCase();
        return t.includes(fn) || (cKey && (companyKey(t) === cKey || companyKey(att) === cKey));
      });

      // Gmail search
      let gmailHits: GmailHit[] = [];
      if (googleAccess) {
        try {
          const q = `"${candidateName.replace(/"/g, "")}" "${company.replace(/"/g, "")}" newer_than:90d`;
          gmailHits = await searchGmail(googleAccess, q, 8);
        } catch (e) {
          console.error("gmail search", e);
        }
      }

      // LLM signal detection
      const signal = await llmDetectSignal({
        candidateName, company, calendar: calMatches.length ? calMatches : calendar.slice(0, 30), gmail: gmailHits,
      });

      // Slack thread activity
      let lastThreadTs = parseFloat(sub.message_ts) * 1000;
      let threadExcerpt = "";
      if (slackTok?.access_token) {
        try {
          const t = await fetchSlackThread(slackTok.access_token, sub.channel_id, sub.message_ts);
          for (const m of t.messages) {
            const tsMs = parseFloat(m.ts) * 1000;
            if (tsMs > lastThreadTs) lastThreadTs = tsMs;
          }
          threadExcerpt = (t.messages.slice(-2).map((m: any) => m.text).join(" • ") || "").slice(0, 400);
        } catch (e) {
          console.error("slack thread", e);
        }
      }

      // Decide card kind
      let kind: "intro_stall" | "post_interview_followup" | null = null;
      let payload: Record<string, unknown> = {};

      if (!signal.scheduled) {
        kind = "intro_stall";
        payload = {
          signal_summary: signal.reason || "No scheduled meeting found in calendar or recent emails.",
          candidate_email: signal.candidate_email,
          suggested_followup_at: fridayFivePmAfter(sub.submitted_at, tz),
          slack_permalink: sub.permalink,
          thread_excerpt: threadExcerpt,
        };
      } else if (signal.scheduled_time) {
        const meetingMs = new Date(signal.scheduled_time).getTime();
        if (!isNaN(meetingMs) && meetingMs < Date.now()) {
          const daysSinceThread = (Date.now() - lastThreadTs) / 86400000;
          if (daysSinceThread >= 3) {
            kind = "post_interview_followup";
            payload = {
              signal_summary: `Interview took place ${new Date(meetingMs).toLocaleDateString()}; no Slack activity for ${Math.round(daysSinceThread)} days.`,
              candidate_email: signal.candidate_email,
              meeting_time: signal.scheduled_time,
              slack_permalink: sub.permalink,
              thread_excerpt: threadExcerpt,
            };
          }
        }
      }

      if (!kind) continue;

      const draft = await llmDraft({
        kind, candidateName, company, recruiterName, threadExcerpt,
      });
      payload = {
        ...payload,
        candidate_name: candidateName,
        company_name: company,
        channel_id: sub.channel_id,
        message_ts: sub.message_ts,
        suggested_slack_message: draft.slack_message,
        suggested_email_subject: draft.email_subject,
        suggested_email_body: draft.email_body,
      };

      stillRelevant.add(`${sub.id}::${kind}`);
      const existing = existingByKey.get(`${sub.id}::${kind}`);
      if (existing) {
        await admin.from("agent_action_cards").update({
          payload, updated_at: new Date().toISOString(),
        }).eq("id", existing.id);
      } else {
        await admin.from("agent_action_cards").insert({
          user_id: userId,
          slack_submission_id: sub.id,
          kind,
          status: "open",
          payload,
        });
        cardsCreated++;
      }
    }

    // Auto-resolve cards no longer relevant
    for (const [key, c] of existingByKey) {
      if (!stillRelevant.has(key)) {
        await admin.from("agent_action_cards").update({
          status: "resolved", updated_at: new Date().toISOString(),
        }).eq("id", c.id);
        cardsResolved++;
      }
    }

    if (runId) {
      await admin.from("agent_scan_runs").update({
        finished_at: new Date().toISOString(),
        cards_created: cardsCreated,
        cards_resolved: cardsResolved,
      }).eq("id", runId);
    }

    return new Response(JSON.stringify({
      ok: true,
      scanned: subs?.length ?? 0,
      cards_created: cardsCreated,
      cards_resolved: cardsResolved,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("agent-scan error", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
