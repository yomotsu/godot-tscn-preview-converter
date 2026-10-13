import {
  AdditiveBlending, Color, DoubleSide, FrontSide, MeshBasicMaterial, MeshStandardMaterial, MultiplyBlending, NormalBlending, SRGBColorSpace, SubtractiveBlending,
  ShaderMaterial, Vector2, Vector3, Vector4, type Material, type Texture,
} from 'three';
import { GodotShaderConverter } from './GodotShaderConverter.js';
import { shaderUniformPropertyName } from './GodotShaderConverter.js';
import { isGodotCall, type GodotResourceSection, type GodotValue } from '../tscn/types.js';

export type ResourceValueResolver = (value: GodotValue) => Promise<unknown>;
export type WarningReporter = (message: string) => void;

/** Converts Godot standard, ORM and shader materials to three.js materials. */
export class GodotMaterialConverter {
  private readonly shaderConverter: GodotShaderConverter;

  constructor(shaderConverter = new GodotShaderConverter()) { this.shaderConverter = shaderConverter; }

  async convert(resource: GodotResourceSection, resolve: ResourceValueResolver, warn: WarningReporter): Promise<Material> {
    if (resource.resourceType === 'ShaderMaterial') return this.convertShaderMaterial(resource, resolve, warn);
    if (resource.resourceType === 'StandardMaterial3D' || resource.resourceType === 'ORMMaterial3D') return this.convertPbrMaterial(resource, resolve, warn);
    warn(`Material '${resource.id}' uses unsupported resource type '${resource.resourceType}'; using a basic fallback`);
    return new MeshStandardMaterial({ color: 0xcccccc, roughness: 0.8 });
  }

  private async convertShaderMaterial(resource: GodotResourceSection, resolve: ResourceValueResolver, warn: WarningReporter): Promise<Material> {
    const shaderValue = resource.properties.shader;
    if (!shaderValue) {
      warn(`ShaderMaterial '${resource.id}' has no shader resource`);
      return fallbackMaterial();
    }
    const shader = await resolve(shaderValue);
    if (typeof shader !== 'string') {
      warn(`ShaderMaterial '${resource.id}' shader did not resolve to source text`);
      return fallbackMaterial();
    }
    try {
      const converted = this.shaderConverter.convert(shader);
      for (const warning of converted.warnings) warn(`ShaderMaterial '${resource.id}': ${warning.message}`);
      const uniforms = converted.uniforms;
      for (const [property, value] of Object.entries(resource.properties)) {
        if (!property.startsWith('shader_parameter/')) continue;
        // Godot scenes can serialize null for shader parameters whose effective
        // value comes from the shader declaration. Preserve that parsed default;
        // passing null through to three.js breaks vector and texture uniforms.
        if (value === null) continue;
        const name = property.slice('shader_parameter/'.length);
        const convertedValue = await convertValue(value, resolve);
        uniforms[name] = { value: shaderUniformValue(convertedValue, uniforms[name]?.value, converted.sourceColorUniforms.includes(name)) };
      }
      const material = new ShaderMaterial({
        uniforms,
        vertexShader: converted.vertexShader,
        fragmentShader: converted.fragmentShader,
        transparent: converted.transparent || hasAlpha(resource.properties),
        blending: converted.blending === 'additive' ? AdditiveBlending : converted.blending === 'subtractive' ? SubtractiveBlending : converted.blending === 'multiply' ? MultiplyBlending : NormalBlending,
        side: converted.side === 'double' ? DoubleSide : FrontSide,
        depthWrite: !converted.transparent,
      });
      for (const uniformName of Object.keys(uniforms)) {
        const alias = shaderUniformPropertyName(uniformName);
        Object.defineProperty(material, alias, {
          configurable: true,
          get: () => material.uniforms[uniformName]?.value,
          set: (value: unknown) => { if (material.uniforms[uniformName]) material.uniforms[uniformName].value = value; },
        });
      }
      material.userData.godotSourceColorUniforms = converted.sourceColorUniforms;
      material.userData.godotTextureUniforms = converted.textureUniforms;
      material.userData.godotDepthUniforms = converted.depthUniforms;
      material.name = resource.id;
      return material;
    } catch (error) {
      warn(`ShaderMaterial '${resource.id}' could not be converted: ${messageOf(error)}; using a fallback material`);
      return fallbackMaterial();
    }
  }

