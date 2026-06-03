## Goal
Prove (or disprove) that the Railway Ashby extractor is returning every org and every candidate it should. No app code changes — this is a one-shot sandbox diagnostic.

## Steps

1. **Secure secret input**
   - I trigger Lovable's secret form to collect `ASHBY_TEST_SESSION_TOKEN` (your `ashby_session_token` cookie value). Never appears in chat or code.

2. **Run diagnostic script** (sandbox-only, not committed)
   - `POST https://ashby-automation-production.up.railway.app/api/extract` with `{ cookie: <token>, force: true }`.
   - Parse the response and write a full report to `/mnt/documents/ashby-extractor-audit.json` + a human-readable summary to `/mnt/documents/ashby-extractor-audit.md` containing:
     - **Extraction stats**: `orgs_total`, `orgs_fetched`, `orgs_failed`, `orgs_retried`, total seconds.
     - **Org enumeration list**: every org name found in `orgs`, `org_names`, `per_org`, `orgs_breakdown`, or top-level keyed stats.
     - **Per-company candidate table**: sorted `company_name → candidate count`.
     - **Zero-candidate orgs**: orgs the extractor reached but returned 0 candidates for (likely upstream filter drops).
     - **Failed orgs**: any orgs in `orgs_failed`.
     - **Sample records**: 2 raw candidate JSON blobs so we can see what fields the extractor emits (stage, status, archive flags, etc.).
     - **Expected-org check**: PRESENT / ZERO / MISSING for Finch Legal, Listen Labs, Valon, Crosby, Netic, Trajectory, AfterQuery, Factory (plus any others you name).

3. **You spot-check 2–3 orgs in Ashby**
   - Open Ashby in your browser, pick 2–3 orgs from the report, and tell me the candidate count you see.
   - I diff against the extractor's count and label each as MATCH / UNDERCOUNT / OVERCOUNT.

4. **Diagnosis**
   - Missing org → extractor's org discovery is broken (Railway service fix).
   - Present but undercount → extractor filter too strict (extend `mem://features/ashby-upstream-drops`).
   - Counts match → extractor is clean; bug is downstream in our save/classification.

5. **Cleanup**
   - Delete `ASHBY_TEST_SESSION_TOKEN` from secrets. (Cookie expires on its own in minutes regardless.)

## Before I run

Two things I need from you when you approve this plan:

- **Confirm orgs to spot-check** — default list above (Finch Legal, Listen Labs, Valon, Crosby, Netic, Trajectory, AfterQuery, Factory). Add or remove any.
- **Be ready with a fresh cookie** — grab `ashby_session_token` right before pasting it into the secret form; Ashby invalidates it fast.

## Out of scope
- No edits to app code, edge functions, or DB schema.
- No changes to the Railway extractor (it's not in this repo). If the audit shows the extractor is at fault, fixing it is a separate workstream you'd need to handle wherever that service lives.
