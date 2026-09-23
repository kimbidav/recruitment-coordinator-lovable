import { describe, expect, it } from "vitest";
import * as s from "./slackSync";

const NOW = new Date("2026-08-21T18:00:00Z");
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
const row = (o: Partial<s.SubmissionRow> & { channel_id: string; message_ts: string }): s.SubmissionRow => ({
  client_name: "Client", status: "submitted", submitted_at: iso(10), linkedin_url: "https://linkedin.com/in/x", ...o,
});

describe("activity window", () => {
  it("open rows follow last activity, closed rows the intro date, no timestamps kept", () => {
    expect(s.rowInWindow({ submitted_at: iso(100), last_activity_at: iso(5), status: "accepted" }, NOW, 60)).toBe(true);
    expect(s.rowInWindow({ submitted_at: iso(100), last_activity_at: iso(70), status: "accepted" }, NOW, 60)).toBe(false);
    expect(s.rowInWindow({ submitted_at: iso(30), status: "submitted" }, NOW, 60)).toBe(true);
    expect(s.rowInWindow({ submitted_at: iso(61), status: "submitted" }, NOW, 60)).toBe(false);
    expect(s.rowInWindow({ submitted_at: iso(61), last_activity_at: iso(5), status: "not_in_process" }, NOW, 60)).toBe(false);
    expect(s.rowInWindow({ submitted_at: "", status: "submitted" }, NOW, 60)).toBe(true);
  });
  it("selectTrackedRows drops off-channel and aged-out rows", () => {
    const rows = [row({ channel_id: "C1", message_ts: "1.1" }), row({ channel_id: "GONE", message_ts: "2.2" }), row({ channel_id: "C1", message_ts: "3.3", submitted_at: iso(90) })];
    const r = s.selectTrackedRows(rows, new Set(["C1"]), NOW, 60);
    expect(r.tracked.map((x) => x.message_ts)).toEqual(["1.1"]);
    expect(r.aged_out).toBe(1);
    expect(r.off_channel).toBe(1);
  });
});

describe("sync state", () => {
  it("full rescan due without state, without a full sync, or after 7 days", () => {
    expect(s.fullRescanDue(null, NOW)).toBe(true);
    expect(s.fullRescanDue({ last_sync_at: iso(1) }, NOW)).toBe(true);
    expect(s.fullRescanDue({ last_full_sync_at: iso(8) }, NOW)).toBe(true);
    expect(s.fullRescanDue({ last_full_sync_at: iso(3) }, NOW)).toBe(false);
  });
  it("live channel ids come from fresh watermarks", () => {
    const st = { last_sync_at: iso(0), channel_watermarks: { LIVE: NOW.getTime() / 1000, OLD: NOW.getTime() / 1000 - 12 * 86400 } };
    expect(s.liveChannelIds(st, NOW)).toEqual(new Set(["LIVE"]));
    expect(s.liveChannelIds(null, NOW)).toEqual(new Set());
  });
  it("discovery search widens to the full window for a new channel and uses the oldest failed watermark", () => {
    const oldest = new Date(NOW.getTime() - 60 * 86_400_000);
    const st = { last_sync_at: iso(1), channel_watermarks: { C1: NOW.getTime() / 1000 - 86400 } };
    expect(s.discoverySearchAfter(st, ["C1", "NEW"], oldest)).toEqual(oldest);
    expect(s.discoverySearchAfter(st, ["C1"], oldest).getTime()).toBe(NOW.getTime() - 2 * 86_400_000);
    const failed = { ...st, channel_watermarks: { C1: NOW.getTime() / 1000 - 86400, C2: NOW.getTime() / 1000 - 5 * 86400 }, failed_channel_ids: ["C2"] };
    expect(s.discoverySearchAfter(failed, ["C1", "C2"], oldest).getTime()).toBe(NOW.getTime() - 6 * 86_400_000);
  });
  it("search hits that are thread replies are not submissions", () => {
    expect(s.isTopLevelHit({ ts: "1.1", permalink: "https://x.slack.com/archives/C1/p11" })).toBe(true);
    expect(s.isTopLevelHit({ ts: "2.2", permalink: "https://x.slack.com/archives/C1/p22?thread_ts=1.1&cid=C1" })).toBe(false);
    expect(s.isTopLevelHit({ ts: "1.1", permalink: "https://x.slack.com/archives/C1/p11?thread_ts=1.1&cid=C1" })).toBe(true);
  });
});

