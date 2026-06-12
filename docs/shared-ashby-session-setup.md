# Shared Ashby Session — One-Time Infrastructure Setup

The code for the shared team session shipped in commit `e93bc14` (app) and
`42b643b` (Ashby-automation/Railway extractor). Three manual steps activate it.
Until they're done, the extractor keeps working unauthenticated and the app
falls back gracefully, so there's no rush window — but the secret gating
matters: **the extractor holds an org-wide Ashby session, so don't skip step 2.**

## 1. Railway — volume + env vars

In the Railway dashboard for `ashby-automation-production`:

1. **Create a volume** and mount it at `/data` on the service.
   (Service → Settings → Volumes → New Volume, mount path `/data`.)
2. **Set environment variables** (Service → Variables):
   - `ASHBY_SESSION_FILE=/data/ashby-session.json`
   - `EXTRACTOR_SHARED_SECRET=<secret>`  ← same value as step 2
3. **Delete `ASHBY_SESSION_COOKIE`** if it's still set (legacy frozen cookie;
   it's now only a panic fallback and a stale value causes confusing failures).
4. Redeploy (Railway redeploys automatically on variable changes).

Verify: `curl https://ashby-automation-production.up.railway.app/api/health`
should show `"shared_secret_required": true`, and
`POST /api/extract/start` without the header should return 401.

## 2. Supabase — edge function secret

Lovable Cloud → project settings → Edge Functions secrets (or
`supabase secrets set` if using the CLI):

- `EXTRACTOR_SHARED_SECRET=<secret>` — must EXACTLY match the Railway value.

## 3. Supabase — apply the migration DDL

Pushes do NOT auto-apply migrations. Run the contents of
`supabase/migrations/20260612190000_ashby_connection.sql` in the Lovable Cloud
SQL panel (or ask Lovable to apply it), then verify:

```sql
select * from public.ashby_connection;  -- should exist (0 rows initially)
```

## 4. First seed

Open the app → the Ashby button reads **Reconnect Ashby** (status is
`disconnected` initially) → click it, paste your `ashby_session_token` from
DevTools, **Reconnect & Sync**. From then on:

- Everyone's button is one-click **Sync from Ashby** — no cookie, ever.
- When the session dies (~weekly), the button flips back to **Reconnect
  Ashby** for whoever wants data next. Any teammate's login works.
- The session survives Railway redeploys (it lives on the volume).

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Sync fails "extractor did not respond" | Railway cold start | Retry in 1 min |
| Button stuck on Reconnect after seeding | Seed cookie didn't authenticate | Make sure the Ashby tab was signed in when you copied the token |
| 401 on every extractor call | Secret mismatch between Railway and Supabase | Re-check both values |
| Your Ashby tab signed out after seeding | Expected — the extractor took over that session | Just sign back in; don't re-seed |
