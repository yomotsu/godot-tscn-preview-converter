import { GodotAudioController } from './customization/GodotAudioController.js';
import { GodotCustomization } from './customization/GodotCustomization.js';
import {
  AnimationClip, Color, DataTexture, DirectionalLight, Float32BufferAttribute, Group, InterpolateDiscrete, Matrix4, Mesh,
  MeshBasicMaterial, NumberKeyframeTrack, Object3D, PerspectiveCamera, PlaneGeometry, PointLight, ShaderMaterial,
  SpotLight, SRGBColorSpace, Texture, Vector2, Vector3, Vector4, type BufferGeometry, type Material, type MinificationTextureFilter,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { GodotEnvironmentConverter, type GodotEnvironmentSettings } from './converters/GodotEnvironmentConverter.js';
import { GodotParticleConverter, type GodotParticleRuntimeData } from './converters/GodotParticleConverter.js';
import { GodotCurveConverter } from './converters/GodotCurveConverter.js';
import { GodotAnimationConverter } from './converters/GodotAnimationConverter.js';
import { GodotMaterialConverter } from './converters/GodotMaterialConverter.js';
import { GodotMeshConverter } from './converters/GodotMeshConverter.js';
import { GodotTextureConverter } from './converters/GodotTextureConverter.js';
import { GodotResourceResolver, type GodotResourceResolverOptions } from './resources/GodotResourceResolver.js';
import { isGodotCall, TSCNParseError, type GodotResourceSection, type GodotValue, type ParsedTSCN, type TSCNNodeSection } from './tscn/types.js';
import { TSCNParser } from './tscn/TSCNParser.js';

export interface TSCNLoaderOptions extends GodotResourceResolverOptions {
  /** Emit warnings to console as well as returning them from each load result. */
  logWarnings?: boolean;
}

export interface TSCNLoaderResult {
  scene: Group;
  customization: GodotCustomization;
  audio: GodotAudioController;
  animations: AnimationClip[];
  resources: Map<string, unknown>;
  warnings: string[];
  environment?: GodotEnvironmentSettings;
  /** Serializable particle inputs for exporters that reproduce the preview simulation. */
  particleRuntimeData: GodotParticleRuntimeData;
  /** Updates shader TIME and the CPU particle approximations in this scene. */
  updateTime(timeSeconds: number): void;
}

interface Accumulator { warnings: string[]; resources: Map<string, unknown>; animations: AnimationClip[] }
interface SceneContext { parsed: ParsedTSCN; url: string; stack: string[]; accumulator: Accumulator; subCache: Map<string, Promise<unknown>>; externals: Map<string, GodotResourceSection> }
interface LoadedScene { kind: 'scene'; scene: Group; animations: AnimationClip[] }
interface LoadedGltf { kind: 'gltf'; scene: Object3D; animations: AnimationClip[] }
interface SpellSheetEntry {
  name: string; file: string; frames: number; fps: number; loop: boolean; columns: number; rows: number;
  cell?: Record<string, number[]>;
}
/** Loads Godot 4 text scenes directly into a three.js scene graph. */
export class TSCNLoader {
  readonly resourceResolver: GodotResourceResolver;
  private readonly parser = new TSCNParser();
  private readonly meshConverter = new GodotMeshConverter();
  private readonly materialConverter = new GodotMaterialConverter();
  private readonly environmentConverter = new GodotEnvironmentConverter();
  private readonly particleConverter = new GodotParticleConverter();
  private readonly curveConverter = new GodotCurveConverter();
  private readonly textureConverter = new GodotTextureConverter();
  private readonly animationConverter = new GodotAnimationConverter();
  private readonly gltfLoader = new GLTFLoader();
  private readonly externalCache = new Map<string, Promise<unknown>>();
  private readonly sceneTextCache = new Map<string, Promise<string>>();
  private readonly liveResults = new Set<(timeSeconds: number) => void>();
  private readonly loggedWarnings = new Set<string>();
  private readonly logWarnings: boolean;
  private elapsedTime = 0;

  constructor(options: TSCNLoaderOptions = {}) {
    this.resourceResolver = new GodotResourceResolver(options);
    this.logWarnings = options.logWarnings ?? false;
  }

  setResourcePath(path: string): this { this.resourceResolver.setResourcePath(path); return this; }
  setResourceMap(map: Record<string, string>): this { this.resourceResolver.setResourceMap(map); return this; }
  clearCache(): void { this.resourceResolver.clearCache(); this.externalCache.clear(); this.sceneTextCache.clear(); }

  async loadAsync(url: string): Promise<TSCNLoaderResult> {
    const resolvedUrl = this.resourceResolver.resolvePath(url);
    const text = await this.loadSceneText(resolvedUrl);
    return this.parseAsync(text, resolvedUrl);
  }

  async parseAsync(text: string, sceneUrl = ''): Promise<TSCNLoaderResult> {
    const parsed = this.parser.parse(text);
    const accumulator: Accumulator = { warnings: [], resources: new Map(), animations: [] };
    const url = sceneUrl ? this.resourceResolver.resolvePath(sceneUrl) : '';
    const scene = await this.buildScene(parsed, url, [url].filter(Boolean), accumulator);
    this.particleConverter.setup(scene, (message) => this.warn(accumulator, message));
    const customization = new GodotCustomization(scene);
    const audio = new GodotAudioController(scene);
    const updateTime = (timeSeconds: number) => {
      customization.apply();
      updateShaderTime(scene, timeSeconds);
      this.particleConverter.update(scene, timeSeconds);
      updateShaderLights(scene);
    };
    this.liveResults.add((time) => updateTime(time));
    return {
      scene, customization, audio, animations: accumulator.animations, resources: accumulator.resources,
      warnings: accumulator.warnings, environment: GodotEnvironmentConverter.find(scene),
      particleRuntimeData: this.particleConverter.exportRuntimeData(scene), updateTime,
    };
  }

  /** Update shaders and particle previews for every scene loaded through this loader. */
  updateTime(timeSeconds: number): void {
    for (const update of this.liveResults) update(timeSeconds);
  }

  /** Advance shader time and particle previews by delta seconds. */
  update(deltaSeconds: number): void {
    this.elapsedTime += deltaSeconds;
    this.updateTime(this.elapsedTime);
  }

  private async buildScene(parsed: ParsedTSCN, url: string, stack: string[], accumulator: Accumulator): Promise<Group> {
    const context: SceneContext = {
      parsed, url, stack, accumulator,
      subCache: new Map(),
      externals: new Map(parsed.externalResources.map((resource) => [resource.id, resource])),
    };
    for (const ext of parsed.externalResources) {
      if (ext.resourceType === 'Script' && !isSupportedPreviewScript(stringValue(ext.attributes.path))) this.warn(accumulator, `GDScript '${String(ext.attributes.path ?? ext.id)}' is not executed`);
    }

    const rootNode = parsed.nodes.find((node) => node.parent === '.' || node.parent === '') ?? parsed.nodes[0];
    const objects = new Map<TSCNNodeSection, Object3D>();
    const paths = new Map<string, Object3D>();
    for (const node of parsed.nodes) {
      const object = await this.createNode(node, context);
      object.name = node.name;
      this.applyNodeProperties(object, node);
      objects.set(node, object);
      paths.set(nodePathFrom(node), object);
    }

    const root = objects.get(rootNode) as Group;
    for (const node of parsed.nodes) {
      if (node === rootNode) continue;
      const object = objects.get(node) as Object3D;
      const parent = node.parent === '.' ? root : paths.get(node.parent);
      if (parent) parent.add(object);
      else {
        this.warn(accumulator, `Node '${node.name}' has missing parent path '${node.parent}'; attached it to the scene root`);
        root.add(object);
      }
    }

    await this.applyBinbunController(root, parsed, context);
    await this.applyAdditionalControllers(root, parsed, context);
    await this.applySpellFxDemo(root, parsed, context);
    await this.applyReebooDemo(root, parsed, context);
    const convertedAnimations = this.animationConverter.convert(parsed, root.name, root);
    for (const warning of convertedAnimations.warnings) this.warn(accumulator, warning);
    accumulator.animations.push(...convertedAnimations.animations);
    return root;
  }

  private async createNode(node: TSCNNodeSection, context: SceneContext): Promise<Object3D> {
    const p = node.properties;
    const sceneReference = node.attributes.instance ?? p.instance;
    if (sceneReference) {
      const instance = await this.resolveValue(sceneReference, context);
      if (isLoadedScene(instance)) {
        return instance.scene;
      }
      if (isLoadedGltf(instance)) {
        context.accumulator.animations.push(...instance.animations);
        return cloneSkinnedScene(instance.scene);
      }
      this.warn(context.accumulator, `Node '${node.name}' has an unresolved scene instance; created an empty group`);
      return new Group();
    }

    switch (node.nodeType) {
      case 'Node3D':
      case 'Node2D': return new Group();
      case 'StaticBody3D':
      case 'CollisionShape3D': {
        const object = new Group();
        object.userData.godotNodeType=node.nodeType;
        object.userData.godotPhysicsEnabled=false;
        return object;
      }
      case 'MeshInstance3D': return this.createMeshInstance(node, context);
      case 'Camera3D': {
        const camera = new PerspectiveCamera(75, 1, 0.05, 4000);
        camera.fov = number(p.fov, 75);
        camera.near = Math.max(0.001, number(p.near, 0.05));
        camera.far = Math.max(camera.near + 0.001, number(p.far, 4000));
        camera.updateProjectionMatrix();
        return camera;
      }
      case 'DirectionalLight3D': return this.createDirectionalLight(node);
      case 'OmniLight3D': return this.createPointLight(node);
      case 'SpotLight3D': return this.createSpotLight(node);
      case 'GPUParticles3D': return this.particleConverter.convert(node,(value)=>this.resolveValue(value,context),(message)=>this.warn(context.accumulator,message));
      case 'AnimationPlayer': return new Group();
      case 'WorldEnvironment': {
        const environment=p.environment?await this.resolveValue(p.environment,context):undefined;
        if(isResourceSection(environment))return this.environmentConverter.convert(environment,value=>this.resolveValue(value,context),message=>this.warn(context.accumulator,`Node '${node.name}': ${message}`));
        this.warn(context.accumulator,`WorldEnvironment '${node.name}' has no resolved Environment resource`);
        return new Group();
      }
      case 'AudioStreamPlayer3D': {
        const audio = new Group() as Group & {playing:boolean};
        audio.playing = Boolean(p.autoplay);
        audio.userData.godotAudio={...p};
        // Empty AudioStreamPlayer3D nodes have no audible runtime behavior.
        if (p.stream) this.warn(context.accumulator, `AudioStreamPlayer3D '${node.name}' has a stream; original stream playback requires explicit audio setup; use result.audio.setAudio()`);
        return audio;
      }
      default:
        this.warn(context.accumulator, `Node '${node.name}' uses unsupported type '${node.nodeType || '(instance)'}'; represented as a Group`);
        return new Group();
    }
  }

  private async createMeshInstance(node: TSCNNodeSection, context: SceneContext): Promise<Object3D> {
    const meshValue = node.properties.mesh;
    const source = meshValue ? await this.resolveValue(meshValue, context) : undefined;
    const materialValue = node.properties.material_override ?? node.properties['surface_material_override/0'];
    const material = materialValue ? await this.resolveValue(materialValue, context) : undefined;
    if (isBufferGeometry(source)) {
      ensureColorAttribute(source);
      const object = new Mesh(source, isMaterial(material) ? material : undefined);
      object.castShadow = Boolean(node.properties.cast_shadow);
      object.receiveShadow = Boolean(node.properties.receive_shadow);
      return object;
    }
    if (isLoadedGltf(source)) {
      context.accumulator.animations.push(...source.animations);
      const scene = cloneSkinnedScene(source.scene);
      scene.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        ensureColorAttribute(mesh.geometry);
        if (isMaterial(material)) mesh.material = material;
      });
      return scene;
    }
    if (source instanceof Object3D) {
      const instance = source.clone(true);
      instance.traverse(child => {
        if (!(child instanceof Mesh)) return;
        ensureColorAttribute(child.geometry);
        if (isMaterial(material)) child.material = material;
      });
      return instance;
    }
    if (node.name === 'Chest' && context.parsed.nodes.some((candidate) => candidate.name === 'VFXStatusShatter')) {
      // StatusFX's combined showcase serializes its character ArrayMesh as a
      // binary PackedByteArray; use the package's matching skinned GLB instead.
      const modelUrl = this.resourceResolver.resolvePath('res://assets/BinbunVFX_Vol2/shared/guy/guy.glb', context.url);
      const model = await this.loadGltf(modelUrl, 'glb');
      context.accumulator.animations.push(...model.animations);
      const scene = cloneSkinnedScene(model.scene);
      if (isMaterial(material)) scene.traverse((child) => {
        const mesh = child as Mesh;
        if (mesh.isMesh) mesh.material = material;
      });
      return scene;
    }
    this.warn(context.accumulator, `MeshInstance3D '${node.name}' has no supported mesh resource`);
    return new Group();
  }

  private createDirectionalLight(node: TSCNNodeSection): DirectionalLight {
    const p = node.properties;
    const light = new DirectionalLight(color(p.light_color), number(p.light_energy, 1));
    light.target.position.set(0,0,-1);
    light.add(light.target);
    light.castShadow = Boolean(p.shadow_enabled);
    return light;
  }

  private createPointLight(node: TSCNNodeSection): PointLight {
    const p = node.properties;
    const baseEnergy = number(p.base_energy, number(p.vfx_light_energy, number(p.light_energy, 1)));
    const multiplier = number(p.light_multiplier, number(p.light_mult, 1));
    const light = new PointLight(color(p.light_color), baseEnergy * multiplier, number(p.omni_range, 5));
    light.userData.godotBaseEnergy = baseEnergy;
    light.userData.godotLightMultiplier = multiplier;
    light.decay=light.userData.godotDecay=number(p.omni_attenuation,1);
    light.castShadow = Boolean(p.shadow_enabled);
    return light;
  }

  private createSpotLight(node: TSCNNodeSection): SpotLight {
    const p = node.properties;
    const light = new SpotLight(color(p.light_color), number(p.light_energy, 1), number(p.spot_range, 5), number(p.spot_angle, 45) * Math.PI / 180);
    light.target.position.set(0,0,-1);
    light.add(light.target);
    light.decay=light.userData.godotDecay=number(p.spot_attenuation,1);
    light.userData.godotSpotDecay=1/Math.max(number(p.spot_angle_attenuation,1),.0001);
    light.castShadow = Boolean(p.shadow_enabled);
    return light;
  }

  /** Adapters for the supported Binbun effect scripts, based on their exported setters. */
  private async applyBinbunController(root: Object3D, parsed: ParsedTSCN, context: SceneContext): Promise<void> {
    for (const node of parsed.nodes) {
      const script = node.properties.script;
      const path = isGodotCall(script) ? stringValue(context.externals.get(stringValue(script.args[0]))?.attributes.path) : '';
      const controller = root.getObjectByName(node.name);
      if (!controller || (!isBinbunEffectScript(path) && !controller.userData.godotEffectController)) continue;
      controller.userData.godotEffectController=true;
      (controller as Object3D & {volume_animation:number}).volume_animation=number(node.properties.volume_animation,1);
      for (const object of controller.children) {
        const material = (object as Mesh).material;
        if (!(material instanceof ShaderMaterial)) continue;
        for (const [key,value] of Object.entries(node.properties)) {
          const uniformKey = path.endsWith('/loot_effects/src/script/vfx_loot.gd') && key === 'shine_direction' ? 'detail_direction'
            : isHitImpactController(path) && key === 'emission' ? 'emission_mult'
              : isHitImpactController(path) && key === 'flash_pinch' ? 'pinch_amount'
                : isHitImpactController(path) && key === 'flash_noise_scale' ? 'noise_scale' : key;
          if (!material.uniforms[uniformKey]) continue;
          const resolved = await this.resolveValue(value,context);
          if (isGodotCall(value) && value.name === 'Color') {
            material.uniforms[uniformKey].value = color(value).convertSRGBToLinear();
          } else if (isGodotCall(value) && value.name === 'Vector2') {
            (material.uniforms[uniformKey].value as {set(x:number,y:number):void}).set(Number(value.args[0]),Number(value.args[1]));
          } else material.uniforms[uniformKey].value = resolved;
          if (key === 'particle_texture' && material.uniforms.use_texture) material.uniforms.use_texture.value = Boolean(resolved);
        }
      }
      if (isElementalAreaController(path)) {
        const particles = controller.getObjectByName('Particles');
        if (particles) this.particleConverter.applyElementalAreaProperties(particles, {
          amount: number(node.properties.particles_amount, 64),
          lifetime: number(node.properties.lifetime, 1),
          explosiveness: number(node.properties.explosiveness, 0),
          emitting: typeof node.properties.emitting === 'boolean' ? node.properties.emitting : true,
          ringRadius: number(node.properties.area_radius, 1.4),
        });
        const areaRadius = node.properties.area_radius;
        if (typeof areaRadius === 'number') this.resizeElementalArea(controller, parsed, areaRadius);
      }
      if (isElementalProjectileController(path)) {
        const particles = controller.getObjectByName('Sparks');
        if (particles) {
          const particleProperties: { amount?: number; lifetime?: number; explosiveness?: number; emitting?: boolean } = {};
          if (typeof node.properties.particles_amount === 'number') particleProperties.amount = node.properties.particles_amount;
          if (typeof node.properties.lifetime === 'number') particleProperties.lifetime = node.properties.lifetime;
          if (typeof node.properties.explosiveness === 'number') particleProperties.explosiveness = node.properties.explosiveness;
          if (typeof node.properties.emitting === 'boolean') particleProperties.emitting = node.properties.emitting;
          this.particleConverter.applyElementalProjectileProperties(particles, particleProperties);
        }
        const light = controller.getObjectByName('OmniLight3D');
        if (light instanceof PointLight) {
          if (node.properties.light_color) light.color.copy(color(node.properties.light_color).convertSRGBToLinear());
          if (typeof node.properties.light_energy === 'number') {
            light.userData.godotBaseEnergy = node.properties.light_energy;
            light.intensity = node.properties.light_energy * Number(light.userData.godotLightMultiplier ?? 1);
          }
        }
      }
      if (path.endsWith('/loot_effects/src/script/vfx_loot.gd')) {
        for (const child of controller.children) {
          this.particleConverter.applyLootProperties(child, node.properties);
          if (child instanceof PointLight) {
            if (node.properties.light_color) child.color.copy(color(node.properties.light_color).convertSRGBToLinear());
            if (typeof node.properties.light_energy === 'number') child.intensity = node.properties.light_energy;
          }
        }
      }
      if (isHitImpactController(path) && typeof node.properties.hide_core === 'boolean') {
        for (const name of ['ImpactSphere', 'HitCore']) {
          const core = controller.getObjectByName(name);
          if (core) core.visible = !node.properties.hide_core;
        }
      }
      if (node.properties.light_color || typeof node.properties.light_energy === 'number') {
        const effectLight = controller.getObjectByName('VFXOmniLightBB');
        if (effectLight instanceof PointLight) {
          if (node.properties.light_color) effectLight.color.copy(color(node.properties.light_color).convertSRGBToLinear());
          if (typeof node.properties.light_energy === 'number') {
            const multiplier = Number(effectLight.userData.godotLightMultiplier ?? 1);
            effectLight.userData.godotBaseEnergy = node.properties.light_energy;
            effectLight.intensity = node.properties.light_energy * multiplier;
          }
        }
      }
      const audioNode=controller.getObjectByName('AudioStreamPlayer3D');
      if(audioNode?.userData.godotAudio){for(const key of ['volume_db','pitch_scale','unit_size','attenuation_model'])if(node.properties[key]!==undefined)audioNode.userData.godotAudio[key]=node.properties[key];if(node.properties.audio_max_distance!==undefined)audioNode.userData.godotAudio.max_distance=node.properties.audio_max_distance;}
      const smoke = controller.getObjectByName('Smoke');
      if (smoke && typeof node.properties.smoke_amount === 'number') this.particleConverter.setAmount(smoke,node.properties.smoke_amount);
      const light = controller.getObjectByName('VFXOmniLightBB') as PointLight | undefined;
      if (light && node.properties.light_color) light.color.copy(color(node.properties.light_color).convertSRGBToLinear());
    }
  }

  /** Mirror the exported area_radius setter for the meshes authored in the scene. */
  private resizeElementalArea(controller: Object3D, parsed: ParsedTSCN, radius: number): void {
    for (const childNode of parsed.nodes) {
      if (childNode.parent !== '.' || !['Ground', 'Glow_01', 'Glow_02'].includes(childNode.name)) continue;
      const meshValue = childNode.properties.mesh;
      if (!isGodotCall(meshValue) || meshValue.name !== 'SubResource') continue;
      const source = parsed.subResources.find((resource) => resource.id === stringValue(meshValue.args[0]));
      if (!source) continue;
      const properties = { ...source.properties };
      if (childNode.name === 'Ground' && source.resourceType === 'QuadMesh') {
        properties.size = { kind: 'call', name: 'Vector2', args: [radius * 3, radius * 3] };
      } else if (source.resourceType === 'CylinderMesh') {
        properties.bottom_radius = radius;
        properties.top_radius = childNode.name === 'Glow_01' ? radius + 0.2 : radius;
      } else continue;
      const geometry = this.meshConverter.convert({ ...source, properties }, () => undefined);
      const target = controller.getObjectByName(childNode.name);
      if (geometry && target instanceof Mesh) target.geometry = geometry;
    }
  }

  /** Emulate the small exported setter surfaces used by the supplied VFX packs. */
  private async applyAdditionalControllers(root: Object3D, parsed: ParsedTSCN, context: SceneContext): Promise<void> {
    for (const node of parsed.nodes) {
      const script = node.properties.script;
      const path = isGodotCall(script) ? stringValue(context.externals.get(stringValue(script.args[0]))?.attributes.path) : '';
      const controller = root.getObjectByName(node.name);
      if (!controller) continue;

      if (isMagicProjectileController(path)) {
        await this.applyMagicProjectileController(controller, node, context);
      } else if (isMagicProjectileLight(path)) {
        const light = controller as PointLight;
        if (!(light instanceof PointLight)) continue;
        const base = number(node.properties.base_energy, Number(light.userData.godotBaseEnergy ?? light.intensity));
        const multiplier = number(node.properties.light_multiplier, Number(light.userData.godotLightMultiplier ?? 1));
        light.userData.godotBaseEnergy = base;
        light.userData.godotLightMultiplier = multiplier;
        light.intensity = base * multiplier;
      } else if (isPortalController(path)) {
        await this.applyPortalController(controller, node, context);
      } else if (isReebooEffectController(path)) {
        this.applyReebooEffectController(controller, root, parsed);
      }
    }
  }

  /** Start the one-shot particle layers that REEBOO's VFXEffect.gd starts in _ready(). */
  private applyReebooEffectController(controller: Object3D, root: Object3D, parsed: ParsedTSCN): void {
    controller.userData.godotEffectController = true;
    root.traverse((object) => {
      if (!object.userData.godotParticleSystem) return;
      const node = parsed.nodes.find((candidate) => candidate.name === object.name);
      const delay = node?.properties['metadata/vfx_delay'];
      if (typeof delay === 'number' && delay > 0) object.userData.godotVfxDelay = delay;
      object.userData.godotVfxLoop = true;
      (object as Object3D & { emitting: boolean }).emitting = true;
      object.userData.godotParticleSystem.emitting = true;
    });
  }

  private async applyMagicProjectileController(controller: Object3D, node: TSCNNodeSection, context: SceneContext): Promise<void> {
    controller.userData.godotEffectController = true;
    const materials = directChildMaterials(controller);
    for (const [key, value] of Object.entries(node.properties)) {
      if (key === 'script') continue;
      const resolved = await this.resolveValue(value, context);
      for (const material of materials) {
        if (material instanceof ShaderMaterial && material.uniforms[key]) setGodotUniform(material, key, value, resolved);
      }
    }

    const light = controller.getObjectByName('Light');
    if (light instanceof PointLight) {
      if (typeof node.properties.light_enable === 'boolean') light.visible = node.properties.light_enable;
      if (node.properties.light_color) light.color.copy(color(node.properties.light_color));
      if (typeof node.properties.light_energy === 'number') {
        light.userData.godotBaseEnergy = node.properties.light_energy;
        light.intensity = node.properties.light_energy * Number(light.userData.godotLightMultiplier ?? 1);
      }
    }
  }

  private async applyPortalController(controller: Object3D, node: TSCNNodeSection, context: SceneContext): Promise<void> {
    controller.userData.godotPortalController = true;
    const meshNames = ['PortalMesh', 'GlowMesh', 'StencilMesh'];
    const meshes = meshNames.map((name) => controller.getObjectByName(name)).filter((object): object is Mesh => object instanceof Mesh);
    const parameterAliases: Record<string, string> = { depth: 'depth_amount', fade: 'fade_amount' };
    const parameters = [
      'size', 'portal_mode', 'primary_color', 'secondary_color', 'emission_strength', 'dither', 'shape_texture',
      'noise_texture', 'shape_warp', 'open_amount', 'density', 'shrink_amount', 'edge_softness', 'depth',
      'depth_mult', 'layers', 'fade', 'fade_mult', 'speed_scale', 'spin_motion', 'inward_motion', 'base_motion',
      'emitting', 'amount', 'animation_speed',
    ];
    const materials = meshes.flatMap((mesh) => Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
    const setParameter = (name: string, value: unknown, source?: GodotValue): void => {
      const uniformName = parameterAliases[name] ?? name;
      for (const material of materials) {
        if (material instanceof ShaderMaterial && material.uniforms[uniformName]) setGodotUniform(material, uniformName, source, value);
      }
      if (name === 'open_amount') {
        const amount = Math.max(0, Number(value));
        const particles = controller.getObjectByName('GPUParticles3D');
        if (particles) {
          particles.scale.set(amount, amount, 1);
          particles.visible = amount > 0;
        }
        const light = controller.getObjectByName('OmniLight3D');
        if (light instanceof PointLight) light.distance = Math.pow(amount, 0.4) * 5;
      } else if (name === 'portal_mode') {
        const stencil = controller.getObjectByName('StencilMesh');
        if (stencil) stencil.visible = Number(value) === 2;
      } else if (name === 'emitting') {
        const particles = controller.getObjectByName('GPUParticles3D');
        if (particles) (particles as Object3D & { emitting: boolean }).emitting = Boolean(value);
      } else if (name === 'amount') {
        const particles = controller.getObjectByName('GPUParticles3D');
        if (particles) this.particleConverter.setAmount(particles, Number(value));
      }
    };

    // Root properties in portal animations are setters in Godot. Mirror those
    // setters so AnimationMixer tracks update all three portal materials.
    for (const name of parameters) {
      if (Object.prototype.hasOwnProperty.call(controller, name)) continue;
      Object.defineProperty(controller, name, {
        configurable: true,
        enumerable: true,
        get: () => {
          const uniformName = parameterAliases[name] ?? name;
          for (const material of materials) if (material instanceof ShaderMaterial && material.uniforms[uniformName]) return material.uniforms[uniformName].value;
          return undefined;
        },
        set: (value: unknown) => setParameter(name, value),
      });
    }

    for (const name of parameters) {
      const value = node.properties[name];
      if (value === undefined) continue;
      const resolved = await this.resolveValue(value, context);
      setParameter(name, resolved, value);
    }
    const portalMaterial = materials.find((material) => material instanceof ShaderMaterial && material.uniforms.portal_mode) as ShaderMaterial | undefined;
    const portalMode = portalMaterial?.uniforms.portal_mode?.value;
    const stencil = controller.getObjectByName('StencilMesh');
    if (stencil && portalMode !== undefined) stencil.visible = Number(portalMode) === 2;
  }

  /** Replaces the original Node2D demo script with its supplied sprite-sheet showcase. */
  private async applySpellFxDemo(root: Object3D, parsed: ParsedTSCN, context: SceneContext): Promise<void> {
    const demo = parsed.externalResources.some((resource) =>
      resource.resourceType === 'Script' && stringValue(resource.attributes.path).endsWith('/addons/spell_fx/demo/demo.gd'));
    if (!demo) return;
    try {
      const manifestPath = this.resourceResolver.resolvePath('res://sheets/effects.json', context.url);
      const manifest = JSON.parse(await this.resourceResolver.loadText(manifestPath)) as { effects?: SpellSheetEntry[] };
      const entries = Array.isArray(manifest.effects) ? manifest.effects : [];
      const effects: { entry: SpellSheetEntry; mesh: Mesh }[] = [];
      for (const entry of entries) {
        if (!entry || !entry.file || !entry.columns || !entry.rows || !entry.frames) continue;
        const imagePath = this.resourceResolver.resolvePath(`res://sheets/256/${entry.file}`, context.url);
        const atlas = await this.resourceResolver.loadTexture(imagePath, '', true);
        const texture = atlas.clone();
        texture.colorSpace = SRGBColorSpace;
        texture.repeat.set(1 / entry.columns, 1 / entry.rows);
        texture.offset.set(0, 1 - 1 / entry.rows);
        const material = new MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.01, depthWrite: false, toneMapped: false });
        const cell = entry.cell?.['256'] ?? [256, 256];
        const width = Math.max(0.1, Number(cell[0] ?? 256) * 0.01);
        const height = Math.max(0.1, Number(cell[1] ?? 256) * 0.01);
        const mesh = new Mesh(new PlaneGeometry(width, height), material);
        mesh.name = entry.name;
        mesh.position.set((effects.length % 3 - 1) * 3.2, 2.15 - Math.floor(effects.length / 3) * 3.1, 0);
        mesh.userData.godotSpriteSheet = { columns: entry.columns, rows: entry.rows, frames: entry.frames, fps: entry.fps, loop: entry.loop };
        Object.defineProperty(mesh, 'frame', {
          configurable: true,
          get: () => Number(mesh.userData.godotFrame ?? 0),
          set: (value: number) => {
            const frame = Math.max(0, Math.min(entry.frames - 1, Math.floor(Number(value) || 0)));
            mesh.userData.godotFrame = frame;
            texture.offset.set((frame % entry.columns) / entry.columns, 1 - (Math.floor(frame / entry.columns) + 1) / entry.rows);
          },
        });
        root.add(mesh);
        effects.push({ entry, mesh });
      }
      if (!effects.length) throw new Error('The effects.json manifest has no supported sprite sheets');

      const clips = effects.map(({ entry, mesh }) => {
        const frames = Array.from({ length: entry.frames }, (_, index) => index);
        const times = frames.map((frame) => frame / Math.max(1, entry.fps));
        const track = new NumberKeyframeTrack(`${mesh.uuid}.frame`, times, frames);
        track.setInterpolation(InterpolateDiscrete);
        const clip = new AnimationClip(entry.name, times.at(-1) ?? 0, [track]);
        clip.userData.godotRootUUID = root.uuid;
        clip.userData.godotRootName = root.name;
        clip.userData.godotLoopMode = entry.loop ? 1 : 0;
        return clip;
      });
      context.accumulator.animations.push(...clips);
      root.userData.godotSpellFxDemo = effects.map(({ entry }) => entry.name);
    } catch (error) {
      this.warn(context.accumulator, `Spell FX 2D demo could not load its sprite sheets: ${messageOf(error)}`);
    }
  }

  /** REEBOO's demo root is script-built; show its first sorted effect (hit_spark) in the preview. */
  private async applyReebooDemo(root: Object3D, parsed: ParsedTSCN, context: SceneContext): Promise<void> {
    const demo = root.name === 'Demo' && parsed.externalResources.some((resource) =>
      resource.resourceType === 'Script' && stringValue(resource.attributes.path) === 'res://demo/demo.gd');
    if (!demo) return;
    try {
      const effectUrl = this.resourceResolver.resolvePath('res://addons/reeboo_vfx/effects/hit_spark.tscn', context.url);
      const effect = await this.loadPackedScene(effectUrl, context);
      effect.scene.name = 'hit_spark';
      root.add(effect.scene);
      root.userData.godotDemoScene = 'hit_spark';
    } catch (error) {
      this.warn(context.accumulator, `REEBOO demo effect could not be loaded: ${messageOf(error)}`);
    }
  }

  private applyNodeProperties(object: Object3D, node: TSCNNodeSection): void {
    const p = node.properties;
    if (p.transform) applyTransform(object, p.transform);
    if (p.basis) applyBasis(object, p.basis);
    if (p.position) object.position.copy(vector3(p.position));
    if (p.rotation) { const [x, y, z] = vector3Array(p.rotation); object.rotation.set(x, y, z, 'YXZ'); }
    if (p.rotation_degrees) { const [x, y, z] = vector3Array(p.rotation_degrees); object.rotation.set(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180, 'YXZ'); }
    if (p.quaternion && isGodotCall(p.quaternion) && p.quaternion.name === 'Quaternion') {
      const q = p.quaternion.args.map(Number);
      object.quaternion.set(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1);
    }
    if (p.scale) object.scale.copy(vector3(p.scale));
    if (typeof p.visible === 'boolean') object.visible = p.visible;
  }

  private async resolveValue(value: GodotValue, context: SceneContext, subStack: string[] = []): Promise<unknown> {
    if (isGodotCall(value)) {
      if (value.name === 'ExtResource') return this.resolveExternal(stringValue(value.args[0]), context);
      if (value.name === 'SubResource') return this.resolveSubResource(stringValue(value.args[0]), context, subStack);
      if (value.name === 'Array' || value.name.startsWith('Packed')) return Promise.all(value.args.map((item) => this.resolveValue(item, context, subStack)));
      return value;
    }
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.resolveValue(item, context, subStack)));
    if (isRecord(value)) {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) output[key] = await this.resolveValue(item, context, subStack);
      return output;
    }
    return value;
  }

  private resolveSubResource(id: string, context: SceneContext, subStack: string[]): Promise<unknown> {
    if (subStack.includes(id)) {
      this.warn(context.accumulator, `Circular SubResource reference '${[...subStack, id].join(' -> ')}' in '${context.url}'`);
      return Promise.resolve(undefined);
    }
    const existing = context.subCache.get(id);
    if (existing) return existing;
    const resource = context.parsed.subResources.find((item) => item.id === id);
    if (!resource) {
      this.warn(context.accumulator, `SubResource '${id}' was not found in '${context.url}'`);
      return Promise.resolve(undefined);
    }
    const nextStack = [...subStack, id];
    const pending = Promise.resolve().then(async () => {
      let converted: unknown;
      const geometry = this.meshConverter.convert(resource, (message) => this.warn(context.accumulator, message));
      if (geometry) converted = geometry;
      else if (resource.resourceType === 'ShaderMaterial' || resource.resourceType === 'StandardMaterial3D' || resource.resourceType === 'ORMMaterial3D') {
        converted = await this.materialConverter.convert(resource, (item) => this.resolveValue(item, context, nextStack), (message) => this.warn(context.accumulator, message));
      } else if (['CurveTexture','CurveXYZTexture','GradientTexture1D'].includes(resource.resourceType)) {
        converted = await this.curveConverter.convert(resource, (item) => this.resolveValue(item,context,nextStack));
      } else if (resource.resourceType === 'GradientTexture2D') {
        converted = await this.curveConverter.convertGradientTexture2D(resource, (item) => this.resolveValue(item,context,nextStack));
      } else if (resource.resourceType === 'NoiseTexture2D') {
        converted = await this.textureConverter.convert(resource, (item) => this.resolveValue(item, context, nextStack), (message) => this.warn(context.accumulator, message));
      } else converted = resource;
      context.accumulator.resources.set(`SubResource:${id}`, converted);
      return converted;
    });
    context.subCache.set(id, pending);
    return pending;
  }

  private resolveExternal(id: string, context: SceneContext): Promise<unknown> {
    const resource = context.externals.get(id);
    if (!resource) {
      this.warn(context.accumulator, `ExtResource '${id}' was not found in '${context.url}'`);
      return Promise.resolve(undefined);
    }
    const path = stringValue(resource.attributes.path) || stringValue(resource.attributes.uid);
    if (!path) {
      this.warn(context.accumulator, `ExtResource '${id}' has no path attribute; uid-only resources require an explicit resource map`);
      return Promise.resolve(undefined);
    }
    let url: string;
    try { url = this.resourceResolver.resolvePath(path, context.url); }
    catch (error) { this.warn(context.accumulator, `${path}: ${messageOf(error)}`); return Promise.resolve(undefined); }
    if (resource.resourceType === 'PackedScene' && context.stack.includes(url)) {
      this.warn(context.accumulator, `Cyclic scene reference detected: ${[...context.stack, url].join(' -> ')}`);
      return Promise.resolve(new Group());
    }
    if (resource.resourceType === 'Script') return Promise.resolve(undefined);
    const key = `${url}|${resource.resourceType}`;
    if (resource.resourceType !== 'PackedScene') {
      const cached = this.externalCache.get(key);
      if (cached) return cached;
    }
    const pending = this.loadExternalResource(resource.resourceType, path, url, context);
    if (resource.resourceType !== 'PackedScene') this.externalCache.set(key, pending);
    return pending;
  }

  private async loadExternalResource(type: string, path: string, url: string, context: SceneContext): Promise<unknown> {
    let result: unknown;
    const extension = path.split(/[?#]/)[0].split('.').at(-1)?.toLowerCase() ?? '';
    try {
      if (extension === 'obj') result = new OBJLoader().parse(await this.resourceResolver.loadText(url));
      else if (extension === 'tga') {
        // @types/three r180 incorrectly declares this descriptor as a DataTexture.
        const image = new TGALoader().parse(await this.resourceResolver.loadArrayBuffer(url)) as unknown as {
          data: Uint8Array; width: number; height: number;
          flipY?: boolean; generateMipmaps?: boolean; minFilter?: MinificationTextureFilter;
        };
        const texture = new DataTexture(image.data, image.width, image.height);
        texture.flipY = image.flipY ?? true;
        texture.generateMipmaps = image.generateMipmaps ?? true;
        if (image.minFilter !== undefined) texture.minFilter = image.minFilter;
        texture.needsUpdate = true;
        result = texture;
      }
      else if (extension === 'tres') result = await this.loadTres(url, context);
      else if (type === 'Shader' || extension === 'gdshader') result = await this.resourceResolver.loadShaderSource(url);
      else if (['glb', 'gltf'].includes(extension)) result = await this.loadGltf(url, extension);
      else if (type === 'PackedScene' || extension === 'tscn') result = await this.loadPackedScene(url, context);
      else if (extension === 'hdr') result = await new HDRLoader().loadAsync(url);
      else if (extension === 'exr') result = await new EXRLoader().loadAsync(url);
      else if (['Texture2D', 'Texture', 'CompressedTexture2D', 'ImageTexture', 'Texture2DArray'].includes(type) || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(extension)) {
        result = await this.resourceResolver.loadTexture(url, '', false);
      }
      else {
        this.warn(context.accumulator, `External resource '${path}' has unsupported type '${type}'`);
        result = undefined;
      }
    } catch (error) {
      this.externalCache.delete(`${url}|${type}`);
      this.warn(context.accumulator, `Failed to resolve external resource '${path}': ${messageOf(error)}`);
      result = undefined;
    }
    context.accumulator.resources.set(`ExtResource:${path}`, result);
    return result;
  }

  private async loadPackedScene(url: string, parent: SceneContext): Promise<LoadedScene> {
    const text = await this.loadSceneText(url);
    const parsed = this.parser.parse(text);
    const start = parent.accumulator.animations.length;
    const scene = await this.buildScene(parsed, url, [...parent.stack, url], parent.accumulator);
    return { kind: 'scene', scene, animations: parent.accumulator.animations.slice(start) };
  }

  private async loadTres(url: string, parent: SceneContext): Promise<unknown> {
    const text = await this.resourceResolver.loadText(url);
    const parsed = this.parser.parseResource(text);
    const type = stringValue(parsed.scene?.attributes.type);
    if (type === 'VisualShader') {
      const generatedCode = parsed.resourceProperties.code;
      if (typeof generatedCode === 'string' && generatedCode.trim()) return generatedCode;
      this.warn(parent.accumulator, `VisualShader resource '${url}' has no generated shader source; its node graph cannot be converted`);
      return undefined;
    }
    const resource: GodotResourceSection = {
      type: 'gd_resource', line: parsed.scene?.line ?? 1, attributes: parsed.scene?.attributes ?? {},
      id: url, resourceType: type, properties: parsed.resourceProperties,
    };
    const context: SceneContext = {
      parsed, url, stack: parent.stack, accumulator: parent.accumulator,
      subCache: new Map(), externals: new Map(parsed.externalResources.map((item) => [item.id, item])),
    };
    if (type === 'ShaderMaterial' || type === 'StandardMaterial3D' || type === 'ORMMaterial3D') {
      return this.materialConverter.convert(resource, (item) => this.resolveValue(item, context), (message) => this.warn(parent.accumulator, message));
    }
    if (type === 'GradientTexture2D') return this.curveConverter.convertGradientTexture2D(resource, (item) => this.resolveValue(item, context));
    if (type === 'NoiseTexture2D') return this.textureConverter.convert(resource, (item) => this.resolveValue(item, context), (message) => this.warn(parent.accumulator, message));
    const geometry = this.meshConverter.convert(resource, (message) => this.warn(parent.accumulator, message));
    return geometry ?? resource;
  }

  private async loadGltf(url: string, extension: string): Promise<LoadedGltf> {
    const source = extension === 'glb' ? await this.resourceResolver.loadArrayBuffer(url) : await this.resourceResolver.loadText(url);
    const basePath = directoryUrl(url);
    const gltf = await new Promise<LoadedGltf>((resolve, reject) => {
      this.gltfLoader.parse(source, basePath, (result) => resolve({ kind: 'gltf', scene: result.scene, animations: result.animations }), reject);
    });
    return gltf;
  }

  private loadSceneText(url: string): Promise<string> {
    let pending = this.sceneTextCache.get(url);
    if (!pending) {
      pending = this.resourceResolver.loadText(url).catch((error) => {
        this.sceneTextCache.delete(url);
        throw error;
      });
      this.sceneTextCache.set(url, pending);
    }
    return pending;
  }

  private warn(accumulator: Accumulator, message: string): void {
    accumulator.warnings.push(message);
    if (this.logWarnings && !this.loggedWarnings.has(message)) {
      this.loggedWarnings.add(message);
      console.warn(`[TSCNLoader] ${message}`);
    }
  }
}

function applyTransform(object: Object3D, value: GodotValue): void {
  if (!isGodotCall(value) || value.name !== 'Transform3D') return;
  if (value.args.length === 2) {
    applyBasis(object, value.args[0]);
    object.position.copy(vector3(value.args[1]));
  } else if (value.args.length >= 12) {
    const values = value.args.map(Number);
    const matrix = new Matrix4().set(
      values[0], values[1], values[2], values[9],
      values[3], values[4], values[5], values[10],
      values[6], values[7], values[8], values[11],
      0, 0, 0, 1,
    );
    decomposeSafe(object, matrix);
  }
}

function applyBasis(object: Object3D, value: GodotValue): void {
  if (!isGodotCall(value) || value.name !== 'Basis') return;
  let values: number[];
  if (value.args.length === 3 && value.args.every((arg) => isGodotCall(arg) && arg.name === 'Vector3')) {
    const axes = value.args.map((arg) => vector3Array(arg));
    values = [axes[0][0], axes[1][0], axes[2][0], axes[0][1], axes[1][1], axes[2][1], axes[0][2], axes[1][2], axes[2][2]];
  } else {
    const v=value.args.map(Number);
    // Godot serializes numeric Basis/Transform3D coefficients in row order.
    values=v;
  }
  if (values.length < 9) return;
  const matrix = new Matrix4().set(values[0], values[1], values[2], 0, values[3], values[4], values[5], 0, values[6], values[7], values[8], 0, 0, 0, 0, 1);
  decomposeSafe(object, matrix);
}

function decomposeSafe(object: Object3D, matrix: Matrix4): void {
  if (Math.abs(matrix.determinant()) > 1e-12) {
    matrix.decompose(object.position, object.quaternion, object.scale);
    if (![object.quaternion.x,object.quaternion.y,object.quaternion.z,object.quaternion.w].every(Number.isFinite)) object.quaternion.identity();
    return;
  }
  const elements = matrix.elements;
  object.position.set(elements[12], elements[13], elements[14]);
  object.scale.set(
    Math.hypot(elements[0], elements[1], elements[2]),
    Math.hypot(elements[4], elements[5], elements[6]),
    Math.hypot(elements[8], elements[9], elements[10]),
  );
  object.quaternion.identity();
}

function vector3(value: GodotValue): Vector3 { const [x, y, z] = vector3Array(value); return new Vector3(x, y, z); }
function vector3Array(value: GodotValue): [number, number, number] {
  if (isGodotCall(value) && value.name === 'Vector3') return [Number(value.args[0] ?? 0), Number(value.args[1] ?? 0), Number(value.args[2] ?? 0)];
  if (Array.isArray(value)) return [Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0)];
  return [0, 0, 0];
}