describe("thread activity", () => {
  it("counts replies and stamps last activity from the newest reply or the intro", () => {
    const parent = "1700000000.000100";
    const a = s.threadActivity([{ ts: parent }, { ts: "1700000100.000200" }, { ts: "1700000200.000300", subtype: "channel_join" }, { ts: "1700000300.000400" }], parent, "2023-11-14T22:13:20.000Z");
    expect(a.reply_count).toBe(2);
    expect(a.last_reply_at).toBe(new Date(1700000300.0004 * 1000).toISOString());
    expect(a.last_activity_at).toBe(a.last_reply_at);
    const none = s.threadActivity([{ ts: parent }], parent, "2023-11-14T22:13:20.000Z");
    expect(none.reply_count).toBe(0);
    expect(none.last_activity_at).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("renames", () => {
  it("relabels and keeps history, idempotently; vetoed for protected (Ashby) clients", () => {
    const rows = [row({ id: "a", channel_id: "C0", message_ts: "1.1", client_name: "Roam" }), row({ id: "b", channel_id: "CK", message_ts: "2.2", client_name: "Klarity" })];
    const r = s.planRenames(rows, { C0: "Applied Reality", CK: "Within", OTHER: "Foo" }, (old) => old === "Klarity");
    expect(r.applied).toEqual([{ id: "a", old_name: "Roam", new_name: "Applied Reality" }]);
    expect(r.vetoed).toEqual([{ id: "b", old_name: "Klarity", new_name: "Within" }]);
    expect(rows[0].client_name).toBe("Applied Reality");
    expect(rows[0].previous_client_names).toEqual(["Roam"]);
    expect(rows[1].client_name).toBe("Klarity");
    expect(s.planRenames(rows, { C0: "Applied Reality" }).applied).toEqual([]);
  });
});

describe("channel migration twins", () => {
  const twins = () => [
    row({ id: "old", channel_id: "OLDCH", message_ts: "1784918192.995419", thread_ts: "1784918192.995419", status: "accepted", submitted_at: iso(30), last_activity_at: iso(14), reply_count: 2 }),
    row({ id: "new", channel_id: "NEWCH", message_ts: "1784918192.995419", thread_ts: "1784918192.995419", status: "submitted", submitted_at: iso(30), last_activity_at: iso(9), reply_count: 1 }),
  ];
  it("prefers the live channel and keeps the best knowledge", () => {
    const m = s.findMigratedTwins(twins(), new Set(["NEWCH"]));
    expect(m.length).toBe(1);
    expect(m[0].survivor.id).toBe("new");
    expect(m[0].losers.map((l) => l.id)).toEqual(["old"]);
    expect(m[0].survivor.status).toBe("accepted");
    expect(m[0].survivor.reply_count).toBe(2);
    expect(m[0].survivor.last_activity_at).toBe(iso(9));
  });
  it("without a live hint prefers recent activity", () => {
    expect(s.findMigratedTwins(twins(), new Set())[0].survivor.id).toBe("new");
  });
  it("closed is sticky on merge; different threads are never merged", () => {
    const rows = twins();
    rows[0].status = "not_in_process";
    expect(s.findMigratedTwins(rows, new Set(["NEWCH"]))[0].survivor.status).toBe("not_in_process");
    const distinct = [row({ channel_id: "CA", message_ts: "1.1", thread_ts: "1.1" }), row({ channel_id: "CB", message_ts: "2.2", thread_ts: "2.2" })];
    expect(s.findMigratedTwins(distinct, new Set())).toEqual([]);
    const sameChannel = [row({ channel_id: "C1", message_ts: "1.1", thread_ts: "1.1" }), row({ channel_id: "C1", message_ts: "1.1", thread_ts: "1.1" })];
    expect(s.findMigratedTwins(sameChannel, new Set())).toEqual([]);
  });
});
