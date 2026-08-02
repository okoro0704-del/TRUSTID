import { describe, expect, it } from "vitest";
import { evaluateSignatureCounter } from "../src/modules/authentication/counter.js";

describe("evaluateSignatureCounter", () => {
  it("accepts a normal increment", () => {
    expect(evaluateSignatureCounter(1n, 2)).toEqual({
      action: "accept",
      warning: false,
    });
  });

  it("accepts platform authenticators that keep counter at zero", () => {
    expect(evaluateSignatureCounter(0n, 0)).toEqual({
      action: "accept",
      warning: false,
    });
  });

  it("warns on unchanged non-zero counter without locking out", () => {
    expect(evaluateSignatureCounter(5n, 5)).toEqual({
      action: "accept",
      warning: true,
      reason: "unchanged",
    });
  });

  it("warns on rollback without locking out", () => {
    expect(evaluateSignatureCounter(9n, 3)).toEqual({
      action: "accept",
      warning: true,
      reason: "rollback",
    });
  });
});
