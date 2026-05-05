import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

function firstName(full: string): string {
  const f = (full || "").trim().split(/\s+/)[0];
  return f || "the candidate";
}

interface DraftArgs {
  kind: "intro_stall" | "post_interview_followup" | "batch_followup";
  candidateName: string;
  company: string;
  recruiterName: string;
  candidates?: string[];
}

export function buildDrafts(args: DraftArgs) {
  const fn = firstName(args.candidateName);
  let slack_message: string;
  if (args.kind === "intro_stall") {
    slack_message = `Hey — wanted to see if ${fn} got scheduled, or do I need to bump?`;
  } else if (args.kind === "post_interview_followup") {
    slack_message = `Hey — any feedback on ${fn} from the interview? Happy to share notes from our side too.`;
  } else {
    const list = (args.candidates ?? []).map((n) => `– ${n}`).join("\n");
    slack_message = `Quick status check on:\n${list}\nAny updates?`;
  }
  const email_subject = args.kind === "intro_stall"
    ? `Following up — ${args.company}`
    : `How did your ${args.company} conversation go?`;
  const email_body = args.kind === "intro_stall"
    ? `Hi ${fn},\n\nJust checking in to make sure you've been able to connect with the team at ${args.company}. Let me know if there's anything I can help unblock on scheduling.\n\nBest,\n${args.recruiterName}`
    : `Hi ${fn},\n\nWanted to check in after your conversation with ${args.company}. How did it go? Happy to share feedback or talk through next steps.\n\nBest,\n${args.recruiterName}`;
  return { slack_message, email_subject, email_body };
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

    const drafts = buildDrafts({
      kind: card.kind as DraftArgs["kind"],
      candidateName: p.candidate_name ?? "",
      company: p.company_name ?? "",
      recruiterName,
      candidates: Array.isArray(p.candidates) ? p.candidates.map((c: any) => c.name).filter(Boolean) : undefined,
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
