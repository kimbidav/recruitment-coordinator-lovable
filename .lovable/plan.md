

## Plan: Fix Calendar Sync Logic

### Problems
1. **Syncs all candidates** — should only sync the currently filtered/visible ones
2. **Wrong date source** — uses `current_stage_date` (e.g. `2026-03-11`) instead of the date in the interview string (e.g. `03/10` → March 10)
3. **Title extraction** — needs to produce "Angel Lim x Causal Labs (Technical Screen)" from "• Technical Screen Interview (03/10) - Dar Mehta - No score yet"

### Changes

**`src/pages/Index.tsx`** (line 121)
- Pass `filteredCandidates` instead of `candidates` to `GoogleCalendarSync`

**`src/components/GoogleCalendarSync.tsx`**
- **Date parsing**: Extract the `(MM/DD)` date from the `current_stage_interviews` string and use current year to build the date. Set time to 5pm local, 30-min slot.
- **Title extraction**: Strip "Interview" suffix from the type name (e.g. "Technical Screen Interview" → "Technical Screen"). Build title as `{candidate} x {company} ({type})`.
- **Remove dependency on `current_stage_date`** for scheduling — only use the date embedded in the interview text.
- Keep `current_stage_date` as a fallback if no `(MM/DD)` pattern is found in the interview text.

