/**
 * visionProcessor.js — Browser-side EO payload image processing
 *
 * Modes: none, grayscale, edges (Sobel), motion (frame diff + blobs), thermal
 */

export const VISION_MODES = ['none', 'grayscale', 'edges', 'motion', 'thermal'];

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function luminance(r, g, b) {
  return (r * 0.299 + g * 0.587 + b * 0.114) | 0;
}

function thermalColor(t) {
  // t: 0..255
  if (t < 64) {
    const u = t / 64;
    return [0, (u * 120) | 0, (80 + u * 120) | 0];
  }
  if (t < 160) {
    const u = (t - 64) / 96;
    return [(u * 255) | 0, (120 + u * 135) | 0, (200 - u * 200) | 0];
  }
  const u = (t - 160) / 95;
  return [255, (255 - u * 120) | 0, 0];
}

export class VisionProcessor {
  constructor() {
    this.mode = 'none';
    this.motionThreshold = 28;
    this.minBlobArea = 120;
    this.lastDetections = [];
    this.lastActivity = 0;
    this._prevGray = null;
    this._gray = null;
    this._work = null;
  }

  setMode(mode) {
    if (!VISION_MODES.includes(mode)) {
      throw new RangeError(`Unknown vision mode: ${mode}`);
    }
    this.mode = mode;
    if (mode !== 'motion') {
      this._prevGray = null;
    }
    if (mode === 'none') {
      this.lastDetections = [];
      this.lastActivity = 0;
    }
  }

  setMotionThreshold(value) {
    this.motionThreshold = Math.max(8, Math.min(80, Number(value) || 28));
  }

  process(imageData) {
    if (this.mode === 'none') {
      this.lastDetections = [];
      this.lastActivity = 0;
      return imageData;
    }

    const { width, height, data } = imageData;
    const pixelCount = width * height;

    if (!this._gray || this._gray.length !== pixelCount) {
      this._gray = new Uint8Array(pixelCount);
      this._work = new Uint8ClampedArray(data.length);
      this._prevGray = null;
    }

    for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
      this._gray[i] = luminance(data[p], data[p + 1], data[p + 2]);
    }

