# AVBotz Tuning

Three Foxglove panels for tuning `sub_control` live, through `foxglove_bridge`: edit any node's parameters, run bounded tuning routines, and graph the controller's signals per axis. `thalassic/docs/control.md` explains the controller; [Tuning](#tuning-sub_control) below is the procedure, panel by panel. Tune in simulation first (`gains_sim.yaml`), then on the vehicle (`gains.yaml`); gains do not carry over between them, the procedure does.

| Panel | |
|---|---|
| **Controller Gains** | The parameters of a node (`/marlin_v3/sub_control` by default), read and set through its own parameter services, so each value keeps its declared type. `sub_control`'s are grouped as in `control.md`; short arrays get a field per element (`kp ki kd`, `v max a max j max`, x to yaw), and each `gains.<axis>` row has an **ω** field that fills in a critically damped `[3ω², ω³, 3ω]`. Edits are staged (amber) until **Apply** (per row, or every staged edit with Ctrl+S or *Apply all*), then read back; a row that the node rejects says why. Rows that differ from the baseline are marked *changed*. |
| **Tuning Routines** | Routines (below), **Hold here** (every axis stops smoothly and holds, level), **Zero pose** (`sub_control`'s `reset_pose`), the path from above or the side (the routine's waypoints, the controller's reference and the measured position), and the controller's state: each axis's mode, thruster health and saturation. |
| **Controller Signals** | A graph of any signals, or for one axis the presets *target / reference / measured*, *tracking error*, *velocity*, *wrench / disturbance* and *integral*. Time window, fixed or fitted Y range, pause, hover readout, clear, CSV export. Add a panel per axis you are watching. |

For one command at a time (a step by hand, an open-loop push), use the Motion Setpoint panel of the teleop extension.

## Signals

Per axis `x`, `y`, `z`, `roll`, `pitch`, `yaw`, in the frames of `ControllerStatus`: translation in odom ENU (z up, so 1 m deep is z = −1) and rotation as ZYX Euler angles, yaw counter-clockwise from above.

| Signal | |
|---|---|
| `<axis>.target` | Where the axis is headed (its `POSITION` target, else the reference) |
| `<axis>.reference`, `.reference_velocity`, `.reference_acceleration` | The smooth trajectory the controller tracks |
| `<axis>.measured`, `.velocity` | From `odometry/filtered`, its body twist turned into odom and Euler rates; z is DVL altitude while holding altitude |
| `<axis>.tracking_error` | Reference minus measured: what the feedback acts on |
| `<axis>.wrench_command`, `.wrench_achieved` | Body FLU [N, N·m]: asked for, and what the thrusters produce of it |
| `<axis>.integral`, `.disturbance` | Body FLU integral action [m/s², rad/s²] and disturbance observer estimate [N, N·m] |
| `thruster_<i>.command`, `.force` | Normalized command and force [N] |
| `altitude`, `state_age` | DVL altitude [m]; age of the controller's odometry [s] |

The built-in Plot panel can show any field of `control/status` directly; these panels exist for what it cannot derive (Euler angles and rates from the odometry quaternion, the tracking error) and for the routines.

## Routines

All start from where `sub_control` is holding (each `POSITION` axis's target, else the measured pose). The controller shapes every target into its trajectory, so a routine only says where to go and for how long. Positions and velocities are along odom axes; zero the pose first so that x is forward and y left. The hint under the form estimates each move's duration from the controller's `trajectory.*` limits.

| Routine | Sends |
|---|---|
| Step | `POSITION` start + step, start, start − step, start on one axis, holding each |
| Cruise | `VELOCITY` at the speed, `HOLD`, then the same the other way, on x, y, z or yaw; streamed with a 0.5 s timeout |
| Hold | `POSITION` at the start on every axis, for a disturbance test |
| Square | `POSITION` through the corners of a square in odom x/y, forward then left |

A routine starts only with live `odometry/filtered` and `control/status` and the vehicle unkilled, armed and not in failsafe, and it aborts when any of that stops being true. Every command it sends carries an id, so once `sub_control` acknowledges a command the panel did not send (a mission, teleop, `identify_model`), the routine aborts too: stop those before starting one. **Stop**, **Hold here**, an abort, or closing the panel all leave every axis stopping smoothly and holding, level; a kill aborts without sending anything. Routines that move z keep the target at least 0.3 m deep.

## Saving

Foxglove cannot write to the vehicle's files, so the Controller Gains panel exports instead:

- **Apply** sets the staged parameters through the node's `set_parameters` service and reads them back; a row clears only once the readback matches. An empty `failed_thrusters` (`[]`) works, since the service carries the type.
- The **baseline** is what the panel first saw, or the values when **Mark as saved** was last pressed. *Changed* rows differ from it; the *Changed* filter shows only those and the staged ones.
- **Copy YAML** and **Download YAML** give the changed parameters in the layout of the gains file (`/**: ros__parameters:`, dotted names nested, doubles written as doubles). Paste them into `src/sub_bringup/config/control/gains.yaml` or `gains_sim.yaml`, keep the comments honest, review with `git diff`, then **Mark as saved**. `thruster_health` and `failed_thrusters` are fault state and are never exported.

## Tuning sub_control

Before starting: no mission running, the vehicle unkilled at least 1.5 m deep and 2 m from walls, and in the pool someone on the kill switch. Press **Zero pose** so that odom x is forward and y left: routines move along odom axes, and the gains act along body axes.

### What to watch

The controller turns each target into a smooth reference within `trajectory.*` and tracks that reference; the feedback acts on **reference minus measured**, not on the distance to the target. So for each axis the useful views are:

- *Target / reference / measured*: the reference should lead the measurement by little and arrive at the target at rest. Measured overshooting where the reference does not is too little damping or too much bandwidth.
- *Tracking error*: small during a move with a good model and gains; how it behaves says what is wrong (below).
- *Wrench / disturbance*: commanded against achieved thrust. A gap means saturation, as does **SATURATED** in the status line.

Body axes are FLU: +x forward, +y left, +z up; +roll lowers the right side, +pitch lowers the nose, +yaw turns left (counter-clockwise from above).

### 1. Thrust directions

In the Motion Setpoint panel, push one axis at a time with `Effort` (10 N, or 2 N·m for rotations) and a 2 s timeout. The vehicle must move the way the axis points, as above. If it does not, fix the vehicle description's thruster layout before anything else.

### 2. Vehicle model

Run `identify_model` (`control.md`, *Identifying the model*) and paste its `model:` block into the gains file. The model is feedforward: with it right, the gains below only correct what is left. To bring it in gradually, apply `feedforward.acceleration`, `.drag` and `.restoring` between 0 and 1 from Controller Gains.

### 3. Bandwidth per axis

In Controller Gains, type a bandwidth ω into the **ω** field of `gains.<axis>`; it sets `[kp, ki, kd]` to `[3ω², ω³, 3ω]`, a critically damped triple pole. **Apply** it, then run a **Step** on that axis with a hold long enough to settle (the hint gives the move time).

- Start low: x and y 0.6, z 1.0, roll, pitch and yaw 1.5 rad/s.
- Raise ω until the step rings, then back off by a third.
- Keep x and y at about 1 rad/s or less: their feedback is the DVL, 0.1 to 0.2 s late.
- Step small: 0.5 m in z, 1 m in x and y, 0.2 rad in roll and pitch, 0.8 rad in yaw. z steps stay at least 0.3 m below the surface.

Reading the tracking error on a step:

| Tracking error | Likely cause |
|---|---|
| Follows the reference acceleration (peaks as the move starts and ends) | `model.mass` or `inertia` off, or `feedforward.acceleration` below 1 |
| Grows with speed, steady while cruising | Drag off (`model.linear_drag`, `quadratic_drag`) |
| Offset at rest that the integral slowly removes | `model.net_buoyancy` or trim off; or `ki` too low if the model is right |
| Oscillates around the reference | Bandwidth too high, or sensing too slow for it |

`gains.integral_limit` caps each integrator and `gains.anti_windup` bleeds off what the thrusters could not produce; neither needs tuning unless an axis saturates for long.

### 4. Speed: Cruise

**Cruise** an axis at a steady speed (x, y, z or yaw). Once at speed, the *integral* and *disturbance* should sit near zero with a right drag model; an integral that climbs while cruising is drag the model is missing. A speed above `trajectory.<group>` v max is clipped by the controller.

### 5. Trajectory limits

Raise `trajectory.<group>` `[v max, a max, j max]` until long steps and cruises show **SATURATED**, then back off. They must stay inside what the thrusters can do at `power_limit`.

### 6. Disturbances and coupling

- **Hold** keeps every axis where it is. Push the vehicle and watch it return without ringing. In sim, the `current` launch argument sets a steady current to hold against.
- With the model identified, set `observer.bandwidth` per axis (at most the feedback bandwidth on x and y) and cut `ki` to a small residual; the observer then takes out steps in buoyancy or current faster than the integrators.
- **Square** moves through four corners in x/y together: the reference runs in straight lines, and depth, attitude and heading should hold through it. Check the path from above and the side.

### 7. Save

Export the changed parameters as YAML and put them in the gains file, as in [Saving](#saving).

### Stop

Press **Stop** or **Hold here**, or kill the vehicle, on oscillation, a persistent **SATURATED**, strong motion on an axis that was not commanded, depth or attitude drifting, or stale telemetry. A routine stops on its own if telemetry goes stale, another command source is acknowledged, or the panel is closed; it then leaves every axis stopping smoothly and holding, level.
