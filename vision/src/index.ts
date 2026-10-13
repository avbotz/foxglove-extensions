import { ExtensionContext } from "@foxglove/extension";

import { initDetectionsPanel } from "./DetectionsPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "Detections", initPanel: initDetectionsPanel });
}
