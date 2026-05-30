# Make email scheduling signal name-agnostic

## Problem

Real scheduling threads rarely contain the candidate's full name in the body. Today's logic loses them because:

1. **Gmail query is full-name only** — `"Te-Lin Wu" newer_than:120d`. Threads addressed "Hi Ken," with a Calendly link never come back.
2. **The client-domain query is unbound** — it pulls *all* client-domain mail from 60d and hopes the LLM stitches it to the right candidate. Noisy and easy to mis-attribute.
3. **No candidate email is ever learned/cached** — even after we successfully detect one via the LLM, we throw it away. Next scan starts from zero.
4. **LLM prompt assumes the candidate name appears in the email** — it has no instruction for "this thread is between the client recruiter and an unknown counterparty whose first name matches our candidate."

## Fix

### 1. Learn & cache the candidate email
Add a small table `candidate_emails`:
- `user_id`, `slack_submission_id`, `email`, `source` ("calendar" | "llm" | "manual"), `confidence`, `learned_at`
- Unique on `(user_id, slack_submission_id, email)`
- Populated when: a calendar attendee matches the candidate, or the LLM returns `candidate_email`, or you set it manually.

This persists across scans so we only have to discover an email once.

### 2. Multi-query Gmail strategy (in order, dedup hits, cap ~15)
For each submission:
1. **If candidate email known** → `(from:{email} OR to:{email}) newer_than:120d` (strongest signal)
2. **Calendar-attendee email** → if a matched calendar event has a non-internal attendee, query that address the same way
3. **First name + client domain** → `"{firstName}" (from:@{domain} OR to:@{domain}) newer_than:60d`
4. **Scheduling-keyword + client domain** → `(calendly OR "grab time" OR "find a time" OR "set up a time" OR "confirmed for") (from:@{domain} OR to:@{domain}) newer_than:30d` — catches threads where even the first name is absent
5. **Full name fallback** (existing) → `"{candidateName}" newer_than:120d`

Skip steps 3–4 when no domain is learned yet.

### 3. Teach the LLM that name absence is normal
Update the `llmDetectScheduling` prompt:
- State explicitly: "Emails between the client and the candidate often use first name only, or no name at all. Match by email address (sender/recipient domain or known candidate address), not by name in the body."
- Pass the **known candidate email** into the prompt when we have one, so the LLM can confidently attribute threads.
- Add a rule: if a scheduling link is sent to / received from an address on a non-client, non-recruiter domain and the first name plausibly matches, treat as the candidate.

### 4. Persist anything the LLM learns
After `llmDetectScheduling` returns, if `candidate_email` is new, upsert into `candidate_emails`. Next scan starts from the strongest query.

## Files

- **New migration**: create `candidate_emails` table with RLS + grants (authenticated CRUD on own rows).
- **`supabase/functions/agent-scan/index.ts`**:
  - Add `loadCandidateEmail()` / `saveCandidateEmail()` helpers
  - Extract candidate emails from matched calendar events (filter out your own + obvious client domains)
  - Replace the Gmail query block (lines ~658–672) with the 5-tier strategy above
  - Update `llmDetectScheduling` prompt + pass `knownCandidateEmail`
  - On signal return, persist `candidate_email` if present

## Out of scope (mention only)

- A UI to manually set/correct a candidate's email on an action card — would close the loop when the agent can't infer one. Flag if you want it now or as a follow-up.

## Validation

1. Pick 3 known submissions where the current scan misses scheduling (Te-Lin Wu / Preferencemodel + 2 of the email examples you shared).
2. Run scan, inspect `agent_scan_items.signal.evidence` — should now quote the actual scheduling email.
3. Confirm `candidate_emails` got populated.
