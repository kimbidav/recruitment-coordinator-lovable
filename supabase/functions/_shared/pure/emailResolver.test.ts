import { describe, expect, it } from "vitest";
import { buildQueries, isSystemAddress, parseCandidateName, scoreCandidateMessages, summarizeResolution, type ResolverMessage } from "./emailResolver";

describe("parseCandidateName", () => {
  it("keeps parenthetical nicknames and the surname", () => {
    const p = parseCandidateName("DJ (Krishnamurthy) Dvijotham");
    expect(p.firsts).toEqual(["dj", "krishnamurthy"]);
    expect(p.surname).toBe("dvijotham");
    expect(p.single_token).toBe(false);
    expect(p.searchable_surname).toBe(true);
  });
  it("short surname is not searchable bare", () => {
    const p = parseCandidateName("Zoe (Zhaoyuan) Xi");
    expect(p.firsts).toEqual(["zoe", "zhaoyuan"]);
    expect(p.surname).toBe("xi");
    expect(p.searchable_surname).toBe(false);
  });
  it("strips trailing junk and suffixes", () => {
    let p = parseCandidateName("Aayush Gupta –");
    expect(p.firsts).toEqual(["aayush"]);
    expect(p.surname).toBe("gupta");
    p = parseCandidateName("Jane Smith-Jones Jr.");
    expect(p.surname).toBe("smithjones");
    expect(p.display_surname).toBe("Smith-Jones");
  });
  it("common-word surname is tight; single token; multi-word parentheticals ignored", () => {
    expect(parseCandidateName("Sahil Jolly").searchable_surname).toBe(false);
    const m = parseCandidateName("Madonna");
    expect(m.single_token).toBe(true);
    expect(m.surname).toBe("madonna");
    expect(m.firsts).toEqual([]);
    const a = parseCandidateName("Alex (he/him) Chen");
    expect(a.firsts).toEqual(["alex"]);
    expect(a.surname).toBe("chen");
  });
});

describe("buildQueries", () => {
  it("never runs a first-name-only query", () => {
    for (const name of ["DJ (Krishnamurthy) Dvijotham", "Zoe (Zhaoyuan) Xi", "Sahil Jolly", "Aayush Gupta –", "Charles Lin"]) {
      const parsed = parseCandidateName(name);
      const qs = buildQueries(parsed);
      expect(qs.length).toBeGreaterThan(0);
      for (const q of qs) {
        expect(q.anchor).toBe(true);
        expect(q.q.toLowerCase()).toContain(parsed.display_surname.toLowerCase());
        for (const f of parsed.display_firsts) {
          expect(q.q).not.toContain(`from:"${f}"`);
          expect(q.q.trim()).not.toBe(`"${f}"`);
        }
      }
    }
  });
  it("surname anchor excludes the internal domain and reads sent mail", () => {
    const qs = buildQueries(parseCandidateName("DJ (Krishnamurthy) Dvijotham")).map((q) => q.q);
    expect(qs.some((q) => q.includes("-from:candidatelabs.com"))).toBe(true);
    expect(qs.some((q) => q.startsWith('from:me "Dvijotham"'))).toBe(true);
  });
});

describe("isSystemAddress", () => {
  it("flags notifiers, keeps humans", () => {
    for (const a of ["notifications@calendly.com", "no-reply@zoom.us", "reminder@superhuman.com", "calendar-notification@google.com", "drive-shares-dm-noreply@google.com", "careers@acme.com"]) {
      expect(isSystemAddress(a)).toBe(true);
    }
    for (const a of ["autumn.smith@gmail.com", "newsome.j@gmail.com", "dvijcse@gmail.com"]) expect(isSystemAddress(a)).toBe(false);
  });
});

const DK = "David Kimball <dkimball@candidatelabs.com>";
const OWN = { ownAddresses: ["dkimball@candidatelabs.com"] };
const msg = (id: string, thread: string, from: string, o: Partial<ResolverMessage> & { to?: string; cc?: string; subject?: string } = {}): ResolverMessage => ({
  id, threadId: thread,
  headers: { From: from, To: o.to ?? "", Cc: o.cc ?? "", Subject: o.subject ?? "", Date: "" },
  snippet: o.snippet ?? "", date: o.date ?? "2026-07-20", anchor: o.anchor ?? true, body: o.body ?? "",
});