  private async convertPbrMaterial(resource: GodotResourceSection, resolve: ResourceValueResolver, warn: WarningReporter): Promise<Material> {
    const p = resource.properties;
    const albedo = colorValue(p.albedo_color) ?? new Color(1, 1, 1);
    const emissionColor = colorValue(p.emission) ?? new Color(0, 0, 0);
    const transparency = Number(p.transparency ?? 0);
    const blendMode = Number(p.blend_mode ?? 0);
    const alpha = colorAlpha(p.albedo_color);
    const transparent = transparency > 0 || blendMode !== 0 || alpha < 1 || Number(p.albedo_color_alpha ?? 1) < 1;
    const material = new MeshStandardMaterial({
      color: albedo,
      roughness: clamp(Number(p.roughness ?? 1), 0, 1),
      metalness: clamp(Number(p.metallic ?? 0), 0, 1),
      emissive: emissionColor,
      emissiveIntensity: Boolean(p.emission_enabled) ? Number(p.emission_energy_multiplier ?? 1) : 0,
      transparent,
      blending: blendMode === 1 ? AdditiveBlending : blendMode === 2 ? SubtractiveBlending : blendMode === 3 ? MultiplyBlending : NormalBlending,
      opacity: alpha,
      side: Number(p.cull_mode ?? 0) === 2 ? DoubleSide : FrontSide,
      depthWrite: !transparent,
      alphaTest: transparency === 2 ? Number(p.alpha_scissor_threshold ?? 0.5) : 0,
    });
    material.name = resource.id;

    const albedoTexture = p.albedo_texture ? await resolve(p.albedo_texture) : undefined;
    if (isTexture(albedoTexture)) { material.map = albedoTexture; material.map.colorSpace = SRGBColorSpace; }
    const normalTexture = p.normal_texture ? await resolve(p.normal_texture) : undefined;
    if (isTexture(normalTexture)) {
      material.normalMap = normalTexture;
      const normalScale = vector2(p.normal_scale ?? [1, 1]);
      material.normalScale.copy(normalScale);
    }
    const ormTexture = p.orm_texture ? await resolve(p.orm_texture) : undefined;
    if (isTexture(ormTexture)) {
      // Godot ORM packs occlusion/roughness/metallic; three's maps use separate channels.
      material.roughnessMap = ormTexture;
      material.metalnessMap = ormTexture;
      material.aoMap = ormTexture;
      material.aoMapIntensity = Number(p.ao_light_affect ?? 1);

    }
    if (p.emission_texture) {
      const texture = await resolve(p.emission_texture);
      if (isTexture(texture)) { material.emissiveMap = texture; material.emissiveMap.colorSpace = SRGBColorSpace; }
    }
    if (Number(p.shading_mode ?? 1) === 0) {
      const unlit = new MeshBasicMaterial({ color: albedo, map: material.map, transparent, opacity: alpha, side: material.side, depthWrite: !transparent });
      unlit.name = resource.id;
      material.dispose();
      return unlit;
    }
    return material;
  }
}

async function convertValue(value: GodotValue, resolve: ResourceValueResolver): Promise<unknown> {
  if (isGodotCall(value)) {
    if (value.name === 'ExtResource' || value.name === 'SubResource') return resolve(value);
    const args = value.args.map((item) => Number(item));
    switch (value.name) {
      case 'Color': return new Vector4(args[0] ?? 1, args[1] ?? 1, args[2] ?? 1, args[3] ?? 1);
      case 'Vector2': return new Vector2(args[0] ?? 0, args[1] ?? 0);
      case 'Vector3': return new Vector3(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
      case 'Vector4': return new Vector4(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
      default: return value;
    }
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => convertValue(item, resolve)));
  return value;
}

function shaderUniformValue(value: unknown, initial: unknown, sourceColor: boolean): unknown {
  if (value instanceof Vector4) {
    const color = new Color(value.x, value.y, value.z);
    if (sourceColor) color.convertSRGBToLinear();
    if (isVector4(initial)) return new Vector4(color.r, color.g, color.b, value.w);
    if (initial instanceof Color) return color;
    if (isVector3(initial)) return new Vector3(color.r, color.g, color.b);
  }
  if (sourceColor && value instanceof Color) value.convertSRGBToLinear();
  if (value instanceof Vector2 && initial instanceof Vector2) return initial.copy(value);
  if (value instanceof Vector3 && initial instanceof Vector3) return initial.copy(value);
  if (value instanceof Vector4 && initial instanceof Vector4) return initial.copy(value);
  return value;
}

function isVector2(value: unknown): value is Vector2 { return typeof value === 'object' && value !== null && 'isVector2' in value; }
function isVector3(value: unknown): value is Vector3 { return typeof value === 'object' && value !== null && 'isVector3' in value; }
function isVector4(value: unknown): value is Vector4 { return typeof value === 'object' && value !== null && 'isVector4' in value; }

function colorValue(value: GodotValue | undefined): Color | undefined {
  if (!isGodotCall(value) || value.name !== 'Color') return undefined;
  return new Color(Number(value.args[0] ?? 1), Number(value.args[1] ?? 1), Number(value.args[2] ?? 1));
}

function colorAlpha(value: GodotValue | undefined): number {
  return isGodotCall(value) && value.name === 'Color' && value.args.length > 3 ? Number(value.args[3]) : 1;
}

function vector2(value: GodotValue): Vector2 {
  if (isGodotCall(value) && value.name === 'Vector2') return new Vector2(Number(value.args[0]), Number(value.args[1]));
  if (Array.isArray(value)) return new Vector2(Number(value[0]), Number(value[1]));
  return new Vector2(1, 1);
}

function isTexture(value: unknown): value is Texture { return typeof value === 'object' && value !== null && 'isTexture' in value; }
function hasAlpha(properties: Record<string, GodotValue>): boolean { return colorAlpha(properties.albedo_color) < 1; }
function fallbackMaterial(): Material { return new MeshBasicMaterial({ color: 0xff32a8, transparent: true, side: DoubleSide }); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
