## Goal
Stop using the LLM for nudge drafts. Use simple, hard-coded templates based on card kind.

## Templates

**1. `intro_stall` (checking if candidate scheduled)** — Slack message to client thread:
- `"Hey — wanted to see if {firstName} got scheduled, or do I need to bump?"`

**2. `post_interview_followup` (asking for feedback)** — Slack message to client thread:
- `"Hey — any feedback on {firstName} from the interview? Happy to share notes from our side too."`

`{firstName}` = first token of `payload.candidate_name`. Falls back to `"the candidate"` if missing.

Email drafts: keep the existing simple non-LLM fallback strings already in `agent-draft/index.ts` (they're not LLM-generated either way and the user only flagged the Slack copy). No change needed there.

## Changes

### `supabase/functions/agent-draft/index.ts`
- Delete `llmDraft` and the `LOVABLE_AI_URL` constant.
- Replace `fallback()` with a single `buildDrafts()` that returns:
  - `slack_message`: from the templates above (per kind)
  - `email_subject` / `email_body`: keep current short email fallback copy
- In the handler: instead of calling `llmDraft`, call `buildDrafts`. Keep the cache-check + cache-write behavior so existing cards don't change unless re-scanned.

### `supabase/functions/agent-scan/index.ts`
- Currently leaves drafts undefined (generated lazily). Optionally pre-fill `suggested_slack_message` directly in the payload at card creation using the same templates so cards show the line immediately without a round-trip. Low-risk one-liner: import/inline the same template helper.

### Re-priming existing cards
Old cards already have LLM-cached `suggested_slack_message` strings. Two options:
- **A. Leave them** — only new cards get the new templates. Simplest.
- **B. One-time clear** — run a migration to null out `payload->>'suggested_slack_message'` on existing open cards so the next render uses the new template.

Recommend **B** so you see the new copy on current cards without re-scanning.

## Out of scope
- No UI changes — `AgentActionCard` already pipes `suggested_slack_message` into the inline composer.
- No template variants/randomization — one canonical line per scenario.