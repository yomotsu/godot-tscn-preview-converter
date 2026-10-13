import * as THREE from 'three';
import { createGodotParticleRuntime } from './particle-runtime.js';
import FastNoiseLite, { CellularDistanceFunction, CellularReturnType, DomainWarpType, FractalType, NoiseType, RotationType3D, TransformType3D } from '../../vendor/FastNoiseLite.ts';
import { createGodotNoiseTextureDataGenerator } from '../../converters/GodotNoiseTexture.ts';

import { generateGodotGradientTextureData } from '../../converters/GodotGradientTexture.ts';

const generateGodotNoiseTextureData = createGodotNoiseTextureDataGenerator(FastNoiseLite);

function getUniformSource(material) { return material?.uniforms ?? material?.userData?.godotShaderUniforms; }
function getMaterials(object) { return Array.isArray(object.material) ? object.material : object.material ? [object.material] : []; }

function decodeBase64Buffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function decodeBase85Data(encoded) {
  const separator = encoded.indexOf(':'), byteLength = Number(encoded.slice(0, separator)), text = encoded.slice(separator + 1);
  if (separator < 1 || !Number.isSafeInteger(byteLength) || byteLength < 0 || text.length % 5 || byteLength > text.length / 5 * 4) {
    throw new Error('Invalid Base85 scene data');
  }
  const alphabet = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33))
    .filter((character) => character !== '"' && character !== '\\').slice(0, 85).join('');
  const digits = new Int16Array(128);
  digits.fill(-1);
  for (let index = 0; index < alphabet.length; index++) digits[alphabet.charCodeAt(index)] = index;
  const output = new Uint8Array(text.length / 5 * 4);
  for (let offset = 0; offset < text.length; offset += 5) {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const code = text.charCodeAt(offset + index), digit = code < digits.length ? digits[code] : -1;
      if (digit < 0) throw new Error('Invalid Base85 scene data');
      value = value * 85 + digit;
    }
    if (value > 0xffffffff) throw new Error('Invalid Base85 scene data');
    const at = offset / 5 * 4;
    for (let index = 3; index >= 0; index--) {
      output[at + index] = value % 256;
      value = Math.floor(value / 256);
    }
  }
  return output.subarray(0, byteLength);
}

function decodeCompressedData(data, format = 'legacy') {
  let input;
  if (format === 'base85') input = decodeBase85Data(data);
  else {
    const binary = atob(data);
    input = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) input[index] = binary.charCodeAt(index);
  }
  let output = new Uint8Array(Math.max(256, input.length * 2)), length = 0, offset = 0;
  const reserve = (size) => {
    if (length + size <= output.length) return;
    let capacity = output.length;
    while (capacity < length + size) capacity *= 2;
    const expanded = new Uint8Array(capacity);
    expanded.set(output.subarray(0, length));
    output = expanded;
  };
  while (offset < input.length) {
    const control = input[offset++];
    for (let bit = 0; bit < 8 && offset < input.length; bit++) {
      if (control & (1 << bit)) {
        const code = (input[offset++] << 8) | input[offset++];
        const wideWindow = format !== 'legacy';
        const distance = wideWindow ? code + 1 : (code >>> 4) + 1;
        const count = wideWindow ? input[offset++] + 3 : (code & 15) + 3;
        reserve(count);
        for (let index = 0; index < count; index++) {
          output[length] = output[length - distance];
          length++;
        }
      } else {
        reserve(1);
        output[length++] = input[offset++];
      }
    }
  }
  return new TextDecoder().decode(output.subarray(0, length));
}

