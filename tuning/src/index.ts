import { ExtensionContext } from "@foxglove/extension";

import { initGainsPanel } from "./GainsPanel";
import { initRoutinesPanel } from "./RoutinesPanel";
import { initSignalsPanel } from "./SignalsPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "Controller Gains", initPanel: initGainsPanel });
  extensionContext.registerPanel({ name: "Tuning Routines", initPanel: initRoutinesPanel });
  extensionContext.registerPanel({ name: "Controller Signals", initPanel: initSignalsPanel });
}
