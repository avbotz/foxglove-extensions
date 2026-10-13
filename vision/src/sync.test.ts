import { describe, expect, it } from "vitest";

import { FrameSync, Stamped, stampKey } from "./sync";

function stamped<T>(stamp: number, receivedAt: number, value: T): Stamped<T> {
  const sec = Math.floor(stamp);
  return { key: stampKey({ sec, nanosec: Math.round((stamp - sec) * 1e9) }), stamp, receivedAt, value };
}

const keys = (shown: { frame: { key: string }; detections: unknown }[]) =>
  shown.map((s) => `${s.frame.key}${s.detections == undefined ? "" : "+"}`);

describe("FrameSync in detected mode", () => {
  const options = { mode: "detected" as const, waitMs: 100, detectorTimeoutMs: 1000 };

  it("shows frames as they come until the detector speaks", () => {
    const sync = new FrameSync<string, string>(options);
    expect(keys(sync.addFrame(stamped(10, 0, "a"), 0))).toEqual(["10.000000000"]);
    expect(keys(sync.addFrame(stamped(10.1, 10, "b"), 10))).toEqual(["10.100000000"]);
  });

  it("pairs a frame with its detections and skips the frames between", () => {
    const sync = new FrameSync<string, string>(options);
    sync.addDetections(stamped(10, 50, "d0"), 50);
    sync.addFrame(stamped(10, 50, "a"), 50);
    expect(sync.addFrame(stamped(10.1, 60, "b"), 60)).toEqual([]);
    expect(sync.addFrame(stamped(10.2, 70, "c"), 70)).toEqual([]);
    const shown = sync.addDetections(stamped(10.2, 90, "d2"), 90);
    expect(keys(shown)).toEqual(["10.200000000+"]);
    expect(shown[0]?.detections?.value).toBe("d2");
    // b was skipped by the detector and never shows.
    expect(sync.tick(5000)).toEqual([]);
  });

  it("holds detections that arrive before their frame", () => {
    const sync = new FrameSync<string, string>(options);
    expect(sync.addDetections(stamped(10, 0, "d"), 0)).toEqual([]);
    expect(keys(sync.addFrame(stamped(10, 5, "a"), 5))).toEqual(["10.000000000+"]);
  });

  it("falls back to every frame once the detector goes quiet", () => {
    const sync = new FrameSync<string, string>(options);
    sync.addDetections(stamped(10, 0, "d"), 0);
    sync.addFrame(stamped(10, 0, "a"), 0);
    expect(sync.addFrame(stamped(10.1, 500, "b"), 500)).toEqual([]);
    // The wait is over: b is shown bare, and later frames go straight through.
    expect(keys(sync.tick(1100))).toEqual(["10.100000000"]);
    expect(keys(sync.addFrame(stamped(10.2, 1200, "c"), 1200))).toEqual(["10.200000000"]);
  });

  it("never shows a frame older than one already shown", () => {
    const sync = new FrameSync<string, string>(options);
    sync.addFrame(stamped(10.2, 0, "c"), 0);
    expect(sync.addFrame(stamped(10.1, 1, "b"), 1)).toEqual([]);
  });

  it("shows unstamped frames without pairing", () => {
    const sync = new FrameSync<string, string>(options);
    sync.addDetections(stamped(10, 0, "d"), 0);
    const frame = { key: "", stamp: 0, receivedAt: 1, value: "a" };
    expect(sync.addFrame(frame, 1)).toEqual([{ frame, detections: undefined }]);
  });
});

describe("FrameSync in all mode", () => {
  const options = { mode: "all" as const, waitMs: 100, detectorTimeoutMs: 1000 };

  it("shows a frame bare once its wait runs out", () => {
    const sync = new FrameSync<string, string>(options);
    sync.addDetections(stamped(10, 0, "d"), 0);
    sync.addFrame(stamped(10, 0, "a"), 0);
    expect(sync.addFrame(stamped(10.1, 10, "b"), 10)).toEqual([]);
    expect(sync.tick(50)).toEqual([]);
    expect(keys(sync.tick(110))).toEqual(["10.100000000"]);
  });

  it("shows older waiting frames bare before a detected one", () => {
    const sync = new FrameSync<string, string>(options);
    sync.addDetections(stamped(10, 0, "d"), 0);
    sync.addFrame(stamped(10, 0, "a"), 0);
    sync.addFrame(stamped(10.1, 10, "b"), 10);
    sync.addFrame(stamped(10.2, 20, "c"), 20);
    expect(keys(sync.addDetections(stamped(10.2, 40, "d2"), 40))).toEqual([
      "10.100000000",
      "10.200000000+",
    ]);
  });
});

describe("stampKey", () => {
  it("pads nanoseconds and marks an unstamped header", () => {
    expect(stampKey({ sec: 12, nanosec: 5 })).toBe("12.000000005");
    expect(stampKey({ sec: 0, nanosec: 0 })).toBe("");
  });
});
