import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// Agent scan: looks at accepted Slack submissions and produces follow-up cards.
// Card kinds:
//   - intro_stall: accepted ≥ 2 days ago, no scheduling signal in calendar or Gmail
//   - post_interview_followup: meeting happened, no Slack thread activity for 3+ days
// Detection uses Lovable AI (google/gemini-3-flash-preview) for calendar + email scan.
// Drafts (Slack/email) are generated lazily via the agent-draft function — not here.

const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const BATCH_LIMIT = 25; // submissions processed per invocation

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
    maxResults: "500",
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

Calendar events (past 60 days through next 30 days):
${args.calendar.slice(0, 50).map((e, i) => `${i + 1}. "${e.summary}" @ ${e.start} attendees=${e.attendees.join(",")}`).join("\n") || "(none)"}

Recent Gmail threads:
${args.gmail.slice(0, 20).map((h, i) => `${i + 1}. From:${h.from} To:${h.to} Subj:${h.subject} | ${h.snippet}`).join("\n") || "(none)"}

Decide:
- scheduled = true ONLY if there is a clear scheduled meeting between the candidate and someone at the company (calendar event matching candidate first name + company, OR an email confirming a specific date/time). Past meetings count.
- scheduled_time = ISO 8601 if known, else null. May be in the past.
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