function restorePackedSceneData(data, config) {
  for (const geometry of data.geometries ?? []) {
    const buffers = [...Object.values(geometry.data?.attributes ?? {}), geometry.data?.index].filter(Boolean);
    for (const buffer of buffers) if (buffer.encoding === 'base64') { buffer.array = decodeBase64Buffer(buffer.array); delete buffer.encoding; }
  }
  for (const image of data.images ?? []) for (const source of (Array.isArray(image.url) ? image.url : [image.url])) {
    if (source?.encoding === 'base64') { source.data = decodeBase64Buffer(source.data); delete source.encoding; }
    else if (source?.encoding === 'godot-gradient') { source.data = generateGodotGradientTextureData(source.godotGradientTexture).buffer; delete source.encoding; delete source.godotGradientTexture; }
    else if (source?.encoding === 'godot-noise') { source.data = generateGodotNoiseTextureData(source.godotNoiseTexture); delete source.encoding; delete source.godotNoiseTexture; }
  }
  for (const material of data.materials ?? []) {
    if (Number.isInteger(material.vertexShaderIndex)) { material.vertexShader = config.shaderSources[material.vertexShaderIndex]; delete material.vertexShaderIndex; }
    if (Number.isInteger(material.fragmentShaderIndex)) { material.fragmentShader = config.shaderSources[material.fragmentShaderIndex]; delete material.fragmentShaderIndex; }
  }
  return data;
}

function restoreGodotLinearColors(root) {
  root.traverse((object) => {
    for (const [name, values] of Object.entries(object.userData?.godotLinearColors ?? {})) {
      object[name]?.fromArray?.(values);
    }
    for (const material of getMaterials(object)) {
      const colors = material.userData?.godotLinearColors;
      if (!colors) continue;
      for (const [name, values] of Object.entries(colors.properties ?? {})) material[name]?.fromArray?.(values);
      for (const [name, values] of Object.entries(colors.uniforms ?? {})) getUniformSource(material)?.[name]?.value?.fromArray?.(values);
    }
  });
}

function restoreParticleUniformValue(uniform, serialized) {
  const value = serialized?.value, current = uniform.value;
  switch (serialized?.type) {
    case 'c': if (current?.isColor) current.setHex(value); else uniform.value = new THREE.Color().setHex(value); break;
    case 'v2': if (current?.isVector2) current.fromArray(value); else uniform.value = new THREE.Vector2().fromArray(value); break;
    case 'v3': if (current?.isVector3) current.fromArray(value); else uniform.value = new THREE.Vector3().fromArray(value); break;
    case 'v4': if (current?.isVector4) current.fromArray(value); else uniform.value = new THREE.Vector4().fromArray(value); break;
    case 'm3': if (current?.isMatrix3) current.fromArray(value); else uniform.value = new THREE.Matrix3().fromArray(value); break;
    case 'm4': if (current?.isMatrix4) current.fromArray(value); else uniform.value = new THREE.Matrix4().fromArray(value); break;
    case 't': break;
    default: uniform.value = structuredClone(value);
  }
}

function restoreParticleMaterialVariants(root, variants, particleData) {
  if (!variants?.length) return;
  const objects = new Map();
  root.traverse((object) => objects.set(object.uuid, object));
  for (const [systemIndex, particleIndex, slot, materialUuid, overrides] of variants) {
    const particleUuid = particleData.systems?.[systemIndex]?.particles?.[particleIndex]?.uuid;
    const object = objects.get(particleUuid);
    if (!object?.material) continue;
    const isArray = Array.isArray(object.material), materials = isArray ? object.material.slice() : [object.material];
    const source = materials[slot];
    if (!source?.isShaderMaterial) continue;
    const material = source.clone();
    material.uuid = materialUuid;
    for (const [name, serialized] of Object.entries(overrides ?? {})) {
      const uniform = material.uniforms?.[name];
      if (uniform) restoreParticleUniformValue(uniform, serialized);
    }
    materials[slot] = material;
    object.material = isArray ? materials : material;
  }
}

export function restoreGodotGeometryDrawRanges(root) {
  root.traverse((object) => {
    const geometry = object.geometry, drawRange = geometry?.userData?.godotDrawRange;
    if (!Array.isArray(drawRange) || drawRange.length !== 2) return;
    geometry.setDrawRange(drawRange[0], drawRange[1] === null ? Infinity : drawRange[1]);
    delete geometry.userData.godotDrawRange;
  });
}

