// sub_vision's detections as foxglove.ImageAnnotations, so Foxglove's own Image panel draws them
// over a camera: pick the detections topic under the panel's annotations, and turn on its
// synchronization to draw them only on the frames they were computed from.

import { DetectionArray, Rgb, boxesOf } from "./draw";

export const DETECTION_ARRAY_SCHEMA = "sub_vision_interfaces/msg/DetectionArray";
export const IMAGE_ANNOTATIONS_SCHEMA = "foxglove.ImageAnnotations";

// foxglove.ImageAnnotations, the fields written here.
type Time = { sec: number; nsec: number };
type Color = Rgb & { a: number };
type Point2 = { x: number; y: number };
const LINE_LOOP = 2;

export type ImageAnnotations = {
  circles: never[];
  points: {
    timestamp: Time;
    type: typeof LINE_LOOP;
    points: Point2[];
    outline_color: Color;
    outline_colors: Color[];
    fill_color: Color;
    thickness: number;
  }[];
  texts: {
    timestamp: Time;
    position: Point2;
    text: string;
    font_size: number;
    text_color: Color;
    background_color: Color;
  }[];
};

const TRANSPARENT: Color = { r: 0, g: 0, b: 0, a: 0 };
const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };

/** Each detection's box and label (best hypothesis and distance), stamped with its frame's stamp. */
export function toImageAnnotations(message: DetectionArray): ImageAnnotations {
  const timestamp = { sec: message.header.stamp.sec, nsec: message.header.stamp.nanosec };
  const annotations: ImageAnnotations = { circles: [], points: [], texts: [] };
  for (const box of boxesOf(message, 0)) {
    const color = { ...box.color, a: 1 };
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    annotations.points.push({
      timestamp,
      type: LINE_LOOP,
      points: [
        { x: box.x, y: box.y },
        { x: right, y: box.y },
        { x: right, y: bottom },
        { x: box.x, y: bottom },
      ],
      outline_color: color,
      outline_colors: [],
      fill_color: TRANSPARENT,
      thickness: 2,
    });
    if (box.label !== "") {
      // The text's origin is its bottom left: on the box's top edge.
      annotations.texts.push({
        timestamp,
        position: { x: box.x, y: box.y },
        text: box.label,
        font_size: 16,
        text_color: BLACK,
        background_color: color,
      });
    }
  }
  return annotations;
}
