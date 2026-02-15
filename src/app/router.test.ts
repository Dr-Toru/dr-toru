import { describe, expect, it } from "vitest";

import { isTabRouteName, parseRoute, routeKey, routeToHash } from "./router";

describe("router", () => {
  it("defaults to list when hash is empty", () => {
    expect(parseRoute("")).toEqual({ name: "list" });
  });

  it("parses list and settings routes", () => {
    expect(parseRoute("#list")).toEqual({ name: "list" });
    expect(parseRoute("#settings")).toEqual({ name: "settings" });
  });

  it("parses recording id routes", () => {
    expect(parseRoute("#recording/abc123")).toEqual({
      name: "recording",
      recordingId: "abc123",
    });
  });

  it("drops invalid recording ids", () => {
    expect(parseRoute("#recording/abc/123")).toEqual({ name: "list" });
    expect(parseRoute("#recording/invalid!")).toEqual({ name: "list" });
    expect(parseRoute("#unknown")).toEqual({ name: "list" });
  });

  it("serializes recording routes", () => {
    expect(routeToHash({ name: "recording", recordingId: "rec-1" })).toBe(
      "#recording/rec-1",
    );
    expect(routeToHash({ name: "recording", recordingId: null })).toBe(
      "#recording",
    );
    expect(routeToHash({ name: "list" })).toBe("#list");
    expect(routeToHash({ name: "settings" })).toBe("#settings");
  });

  it("builds stable route keys", () => {
    expect(routeKey({ name: "list" })).toBe("list");
    expect(routeKey({ name: "recording", recordingId: null })).toBe(
      "recording",
    );
    expect(routeKey({ name: "recording", recordingId: "abc" })).toBe(
      "recording:abc",
    );
  });

  it("detects tab routes", () => {
    expect(isTabRouteName("list")).toBe(true);
    expect(isTabRouteName("recording")).toBe(true);
    expect(isTabRouteName("settings")).toBe(false);
    expect(isTabRouteName(undefined)).toBe(false);
  });
});