    switch (this.mode) {
      case 'grayscale':
        this.lastDetections = [];
        this.lastActivity = 0;
        return this._toGrayscaleImage(width, height, data);
      case 'edges':
        this.lastDetections = [];
        this.lastActivity = 0;
        return this._sobelEdges(width, height, data);
      case 'motion':
        return this._motionDetect(width, height, data);
      case 'thermal':
        this.lastDetections = [];
        this.lastActivity = 0;
        return this._thermalMap(width, height, data);
      default:
        return imageData;
    }
  }

  _toGrayscaleImage(width, height, source) {
    const out = new Uint8ClampedArray(source.length);
    for (let i = 0, p = 0; i < this._gray.length; i++, p += 4) {
      const g = this._gray[i];
      out[p] = g;
      out[p + 1] = g;
      out[p + 2] = g;
      out[p + 3] = 255;
    }
    return new ImageData(out, width, height);
  }

  _sobelEdges(width, height, source) {
    const out = this._work;
    const gray = this._gray;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const tl = gray[idx - width - 1];
        const tc = gray[idx - width];
        const tr = gray[idx - width + 1];
        const ml = gray[idx - 1];
        const mr = gray[idx + 1];
        const bl = gray[idx + width - 1];
        const bc = gray[idx + width];
        const br = gray[idx + width + 1];

        const gx = -tl + tr - (2 * ml) + (2 * mr) - bl + br;
        const gy = -tl - (2 * tc) - tr + bl + (2 * bc) + br;
        const mag = clampByte(Math.hypot(gx, gy));
        const p = idx * 4;
        out[p] = mag;
        out[p + 1] = mag;
        out[p + 2] = mag;
        out[p + 3] = 255;
      }
    }

    // Copy border from source to avoid black frame.
    for (let x = 0; x < width; x++) {
      this._copyPixel(source, out, x, 0, width);
      this._copyPixel(source, out, x, height - 1, width);
    }
    for (let y = 0; y < height; y++) {
      this._copyPixel(source, out, 0, y, width);
      this._copyPixel(source, out, width - 1, y, width);
    }

    return new ImageData(out.slice(0), width, height);
  }

  _copyPixel(source, dest, x, y, width) {
    const p = (y * width + x) * 4;
    dest[p] = source[p];
    dest[p + 1] = source[p + 1];
    dest[p + 2] = source[p + 2];
    dest[p + 3] = 255;
  }

  _thermalMap(width, height, source) {
    const out = this._work;
    for (let i = 0, p = 0; i < this._gray.length; i++, p += 4) {
      const [r, g, b] = thermalColor(this._gray[i]);
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
      out[p + 3] = 255;
    }
    return new ImageData(out.slice(0), width, height);
  }

  _motionDetect(width, height, source) {
    const out = new Uint8ClampedArray(source);
    const detections = [];
    let activePixels = 0;

    if (!this._prevGray || this._prevGray.length !== this._gray.length) {
      this._prevGray = new Uint8Array(this._gray);
      this.lastDetections = [];
      this.lastActivity = 0;
      return new ImageData(out, width, height);
    }

    const mask = new Uint8Array(this._gray.length);
    const threshold = this.motionThreshold;

    for (let i = 0; i < this._gray.length; i++) {
      const diff = Math.abs(this._gray[i] - this._prevGray[i]);
      if (diff > threshold) {
        mask[i] = 1;
        activePixels++;
        const p = i * 4;
        const heat = clampByte(diff * 3);
        out[p] = heat;
        out[p + 1] = (heat * 0.35) | 0;
        out[p + 2] = 0;
        out[p + 3] = 220;
      } else {
        const p = i * 4;
        const g = (this._gray[i] * 0.35) | 0;
        out[p] = g;
        out[p + 1] = g;
        out[p + 2] = g;
        out[p + 3] = 255;
      }
    }

    this._prevGray.set(this._gray);
    this.lastActivity = activePixels / this._gray.length;

    const block = 16;
    for (let by = 0; by < height; by += block) {
      for (let bx = 0; bx < width; bx += block) {
        let count = 0;
        const bw = Math.min(block, width - bx);
        const bh = Math.min(block, height - by);
        for (let y = 0; y < bh; y++) {
          const row = (by + y) * width + bx;
          for (let x = 0; x < bw; x++) {
            if (mask[row + x]) count++;
          }
        }
        if (count >= Math.max(12, (bw * bh) * 0.18)) {
          detections.push({ x: bx, y: by, w: bw, h: bh, score: count / (bw * bh) });
        }
      }
    }

    this.lastDetections = this._mergeDetections(detections, width, height);
    return new ImageData(out, width, height);
  }

  _mergeDetections(boxes, width, height) {
    if (boxes.length === 0) return [];

    const merged = [];
    const used = new Array(boxes.length).fill(false);

    for (let i = 0; i < boxes.length; i++) {
      if (used[i]) continue;
      let box = { ...boxes[i] };
      used[i] = true;

      let changed = true;
      while (changed) {
        changed = false;
        for (let j = 0; j < boxes.length; j++) {
          if (used[j]) continue;
          const other = boxes[j];
          const overlap =
            box.x < other.x + other.w &&
            box.x + box.w > other.x &&
            box.y < other.y + other.h &&
            box.y + box.h > other.y;
          if (overlap) {
            const x1 = Math.min(box.x, other.x);
            const y1 = Math.min(box.y, other.y);
            const x2 = Math.max(box.x + box.w, other.x + other.w);
            const y2 = Math.max(box.y + box.h, other.y + other.h);
            box = {
              x: x1,
              y: y1,
              w: x2 - x1,
              h: y2 - y1,
              score: Math.max(box.score, other.score),
            };
            used[j] = true;
            changed = true;
          }
        }
      }

      if (box.w * box.h >= this.minBlobArea) {
        merged.push(box);
      }
    }

    return merged.slice(0, 12);
  }

  getSummary() {
    return {
      mode: this.mode,
      detections: this.lastDetections,
      activity: this.lastActivity,
      motionThreshold: this.motionThreshold,
    };
  }
}
