# Candidate Compass v2 — rollout runbook

v2 gives every Candidate Labs recruiter the **⋮ → Add to Ashby** Slack shortcut
(uploading under *their own* Ashby login, credited to them) and brings the
cloud app up to the desktop coordinator's business rules. Branch `v2`, one
release, commits "v2 / Package 0…7". Package 1 (per-user sessions, async
upload) lives in `kimbidav/Ashby-automation` PR #8.

Nothing in this release relaxes the standing rules: review-then-write; nothing
client-visible from the bot (modals + DM only); only the clicker's own
submissions; email prefilled at HIGH confidence only; retries never resend a
landed resume or note; confirm-or-skip, never confirm-or-stamp; surface over
suppress; the internal Ashby API stays feature-frozen.

## Order of operations

1. **Extractor first.** Merge Ashby-automation PR #8 (`per-user-sessions`).
   Railway env:
   - `ASHBY_SESSIONS_DIR=/data/sessions` (on the existing volume)
   - `ASHBY_REQUIRE_USER_IDENTITY=1` — write routes require `X-Ashby-User`
     and refuse a token that belongs to a different account
   - `EXTRACTOR_CALLBACK_SECRET=<random>` — signs upload callbacks
   - `SESSION_ENC_KEY=<32 bytes base64>` (optional, encrypts session files)
   Verify `GET /api/health` reports `build: 2026-09-23-per-user-sessions`,
   `require_user_identity: true`.
2. **Migrations 1–2** (Lovable Cloud SQL panel, in this order — pushes do not
   apply DDL):
   `20261001000000_domain_lock_and_oauth_states.sql`,
   `20261001000100_token_column_grants.sql`.
   The domain lock deletes any non-`@candidatelabs.com` user.
3. **Supabase secrets** (Edge Functions → Secrets):
   - `EXTRACTOR_CALLBACK_SECRET` (same value as Railway)
   - `COMPASS_URL=https://candidate-compass.lovable.app` (or the custom domain)
   - already present: `EXTRACTOR_SHARED_SECRET`, `SLACK_CLIENT_ID/SECRET`,
     `SLACK_SIGNING_SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `LOVABLE_API_KEY`
   - optional: `LLM_COMPOSE_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`,
     `COMPOSER_MODEL=claude-sonnet-4-6` (drafts in DK's voice; templates
     otherwise); `ASHBY_LIVE_ARCHIVE_CHECK=0` to disable the live check;
     `ASHBY_LIVE_CHECK_MAX_APPS` (default 60).
4. **Migrations 3–10**, in order:
   `20261002000000_slack_workspaces.sql`,
   `20261002000100_shortcut_sessions_and_uploads.sql` (creates the private
   `shortcut-resumes` bucket), `20261002000200_open_jobs_cache_and_channel_map.sql`,
   `20261003000000_ashby_user_sessions.sql`,
   `20261004000000_snapshot_columns_and_org_health.sql`,
   `20261005000000_agent_settings_timezone.sql`,
   `20261006000000_slack_sync_hygiene.sql`,
   `20261007000000_agent_cards_queue_section_and_act.sql`.
5. **Publish** (merge `v2` → `main`; Lovable deploys the frontend and every
   edge function). `supabase/config.toml` declares `verify_jwt = false` for
   `slack-interactions` and `slack-upload-callback` (Slack and the extractor
   call them without a user JWT; both verify their own signatures).
6. **Slack app** (api.slack.com → the existing Compass app):
   - Add a **bot user** ("Candidate Compass").
   - **Interactivity** on, request URL
     `https://<project>.supabase.co/functions/v1/slack-interactions`.
   - **Message shortcut**: name "Add to Ashby", callback id `add_to_ashby`.
   - Bot scopes: `commands`, `chat:write` — nothing else. The bot never
     joins a client channel.
   - User scopes now include `files:read` (resume PDFs from the intro
     thread) and `search:read` (incremental sync). Everyone re-connects
     Slack once in Compass; until they do, the shortcut reports the resume
     as `scope_missing` and the sync falls back to per-channel history.
   - Workspace admin approves the updated app.
