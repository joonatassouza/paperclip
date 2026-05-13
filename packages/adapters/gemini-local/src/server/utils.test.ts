import { describe, expect, it } from "vitest";
import { filterConflictingExtraArgs } from "./utils.js";

describe("filterConflictingExtraArgs", () => {
  it("removes lone --yolo", () => {
    const { filtered, dropped } = filterConflictingExtraArgs(["--yolo"]);
    expect(filtered).toEqual([]);
    expect(dropped).toEqual(["--yolo"]);
  });

  it("removes lone -y", () => {
    const { filtered, dropped } = filterConflictingExtraArgs(["-y"]);
    expect(filtered).toEqual([]);
    expect(dropped).toEqual(["-y"]);
  });

  it("removes --approval-mode and its value token (two-token form)", () => {
    const { filtered, dropped } = filterConflictingExtraArgs(["--approval-mode", "default"]);
    expect(filtered).toEqual([]);
    expect(dropped).toEqual(["--approval-mode", "default"]);
  });

  it("removes --approval-mode=value (single-token form)", () => {
    const { filtered, dropped } = filterConflictingExtraArgs(["--approval-mode=yolo"]);
    expect(filtered).toEqual([]);
    expect(dropped).toEqual(["--approval-mode=yolo"]);
  });

  it("preserves non-conflicting args while removing conflicting ones", () => {
    const { filtered, dropped } = filterConflictingExtraArgs(["--yolo", "--policy", "foo"]);
    expect(filtered).toEqual(["--policy", "foo"]);
    expect(dropped).toEqual(["--yolo"]);
  });

  it("handles the empty case", () => {
    const { filtered, dropped } = filterConflictingExtraArgs([]);
    expect(filtered).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("passes through args that do not conflict", () => {
    const { filtered, dropped } = filterConflictingExtraArgs(["--include-directories", "/foo", "--sandbox"]);
    expect(filtered).toEqual(["--include-directories", "/foo", "--sandbox"]);
    expect(dropped).toEqual([]);
  });

  it("handles --approval-mode at end of array (no following value token)", () => {
    const { filtered, dropped } = filterConflictingExtraArgs(["--approval-mode"]);
    expect(filtered).toEqual([]);
    expect(dropped).toEqual(["--approval-mode"]);
  });

  it("removes multiple conflicting flags in one pass", () => {
    const { filtered, dropped } = filterConflictingExtraArgs([
      "--yolo",
      "--include-directories",
      "-y",
      "--approval-mode",
      "interactive",
      "--sandbox",
    ]);
    expect(filtered).toEqual(["--include-directories", "--sandbox"]);
    expect(dropped).toEqual(["--yolo", "-y", "--approval-mode", "interactive"]);
  });
});
