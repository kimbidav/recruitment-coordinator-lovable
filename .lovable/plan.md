## Problem

Cards for Reducto, Deeptune, and Graphite are landing in the **Slack pipeline** tab when they should be in the **Ashby pipeline** tab.

The agent decides routing in `supabase/functions/agent-scan/index.ts` (`ashbyFlagsFor`). A client is "Ashby-tracked" only when its lowercased company name appears in either:
- `candidates` table with a non-null `ashby_candidate_id`, or
- `ashby_known_clients` table (populated only on Ashby fetch from the candidates + extractor's `orgs`/`org_names` fields).

A DB check confirmed none of Reducto/Deeptune/Graphite exist in either source, so they fall back to Slack pipeline.

## Plan

### 1. Auto-pull the full Ashby org list during every fetch

The Railway extractor (`/api/extract`) already returns `extraction_stats.orgs_total` and (sometimes) `orgs`/`org_names`. The current code only persists names that come back through those fields **or** through `candidates[].company_name`. The miss is orgs that exist in Ashby but have zero active candidates at fetch time and aren't enumerated in the stats payload.

Changes in `src/components/AshbyFetchButton.tsx`:
- After `/api/extract` returns, also harvest org names from any nested per-org breakdown the response includes (e.g. `extraction_stats.per_org`, `extraction_stats.orgs_breakdown`, or any object whose keys/entries look like org rows). Today we only check top-level `orgs`/`org_names`.
- Upsert every distinct name we see into `ashby_known_clients` (already partially done — broaden the harvest).

Because Railway is the only source of org enumeration we have (no Ashby connector in the workspace, no `/api/orgs` endpoint), this is the best we can do automatically. If after a fresh fetch a company still doesn't appear, it's because the extractor genuinely doesn't surface it — see the fallback below.

### 2. Fuzzy / normalized company-name matching

In `supabase/functions/agent-scan/index.ts`, replace the strict `companyName.trim().toLowerCase()` comparison in `ashbyFlagsFor` and `ashbyByCompany` keys with a normalized form so "Reducto AI" in Slack matches "Reducto" in Ashby.

Normalization:
- Lowercase, NFKD, strip diacritics.
- Strip punctuation and collapse whitespace.
- Strip common suffixes: `inc`, `inc.`, `llc`, `ltd`, `co`, `corp`, `labs`, `ai`, `the`, `technologies`, `tech`, `research`.
- Match if either side's normalized form is a token-superset of the other (e.g. `reductoai` ⊇ `reducto`).

Apply the same normalization on both sides (the map key and the lookup key).

### 3. Fallback: manual override entry

Add a small "Add Ashby client" affordance on the Agent tab header (next to the Slack/Ashby pipeline tabs) — one input that inserts a row into `ashby_known_clients`. This covers the edge case where an org never appears in any Ashby extraction but the user knows it's tracked there.

No schema changes; `ashby_known_clients` already exists with the right columns and RLS.

### 4. Re-scan after the data is corrected

Trigger an agent scan automatically after a new client is added (or after a successful Ashby fetch that produced new known-client rows). Existing open cards belonging to newly-tracked clients will be re-evaluated and routed to the Ashby pipeline on the next scan; no migration of historical cards is needed because `AgentTab` derives the tab purely from `payload.ashby_tracked`, which is recomputed each scan.

## Technical details

Files touched:
- `src/components/AshbyFetchButton.tsx` — broader org-name harvest.
- `supabase/functions/agent-scan/index.ts` — `normalizeCompany()` helper; use it for both the `ashbyByCompany` map and the `ashbyFlagsFor` lookup.
- `src/components/AgentTab.tsx` — small "Add Ashby client" inline input + button; calls Supabase insert into `ashby_known_clients`, then triggers `runScan()`.

No DB migration needed.

## Verification

1. Add "Reducto" via the new input, re-run scan, confirm Pau Perng-Hwa Kung's card now appears under **Ashby pipeline**.
2. Run a fresh Ashby fetch; confirm any new orgs reported in extractor stats get persisted into `ashby_known_clients`.
3. With normalization on, confirm a Slack client labelled "Reducto AI" matches an Ashby org named "Reducto".
