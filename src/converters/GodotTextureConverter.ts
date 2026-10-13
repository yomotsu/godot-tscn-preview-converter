import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType, type Texture } from 'three';
import { isGodotCall, type GodotResourceSection, type GodotValue } from '../tscn/types.js';
import { generateGodotNoiseTextureData, type GodotNoiseTextureRecipe } from './GodotNoiseTexture.js';
import type { ResourceValueResolver } from './GodotMaterialConverter.js';

/** Creates browser textures for Godot-generated NoiseTexture2D resources. */
export class GodotTextureConverter {
  constructor(private readonly maxSize?: number) {}

  async convert(resource: GodotResourceSection, resolve: ResourceValueResolver, warn: (message: string) => void): Promise<Texture | undefined> {
    if (resource.resourceType !== 'NoiseTexture2D') return undefined;
    const noiseValue = resource.properties.noise;
    const noise = noiseValue ? await resolve(noiseValue) : undefined;
    const parameters = isResource(noise) ? noise.properties : {};
    const ramp=resource.properties.color_ramp ? await resolve(resource.properties.color_ramp) : undefined;
    if(resource.properties.color_ramp && !isResource(ramp))warn(`NoiseTexture2D '${resource.id}' color_ramp could not be resolved`);
    const width = Math.max(1, Math.min(Number(resource.properties.width ?? 512), this.maxSize ?? Infinity));
    const height = Math.max(1, Math.min(Number(resource.properties.height ?? 512), this.maxSize ?? Infinity));
    const recipe = createNoiseTextureRecipe(resource, parameters, isResource(ramp) ? ramp : undefined, width, height);
    const texture = generateNoiseTexture(recipe);
    texture.name = resource.id;
    texture.userData.godotNoiseTexture = recipe;
    return texture;
  }
}

function generateNoiseTexture(recipe: GodotNoiseTextureRecipe): DataTexture {
  const { width, height } = recipe;
  const data = generateGodotNoiseTextureData(recipe);
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = recipe.generateMipmaps;
  texture.minFilter = texture.generateMipmaps ? LinearMipmapLinearFilter : LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createNoiseTextureRecipe(
  resource: GodotResourceSection,
  parameters: Record<string, GodotValue>,
  ramp: GodotResourceSection | undefined,
  width: number,
  height: number,
): GodotNoiseTextureRecipe {
  const offset = parameters.offset;
  const offsetArgs = isGodotCall(offset) ? offset.args.map(Number) : [];
  return {
    width, height,
    seed: number(parameters.seed, 0),
    frequency: number(parameters.frequency, 0.01),
    octaves: number(parameters.fractal_octaves, 5),
    lacunarity: number(parameters.fractal_lacunarity, 2),
    gain: number(parameters.fractal_gain, 0.5),
    noiseType: Math.round(number(parameters.noise_type, 1)),
    fractalType: number(parameters.fractal_type, 1),
    weightedStrength: number(parameters.fractal_weighted_strength, 0),
    pingPongStrength: number(parameters.fractal_ping_pong_strength, 2),
    cellularDistanceFunction: number(parameters.cellular_distance_function, 0),
    cellularReturnType: number(parameters.cellular_return_type, 1),
    cellularJitter: number(parameters.cellular_jitter, 1),
    invert: Boolean(resource.properties.invert),
    normalMap: Boolean(resource.properties.as_normal_map),
    seamless: Boolean(resource.properties.seamless ?? false),
    seamlessBlendSkirt: number(resource.properties.seamless_blend_skirt, 0.1),
    normalize: resource.properties.normalize !== false,
    generateMipmaps: resource.properties.generate_mipmaps !== false,
    bumpStrength: number(resource.properties.bump_strength, 1),
    domainWarpEnabled: parameters.domain_warp_enabled === true,
    domainWarpFrequency: number(parameters.domain_warp_frequency, 0.05),
    domainWarpType: number(parameters.domain_warp_type, 0),
    domainWarpAmplitude: number(parameters.domain_warp_amplitude, 30),
    domainWarpFractalType: number(parameters.domain_warp_fractal_type, 1),
    domainWarpFractalOctaves: number(parameters.domain_warp_fractal_octaves, 5),
    domainWarpFractalLacunarity: number(parameters.domain_warp_fractal_lacunarity, 6),
    domainWarpFractalGain: number(parameters.domain_warp_fractal_gain, 0.5),
    offset: [offsetArgs[0] ?? 0, offsetArgs[1] ?? 0],
    ramp: ramp ? {
      offsets: numberArray(ramp.properties.offsets),
      colors: numberArray(ramp.properties.colors),
      interpolationMode: number(ramp.properties.interpolation_mode, 0),
    } : null,
  };
}

function number(value: GodotValue | undefined, fallback: number): number { return typeof value === 'number' ? value : fallback; }
function isResource(value: unknown): value is GodotResourceSection { return typeof value === 'object' && value !== null && 'resourceType' in value && 'properties' in value; }
function numberArray(value: GodotValue | undefined): number[] {
  if (isGodotCall(value)) return value.args.map(Number);
  return Array.isArray(value) ? value.map(Number) : [];
}