export function restoreGodotProceduralGeometries(root) {
  const restored = new Set();
  root.traverse((object) => {
    const geometry = object.geometry, recipe = geometry?.userData?.godotGeometryRecipe;
    if (!geometry || !recipe || restored.has(geometry)) return;
    restored.add(geometry);
    if (geometry.parameters && recipe.kind === 'sphere') {
      const scaleY = Number(recipe.scaleY ?? 1);
      if (recipe.hemisphere && geometry.parameters.radius > 0) {
        const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
        for (let index = 0; index < positions.count; index++) {
          if (positions.getY(index) < 0) {
            positions.setY(index, 0);
            normals.setXYZ(index, 0, -1, 0);
          } else {
            positions.setY(index, positions.getY(index) * scaleY);
            const normal = new THREE.Vector3(normals.getX(index) * scaleY, normals.getY(index), normals.getZ(index) * scaleY).normalize();
            normals.setXYZ(index, normal.x, normal.y, normal.z);
          }
        }
        positions.needsUpdate = normals.needsUpdate = true;
      } else if (Math.abs(scaleY - 1) > 1e-6) geometry.scale(1, scaleY, 1);
      geometry.rotateY(Math.PI / 2);
      const uv = geometry.getAttribute('uv');
      if (uv) for (let index = 0; index < uv.count; index++) uv.setY(index, 1 - uv.getY(index));
    } else if (geometry.parameters && (recipe.kind === 'plane' || recipe.kind === 'torus')) geometry.rotateX(-Math.PI / 2);
    else if (geometry.parameters && recipe.kind === 'cylinderUV') {
      const uv = geometry.getAttribute('uv'), index = geometry.getIndex();
      if (uv && index) for (const group of geometry.groups) {
        const vertices = new Set();
        for (let offset = group.start; offset < group.start + group.count; offset++) vertices.add(index.getX(offset));
        for (const vertex of vertices) {
          if (group.materialIndex === 0) uv.setY(vertex, (1 - uv.getY(vertex)) * 0.5);
          else uv.setXY(vertex, uv.getX(vertex) * 0.5 + (group.materialIndex === 2 ? 0.5 : 0), uv.getY(vertex) * 0.5 + 0.5);
        }
      }
    }
    if (recipe.colorItemSize && !geometry.getAttribute('color')) {
      const position = geometry.getAttribute('position');
      if (position) geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(position.count * recipe.colorItemSize).fill(1), recipe.colorItemSize));
    }
    delete geometry.userData.godotGeometryRecipe;
  });
}

function restoreAnimationMaterialAliases(root, clips) {
  for (const clip of clips) for (const track of clip.tracks) {
    let path;
    try { path = THREE.PropertyBinding.parseTrackName(track.name); } catch { continue; }
    if (path.objectName !== 'material' || !path.propertyName.startsWith('godotUniform_')) continue;
    const object = THREE.PropertyBinding.findNode(root, path.nodeName);
    if (!object) continue;
    const materials = getMaterials(object);
    const targets = path.objectIndex === undefined ? materials : [materials[Number(path.objectIndex)]].filter(Boolean);
    const uniformName = path.propertyName.slice('godotUniform_'.length);
    for (const material of targets) {
      const uniforms = getUniformSource(material);
      if (!uniforms?.[uniformName] || material[path.propertyName] !== undefined) continue;
      Object.defineProperty(material, path.propertyName, {
        configurable: true,
        get: () => getUniformSource(material)?.[uniformName]?.value,
        set: (value) => { const current = getUniformSource(material)?.[uniformName]; if (current) current.value = value; },
      });
    }
  }
}