7. **Per recruiter** (Compass → Onboarding): Google sign-in → Connect Slack
   (re-connect if already connected) → **Connect Ashby (yours)** — the
   Chrome extension (`extension/`, load unpacked or Workspace policy) or the
   DevTools paste → optional Google Calendar/Gmail → optional team sync
   session and aliases. Ashby logins expire about weekly; the banner and the
   shortcut's "Reconnect" view route them back.
8. **Pilot**: DK first, then one more recruiter (proves per-identity credit
   and org visibility). One supervised real upload per recruiter on a genuine
   submission of theirs — never a dummy candidate in a client org — checking
   credited-to and org in Ashby afterwards.
9. Company-wide announcement.

## What each package changed (for reviewers)

| Package | Where | Summary |
|---|---|---|
| 0 | migrations 1–2, `_shared/pure/*`, Auth | Domain lock, token column grants, OAuth `state` nonces, shared pure modules (Slack text, company/name matching, chunking, Friday rule, shortcut views/rules) tested by vitest + deno |
| 1 | Ashby-automation PR #8 | Per-user sessions keyed by email (identity verified from `available_identities`), identity-keyed locks, async upload job + signed callback, `credited_to_not_self` guard |
| 2 | `slack-interactions`, `slack-upload-callback`, `_shared/addToAshby.ts` | The shortcut: signed HTTP interactivity, ack ≤1s + `waitUntil`, review modal, duplicate resolution, result modal + DM, channel→org memory learned only on success |
| 3 | `ashby-user-session`, Onboarding, `extension/` | Each recruiter connects their own Ashby login (extension or paste), expiry banner, `?step=ashby` deep link |
| 4 | `_shared/pure/{ashbyMerge,orgHealth,liveCheck}.ts`, `ashby-sync`, `agent-scan`, dashboard | Confirm-or-skip archival with the >50% guard, org blind spots / human-confirmed retirement / learned renames, live archive check at scan start, LinkedIn + nickname-tolerant identity join, derived coverage |
| 7 | `_shared/pure/{emailResolver,calendarReminder}.ts`, `gmail-helper`, `google-calendar-sync` | Surname-anchored, confidence-gated email resolver; 5pm reminders in the recruiter's timezone with identity dedup and deterministic ids |
| 5 | `_shared/pure/slackSync.ts`, `slack-sync`, `slack-events` | Incremental sync, activity-based window, rename hygiene with the Ashby veto, channel-migration dedupe |
| 6 | `_shared/pure/agentRules.ts`, `agent-scan`, `agent-act`, `agent-draft` | Email signals scoped to the client, calendar tier 3 on the ambiguous set only, Friday rule in timezone, per-candidate unscheduled cards, `queue_section`, atomic approve |

## Verification

- `npm run test` — vitest over the frontend and `supabase/functions/_shared/pure`
  (127 tests at the time of writing); `npx tsc --noEmit -p tsconfig.app.json`;
  `npm run lint` (pre-existing findings only in untouched files).
- `cd supabase/functions && deno task check` — type-checks the shared
  modules and every function touched by v2.
- Ashby-automation: `npm test` (sessions, keyed locks, org verification).
- Read-only staging per pilot user: seed → open-jobs on one real client →
  prefill/enrich without submit (the modal's confirm is the only write).
- Integration with recorded, signed Slack payloads against a local
  `supabase functions serve` is still to be scripted (see "Not in this
  release").

## Operating notes

- **"Org not found" means Reconnect Ashby, not Refresh.** The org list is fixed
  when the session is created; a client that added the recruiter since their
  last login is invisible until they reconnect.
- **Uploads return `extractor_busy` during a team sweep**; the sweep and an
  upload cannot share an org context.
- **Blind spots banner** (Pipeline page): clients with live rows the last
  sweep could not see. Restore access in Ashby or *Retire* the client — never
  inferred, and retired rows are "access lost", not Archived.
- **A sweep that outruns the timeout is discarded silently** by the extractor
  side; the live archive check at the start of every scan is the last line of
  defence, not a replacement for a persisted refresh.
- **Slack sync** is incremental; shift-click Sync for a full rescan (also
  automatic weekly).

## Not in this release

- Proactive Slack DM when a recruiter's Ashby login expires (today: click-time
  error view + dashboard banner).
- Recorded-payload integration tests for `slack-interactions`.
- The public Ashby API migration (the write path sits behind
  `_shared/extractor.ts` and the `steps{}` contract so it can be swapped
  underneath).
