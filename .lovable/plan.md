## Goal

Pull every candidate the signed-in user has personally submitted into a CandidateLabs Slack channel, infer the client from the channel name, infer status from emoji reactions, and merge those rows with the existing Ashby data so the dashboard shows the user's complete pipeline.

## How it works (end-to-end)

```text
User clicks "Connect Slack" in the dashboard
        |
        v
[edge fn: slack-connect]  -> redirect to Slack OAuth (user scopes)
        |
        v
Slack -> /slack/callback -> [edge fn: slack-callback]
        - exchanges code for user-token
        - stores in slack_tokens (per Lovable user)
        - records the user's Slack user_id + workspace
        |
        v
User clicks "Sync from Slack" (or auto-runs after connect)
        |
        v
[edge fn: slack-sync]
        1. List external/shared channels the user is in
        2. For each, fetch recent parent messages authored by THIS user
        3. Extract LinkedIn URL + candidate name from each message
        4. Read reactions on the parent message -> derive status
        5. Infer client name from channel name
        6. Upsert into `slack_submissions`
        |
        v
Dashboard merges `candidates` (Ashby) + `slack_submissions` by
(client + normalized name) -> single row, Ashby data preferred,
"Also in Slack" badge added.
```

## Slack auth model

The user picked "Sign in with Slack". The built-in Lovable Slack connector authenticates the workspace owner, not each end-user, so it doesn't fit. Instead we mirror the existing Google Calendar pattern:

1. The user creates (or we provide a manifest for) a custom Slack app with **user token scopes**: `channels:read`, `groups:read`, `channels:history`, `groups:history`, `reactions:read`, `users:read`, `users:read.email`. (These are user-token scopes, not bot scopes — required so we can read messages in any channel the user is already a member of, including external/Slack-Connect channels, without an admin invite.)
2. We add two secrets (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`) — the user pastes them once, same flow Google Calendar uses today.
3. Per-user OAuth tokens are stored in a new `slack_tokens` table (RLS = own-row only), refreshed when expired.

We will surface the manifest JSON and the redirect URI (`{site}/slack/callback`) in the connect dialog so setup is copy-paste.

## Data model (new tables)

`slack_tokens` — one row per Lovable user
- `user_id uuid` (RLS key)
- `slack_user_id text`, `slack_team_id text`, `slack_team_name text`
- `access_token text` (user token), `refresh_token text` nullable, `expires_at timestamptz` nullable
- `scope text`, `created_at`, `updated_at`

`slack_channel_mappings` — auto-discovered channel -> client name, editable
- `user_id uuid`, `channel_id text`, `channel_name text`
- `client_name text` (default = parsed from channel name, user-overridable)
- `enabled boolean default true`
- unique (user_id, channel_id)

`slack_submissions` — one row per parent message authored by the user
- `user_id uuid`, `channel_id text`, `message_ts text` (Slack timestamp = unique id)
- `client_name text`, `candidate_name text`, `linkedin_url text` nullable
- `submitted_at timestamptz`
- `status text` — one of `submitted` | `accepted` | `not_in_process` | `disqualified`
- `raw_text text` (for debugging / re-parse), `permalink text`
- unique (user_id, channel_id, message_ts)

All three tables: RLS `auth.uid() = user_id` (select/insert/update/delete).

## Channel & message parsing rules

**Channel discovery**: call `users.conversations` with `types=public_channel,private_channel,mpim` and `exclude_archived=true`, paginated. Filter to channels where `is_ext_shared = true` OR `is_shared = true` OR `is_org_shared = true` (these are the external client channels). Also include channels whose name matches `candidatelabs-*` as a fallback heuristic. The user can disable any channel from a settings drawer.

**Client name inference** (from channel name):
- `candidatelabs-serval-engineers` -> `Serval`
- `candidatelabs-netic-engineers` -> `Netic`
- `candidatelabs-coderabbit-engineers` -> `CodeRabbit`
- General regex: strip `candidatelabs-` prefix and `-engineers?$` / `-eng$` suffix, then title-case. Editable per-channel mapping handles edge cases.

**"Authored by me" filter**: after fetching `conversations.history`, keep messages where `user === slack_tokens.slack_user_id` and `thread_ts` is absent or equals `ts` (parent messages only).

**Candidate extraction from each message**:
- LinkedIn URL: regex `https?://(www\.)?linkedin\.com/in/[A-Za-z0-9\-_%]+/?` against the raw `text` AND any `<https://...|label>` link spans in `blocks`/`elements`. First match wins.
- Candidate name: prefer the link label text in the message blocks (covers "hyperlinked to candidate's name"). Fallback: characters before the first ` - ` / `—` / `(` after the link. If we can't find a name, still store the row with `candidate_name = ""` so nothing is silently dropped (per the project's completeness rule) and flag it visibly in the UI as "Needs review".

**Status from reactions** (Slack `reactions` array on the parent message; we look at reaction `name`, ignoring who reacted):
- `white_check_mark` present, `no_entry` absent -> `accepted`
- `no_entry` present, `white_check_mark` absent -> `not_in_process`
- both present -> `disqualified`
- neither -> `submitted`

