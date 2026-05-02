## Goal

Simplify the Ashby session token dialog (`src/components/AshbyFetchButton.tsx`) so users see one clear path — the DevTools / Application tab method — and link a Loom walkthrough for help.

## Changes

**File: `src/components/AshbyFetchButton.tsx`**

1. **Remove the "Quick way" tabbed UI**
   - Delete the `activeStep` state and the tab toggle row (Quick / Manual buttons).
   - Remove the conditional that switches between the quick console-snippet flow and the manual flow.
   - Remove now-unused pieces tied to the quick path: `CONSOLE_SNIPPET` constant, `snippetCopied` state, `copySnippet` handler, and the `Copy` / `Check` icon imports if no longer used elsewhere in the file (the `Check` icon is still used for the valid-token indicator, so keep it; drop `Copy` only if unused).

2. **Promote the DevTools instructions to the primary (only) flow**
   - Replace the previous "Manual (DevTools)" terse list with a clearer numbered list at body text size (not muted micro-text), keeping the same six steps:
     1. Open `app.ashbyhq.com` and sign in (with an "Open Ashby" button as in the current quick flow).
     2. Open DevTools (`⌘⌥I` on macOS / `F12` on Windows).
     3. Go to the **Application** tab (Firefox: **Storage**).
     4. Expand **Cookies** → select `https://app.ashbyhq.com`.
     5. Find the row `ashby_session_token`, double-click its **Value**, and copy it.
     6. Paste it into the field below.

3. **Update the dialog header copy**
   - Title stays "Connect your Ashby account".
   - Description becomes something like: "We need your Ashby session token to pull candidates. Follow the steps below — it takes about a minute. Watch the walkthrough if you get stuck."

4. **Add a Loom walkthrough link**
   - Just below the dialog description (above the numbered steps), add a small inline link/button:
     - Label: "Watch the 1-minute walkthrough"
     - Icon: `ExternalLink` (already imported)
     - Opens `https://www.loom.com/share/3423bbe88fdd4ad4819ce24afda058b1` in a new tab (`target="_blank"`, `rel="noopener noreferrer"`).
   - Style: subtle outline button (`size="sm"`), matching the existing "Open Ashby" button.

5. **Leave untouched**
   - Token input, validation, privacy disclosure (`Why do you need this?`), progress UI during fetch, footer "Fetch Candidates" button, and all fetch/run logic.
   - The button itself on the dashboard / onboarding screen.

## Notes

- No changes to backend, edge functions, or other files.
- No new dependencies.
