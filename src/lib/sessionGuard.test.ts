import { describe, it, expect } from "vitest";
import { isUnauthorizedError } from "@/lib/sessionGuard";

// A token the backend no longer accepts must read as "signed out", while every
// other failure (a denied row, a flaky network) must leave the session alone.
describe("isUnauthorizedError", () => {
  it("reads an edge function rejecting the token (401) as signed out", () => {
    expect(
      isUnauthorizedError({
        status: 401,
        message: 'Error, {"error":"Unauthorized"}',
      }),
    ).toBe(true);
  });

  it("reads the functions-client shape carrying the response on context", () => {
    expect(
      isUnauthorizedError({
        message: 'Error, {"error":"Unauthorized"}',
        context: { status: 401 },
      }),
    ).toBe(true);
  });

  it("reads a database call whose JWT cannot be decoded as signed out", () => {
    expect(
      isUnauthorizedError({
        code: "PGRST301",
        message: "No suitable key or wrong key type",
      }),
    ).toBe(true);
  });

  it("reads Auth rejecting the JWT (403 invalid signature) as signed out", () => {
    expect(
      isUnauthorizedError({
        status: 403,
        message:
          "invalid JWT: unable to parse or verify signature, token signature is invalid: signature is invalid",
      }),
    ).toBe(true);
  });

  it("leaves the session alone when a row is simply denied", () => {
    expect(
      isUnauthorizedError({
        code: "42501",
        status: 403,
        message: "permission denied for table candidates",
      }),
    ).toBe(false);
  });

  it("leaves the session alone on a network blip", () => {
    expect(isUnauthorizedError(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("leaves the session alone when there is no error", () => {
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
  });
});