We re-read reactions on every sync so status updates over time.

## Edge functions

All three deploy as Lovable-managed functions (`verify_jwt = false`, validate user JWT in code, same as the Google Calendar functions).

1. **`slack-connect`**: builds the Slack OAuth authorize URL with the user-token scopes above and `state = user.id`. Returns `{ url }` for the frontend to redirect to.

2. **`slack-callback`**: exchanges `code` for tokens via `slack.com/api/oauth.v2.access`, calls `auth.test` to grab the user's `slack_user_id`/team, upserts into `slack_tokens`, redirects to `/?slack=connected`.

3. **`slack-sync`**: 
   - Loads the caller's `slack_tokens` row (refresh if expired and refresh token exists).
   - Lists channels (paginated), upserts into `slack_channel_mappings` (preserving existing `client_name` overrides and `enabled` flag).
   - For each enabled channel: pulls `conversations.history` for the last N days (configurable, default 90), filters to user's parent messages, fetches reactions if not already inline, parses, upserts into `slack_submissions`.
   - Returns `{ channels_scanned, messages_seen, submissions_upserted, missing_name_count }`.
   - Emits a `pipeline_save_reports`-style row so the existing reconciliation pattern catches drops.

Pagination uses `next_cursor`. We chunk Supabase upserts at 500 rows. Same defensive patterns as `usePipelineSession`.

## Frontend changes

**New: `SlackConnectButton.tsx`** (next to `AshbyFetchButton` in `Index.tsx` header)
- "Connect Slack" when no token, "Sync from Slack" once connected.
- First-time dialog includes the Slack app manifest JSON + redirect URI + a field to paste `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` (we trigger `add_secret` for these once).
- Shows last sync timestamp and missing-name count if any.

**New: `/slack/callback` route** -> small page that calls the callback edge fn with `code` + `state`, then routes to `/`.

**New: `SlackChannelSettings.tsx`** (gear icon next to the Slack button)
- Lists discovered channels with toggle (enabled), editable client-name override, last-seen submissions count.

**Merging into the table** (`Index.tsx` + `usePipelineSession.ts`):
- Add a second loader `useSlackSubmissions()` returning `SlackSubmission[]`.
- Build merged list:
  - Key = `normalize(client_name) + "::" + normalize(candidate_name)`.
  - If both Ashby + Slack rows match -> use the Ashby row, attach `slack_meta` (status + submitted_at + permalink).
  - If only Slack -> synthesize a `Candidate` with `source = "slack"`, `pipeline_stage` derived from Slack status (`accepted` -> "In Process", `not_in_process` -> "Not in process", `disqualified` -> "Disqualified", `submitted` -> "Submitted"), `credited_to = current user`, `total_stages = 1`, `current_stage_index = 0`/`1`.
- Filters keep working unchanged (company, stage, status, submitter).

**Table changes** (`CandidateTable.tsx`):
- New small "Source" pill column showing `Ashby` / `Slack` / `Both`.
- For `Both` rows, expanded row shows the Slack permalink + reaction status + submitted date.
- Slack-only rows show LinkedIn link in the expanded section (since there's no interview history).

**Stats** (`DashboardStats.tsx`): include Slack-only rows in totals so the "complete pipeline" headline is honest. Add a line "X submissions tracked from Slack".

## Privacy & scope (per project's core rule)

- Slack scopes are user-token only — we never see channels the user isn't already in.
- We only persist messages the signed-in user authored. Other people's submissions in the same channel are ignored and never stored.
- The connect dialog explicitly lists what we read and store before the OAuth click (no covert collection).
- A "Disconnect Slack" button deletes the token row and (on confirm) all `slack_submissions` for that user.

## Open follow-ups (out of scope for this change)

- Real-time updates via Slack Events API (would need a custom app + webhook); for now sync is on-demand + a "last sync" stamp.
- Auto-detecting candidate email/role from the message thread replies (often where resumes live).
- Cross-recruiter view (today: only "messages I posted").

## File map

New:
- `supabase/functions/slack-connect/index.ts`
- `supabase/functions/slack-callback/index.ts`
- `supabase/functions/slack-sync/index.ts`
- `src/components/SlackConnectButton.tsx`
- `src/components/SlackChannelSettings.tsx`
- `src/pages/SlackCallback.tsx`
- `src/hooks/useSlackSubmissions.ts`
- `src/lib/slackParse.ts` (LinkedIn regex, name extraction, client-name inference, reaction -> status)

Migration: `slack_tokens`, `slack_channel_mappings`, `slack_submissions` with RLS.

Modified:
- `src/pages/Index.tsx` (button, merging, route)
- `src/App.tsx` (route)
- `src/components/CandidateTable.tsx` (Source column, Slack expansion)
- `src/components/DashboardStats.tsx`
- `src/data/candidates.ts` (add optional `source`, `slack_meta` fields)

## Required from you before I build

1. Approve creating a custom Slack app (we'll give you a one-paste manifest + walk through where to find the client ID/secret).
2. After approval, you'll add `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` when prompted.