function color(value: GodotValue | undefined): Color {
  if (isGodotCall(value) && value.name === 'Color') return new Color(Number(value.args[0] ?? 1), Number(value.args[1] ?? 1), Number(value.args[2] ?? 1));
  return new Color(1, 1, 1);
}
function number(value: GodotValue | undefined, fallback: number): number { return typeof value === 'number' ? value : fallback; }
function stringValue(value: GodotValue | undefined): string { return typeof value === 'string' ? value : ''; }
function nodePathFrom(node: TSCNNodeSection): string { return node.parent === '.' || !node.parent ? node.name : `${node.parent}/${node.name}`; }
function isRecord(value: GodotValue): value is { [key: string]: GodotValue } { return typeof value === 'object' && value !== null && !Array.isArray(value) && !isGodotCall(value); }
function isLoadedScene(value: unknown): value is LoadedScene { return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'scene'; }
function isLoadedGltf(value: unknown): value is LoadedGltf { return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'gltf'; }
function isBufferGeometry(value: unknown): value is BufferGeometry { return typeof value === 'object' && value !== null && 'isBufferGeometry' in value; }
function isMaterial(value: unknown): value is Material { return typeof value === 'object' && value !== null && 'isMaterial' in value; }
function isResourceSection(value: unknown): value is GodotResourceSection {
  return typeof value === 'object' && value !== null && 'resourceType' in value && 'properties' in value;
}
function ensureColorAttribute(geometry: BufferGeometry): void {
  let color = geometry.getAttribute('color');
  if (!color) {
    const position = geometry.getAttribute('position');
    if (!position) return;
    const colors = new Float32Array(position.count * 4);
    for (let i = 0; i < position.count; i++) {
      colors[i * 4] = colors[i * 4 + 1] = colors[i * 4 + 2] = colors[i * 4 + 3] = 1;
    }
    color = new Float32BufferAttribute(colors, 4);
    geometry.setAttribute('color', color);
  }
  geometry.setAttribute('godotVertexColor', color);
}

