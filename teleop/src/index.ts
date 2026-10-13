import { ExtensionContext } from "@foxglove/extension";

import { initSetpointPanel } from "./SetpointPanel";
import { initTeleopPanel } from "./TeleopPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "6-DOF Teleop", initPanel: initTeleopPanel });
  extensionContext.registerPanel({ name: "Motion Setpoint", initPanel: initSetpointPanel });
}