function restorePreviewEnvironment(root, value) {
  if (!value) return null;
  let backgroundTexture = null, environmentTexture = null;
  const carrier = root.getObjectByName('__godotEnvironmentTextureCarrier');
  if (carrier) {
    for (const child of [...carrier.children]) {
      if (child.name === '__godotEnvironment_background') backgroundTexture = child.material?.map ?? null;
      if (child.name === '__godotEnvironment_environment') environmentTexture = child.material?.map ?? null;
      child.parent.remove(child); child.geometry?.dispose(); child.material?.dispose();
    }
    carrier.parent?.remove(carrier);
  }
  return {
    background: value.backgroundType === 'texture' ? backgroundTexture : value.backgroundType === 'color' ? new THREE.Color().fromArray(value.backgroundColor) : null,
    environment: value.hasEnvironmentTexture ? environmentTexture : null,
    skyRotation: new THREE.Euler().fromArray(value.skyRotation), skyEnergy: value.skyEnergy,
    exposure: value.exposure, tonemapMode: 0, glow: value.glow, glowBloom: value.glowBloom,
    fogDensity: value.fogDensity, volumetricDensity: value.volumetricDensity, fogSkyAffect: value.fogSkyAffect,
    fog: value.hasFog ? new THREE.FogExp2(new THREE.Color().fromArray(value.fogColor), value.fogDensity || value.volumetricDensity) : null,
    ambientColor: new THREE.Color().fromArray(value.ambientColor),
  };
}

function restoreGodotShaderUniformArrays(root) {
  const declarationPattern = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(vec[234]|mat[34])\s+(\w+)\s*\[\s*(\d+)\s*\]/g;
  root.traverse((object) => { for (const material of getMaterials(object)) {
    if (!material.isShaderMaterial) continue;
    const shader = String(material.vertexShader || '') + String(material.fragmentShader || '');
    for (const match of shader.matchAll(declarationPattern)) {
      const [, type, name, declaredLength] = match, uniform = material.uniforms?.[name], value = uniform?.value, length = Number(declaredLength);
      if (!Array.isArray(value) || !length) continue;
      if (type.startsWith('vec')) {
        const components = Number(type.slice(3)), Vector = components === 2 ? THREE.Vector2 : components === 3 ? THREE.Vector3 : THREE.Vector4;
        if (components === 3 && /colou?r/i.test(name) && value.length === length && value.every((item) => typeof item === 'number')) uniform.value = value.map((hex) => new THREE.Color(hex));
        else if (value.length === length * components && value.every((item) => typeof item === 'number')) uniform.value = Array.from({ length }, (_, index) => new Vector().fromArray(value, index * components));
        else if (components === 3 && /colou?r/i.test(name)) uniform.value = value.map((item) => item?.isColor && typeof item.copy === 'function' ? item : new THREE.Color().setRGB(item?.r ?? item?.x ?? item?.[0] ?? 0, item?.g ?? item?.y ?? item?.[1] ?? 0, item?.b ?? item?.z ?? item?.[2] ?? 0));
        else uniform.value = value.map((item) => {
          const isVector = components === 2 ? item?.isVector2 : components === 3 ? item?.isVector3 : item?.isVector4;
          if (isVector && typeof item.set === 'function') return item;
          const values = Array.isArray(item) || ArrayBuffer.isView(item) ? item
            : components === 2 ? [item?.x ?? 0, item?.y ?? 0]
              : components === 3 ? [item?.x ?? 0, item?.y ?? 0, item?.z ?? 0]
                : [item?.x ?? 0, item?.y ?? 0, item?.z ?? 0, item?.w ?? 0];
          return new Vector().fromArray(values);
        });
      } else {
        const Matrix = type === 'mat3' ? THREE.Matrix3 : THREE.Matrix4, components = type === 'mat3' ? 9 : 16;
        if (value.length === length * components && value.every((item) => typeof item === 'number')) uniform.value = Array.from({ length }, (_, index) => new Matrix().fromArray(value, index * components));
        else if (value.length === length) uniform.value = value.map((item) => {
          if ((item?.isMatrix3 || item?.isMatrix4) && typeof item.fromArray === 'function') return item;
          return new Matrix().fromArray(item?.elements ?? item);
        });
      }
    }
  }});
}

function linkParticleUniforms(root, particleData) {
  const objects = new Map(); root.traverse((object) => objects.set(object.uuid, object));
  const perParticle = new Set(['u_particleColor', 'u_instanceCustom', 'u_billboard', 'u_instanceId']);
  for (const system of particleData.systems ?? []) {
    const emitter = objects.get(system.emitterUuid);
    if (!emitter) continue;
    const particles = Array.isArray(system.particles)
      ? system.particles.map((particle) => objects.get(particle.uuid))
      : [objects.get(system.templateUuid)];
    for (const object of particles) {
      if (!object) continue;
      const sources = getMaterials(emitter), targets = getMaterials(object);
      for (let index = 0; index < Math.min(sources.length, targets.length); index++) {
        const source = sources[index], target = targets[index];
        if (!source.uniforms || !target.uniforms) continue;
        for (const [name, uniform] of Object.entries(source.uniforms)) if (!perParticle.has(name) && target.uniforms[name]) target.uniforms[name] = uniform;
      }
    }
  }
}

