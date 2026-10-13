import { Color, Light, Mesh, ShaderMaterial, Texture, TextureLoader, RepeatWrapping, Vector2, Vector3, Vector4, type Material, type Object3D } from 'three';
import { rotateGodotHue } from './GodotHueShift.js';

export type GodotParameterValue = number | boolean | string | number[];
export interface GodotParameter {
  id: string;
  target: string;
  name: string;
  type: 'number' | 'boolean' | 'color' | 'vector' | 'texture';
  value: GodotParameterValue;
}
type ColorValue = Color | Vector3 | Vector4;
interface ColorBinding { id: string; read: () => ColorValue; initial: ColorValue; base: ColorValue; applied: ColorValue }
interface Binding { parameter: GodotParameter; material: ShaderMaterial; name: string; initial: unknown }

/** Editable shader uniforms, addressed by scene-relative node path rather than UUID. */
export class GodotCustomization {
  readonly parameters: GodotParameter[] = [];
  private readonly bindings = new Map<string, Binding>();
  private readonly textureChanges = new Map<string, { texture: Texture; path: string; owned: boolean }>();
  private readonly textureRequests = new Map<string, number>();
  private readonly changes = new Map<string, GodotParameterValue>();
  private readonly colorBindings = new Map<string, ColorBinding>();
  private readonly colorAliases = new Map<string, string>();
  private readonly colorChanges = new Map<string, number[]>();
  private hueShift = 0;

