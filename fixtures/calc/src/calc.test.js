import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { add, sub, mul } from "./calc.js";

describe("calc", () => {
  it("adds two numbers", () => {
    assert.strictEqual(add(2, 3), 5);
  });

  it("subtracts two numbers", () => {
    assert.strictEqual(sub(7, 3), 4);
  });

  it("multiplies two numbers", () => {
    assert.strictEqual(mul(2, 3), 5);
  });
});
