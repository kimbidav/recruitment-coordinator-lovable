## Goal

Two-tap first-run onboarding: one Google sign-in grants app login + Gmail + Calendar in a single consent, then a guided screen walks the user through the unavoidable Slack + Ashby steps.

## Changes

### 1. Simplified Auth screen (`src/pages/Auth.tsx`)
- Make **Continue with Google** the primary, full-width filled button.
- Remove the "Also connect Google Calendar" checkbox — Calendar+Gmail scopes are always requested up-front during sign-in (single consent screen).
- Demote email/password to a small "Use email instead" toggle below a divider.
- Copy: "Welcome — sign in with Google to get started in under a minute."

### 2. Single-consent Google flow
- After successful Google sign-in (in `Auth.tsx` and on the existing OAuth return path), automatically kick off the existing `google-calendar-connect` flow once, so the user gets a single Google consent screen that covers Calendar + Gmail. Skip if `google_calendar_tokens` already exists for that user.
- The existing `google-calendar-connect` edge function already requests `calendar.events`, `gmail.send`, `gmail.readonly`, `userinfo.email`, `openid` — no scope changes needed.

### 3. New onboarding screen (`src/pages/Onboarding.tsx`)
A first-run checklist shown to any signed-in user who hasn't finished setup. Three numbered cards:

```text
1. Google (Calendar + Gmail)   ✓ Connected as user@example.com
2. Connect Slack               [Connect Slack]
3. Connect Ashby               [Connect Ashby]
                               [Continue to dashboard]
```

- Step 1 is pre-checked because it was granted during sign-in.
- Steps 2 and 3 reuse `SlackConnectButton` and `AshbyFetchButton` inline; each shows a one-line "why this matters" caption and a Pending/Connected pill.
- Slack + Ashby are recommended but not blocking — **Continue to dashboard** is always enabled, with a subtle "you can finish this later from the header" note.
- "Skip for now" link routes to `/` and sets a localStorage flag so we don't re-prompt.

### 4. Routing (`src/App.tsx`)
- Add protected `/onboarding` route.
- Add a small `useOnboardingStatus` hook that returns `{ googleConnected, slackConnected, ashbyConnected, hasCandidates, loading }` by checking `google_calendar_tokens`, `slack_tokens`, the local Ashby cookie, and the candidates count.
- On `/`, if the user is signed in, has zero candidates, has not completed Slack/Ashby, and hasn't dismissed onboarding, redirect to `/onboarding`. Otherwise show the dashboard.

### 5. Dashboard empty-state polish (`src/pages/Index.tsx`)
- Replace the generic "Connect Ashby or Slack…" copy with a "Finish setup" button linking to `/onboarding`, plus the existing CSV upload as a secondary option.

## Out of scope

- No DB schema changes.
- No changes to Slack or Ashby connect mechanics — those remain their own OAuth / cookie flows (technical Slack limitation: cannot be merged with Google consent).
- Email/password sign-in stays available, just de-emphasized.

## Technical notes

- One shared `useOnboardingStatus` hook backs both the routing guard and the onboarding screen so they never disagree.
- After each connect button completes, re-poll status (the components already expose `onConnected`/`onSynced` callbacks).
- Onboarding screen uses the existing neutral palette + Inter font, numbered circle markers, generous spacing.
