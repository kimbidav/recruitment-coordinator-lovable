import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { channelQualifies, channelToClientName, extractCandidateName, extractLinkedinUrl } from "../_shared/pure/slackText.ts";
import { companiesMatch } from "../_shared/pure/companyMatch.ts";
import {
  LOOKBACK_DAYS_DEFAULT,
  discoverySearchAfter,
  findMigratedTwins,
  fullRescanDue,
  isClosed,
  isTopLevelHit,
  planRenames,
  selectTrackedRows,
  threadActivity,
  type SubmissionRow,
  type SyncState,
} from "../_shared/pure/slackSync.ts";

// Slack sync — incremental by default (desktop app: incremental_slack_sync.py).
//
//   POST {}              incremental: one search for the recruiter's own
//                        LinkedIn posts since the last sync + one
//                        conversations.replies per OPEN tracked submission.
//   POST {full: true}    full rescan of every client channel's history over
//                        the lookback window (also runs automatically when
//                        the last full scan is older than 7 days — it
//                        self-heals drift the incremental path can't see:
//                        edited parents, reactions removed from closed rows).
//
// Rules (see _shared/pure/slackSync.ts): the window follows ACTIVITY, not
// the intro date; closed (⛔) rows are carried without an API call; a
// channel that is new to the sync widens discovery to the full window; the
// same thread under a new channel id is re-keyed, never duplicated; the
// client name follows the channel's current name except for Ashby clients.
// Submissions are only ever created from the recruiter's OWN LinkedIn-link
// posts, so shared channels never yield a teammate's candidates.

const SLACK_API = "https://slack.com/api";
const SCAN_BUDGET_MS = 240_000; // stop well before the edge wall clock
const HISTORY_OVERLAP_SEC = 3600;
const EXCLUDED_NAME_RE = /^(eng[-_]?recruiting|eng[-_]?candidate|recruiting[-_]general|hiring[-_]general)/i;

interface SlackChannel { id: string; name: string; is_archived?: boolean; is_ext_shared?: boolean; is_member?: boolean }
interface SlackReaction { name: string; users?: string[]; count?: number }
interface SlackMessageElement { type?: string; url?: string; text?: string; elements?: SlackMessageElement[] }
interface SlackMessage {
  type?: string; user?: string; ts: string; thread_ts?: string; text?: string;
  reactions?: SlackReaction[]; blocks?: Array<{ elements?: SlackMessageElement[] }>; subtype?: string;
}

function walkElementsForLink(elements: SlackMessageElement[] | undefined): { url?: string; label?: string } {
  for (const el of elements ?? []) {
    if (el.type === "link" && el.url && extractLinkedinUrl(el.url)) return { url: el.url, label: (el.text ?? "").trim() || undefined };
    if (el.elements) {
      const nested = walkElementsForLink(el.elements);
      if (nested.url) return nested;
    }
  }
  return {};
}

/** LinkedIn URL + name from a parent message: block-kit hyperlink first, then the shared text extractors. */
function extractCandidate(msg: { text?: string; blocks?: Array<{ elements?: SlackMessageElement[] }> }) {
  let url: string | null = null;
  let label: string | undefined;
  for (const block of msg.blocks ?? []) {
    const found = walkElementsForLink(block.elements);
    if (found.url) { url = found.url; label = found.label; break; }
  }
  const text = msg.text ?? "";
  if (!url) url = extractLinkedinUrl(text);
  let name = "";
  if (label && !/^linkedin$/i.test(label) && !/^https?:/i.test(label)) name = label;
  else name = extractCandidateName(text);
  if (name.length > 80) name = name.slice(0, 80);
  return { linkedin_url: url, candidate_name: name, needs_review: !name || !url };
}

function statusFromReactions(reactions: SlackReaction[] | undefined): string {
  if (!reactions || reactions.length === 0) return "submitted";
  const names = new Set(reactions.map((r) => r.name));
  const hasCheck = names.has("white_check_mark") || names.has("heavy_check_mark") || names.has("white_check");
  const hasNoEntry = names.has("no_entry") || names.has("no_entry_sign");
  if (hasCheck && hasNoEntry) return "disqualified";
  if (hasCheck) return "accepted";
  if (hasNoEntry) return "not_in_process";
  return "submitted";
}

