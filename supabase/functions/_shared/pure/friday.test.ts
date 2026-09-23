import { describe, expect, it } from "vitest";
import { normalizeFollowupToFriday } from "./friday";

describe("Friday-EOW", () => {
  const now = new Date("2026-09-23T15:00:00Z"); // a Wednesday
  it("trusts a Friday from the LLM", () => {
    expect(normalizeFollowupToFriday("2026-09-25", null, now)).toBe("2026-09-25");
  });
  it("snaps a non-Friday to the Friday of the email's week", () => {
    expect(normalizeFollowupToFriday("2026-09-24", "2026-09-22", now)).toBe("2026-09-25"); // Tue -> Fri
    expect(normalizeFollowupToFriday(null, "2026-09-21", now)).toBe("2026-09-25"); // Mon
  });
  it("rolls Fri/Sat/Sun to the next Friday", () => {
    expect(normalizeFollowupToFriday(null, "2026-09-25", now)).toBe("2026-10-02");
    expect(normalizeFollowupToFriday(null, "2026-09-26", now)).toBe("2026-10-02");
    expect(normalizeFollowupToFriday(null, "2026-09-27", now)).toBe("2026-10-02");
  });
  it("uses today in the recruiter's timezone when there is no anchor", () => {
    // 2026-09-25 03:00 UTC is still Thursday the 24th in Chicago.
    const late = new Date("2026-09-25T03:00:00Z");
    expect(normalizeFollowupToFriday(null, null, late, "America/Chicago")).toBe("2026-09-25");
    expect(normalizeFollowupToFriday(null, null, late, "UTC")).toBe("2026-10-02");
  });
});
