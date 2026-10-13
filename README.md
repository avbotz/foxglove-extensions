# AVBotz Foxglove Extensions

Foxglove panels for the [thalassic](https://github.com/avbotz/thalassic) stack, as three extensions:

| Extension | Panels | For |
|---|---|---|
| [teleop](teleop/README.md) | 6-DOF Teleop, Motion Setpoint | Driving `sub_control` by hand: instruments, keyboard and gamepad, or one command with a mode per axis |
| [tuning](tuning/README.md) | Controller Gains, Tuning Routines, Controller Signals | Tuning `sub_control` live: its parameters, bounded step/cruise/hold/square routines, and graphs of its signals |
| [vision](vision/README.md) | Detections | A camera view with `sub_vision`'s detections drawn on the frames they were computed from |

They need a live connection to `foxglove_bridge`, which `sub_bringup` launches: open a **Foxglove WebSocket** connection to `ws://<host>:8765`. The bridge's environment must have `sub_control_interfaces` and `sub_vision_interfaces` sourced, which is the case when it is started from the workspace.

## Build and install

```sh
pnpm install
pnpm test            # unit tests of the logic in every extension
pnpm run lint
pnpm run build       # every extension's dist/extension.js
pnpm run package     # every extension's avbotz.<name>-<version>.foxe
```

To install in the Foxglove desktop app, drag each `.foxe` onto the window, or use *Settings → Extensions → Install local extension*. `pnpm run local-install` installs all three straight into the desktop app. The extensions replace the earlier single `AVBotz Teleop` extension (`avbotz.foxglove-teleop-extensions`): uninstall that one.

One extension at a time: `pnpm --filter teleop run build`, and the same for `package` and `local-install`.

`pnpm run probe [ws://host:8765]` checks a running bridge for what the panels need (topics, the controller's parameter services, client publishing of `MotionSetpoint`) and that `sub_control` acknowledges a command built from `common/msgs.ts`. It sends one hold-all command and re-zeroes the pose, so use it on the simulator or with the vehicle holding still.

## Layout

```
common/    code every extension shares: message definitions, panel plumbing, UI pieces,
           ROS parameters over the node's own services
teleop/    } one Foxglove extension each: package.json, tsconfig.json, src/index.ts
tuning/    }
vision/    }
```

The message definitions in `common/msgs.ts` are copied from thalassic's `sub_control_interfaces` and `sub_vision_interfaces`. Update them if a message changes: a published `MotionSetpoint` that is a field short fails to deserialize in the controller and is silently dropped.
