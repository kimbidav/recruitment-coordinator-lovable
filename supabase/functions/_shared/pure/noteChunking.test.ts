import { describe, expect, it } from "vitest";
import { joinNote, splitNote } from "./noteChunking";

const roundtrip = (parts: string[]) => {
  const chunks = splitNote(parts);
  for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(2900);
  return joinNote(chunks.map((c) => c.text), chunks.map((c) => c.joiner));
};

describe("note chunking", () => {
  it("an unedited note round-trips exactly", () => {
    const parts = ["Intro blurb", "para one. ".repeat(200) + "\n\n" + "para two. ".repeat(250) + "\nline\n" + "x".repeat(50)];
    expect(roundtrip(parts)).toBe(parts.join("\n\n"));
  });
  it("a paragraph with no breaks is hard-cut and still round-trips", () => {
    const blob = "x".repeat(7000);
    expect(roundtrip([blob])).toBe(blob);
    expect(splitNote([blob])).toHaveLength(3);
  });
  it("an emptied chunk drops out without leaving a gap", () => {
    const chunks = splitNote(["Intro", "Highlights", "Comp"]);
    expect(joinNote(["Intro", "", "Comp"], chunks.map((c) => c.joiner))).toBe("Intro\n\nComp");
    expect(joinNote(["Intro", "  "], splitNote(["Intro", "Highlights"]).map((c) => c.joiner))).toBe("Intro");
  });
});