function updateShaderTime(root, time) {
  root.traverse((object) => { for (const material of getMaterials(object)) { const uniforms = getUniformSource(material); if (uniforms?.u_time) uniforms.u_time.value = time; } });
}

function updateShaderLights(root) {
  const lights = []; let stage = root; while (stage.parent) stage = stage.parent; stage.updateMatrixWorld(true);
  const environment = stage.userData?.godotEnvironment, previewFogScale = Number(stage.userData?.godotPreviewFogScale ?? 1);
  stage.traverseVisible((object) => { if (object.isPointLight || object.isDirectionalLight || object.isSpotLight) lights.push(object); });
  root.traverse((object) => { for (const material of getMaterials(object)) {
    const uniforms = getUniformSource(material); if (!uniforms?.u_lightCount) continue;
    if (uniforms.u_fogDensity) {
      uniforms.u_fogDensity.value = (environment?.fogDensity ?? 0) * previewFogScale;
      uniforms.u_volumetricDensity.value = (environment?.volumetricDensity ?? 0) * previewFogScale;
      uniforms.u_fogColor.value?.copy?.(environment?.fog?.color ?? new THREE.Color(0, 0, 0));
      if (environment) uniforms.u_ambient.value?.copy?.(environment.ambientColor);
    }
    uniforms.u_lightCount.value = Math.min(lights.length, 8);
    for (let i = 0; i < Math.min(lights.length, 8); i++) {
      const light = lights[i], position = light.getWorldPosition(new THREE.Vector3());
      if (light.isDirectionalLight) position.sub(light.target.getWorldPosition(new THREE.Vector3())).normalize();
      const positionValue = uniforms.u_lightPosition.value[i];
      if (typeof positionValue?.set === 'function') positionValue.set(position.x, position.y, position.z, light.isDirectionalLight ? 0 : 1);
      else uniforms.u_lightPosition.value[i] = new THREE.Vector4(position.x, position.y, position.z, light.isDirectionalLight ? 0 : 1);
      const colorValue = uniforms.u_lightColor.value[i];
      if (typeof colorValue?.copy === 'function') colorValue.copy(light.color).multiplyScalar(light.intensity * Math.PI);
      else uniforms.u_lightColor.value[i] = light.color.clone().multiplyScalar(light.intensity * Math.PI);
      uniforms.u_lightDecay.value[i] = light.userData.godotDecay ?? 2; uniforms.u_spotDecay.value[i] = light.userData.godotSpotDecay ?? 1;
      const directionValue = uniforms.u_lightDirection.value[i];
      if (light.isSpotLight) {
        const direction = light.target.getWorldPosition(new THREE.Vector3()).sub(position).normalize();
        if (typeof directionValue?.set === 'function') directionValue.set(direction.x, direction.y, direction.z, Math.cos(light.angle));
        else uniforms.u_lightDirection.value[i] = new THREE.Vector4(direction.x, direction.y, direction.z, Math.cos(light.angle));
      } else if (typeof directionValue?.set === 'function') directionValue.set(0, 0, 0, -1);
      else uniforms.u_lightDirection.value[i] = new THREE.Vector4(0, 0, 0, -1);
      uniforms.u_lightRange.value[i] = light.isPointLight || light.isSpotLight ? light.distance : 0;
    }
  }});
}

