import { describe, expect, it } from "vitest";

import { DetectionArray, boxesOf, classColor, fitContain } from "./draw";

function detection(classId: string, score: number, distance = NaN) {
  return {
    detection: {
      results: [{ hypothesis: { class_id: classId, score } }],
      bbox: { center: { position: { x: 100, y: 50 }, theta: 0 }, size_x: 40, size_y: 20 },
      id: "",
    },
    bearing_horizontal: 0,
    bearing_vertical: 0,
    distance_m: distance,
    pose_valid: false,
  };
}

describe("boxesOf", () => {
  it("turns centered boxes into corners and labels them", () => {
    const message: DetectionArray = {
      header: { stamp: { sec: 1, nanosec: 0 }, frame_id: "cam" },
      task: "gate",
      detections: [detection("gate", 0.91, 2.34), detection("buoy", 0.2)],
    };
    const boxes = boxesOf(message, 0.5);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ x: 80, y: 40, width: 40, height: 20, label: "gate 0.91 2.3 m" });
    expect(boxesOf(message, 0)).toHaveLength(2);
  });
});

describe("classColor", () => {
  it("is stable and differs between classes", () => {
    expect(classColor("gate")).toBe(classColor("gate"));
    expect(classColor("gate")).not.toBe(classColor("buoy"));
  });
});

describe("fitContain", () => {
  it("letterboxes a wide image in a tall box", () => {
    expect(fitContain(200, 100, 100, 100)).toEqual({ scale: 0.5, dx: 0, dy: 25 });
  });
});
