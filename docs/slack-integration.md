# Slack Integration — Architecture & Operations

How the app connects to Slack, ingests candidate submissions, and acts on them
(threads, follow-ups, closes). Companion to [ashby-architecture.md](ashby-architecture.md);
together they cover the pipeline's two data sources.

Unlike the org-shared Ashby connection, **Slack is connected per user**: each
recruiter authorizes their own Slack account (a user token, not a bot), and the
app only sees channels and submissions that user can see.

---

## 1. Connection & OAuth

- **`SlackConnectButton`** opens Slack OAuth in a new tab (Slack refuses to load
  in iframes). On success, `slack-callback` stores the **user** access token,
  Slack user id, and team info in `slack_tokens` (one row per app user).
- **`slack-connect`** builds the authorize URL. User scopes requested:

  | Scope | Used for |
  |---|---|
  | `channels:read`, `groups:read` | discover channels (`users.conversations`) |
  | `channels:history`, `groups:history` | read submission messages |
  | `reactions:read` | infer status from ✅ / ⛔ reactions |
  | `chat:write` | thread replies + the follow-up bar's channel posts |
  | `reactions:write` | ⛔ close / reopen reactions |
  | `search:read` | thread lookup for candidates without a stored link |
  | `users:read`, `users:read.email` | names/avatars, @mention autocomplete |

  **Rollout note:** `chat:write`, `reactions:write`, and `search:read` were
  added later. The Slack app's manifest (api.slack.com → OAuth & Permissions)
  must allow them, and users who connected before the change must
  **Disconnect → Connect** once to grant them. Until they do, thread lookup
  returns a friendly "reconnect Slack" error; everything else keeps working.

## 2. Ingestion — how submissions reach the pipeline

Two paths, same extraction rules:

- **`slack-sync`** (pull, triggered by the "Sync Slack (team)" button):
  discovers the user's channels, keeps external Slack Connect channels and
  `internal-*` channels, and scans a 75-day window for **parent messages
  authored by the connecting user that contain a LinkedIn URL**. Honors Slack
  rate limits with a 240s budget (stalest channels first, resumable).
- **`slack-events`** (push, Events API receiver, HMAC-verified, `verify_jwt=false`):
  handles new/edited messages in real time and recomputes status on
  `reaction_added`/`reaction_removed`.

Extraction per message: candidate name (block-kit link label or text
heuristics), LinkedIn URL, and status from reactions — ✅ = accepted,
⛔ = not in process, both = disqualified. Rows land in `slack_submissions`;
channel→client mappings in `slack_channel_mappings`.

**Merge into the pipeline** happens in `Index.tsx`: Ashby rows fuzzy-match
Slack submissions by candidate name *and* company (`companiesMatch`) to attach
`slack_meta`; unmatched submissions become Slack-only rows. Source tags are
company-level (an Ashby-instrumented client's loops are all "ashby"), and a
Slack-only candidate at an Ashby client gets the "⚠ Not yet in Ashby" badge.
Note the `SEPARATE_CLIENTS` exception in `src/lib/companyMatch.ts`: names
listed there (e.g. `anterior vpe cto`) only ever match themselves, so a parent
org can't swallow a deliberately separate loop.

## 3. Acting on submissions — `slack-thread` edge function

One function, action-dispatched. All actions use the caller's own user token.

| Action | Behavior |
|---|---|
| `fetch` | Parent + replies (`conversations.replies`), names/avatars resolved, detects an existing ⛔ reaction. |
| `reply` | Thread reply as the connected user (`chat.postMessage` with `thread_ts`). |
| `post` | **Top-level channel message** — used by the follow-up bar. |
| `close` / `reopen` | Add / remove the ⛔ `no_entry` reaction on the parent (idempotent). |
| `find` | **Thread lookup** via `search.messages`: prefers channels whose `slack_channel_mappings` entry matches the company, quoted-name search scoped to that channel first, unscoped fallback filtered by channel↔company match, parent message preferred (a reply's permalink carries `thread_ts`). Returns `{found, channel_id, message_ts}`. |
| `users` | Workspace users + channel members (incl. external Slack Connect guests) for @mention autocomplete. |

## 4. UI surfaces

- **Pipeline table** (`CandidateTable`): per-row **Thread** button — opens the
  stored thread, or runs `find` (spinner) when no link is stored. **⛔ Close**
  button closes locally and mirrors the ⛔ reaction in Slack. Sortable **Days**
  column (days in stage, red past 30). Checkbox column enables multi-select.
- **Follow-up bar** (`FollowUpBar`): appears when rows are selected. Groups the
  selection by Slack channel, drafts one editable "quick status check" message
  per channel (candidate name + days in stage), Send / Send All via
  `action=post`, plus batch ⛔ close. Rows without a Slack channel group under
  their company and can't be sent to.
- **Thread panel** (`SlackThreadPanel`): live thread view (10s poll) with a
  reply composer and @mention autocomplete that includes external client
  guests.
- **Email composer** (`EmailComposer`): drafts a candidate check-in email —
  each active opportunity shows its **pipeline stage** (falls back to
  "in process"; closed ones read "no longer moving forward") and the message
  signs off with the sender's first name. "Look up from Gmail" and Send go
  through the `gmail-helper` function using the user's Google connection.

## 5. Storage

| Table | Contents |
|---|---|
| `slack_tokens` | Per-user Slack user token, slack_user_id, team info. |
| `slack_channel_mappings` | Channel ↔ inferred client name, enabled flag. |
| `slack_submissions` | Extracted submissions: candidate, LinkedIn URL, status, channel, message_ts. |

All per-user with RLS; edge functions use the service role.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Thread lookup says "search permission missing" | Token predates `search:read` | Disconnect → Connect Slack |
| Follow-up send fails `missing_scope` | Token predates `chat:write`, or app manifest lacks it | Add scope to the Slack app manifest, then reconnect |
| ⛔ close "Slack reaction failed" | Token lacks `reactions:write` | Same as above |
| Submissions missing | Message not authored by the connecting user, or no LinkedIn URL in the parent message | That's the ingestion contract — post submissions as parent messages with a LinkedIn link |
