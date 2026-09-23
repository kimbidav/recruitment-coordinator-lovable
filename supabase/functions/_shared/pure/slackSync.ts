// Slack sync hygiene rules, ported from the desktop coordinator's
// incremental_slack_sync.py and agent_state.py. Pure so both the edge
// function and vitest run the same logic.
//
// The rules that encode business judgment:
//  * The lookback window follows ACTIVITY, not the intro date. An open loop
//    is in scope while its last thread activity is inside the window,
//    however old the intro. Closed (⛔) submissions age out by intro date —
//    closing is deliberate and sticky.
//  * Discovery is one search for the recruiter's own LinkedIn posts since
//    the last sync; a channel with no watermark widens the search back to
//    the full window so a newly-in-scope channel's older submissions are
//    picked up now, not at the next weekly rescan.
//  * A full rescan is due weekly (self-heals drift the incremental path
//    can't see: edited parents, reactions removed from closed rows).
//  * (linkedin_url, thread_ts) is the migration-stable identity: the same
//    thread seen under a new channel id is the SAME submission, re-keyed —
//    never a twin. Survivor = the channel the sync currently sees, then the
//    most recent activity; closed is sticky across a merge.
//  * client_name follows the channel's CURRENT name (Roam -> Applied
//    Reality), except for Ashby clients, where the ATS org name is ground
//    truth and every Ashby join keys on it.

export const FULL_RESYNC_DAYS = 7;
export const LOOKBACK_DAYS_DEFAULT = 60;
export const CLOSED_STATUSES: ReadonlySet<string> = new Set(["not_in_process", "disqualified"]);

export interface SyncState {
  channel_watermarks?: Record<string, number>;
  live_channel_ids?: string[];
  failed_channel_ids?: string[];
  last_sync_at?: string | null;
  last_full_sync_at?: string | null;
}

export interface SubmissionRow {
  id?: string;
  channel_id: string;
  message_ts: string;
  thread_ts?: string | null;
  linkedin_url?: string | null;
  client_name: string;
  candidate_name?: string;
  status: string;
  submitted_at: string;
  last_activity_at?: string | null;
  reply_count?: number;
  last_reply_at?: string | null;
  previous_client_names?: string[];
  last_refreshed_at?: string | null;
}

function parseTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function isClosed(row: Pick<SubmissionRow, "status">): boolean {
  return CLOSED_STATUSES.has((row.status || "").toLowerCase());
}

/** Last real signal on a submission: last thread activity, else the intro. */
export function rowLastActivity(row: Pick<SubmissionRow, "submitted_at" | "last_activity_at">): number | null {
  return parseTs(row.last_activity_at) ?? parseTs(row.submitted_at);
}

/**
 * Is this row in scope? Open rows: last activity inside the window (a row
 * with no timestamps is kept — no evidence it aged out). Closed rows: intro
 * inside the window.
 */
export function rowInWindow(row: Pick<SubmissionRow, "submitted_at" | "last_activity_at" | "status">, now: Date, lookbackDays = LOOKBACK_DAYS_DEFAULT): boolean {
  const oldest = now.getTime() - lookbackDays * 86_400_000;
  const anchor = isClosed(row) ? parseTs(row.submitted_at) : rowLastActivity(row);
  if (anchor === null) return true;
  return anchor >= oldest;
}

export function fullRescanDue(state: SyncState | null | undefined, now: Date): boolean {
  if (!state) return true;
  const last = parseTs(state.last_full_sync_at);
  if (last === null) return true;
  return (now.getTime() - last) / 86_400_000 >= FULL_RESYNC_DAYS;
}

/** Channels the last sync actually saw (watermarked within ~a week). */
export function liveChannelIds(state: SyncState | null | undefined, now: Date): Set<string> {
  const out = new Set<string>();
  if (!state) return out;
  const marks = state.channel_watermarks ?? {};
  for (const [cid, mark] of Object.entries(marks)) {
    if (typeof mark === "number" && now.getTime() / 1000 - mark <= FULL_RESYNC_DAYS * 86_400) out.add(cid);
  }
  for (const cid of state.live_channel_ids ?? []) out.add(cid);
  return out;
}

/**
 * The `after:` date for the discovery search. Full window when any current
 * channel has no watermark (it is new to the sync); otherwise the earlier of
 * the last sync and the oldest failed channel's watermark, backed up a day
 * because `after:` is day-granular.
 */
export function discoverySearchAfter(state: SyncState | null | undefined, currentChannelIds: Iterable<string>, lookbackOldest: Date): Date {
  const ids = Array.from(currentChannelIds);
  const marks = state?.channel_watermarks ?? {};
  const hasNew = ids.some((cid) => !(cid in marks));
  const lastSync = parseTs(state?.last_sync_at);
  if (lastSync === null || hasNew) return lookbackOldest;
  let after = lastSync;
  const failed = (state?.failed_channel_ids ?? []).map((cid) => marks[cid]).filter((m): m is number => typeof m === "number");
  if (failed.length) after = Math.min(after, Math.min(...failed) * 1000);
  return new Date(Math.max(lookbackOldest.getTime(), after - 86_400_000));
}

const THREAD_TS_RE = /[?&]thread_ts=(\d+\.\d+)/;

/** A search hit is a top-level submission unless its permalink names a different parent. */
export function isTopLevelHit(hit: { ts?: string; permalink?: string }): boolean {
  const m = (hit.permalink || "").match(THREAD_TS_RE);
  return !m || m[1] === hit.ts;
}

