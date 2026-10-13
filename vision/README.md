# AVBotz Vision

One Foxglove panel, **Detections**: a camera view with `sub_vision`'s detections drawn on the frames they were computed from.

Set the image topic (`sensor_msgs/msg/Image` or `CompressedImage`; by default the front camera's JPEG copy, `/marlin_v3/front_camera/image_color/compressed`) and the detections topic (`sub_vision_interfaces/msg/DetectionArray`, by default `/marlin_v3/vision/detections`). Frames and detections are paired by their header stamp, which `sub_vision` copies from the source frame, so a box is only ever drawn on the frame it belongs to, never on whatever frame happens to be latest. The footer shows the detector's latency on the frame shown (when its detections arrived, after the frame did), the task and the number of detections, the frame rate and the frame's stamp.

## Which frames are shown

The detector runs slower than the camera, and skips frames when it is busy. Drawing every frame while the boxes exist only on some of them makes the boxes flicker at the detector's rate, so by default the panel shows **only the frames the detector processed**, each with its detections (including frames with none): the view runs at the detector's rate and the boxes are always current. *Frames shown: Every frame* shows the others too, bare, after they have waited *Wait for detections* (150 ms) for theirs.

Without any detections for *Detector timeout* (1 s), say with no model loaded, every frame is shown as it arrives, so the panel is also a plain camera view.

## Drawing

Each detection's best hypothesis gives its box a color (stable per class) and its label, `class score`, with the distance in metres when a post-processor ranged the object. *Minimum score* hides detections below it, and *Labels* and *Line width* are in the settings. Raw images may be `rgb8`, `bgr8`, `rgba8`, `bgra8`, `mono8`, `mono16` or `32FC1` (the last two stretched over their range); compressed ones JPEG, PNG or WebP. Instance masks are not part of the message, so they are not drawn.

The `annotation_visualizer` node in `sub_vision` draws the latest detections on the latest frame, on the vehicle, for viewers without this panel; this panel does the drawing on the laptop instead, from the frames and detections the bag records anyway.