function applyWebGPUShaderMaterials(root, factories, materialShaderKeys, TSL, runtimeThree = THREE) {
  root.traverse((object) => {
    if (!object.material) return;
    const sourceMaterials = getMaterials(object);
    const converted = sourceMaterials.map((source) => {
      if (!source.isShaderMaterial) return source;
      const shaderKey = materialShaderKeys[source.uuid] ?? materialShaderKeys[source.userData?.godotBaseMaterialUuid];
      const shader = factories[shaderKey];
      if (!shader) throw new Error('WebGPU 用 TSL グラフがありません: ' + source.uuid);
      const uniforms = source.uniforms, material = new runtimeThree.MeshBasicNodeMaterial();
      material.colorNode = shader.fragment(TSL, uniforms).main; material.vertexNode = shader.vertex(TSL, uniforms).main;
      material.transparent = source.transparent; material.blending = source.blending; material.side = source.side;
      material.depthWrite = source.depthWrite; material.depthTest = source.depthTest; material.alphaTest = source.alphaTest;
      material.opacity = source.opacity; material.toneMapped = source.toneMapped;
      material.userData = { ...source.userData, godotShaderUniforms: uniforms }; source.dispose(); return material;
    });
    object.material = Array.isArray(object.material) ? converted : converted[0];
  });
}

export class AbstractVFXMesh extends THREE.Mesh {
  static rendererTarget = 'WebGLRenderer';
  static previewId = '';
  static previewRootPositionAnimated = false;
  static config = {};

  static decodeDataKeys(value, keyMap) {
    if (typeof value === 'string') {
      const format = value.startsWith('LZ1:') ? 'legacy'
        : value.startsWith('LZ2:') ? 'wide'
          : value.startsWith('LZ3:') ? 'base85'
            : '';
      if (format) value = JSON.parse(decodeCompressedData(value.slice(4), format));
    }
    const visit = (node) => {
      if (Array.isArray(node)) {
        for (let index = 0; index < node.length; index++) node[index] = visit(node[index]);
      } else if (node && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) {
          const decoded = visit(child), name = Object.prototype.hasOwnProperty.call(keyMap, key) ? keyMap[key] : key;
          if (name !== key) {
            Object.defineProperty(node, name, { value: decoded, enumerable: true, writable: true, configurable: true });
            delete node[key];
          } else node[key] = decoded;
        }
      }
      return node;
    };
    return visit(value);
  }

  constructor() {
    super(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
    const config = new.target.config ?? {};
    this._config = config;
    this.geometry.setDrawRange(0, 0);
    this.name = config.name || new.target.name;
    const scene = restorePackedSceneData(structuredClone(config.sceneData), config);
    this.effectRoot = new THREE.ObjectLoader().parse(scene);
    restoreGodotLinearColors(this.effectRoot);
    if (config.features?.particleMaterialVariants) restoreParticleMaterialVariants(this.effectRoot, config.particleMaterialVariants, config.particleData ?? {});
    if (config.features?.geometryRecipes) restoreGodotProceduralGeometries(this.effectRoot);
    if (config.features?.geometryDrawRanges) restoreGodotGeometryDrawRanges(this.effectRoot);
    if (config.features?.shaderUniformArrays) restoreGodotShaderUniformArrays(this.effectRoot);
    this.previewEnvironment = restorePreviewEnvironment(this.effectRoot, config.environmentData);
    this.add(this.effectRoot);
    this.effectRoot.traverse((node) => {
      if (node.userData?.godotParticleSystem) node.emitting = Boolean(node.userData.godotParticleSystem.emitting);
      if (node.userData?.godotRuntimeProperties) Object.assign(node, node.userData.godotRuntimeProperties);
    });
    if (config.features?.particles) {
      linkParticleUniforms(this.effectRoot, config.particleData ?? {});
      this._updateParticles = createGodotParticleRuntime(this.effectRoot, config.particleData ?? { systems: [] }, THREE);
    } else this._updateParticles = () => {};
    this._mixer = new THREE.AnimationMixer(this.effectRoot);
    this._clips = (config.animationData ?? []).map((data) => THREE.AnimationClip.parse(data));
    this._playback = config.playbackData ?? [];
    if (config.target === 'webgpu' && Object.keys(config.webgpuShaderFactories ?? {}).length) applyWebGPUShaderMaterials(this.effectRoot, config.webgpuShaderFactories, config.webgpuMaterialShaderKeys ?? {}, config.TSL, config.THREE);
    if (config.features?.animationMaterialAliases) restoreAnimationMaterialAliases(this.effectRoot, this._clips);
    this.play();
  }

  play() {
    this._mixer.stopAllAction(); this._mixer.timeScale = 1;
    for (const data of this._playback) {
      const clip = this._clips.find((item) => item.uuid === data.clipUuid); if (!clip) continue;
      const action = this._mixer.clipAction(clip);
      action.setLoop(data.loop, data.repetitions || (data.loop === THREE.LoopOnce ? 1 : Infinity));
      action.clampWhenFinished = data.clampWhenFinished; action.reset().play();
    }
    this._mixer.setTime(0); this.updateTime(0); return this;
  }

  update(deltaSeconds) {
    const delta = Math.max(0, Number(deltaSeconds) || 0);
    this._mixer.update(delta); this._time = this._mixer.time;
    if (this._config.features?.shaderTime) updateShaderTime(this.effectRoot, this._time);
    this._updateParticles(this._time);
    if (this._config.features?.shaderLights) updateShaderLights(this.effectRoot);
    return this;
  }

  updateTime(timeSeconds) {
    if (!Number.isFinite(timeSeconds)) return this;
    this._time = Math.max(0, timeSeconds); this._mixer.setTime(this._time);
    if (this._config.features?.shaderTime) updateShaderTime(this.effectRoot, this._time);
    this._updateParticles(this._time);
    if (this._config.features?.shaderLights) updateShaderLights(this.effectRoot);
    return this;
  }

  dispose() {
    this._mixer?.stopAllAction();
    const geometries = new Set(), materials = new Set(), textures = new Set();
    this.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of getMaterials(object)) { materials.add(material); const uniforms = getUniformSource(material); if (uniforms) for (const uniform of Object.values(uniforms)) if (uniform.value?.isTexture) textures.add(uniform.value); }
    });
    for (const texture of [this.previewEnvironment?.background, this.previewEnvironment?.environment]) if (texture?.isTexture) textures.add(texture);
    for (const texture of textures) texture.dispose(); for (const material of materials) material.dispose(); for (const geometry of geometries) geometry.dispose();
  }
}

