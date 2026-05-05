## Context

Today `agent-scan` only uses Gmail as supporting context for the LLM signal call. The LLM is asked one yes/no ("scheduled?") and Gmail hits are pre-fetched by candidate name only. There is no domain-aware client search, no separate "scheduled-via-email" check for `post_interview_followup` suppression, no batching, and no `suggested_followup_at` enforcement. `accepted` already means ✅ reaction (good), but the 2-day threshold is a flat constant. Pagination caps at 6×25=150.

I'd ship #1, #2, #3, #6, #7 and the pagination fix now. #5 (threshold) and #4-tier-3 (LLM calendar match) are smaller wins — proposing a lighter take. Details below.

---

## 1. Email-based scheduling detection (intro_stall)

Today: `llmDetectSignal` gets up to 20 gmail hits, but the prompt is generic and Gmail search is candidate-name only. Result: a client email "let's chat Thursday" rarely surfaces, especially when the candidate isn't on the thread.

Change:
- Add `searchClientEmails(token, clientName, candidateName, domainHint)` — runs two Gmail queries:
  1. `from:@{domain} OR to:@{domain}` scoped to last 30d, candidate name in body if present
  2. Fallback: `"{candidateName}" newer_than:30d` (current behavior)
- Add a dedicated detector `detectEmailScheduling({ candidateName, company, emails })` calling Lovable AI with a tool schema:
  ```
  { scheduled_via_email: bool,
    scheduled_time_iso: string|null,   // "next Thursday" → resolved against email date
    confidence: "high"|"medium"|"low",
    evidence_snippet: string }
  ```
- In the `intro_stall` branch: if `scheduled_via_email` is high/medium confidence, do NOT create a card; instead write `agent_scan_items.outcome="suppressed_email_scheduled"` with the snippet for diagnostics. If `scheduled_time_iso` exists, store on the (suppressed) signal so we can reuse it.
- Cache the LLM call per `(submission_id, last_email_id)` in memory to avoid double-spending tokens when paginating.

## 2. Email-scheduled-next-round suppression (post_interview_followup)

In the post-interview branch, before queueing a card:
- Run the same `detectEmailScheduling` over emails dated after the past interview's `meeting_time`.
- If a future scheduled time is detected (high/medium), suppress the card and set `payload.suggested_followup_at` to that time + 1 business day so it can re-surface later (see #8).

## 3. Smarter calendar matching (3-tier light)

Replace the current `firstName || companyKey` filter with:
1. **Exact**: `summary` contains candidate first name AND normalized company key
2. **Fuzzy**: candidate first name OR initials + company token; also `lastName` token; also "{firstName} x {Company}" / "{firstName} / {Company}" pattern regex (covers "Yi x Altara", "Fan / Decagon", "Jane × Acme")
3. **LLM tiebreak (only when 0 tier-1+2 matches AND we still have ambiguous candidates)**: send up to 15 candidate event titles + the candidate/company to the LLM with a `pick_matching_events` tool returning indices + confidence. Capped at one LLM call per submission.

This avoids tier-3 cost on the 80% of submissions that match cleanly.

## 4. Client domain learning

Add table `client_domain_cache`:
```
user_id uuid, client_name text, domain text, source text ('inferred'|'llm'|'manual'),
confidence numeric, learned_at timestamptz, primary key (user_id, client_name)
```
Two-pass flow inside `agent-scan`:
1. Look up cached domain. If hit → use it.
2. If miss → infer (`{slug}.com`, `get{slug}.{com|ai|io}`) and run Gmail search; if ≥1 hit, accept inferred domain.
3. If still miss → run a small LLM call given the company name + 5 most-recent inbox sender domains to pick the right one; cache result with `source='llm'`.

RLS: standard `auth.uid() = user_id`.

## 5. Threshold tuning (low-priority)

Keep `status='accepted'` as the gate (✅ reaction — confirmed in `slack-sync`). Bump `intro_stall` eligibility from 2 → 3 days AND require `lastThreadTs == subMs` (no replies at all in the thread). Also add a config row in `agent_settings` (new tiny table, `user_id` PK) with `intro_stall_min_days` so users can tune later. Default 3.

## 6. Batch follow-ups

New card kind `batch_followup`:
- After per-submission processing, group `intro_stall` candidates by `client_name` (normalized).
- If a client has ≥3 stalls, suppress the individual cards (mark `agent_scan_items.outcome="rolled_into_batch"`) and create one `batch_followup` card with payload:
  ```
  { client_name, channel_id (most recent), candidates: [{name, submitted_at, message_ts}],
    suggested_slack_message: "Quick status check on: – Name1 – Name2 – Name3. Any updates?" }
  ```
- `AgentActionCard` gets a small variant for `batch_followup` rendering the candidate list and posting to the most recent channel.
- Resolution sweep: if any candidate in the batch resolves on the next scan, drop them from the batch payload; resolve the batch card when the list is empty.

## 7. `suggested_followup_at` enforcement

`useAgentCards.visibleCards` already filters snoozed. Add: if `payload.suggested_followup_at > now()` AND the card was created with that future date (i.e., we *know* something is scheduled later), treat it as snoozed until that time. Implementation:
- In `agent-scan`, when we suppress via #2, write a card with `status='snoozed'`, `snooze_until=suggested_followup_at`, kind=`post_interview_followup` so it auto-surfaces after the next round date passes without their reply.
- Update `visibleCards` to honor `snooze_until` (already does) — no UI change needed.

## 8. Pagination + progress

- Bump `BATCH_LIMIT` to 50 and `MAX_PAGES` to 20 (1000 submissions per scan).
- Stream progress to the client: include `total_eligible` (computed once on first invocation via a `count` query) in the response. `useAgentCards.runScan` accumulates and exposes `{processed, total, pagesDone}`. `AgentTab` shows `Scanning… 142 / 487` instead of just a spinner.
- Add a hard timeout guard: if a single page takes >25s, log and return `has_more=true` with current cursor so the client retries cleanly.

## 9. Gemini false-negative mitigation

- Switch the signal-detection model to `google/gemini-2.5-pro` for the `intro_stall` decision only (cost is fine — one call per submission). Keep `2.5-flash` for everything else.
- Add an explicit ambiguity bucket to the tool schema: `outcome: "scheduled" | "not_scheduled" | "ambiguous"`. Treat `ambiguous` as "do not create card; write diagnostic" so we don't generate noisy nudges on phrases like "let me circle back".

---

## Files to change

- `supabase/functions/agent-scan/index.ts` — items #1, #2, #3, #5, #6, #8, #9
- `supabase/functions/agent-draft/index.ts` — add `batch_followup` template
- `src/hooks/useAgentCards.ts` — `runScan` returns `{processed, total}`; type `AgentCard["kind"]` adds `"batch_followup"`
- `src/components/AgentTab.tsx` — progress label during scan; queue ordering includes batch first
- `src/components/AgentActionCard.tsx` — `batch_followup` rendering variant
- New migration: `client_domain_cache`, `agent_settings`, add `'batch_followup'` to allowed kinds (no enum, just a check or doc)

## Out of scope

- Auto-sending nudges
- Per-recipient personalization in batch messages
- Replacing the LLM signal entirely with deterministic rules (Gemini-with-ambiguity is the lighter fix)
- Offer/rejection card kinds

## Open question

For batch grouping: do you want the threshold at **3** stalls per client (your suggestion) or **2**? At 2 you get more batching but also batch a lot of pairs. I'd default to 3 and make it tunable via `agent_settings`.
