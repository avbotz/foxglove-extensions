// Pairs camera frames with the detections computed from them, by header stamp, so a box is only
// ever drawn on the frame it was computed from. No React or Foxglove here, so it can be unit
// tested.

import { Stamp } from "../../common/msgs";

/**
 * Which frames are shown while the detector is running:
 * - detected: only the frames it processed, each with its detections, so the view runs at the
 *   detector's rate and the boxes never flicker
 * - all: every frame; one waits `waitMs` for its detections and is then shown bare
 * Without any detections for `detectorTimeoutMs`, every frame is shown as it arrives.
 */
export type FrameMode = "detected" | "all";

export type SyncOptions = { mode: FrameMode; waitMs: number; detectorTimeoutMs: number };

/** A message with its header stamp [s], a key for pairing, and when it arrived [ms]. */
export type Stamped<T> = { key: string; stamp: number; receivedAt: number; value: T };

export type Shown<I, D> = { frame: Stamped<I>; detections: Stamped<D> | undefined };

// Frames waiting for detections: beyond this many, the oldest go.
const MAX_WAITING = 60;
// [ms] a frame or detections that found no partner by then is dropped.
const MAX_AGE_MS = 3000;

export function stampKey(stamp: Stamp): string {
  return stamp.sec === 0 && stamp.nanosec === 0
    ? ""
    : `${stamp.sec}.${String(stamp.nanosec).padStart(9, "0")}`;
}

export function stampSeconds(stamp: Stamp): number {
  return stamp.sec + stamp.nanosec * 1e-9;
}

type Waiting<I> = Stamped<I> & { due: number | undefined };

function bare<I, D>(frame: Stamped<I>): Shown<I, D> {
  return { frame, detections: undefined };
}

export class FrameSync<I, D> {
  #waiting: Waiting<I>[] = [];
  #pending: Stamped<D>[] = [];
  #lastDetectionAt: number | undefined;
  #lastShown = -Infinity;
  options: SyncOptions;

  constructor(options: SyncOptions) {
    this.options = options;
  }

  /** Whether detections have arrived recently enough to wait for them. */
  detectorLive(now: number): boolean {
    return (
      this.#lastDetectionAt != undefined &&
      now - this.#lastDetectionAt <= this.options.detectorTimeoutMs
    );
  }

  reset(): void {
    this.#waiting = [];
    this.#pending = [];
    this.#lastDetectionAt = undefined;
    this.#lastShown = -Infinity;
  }

  /** Frames to show, in order, now that this one has arrived. */
  addFrame(frame: Stamped<I>, now: number): Shown<I, D>[] {
    if (frame.key === "") {
      // Unstamped: nothing could be paired with it.
      return [bare(frame)];
    }
    const pending = this.#pending.findIndex((d) => d.key === frame.key);
    if (pending >= 0) {
      return this.#release(frame, this.#pending.splice(pending, 1)[0]!);
    }
    if (!this.detectorLive(now)) {
      return this.#show([bare(frame)]);
    }
    this.#waiting.push({
      ...frame,
      due: this.options.mode === "all" ? now + this.options.waitMs : undefined,
    });
    const overflow = this.#waiting.splice(0, Math.max(0, this.#waiting.length - MAX_WAITING));
    return this.options.mode === "all" ? this.#show(overflow.map((f) => bare<I, D>(f))) : [];
  }

  /** Frames to show now that these detections have arrived. */
  addDetections(detections: Stamped<D>, now: number): Shown<I, D>[] {
    this.#lastDetectionAt = now;
    if (detections.key === "") {
      return [];
    }
    const index = this.#waiting.findIndex((f) => f.key === detections.key);
    if (index >= 0) {
      return this.#release(this.#waiting.splice(index, 1)[0]!, detections);
    }
    this.#pending.push(detections);
    return [];
  }

  /** Frames whose wait is over, or every waiting frame once the detector has gone quiet. */
  tick(now: number): Shown<I, D>[] {
    const live = this.detectorLive(now);
    const ready = this.#waiting.filter((f) => !live || (f.due != undefined && f.due <= now));
    this.#waiting = this.#waiting.filter(
      (f) => !ready.includes(f) && now - f.receivedAt <= MAX_AGE_MS,
    );
    this.#pending = this.#pending.filter((d) => now - d.receivedAt <= MAX_AGE_MS);
    return this.#show(ready.map((f) => bare<I, D>(f)));
  }

  // The frame goes out with its detections. Frames still waiting that are older than it were
  // skipped by the detector: they are dropped, or shown bare first when every frame is wanted.
  #release(frame: Stamped<I>, detections: Stamped<D>): Shown<I, D>[] {
    const older = this.#waiting.filter((f) => f.stamp < frame.stamp);
    this.#waiting = this.#waiting.filter((f) => f.stamp >= frame.stamp);
    const first = this.options.mode === "all" ? older.map((f) => bare<I, D>(f)) : [];
    return this.#show([...first, { frame, detections }]);
  }

  // Never shows a frame older than one already shown.
  #show(items: Shown<I, D>[]): Shown<I, D>[] {
    const out: Shown<I, D>[] = [];
    for (const item of items) {
      if (item.frame.stamp < this.#lastShown) {
        continue;
      }
      this.#lastShown = item.frame.stamp;
      out.push(item);
    }
    return out;
  }
}
