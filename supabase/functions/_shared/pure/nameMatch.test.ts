import { describe, expect, it } from "vitest";
import { sameCandidateName } from "./nameMatch";

describe("sameCandidateName", () => {
  it.each([
    ["sai", "Sai Xiao"],
    ["Zhaohan (Robert) Hu", "Robert (Zhaohan) Hu"],
    ["Dan Clark", "Daniel Clark"],
    ["Sophia Abolore", "sophia abolore"],
  ])("%s ≡ %s", (a, b) => expect(sameCandidateName(a, b)).toBe(true));

  it.each([
    ["Dan Clarkson", "Daniel Clark"],
    ["David Clark", "Daniel Clark"],
    ["Sophia Abolore", "Sophia Chen"],
    ["", "Sophia Abolore"],
  ])("%s ≠ %s", (a, b) => expect(sameCandidateName(a, b)).toBe(false));
});
