# AVBotz Teleop

Two Foxglove panels that drive `sub_control` in all six degrees of freedom. Both publish `sub_control_interfaces/msg/MotionSetpoint` on `/marlin_v3/motion_setpoint` and show `/marlin_v3/control/status`. See `thalassic/docs/control.md#command-interface` for what the controller does with them.

- **6-DOF Teleop**: a pilot console. It has instruments that show and set position, heading, depth and attitude, plus keyboard and gamepad control.
- **Motion Setpoint**: send one command with a mode per axis. Use it for step tests and exact moves.

The controller rejects every command while it is killed or not yet armed (the kill switch must have been cycled since it started, and its sensors must be fresh): the status line shows **KILLED** or **NOT ARMED** then, and the Motion Setpoint panel reports whether `sub_control` took a command up or rejected it.

## 6-DOF Teleop

### Instruments

Each instrument shows three things:

- the **measured** state from `/marlin_v3/odometry/filtered`, in purple
- the controller's **target**, in teal
- a **pending** target you have picked but not sent, in amber and dashed

| Instrument | Shows | Click to | Buttons (send at once) |
|---|---|---|---|
| Position | Top-down map with +x up and +y left, the vehicle's track, and the distance to the target | Pick an x/y target | Step forward, back, left or right along the heading |
| Heading | Compass in odom yaw (counterclockwise +, 0 = +x) | Pick a heading (5° snaps) | Turn 15° or 90° either way, or 180° |
| Depth | Depth gauge, with the bottom from `/marlin_v3/altitude` | Pick a depth | Step up or down |
| Attitude | Artificial horizon with roll and pitch targets | — | Step roll or pitch; *Level* |

**Command** lists the target on every axis: x, y, depth (down +), roll (right +), pitch (nose up +) and yaw (left +). Each field shows the controller's current target until you change it. Typing a value or clicking an instrument makes that axis pending. **Go** (or Enter) sends every pending axis as `POSITION`, and **Clear** (or Esc) drops them. Axes you didn't change are left as they are. Setting only x or only y keeps the other where the target is. An axis switched to *Vel* takes a velocity instead, which the panel keeps streaming (with the stream timeout, so the vehicle holds if the panel goes away) for the time set, or until *Stop velocities*.

Steps start from the current target, so pressing a step button three times moves three steps. Step sizes are in the settings.

### Manual control

Click the panel to drive with the keyboard. It only listens while it has focus, which the purple outline shows. Typing in its target fields or in other panels never moves the vehicle.

| Keys | Axis |
|---|---|
| W / S | Surge forward / back |
| A / D | Sway left / right |
| R / F | Heave up / down |
| Q / E | Yaw left / right |
| I / K | Pitch nose down / nose up |
| J / L | Roll left / right |
| Space | Hold all: every axis stops smoothly and holds |
| Z | Level: roll and pitch go back to 0 |
| Enter / Esc | Send / clear the pending targets |

Each axis has a mode, set in the table or under *Manual modes* in the settings. Surge and sway always share one.

- **Rate**: while you hold the input, the axis streams `VELOCITY`, scaled by the speed slider and the full-deflection speeds. Each message carries the stream timeout, 0.5 s by default, so if the panel, the browser or the link stops, the controller holds the axis on its own. When you let go, the panel sends one `HOLD`, and the axis decelerates and holds where it stops. With *Level roll/pitch on release*, roll and pitch go back to level instead.
- **Step**: each key press, or each push of a stick past 60%, moves that axis's position target by one step. For example, set yaw to Step for exact 15° turns, or depth to Step for 10 cm changes.
- **Lock**: the axis ignores the keyboard and gamepad. Use it to keep depth or attitude while you drive the other axes.

**Gamepad**: press the panel's *Gamepad* button to turn it on. The browser only shows a gamepad after one of its buttons has been pressed. By default it uses the W3C standard mapping and follows ArduSub for the main axes:

- Left stick: surge and yaw
- Right stick: heave and sway
- Triggers: pitch (RT nose up)
- Bumpers: roll
- B: hold all
- Y: level

You can reassign each axis, invert it, and set the deadzone under *Gamepad* in the settings. Keyboard and gamepad inputs add together.

Safety behaviour:

- **An idle panel publishes nothing.** Axes you aren't commanding are sent `KEEP`, so the panel never overrides a mission or the Motion Setpoint panel.
- **Hold all, turning the gamepad on, and returning to the Foxglove window** all ignore input until every key and stick is back at neutral. A held key or a deflected stick therefore cannot drive straight on.
- **Leaving the window** releases every key and pauses the gamepad.
- **Rate command: Effort** makes Rate axes push open loop (`EFFORT`) with the full-deflection forces and torques. Use it for checking thruster directions (tuning step 1 in `control.md`).

The status line shows when the vehicle is killed or not armed, in failsafe, missing IMU, DVL or depth feedback, has lost an axis, or has saturated thrusters.

## Motion Setpoint

Pick a mode and a value for each axis, then press **Send** (or Enter in a value).

| Mode | Value |
|---|---|
| Keep | None. The axis carries on |
| Pos | Target in m or degrees |
| Vel | m/s or °/s. The axis holds after the timeout; 0 latches it |
| Hold | None. The axis stops smoothly and holds |
| Effort | N or N·m, open loop along the body axis |

- **Position targets** can be absolute in odom, or relative to the controller's current target. Relative targets use either odom axes or the heading, where x is forward and y is left.
- **Columns:** *Sends* previews the exact values before you send them. *Target* and *Measured* show where the controller is headed and where the vehicle is.
- **Loading:** *Load target* and *Load measured* fill the positions from either one.
- **Units and signs:** this panel uses the message's own frames. z is odom z, so 1 m deep is −1; set *z position is* to *Altitude* to hold height above the bottom instead. Angles are ZYX Euler angles in degrees, and +pitch is nose down, as in ROS.
- **Acknowledgment:** each command carries a fresh id; once `control/status` reports it, the panel says whether `sub_control` took the command up or rejected it (its log says why: an unknown mode, a non-finite target, no DVL altitude, killed or not armed).
