# Onboarding UX Polish

Two independent improvements to the first-run experience.

---

## 1. Make Ashby session token capture painless

The DevTools → Application → Cookies path is the part new users get stuck on. We can't avoid the cookie (Ashby has no per-user API), but we can make the steps copy-paste foolproof.

### Changes to the "Connect Ashby" dialog (`src/components/AshbyFetchButton.tsx`)

- **Replace the terse 3-step list with a guided, visual walkthrough**, OS-aware:
  - Detect Mac vs Windows/Linux from `navigator.platform` and show the correct DevTools shortcut (`⌘⌥I` vs `F12` / `Ctrl+Shift+I`).
  - Use a numbered, illustrated stepper with small inline screenshots/diagrams (static SVGs in `public/onboarding/`) showing: the DevTools panel, the Application tab location, the Cookies tree, and the `ashby_session_token` row highlighted.
  - Each step is a collapsible card; the active step expands automatically.
- **One-click "Open Ashby cookies page"** button that opens `https://app.ashbyhq.com/` in a new tab with a tooltip reminding the user to come back.
- **Copy-ready DevTools snippet** as an alternative path for power users:
  ```js
  copy(document.cookie.split('; ').find(r => r.startsWith('ashby_session_token='))?.split('=')[1])
  ```
  Render in a code block with a "Copy snippet" button. After running it in the Ashby tab's console, the token is on their clipboard — they paste once.
- **Live token validation** in the textarea: as soon as something is pasted, validate shape (length, no `ashby_session_token=` prefix, no surrounding quotes). Auto-strip common paste mistakes (whole `cookie:` header, quotes, `Name\tValue` from DevTools row copy). Show a green check when it looks valid, red hint when it doesn't.
- **"Why do you need this?" disclosure** linking to a short explanation (no covert collection, stored in browser localStorage, never sent anywhere except the extraction service). Reinforces our privacy-first stance.

### Optional follow-up (not in this plan, just flagged)

A browser extension or bookmarklet would eliminate DevTools entirely. Out of scope for now — the snippet approach gets ~90% of the benefit with zero install.

---

## 2. Merge Google Calendar connect into the sign-in flow

### Constraint to know up front

Lovable Cloud's managed "Continue with Google" handles authentication only — it does not request Calendar scopes and does not return a refresh token we can store for offline calendar writes. To push events to a user's calendar later (without them being signed into Google in the browser at that exact moment), we need our own OAuth consent with `calendar.events` scope and `access_type=offline`. That's exactly what `google-calendar-connect` already does.

So we can't literally combine them into one Google consent screen via the managed provider, **but we can make it feel like one step** by auto-triggering the Calendar consent immediately after first sign-in. The user clicks "Continue with Google" → approves sign-in → is bounced straight into the Calendar consent → lands on the dashboard fully connected. From their perspective: one Google flow.

### Changes

**`src/pages/Auth.tsx`**
- When the user clicks "Continue with Google", set a `pendingCalendarConnect=1` flag in `sessionStorage` *before* redirecting to Google.
- Add a small "Also sync interviews to Google Calendar" checkbox (default checked) under the Google button so users who don't want Calendar can opt out.

**New: `src/components/PostSignInCalendarPrompt.tsx`** (mounted in `src/pages/Index.tsx`)
- On mount, if user is authenticated AND `sessionStorage.pendingCalendarConnect === "1"` AND no row exists in `google_calendar_tokens` for this user:
  - Clear the flag.
  - Immediately call `google-calendar-connect` and redirect to Google's consent screen — same code path `GoogleCalendarSync` uses today, just auto-fired.
- After return from `/google-calendar/callback`, the existing handler stores the token and lands the user on `/`. Show a one-time success toast: "Google Calendar connected as <email>".
- If they email/password sign up instead, this prompt never fires — the manual "Connect Google Calendar" button in the toolbar still works for them.

**`src/components/GoogleCalendarSync.tsx`**
- No behavioral change required. It will simply detect the token already exists and render the "Sync filtered to Calendar" button on first dashboard load.

### UX result

| Path | Before | After |
|---|---|---|
| Continue with Google | 1. Sign in. 2. Later, find the Calendar button. 3. Click connect. 4. Approve again. | 1. Sign in. 2. Approve Calendar. 3. Done — sync button is live. |
| Email/password | Same as before — manual connect button. | Same as before. |

---

## Technical notes

- No DB migrations needed.
- No new edge functions; reusing `google-calendar-connect` + `google-calendar-callback`.
- The `sessionStorage` flag is the cleanest carrier through the OAuth round-trip because Supabase's Google OAuth redirect strips custom query params.
- The Ashby walkthrough screenshots are static assets — small PNG/SVG, no runtime cost.
- Privacy memory respected: the Ashby token is still stored only in `localStorage` and only sent to the extraction service the user explicitly invokes. The new console snippet runs in *their* Ashby tab and only copies to *their* clipboard.

---

## Out of scope

- Browser extension for Ashby cookie (mentioned above).
- Auto-refreshing Ashby tokens (impossible without an Ashby API key).
- Changing the Calendar sync behavior itself — confirmed "good enough" earlier.