const RATE_LIMIT_MAX_WAIT_MS = 30_000;
async function slackGet(path: string, token: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const retryAfterSec = Number(res.headers.get("Retry-After")) || 10;
    const data = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
    const rateLimited = res.status === 429 || data.error === "ratelimited";
    if (rateLimited && attempt < 3) {
      await new Promise((r) => setTimeout(r, Math.min(retryAfterSec * 1000, RATE_LIMIT_MAX_WAIT_MS)));
      continue;
    }
    if (!data.ok) throw new Error(`Slack ${path} failed: ${data.error ?? "unknown"}`);
    return data;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > SCAN_BUDGET_MS;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: tokenRow, error: tokenErr } = await admin.from("slack_tokens").select("access_token, slack_user_id").eq("user_id", userId).maybeSingle();
    if (tokenErr) throw tokenErr;
    if (!tokenRow) return json({ error: "Slack not connected" }, 400);
    const token: string = tokenRow.access_token as string;
    const slackUserId: string = tokenRow.slack_user_id as string;

    const body = await req.json().catch(() => ({}));
    const lookbackDays: number = Number(body.days) || LOOKBACK_DAYS_DEFAULT;
    const now = new Date();
    const lookbackOldest = new Date(now.getTime() - lookbackDays * 86_400_000);
    const lookbackOldestTs = Math.floor(lookbackOldest.getTime() / 1000);

    // ── 1. Channels: every external (Slack Connect) channel plus any carrying the agency name ──
    const channels: SlackChannel[] = [];
    let cursor = "";
    for (let i = 0; i < 50; i++) {
      const data = await slackGet("users.conversations", token, {
        types: "public_channel,private_channel", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}),
      });
      channels.push(...(((data.channels as SlackChannel[]) ?? [])));
      cursor = (data.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      if (!cursor) break;
    }
    const clientChannels = channels.filter(
      (c) => !c.is_archived && !EXCLUDED_NAME_RE.test(c.name ?? "") && (channelQualifies(c) || /^internal[-_]/i.test(c.name ?? "")),
    );
    const currentIds = new Set(clientChannels.map((c) => c.id));

    // Mappings: a client name the user typed over is kept; a DERIVED name
    // follows the channel's current name (rename hygiene).
    const { data: existingMappings } = await admin.from("slack_channel_mappings").select("channel_id, channel_name, client_name, enabled, last_synced_at").eq("user_id", userId);
    const existingByChannel = new Map<string, { channel_name: string; client_name: string; enabled: boolean; last_synced_at: string | null }>();
    for (const m of (existingMappings ?? []) as Array<Record<string, unknown>>) {
      existingByChannel.set(m.channel_id as string, {
        channel_name: (m.channel_name as string) ?? "", client_name: m.client_name as string, enabled: m.enabled as boolean, last_synced_at: (m.last_synced_at as string | null) ?? null,
      });
    }
    const channelClientNames: Record<string, string> = {};
    const mappingsUpsert = clientChannels.map((c) => {
      const existing = existingByChannel.get(c.id);
      const derivedNow = channelToClientName(c.name);
      const userOverride = existing && existing.client_name && existing.client_name !== channelToClientName(existing.channel_name || c.name);
      const clientName = userOverride ? existing!.client_name : derivedNow;
      channelClientNames[c.id] = clientName;
      return { user_id: userId, channel_id: c.id, channel_name: c.name, client_name: clientName, enabled: existing?.enabled ?? true };
    });
    if (mappingsUpsert.length) {
      const { error } = await admin.from("slack_channel_mappings").upsert(mappingsUpsert, { onConflict: "user_id,channel_id" });
      if (error) console.error("channel mapping upsert error:", error.message);
    }
    const staleIds = Array.from(existingByChannel.keys()).filter((id) => !currentIds.has(id));
    if (staleIds.length) await admin.from("slack_channel_mappings").update({ enabled: false }).eq("user_id", userId).in("channel_id", staleIds);
    const enabledChannels = clientChannels.filter((c) => existingByChannel.get(c.id)?.enabled ?? true);
    const enabledIds = new Set(enabledChannels.map((c) => c.id));

    // ── 2. Previous rows + sync state ──
    const { data: prevRaw } = await admin.from("slack_submissions").select("*").eq("user_id", userId).limit(10000);
    let previous = ((prevRaw ?? []) as unknown as SubmissionRow[]).map((r) => ({ ...r, thread_ts: r.thread_ts || r.message_ts }));
    const { data: stateRaw } = await admin.from("slack_sync_state").select("*").eq("user_id", userId).maybeSingle();
    const state = (stateRaw ?? null) as SyncState | null;
    const full = body.full === true || fullRescanDue(state, now);

    // ── 3. Hygiene: renames (vetoed for Ashby clients) and migrated twins ──
    const protectedNames: string[] = [];
    try {
      const { data: orgs } = await admin.from("ashby_orgs").select("org_name");
      for (const o of (orgs ?? []) as Array<{ org_name: string }>) protectedNames.push(o.org_name);
      const { data: real } = await admin.from("ashby_snapshot_candidates").select("company_name").neq("stage_type", "").is("org_status", null).limit(5000);
      for (const r of (real ?? []) as Array<{ company_name: string }>) if (r.company_name) protectedNames.push(r.company_name);
    } catch (e) {
      console.warn("[slack-sync] could not load Ashby names for rename veto", e);
    }
    const isProtected = (oldName: string) => protectedNames.some((n) => companiesMatch(oldName, n));
    const renames = planRenames(previous, channelClientNames, isProtected);
    for (const r of renames.applied) {
      const row = previous.find((p) => p.id === r.id)!;
      await admin.from("slack_submissions").update({ client_name: row.client_name, previous_client_names: row.previous_client_names ?? [] }).eq("id", r.id);
    }
    if (renames.applied.length) {
      const ids = renames.applied.map((r) => r.id);
      const { data: cards } = await admin.from("agent_action_cards").select("id, slack_submission_id, payload").in("slack_submission_id", ids).in("status", ["open", "snoozed"]);
      for (const c of (cards ?? []) as Array<{ id: string; slack_submission_id: string; payload: Record<string, unknown> }>) {
        const r = renames.applied.find((x) => x.id === c.slack_submission_id);
        if (!r) continue;
        await admin.from("agent_action_cards").update({ payload: { ...c.payload, company_name: r.new_name, client_name: r.new_name }, updated_at: now.toISOString() }).eq("id", c.id);
      }
      console.log(`[slack-sync] renamed ${renames.applied.length} row(s): ${Array.from(new Set(renames.applied.map((r) => `${r.old_name} -> ${r.new_name}`))).join(", ")}`);
    }
    if (renames.vetoed.length) {
      console.log(`[slack-sync] kept Ashby client names on ${renames.vetoed.length} row(s): ${Array.from(new Set(renames.vetoed.map((r) => `${r.old_name} (channel now ${r.new_name})`))).join(", ")}`);
    }
    const migrations = findMigratedTwins(previous, currentIds);
    for (const m of migrations) {
      const loserIds = m.losers.map((l) => l.id!).filter(Boolean);
      const { data: cards } = await admin.from("agent_action_cards").select("id, kind, slack_submission_id").in("slack_submission_id", [m.survivor.id!, ...loserIds]);
      const survivorKinds = new Set(((cards ?? []) as Array<{ kind: string; slack_submission_id: string }>).filter((c) => c.slack_submission_id === m.survivor.id).map((c) => c.kind));
      for (const c of (cards ?? []) as Array<{ id: string; kind: string; slack_submission_id: string }>) {
        if (c.slack_submission_id === m.survivor.id) continue;
        if (survivorKinds.has(c.kind)) await admin.from("agent_action_cards").delete().eq("id", c.id);
        else { await admin.from("agent_action_cards").update({ slack_submission_id: m.survivor.id }).eq("id", c.id); survivorKinds.add(c.kind); }
      }
      await admin.from("slack_submissions").update({
        status: m.survivor.status, last_activity_at: m.survivor.last_activity_at ?? null, last_reply_at: m.survivor.last_reply_at ?? null,
        reply_count: m.survivor.reply_count ?? 0, candidate_name: m.survivor.candidate_name ?? "", previous_client_names: m.survivor.previous_client_names ?? [],
        migrated_from_channel_id: m.losers[0]?.channel_id ?? null,
      }).eq("id", m.survivor.id!);
      if (loserIds.length) await admin.from("slack_submissions").delete().in("id", loserIds);
      previous = previous.filter((p) => !loserIds.includes(p.id!));
      console.log(`[slack-sync] merged migrated thread ${m.survivor.thread_ts}: ${m.losers.map((l) => l.channel_id).join(",")} -> ${m.survivor.channel_id}`);
    }

    // ── 4. Which previous rows to carry (activity window) ──
    const { tracked, aged_out, off_channel } = selectTrackedRows(previous, enabledIds, now, lookbackDays);
    const trackedByKey = new Map(tracked.map((r) => [`${r.channel_id}|${r.message_ts}`, r]));
    const byIdentity = new Map<string, SubmissionRow>();
    for (const r of previous) {
      const li = (r.linkedin_url || "").trim().toLowerCase();
      if (li) byIdentity.set(`${li}|${r.thread_ts || r.message_ts}`, r);
    }

    const stats = {
      mode: full ? "full" : "incremental", scan_method: "", channels_discovered: clientChannels.length, channels_scanned: 0,
      messages_seen: 0, new_submissions: 0, rekeyed: 0, threads_refreshed: 0, closed_carried: 0, carried_unchanged: 0,
      aged_out_by_activity: aged_out, off_channel, renamed: renames.applied.length, renames_vetoed: renames.vetoed.length,
      migrated_threads: migrations.length, thread_errors: 0, failed_channel_ids: [] as string[], partial: false, remaining: 0,
    };

    // ── 5. Discover new submissions ──
    type NewParent = { channel_id: string; ts: string; text: string; rekeyFrom?: SubmissionRow };
    const newParents: NewParent[] = [];
    const seenNew = new Set<string>();
    const considerParent = (channelId: string, ts: string, text: string) => {
      const key = `${channelId}|${ts}`;
      if (trackedByKey.has(key) || seenNew.has(key)) return;
      const li = (extractLinkedinUrl(text) || "").trim().toLowerCase();
      if (!li) return;
      stats.messages_seen++;
      // Same LinkedIn + same thread_ts under another channel id = a migrated
      // Slack Connect channel. Re-key the existing row, don't create a twin.
      const twin = byIdentity.get(`${li}|${ts}`);
      seenNew.add(key);
      newParents.push({ channel_id: channelId, ts, text, rekeyFrom: twin && twin.channel_id !== channelId ? twin : undefined });
    };
    const scanHistory = async (channel: SlackChannel, oldestTs: number) => {
      let chCursor = "";
      for (let i = 0; i < 20; i++) {
        if (overBudget()) return false;
        const data = await slackGet("conversations.history", token, { channel: channel.id, limit: "200", oldest: String(oldestTs), ...(chCursor ? { cursor: chCursor } : {}) });
        for (const msg of (data.messages as SlackMessage[]) ?? []) {
          if (msg.user !== slackUserId || msg.subtype) continue;
          if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;
          considerParent(channel.id, msg.ts, msg.text ?? "");
        }
        chCursor = (data.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
        if (!chCursor) return true;
      }
      return true;
    };
    const scanAllHistory = async (perChannelOldest: (c: SlackChannel) => number) => {
      const ordered = [...enabledChannels].sort((a, b) => {
        const ta = existingByChannel.get(a.id)?.last_synced_at; const tb = existingByChannel.get(b.id)?.last_synced_at;
        return (ta ? Date.parse(ta) : 0) - (tb ? Date.parse(tb) : 0);
      });
      for (const c of ordered) {
        if (overBudget()) { stats.failed_channel_ids.push(c.id); stats.partial = true; continue; }
        try {
          const complete = await scanHistory(c, perChannelOldest(c));
          if (complete) { stats.channels_scanned++; await admin.from("slack_channel_mappings").update({ last_synced_at: now.toISOString() }).eq("user_id", userId).eq("channel_id", c.id); }
          else { stats.failed_channel_ids.push(c.id); stats.partial = true; }
        } catch (e) {
          console.warn(`[slack-sync] history failed for ${c.name}:`, (e as Error).message);
          stats.failed_channel_ids.push(c.id);
        }
      }
    };

    if (full) {
      stats.scan_method = "history";
      await scanAllHistory(() => lookbackOldestTs);
    } else {
      // Preferred: one search for the recruiter's own posts since the last sync.
      const after = discoverySearchAfter(state, enabledIds, lookbackOldest);
      const query = `from:<@${slackUserId}> linkedin.com after:${after.toISOString().slice(0, 10)}`;
      try {
        for (let page = 1; page <= 20; page++) {
          const resp = await slackGet("search.messages", token, { query, count: "100", page: String(page), sort: "timestamp" });
          const messages = (resp.messages ?? {}) as { matches?: Array<Record<string, unknown>>; paging?: { pages?: number } };
          for (const m of messages.matches ?? []) {
            const channelId = ((m.channel as { id?: string } | undefined)?.id) ?? "";
            const ts = (m.ts as string) ?? "";
            if (!enabledIds.has(channelId) || !ts) continue;
            if (!isTopLevelHit({ ts, permalink: m.permalink as string })) continue;
            if (parseFloat(ts) < lookbackOldestTs) continue;
            considerParent(channelId, ts, (m.text as string) ?? "");
          }
          if (page >= (messages.paging?.pages ?? 1)) break;
        }
        stats.scan_method = "search";
        stats.channels_scanned = enabledChannels.length;
      } catch (e) {
        console.warn(`[slack-sync] search.messages failed (${(e as Error).message}); falling back to per-channel history`);
        newParents.length = 0; seenNew.clear();
        stats.scan_method = "history-fallback";
        const marks = state?.channel_watermarks ?? {};
        await scanAllHistory((c) => (typeof marks[c.id] === "number" ? Math.max(lookbackOldestTs, Math.floor(marks[c.id] - HISTORY_OVERLAP_SEC)) : lookbackOldestTs));
      }
    }
    stats.new_submissions = newParents.filter((p) => !p.rekeyFrom).length;
    stats.rekeyed = newParents.filter((p) => !!p.rekeyFrom).length;

    // ── 6. Thread refresh: open tracked rows (stalest first) + new parents ──
    const fetchThread = async (channelId: string, parentTs: string): Promise<SlackMessage[] | null> => {
      const out: SlackMessage[] = [];
      let c = "";
      try {
        for (let i = 0; i < 5; i++) {
          const data = await slackGet("conversations.replies", token, { channel: channelId, ts: parentTs, limit: "200", ...(c ? { cursor: c } : {}) });
          out.push(...(((data.messages as SlackMessage[]) ?? [])));
          c = (data.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
          if (!c) break;
        }
        return out.length ? out : null;
      } catch (e) {
        stats.thread_errors++;
        console.warn(`[slack-sync] thread fetch failed ${channelId}/${parentTs}:`, (e as Error).message);
        return null;
      }
    };
    const rowFromThread = (channelId: string, thread: SlackMessage[], prior: SubmissionRow | null, fallbackText: string) => {
      const parent = thread[0];
      const ex = extractCandidate({ text: parent.text ?? fallbackText, blocks: parent.blocks });
      const submittedAt = prior?.submitted_at ?? new Date(parseFloat(parent.ts) * 1000).toISOString();
      const act = threadActivity(thread, parent.ts, submittedAt);
      return {
        user_id: userId, channel_id: channelId, message_ts: parent.ts, thread_ts: parent.ts,
        client_name: channelClientNames[channelId] ?? prior?.client_name ?? channelToClientName(channelId),
        channel_name: enabledChannels.find((c) => c.id === channelId)?.name ?? null,
        candidate_name: ex.candidate_name || prior?.candidate_name || "",
        linkedin_url: ex.linkedin_url ?? prior?.linkedin_url ?? null,
        submitted_at: submittedAt, status: statusFromReactions(parent.reactions),
        raw_text: (parent.text ?? fallbackText ?? "").slice(0, 2000), needs_review: ex.needs_review && !(prior?.candidate_name && prior?.linkedin_url),
        last_activity_at: act.last_activity_at, reply_count: act.reply_count, last_reply_at: act.last_reply_at, last_refreshed_at: now.toISOString(),
        previous_client_names: prior?.previous_client_names ?? [],
      };
    };

    const upserts: Array<Record<string, unknown>> = [];
    const openRows = tracked.filter((r) => !isClosed(r)).sort((a, b) => (Date.parse(a.last_refreshed_at ?? "") || 0) - (Date.parse(b.last_refreshed_at ?? "") || 0));
    stats.closed_carried = tracked.length - openRows.length;
    const refreshQueue: Array<{ channel_id: string; ts: string; prior: SubmissionRow | null; text: string; rekeyFrom?: SubmissionRow }> = [
      ...newParents.map((p) => ({ channel_id: p.channel_id, ts: p.ts, prior: p.rekeyFrom ?? null, text: p.text, rekeyFrom: p.rekeyFrom })),
      ...openRows.map((r) => ({ channel_id: r.channel_id, ts: r.message_ts, prior: r, text: "" })),
    ];
    for (const item of refreshQueue) {
      if (overBudget()) { stats.partial = true; stats.remaining++; continue; }
      const thread = await fetchThread(item.channel_id, item.ts);
      if (item.rekeyFrom?.id) {
        // Migration: move the existing row to the channel we see now.
        await admin.from("slack_submissions").update({ channel_id: item.channel_id, migrated_from_channel_id: item.rekeyFrom.channel_id }).eq("id", item.rekeyFrom.id);
      }
      if (!thread) {
        if (item.prior) stats.carried_unchanged++; // keep the previous state rather than dropping it
        else upserts.push({ ...rowFromThread(item.channel_id, [{ ts: item.ts, text: item.text }], null, item.text) });
        continue;
      }
      stats.threads_refreshed++;
      upserts.push(rowFromThread(item.channel_id, thread, item.prior, item.text));
    }
    let saved = 0;
    for (let i = 0; i < upserts.length; i += 200) {
      const chunk = upserts.slice(i, i + 200);
      const { error } = await admin.from("slack_submissions").upsert(chunk, { onConflict: "user_id,channel_id,message_ts" });
      if (error) console.error(`[slack-sync] submissions chunk ${i} failed:`, error.message);
      else saved += chunk.length;
    }

    // ── 7. Sync state ──
    const marks: Record<string, number> = { ...(state?.channel_watermarks ?? {}) };
    const failed = new Set(stats.failed_channel_ids);
    for (const c of enabledChannels) if (!failed.has(c.id)) marks[c.id] = now.getTime() / 1000;
    await admin.from("slack_sync_state").upsert({
      user_id: userId, channel_watermarks: marks, live_channel_ids: Array.from(enabledIds), failed_channel_ids: stats.failed_channel_ids,
      last_sync_at: now.toISOString(), ...(full && !stats.partial ? { last_full_sync_at: now.toISOString() } : {}),
      last_scan_method: stats.scan_method, updated_at: now.toISOString(),
    }, { onConflict: "user_id" });

    console.log(`[slack-sync] ${stats.mode}/${stats.scan_method}: +${stats.new_submissions} new, ${stats.rekeyed} re-keyed, ${stats.threads_refreshed} threads refreshed, ${stats.closed_carried} closed carried, ${stats.aged_out_by_activity} aged out, ${stats.renamed} renamed, ${stats.migrated_threads} migrated${stats.partial ? `, PARTIAL (${stats.remaining} left)` : ""}`);
    return json({ ok: true, submissions_saved: saved, ...stats, channels_remaining: stats.failed_channel_ids });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("slack-sync error:", msg);
    return json({ error: msg }, 500);
  }
});
