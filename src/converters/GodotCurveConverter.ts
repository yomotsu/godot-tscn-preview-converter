import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, RGBAFormat, UnsignedByteType, Vector2, Vector4 } from 'three';
import { isGodotCall, type GodotResourceSection, type GodotValue } from '../tscn/types.js';
import { generateGodotGradientTextureData, type GodotGradientTextureRecipe } from './GodotGradientTexture.js';
import type { ResourceValueResolver } from './GodotMaterialConverter.js';

export type GodotCurveSampleData =
  | { kind: 'curve'; data: GodotValue[] }
  | { kind: 'curveXYZ'; curves: (GodotValue[] | null)[] }
  | { kind: 'gradient'; offsets: GodotValue; colors: GodotValue; interpolationMode: GodotValue };

export interface SampledTexture extends DataTexture {
  sampleGodot(t: number): Vector4;
  godotSampleData?: GodotCurveSampleData;
}

/** Godot Curve uses cubic segments with slopes at either end. */
export function sampleCurve(resource: GodotResourceSection, x: number): number {
  const data = resource.properties._data;
  if (!Array.isArray(data) || data.length < 5) return 1;
  const points = [];
  for (let i = 0; i + 4 < data.length; i += 5) {
    const p = data[i];
    if (isGodotCall(p)) points.push({ x: Number(p.args[0]), y: Number(p.args[1]), left: Number(data[i + 1]), right: Number(data[i + 2]), leftMode: Number(data[i + 3]), rightMode: Number(data[i + 4]) });
  }
  if (!points.length) return 1;
  if (x <= points[0].x) return points[0].y;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (x > b.x) continue;
    const dx = b.x - a.x, t = dx > 0 ? (x - a.x) / dx : 0;
    const slope = dx > 0 ? (b.y - a.y) / dx : 0;
    const m0 = (a.rightMode === 1 ? slope : a.right) * dx;
    const m1 = (b.leftMode === 1 ? slope : b.left) * dx;
    return (2*t*t*t - 3*t*t + 1)*a.y + (t*t*t - 2*t*t + t)*m0 + (-2*t*t*t + 3*t*t)*b.y + (t*t*t - t*t)*m1;
  }
  return points.at(-1)!.y;
}

function packed(value: GodotValue | undefined): number[] { return isGodotCall(value) ? value.args.map(Number) : Array.isArray(value) ? value.map(Number) : []; }
export function sampleGradient(resource: GodotResourceSection, t: number): Vector4 {
  const rawOffsets=packed(resource.properties.offsets),rawColors=packed(resource.properties.colors);
  const colors=rawColors.length?rawColors:[0,0,0,1,1,1,1,1];
  const offsets=rawOffsets.length?rawOffsets:[0,1];
  const c = (i: number) => new Vector4(...colors.slice(i*4, i*4+4) as [number,number,number,number]);
  if (t <= offsets[0]) return c(0);
  for (let i = 1; i < offsets.length; i++) if (t <= offsets[i]) {
    let f = (t-offsets[i-1]) / (offsets[i]-offsets[i-1]);
    if (Number(resource.properties.interpolation_mode ?? 0) === 1) f = 0;
    return c(i-1).lerp(c(i), f);
  }
  return c(offsets.length-1);
}