function renderNoiseTextureRuntime() {
  const enumSource = [
    ['NoiseType', NoiseType], ['RotationType3D', RotationType3D], ['FractalType', FractalType],
    ['CellularDistanceFunction', CellularDistanceFunction], ['CellularReturnType', CellularReturnType], ['DomainWarpType', DomainWarpType], ['TransformType3D', TransformType3D],
  ].map(([name, values]) => `const ${name} = ${JSON.stringify(values)};`).join('\n');
  const license = `/*! FastNoiseLite.js v1.1.1, ported by snowfoxsh and Simon Paris.
MIT License
Copyright(c) 2023 Jordan Peck (jordan.me2@gmail.com)
Copyright(c) 2023 Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/`;
  return `${license}\n${enumSource}\nconst FastNoiseLite = ${FastNoiseLite.toString()};\nconst generateGodotNoiseTextureData = (${createGodotNoiseTextureDataGenerator.toString()})(FastNoiseLite);\n`;
}

export function renderAbstractVFXMeshSource() {
  return `import * as THREE from 'three';
${renderNoiseTextureRuntime()}
const generateGodotGradientTextureData = ${generateGodotGradientTextureData.toString()};
const createGodotParticleRuntime = ${createGodotParticleRuntime.toString()};
${[
  getUniformSource, getMaterials, decodeBase64Buffer, restorePackedSceneData,
  decodeBase85Data, decodeCompressedData,
  restoreGodotLinearColors, restoreParticleUniformValue, restoreParticleMaterialVariants, restoreGodotGeometryDrawRanges,
  restoreGodotProceduralGeometries, restoreAnimationMaterialAliases, restorePreviewEnvironment,
  restoreGodotShaderUniformArrays, linkParticleUniforms, updateShaderTime, updateShaderLights,
  applyWebGPUShaderMaterials, AbstractVFXMesh,
].map((value) => value.toString()).join('\n\n')}
export { AbstractVFXMesh };
`;
}