function fridayFivePmAfter(iso: string, _tz: string): string {
  const d = new Date(iso);
  const day = d.getUTCDay();
  const daysUntilNextFri = ((5 - day + 7) % 7) + 7;
  const target = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilNextFri, 17 + 8, 0, 0,
  ));
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
    const cursor: string | null = body.cursor ?? null; // ISO timestamp; process submissions submitted strictly AFTER this
    const reuseRunId: string | undefined = body.run_id;

    // Start (or reuse) scan run
    if (reuseRunId) {
      runId = reuseRunId;
    } else {
      const { data: runRow } = await admin
        .from("agent_scan_runs")
        .insert({ user_id: userId, started_at: new Date().toISOString() })
        .select("id")
        .single();
      runId = runRow?.id;
    }

    // Load slack token
    const { data: slackTok } = await admin
      .from("slack_tokens").select("access_token").eq("user_id", userId).maybeSingle();

    // Load google token + refresh; check Gmail scope
    const { data: gTok } = await admin
      .from("google_calendar_tokens").select("*").eq("user_id", userId).maybeSingle();

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

    // Calendar window: past 60d → next 30d
    let calendar: CalEvent[] = [];
    if (googleAccess) {
      const now = new Date();
      const from = new Date(now.getTime() - 60 * 86400000);
      const to = new Date(now.getTime() + 30 * 86400000);
      try {
        calendar = await listCalendarEvents(googleAccess, from.toISOString(), to.toISOString());
      } catch (e) {
        console.error("calendar fetch", e);
      }
    }

    // Load accepted Slack submissions (oldest-first within window), paginated by cursor
    const eligibilityCutoff = new Date(Date.now() - 2 * 86400000).toISOString();
    let q = admin
      .from("slack_submissions")
      .select("id, channel_id, message_ts, client_name, candidate_name, status, submitted_at, permalink, linkedin_url")
      .eq("user_id", userId)
      .eq("status", "accepted")
      .lte("submitted_at", eligibilityCutoff)
      .order("submitted_at", { ascending: true })
      .limit(BATCH_LIMIT + 1); // +1 to detect has_more
    if (cursor) q = q.gt("submitted_at", cursor);
    const { data: subsRaw } = await q;
    const subs = subsRaw ?? [];
    hasMore = subs.length > BATCH_LIMIT;
    const batch = hasMore ? subs.slice(0, BATCH_LIMIT) : subs;

    // Existing open/snoozed cards (only relevant if first invocation; resolution is done at end of full run)
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
      // For continuation calls, only load existing cards for this batch's submissions
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

    for (const sub of batch) {
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

        // Pre-filter calendar events by candidate first name OR normalized company
        const fn = firstName(candidateName).toLowerCase();
        const cKey = companyKey(company);
        const calMatches = calendar.filter((e) => {
          const t = (e.summary || "").toLowerCase();
          const att = e.attendees.join(" ").toLowerCase();
          return t.includes(fn) || (cKey && (companyKey(t) === cKey || companyKey(att).includes(cKey)));
        });

        // Gmail search: candidate-name only (companies vary; company added as soft hint)
        let gmailHits: GmailHit[] = [];
        if (googleAccess && !gmailScopeMissing) {
          try {
            const q = `"${candidateName.replace(/"/g, "")}" newer_than:120d`;
            gmailHits = await searchGmail(googleAccess, q, 10);
          } catch (e) {
            console.error("gmail search", e);
          }
        }

        // LLM signal detection
        const signal = await llmDetectSignal({
          candidateName, company,
          calendar: calMatches.length ? calMatches : calendar.slice(0, 30),
          gmail: gmailHits,
        });

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
            // Keep up to the last 8 messages for in-card preview
            threadMessages = t.messages.slice(-8).map((m: any) => ({
              ts: m.ts,
              user: m.user || m.username || m.bot_id || undefined,
              text: (m.text || "").slice(0, 1000),
              at: new Date(parseFloat(m.ts) * 1000).toISOString(),
            }));
          } catch (e) {
            console.error("slack thread", e);
          }
        }

        // Prefer past calendar event for "meeting happened" detection
        const pastCalMatch = calMatches.find((e) => {
          const ts = e.start ? new Date(e.start).getTime() : NaN;
          return !isNaN(ts) && ts < Date.now();
        });

        // Build a "last known event" we can display on the card so the user
        // can see what we observed and where we got it from.
        type LastEvent = { kind: string; label: string; at: string; source: string; detail?: string };
        const candidates: LastEvent[] = [];
        // Slack: last reply in thread (if any newer than the original submission)
        const subMs = parseFloat(sub.message_ts) * 1000;
        if (lastThreadTs > subMs) {
          candidates.push({
            kind: "slack_reply",
            label: "Last Slack reply in thread",
            at: new Date(lastThreadTs).toISOString(),
            source: "Slack thread",
            detail: threadExcerpt ? threadExcerpt.slice(0, 160) : undefined,
          });
        }
        // Slack: original submission
        candidates.push({
          kind: "slack_submission",
          label: "Submitted in Slack",
          at: new Date(subMs).toISOString(),
          source: "Slack channel",
        });
        // Calendar: most recent past meeting
        const pastCals = calMatches
          .map((e) => ({ e, ts: e.start ? new Date(e.start).getTime() : NaN }))
          .filter((x) => !isNaN(x.ts) && x.ts < Date.now())
          .sort((a, b) => b.ts - a.ts);
        if (pastCals[0]) {
          candidates.push({
            kind: "calendar_past",
            label: `Interview held: ${pastCals[0].e.summary || "(untitled)"}`,
            at: new Date(pastCals[0].ts).toISOString(),
            source: "Google Calendar",
          });
        }
        // Calendar: next upcoming meeting
        const upcomingCal = calMatches
          .map((e) => ({ e, ts: e.start ? new Date(e.start).getTime() : NaN }))
          .filter((x) => !isNaN(x.ts) && x.ts >= Date.now())
          .sort((a, b) => a.ts - b.ts)[0];
        if (upcomingCal) {
          candidates.push({
            kind: "calendar_upcoming",
            label: `Upcoming interview: ${upcomingCal.e.summary || "(untitled)"}`,
            at: new Date(upcomingCal.ts).toISOString(),
            source: "Google Calendar",
          });
        }
        // Gmail: most recent matching email
        const recentGmail = (gmailHits || [])
          .map((g: any) => ({ g, ts: g.date ? new Date(g.date).getTime() : NaN }))
          .filter((x) => !isNaN(x.ts))
          .sort((a, b) => b.ts - a.ts)[0];
        if (recentGmail) {
          candidates.push({
            kind: "gmail",
            label: `Email: ${(recentGmail.g.subject || "(no subject)").slice(0, 80)}`,
            at: new Date(recentGmail.ts).toISOString(),
            source: `Gmail · ${recentGmail.g.from || "unknown sender"}`,
          });
        }
        const lastEvent = candidates
          .filter((c) => !!c.at)
          .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0] ?? null;

        let kind: "intro_stall" | "post_interview_followup" | null = null;
        let payload: Record<string, unknown> = {};

        if (!signal.scheduled && !pastCalMatch) {
          kind = "intro_stall";
          payload = {
            signal_summary: signal.reason || "No scheduled meeting found in calendar or recent emails.",
            candidate_email: signal.candidate_email,
            suggested_followup_at: fridayFivePmAfter(sub.submitted_at, tz),
            slack_permalink: sub.permalink,
            thread_excerpt: threadExcerpt,
            last_event: lastEvent,
          };
        } else {
          // Determine meeting time: past calendar match wins; else parse signal
          let meetingMs = pastCalMatch?.start ? new Date(pastCalMatch.start).getTime() : NaN;
          if (isNaN(meetingMs) && signal.scheduled_time) {
            const t = new Date(signal.scheduled_time).getTime();
            if (!isNaN(t)) meetingMs = t;
          }
          if (!isNaN(meetingMs) && meetingMs < Date.now()) {
            const daysSinceThread = (Date.now() - lastThreadTs) / 86400000;
            if (daysSinceThread >= 3) {
              kind = "post_interview_followup";
              payload = {
                signal_summary: `Interview took place ${new Date(meetingMs).toLocaleDateString()}; no Slack activity for ${Math.round(daysSinceThread)} days.`,
                candidate_email: signal.candidate_email,
                meeting_time: new Date(meetingMs).toISOString(),
                slack_permalink: sub.permalink,
                thread_excerpt: threadExcerpt,
                last_event: lastEvent,
              };
            }
          }
        }

        if (!kind) {
          await admin.from("agent_scan_items").insert({
            user_id: userId, scan_run_id: runId, slack_submission_id: sub.id,
            candidate_name: candidateName, client_name: company,
            outcome: "no_signal_needed",
            reason: signal.scheduled
              ? "scheduled — no follow-up needed yet"
              : (pastCalMatch ? "past meeting found, thread still active" : "no card needed"),
            signal,
          });
          continue;
        }

        payload = {
          ...payload,
          candidate_name: candidateName,
          company_name: company,
          channel_id: sub.channel_id,
          message_ts: sub.message_ts,
          // drafts intentionally omitted — generated on demand by agent-draft
        };

        stillRelevant.add(`${sub.id}::${kind}`);
        const existing = existingByKey.get(`${sub.id}::${kind}`);
        let outcome: string;
        if (existing) {
          await admin.from("agent_action_cards").update({
            payload, updated_at: new Date().toISOString(),
          }).eq("id", existing.id);
          outcome = "card_updated";
        } else {
          await admin.from("agent_action_cards").insert({
            user_id: userId,
            slack_submission_id: sub.id,
            kind,
            status: "open",
            payload,
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

    // Auto-resolve only on the FINAL invocation of a run (no more pages).
    // To avoid resolving cards we haven't yet re-scanned, we do this only when !hasMore AND first invocation
    // OR when it's the last continuation — caller decides by stopping. Safest: resolve when !hasMore.
    if (!hasMore && isFirstInvocation) {
      // Resolve cards whose submissions weren't marked relevant in this single-batch run
      for (const [key, c] of existingByKey) {
        if (!stillRelevant.has(key)) {
          await admin.from("agent_action_cards").update({
            status: "resolved", updated_at: new Date().toISOString(),
          }).eq("id", c.id);
          cardsResolved++;
        }
      }
    }
    // Note: for multi-page runs, resolution is best handled by a separate sweeper or on the final page
    // by re-loading all open cards and comparing against agent_scan_items for this run_id.
    if (!hasMore && !isFirstInvocation && runId && userId) {
      const { data: openCards } = await admin
        .from("agent_action_cards")
        .select("id, slack_submission_id, kind")
        .eq("user_id", userId)
        .in("status", ["open", "snoozed"]);
      const { data: items } = await admin
        .from("agent_scan_items")
        .select("slack_submission_id, outcome, reason")
        .eq("scan_run_id", runId);
      const seenAsRelevant = new Set<string>();
      for (const it of items ?? []) {
        if (it.outcome === "card_created" || it.outcome === "card_updated") {
          seenAsRelevant.add(`${it.slack_submission_id}::${it.reason}`);
        }
      }
      for (const c of openCards ?? []) {
        if (!seenAsRelevant.has(`${c.slack_submission_id}::${c.kind}`)) {
          await admin.from("agent_action_cards").update({
            status: "resolved", updated_at: new Date().toISOString(),
          }).eq("id", c.id);
          cardsResolved++;
        }
      }
    }
  } catch (e) {
    scanError = e instanceof Error ? e.message : "Unknown error";
    console.error("agent-scan fatal", scanError);
  } finally {
    if (runId) {
      // Only finalize the run when there are no more pages
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
  }), {
    status: scanError ? 500 : 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
