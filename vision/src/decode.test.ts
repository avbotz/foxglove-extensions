import { describe, expect, it } from "vitest";

import { compressedMimeType, rawToRgba } from "./decode";

describe("rawToRgba", () => {
  it("reads rgb8 and bgr8 with row padding", () => {
    // Two rows of two pixels, each row padded to 8 bytes.
    const data = Uint8Array.from([1, 2, 3, 4, 5, 6, 0, 0, 7, 8, 9, 10, 11, 12, 0, 0]);
    const rgb = rawToRgba({ width: 2, height: 2, encoding: "rgb8", is_bigendian: 0, step: 8, data });
    expect(Array.from(rgb.slice(0, 8))).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(Array.from(rgb.slice(8, 12))).toEqual([7, 8, 9, 255]);
    const bgr = rawToRgba({ width: 2, height: 2, encoding: "bgr8", is_bigendian: 0, step: 8, data });
    expect(Array.from(bgr.slice(0, 4))).toEqual([3, 2, 1, 255]);
  });

  it("reads mono8 and bgra8", () => {
    const mono = rawToRgba({
      width: 2,
      height: 1,
      encoding: "mono8",
      is_bigendian: 0,
      step: 2,
      data: Uint8Array.from([9, 200]),
    });
    expect(Array.from(mono)).toEqual([9, 9, 9, 255, 200, 200, 200, 255]);
    const bgra = rawToRgba({
      width: 1,
      height: 1,
      encoding: "bgra8",
      is_bigendian: 0,
      step: 4,
      data: Uint8Array.from([1, 2, 3, 4]),
    });
    expect(Array.from(bgra)).toEqual([3, 2, 1, 4]);
  });

  it("stretches mono16 to its maximum, in either byte order", () => {
    const little = rawToRgba({
      width: 2,
      height: 1,
      encoding: "mono16",
      is_bigendian: 0,
      step: 4,
      data: Uint8Array.from([0, 1, 0, 2]), // 256, 512
    });
    expect(Array.from(little)).toEqual([128, 128, 128, 255, 255, 255, 255, 255]);
    const big = rawToRgba({
      width: 1,
      height: 1,
      encoding: "16UC1",
      is_bigendian: 1,
      step: 2,
      data: Uint8Array.from([1, 0]),
    });
    expect(big[0]).toBe(255);
  });

  it("stretches a float image over its finite range", () => {
    const data = new Uint8Array(new Float32Array([1, 3, NaN, 2]).buffer);
    const out = rawToRgba({ width: 4, height: 1, encoding: "32FC1", is_bigendian: 0, step: 16, data });
    expect([out[0], out[4], out[8], out[12]]).toEqual([0, 255, 0, 128]);
  });

  it("refuses short data and unknown encodings", () => {
    const image = { width: 2, height: 2, is_bigendian: 0, step: 6, data: new Uint8Array(6) };
    expect(() => rawToRgba({ ...image, encoding: "rgb8" })).toThrow(/short/);
    expect(() => rawToRgba({ ...image, encoding: "bayer_rggb8" })).toThrow(/unsupported/);
  });
});

describe("compressedMimeType", () => {
  it("reads the format field", () => {
    expect(compressedMimeType("jpeg")).toBe("image/jpeg");
    expect(compressedMimeType("rgb8; jpeg compressed bgr8")).toBe("image/jpeg");
    expect(compressedMimeType("png")).toBe("image/png");
  });
});
