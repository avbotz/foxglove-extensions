# Changelog

## 0.3.0

- Split out of the single `foxglove-teleop-extensions` extension into this workspace.
- Fixed publishing against the current `sub_control_interfaces`: `MotionSetpoint` gained an `id`
  field, without which the controller dropped every command.
- The status line shows when the controller is not armed or has no IMU; the Motion Setpoint
  panel reports whether the controller took a command up or rejected it.

## 0.2.0

- 6-DOF Teleop and Motion Setpoint panels.
