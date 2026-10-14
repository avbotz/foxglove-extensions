import { ExtensionContext } from "@foxglove/extension";

import { initDetectionsPanel } from "./DetectionsPanel";
import {
  DETECTION_ARRAY_SCHEMA,
  IMAGE_ANNOTATIONS_SCHEMA,
  toImageAnnotations,
} from "./annotations";
import { DetectionArray } from "./draw";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "Detections", initPanel: initDetectionsPanel });
  extensionContext.registerMessageConverter({
    type: "schema",
    fromSchemaName: DETECTION_ARRAY_SCHEMA,
    toSchemaName: IMAGE_ANNOTATIONS_SCHEMA,
    converter: (message: DetectionArray) => toImageAnnotations(message),
  });
}
