// Structured LLM calls through the Lovable AI gateway (OpenAI-compatible,
// forced tool calls). Same pattern as agent-scan's llmDetectScheduling.
const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

export interface JobMatch { job_id: string | null; job_title: string | null; confidence: "high" | "medium" | "low"; reasoning: string }

/**
 * Which ONE of the client's open jobs was this candidate submitted for?
 * A draft for the recruiter to override, never an autonomous pick. An id
 * the model invents (not in `jobs`) is discarded. Port of
 * AIInterpreter.match_job in the desktop coordinator.
 */
export async function matchJob(writeup: string, jobs: Array<{ id: string; title?: string }>, resumeText: string | null = null): Promise<JobMatch> {
  const none: JobMatch = { job_id: null, job_title: null, confidence: "low", reasoning: "" };
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey || !jobs.length || !writeup.trim()) return { ...none, reasoning: apiKey ? "no jobs or write-up" : "no_llm" };

  const system = `You are helping a recruiter file a candidate under the right job opening.
Given the recruiter's intro write-up for a candidate (and optionally their resume text),
pick which ONE of the client's open jobs the candidate was submitted for.
Match on role type and seniority (e.g. an ML researcher intro goes to the ML role, a
founding/full-stack intro to the product engineer role). If no job clearly fits, return null.`;
  const user = JSON.stringify({
    open_jobs: jobs.map((j) => ({ id: j.id, title: j.title })),
    intro_writeup: writeup.slice(0, 6000),
    resume_text: resumeText ? resumeText.slice(0, 4000) : null,
  }, null, 2);
  const body = (model: string) => ({
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    tools: [{
      type: "function",
      function: {
        name: "pick_job",
        parameters: {
          type: "object",
          properties: {
            job_id: { type: ["string", "null"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            reasoning: { type: "string" },
          },
          required: ["job_id", "confidence", "reasoning"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "pick_job" } },
  });
  const call = async (model: string) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      return await fetch(LOVABLE_AI_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body(model)), signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let r = await call("google/gemini-2.5-flash");
    if (!r.ok && (r.status === 429 || r.status >= 500)) r = await call("google/gemini-2.5-flash-lite");
    if (!r.ok) return { ...none, reasoning: `llm_error_${r.status}` };
    const j = await r.json();
    const tc = j.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc) return { ...none, reasoning: "no_tool_call" };
    const parsed = JSON.parse(tc.function.arguments) as { job_id?: string | null; confidence?: string; reasoning?: string };
    const id = typeof parsed.job_id === "string" && !["null", "none", ""].includes(parsed.job_id.toLowerCase()) ? parsed.job_id : null;
    const job = id ? jobs.find((x) => x.id === id) : undefined;
    if (!job) return { ...none, reasoning: parsed.reasoning || "" };
    const confidence = (["high", "medium", "low"] as const).includes(parsed.confidence as never) ? (parsed.confidence as JobMatch["confidence"]) : "low";
    return { job_id: job.id, job_title: job.title ?? null, confidence, reasoning: parsed.reasoning || "" };
  } catch (e) {
    return { ...none, reasoning: `llm_failed: ${(e as Error)?.message ?? e}` };
  }
}
