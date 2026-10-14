import { describe, expect, it } from "vitest";

import { toImageAnnotations } from "./annotations";
import { DetectionArray } from "./draw";

describe("toImageAnnotations", () => {
  it("draws each detection's box and label at its frame's stamp", () => {
    const message: DetectionArray = {
      header: { stamp: { sec: 12, nanosec: 345 }, frame_id: "cam" },
      task: "gate",
      detections: [
        {
          detection: {
            results: [{ hypothesis: { class_id: "gate", score: 0.91 } }],
            bbox: { center: { position: { x: 100, y: 50 }, theta: 0 }, size_x: 40, size_y: 20 },
            id: "",
          },
          bearing_horizontal: 0,
          bearing_vertical: 0,
          distance_m: NaN,
          pose_valid: false,
        },
      ],
    };
    const annotations = toImageAnnotations(message);
    expect(annotations.points).toHaveLength(1);
    expect(annotations.points[0]!.timestamp).toEqual({ sec: 12, nsec: 345 });
    expect(annotations.points[0]!.points).toEqual([
      { x: 80, y: 40 },
      { x: 120, y: 40 },
      { x: 120, y: 60 },
      { x: 80, y: 60 },
    ]);
    expect(annotations.texts).toHaveLength(1);
    expect(annotations.texts[0]).toMatchObject({ text: "gate 0.91", position: { x: 80, y: 40 } });
  });
});
