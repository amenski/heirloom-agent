import { describe, it, expect } from "vitest";
import { moveWordLeft, moveWordRight, type PromptBufferState } from "./prompt-buffer.js";

function at(text: string, cursor: number): PromptBufferState {
  return { text, cursor };
}

describe("moveWordLeft", () => {
  it("jumps to the start of the current word", () => {
    expect(moveWordLeft(at("hello world", 11)).cursor).toBe(6);
  });

  it("skips trailing whitespace before jumping over the word", () => {
    expect(moveWordLeft(at("hello   world", 13)).cursor).toBe(8);
  });

  it("stops at the start of the buffer", () => {
    expect(moveWordLeft(at("hello", 0)).cursor).toBe(0);
  });

  it("jumps over consecutive words from the middle of one", () => {
    expect(moveWordLeft(at("foo bar baz", 5)).cursor).toBe(4);
  });
});

describe("moveWordRight", () => {
  it("jumps to the end of the current word", () => {
    expect(moveWordRight(at("hello world", 0)).cursor).toBe(5);
  });

  it("skips leading whitespace before jumping over the next word", () => {
    expect(moveWordRight(at("hello   world", 5)).cursor).toBe(13);
  });

  it("stops at the end of the buffer", () => {
    expect(moveWordRight(at("hello", 5)).cursor).toBe(5);
  });

  it("jumps over consecutive words from the middle of one", () => {
    expect(moveWordRight(at("foo bar baz", 5)).cursor).toBe(7);
  });
});
