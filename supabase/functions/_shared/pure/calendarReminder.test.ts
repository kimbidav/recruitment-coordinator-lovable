// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as cr from "./calendarReminder";

describe("reminder identity", () => {
  it("recognizes a title with a parenthetical stage and legacy full-name titles, not substrings", () => {
    expect(cr.summaryMatches("Fan x Decagon (Onsite)", "Fan Li", "Decagon")).toBe(true);
    expect(cr.summaryMatches("Fan Li x Decagon", "Fan", "Decagon")).toBe(true);
    expect(cr.summaryMatches("Joanne x Decagon", "Ann Smith", "Decagon")).toBe(false);
    expect(cr.summaryMatches("Fan x Decagon Labs", "Fan", "Decagon")).toBe(false);
  });
  it("dedup key includes the date so a moved interview is a new reminder", () => {
    expect(cr.reminderKey("Fan Li", "Decagon", "2026-09-12")).not.toBe(cr.reminderKey("Fan Li", "Decagon", "2026-09-13"));
    expect(cr.reminderKey("fan  li", " Decagon ", "2026-09-12")).toBe(cr.reminderKey("Fan", "decagon", "2026-09-12"));
  });
  it("stable id is deterministic and Google-compatible", async () => {
    const a = await cr.stableEventId("Fan Li", "Decagon", "2026-09-12");
    const b = await cr.stableEventId("fan", "decagon", "2026-09-12");
    expect(a).toBe(b);
    expect(a).toMatch(/^rca[0-9a-v]{40,}$/);
    expect(await cr.stableEventId("Fan", "Decagon", "2026-09-13")).not.toBe(a);
  });
  it("summary uses the first name only", () => {
    expect(cr.reminderSummary("Fan Li", "Decagon")).toBe("Fan x Decagon");
  });
});

describe("timezone math", () => {
  it("17:00 Chicago on a DST date and a standard-time date", () => {
    expect(cr.zonedTimeToUtc("2026-07-01", "17:00", "America/Chicago").toISOString()).toBe("2026-07-01T22:00:00.000Z");
    expect(cr.zonedTimeToUtc("2026-12-01", "17:00", "America/Chicago").toISOString()).toBe("2026-12-01T23:00:00.000Z");
  });
  it("local day can begin on the previous UTC date", () => {
    expect(cr.localDateOf("2026-09-13T03:30:00Z", "America/Los_Angeles")).toBe("2026-09-12");
    expect(cr.localDateOf("2026-09-12", "America/Los_Angeles")).toBe("2026-09-12");
  });
  it("validates timezones", () => {
    expect(cr.isValidTimeZone("America/Chicago")).toBe(true);
    expect(cr.isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
