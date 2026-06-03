## Goal

Make Ashby vs Slack attribution 100% accurate and complete:

- **Company-level classification** — every company is either an "Ashby client" or a "Slack-only client", based on whether it exists in the user's Ashby workspace.
- **Candidate-level source** — within an Ashby company, individual candidates are tagged `ashby`, `slack`, or `both` based on where their record actually appears. (Keeping `both` per your answer.)
- **Persistent + cumulative** — once a company is known to Ashby, it stays Ashby forever, even if a later fetch doesn't enumerate it.

## Root cause of today's bugs

1. The Ashby extractor returns a full org list (`extraction_stats.orgs_total`, `org_names`, sometimes a per-org breakdown), but we only persist orgs that have at least one returned candidate. Orgs with zero active candidates at fetch time silently disappear → companies like Finch Legal / Listen Labs / Valon get mis-classified as Slack-only.
2. The candidate-to-Ashby match in `src/pages/Index.tsx` runs name-normalization on the dashboard side and is fragile (e.g. `Valon Tech` vs `Valon Eng Ds`, `Listen Labs` vs `listenlabs`). It also drives the per-candidate `source` field, so mismatches show up as "slack-only" candidates inside Ashby companies.
3. There is no single source of truth — `ashby_known_clients` is partially populated, and the dashboard re-derives company identity ad-hoc.

## Plan

### 1. Make `ashby_known_clients` the single source of truth for "is this an Ashby company?"

- On every Ashby fetch (`src/components/AshbyFetchButton.tsx`):
  - Harvest org names from **all** locations the extractor returns them: `orgs`, `org_names`, `extraction_stats.orgs`, `extraction_stats.org_names`, `extraction_stats.per_org`, `extraction_stats.orgs_breakdown`, plus every distinct `company_name` on returned candidates.
  - Upsert each distinct name into `ashby_known_clients` (cumulative — never delete).
  - Also re-upsert on every successful candidate save, so historical Ashby company memberships are preserved.
- Load `ashby_known_clients` once on dashboard mount and use it as the authoritative "Ashby company set."

### 2. Centralize company normalization and matching

Create `src/lib/companyMatch.ts` with:

- `normalizeCompany(name)` — lowercase, NFKD, strip diacritics, strip punctuation, collapse whitespace, drop a fixed noise set (`inc`, `llc`, `ltd`, `co`, `corp`, `labs`, `ai`, `the`, `technologies`, `tech`, `research`, `legal`, `engineering`, `eng`, `ds`).
- `companyAliases(name)` — returns a Set of alias keys: full collapsed key, first significant token (≥4 chars), first two tokens joined, and the de-suffixed form.
- `companiesMatch(a, b)` — true if alias sets intersect, OR keys share a ≥5-char common prefix, OR first significant tokens match (≥5 chars).
- `isAshbyCompany(name, ashbyClientSet)` — runs `companiesMatch` against every entry in the known-client set.

Replace every ad-hoc matcher (`src/pages/Index.tsx`, `supabase/functions/agent-scan/index.ts`, `src/hooks/usePipelineSession.ts`) with these helpers so client and edge function agree.

### 3. Rebuild source attribution in two layers

In `src/pages/Index.tsx`, when merging Ashby candidates + Slack submissions:

- **Step A — company classification (company-level):**
  For every distinct company across both feeds, compute `isAshby = isAshbyCompany(companyName, ashbyClientSet)`.
  - `isAshby = true` → company belongs to the Ashby pipeline tab.
  - `isAshby = false` → company belongs to the Slack pipeline tab.
  This drives the tab/bucket the company shows up in. No company is ever split across tabs.

- **Step B — per-candidate source (within Ashby companies only):**
  For an Ashby company, iterate its candidates:
  - In Ashby fetch only → `source: "ashby"`.
  - In Slack only (matched by candidate name via `normalizeMatchKey`) → `source: "slack"`.
  - In both → `source: "both"`.
  Slack-only candidates at Ashby companies still appear and still surface their Slack thread.

- For Slack-only companies, every candidate is `source: "slack"` (no Ashby data exists for them).

### 4. Use the same logic in the agent-scan edge function

`supabase/functions/agent-scan/index.ts` currently routes cards to Ashby vs Slack pipelines using a strict lowercase match against `ashby_known_clients` + `candidates`. Swap that for `isAshbyCompany` using the centralized helper (port to Deno), so cards route the same way the dashboard categorizes companies.

### 5. Diagnostics

Add a small "Ashby company list" diagnostic on the AshbyFetchButton's last-fetch console output: `console.table` of every name harvested with its source (`orgs`, `extraction_stats.per_org`, `candidates[].company_name`, `existing ashby_known_clients`). This makes it trivial to verify completeness after a fetch.

## Technical details

Files touched:

- `src/lib/companyMatch.ts` (new) — normalization + matching helpers.
- `src/components/AshbyFetchButton.tsx` — broaden org harvest, upsert into `ashby_known_clients`, log full company set.
- `src/hooks/usePipelineSession.ts` — on save, also upsert every candidate's `company_name` into `ashby_known_clients`; remove old ad-hoc matchers.
- `src/pages/Index.tsx` — load `ashby_known_clients`, classify companies, then derive per-candidate `source` using the two-layer logic.
- `supabase/functions/agent-scan/index.ts` — replace strict company lookup with the shared `isAshbyCompany` logic (Deno port of `companyMatch.ts`).

No DB schema changes — `ashby_known_clients` already exists with the right columns and RLS.

## Verification

1. Fresh Ashby fetch → console table lists Finch Legal, Listen Labs, Valon, Crosby, Netic, Trajectory, AfterQuery, Factory.
2. `select client_name from ashby_known_clients` returns all of them after the fetch.
3. Dashboard: each of those companies appears in the Ashby pipeline tab; candidates seen in both Ashby and Slack are tagged `both`; Slack-only candidates inside those companies are tagged `slack` but still inside the Ashby company group.
4. A company never appears in both the Ashby and Slack tabs.
5. Agent scan routes cards to the same pipeline tab the dashboard shows.