function updateShaderLights(root: Object3D): void {
  const lights: (PointLight | DirectionalLight | SpotLight)[] = [];
  let lightingRoot = root;
  while (lightingRoot.parent) lightingRoot = lightingRoot.parent;
  lightingRoot.updateMatrixWorld(true);
  lightingRoot.traverseVisible(o=> { if (o instanceof PointLight || o instanceof DirectionalLight || o instanceof SpotLight) lights.push(o); });
  root.traverse(o=> {
    const material = (o as Mesh).material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      if (!(m instanceof ShaderMaterial) || !m.uniforms.u_lightCount) continue;
      const environment=lightingRoot.userData.godotEnvironment as GodotEnvironmentSettings|undefined;
      if(m.uniforms.u_fogDensity){
        const previewFogScale=Number(lightingRoot.userData.godotPreviewFogScale??1);
        m.uniforms.u_fogDensity.value=(environment?.fogDensity??0)*previewFogScale;
        m.uniforms.u_volumetricDensity.value=(environment?.volumetricDensity??0)*previewFogScale;
        (m.uniforms.u_fogColor.value as Color).copy(environment?.fog?.color??new Color(0,0,0));
        if(environment)(m.uniforms.u_ambient.value as Color).copy(environment.ambientColor);
      }
      m.uniforms.u_lightCount.value = Math.min(lights.length,8);
      for (let i=0;i<Math.min(lights.length,8);i++) {
        const light=lights[i], v=new Vector3();
        light.getWorldPosition(v);
        if (light instanceof DirectionalLight) v.sub(light.target.getWorldPosition(new Vector3())).normalize();
        (m.uniforms.u_lightPosition.value[i] as Vector4).set(v.x,v.y,v.z,light instanceof DirectionalLight ? 0 : 1);
        (m.uniforms.u_lightColor.value[i] as Color).copy(light.color).multiplyScalar(light.intensity*Math.PI);
        m.uniforms.u_lightDecay.value[i]=light.userData.godotDecay??2;
        m.uniforms.u_spotDecay.value[i]=light.userData.godotSpotDecay??1;
        const direction=m.uniforms.u_lightDirection.value[i] as Vector4;
        if(light instanceof SpotLight){const axis=light.target.getWorldPosition(new Vector3()).sub(v).normalize();direction.set(axis.x,axis.y,axis.z,Math.cos(light.angle));}
        else direction.set(0,0,0,-1);
        m.uniforms.u_lightRange.value[i] = light instanceof PointLight || light instanceof SpotLight ? light.distance : 0;
      }
    }
  });
}

