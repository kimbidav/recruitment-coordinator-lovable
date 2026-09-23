import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

function firstName(full: string): string {
  const f = (full || "").trim().split(/\s+/)[0];
  return f || "the candidate";
}

interface DraftArgs {
  kind:
    | "intro_stall"
    | "post_interview_followup"
    | "batch_followup"
    | "unscheduled_followup"
    | "ashby_needs_scheduling"
    | "ashby_missing_feedback";
  candidateName: string;
  company: string;
  recruiterName: string;
  candidates?: string[];
  stage?: string;
  daysInStage?: number;
}

export function buildDrafts(args: DraftArgs) {
  const fn = firstName(args.candidateName);
  let slack_message: string;
  if (args.kind === "intro_stall") {
    slack_message = `Hey — wanted to see if ${fn} got scheduled, or do I need to bump?`;
  } else if (args.kind === "post_interview_followup") {
    slack_message = `Hey — any feedback on ${fn} from the interview? Happy to share notes from our side too.`;
  } else if (args.kind === "unscheduled_followup") {
    slack_message = `Hey — wanted to check in on ${fn} — any update on next steps? Let me know if I need to bump.`;
  } else if (args.kind === "ashby_needs_scheduling") {
    const stagePart = args.stage ? ` in ${args.stage}` : "";
    const daysPart = typeof args.daysInStage === "number" && args.daysInStage > 0 ? ` for ${args.daysInStage} days` : "";
    slack_message = `Hey team! ${fn} has been${stagePart}${daysPart} — anything I can do to help get the next step scheduled?`;
  } else if (args.kind === "ashby_missing_feedback") {
    slack_message = `Hey team! ${fn} has interviews completed but feedback is still missing in Ashby — any chance we can get scorecards in? Happy to help chase.`;
  } else {
    const list = (args.candidates ?? []).map((n) => `– ${n}`).join("\n");
    slack_message = `Quick status check on:\n${list}\nAny updates?`;
  }
  const email_subject = args.kind === "intro_stall" || args.kind === "ashby_needs_scheduling" || args.kind === "unscheduled_followup"
    ? `Following up — ${args.company}`
    : `How did your ${args.company} conversation go?`;
  const email_body = args.kind === "intro_stall" || args.kind === "ashby_needs_scheduling" || args.kind === "unscheduled_followup"
    ? `Hi ${fn},\n\nJust checking in to make sure you've been able to connect with the team at ${args.company}. Let me know if there's anything I can help unblock on scheduling.\n\nBest,\n${args.recruiterName}`
    : `Hi ${fn},\n\nWanted to check in after your conversation with ${args.company}. How did it go? Happy to share feedback or talk through next steps.\n\nBest,\n${args.recruiterName}`;
  return { slack_message, email_subject, email_body };
}

/**
 * Optional model-written drafts (LLM_COMPOSE_PROVIDER=anthropic). The
 * templates above are the deterministic fallback; the model only rewrites in
 * the same register — friendly, low-pressure, never robotic ("wanted to
 * follow up here on [Name] — any update? Let me know if I need to bump").
 * Clients are relationships, not tickets. Candidate-facing email never uses
 * internal ATS wording.
 */