describe("scoreCandidateMessages", () => {
  it("DJ regression: personal gmail scores high, the colleague is excluded", () => {
    const parsed = parseCandidateName("DJ (Krishnamurthy) Dvijotham");
    const out = scoreCandidateMessages([
      msg("1", "t1", DK, { to: "dvijcse@gmail.com", subject: "Chat recap", date: "2026-07-20" }),
      msg("2", "t2", DK, { to: "dvijcse@gmail.com", subject: "How did the Prometheus conversation go?", date: "2026-08-01" }),
      msg("3", "t2", "Dvijotham Krishnamurthy <dvijcse@gmail.com>", { to: DK, subject: "Re: How did the Prometheus conversation go?", date: "2026-08-03" }),
      msg("4", "t3", "Calendly <notifications@calendly.com>", { to: DK, subject: "New Event: Dj Dvijotham - 12:00pm Mon, Jul 20",
        snippet: "A new event has been scheduled. Event Type: Intro chat Invitee: Dj Dvijotham  Invitee Email: dvijcse@gmail.com Event Date", date: "2026-07-14" }),
      msg("5", "t4", "Zoom <no-reply@zoom.us>", { to: DK, subject: "Notetaker joined: Dj Dvijotham and David Kimball", date: "2026-07-20" }),
      msg("6", "t5", "DJ DeAnda <djdeanda@candidatelabs.com>", { to: DK, subject: "Re: pipeline sync", date: "2026-08-05", anchor: false }),
    ], parsed, OWN);
    const top = out.candidates[0];
    expect(top.email).toBe("dvijcse@gmail.com");
    expect(top.confidence).toBe("high");
    expect(top.bidirectional).toBe(true);
    const kinds = new Set(top.evidence.map((e) => e.kind));
    expect(kinds.has("you_emailed") && kinds.has("they_emailed") && kinds.has("calendly_invitee")).toBe(true);
    expect(out.candidates.every((c) => !c.email.endsWith("@candidatelabs.com"))).toBe(true);
    expect(out.supporting.some((s) => s.kind === "scheduling_notice")).toBe(true);
  });
  it("local-part-only surname match caps at low", () => {
    const out = scoreCandidateMessages([
      msg("1", "t1", "<arul18.gupta@gmail.com>", { to: DK, subject: "Hi", date: "2026-07-01" }),
      msg("2", "t2", "<arul18.gupta@gmail.com>", { to: DK, subject: "Hello again", date: "2026-07-05" }),
    ], parseCandidateName("Aayush Gupta"), OWN);
    expect(out.candidates[0].email).toBe("arul18.gupta@gmail.com");
    expect(out.candidates[0].confidence).toBe("low");
  });
  it("a conflicting first name demotes to low", () => {
    const out = scoreCandidateMessages([
      msg("1", "t1", "Rahul Gupta <rahul.g@gmail.com>", { to: DK, subject: "Re: roles", date: "2026-07-01" }),
      msg("2", "t2", DK, { to: "Rahul Gupta <rahul.g@gmail.com>", subject: "Re: roles", date: "2026-07-02" }),
    ], parseCandidateName("Aayush Gupta"), OWN);
    expect(out.candidates[0].confidence).toBe("low");
  });
  it("no name evidence is dropped; internal and system never become candidates", () => {
    expect(scoreCandidateMessages([msg("1", "t1", DK, { to: "hiring.manager@client.com", subject: "About Aayush Gupta" })], parseCandidateName("Aayush Gupta"), OWN).candidates).toEqual([]);
    const out = scoreCandidateMessages([
      msg("1", "t1", "Dvijotham DeAnda <dj@candidatelabs.com>", { to: DK, subject: "x" }),
      msg("2", "t2", "Dvijotham Bot <noreply@dvijotham.com>", { to: DK, subject: "x" }),
      msg("3", "t3", DK, { to: "dkimball@candidatelabs.com", subject: "Dvijotham note to self" }),
    ], parseCandidateName("DJ (Krishnamurthy) Dvijotham"), OWN);
    expect(out.candidates).toEqual([]);
  });
  it("single-token name caps at medium", () => {
    const out = scoreCandidateMessages([
      msg("1", "t1", "Dvijotham <dvijcse@gmail.com>", { to: DK, subject: "Hi", date: "2026-07-01" }),
      msg("2", "t2", DK, { to: "Dvijotham <dvijcse@gmail.com>", subject: "Re: Hi", date: "2026-07-02" }),
    ], parseCandidateName("Dvijotham"), OWN);
    expect(out.candidates[0].confidence).toBe("medium");
  });
  it("summarizeResolution sets email only at high/medium", () => {
    const parsed = parseCandidateName("Aayush Gupta");
    const low = scoreCandidateMessages([msg("1", "t1", "<arul18.gupta@gmail.com>", { to: DK, subject: "Hi" })], parsed, OWN);
    const r = summarizeResolution(parsed, ["q"], low);
    expect(r.email).toBeNull();
    expect(r.confidence).toBe("low");
    expect(r.candidates[0].email).toBe("arul18.gupta@gmail.com");
  });
});