function updateShaderTime(scene: Object3D, timeSeconds: number): void {
  scene.traverse((object) => {
    const material = (object as Mesh).material as Material | Material[] | undefined;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    for (const item of materials) {
      const uniforms = (item as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
      if (uniforms?.u_time) uniforms.u_time.value = timeSeconds;
    }
  });
}
function directoryUrl(url: string): string {
  try { return new URL('.', url).toString(); }
  catch { return url.slice(0, url.lastIndexOf('/') + 1); }
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isBinbunEffectScript(path: string): boolean {
  return isElementalAreaController(path) || isElementalCastController(path) || isElementalProjectileController(path) || path.endsWith('/loot_effects/src/script/vfx_loot.gd') || path.endsWith('/ExplosionFX/script/VFXExplosionBB.gd') || path.endsWith('/StatusFX/script/VFXStatusBB.gd') || /\/DarkMagicFX\/script\/VFXDark(Ball|Area|Projectile)BB\.gd$/.test(path) || isHitImpactController(path) || /\/BattleFX\/script\/VFXBattle(?:SwingBB|ChargeBB|Slash|ShieldBB)\.gd$/.test(path) || /\/ElectricFX\/script\/VFX(?:ZapBB|ElectricBallBB|ImpactLightningBB)\.gd$/.test(path) || path.endsWith('/shared/script/VFXControllerBB.gd') || path.endsWith('/shared/script/VFXEmitterBB.gd') || path.endsWith('/beam_vfx/src/script/vfx_beam_controller.gd');
}
function isHitImpactController(path: string): boolean { return path.endsWith('/StylizedHitFX/script/VFXImpactBB.gd'); }
function isElementalAreaController(path: string): boolean { return path.endsWith('/ElementalMagicFX/script/VFXElementalAreaBB.gd'); }
function isElementalCastController(path: string): boolean { return path.endsWith('/ElementalMagicFX/script/VFXElementalCastBB.gd'); }
function isElementalProjectileController(path: string): boolean { return path.endsWith('/ElementalMagicFX/script/VFXElementalProjectileBB.gd'); }
function isBinbunScript(path: string): boolean { return isBinbunEffectScript(path) || path.endsWith('/shared/script/VFXOmniLightBB.gd') || path.endsWith('/shared/script/vfx_effect.gd'); }
function isMagicProjectileController(path: string): boolean { return path.endsWith('/shared/script/vfx_controller.gd'); }
function isMagicProjectileLight(path: string): boolean { return path.endsWith('/shared/script/vfx_light.gd'); }
function isPortalController(path: string): boolean { return path.endsWith('/portal_vfx/src/script/vfx_portal_controller.gd'); }
function isSpellFxDemo(path: string): boolean { return path.endsWith('/addons/spell_fx/demo/demo.gd'); }
function isReebooEffectController(path: string): boolean { return path.endsWith('/addons/reeboo_vfx/vfx_effect.gd'); }
function isSupportedPreviewScript(path: string): boolean {
  return isBinbunScript(path) || isMagicProjectileController(path) || isMagicProjectileLight(path) || isPortalController(path) || isSpellFxDemo(path) || isReebooEffectController(path) || isReebooDemo(path);
}
function isReebooDemo(path: string): boolean { return path.endsWith('/demo/demo.gd'); }

function directChildMaterials(object: Object3D): Material[] {
  return object.children.flatMap((child) => {
    const material = (child as Mesh).material;
    return Array.isArray(material) ? material : material ? [material] : [];
  });
}

function setGodotUniform(material: ShaderMaterial, name: string, source: GodotValue | undefined, value: unknown): void {
  const uniform = material.uniforms[name];
  if (!uniform) return;
  const current = uniform.value as { isColor?: boolean; isVector2?: boolean; isVector3?: boolean; isVector4?: boolean; copy?: (value: unknown) => unknown } | undefined;
  if (isGodotCall(source) && source.name === 'Color') {
    const srgb = new Color(Number(source.args[0] ?? 1), Number(source.args[1] ?? 1), Number(source.args[2] ?? 1));
    const alpha = Number(source.args[3] ?? 1);
    if (material.userData.godotSourceColorUniforms?.includes(name)) srgb.convertSRGBToLinear();
    if (current?.isVector4) uniform.value = new Vector4(srgb.r, srgb.g, srgb.b, alpha);
    else if (current?.isVector3) uniform.value = new Vector3(srgb.r, srgb.g, srgb.b);
    else if (current?.isColor) uniform.value = srgb;
    else uniform.value = new Vector4(srgb.r, srgb.g, srgb.b, alpha);
    return;
  }
  if (isGodotCall(source) && source.name === 'Vector2') {
    const next = new Vector2(Number(source.args[0] ?? 0), Number(source.args[1] ?? 0));
    uniform.value = current?.isVector2 ? (current.copy?.(next), current) : next;
    return;
  }
  if (isGodotCall(source) && source.name === 'Vector3') {
    const next = new Vector3(Number(source.args[0] ?? 0), Number(source.args[1] ?? 0), Number(source.args[2] ?? 0));
    uniform.value = current?.isVector3 ? (current.copy?.(next), current) : next;
    return;
  }
  if (isGodotCall(source) && source.name === 'Vector4') {
    const next = new Vector4(Number(source.args[0] ?? 0), Number(source.args[1] ?? 0), Number(source.args[2] ?? 0), Number(source.args[3] ?? 0));
    uniform.value = current?.isVector4 ? (current.copy?.(next), current) : next;
    return;
  }
  if (value === undefined) return;
  uniform.value = value;
}

