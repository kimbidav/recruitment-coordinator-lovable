
# Agent Tab — Action Cards

A new "Agent" tab next to the candidate pipeline. The agent scans accepted Slack submissions for two kinds of dropped balls and produces action cards you can act on inline (reply in Slack, email the candidate, dismiss).

## What the agent looks for

**Card type A — "No scheduling signal yet"** (intro stall)
- Trigger: Slack submission has the green ✅ accepted reaction (already tracked as `status='accepted'`), submitted ≥ 2 days ago, and no scheduled call detected.
- Detection (in priority order, via an LLM pass per candidate):
  1. Scan Google Calendar events in the next 30 days for the candidate's first name + company name.
  2. If nothing found, scan Gmail for threads involving the candidate (we infer the candidate's email from past intro emails matching candidate name + company) and look for a confirmed time/date for a meeting.
- If neither signal exists, create a follow-up card. Suggested follow-up timing: Friday 5pm local of the week following the intro email — surfaced as a recommended nudge timestamp on the card (no calendar event is created automatically; user can act on it).

**Card type B — "Post-interview follow-up"**
- Trigger: A scheduling signal exists (calendar event or confirmed email time) AND the meeting time has passed AND no new Slack thread activity for ≥ 3 days since the meeting.
- Action: prompt to follow up in the Slack thread for feedback.

## UI

- Top-level tabs in `Index.tsx`: **Pipeline** (current view) | **Agent** `[N]` badge with open card count.
- Agent view: header with "Refresh" (re-runs detection) and a "Last scan" timestamp; grid of cards grouped by type (Intro Stalls / Post-Interview Follow-ups), then by priority (oldest first).
- Each card shows: candidate name, company, submitter, days since intro (or days since interview), status pill (`No scheduling signal` / `Awaiting feedback`), the original Slack permalink, and a 2-line excerpt of the most recent thread message.
- Card actions:
  - **Reply in Slack** — opens existing `SlackThreadPanel` prefilled with a suggested message (LLM-drafted, editable).
  - **Email candidate** — opens existing `EmailComposer` prefilled with subject + body.
  - **Snooze 3 days** — hides the card until then.
  - **Dismiss** — marks resolved.
- Cards auto-resolve when: (A) a scheduling signal appears, or (B) new thread activity appears after the card was created.

## Backend

New tables (migration):
- `agent_action_cards` — `id, user_id, candidate_row_id (nullable), slack_submission_id, kind ('intro_stall'|'post_interview_followup'), status ('open'|'snoozed'|'dismissed'|'resolved'), snooze_until, payload jsonb (suggested_message, suggested_email_subject, suggested_email_body, suggested_followup_at, signal_summary), created_at, updated_at`. RLS: owner-only (mirrors existing pattern).
- `agent_scan_runs` — `id, user_id, started_at, finished_at, cards_created, error`. RLS: owner-only.

New edge function: `agent-scan` (verify_jwt validated in code, like the others).
1. Loads accepted Slack submissions for the user (`status='accepted'`, not yet resolved).
2. For each, locate the matching Ashby candidate via the same `companyKey` + name match used in `Index.tsx`. Pull recent thread messages via `slack-thread fetch`.
3. Calendar pass: list events from `google_calendar_tokens` user (next 30 days) and pass titles + attendees to Lovable AI (`google/gemini-3-flash-preview`, structured output) along with `{candidate_first_name, company}` → `{matched: bool, event_time?: iso}`.
4. If unmatched, Gmail pass: query Gmail (extend `gmail-helper` with `action='thread_scan'`) for `from:OR to: candidate-name OR company` in the last 60 days; LLM extracts `{candidate_email?, scheduled_time?: iso, confidence}`.
5. Decide card kind:
   - No signal → create `intro_stall` card with `suggested_followup_at` = Friday 5pm local of week after the intro Slack message.
   - Signal + meeting passed + Slack thread silent ≥ 3 days → create `post_interview_followup` card.
6. Generate suggested Slack reply + suggested email (subject/body) with a single LLM call per card.
7. Upsert by `(user_id, slack_submission_id, kind)`; auto-resolve cards whose conditions no longer hold.

Extend `gmail-helper` with `action='thread_scan'` returning normalized message snippets (subject, from, to, snippet, internalDate) for a query string. Extend `google-calendar-sync` (or add small `agent-scan` internal helper) to list events in a date window.

Trigger: client calls `agent-scan` on Agent-tab open and on "Refresh". (Optional later: pg_cron daily run — not in this plan.)

## Frontend changes

- `src/components/AgentTab.tsx` — fetches `agent_action_cards`, renders grouped cards, handles snooze/dismiss/refresh.
- `src/components/AgentActionCard.tsx` — single card with action buttons; opens existing `SlackThreadPanel` and `EmailComposer` with prefilled content.
- `src/pages/Index.tsx` — wrap pipeline content + agent in shadcn `Tabs` (`Pipeline` / `Agent`). Agent tab shows unresolved card count badge from a lightweight count query.
- `src/hooks/useAgentCards.ts` — list cards, mutate (snooze/dismiss), trigger scan.

## Files

Created:
- `supabase/functions/agent-scan/index.ts`
- `src/components/AgentTab.tsx`
- `src/components/AgentActionCard.tsx`
- `src/hooks/useAgentCards.ts`
- migration: `agent_action_cards`, `agent_scan_runs` + RLS

Edited:
- `src/pages/Index.tsx` (add Tabs)
- `supabase/functions/gmail-helper/index.ts` (add `thread_scan` action)
- `src/components/EmailComposer.tsx` and `src/components/SlackThreadPanel.tsx` (accept optional `initialMessage` / `initialSubject` + `initialBody` props for prefill)

## Open question

The "Friday 5pm local" recommendation needs a timezone. I'll default to the browser timezone (sent from client when invoking `agent-scan`); if you'd prefer a fixed timezone (e.g., America/Los_Angeles), say the word and I'll hardcode it.
