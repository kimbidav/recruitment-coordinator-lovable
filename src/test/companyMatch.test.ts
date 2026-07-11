import { describe, expect, it } from "vitest";
import { companiesMatch, isAshbyCompany } from "@/lib/companyMatch";

describe("companiesMatch", () => {
  it("collapses lenient variants", () => {
    expect(companiesMatch("Listen Labs", "Listenlabs")).toBe(true);
    expect(companiesMatch("Crosby", "Crosby Legal")).toBe(true);
    expect(companiesMatch("Valon Tech", "Valon Eng Ds")).toBe(true);
  });

  it("keeps different companies separate", () => {
    expect(companiesMatch("Decagon", "January")).toBe(false);
  });

  it("never fuzzy-collapses SEPARATE_CLIENTS entries", () => {
    // "Anterior Vpe Cto" is a distinct loop from "Anterior" — an Anterior
    // org/archive must not swallow it.
    expect(companiesMatch("Anterior", "Anterior Vpe Cto")).toBe(false);
    expect(companiesMatch("Anterior Vpe Cto", "Anterior")).toBe(false);
    expect(companiesMatch("Anterior VPE/CTO", "Anterior Vpe Cto")).toBe(true);
    expect(companiesMatch("Anterior Vpe Cto", "Anterior Vpe Cto")).toBe(true);
    // Plain Anterior still matches itself.
    expect(companiesMatch("Anterior", "Anterior")).toBe(true);
  });

  it("isAshbyCompany respects the separate-client rule", () => {
    const ashbyOrgs = ["Anterior"];
    expect(isAshbyCompany("Anterior Vpe Cto", ashbyOrgs)).toBe(false);
    expect(isAshbyCompany("Anterior", ashbyOrgs)).toBe(true);
  });
});