export interface ThreadActivity {
  reply_count: number;
  last_reply_at: string | null;
  last_activity_at: string;
}

/** Reply count and last activity from a conversations.replies page set. */
export function threadActivity(messages: Array<{ ts?: string; thread_ts?: string; subtype?: string }>, parentTs: string, submittedAt: string): ThreadActivity {
  let count = 0;
  let last = 0;
  for (const m of messages) {
    if (!m.ts || m.ts === parentTs) continue;
    if (m.subtype && m.subtype !== "thread_broadcast") continue;
    count++;
    const t = parseFloat(m.ts) * 1000;
    if (Number.isFinite(t) && t > last) last = t;
  }
  const submitted = parseTs(submittedAt) ?? parseFloat(parentTs) * 1000;
  return {
    reply_count: count,
    last_reply_at: last ? new Date(last).toISOString() : null,
    last_activity_at: new Date(Math.max(submitted, last)).toISOString(),
  };
}

export interface Rename { id: string; old_name: string; new_name: string }

/**
 * Re-derive client_name from each channel's current name. `isProtected(old)`
 * vetoes a rename (Ashby clients keep the ATS name). Mutates rows in place;
 * returns the renames applied and the ones vetoed.
 */
export function planRenames(
  rows: SubmissionRow[],
  channelClientNames: Record<string, string>,
  isProtected: (oldName: string) => boolean = () => false,
): { applied: Rename[]; vetoed: Rename[] } {
  const applied: Rename[] = [];
  const vetoed: Rename[] = [];
  for (const row of rows) {
    const newName = (channelClientNames[row.channel_id] || "").trim();
    if (!newName) continue;
    const oldName = (row.client_name || "").trim();
    if (oldName === newName) continue;
    const r: Rename = { id: row.id ?? `${row.channel_id}|${row.message_ts}`, old_name: oldName, new_name: newName };
    if (oldName && isProtected(oldName)) {
      vetoed.push(r);
      continue;
    }
    const history = [...(row.previous_client_names ?? [])];
    if (oldName && !history.includes(oldName)) history.push(oldName);
    row.previous_client_names = history;
    row.client_name = newName;
    applied.push(r);
  }
  return { applied, vetoed };
}

export interface Migration { survivor: SubmissionRow; losers: SubmissionRow[] }

const STATUS_RANK: Record<string, number> = { submitted: 1, accepted: 2 };

/**
 * Group rows that are the same submission under two channel ids (same
 * LinkedIn URL + thread_ts). Survivor: a channel the sync currently sees,
 * then most recent activity, then earliest intro. Closed is sticky.
 */
export function findMigratedTwins(rows: SubmissionRow[], liveChannels: Set<string>): Migration[] {
  const groups = new Map<string, SubmissionRow[]>();
  for (const row of rows) {
    const li = (row.linkedin_url || "").trim().toLowerCase();
    const ts = row.thread_ts || row.message_ts;
    if (!li || !ts) continue;
    const key = `${li}\u0000${ts}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const out: Migration[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (new Set(group.map((r) => r.channel_id)).size < 2) continue; // same-channel dupes are out of scope
    const rank = (r: SubmissionRow) => [liveChannels.has(r.channel_id) ? 1 : 0, rowLastActivity(r) ?? 0, -(parseTs(r.submitted_at) ?? 0)];
    const sorted = [...group].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
      return 0;
    });
    const survivor = sorted[0];
    const losers = sorted.slice(1);
    for (const loser of losers) mergeInto(survivor, loser);
    out.push({ survivor, losers });
  }
  return out;
}

function mergeInto(survivor: SubmissionRow, other: SubmissionRow): void {
  if (isClosed(other) && !isClosed(survivor)) survivor.status = other.status;
  else if (!isClosed(survivor) && (STATUS_RANK[other.status] ?? 0) > (STATUS_RANK[survivor.status] ?? 0)) survivor.status = other.status;
  const s = parseTs(survivor.last_activity_at);
  const o = parseTs(other.last_activity_at);
  if (o !== null && (s === null || o > s)) {
    survivor.last_activity_at = other.last_activity_at;
    survivor.last_reply_at = other.last_reply_at ?? survivor.last_reply_at;
  }
  survivor.reply_count = Math.max(survivor.reply_count ?? 0, other.reply_count ?? 0);
  if (!survivor.candidate_name && other.candidate_name) survivor.candidate_name = other.candidate_name;
  const hist = new Set([...(survivor.previous_client_names ?? []), ...(other.previous_client_names ?? [])]);
  if (other.client_name && other.client_name !== survivor.client_name) hist.add(other.client_name);
  survivor.previous_client_names = Array.from(hist);
}

/**
 * Pick which previously-tracked rows to carry into this sync: rows in
 * current channels and inside the activity window. Returns the aged-out
 * count too, for the stats line.
 */
export function selectTrackedRows(rows: SubmissionRow[], currentChannelIds: Set<string>, now: Date, lookbackDays = LOOKBACK_DAYS_DEFAULT): { tracked: SubmissionRow[]; aged_out: number; off_channel: number } {
  const tracked: SubmissionRow[] = [];
  let agedOut = 0;
  let offChannel = 0;
  for (const row of rows) {
    if (!currentChannelIds.has(row.channel_id)) {
      offChannel++;
      continue;
    }
    if (!rowInWindow(row, now, lookbackDays)) {
      agedOut++;
      continue;
    }
    tracked.push(row);
  }
  return { tracked, aged_out: agedOut, off_channel: offChannel };
}
