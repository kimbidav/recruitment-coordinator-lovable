# Agent reliability + signal coverage fixes

The scan currently times out before reaching most submissions, Gmail returns 403 on every call (token predates the gmail.readonly scope being requested), and we can't tell why a given candidate did/didn't get a card. Five fixes:

## 1. Detect & surface missing Gmail scope (fast + non-noisy)

The OAuth init already requests `gmail.readonly`, but the existing stored Google token only has Calendar scope, so every Gmail call 403s.

- In `agent-scan`, **read `google_calendar_tokens.scope`** once at the top. If it doesn't include `gmail.readonly`, skip Gmail entirely (no 403 spam) and mark the run with `gmail_scope_missing: true`.
- Return `gmail_scope_missing` in the scan response.
- In `AgentTab.tsx`, when the response says scope is missing, show a small banner: **"Gmail signals are off — reconnect Google to enable email-based scheduling detection"** with a button that calls the existing `google-calendar-connect` init flow (forcing `prompt=consent` so Google re-prompts).

## 2. Make the scan resilient and resumable

Current loop dies on the first slow/failing iteration with no partial progress saved.

- Wrap each per-submission block in `try/catch` so one failure can't abort the run; log the error to a new `agent_scan_items` row (see #5) and continue.
- Process submissions **oldest-first within the eligibility window** (≥2 days old), and **persist after each card** (already happens, but ensure no batch buffering).
- **Cap each invocation at 25 submissions**. Track which submissions were processed in this run; if more remain, return `{ has_more: true, next_cursor: <last_submitted_at> }`. The hook auto-invokes again until `has_more = false` (with a max of e.g. 4 chained calls = 100 submissions, safety bound).
- Add an overall scan-level `try/finally` so `agent_scan_runs.finished_at`, `cards_created`, `cards_resolved`, and `error` always get written — even on partial failure.

## 3. Lazy LLM draft generation

Today every candidate triggers two Gemini calls (signal + draft). Drafts are only needed when you click "Reply in Slack" or "Email candidate."

- Remove the `llmDraft` call from the scan loop. Store only the signal-based payload.
- Add a new edge function `agent-draft` that takes `{ card_id }`, looks up the card, generates the Slack/email drafts, and returns them (also caches them onto `payload.suggested_*`).
- In `AgentActionCard.tsx`, when the user clicks Reply in Slack or Email candidate, call `agent-draft` first if the card has no cached draft, then open the existing dialog with `initialReply` / `initialBody`. Show a tiny spinner on the button while drafting (~1–2s).

This roughly halves per-scan LLM calls and dramatically reduces timeout risk.

## 4. Widen calendar window to past 60 days

`post_interview_followup` cards rely on knowing a meeting happened, but we only fetch the **next** 30 days from Calendar. Past interviews are invisible.

- Change `listCalendarEvents` window to `[now - 60d, now + 30d]`.
- Use this expanded set both for the substring pre-filter and the LLM prompt.
- For post-interview detection, prefer matching a past calendar event over the LLM's `scheduled_time` from email (more reliable).

## 5. Per-submission scan diagnostics

Add a small audit table so we can answer "why didn't Minkai/Proximal get a card?"

```sql
create table public.agent_scan_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  scan_run_id uuid not null,
  slack_submission_id uuid,
  candidate_name text,
  client_name text,
  outcome text not null, -- 'card_created' | 'card_updated' | 'no_signal_needed' | 'too_recent' | 'error' | 'skipped_no_name'
  reason text,           -- LLM reason or error message
  signal jsonb,          -- raw signal output
  created_at timestamptz not null default now()
);
-- RLS: users can select their own rows (same pattern as agent_scan_runs).
```

For each submission processed, insert one row with the outcome and the LLM signal JSON (or error). Add a small **"Scan diagnostics"** collapsible at the bottom of the Agent tab listing the most recent run's items, filterable by outcome — so you can see exactly what the agent saw for each candidate.

## Files

**New**
- `supabase/functions/agent-draft/index.ts`
- `supabase/migrations/<ts>_agent_scan_items.sql`
- `src/components/AgentScanDiagnostics.tsx`

**Modified**
- `supabase/functions/agent-scan/index.ts` — scope detection, resilient loop, batching, calendar window, no draft calls, scan_items inserts
- `src/hooks/useAgentCards.ts` — chained re-invoke when `has_more`, expose `gmailScopeMissing`, `lastRunId`
- `src/components/AgentTab.tsx` — Gmail-scope banner with "Reconnect Google", diagnostics panel
- `src/components/AgentActionCard.tsx` — lazy draft fetch on action click

## Open question
For #1's "Reconnect Google" button — the existing `google-calendar-connect` init flow handles re-consent fine, but it currently redirects with `prompt=consent`? I'll verify and force it if not. Nothing for you to decide.