  constructor(root: Object3D) {
    const colorTargets = new Map<object, string>();
    root.traverse(object => {
      const names: string[] = [];
      for (let node: Object3D | null = object; node && node !== root; node = node.parent) names.unshift(node.name);
      const path = names.join('/') || root.name;
      if (object instanceof Light) this.registerColor(`${path}:color`, () => object.color);
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material, index) => {
        const target = path + (materials.length > 1 ? `/material[${index}]` : '');
        const particle = /__particle_\d+$/.test(object.name);
        if (!(material instanceof ShaderMaterial)) {
          for (const name of ['color', 'emissive', 'specular', 'sheenColor']) {
            const value = (material as unknown as Record<string, unknown>)[name];
            if (value instanceof Color && !colorTargets.has(value)) {
              colorTargets.set(value, `${target}:${name}`);
              this.registerColor(`${target}:${name}`, () => (material as unknown as Record<string, Color>)[name]);
            }
          }
          return;
        }

        for (const [name, uniform] of Object.entries(material.uniforms)) {
          if (name.startsWith('u_')||material.userData.godotDepthUniforms?.includes(name)) continue;
          const value = uniform.value;
          if ((value instanceof Color || material.userData.godotSourceColorUniforms?.includes(name) && (value instanceof Vector3 || value instanceof Vector4)) && !colorTargets.has(uniform)) {
            colorTargets.set(uniform, `${target}:${name}`);
            this.registerColor(`${target}:${name}`, () => material.uniforms[name].value);
          }
          const colorId = colorTargets.get(uniform);
          if (colorId) this.colorAliases.set(`${target}:${name}`, colorId);
          if (particle) continue;
          const type = value instanceof Texture || material.userData.godotTextureUniforms?.includes(name) ? 'texture' : value instanceof Color ? 'color' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : value instanceof Vector2 || value instanceof Vector3 || value instanceof Vector4 ? 'vector' : undefined;
          if (!type) continue;
          const parameter: GodotParameter = { id: `${target}:${name}`, target, name, type, value: type==='texture' ? (value?.name || '未設定') : serialize(value) };
          this.parameters.push(parameter);
          this.bindings.set(parameter.id, { parameter, material, name, initial: clone(value) });
        }
      });
    });
  }

  /** Rotate actual color properties and uniforms relative to their base colors. */
  setHueShift(degrees: number): void {
    if (!Number.isFinite(degrees)) throw new Error('Hue shift must be a finite number of degrees');
    this.hueShift = degrees;
    this.apply();
  }
  getHueShift(): number { return this.hueShift; }
  resetHueShift(): void { this.setHueShift(0); }

  /** Commit the current hue to actual color values and clear the relative hue control. */
  applyHueShift(): void {
    this.apply();
    if (this.hueShift === 0) return;
    for (const binding of this.colorBindings.values()) {
      this.colorChanges.set(binding.id, binding.read().toArray());
      this.changes.delete(binding.id);
      binding.base.copy(binding.read() as Color & Vector3 & Vector4);
    }
    for (const id of this.changes.keys()) if (this.colorAliases.has(id)) this.changes.delete(id);
    this.hueShift = 0;
    this.apply();
  }
  /** Exact linear RGB/RGBA values, including HDR, for reproducing committed colors. */
  getColorOverrides(): Record<string, number[]> {
    return Object.fromEntries([...this.colorChanges].map(([id, value]) => [id, [...value]]));
  }
  setColor(id: string, value: number[]): void {
    id = this.colorAliases.get(id) ?? id;
    const binding = this.colorBindings.get(id);
    if (!binding || value.length !== binding.initial.toArray().length || value.some(v => !Number.isFinite(v))) throw new Error(`Invalid Godot color: ${id}`);
    this.colorChanges.set(id, [...value]);
    this.changes.delete(id);
    this.apply();
  }

  setParameter(id: string, value: GodotParameterValue): void {
    const binding = this.bindings.get(id);
    if (!binding) throw new Error(`Unknown Godot parameter: ${id}`);
    const { parameter } = binding;
    if(parameter.type==='texture') throw new Error('Use setTexture() for texture parameters');
    if (parameter.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)) ||
        parameter.type === 'boolean' && typeof value !== 'boolean' ||
        parameter.type === 'color' && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) ||
        parameter.type === 'vector' && (!Array.isArray(value) || value.length !== (parameter.value as number[]).length || value.some(v => !Number.isFinite(v)))) {
      throw new Error(`Invalid value for Godot parameter: ${id}`);
    }
    const saved = Array.isArray(value) ? [...value] : value;
    const colorId = this.colorAliases.get(id) ?? id;
    this.colorChanges.delete(colorId);
    for (const otherId of this.changes.keys()) if (otherId !== id && this.colorAliases.get(otherId) === colorId) this.changes.delete(otherId);
    this.changes.set(id, saved);
    parameter.value = saved;
    this.applyBinding(binding, saved);
    this.applyColors();
  }

  async setTexture(id: string, source: string | Blob | Texture, assetPath?: string): Promise<void> {
    const binding=this.bindings.get(id);
    if(!binding || binding.parameter.type!=='texture')throw new Error(`Unknown texture parameter: ${id}`);
    const request=(this.textureRequests.get(id)??0)+1;this.textureRequests.set(id,request);
    const objectUrl=source instanceof Blob?URL.createObjectURL(source):undefined;
    let texture:Texture;
    try {texture=source instanceof Texture?source:await new TextureLoader().loadAsync(objectUrl??source as string);}
    finally {if(objectUrl)URL.revokeObjectURL(objectUrl);}
    if(this.textureRequests.get(id)!==request){if(!(source instanceof Texture))texture.dispose();return;}
    const original=binding.initial as Texture|undefined;
    texture.wrapS=original?.wrapS??RepeatWrapping;texture.wrapT=original?.wrapT??RepeatWrapping;
    if(original){texture.colorSpace=original.colorSpace;texture.flipY=original.flipY;texture.repeat.copy(original.repeat);texture.offset.copy(original.offset);texture.minFilter=original.minFilter;texture.magFilter=original.magFilter;texture.generateMipmaps=original.generateMipmaps;}
    texture.needsUpdate=true;
    const previous=this.textureChanges.get(id);if(previous?.owned)previous.texture.dispose();
    const path=assetPath??(typeof source==='string'?source:source instanceof File?'/godot/custom/'+source.name:'');
    this.textureChanges.set(id,{texture,path,owned:!(source instanceof Texture)});
    binding.parameter.value=path||texture.name||'差し替えテクスチャ';
    binding.material.uniforms[binding.name].value=texture;
  }
  getTextureOverrides(): Record<string,string> {return Object.fromEntries([...this.textureChanges].filter(([,v])=>v.path).map(([id,v])=>[id,v.path]));}
  dispose():void {this.reset();}

  /** Apply after AnimationMixer.update() so explicitly edited values remain stable. */
  apply(): void { for (const [id, value] of this.changes) this.applyBinding(this.bindings.get(id)!, value);for(const [id,value] of this.textureChanges){const b=this.bindings.get(id)!;b.material.uniforms[b.name].value=value.texture;} this.applyColors(); }
  getOverrides(): Record<string, GodotParameterValue> {
    return Object.fromEntries([...this.changes].map(([id, value]) => [id, Array.isArray(value) ? [...value] : value]));
  }
  reset(): void {
    this.hueShift = 0;
    this.colorChanges.clear();
    for (const binding of this.colorBindings.values()) {
      binding.read().copy(binding.initial as Color & Vector3 & Vector4);
      binding.base.copy(binding.initial as Color & Vector3 & Vector4);
      binding.applied.copy(binding.initial as Color & Vector3 & Vector4);
    }
    this.changes.clear();
    for(const [id,value] of this.textureChanges){if(value.owned)value.texture.dispose();}
    this.textureChanges.clear();
    for(const [id,request] of this.textureRequests)this.textureRequests.set(id,request+1);
    for (const binding of this.bindings.values()) {
      binding.material.uniforms[binding.name].value = clone(binding.initial);
      binding.parameter.value = binding.parameter.type==='texture' ? ((binding.initial as Texture)?.name||'未設定') : serialize(binding.initial);
    }
  }
  private registerColor(id: string, read: () => ColorValue): void {
    const value = read();
    this.colorBindings.set(id, { id, read, initial: value.clone(), base: value.clone(), applied: value.clone() });
  }
  private applyColors(): void {
    const source = new Color(), rotated = new Color();
    for (const binding of this.colorBindings.values()) {
      const value = binding.read(), committed = this.colorChanges.get(binding.id);
      if (committed) binding.base.fromArray(committed);
      else if (!value.equals(binding.applied as Color & Vector3 & Vector4)) binding.base.copy(value as Color & Vector3 & Vector4);
      const base = binding.base;
      if (base instanceof Color) source.copy(base);
      else source.setRGB(base.x, base.y, base.z);
      rotateGodotHue(source, (this.hueShift % 360) / 360, rotated);
      if (value instanceof Color) value.copy(rotated);
      else { value.x = rotated.r; value.y = rotated.g; value.z = rotated.b; if (value instanceof Vector4 && base instanceof Vector4) value.w = base.w; }
      binding.applied.copy(value as Color & Vector3 & Vector4);
    }
    // Shared uniforms may be exposed by several nodes; keep every UI row in sync.
    for (const binding of this.bindings.values()) {
      const value = binding.material.uniforms[binding.name].value;
      if (value instanceof Color || binding.material.userData.godotSourceColorUniforms?.includes(binding.name)) binding.parameter.value = serialize(value);
    }
  }
  private applyBinding(binding: Binding, value: GodotParameterValue): void {
    const uniform = binding.material.uniforms[binding.name];
    if (binding.parameter.type === 'color') uniform.value = new Color(value as string);
    else if (binding.parameter.type === 'vector') uniform.value = clone(binding.initial).fromArray(value);
    else uniform.value = value;
  }
}
function clone(value: any): any { return value instanceof Texture ? value : value?.clone ? value.clone() : value; }
function serialize(value: any): GodotParameterValue {
  return value instanceof Color ? `#${value.getHexString()}` : value?.toArray ? value.toArray() : value;
}
