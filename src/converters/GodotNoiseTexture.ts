import FastNoiseLite, { CellularDistanceFunction, CellularReturnType, DomainWarpType, FractalType, NoiseType } from '../vendor/FastNoiseLite.js';

export interface GodotNoiseTextureRecipe {
  width: number;
  height: number;
  seed: number;
  frequency: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  noiseType: number;
  fractalType: number;
  weightedStrength: number;
  pingPongStrength: number;
  cellularDistanceFunction: number;
  cellularReturnType: number;
  cellularJitter: number;
  invert: boolean;
  normalMap: boolean;
  seamless: boolean;
  seamlessBlendSkirt: number;
  normalize: boolean;
  generateMipmaps: boolean;
  bumpStrength: number;
  domainWarpEnabled: boolean;
  domainWarpFrequency: number;
  domainWarpType: number;
  domainWarpAmplitude: number;
  domainWarpFractalType: number;
  domainWarpFractalOctaves: number;
  domainWarpFractalLacunarity: number;
  domainWarpFractalGain: number;
  offset: [number, number];
  ramp: { offsets: number[]; colors: number[]; interpolationMode: number } | null;
}

/** Builds a reusable generator so the same code can be embedded in exported classes. */
export function createGodotNoiseTextureDataGenerator(FastNoiseLiteCtor: typeof FastNoiseLite) {
  return function generateGodotNoiseTextureData(recipe: GodotNoiseTextureRecipe): Uint8Array {
    const width = recipe.width, height = recipe.height;
    const noise = new FastNoiseLiteCtor();
    noise.SetSeed(recipe.seed);
    noise.SetFrequency(Math.max(0.0001, recipe.frequency));
    noise.SetNoiseType((recipe.noiseType + 1) as NoiseType);
    noise.SetFractalType(recipe.fractalType as FractalType);
    noise.SetFractalOctaves(Math.max(1, Math.min(8, Math.round(recipe.octaves))));
    noise.SetFractalLacunarity(recipe.lacunarity);
    noise.SetFractalGain(recipe.gain);
    noise.SetFractalWeightedStrength(recipe.weightedStrength);
    noise.SetFractalPingPongStrength(recipe.pingPongStrength);
    noise.SetCellularDistanceFunction((recipe.cellularDistanceFunction + 1) as CellularDistanceFunction);
    noise.SetCellularReturnType((recipe.cellularReturnType + 1) as CellularReturnType);
    noise.SetCellularJitter(recipe.cellularJitter);

    const warp = new FastNoiseLiteCtor();
    warp.SetSeed(recipe.seed);
    warp.SetFrequency(recipe.domainWarpFrequency);
    warp.SetDomainWarpType((recipe.domainWarpType + 1) as DomainWarpType);
    warp.SetDomainWarpAmp(recipe.domainWarpAmplitude);
    warp.SetFractalType((recipe.domainWarpFractalType === 0 ? 0 : recipe.domainWarpFractalType + 3) as FractalType);
    warp.SetFractalOctaves(recipe.domainWarpFractalOctaves);
    warp.SetFractalLacunarity(recipe.domainWarpFractalLacunarity);
    warp.SetFractalGain(recipe.domainWarpFractalGain);

    const sample = (x: number, y: number) => {
      const point = { x: x + recipe.offset[0], y: y + recipe.offset[1] };
      if (recipe.domainWarpEnabled) warp.DomainWarp(point);
      return noise.GetNoise(point.x, point.y);
    };
    const skirtWidth = recipe.seamless ? Math.max(1, Math.floor(width * recipe.seamlessBlendSkirt)) : 0;
    const skirtHeight = recipe.seamless ? Math.max(1, Math.floor(height * recipe.seamlessBlendSkirt)) : 0;
    const sampleWidth = width + skirtWidth, sampleHeight = height + skirtHeight;
    const raw = new Float32Array(sampleWidth * sampleHeight);
    let minimum = Infinity, maximum = -Infinity;
    for (let y = 0; y < sampleHeight; y++) for (let x = 0; x < sampleWidth; x++) {
      const value = sample(x, y);
      raw[y * sampleWidth + x] = value;
      minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
    }

    const gray = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const value = recipe.normalize ? (raw[i] - minimum) / Math.max(1e-8, maximum - minimum) : raw[i] * 0.5 + 0.5;
      gray[i] = Math.max(0, Math.min(255, Math.floor(value * 255)));
      if (recipe.invert) gray[i] = 255 - gray[i];
    }
    const values = recipe.seamless ? blendSeamless(gray, width, height, skirtWidth, skirtHeight) : gray;

    if (recipe.ramp && recipe.normalMap) {
      for (let i = 0; i < values.length; i++) {
        const color = sampleRamp(recipe.ramp, values[i] / 255);
        values[i] = byte(color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722);
      }
    }

    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x, value = values[index] / 255, pixel = index * 4;
      let red = value, green = value, blue = value, alpha = 1;
      if (recipe.normalMap) {
        const dx = (values[y * width + (x + 1) % width] - values[index]) / 255;
        const dy = (values[((y + 1) % height) * width + x] - values[index]) / 255;
        const length = Math.hypot(dx * recipe.bumpStrength, dy * recipe.bumpStrength, 1);
        red = (-dx * recipe.bumpStrength / length + 1) * 0.5;
        green = (dy * recipe.bumpStrength / length + 1) * 0.5;
        blue = (1 / length + 1) * 0.5;
      }
      data[pixel] = recipe.normalMap ? Math.floor(red * 255) : byte(red);
      data[pixel + 1] = recipe.normalMap ? Math.floor(green * 255) : byte(green);
      data[pixel + 2] = recipe.normalMap ? Math.floor(blue * 255) : byte(blue);
      data[pixel + 3] = 255;
      if (recipe.ramp && !recipe.normalMap) {
        const color = sampleRamp(recipe.ramp, value);
        data[pixel] = floorByte(color[0]); data[pixel + 1] = floorByte(color[1]);
        data[pixel + 2] = floorByte(color[2]); data[pixel + 3] = floorByte(color[3]);
      }
    }
    return data;

    function sampleRamp(ramp: NonNullable<GodotNoiseTextureRecipe['ramp']>, t: number): number[] {
      const offsets = ramp.offsets.length ? ramp.offsets : [0, 1];
      const colors = ramp.colors.length ? ramp.colors : [0, 0, 0, 1, 1, 1, 1, 1];
      const color = (index: number) => colors.slice(index * 4, index * 4 + 4);
      if (t <= offsets[0]) return color(0);
      for (let i = 1; i < offsets.length; i++) if (t <= offsets[i]) {
        let amount = (t - offsets[i - 1]) / (offsets[i] - offsets[i - 1]);
        if (ramp.interpolationMode === 1) amount = 0;
        return color(i - 1).map((component, channel) => component + (color(i)[channel] - component) * amount);
      }
      return color(offsets.length - 1);
    }

    function blendSeamless(source: Uint8Array, w: number, h: number, sx: number, sy: number): Uint8Array {
      const sw = w + sx, hx = Math.floor(w / 2), hy = Math.floor(h / 2), result = new Uint8Array(w * h);
      const read = (x: number, y: number, mx = w, my = h) => source[((y + hy) % my) * sw + (x + hx) % mx];
      const alpha = (i: number, length: number) => Math.floor(255 * (1 - smooth(Math.max(0, Math.min(1, (i / length - 0.1) / 0.8)))));
      const blend = (background: number, foreground: number, amount: number) => ((amount + 1) * foreground + (256 - amount) * background) >> 8;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) result[y * w + x] = read(x, y);
      for (let y = 0; y < h; y++) for (let x = hx; x < Math.min(w, hx + sx); x++) {
        if (y >= hy && y < hy + sy) continue;
        result[y * w + x] = blend(result[y * w + x], read(x, y, sw, h), alpha(x - hx, sx));
      }
      for (let y = hy; y < Math.min(h, hy + sy); y++) for (let x = 0; x < w; x++) {
        if (x >= hx && x < hx + sx) continue;
        result[y * w + x] = blend(result[y * w + x], read(x, y, w, h + sy), alpha(y - hy, sy));
      }
      for (let y = hy; y < Math.min(h, hy + sy); y++) for (let x = hx; x < Math.min(w, hx + sx); x++) {
        const a = alpha(x - hx, sx), b = alpha(y - hy, sy);
        const top = blend(read(x, y, w, h + sy), read(x, y, sw, h + sy), a);
        const bottom = blend(read(x, y), read(x, y, sw, h), a);
        result[y * w + x] = blend(bottom, top, b);
      }
      return result;
    }

    function smooth(value: number): number { return value * value * (3 - 2 * value); }
    function byte(value: number): number { return Math.max(0, Math.min(255, Math.round(value * 255))); }
    function floorByte(value: number): number { return Math.max(0, Math.min(255, Math.floor(value * 255))); }
  };
}

export const generateGodotNoiseTextureData = createGodotNoiseTextureDataGenerator(FastNoiseLite);
