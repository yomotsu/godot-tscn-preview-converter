import * as THREE from 'three';
export { restoreGodotGeometryDrawRanges, restoreGodotProceduralGeometries } from './runtime.js';

/** Download a class derived from the currently previewed Godot scene. */
export async function exportThreeClass({ target, effect, entry, actions = [] }) {
  if (!entry?.result?.scene) throw new Error('書き出すエフェクトがありません');
  if (!['webgl', 'webgpu'].includes(target)) throw new Error(`未対応の出力先です: ${target}`);

  const baked = captureAnimatedEffect(entry, actions, effect.id || '');
  const className = toClassName(effect.id || effect.name);

  const webgpuShaders = target === 'webgpu' ? await collectWebGPUShaderFactories(entry.result.scene) : { factories: {}, materialKeys: {} };
  const source = renderClassSource({
    target, className, effect, sceneData: baked.sceneData,
    animationData: baked.animationData,
    playbackData: baked.playbackData,
    particleData: baked.particleData,
    previewRootPositionAnimated: baked.previewRootPositionAnimated,
    environmentData: serializePreviewEnvironment(entry.result.environment),
    shaderFactories: webgpuShaders.factories, shaderKeys: webgpuShaders.materialKeys,
  });
  const fileBase = safeFileName(effect.id || effect.name || className);
  const fileName = `${fileBase}.${target}.js`;
  const minifiedFileName = `${fileBase}.${target}.min.js`;
  const terser = await getTerser();
  if (typeof terser?.minify !== 'function') throw new Error('Terser が読み込まれていません');
  const minifyOptions = {
    module: true,
    compress: { passes: 5, toplevel: true },
    mangle: true,
    format: { comments: false },
  };
  const minified = await terser.minify(source, minifyOptions);
  if (minified.error) throw minified.error;
  if (!minified.code) throw new Error('min.js を生成できませんでした');
  const classOutputs = [
    { fileName, blob: new Blob([source], { type: 'text/javascript;charset=utf-8' }) },
    { fileName: minifiedFileName, blob: new Blob([minified.code], { type: 'text/javascript;charset=utf-8' }) },
  ];
  const anchor = document.createElement('a');
  for (const output of classOutputs) {
    const url = URL.createObjectURL(output.blob);
    anchor.href = url;
    anchor.download = output.fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return {
    fileName,
    bytes: classOutputs[0].blob.size,
    minifiedFileName,
    minifiedBytes: classOutputs[1].blob.size,
  };
}

async function getTerser() {
  if (typeof globalThis.Terser?.minify === 'function') return globalThis.Terser;

  const script = document.createElement('script');
  script.src = '/vendor/terser.bundle.min.js';
  try {
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Terser を読み込めませんでした: ${script.src}`));
      document.head.append(script);
    });
  } finally {
    script.remove();
  }
  return globalThis.Terser;
}

function captureAnimatedEffect(entry, requestedActions, previewId) {
  // Export only the imported .tscn root; the preview camera and viewer floor live outside it.
  const root = entry.result.scene;
  const mixer = entry.mixer;
  const actions = requestedActions.length ? requestedActions : entry.actions.slice(0, 1);
  const playbackData = actions.map((action) => ({
    clipUuid: action.getClip().uuid,
    loop: action.loop,
    repetitions: Number.isFinite(action.repetitions) ? action.repetitions : 0,
    clampWhenFinished: action.clampWhenFinished,
  }));
  const animationData = [...new Map(actions.map((action) => [action.getClip().uuid, stripAudioTracks(action.getClip().toJSON(), new Set())])).values()];
  const previewRootPositionAnimated = animationData.some((clip) => (clip.tracks ?? []).some((track) => {
    try {
      const path = THREE.PropertyBinding.parseTrackName(track.name);
      return (path.nodeName === root.name || path.nodeName === root.uuid) && !path.objectName && path.propertyName === 'position';
    } catch { return false; }
  }));
  let sceneData;
  const particleData = structuredClone(entry.result.particleRuntimeData ?? { systems: [] });
  const savedMixer = mixer ? {
    time: mixer.time,
    timeScale: mixer.timeScale,
    actions: entry.actions.map((action) => ({
      action,
      scheduled: action.isScheduled(),
      time: action.time,
      timeScale: action.timeScale,
      weight: action.weight,
      enabled: action.enabled,
      paused: action.paused,
      loop: action.loop,
      repetitions: action.repetitions,
      clampWhenFinished: action.clampWhenFinished,
    })),
  } : null;

  try {
    if (mixer) {
      mixer.stopAllAction();
      mixer.timeScale = 1;
      for (const action of actions) {
        action.enabled = true;
        action.paused = false;
        action.timeScale = 1;
        action.reset().play();
      }
      mixer.setTime(0);
    }
    entry.result.updateTime(0);
    root.updateMatrixWorld(true);
    const originalPosition = root.position.clone();
    // The preview offsets air effects for framing. Keep that viewer placement out of the class data.
    try {
      if (previewRootPositionAnimated) root.position.set(0, 0, 0);
      else root.position.y -= previewId.includes('air') ? 2 : 0;
      sceneData = buildSceneData(root, animationData, entry.result.environment);
      compactParticleInstances(sceneData, particleData);
    } finally {
      root.position.copy(originalPosition);
      root.updateMatrixWorld(true);
    }
  } finally {
    if (mixer && savedMixer) restoreMixerState(mixer, savedMixer, entry);
  }

  return { animationData, playbackData, particleData, sceneData, previewRootPositionAnimated };
}

/** Keep one serialized mesh as a prototype; runtime recreates the particle instances from each emitter recipe. */
function compactParticleInstances(sceneData, particleData) {
  const particleUuids = new Set();
  const templateUuids = new Set();
  for (const system of particleData.systems ?? []) {
    const bakedParticles = system.particles ?? [];
    const recipe = system.recipe ?? {};
    const uuids = bakedParticles.map((particle) => particle.uuid);
    // Older/stale preview bundles can provide baked particles without the
    // procedural recipe. Keep those instances intact instead of rebuilding
    // them with incomplete process defaults.
    if (!recipe.templateUuid || !uuids.includes(recipe.templateUuid) || !Number.isFinite(recipe.count)) continue;
    const templateUuid = recipe.templateUuid;
    system.templateUuid = templateUuid;
    system.count = recipe.count;
    system.delay = Number.isFinite(recipe.delay) ? recipe.delay : (bakedParticles[0]?.delay ?? 0);
    if (Number.isFinite(recipe.explosiveness)) system.explosiveness = recipe.explosiveness;
    if (recipe.process) system.process = recipe.process;
    for (const uuid of uuids) particleUuids.add(uuid);
    if (templateUuid) templateUuids.add(templateUuid);
    delete system.recipe;
    delete system.particles;
  }

  const geometryUuids = new Set();
  const materialUuids = new Set();
  const compact = (object) => {
    if (!object) return;
    object.children = (object.children ?? []).filter((child) => {
      if (particleUuids.has(child.uuid) && !templateUuids.has(child.uuid)) return false;
      compact(child);
      return true;
    });
    if (templateUuids.has(object.uuid)) object.visible = false;
    if (typeof object.geometry === 'string') geometryUuids.add(object.geometry);
    const ids = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const id of ids) if (typeof id === 'string') materialUuids.add(id);
  };
  compact(sceneData.object);
  sceneData.geometries = (sceneData.geometries ?? []).filter((geometry) => geometryUuids.has(geometry.uuid));
  sceneData.materials = (sceneData.materials ?? []).filter((material) => materialUuids.has(material.uuid));
}

function restoreMixerState(mixer, saved, entry) {
  mixer.stopAllAction();
  for (const state of saved.actions) {
    const action = state.action;
    action.enabled = state.enabled;
    action.paused = state.paused;
    action.timeScale = state.timeScale;
    action.weight = state.weight;
    action.loop = state.loop;
    action.repetitions = state.repetitions;
    action.clampWhenFinished = state.clampWhenFinished;
    action.time = state.time;
    if (state.scheduled) action.play();
  }
  mixer.timeScale = saved.timeScale;
  mixer.time = saved.time;
  mixer.update(0);
  entry.result.updateTime(saved.time);
  entry.result.scene.updateMatrixWorld(true);
}

export function buildSceneData(root, animationData, environment) {
  const carrier = addEnvironmentTextureCarrier(root, environment);
  const geometryTransformStates = [];
  const geometryDrawRanges = new Map();
  const geometryRecipes = new Map();
  const objectColors = new Map(), materialColors = new Map();
  root.traverse((object) => {
    const colors = {};
    for (const key of ['color', 'groundColor']) if (object[key]?.isColor) colors[key] = object[key].toArray();
    if (Object.keys(colors).length) objectColors.set(object.uuid, colors);
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) {
      const properties = {}, uniforms = {};
      for (const [key, value] of Object.entries(material)) if (value?.isColor) properties[key] = value.toArray();
      for (const [key, uniform] of Object.entries(material.uniforms ?? {})) if (uniform.value?.isColor) uniforms[key] = uniform.value.toArray();
      if (Object.keys(properties).length || Object.keys(uniforms).length) materialColors.set(material.uuid, { properties, uniforms });
    }
    const geometry = object.geometry;
    if (!geometry) return;
    if (geometry.userData?.godotGeometryRecipe) geometryRecipes.set(geometry.uuid, geometry.userData.godotGeometryRecipe);
    const { start, count } = geometry.drawRange;
    if (start !== 0 || count !== Infinity) {
      geometryDrawRanges.set(geometry.uuid, [start, Number.isFinite(count) ? count : null]);
    }
    if (geometry.parameters === undefined) return;
    geometryTransformStates.push([geometry, geometry._transformed, geometry.parameters, geometry.type]);
    // Built-in primitives need no vertex payload unless they carry unhandled edits.
    const recipe = geometry.userData?.godotGeometryRecipe;
    const hasUnrestoredAttributes = Object.keys(geometry.attributes).some((name) =>
      !['position', 'normal', 'uv'].includes(name) && !(name === 'color' && recipe?.colorItemSize === geometry.getAttribute('color')?.itemSize));
    const hasMorphAttributes = Object.keys(geometry.morphAttributes).length > 0;
    geometry._transformed = !hasUnrestoredAttributes && !hasMorphAttributes && (recipe || geometry._transformed !== true) ? false : true;
    // Three.js r180 ignores _transformed and serializes primitives by parameters.
    // Serialize edited primitives as buffers so every custom attribute survives.
    if (geometry._transformed) {
      delete geometry.parameters;
      geometry.type = 'BufferGeometry';
    }
  });
  let data;
  try { data = root.toJSON(); }
  finally {
    for (const [geometry, transformed, parameters, type] of geometryTransformStates) {
      if (transformed === undefined) delete geometry._transformed;
      else geometry._transformed = transformed;
      geometry.parameters = parameters;
      geometry.type = type;
    }
    if (carrier) {
      root.remove(carrier);
      for (const child of carrier.children) { child.geometry.dispose(); child.material.dispose(); }
    }
  }
  const audioUuids = new Set();
  const isAudio = (object) => /^AudioStreamPlayer(?:2D|3D)?$/.test(object?.name ?? '') || /^AudioStreamPlayer(?:2D|3D)?$/.test(object?.type ?? '');
  const prune = (object) => {
    if (!object) return;
    object.children = (object.children ?? []).filter((child) => {
      if (isAudio(child)) { if (child.uuid) audioUuids.add(child.uuid); return false; }
      prune(child);
      return true;
    });
    const userData = object.userData;
    const keep = {};
    if (objectColors.has(object.uuid)) keep.godotLinearColors = objectColors.get(object.uuid);
    if (userData?.previewGroundOffsetApplied) keep.previewGroundOffsetApplied = true;
    if (userData?.godotParticleSystem) keep.godotParticleSystem = userData.godotParticleSystem;
    if (userData?.godotDecay !== undefined) keep.godotDecay = userData.godotDecay;
    if (userData?.godotSpotDecay !== undefined) keep.godotSpotDecay = userData.godotSpotDecay;
    if (['emitting', 'volume_animation'].some((key) => object[key] !== undefined)) {
      keep.godotRuntimeProperties = Object.fromEntries(['emitting', 'volume_animation'].filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));
    }
    object.userData = Object.keys(keep).length ? keep : undefined;
  };
  prune(data.object);
  for (const animation of animationData) stripAudioTracks(animation, audioUuids);
  delete data.metadata;
  for (const geometry of data.geometries ?? []) {
    delete geometry.metadata;
    delete geometry.userData;
    delete geometry.data?.userData;
    const drawRange = geometryDrawRanges.get(geometry.uuid);
    const recipe = geometryRecipes.get(geometry.uuid);
    const userData = {};
    if (drawRange) userData.godotDrawRange = drawRange;
    // BufferGeometry already contains the converted vertices and UVs.
    // Recipes only apply to primitives reconstructed from their parameters.
    if (recipe && geometry.type !== 'BufferGeometry') userData.godotGeometryRecipe = recipe;
    if (Object.keys(userData).length) geometry.userData = userData;
  }
  for (const material of data.materials ?? []) {
    delete material.metadata;
    delete material.name;
    const depthUniforms = material.userData?.godotDepthUniforms;
    const userData = {};
    if (depthUniforms?.length) userData.godotDepthUniforms = depthUniforms;
    if (materialColors.has(material.uuid)) userData.godotLinearColors = materialColors.get(material.uuid);
    material.userData = Object.keys(userData).length ? userData : undefined;
  }
  const proceduralImages = new Map();
  for (const texture of data.textures ?? []) {
    delete texture.metadata;
    delete texture.name;
    const recipe = texture.userData?.godotNoiseTexture;
    if (recipe && texture.image) proceduralImages.set(texture.image, { encoding: 'godot-noise', godotNoiseTexture: recipe });
    const gradient = texture.userData?.godotGradientTexture;
    // Older preview bundles only stored fill/from/to; keep their baked pixels.
    if (gradient && Number.isInteger(gradient.width) && Number.isInteger(gradient.height)
      && Array.isArray(gradient.offsets) && gradient.offsets.length
      && Array.isArray(gradient.colors) && gradient.colors.length) {
      proceduralImages.set(texture.image, { encoding: 'godot-gradient', godotGradientTexture: gradient });
    }
    delete texture.userData;
  }
  for (const image of data.images ?? []) {
    delete image.metadata;
    const recipe = proceduralImages.get(image.uuid);
    if (!recipe) continue;
    const sources = Array.isArray(image.url) ? image.url : [image.url];
    for (const source of sources) {
      if (!source || !Array.isArray(source.data)) continue;
      delete source.data;
      Object.assign(source, recipe);
    }
  }
  compactMeshData(data);
  return data;
}

function addEnvironmentTextureCarrier(root, environment) {
  if (!environment) return null;
  const carrier = new THREE.Group();
  carrier.name = '__godotEnvironmentTextureCarrier';
  const addTexture = (role, texture) => {
    if (!texture?.isTexture) return;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture }));
    mesh.name = `__godotEnvironment_${role}`;
    mesh.visible = false;
    carrier.add(mesh);
  };
  addTexture('background', environment.background);
  addTexture('environment', environment.environment);
  if (!carrier.children.length) return null;
  root.add(carrier);
  return carrier;
}

function serializePreviewEnvironment(environment) {
  if (!environment) return null;
  const background = environment.background;
  return {
    backgroundType: background?.isTexture ? 'texture' : background?.isColor ? 'color' : 'none',
    backgroundColor: background?.isColor ? background.toArray() : null,
    hasEnvironmentTexture: Boolean(environment.environment?.isTexture),
    skyRotation: environment.skyRotation?.toArray() ?? [0, 0, 0, 'YXZ'],
    skyEnergy: environment.skyEnergy ?? 1,
    exposure: environment.exposure ?? 1,
    glow: Boolean(environment.glow),
    glowBloom: environment.glowBloom ?? 0.2,
    fogDensity: environment.fogDensity ?? 0,
    volumetricDensity: environment.volumetricDensity ?? 0,
    fogSkyAffect: environment.fogSkyAffect ?? 0,
    fogColor: environment.fog?.color?.toArray() ?? [0, 0, 0],
    hasFog: Boolean(environment.fog),
    ambientColor: environment.ambientColor?.toArray() ?? [0.15, 0.15, 0.15],
  };
}

function stripAudioTracks(animation, audioUuids) {
  animation.tracks = (animation.tracks ?? []).filter((track) => {
    const name = String(track.name ?? '');
    const targetUuid = name.match(/^([0-9a-f-]{36})\./i)?.[1];
    return !audioUuids.has(targetUuid) && !/(?:^|[/.])AudioStreamPlayer(?:2D|3D)?(?=[:/.]|$)/i.test(name);
  });
  return animation;
}

function compactMeshData(data) {
  for (const geometry of data.geometries ?? []) {
    const buffers = [...Object.values(geometry.data?.attributes ?? {}), geometry.data?.index].filter(Boolean);
    for (const buffer of buffers) {
      if (!Array.isArray(buffer.array) || !buffer.type) continue;
      buffer.array = typedArrayToBase64(buffer.type, buffer.array);
      buffer.encoding = 'base64';
    }
  }
  for (const image of data.images ?? []) {
    const sources = Array.isArray(image.url) ? image.url : [image.url];
    for (const source of sources) {
      if (!Array.isArray(source?.data) || !source.type) continue;
      source.data = typedArrayToBase64(source.type, source.data);
      source.encoding = 'base64';
    }
  }
}

function typedArrayToBase64(type, values) {
  const Constructor = globalThis[type];
  if (typeof Constructor !== 'function') throw new Error(`未対応の頂点データ型です: ${type}`);
  const typed = new Constructor(values);
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function collectWebGPUShaderFactories(scene) {
  let Transpiler, GLSLDecoder, TSLEncoder;
  try {
    [{ default: Transpiler }, { default: GLSLDecoder }, { default: TSLEncoder }] = await Promise.all([
      import('three/addons/transpiler/Transpiler.js'),
      import('three/addons/transpiler/GLSLDecoder.js'),
      import('three/addons/transpiler/TSLEncoder.js'),
    ]);
  } catch (error) {
    throw new Error(`three.js の GLSL→TSL 変換器を読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
  const factories = {};
  const materialKeys = {};
  const sourceKeys = new Map();
  scene.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const material of materials) {
      if (!material.isShaderMaterial) continue;
      try {
        const shaderSource = `${material.vertexShader}\u0000${material.fragmentShader}`;
        let key = sourceKeys.get(shaderSource);
        if (!key) {
          key = `shader_${sourceKeys.size}`;
          sourceKeys.set(shaderSource, key);
          factories[key] = {
            vertex: transpileShaderFactory(material.vertexShader, 'vertex', material.name, Transpiler, GLSLDecoder, TSLEncoder),
            fragment: transpileShaderFactory(material.fragmentShader, 'fragment', material.name, Transpiler, GLSLDecoder, TSLEncoder),
          };
        }
        materialKeys[material.uuid] = key;
      } catch (error) {
        throw new Error(`WebGPU 変換: ShaderMaterial「${material.name || material.uuid}」を TSL に変換できませんでした。${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  return { factories, materialKeys };
}

function transpileShaderFactory(source, stage, materialName, Transpiler, GLSLDecoder, TSLEncoder) {
  if (/\b[A-Za-z_]\w*\s*\[\s*[A-Za-z_]\w*\s*\]/.test(source)) {
    throw new Error('動的な GLSL 配列アクセスは現在の three.js GLSL→TSL 変換器で安全に変換できません');
  }
  let shader = source
    .replace(/^\s*#.*$/gm, '')
    .replace(/^\s*precision\s+\w+\s+\w+\s*;\s*$/gm, '')
    .replace(/^\s*attribute\s+\w+\s+\w+\s*;\s*$/gm, '')
    .replace(/\bprojectionMatrix\b/g, 'cameraProjectionMatrix')
    .replace(/\bnormalMatrix\b/g, 'modelNormalMatrix')
    .replace(/\bviewMatrix\b/g, 'cameraViewMatrix')
    .replace(/\bmodelMatrix\b/g, 'modelWorldMatrix')
    .replace(/\bposition\b/g, 'positionGeometry')
    .replace(/\bnormal\b/g, 'normalGeometry');
  shader = shader.replace(/void\s+main\s*\(\s*(?:void)?\s*\)/, 'vec4 main()');
  const outputName = stage === 'vertex' ? 'gl_Position' : 'gl_FragColor';
  const outputPattern = new RegExp(`\\b${outputName}\\s*=\\s*([\\s\\S]*?);`);
  if (!outputPattern.test(shader)) throw new Error(`${materialName || 'shader'} の ${outputName} 出力が見つかりません`);
  shader = shader.replace(outputPattern, 'return $1;');

  const encoder = new TSLEncoder();
  encoder.reference = true;
  encoder.iife = true;
  const emitted = new Transpiler(new GLSLDecoder(), encoder).parse(shader);
  const expression = emitted.replace(/^\/\/ Three\.js Transpiler[^\n]*\n/, '').trim();
  return expression.endsWith(';') ? expression.slice(0, -1) : expression;
}

function compactWebGPUShaderKeys(data) {
  const keys = data.shaderKeys ?? {};
  const compacted = {};
  for (const material of data.sceneData.materials ?? []) {
    if (keys[material.uuid] !== undefined) compacted[material.uuid] = keys[material.uuid];
  }
  return compacted;
}

function encodeDataKeys(value) {
  const counts = new Map(), sourceKeys = new Set();
  const scan = (node) => {
    if (Array.isArray(node)) { for (const item of node) scan(item); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      sourceKeys.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      scan(child);
    }
  };
  scan(value);

  const candidates = [...counts].filter(([key, count]) => count > 1 && JSON.stringify(key).length > 3)
    .sort((a, b) => b[1] * JSON.stringify(b[0]).length - a[1] * JSON.stringify(a[0]).length);
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const used = new Set(), keyMap = Object.create(null), tokens = new Map();
  let tokenIndex = 0;
  for (const [key, count] of candidates) {
    let token;
    do {
      token = tokenIndex < alphabet.length ? alphabet[tokenIndex] : `~${(tokenIndex - alphabet.length).toString(36)}`;
      tokenIndex++;
    } while (sourceKeys.has(token) || used.has(token));
    const savings = count * (JSON.stringify(key).length - JSON.stringify(token).length);
    const dictionaryCost = JSON.stringify(token).length + JSON.stringify(key).length + 2;
    if (savings <= dictionaryCost) continue;
    used.add(token);
    keyMap[token] = key;
    tokens.set(key, token);
  }

  const encode = (node) => {
    if (Array.isArray(node)) return node.map(encode);
    if (!node || typeof node !== 'object') return node;
    const result = {};
    for (const [key, child] of Object.entries(node)) {
      Object.defineProperty(result, tokens.get(key) ?? key, {
        value: encode(child), enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  };
  return { data: encode(value), keyMap };
}

function compressDataText(text) {
  const input = new TextEncoder().encode(text);
  const previous = new Int32Array(input.length);
  previous.fill(-1);
  const heads = new Map(), output = [];
  let position = 0;
  while (position < input.length) {
    const controlIndex = output.length;
    output.push(0);
    let control = 0;
    for (let bit = 0; bit < 8 && position < input.length; bit++) {
      let bestLength = 0, bestDistance = 0;
      if (position + 2 < input.length) {
        const key = input[position] * 65536 + input[position + 1] * 256 + input[position + 2];
        let candidate = heads.get(key) ?? -1, checked = 0;
        while (candidate >= 0 && position - candidate <= 65536 && checked++ < 64) {
          let length = 3;
          while (length < 258 && position + length < input.length && input[candidate + length] === input[position + length]) length++;
          if (length > bestLength) {
            bestLength = length;
            bestDistance = position - candidate;
            if (length === 258) break;
          }
          candidate = previous[candidate];
        }
      }
      let consumed = 1;
      if (bestLength >= 4) {
        control |= 1 << bit;
        const distance = bestDistance - 1;
        output.push(distance >> 8, distance & 255, bestLength - 3);
        consumed = bestLength;
      } else output.push(input[position]);

      const end = position + consumed;
      for (; position < end; position++) {
        if (position + 2 >= input.length) continue;
        const key = input[position] * 65536 + input[position + 1] * 256 + input[position + 2];
        previous[position] = heads.get(key) ?? -1;
        heads.set(key, position);
      }
    }
    output[controlIndex] = control;
  }

  const bytes = new Uint8Array(output);
  const alphabet = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33))
    .filter((character) => character !== '"' && character !== '\\').slice(0, 85).join('');
  const encoded = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let value = bytes[offset] * 16777216 + (bytes[offset + 1] ?? 0) * 65536
      + (bytes[offset + 2] ?? 0) * 256 + (bytes[offset + 3] ?? 0);
    const digits = new Array(5);
    for (let index = 4; index >= 0; index--) {
      digits[index] = alphabet[value % 85];
      value = Math.floor(value / 85);
    }
    encoded.push(digits.join(''));
  }
  return `${bytes.length}:${encoded.join('')}`;
}

function renderClassSource(data) {
  const webgpu = data.target === 'webgpu';
  const materials = data.sceneData.materials ?? [];
  const shaderMaterials = materials.filter((material) => material.type === 'ShaderMaterial');
  const hasParticleSystems = Boolean(data.particleData?.systems?.length);
  const hasGeometryDrawRanges = (data.sceneData.geometries ?? []).some((geometry) => geometry.userData?.godotDrawRange);
  const hasGeometryRecipes = (data.sceneData.geometries ?? []).some((geometry) => geometry.userData?.godotGeometryRecipe);
  const hasShaderUniformArrays = shaderMaterials.some((material) => /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(?:vec[234]|mat[34])\s+\w+\s*\[\s*\d+\s*\]/.test(`${material.vertexShader ?? ''}\n${material.fragmentShader ?? ''}`));
  const hasAnimationMaterialAliases = (data.animationData ?? []).some((clip) => (clip.tracks ?? []).some((track) => String(track.name ?? '').includes('godotUniform_')));
  const hasShaderTime = shaderMaterials.some((material) => (material.uniforms ?? material.userData?.godotShaderUniforms)?.u_time);
  const hasShaderLights = shaderMaterials.some((material) => (material.uniforms ?? material.userData?.godotShaderUniforms)?.u_lightCount);
  const shaderSources = [];
  const shaderSourceIndexes = new Map();
  const internShader = (source) => {
    let index = shaderSourceIndexes.get(source);
    if (index === undefined) { index = shaderSources.length; shaderSourceIndexes.set(source, index); shaderSources.push(source); }
    return index;
  };
  for (const material of materials) {
    if (material.type !== 'ShaderMaterial') continue;
    material.vertexShaderIndex = internShader(material.vertexShader);
    material.fragmentShaderIndex = internShader(material.fragmentShader);
    delete material.vertexShader;
    delete material.fragmentShader;
  }
  const hasWebGPUShaders = webgpu && shaderMaterials.length > 0;
  const particleData = data.particleData ?? { systems: [] };
  const animationData = data.animationData ?? [];
  const playbackData = data.playbackData ?? [];
  const shaderFactories = hasWebGPUShaders ? renderShaderFactories(data.shaderFactories) : '{}';
  const shaderKeys = hasWebGPUShaders ? JSON.stringify(compactWebGPUShaderKeys(data)) : '{}';
  const packed = encodeDataKeys({
    sceneData: data.sceneData,
    animationData,
    playbackData,
    particleData,
    shaderSources,
    environmentData: data.environmentData ?? null,
  });
  const packedJson = JSON.stringify(packed.data);
  const compressedData = compressDataText(packedJson);
  const packedData = compressedData.length + 6 < packedJson.length
    ? 'LZ3:' + compressedData
    : packed.data;
  const declarations = [
    'const PACKED_DATA = ' + JSON.stringify(packedData) + ';',
    'const DATA_KEY_MAP = ' + JSON.stringify(packed.keyMap) + ';',
    'const FEATURES = ' + JSON.stringify({
      particles: hasParticleSystems,
      geometryDrawRanges: hasGeometryDrawRanges,
      geometryRecipes: hasGeometryRecipes,
      shaderUniformArrays: hasShaderUniformArrays,
      animationMaterialAliases: hasAnimationMaterialAliases,
      shaderTime: hasShaderTime,
      shaderLights: hasShaderLights,
    }) + ';',
  ];
  const imports = [
    "import { AbstractVFXMesh } from './AbstractVFXMesh.min.js';",
    webgpu ? "import * as THREE from 'three/webgpu';" : '',
    hasWebGPUShaders ? "import * as TSL from 'three/tsl';" : '',
  ].filter(Boolean).join('\n');
  const config = [
    '  ...AbstractVFXMesh.decodeDataKeys(PACKED_DATA, DATA_KEY_MAP)',
    '  name: ' + JSON.stringify(data.effect.name || data.className),
    '  target: ' + JSON.stringify(data.target),
    '  webgpuShaderFactories: ' + shaderFactories,
    '  webgpuMaterialShaderKeys: ' + shaderKeys,
    '  features: FEATURES',
    '  TSL: ' + (hasWebGPUShaders ? 'TSL' : 'undefined'),
    '  THREE: ' + (webgpu ? 'THREE' : 'undefined'),
  ].join(',\n');
  return [
    imports,
    '',
    ...declarations,
    'const CONFIG = {\n' + config + '\n};',
    'export class ' + data.className + ' extends AbstractVFXMesh {',
    '  static rendererTarget = ' + JSON.stringify(webgpu ? 'WebGPURenderer' : 'WebGLRenderer') + ';',
    '  static previewId = ' + JSON.stringify(data.effect.id || '') + ';',
    '  static previewRootPositionAnimated = ' + JSON.stringify(data.previewRootPositionAnimated) + ';',
    '  static config = CONFIG;',
    '}',
    'export default ' + data.className + ';',
    '',
  ].join('\n');
}

function renderShaderFactories(factories) {
  const rows = Object.entries(factories).map(([uuid, factory]) => `${JSON.stringify(uuid)}: { vertex: ${factory.vertex}, fragment: ${factory.fragment} }`);
  return `{ ${rows.join(',\n  ')} }`;
}


function toClassName(value) {
  const words = String(value || 'GodotVFX').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('') || 'GodotVFX';
  const fxName = /^\d/.test(name) ? `VFX${name}` : name.endsWith('FX') ? name : `${name}FX`;
  return fxName.endsWith('Mesh') ? fxName : `${fxName}Mesh`;
}

function safeFileName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'godot-vfx';
}


