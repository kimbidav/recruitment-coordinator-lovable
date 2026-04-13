

## Problem

The frontend (`AshbyFetchButton.tsx`) calls `/api/extract/start` and then polls `/api/extract/jobs/{jobId}`, but the Railway backend only has `/api/extract`. The backend was never updated to match.

## Solution

Revert `AshbyFetchButton.tsx` to call the original `/api/extract` endpoint that actually exists on your Railway server. Keep the progress indicator UI but use the simpler single-request flow:

1. **Revert API call** — Change from `/api/extract/start` + polling to a single `POST /api/extract` with `include_enrichment: false` for fast basic load
2. **Keep progress UI** — The simulated progress bar still works during the request
3. **Background enrichment** — After basic load succeeds, fire a second `POST /api/extract` with `include_enrichment: true` in the background to get interview feedback

### Files changed
- `src/components/AshbyFetchButton.tsx` — Replace the job-based polling logic with the original two-request flow (basic then enriched)

