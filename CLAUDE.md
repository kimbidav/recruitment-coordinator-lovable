# Candidate Compass

The cloud, team-wide version of DK's recruitment coordinator: a scheduling
tracker that makes sure every candidate a Candidate Labs recruiter introduces
to a client actually gets scheduled, and that the recruiter gets feedback after
each round. Lovable Cloud (Supabase auth/DB/edge functions + React/Vite) with
the Ashby extractor on Railway. Sibling repos: the desktop coordinator
(`recruitment_coordinator_agent`, DK's solo tool — behaviours are ported
deliberately, never merged) and the extractor (`Ashby-automation`).

## Business context (read before changing pipeline logic)

Candidate Labs is paid on **placements**, so the business rides on candidates
*progressing*: intro → client accepts (✅ on the Slack post; ⛔ = pass) →
interviews scheduled (outside Slack: email, or the client's Ashby) → feedback
after each round → offer. A candidate who silently stalls is lost revenue and a
bad experience; momentum is the product. The core question everywhere is
"who did I introduce that hasn't been scheduled yet?"

Rules that encode business judgment — keep them when you touch anything:

- **Nothing auto-sends.** Every queued action is a draft a recruiter reviews;
  `agent-act` is only reached from a button on a card showing what will be
  sent. Never turn review-then-send into fire-and-forget.
- **Nothing client-visible from automation.** Client channels are shared Slack
  Connect channels. The bot never joins, posts or reacts there; results go to
  modals and DMs. Reads happen with the recruiter's own user token.
- **Only the clicker's own submissions.** Shared channels carry teammates'
  candidates; the parent post's author must be the recruiter acting.
- **Uploads run under the recruiter's own Ashby login**, matched by their
  `@candidatelabs.com` email (`X-Ashby-User`; identity verified against
  `available_identities`), so credited-to is always the uploader.
- **Email prefill only at HIGH confidence.** The address becomes the
  candidate's primary email in the *client's* ATS; medium is a "Use" button,
  low is a chip list, never an auto-fill (`_shared/pure/emailResolver.ts`).
- **Retries never resend what landed.** Resume upload and note creation are
  not idempotent in Ashby.
- **Confirm-or-skip, never confirm-or-stamp.** A row is marked Archived/Hired
  only on a confirming verdict from Ashby; "couldn't check" leaves it as it
  was. A sweep that loses more than half the trusted rows is sick, not
  informative (the 470-candidate incident).
- **Absence is surfaced, never acted on.** An org missing from the sweep is a
  blind spot (banner), retirement is a human statement about access
  (`org_status="retired"`, never Archived), renames are learned only where
  the data proves them.
- **Only ✅-accepted intros get individual stale nudges.** Unresponded intros
  surface per candidate only when a client has 2+ stale unscheduled
  candidates — the client has gone quiet.
- **Three quiet days** before nudging: an active thread means a human is on
  it. **The 60-day window follows activity**, not the intro date.
- **Email signals must be about this client.** A multi-loop candidate's
  Nooks email must never become a Listenlabs card.
- **Surface over suppress.** When unsure whether a loop is live, show it.
- **DK's voice in drafts**: friendly, low-pressure, never robotic; candidates
  never see internal ATS states.
- **The internal Ashby API is feature-frozen** (Ashby asked CL off it,
  2026-08-25): reuse existing operations only; the write path sits behind
  `_shared/extractor.ts` and the `steps{}` contract.

## Where things live

- `supabase/functions/_shared/pure/` — dependency-free rules shared by the
  edge functions (Deno) and the dashboard (vitest via `@shared`): Slack text
  parsing, company/name identity, Ashby merge + org health + live check,
  email resolver, calendar reminder identity, Slack sync hygiene, agent
  rules, shortcut views. Put logic here first; tests live beside it.
- `supabase/functions/` — `slack-interactions` (the shortcut),
  `slack-upload-callback`, `ashby-user-session`, `ashby-sync`, `slack-sync`,
  `slack-events`, `agent-scan`, `agent-act`, `agent-draft`, `gmail-helper`,
  `google-calendar-sync`, OAuth connect/callback pairs.
- `src/` — dashboard (Pipeline + Agent tabs, onboarding, banners).
- `extension/` — Chrome MV3 extension for one-click Connect Ashby.
- `docs/v2-rollout.md` — the release runbook (migrations, secrets, Slack
  manifest, pilot); `docs/ashby-architecture.md`, `docs/slack-integration.md`.

## Working here

- `npm run test`, `npx tsc --noEmit -p tsconfig.app.json`, `npm run lint`,
  `cd supabase/functions && deno task check`.
- Migrations are applied by hand in the Lovable Cloud SQL panel; pushes do not
  apply DDL. `src/integrations/supabase/types.ts` is hand-edited for new
  columns until Lovable regenerates it.
- `verify_jwt = false` functions must be declared in `supabase/config.toml`.
- Never print tokens, cookies or secrets; they live only in Railway/Supabase
  secrets.
