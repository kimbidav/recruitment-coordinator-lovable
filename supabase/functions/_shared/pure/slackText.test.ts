import { describe, expect, it } from "vitest";
import {
  assembleWriteup, channelQualifies, channelToClientName, cleanSlackText,
  extractCandidateName, extractLinkedinUrl, noteParts, normalizeLinkedin,
} from "./slackText";

const SOPHIA = "<@U1> <@U2> Do you have any interest in someone on the more junior side?\n" +
  ":memo: <https://www.linkedin.com/in/sophia-abolore|Sophia Abolore> – Neo Scholar, backend-focused // Bloomberg\nDetails in thread";

describe("submission parsing", () => {
  it("finds the LinkedIn URL inside Slack link markup", () => {
    expect(extractLinkedinUrl(SOPHIA)).toBe("https://www.linkedin.com/in/sophia-abolore");
    expect(extractLinkedinUrl("heads up joined this channel")).toBeNull();
  });
  it("takes the name from the link label, or the Name – description fallback", () => {
    expect(extractCandidateName(SOPHIA)).toBe("Sophia Abolore");
    expect(extractCandidateName(":memo: Ramkumar Vaidyanathan — Founding Engineer")).toBe("Ramkumar Vaidyanathan");
    expect(extractCandidateName("no name here")).toBe("");
  });
  it("normalizes LinkedIn keys", () => {
    expect(normalizeLinkedin("https://www.linkedin.com/in/x/?utm=1")).toBe("linkedin.com/in/x");
    expect(normalizeLinkedin("linkedin.com/in/x")).toBe("linkedin.com/in/x");
  });
});

describe("channel names", () => {
  it.each([
    ["candidatelabs-prelim-eng", "Prelim"],
    ["candidatelabs-agave-engineering", "Agave"],
    ["candidatelabs-charta-health-fwd", "Charta Health"],
    ["ext-candidatelabs-prometheus-engineering", "Prometheus"],
    ["supio-candidate-labs-recruiting", "Supio"],
    ["candidatelabs-valon-eng-ds", "Valon Eng Ds"],
    ["candidatelabs-applied-reality-eng", "Applied Reality"],
  ])("%s -> %s", (channel, client) => expect(channelToClientName(channel)).toBe(client));

  it("treats every external channel and any candidatelabs channel as a client channel", () => {
    expect(channelQualifies({ name: "supio-candidate-labs-recruiting", is_ext_shared: true })).toBe(true);
    expect(channelQualifies({ name: "candidatelabs-prelim-eng", is_ext_shared: false })).toBe(true);
    expect(channelQualifies({ name: "random-vendor", is_ext_shared: true })).toBe(true);
    expect(channelQualifies({ name: "eng-candidate-review", is_ext_shared: true })).toBe(false);
    expect(channelQualifies({ name: "candidatelabs-old", is_ext_shared: true, is_archived: true })).toBe(false);
    expect(channelQualifies({ name: "general" })).toBe(false);
  });
});

describe("note text for the client's ATS", () => {
  it("removes Slack-only syntax and keeps nested bullets", () => {
    const out = cleanSlackText("<@U1> Interested?\n\n\n:spiral_note_pad: <https://linkedin.com/in/x|Sophia Abolore> – backend\n• *Bloomberg* (IB Multimedia)\n    ◦ nested :+1::skin-tone-2:\n• Dream3D _(YC W23)_");
    expect(out).toBe("Interested?\n\nSophia Abolore (https://linkedin.com/in/x) – backend\n• Bloomberg (IB Multimedia)\n    ◦ nested\n• Dream3D (YC W23)");
  });
  it("leaves ordinary colons, asterisks, snake_case and URLs alone", () => {
    const keep = "Call at 10:30:45, re: comp: 5 * 3 * 2 = 30, https://x.com/a:b my_var linkedin.com/in/first_last";
    expect(cleanSlackText(keep)).toBe(keep);
  });
  it("keeps only the thread author's messages, and parts re-join to the write-up", () => {
    const msgs = [
      { user: "DK", text: SOPHIA },
      { user: "DK", text: "Experience Highlights\n• Bloomberg &amp; more" },
      { user: "CLIENT", text: "Thanks, taking a look" },
    ];
    expect(noteParts(msgs)).toHaveLength(2);
    expect(assembleWriteup(msgs)).toBe(noteParts(msgs).join("\n\n"));
    expect(assembleWriteup(msgs)).not.toContain("taking a look");
    expect(assembleWriteup(msgs)).toContain("Bloomberg & more");
  });
});
