// sensor_msgs images as RGBA pixels for a canvas. No DOM here, so it can be unit tested.

export type RawImage = {
  width: number;
  height: number;
  encoding: string;
  is_bigendian: number | boolean;
  step: number;
  data: Uint8Array;
};

export type CompressedImage = { format: string; data: Uint8Array };

/** The MIME type of a CompressedImage: its format is "jpeg", "png" or "rgb8; jpeg compressed bgr8". */
export function compressedMimeType(format: string): string {
  const lower = format.toLowerCase();
  if (lower.includes("png")) {
    return "image/png";
  }
  if (lower.includes("webp")) {
    return "image/webp";
  }
  return "image/jpeg";
}

// Bytes per pixel and the byte of each of red, green, blue and alpha within the pixel.
const LAYOUTS: Record<string, [number, number, number, number, number | undefined]> = {
  rgb8: [3, 0, 1, 2, undefined],
  bgr8: [3, 2, 1, 0, undefined],
  rgba8: [4, 0, 1, 2, 3],
  bgra8: [4, 2, 1, 0, 3],
  "8uc3": [3, 2, 1, 0, undefined],
  "8uc4": [4, 2, 1, 0, 3],
  mono8: [1, 0, 0, 0, undefined],
  "8uc1": [1, 0, 0, 0, undefined],
};

function bigEndian(image: RawImage): boolean {
  return image.is_bigendian === true || image.is_bigendian === 1;
}

function gray(values: Float32Array, offset: number, scale: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(values.length * 4);
  for (let i = 0, o = 0; i < values.length; i++, o += 4) {
    const value = values[i]!;
    const level = Number.isFinite(value) ? (value - offset) * scale : 0;
    out[o] = out[o + 1] = out[o + 2] = level;
    out[o + 3] = 255;
  }
  return out;
}

/** The image as RGBA, 8 bits per channel; 16-bit and float images are stretched to their range. */
export function rawToRgba(image: RawImage): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, step, data } = image;
  const encoding = image.encoding.toLowerCase();
  const layout = LAYOUTS[encoding];
  if (layout) {
    const [bytes, r, g, b, a] = layout;
    if (data.length < step * (height - 1) + width * bytes) {
      throw new Error(`${image.encoding} image data is short`);
    }
    const out = new Uint8ClampedArray(width * height * 4);
    let o = 0;
    for (let row = 0; row < height; row++) {
      let i = row * step;
      for (let col = 0; col < width; col++, i += bytes, o += 4) {
        out[o] = data[i + r]!;
        out[o + 1] = data[i + g]!;
        out[o + 2] = data[i + b]!;
        out[o + 3] = a == undefined ? 255 : data[i + a]!;
      }
    }
    return out;
  }
  const little = !bigEndian(image);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (encoding === "mono16" || encoding === "16uc1") {
    if (data.length < step * (height - 1) + width * 2) {
      throw new Error(`${image.encoding} image data is short`);
    }
    const values = new Float32Array(width * height);
    let max = 0;
    for (let row = 0, o = 0; row < height; row++) {
      for (let col = 0; col < width; col++, o++) {
        const value = view.getUint16(row * step + col * 2, little);
        values[o] = value;
        max = Math.max(max, value);
      }
    }
    return gray(values, 0, max > 0 ? 255 / max : 1);
  }
  if (encoding === "32fc1") {
    if (data.length < step * (height - 1) + width * 4) {
      throw new Error(`${image.encoding} image data is short`);
    }
    const values = new Float32Array(width * height);
    let min = Infinity;
    let max = -Infinity;
    for (let row = 0, o = 0; row < height; row++) {
      for (let col = 0; col < width; col++, o++) {
        const value = view.getFloat32(row * step + col * 4, little);
        values[o] = value;
        if (Number.isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }
    return gray(values, min, max > min ? 255 / (max - min) : 1);
  }
  throw new Error(`unsupported image encoding "${image.encoding}"`);
}