async function composeWithAnthropic(
  args: DraftArgs & { signalSummary?: string; threadExcerpt?: string },
  fallback: { slack_message: string; email_subject: string; email_body: string },
): Promise<{ slack_message: string; email_subject: string; email_body: string; provider: string }> {
  const provider = (Deno.env.get("LLM_COMPOSE_PROVIDER") ?? "").toLowerCase();
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (provider !== "anthropic" || !apiKey) return { ...fallback, provider: "template" };
  const model = Deno.env.get("COMPOSER_MODEL") ?? "claude-sonnet-4-6";
  const fn = firstName(args.candidateName);
  const prompt = `You draft two short messages for a recruiter at Candidate Labs. Voice: friendly, low-pressure, never robotic — like "wanted to follow up here on ${fn} — any update? Let me know if I need to bump." No bullet points, no sign-off boilerplate in Slack, one to three sentences.

Situation (${args.kind.replace(/_/g, " ")}): ${args.signalSummary ?? "no extra context"}
Candidate: ${args.candidateName}; client: ${args.company}${args.stage ? `; stage: ${args.stage}` : ""}${typeof args.daysInStage === "number" ? `; ${args.daysInStage} days in stage` : ""}
Recent Slack thread excerpt: ${(args.threadExcerpt ?? "").slice(0, 400) || "(none)"}

1. slack_message: a reply to the CLIENT in the intro thread, asking for the update the situation calls for.
2. email_subject and email_body: a check-in to the CANDIDATE from ${args.recruiterName}. Candidate-safe wording only: never mention internal ATS states like "Needs Decision" or "Waiting on Feedback".

Reference drafts you may lightly improve:
Slack: ${fallback.slack_message}
Email subject: ${fallback.email_subject}
Email: ${fallback.email_body}`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 600,
        tools: [{
          name: "drafts", description: "The two drafts.",
          input_schema: { type: "object", properties: { slack_message: { type: "string" }, email_subject: { type: "string" }, email_body: { type: "string" } }, required: ["slack_message", "email_subject", "email_body"] },
        }],
        tool_choice: { type: "tool", name: "drafts" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const j = await res.json().catch(() => ({}));
    const tool = Array.isArray(j.content) ? j.content.find((c: { type?: string }) => c.type === "tool_use") : null;
    const out = tool?.input as { slack_message?: string; email_subject?: string; email_body?: string } | undefined;
    if (!res.ok || !out?.slack_message || !out.email_subject || !out.email_body) return { ...fallback, provider: "template" };
    return { slack_message: out.slack_message.trim(), email_subject: out.email_subject.trim(), email_body: out.email_body.trim(), provider: `anthropic:${model}` };
  } catch (e) {
    console.warn("[agent-draft] anthropic compose failed, using template:", e instanceof Error ? e.message : e);
    return { ...fallback, provider: "template" };
  }
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
    const cardId: string | undefined = body.card_id;
    if (!cardId) {
      return new Response(JSON.stringify({ error: "card_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: card, error: cardErr } = await admin
      .from("agent_action_cards")
      .select("id, user_id, kind, payload")
      .eq("id", cardId)
      .maybeSingle();
    if (cardErr || !card || card.user_id !== userId) {
      return new Response(JSON.stringify({ error: "Card not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const p = (card.payload ?? {}) as Record<string, any>;
    // Return cached drafts when present
    if (p.suggested_slack_message && p.suggested_email_subject && p.suggested_email_body) {
      return new Response(JSON.stringify({
        slack_message: p.suggested_slack_message,
        email_subject: p.suggested_email_subject,
        email_body: p.suggested_email_body,
        cached: true,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const draftArgs: DraftArgs = {
      kind: card.kind as DraftArgs["kind"],
      candidateName: p.candidate_name ?? "",
      company: p.company_name ?? "",
      recruiterName,
      candidates: Array.isArray(p.candidates) ? p.candidates.map((c: any) => c.name).filter(Boolean) : undefined,
      stage: p.ashby_context?.pipeline_stage ?? undefined,
      daysInStage: p.ashby_context?.days_in_stage ?? undefined,
    };
    const drafts = await composeWithAnthropic(
      { ...draftArgs, signalSummary: p.signal_summary, threadExcerpt: p.thread_excerpt },
      buildDrafts(draftArgs),
    );

    // Cache onto the card
    const newPayload = {
      ...p,
      suggested_slack_message: drafts.slack_message,
      suggested_email_subject: drafts.email_subject,
      suggested_email_body: drafts.email_body,
      draft_provider: drafts.provider,
    };
    await admin.from("agent_action_cards").update({
      payload: newPayload, updated_at: new Date().toISOString(),
    }).eq("id", cardId);

    return new Response(JSON.stringify({
      slack_message: drafts.slack_message,
      email_subject: drafts.email_subject,
      email_body: drafts.email_body,
      cached: false,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("agent-draft error", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
