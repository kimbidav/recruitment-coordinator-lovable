import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

function firstName(full: string): string {
  return (full || "").trim().split(/\s+/)[0] || full;
}

interface DraftArgs {
  kind: "intro_stall" | "post_interview_followup";
  candidateName: string;
  company: string;
  recruiterName: string;
  threadExcerpt: string;
}

function fallback(args: DraftArgs) {
  return {
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
}

async function llmDraft(args: DraftArgs) {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  const fb = fallback(args);
  if (!apiKey) return fb;

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
    if (r.status === 429) return { ...fb, _rate_limited: true };
    if (r.status === 402) return { ...fb, _payment_required: true };
    if (!r.ok) return fb;
    const j = await r.json();
    const tc = j.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc) return fb;
    return { ...fb, ...JSON.parse(tc.function.arguments) };
  } catch {
    return fb;
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

    const drafts = await llmDraft({
      kind: card.kind as "intro_stall" | "post_interview_followup",
      candidateName: p.candidate_name ?? "",
      company: p.company_name ?? "",
      recruiterName,
      threadExcerpt: p.thread_excerpt ?? "",
    });

    // Cache onto the card
    const newPayload = {
      ...p,
      suggested_slack_message: drafts.slack_message,
      suggested_email_subject: drafts.email_subject,
      suggested_email_body: drafts.email_body,
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