export class GodotCurveConverter {
  async convert(resource: GodotResourceSection, resolve: ResourceValueResolver): Promise<SampledTexture | undefined> {
    const p = resource.properties;
    let sample: ((t: number) => Vector4) | undefined;
    let sampleData: GodotCurveSampleData | undefined;
    if (resource.resourceType === 'CurveTexture') {
      const curve = await resolve(p.curve);
      if (isResource(curve)) {
        sample = t => { const v = sampleCurve(curve,t); return new Vector4(v,v,v,1); };
        sampleData = { kind: 'curve', data: Array.isArray(curve.properties._data) ? curve.properties._data : [] };
      }
    } else if (resource.resourceType === 'CurveXYZTexture') {
      const curves = await Promise.all(['curve_x','curve_y','curve_z'].map(k => p[k] ? resolve(p[k]) : undefined));
      sample = t => new Vector4(...curves.map(c => isResource(c) ? sampleCurve(c,t) : 1) as [number,number,number], 1);
      sampleData = { kind: 'curveXYZ', curves: curves.map(c => isResource(c) && Array.isArray(c.properties._data) ? c.properties._data : null) };
    } else if (resource.resourceType === 'GradientTexture1D') {
      const gradient = await resolve(p.gradient);
      if (isResource(gradient)) {
        sample = t => sampleGradient(gradient,t);
        sampleData = {
          kind: 'gradient',
          offsets: gradient.properties.offsets ?? [],
          colors: gradient.properties.colors ?? [],
          interpolationMode: gradient.properties.interpolation_mode ?? 0,
        };
      }
    }
    if (!sample) return undefined;
    const width = Number(p.width ?? 256), data = new Float32Array(width * 4);
    for (let i=0;i<width;i++) sample(i/(width-1)).toArray(data,i*4);
    const texture = new DataTexture(data,width,1,RGBAFormat,FloatType) as SampledTexture;
    texture.name = resource.id;
    texture.sampleGodot = sample;
    texture.godotSampleData = sampleData;
    texture.minFilter = texture.magFilter = LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }

  /** Generate Godot's radial and linear GradientTexture2D resources used by portal shaders. */
  async convertGradientTexture2D(resource: GodotResourceSection, resolve: ResourceValueResolver): Promise<DataTexture | undefined> {
    if (resource.resourceType !== 'GradientTexture2D') return undefined;
    const p = resource.properties;
    const gradient = await resolve(p.gradient);
    if (!isResource(gradient)) return undefined;

    // Match Godot's GradientTexture2D defaults: 64×64, linear from the
    // upper-left to the upper-right. A vertical fallback creates a false
    // half-sphere on materials that rely on the default texture settings.
    const width = boundedDimension(p.width, 64), height = boundedDimension(p.height, 64);
    const from = vector2(p.fill_from, [0, 0]);
    const to = vector2(p.fill_to, [1, 0]);
    const hdr = p.use_hdr === true;
    const recipe: GodotGradientTextureRecipe = {
      width, height, fill: Number(p.fill ?? 0) === 1 ? 'radial' : 'linear',
      from: from.toArray(), to: to.toArray(), hdr,
      offsets: packed(gradient.properties.offsets), colors: packed(gradient.properties.colors),
      interpolationMode: Number(gradient.properties.interpolation_mode ?? 0),
    };
    if (!recipe.offsets.length) recipe.offsets = [0, 1];
    if (!recipe.colors.length) recipe.colors = [0, 0, 0, 1, 1, 1, 1, 1];
    const data = generateGodotGradientTextureData(recipe);

    const texture = new DataTexture(data, width, height, RGBAFormat, hdr ? FloatType : UnsignedByteType);
    texture.name = resource.id;
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = texture.magFilter = LinearFilter;
    texture.flipY = false;
    texture.needsUpdate = true;
    texture.userData.godotGradientTexture = recipe;
    return texture;
  }
}
function isResource(value: unknown): value is GodotResourceSection { return typeof value === 'object' && value !== null && 'resourceType' in value; }
function vector2(value: GodotValue | undefined, fallback: [number, number]): Vector2 {
  if (isGodotCall(value) && value.name === 'Vector2') return new Vector2(Number(value.args[0]), Number(value.args[1]));
  if (Array.isArray(value)) return new Vector2(Number(value[0]), Number(value[1]));
  return new Vector2(...fallback);
}
function boundedDimension(value: GodotValue | undefined, fallback: number): number {
  return Math.max(1, Math.min(2048, Math.floor(typeof value === 'number' ? value : fallback)));
}
