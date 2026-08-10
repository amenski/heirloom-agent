import { describe, it, expect } from "vitest";
import {
  moveWordLeft, moveWordRight,
  getCurrentFileMentionToken,
  type PromptBufferState,
} from "./prompt-buffer.js";

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

describe("getCurrentFileMentionToken", () => {
  it("returns the token after @ at the start of a line or after whitespace", () => {
    expect(getCurrentFileMentionToken(at("@src/main.ts", 12))).toEqual({ query: "src/main.ts", start: 0 });
    expect(getCurrentFileMentionToken(at("look at @src/main.ts", 20))).toEqual({ query: "src/main.ts", start: 8 });
  });

  it("returns an empty query for a bare @, so the picker can open on the @ itself", () => {
    expect(getCurrentFileMentionToken(at("@", 1))).toEqual({ query: "", start: 0 });
  });

  it("returns null when @ is mid-word (emails) and for a trailing @ after a space", () => {
    expect(getCurrentFileMentionToken(at("a@b.com", 6))).toBeNull();
    // Word-internal: the char before @ is not whitespace.
    expect(getCurrentFileMentionToken(at("foo@bar", 7))).toBeNull();
  });

  it("stops the token at whitespace or a quote", () => {
    expect(getCurrentFileMentionToken(at("say @foo bar", 8))).toEqual({ query: "foo", start: 4 });
    expect(getCurrentFileMentionToken(at('say "@foo bar"', 9))).toBeNull();
  });

  it("ignores @ not preceded by whitespace even mid-buffer", () => {
    expect(getCurrentFileMentionToken(at("prefix@file.ts", 13))).toBeNull();
  });
});
