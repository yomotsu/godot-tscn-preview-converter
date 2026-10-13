import { Float32BufferAttribute, Group, Mesh, Object3D, Quaternion, ShaderMaterial, Vector3, Vector4, type BufferGeometry, type Material } from 'three';
import { isGodotCall, type GodotResourceSection, type GodotValue, type TSCNNodeSection } from '../tscn/types.js';
import { sampleCurve, type GodotCurveSampleData, type SampledTexture } from './GodotCurveConverter.js';
import type { ResourceValueResolver } from './GodotMaterialConverter.js';

interface ParticleSystemData {
  amount: number;
  lifetime: number;
  explosiveness: number;
  oneShot: boolean;
  emitting: boolean;
  process: Record<string, GodotValue>;
  samples: Record<string, SampledTexture>;
  nodeProperties: Record<string, GodotValue>;
  trailCurve?: GodotResourceSection;
  drawGeometry?: BufferGeometry;
  sourceEmitter?: Object3D;
  wasEmitting: boolean;
  emissionStart?: number;
  emissionStoppedAt?: number;
  previews: Mesh[];
}
interface ParticlePreviewData {
  system: ParticleSystemData;
  emitter: Object3D;
  index: number;
  count: number;
  seed: number;
  delay: number;
  origin: Vector3;
  direction: Vector3;
  radial: Vector3;
  velocity: number;
  gravity: Vector3;
  damping: number;
  particleScale: number;
  spin: number;
  initialColor: Vector4;
  sourceParticle?: Mesh;
}
export interface GodotParticleRuntimeData {
  systems: GodotParticleRuntimeSystem[];
}
export interface GodotParticleRuntimeSystem {
  emitterUuid: string;
  lifetime: number;
  oneShot: boolean;
  process: Record<string, GodotValue>;
  properties: { fixedFps: number; transformAlign: number; trailEnabled: boolean; trailLifetime: number; trailRadius: number };
  samples: Record<string, GodotCurveSampleData>;
  trailCurveData: GodotValue[] | null;
  sourceEmitterUuid?: string;
  particles: Array<{
    uuid: string;
    seed: number;
    delay: number;
    origin: number[];
    direction: number[];
    velocity: number;
    gravity: number[];
    damping: number;
    particleScale: number;
    spin: number;
    initialColor: number[];
    sourceParticleUuid?: string;
  }>;
  recipe: {
    templateUuid: string;
    count: number;
    explosiveness: number;
    delay: number;
    process: Record<string, GodotValue>;
  };
}
const particleSystems = new WeakMap<Object3D, ParticleSystemData>();
const particlePreviewData = new WeakMap<Mesh, ParticlePreviewData>();
const previousTimes = new WeakMap<Object3D, number>();

/** CPU implementation of the ParticleProcessMaterial features used by bundled VFX. */
export class GodotParticleConverter {
  setup(root:Object3D,warn:(message:string)=>void):void {setupParticlePreviews(root,warn);}
  update(root:Object3D,time:number):void {updateParticlePreviews(root,time);}
  exportRuntimeData(root: Object3D): GodotParticleRuntimeData {
    const systems: GodotParticleRuntimeSystem[] = [];
    root.traverse((emitter) => {
      const system = particleSystems.get(emitter);
      if (!system) return;
      const samples: Record<string, GodotCurveSampleData> = {};
      for (const [name, texture] of Object.entries(system.samples)) {
        if (texture.godotSampleData) samples[name] = texture.godotSampleData;
      }
      const processKeys = [
        'emission_shape_offset', 'sub_emitter_frequency', 'particle_flag_align_y', 'particle_flag_rotate_y',
        'linear_accel_min', 'linear_accel_max', 'radial_accel_min', 'radial_accel_max',
        'tangential_accel_min', 'tangential_accel_max',
      ];
      const recipeProcessKeys = [
        'emission_shape', 'emission_shape_offset', 'emission_shape_scale', 'emission_sphere_radius',
        'emission_ring_axis', 'emission_ring_radius', 'emission_ring_inner_radius', 'emission_ring_height',
        'direction', 'spread', 'initial_velocity_min', 'initial_velocity_max', 'gravity',
        'damping_min', 'damping_max', 'scale_min', 'scale_max', 'angle_min', 'angle_max',
        'sub_emitter_frequency', 'particle_flag_align_y', 'particle_flag_rotate_y',
        'linear_accel_min', 'linear_accel_max', 'radial_accel_min', 'radial_accel_max',
        'tangential_accel_min', 'tangential_accel_max',
      ];
      const particleUuids = system.previews.map((preview) => preview.uuid);
      systems.push({
        emitterUuid: emitter.uuid,
        lifetime: system.lifetime,
        oneShot: system.oneShot,
        process: Object.fromEntries(processKeys.filter((key) => system.process[key] !== undefined).map((key) => [key, system.process[key]])),
        properties: {
          fixedFps: number(system.nodeProperties.fixed_fps, 30),
          transformAlign: number(system.nodeProperties.transform_align, 0),
          trailEnabled: Boolean(system.nodeProperties.trail_enabled),
          trailLifetime: number(system.nodeProperties.trail_lifetime, 0.3),
          trailRadius: Number(system.drawGeometry?.userData.godotTrailRadius ?? 0.1),
        },
        samples,
        trailCurveData: system.trailCurve && Array.isArray(system.trailCurve.properties._data) ? system.trailCurve.properties._data : null,
        sourceEmitterUuid: system.sourceEmitter?.uuid,
        particles: system.previews.map((preview) => {
          const particle = particlePreviewData.get(preview)!;
          return {
            uuid: preview.uuid,
            seed: particle.seed,
            delay: particle.delay,
            origin: particle.origin.toArray(),
            direction: particle.direction.toArray(),
            velocity: particle.velocity,
            gravity: particle.gravity.toArray(),
            damping: particle.damping,
            particleScale: particle.particleScale,
            spin: particle.spin,
            initialColor: particle.initialColor.toArray(),
            sourceParticleUuid: particle.sourceParticle?.uuid,
          };
        }),
        recipe: {
          templateUuid: particleUuids[0] ?? '',
          count: particleUuids.length,
          explosiveness: system.explosiveness,
          delay: number(emitter.userData.godotVfxDelay, 0),
          process: Object.fromEntries(recipeProcessKeys.filter((key) => system.process[key] !== undefined).map((key) => [key, system.process[key]])),
        },
      });
    });
    return { systems };
  }
  setAmount(emitter:Object3D,amount:number):void {const system=particleSystems.get(emitter);if(system) system.amount=amount;}
  /** Apply the particle properties exposed by ElementalMagicFX's area controller. */
  applyElementalAreaProperties(emitter: Object3D, properties: { amount: number; lifetime: number; explosiveness: number; emitting: boolean; ringRadius: number }): void {
    const system = particleSystems.get(emitter);
    if (!system) return;
    system.amount = properties.amount;
    system.lifetime = properties.lifetime;
    system.explosiveness = properties.explosiveness;
    system.emitting = properties.emitting;
    system.process = {
      ...system.process,
      emission_ring_radius: properties.ringRadius,
      emission_ring_inner_radius: properties.ringRadius,
    };
    (emitter as Object3D & { emitting: boolean }).emitting = properties.emitting;
    Object.assign(emitter.userData.godotParticleSystem ?? {}, {
      amount: system.amount, lifetime: system.lifetime, emitting: system.emitting,
    });
  }
  /** Apply the particle settings exposed by ElementalMagicFX's projectile controller. */
  applyElementalProjectileProperties(emitter: Object3D, properties: { amount?: number; lifetime?: number; explosiveness?: number; emitting?: boolean }): void {
    const system = particleSystems.get(emitter);
    if (!system) return;
    if (properties.amount !== undefined) system.amount = properties.amount;
    if (properties.lifetime !== undefined) system.lifetime = properties.lifetime;
    if (properties.explosiveness !== undefined) system.explosiveness = properties.explosiveness;
    if (properties.emitting !== undefined) {
      system.emitting = properties.emitting;
      (emitter as Object3D & { emitting: boolean }).emitting = properties.emitting;
    }
    Object.assign(emitter.userData.godotParticleSystem ?? {}, {
      amount: system.amount, lifetime: system.lifetime, emitting: system.emitting,
    });
  }
  applyLootProperties(emitter: Object3D, properties: Record<string, GodotValue>): void {
    const system = particleSystems.get(emitter);
    if (!system) return;
    for (const key of ['amount', 'lifetime', 'explosiveness'] as const) {
      if (typeof properties[key] === 'number') system[key] = properties[key];
    }
    if (typeof properties.emitting === 'boolean') (emitter as Object3D & {emitting: boolean}).emitting = properties.emitting;
    // Keep each emitter independent when process materials are shared.
    system.process = {...system.process};
    if (typeof properties.emission_radius === 'number') system.process.emission_sphere_radius = properties.emission_radius;
    if (typeof properties.radial_accel === 'number') {
      system.process.radial_accel_min = properties.radial_accel;
      system.process.radial_accel_max = properties.radial_accel * 0.6;
    }
  }
  async convert(node: TSCNNodeSection, resolve: ResourceValueResolver, warn: (message:string)=>void): Promise<Object3D> {
    const processValue = node.properties.process_material ? await resolve(node.properties.process_material) : undefined;
    const process = isResourceSection(processValue) ? processValue.properties : {};
    const particleData: ParticleSystemData = {
      amount: number(node.properties.amount, 1), lifetime: number(node.properties.lifetime, 1),
      explosiveness: number(node.properties.explosiveness, 0),
      oneShot: Boolean(node.properties.one_shot), emitting: Boolean(node.properties.emitting ?? true),
      process, samples: {}, nodeProperties: node.properties, wasEmitting: false, previews: [],
    };
    for (const key of ['scale_curve','alpha_curve','color_ramp','color_initial_ramp','damping_curve','angle_curve','radial_accel_curve','linear_accel_curve','tangential_accel_curve']) {
      const value = process[key] ? await resolve(process[key]) : undefined;
      if (value && typeof value === 'object' && 'sampleGodot' in value) particleData.samples[key] = value as SampledTexture;
    }
    const geometryValue = node.properties.draw_pass_1;
    const materialValue = node.properties.material_override;
    const geometry = geometryValue ? await resolve(geometryValue) : undefined;
    const material = materialValue ? await resolve(materialValue) : undefined;
    if (isBufferGeometry(geometry)) {
      ensureColorAttribute(geometry);
      if (geometry.userData.godotTrailCurve) {
        const curve = await resolve(geometry.userData.godotTrailCurve);
        if (isResourceSection(curve)) particleData.trailCurve = curve;
      }
      particleData.drawGeometry = geometry;
      const controllerGeometry=geometry.clone();
      controllerGeometry.setDrawRange(0,0);
      const mesh = new Mesh(controllerGeometry, isMaterial(material) ? material : undefined);
      // Keep visibility and AnimationMixer bindings on an empty draw controller.
      // Particle draw meshes are siblings, so emission can stop without hiding them.
      (mesh as Mesh & { emitting: boolean }).emitting = particleData.emitting;
      particleSystems.set(mesh, particleData);
      mesh.userData.godotParticleSystem = { amount: particleData.amount, lifetime: particleData.lifetime, oneShot: particleData.oneShot, emitting: particleData.emitting };
      for (const key of ['turbulence_enabled','collision_mode','attractor_interaction_enabled']) {
        if (process[key]) warn(`GPUParticles3D '${node.name}': '${key}' is not supported by the CPU simulation`);
      }
      return mesh;
    } else {
      warn(`GPUParticles3D '${node.name}' has no supported draw_pass_1 mesh`);
    }
    const group = new Group();
    (group as Group & { emitting: boolean }).emitting = particleData.emitting;
    particleSystems.set(group, particleData);
    group.userData.godotParticleSystem = { amount: particleData.amount, lifetime: particleData.lifetime, oneShot: particleData.oneShot, emitting: particleData.emitting };
    return group;
  }

}
/** Builds a bounded set of deterministic draw meshes for each GPU particle emitter. */
function setupParticlePreviews(root: Object3D, warn: (message: string) => void): void {
  const emitters: Mesh[] = [];
  root.traverse((object) => {
    if (particleSystems.has(object) && (object as Mesh).isMesh) emitters.push(object as Mesh);
  });

  for (const emitter of emitters) {
    const system = particleSystems.get(emitter) as ParticleSystemData;
    // Script-driven sample effects are replayed as previews, so one-shot layers
    // should cycle instead of disappearing permanently after their first burst.
    if (emitter.userData.godotVfxLoop === true) system.oneShot = false;
    if (!emitter.parent) {
      warn(`GPUParticles3D '${emitter.name}' has no parent; particle preview was skipped`);
      continue;
    }
    if(system.amount>2048) warn(`GPUParticles3D '${emitter.name}': amount ${system.amount} exceeds the CPU limit of 2048`);
    const count = Math.min(Math.max(1, Math.floor(system.amount)), 2048);
    const life = Math.max(0.05, system.lifetime);
    const layerDelay = number(emitter.userData.godotVfxDelay, 0);
    const emissionSpread = system.oneShot ? life * (1 - clamp(system.explosiveness, 0, 1)) : life;
    for (let index = 0; index < count; index++) {
      const seed = hashSeed(`${emitter.name}:${index}`);
      const random = (step: number) => random01(seed + step * 1013);
      const props = system.process;
      const baseMaterial = emitter.material;
      const cloneMaterial = (material: Material) => {
        if (!(material instanceof ShaderMaterial)) return material;
        const clone = material.clone();
        // Keep animated material parameters shared, with independent particle inputs.
        for (const [key,value] of Object.entries(material.uniforms)) {
          if (!['u_particleColor','u_instanceCustom','u_billboard','u_instanceId'].includes(key)) clone.uniforms[key] = value;
        }
        return clone;
      };
      const preview = new Mesh(system.nodeProperties.trail_enabled ? system.drawGeometry!.clone() : system.drawGeometry!,
        Array.isArray(baseMaterial) ? baseMaterial.map(cloneMaterial) : cloneMaterial(baseMaterial));
      const previewMaterials = Array.isArray(preview.material) ? preview.material : [preview.material];
      for (const material of previewMaterials) if (material instanceof ShaderMaterial && material.uniforms.u_instanceId) material.uniforms.u_instanceId.value = index;
      preview.name = `${emitter.name}__particle_${index + 1}`;
      preview.visible = false;
      preview.castShadow = false;
      preview.receiveShadow = false;
      emitter.parent.add(preview);

      const shape = number(props.emission_shape, 0);
      const offset = vector3(props.emission_shape_offset);
      if (shape === 1 || shape === 2) {
        const radius = number(props.emission_sphere_radius, 1);
        const shapeScale = props.emission_shape_scale ? vector3(props.emission_shape_scale) : new Vector3(1, 1, 1);
        const theta = Math.acos(1 - random(0) * 2);
        const phi = random(1) * Math.PI * 2;
        offset.add(new Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)).multiply(shapeScale).multiplyScalar(radius*(shape===1 ? Math.cbrt(random(10)) : 1)));
      } else if (shape === 6) {
        const axis = vector3(props.emission_ring_axis);
        if (axis.lengthSq() === 0) axis.set(0, 1, 0);
        axis.normalize();
        const reference = Math.abs(axis.y) < 0.99 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
        const tangent = new Vector3().crossVectors(axis, reference).normalize();
        const bitangent = new Vector3().crossVectors(axis, tangent).normalize();
        const angle = random(4) * Math.PI * 2;
        const outerRadius = Math.max(0, number(props.emission_ring_radius, 1));
        const innerRadius = Math.min(outerRadius, Math.max(0, number(props.emission_ring_inner_radius, 0)));
        const radius = Math.sqrt(innerRadius * innerRadius + random(10) * (outerRadius * outerRadius - innerRadius * innerRadius));
        const height = number(props.emission_ring_height, 0);
        const radial = tangent.multiplyScalar(Math.cos(angle)).addScaledVector(bitangent, Math.sin(angle));
        offset.addScaledVector(axis, (random(11) - 0.5) * height).addScaledVector(radial, radius);
      }

      const baseDirection = vector3(props.direction);
      if (baseDirection.lengthSq() === 0) baseDirection.set(0, 1, 0);
      const spread = number(props.spread, 45) * Math.PI / 180;
      const direction = directionInCone(baseDirection, spread, random(2), random(3));
      const radialAngle = random(4) * Math.PI * 2;
      const velocityMin = number(props.initial_velocity_min, 0);
      const velocityMax = number(props.initial_velocity_max, velocityMin);
      const scaleMin = number(props.scale_min, 1);
      const scaleMax = number(props.scale_max, scaleMin);
      const gravity = props.gravity ? vector3(props.gravity) : new Vector3(0,-9.8,0);
      const dampingMin = number(props.damping_min, number(props.damping_max, 0));
      const dampingMax = number(props.damping_max, dampingMin);
      const angleMin = number(props.angle_min, 0);
      const angleMax = number(props.angle_max, 0);

      particlePreviewData.set(preview, {
        system, emitter, index, count, seed,
        delay: layerDelay + (count > 1 ? index / count * emissionSpread : 0),
        origin: offset,
        direction,
        radial: new Vector3(Math.cos(radialAngle), 0, Math.sin(radialAngle)),
        velocity: velocityMin + (velocityMax - velocityMin) * random(5),
        gravity,
        damping: dampingMin + (dampingMax - dampingMin) * random(6),
        particleScale: scaleMin + (scaleMax - scaleMin) * random(7),
        initialColor: system.samples.color_initial_ramp?.sampleGodot(random(9)) ?? new Vector4(1,1,1,1),
        spin: (angleMin + (angleMax - angleMin) * random(8)) * Math.PI / 180,
      });
      system.previews.push(preview);
    }
  }
  for (const emitter of emitters) {
    const system = particleSystems.get(emitter)!;
    const path = system.nodeProperties.sub_emitter;
    if (!isGodotCall(path)) continue;
    const name = String(path.args[0]).split('/').at(-1)!;
    const target = emitter.parent?.getObjectByName(name);
    const targetSystem = target && particleSystems.get(target);
    if (!targetSystem || !target) continue;
    targetSystem.sourceEmitter = emitter;
    const frequency = number(system.process.sub_emitter_frequency, 4);
    for (let i=0;i<targetSystem.previews.length;i++) {
      const p = particlePreviewData.get(targetSystem.previews[i])!;
      p.sourceParticle = system.previews[i % system.previews.length];
      p.delay = Math.floor(i / system.previews.length) / frequency;
    }
  }

}

/** Advances preview meshes from emitter `emitting` tracks and elapsed time. */
function updateParticlePreviews(root: Object3D, timeSeconds: number): void {
  const previous=previousTimes.get(root);
  if(previous!==undefined && timeSeconds<previous) root.traverse(o=>{
    const system=particleSystems.get(o);
    if(system) {system.wasEmitting=false;system.emissionStart=undefined;system.emissionStoppedAt=undefined;}
  });
  previousTimes.set(root,timeSeconds);
  root.traverse((emitter) => {
    const system = particleSystems.get(emitter);
    if (!system) return;
    const source = system.sourceEmitter && particleSystems.get(system.sourceEmitter);
    const isEmitting = Boolean((emitter as Object3D & { emitting: boolean }).emitting);
    if (source) system.emissionStart = source.emissionStart;
    else if (isEmitting && (!system.wasEmitting || (system.emissionStart !== undefined && timeSeconds < system.emissionStart))) {
      system.emissionStart = timeSeconds;
      system.emissionStoppedAt = undefined;
    } else if (!isEmitting && system.wasEmitting) system.emissionStoppedAt = timeSeconds;
    system.wasEmitting = isEmitting;
    if (isEmitting && system.emissionStart === undefined && !source) system.emissionStart = timeSeconds;
    for (const preview of system.previews) {
      const particle = particlePreviewData.get(preview)!;
      if (system.emissionStart === undefined) { preview.visible = false; continue; }
      const life = Math.max(0.05, system.lifetime);
      let spawnTime = system.emissionStart + particle.delay;
      if (source) {
        const sourceCount = source.previews.length;
        const frequency = number(source.process.sub_emitter_frequency,4);
        const period = Math.ceil(system.previews.length/sourceCount)/frequency;
        const cutoff = system.emissionStart + source.lifetime;
        const cycle = Math.floor((Math.min(timeSeconds,cutoff-0.00001)-spawnTime)/period);
        if (cycle < 0) { preview.visible = false; continue; }
        spawnTime += cycle * period;
      } else if (!system.oneShot) {
        const cycle = Math.floor(((isEmitting ? timeSeconds : Math.min(timeSeconds,system.emissionStoppedAt ?? timeSeconds))-spawnTime)/life);
        if (cycle < 0) { preview.visible = false; continue; }
        spawnTime += cycle*life;
      }
      const age = timeSeconds-spawnTime;
      if (age<0 || age>=life) { preview.visible=false; continue; }
      const phase = age/life;
      const state = particleState(particle,age);
      let position = state.position;
      if (particle.sourceParticle && source) {
        const parentParticle = particlePreviewData.get(particle.sourceParticle)!;
        position = particleState(parentParticle,spawnTime-system.emissionStart).position.add(position);
      }
      position.multiply(emitter.scale).applyQuaternion(emitter.quaternion);
      preview.position.copy(emitter.position).add(position);
      const curve = system.samples.scale_curve?.sampleGodot(phase) ?? new Vector4(1,1,1,1);
      preview.scale.copy(emitter.scale).multiply(new Vector3(curve.x,curve.y,curve.z)).multiplyScalar(particle.particleScale);
      preview.quaternion.copy(emitter.quaternion);
      if ((system.process.particle_flag_align_y || system.nodeProperties.transform_align===2) && state.velocity.lengthSq()>0.000001) {
        preview.quaternion.multiply(new Quaternion().setFromUnitVectors(new Vector3(0,1,0),state.velocity.clone().normalize()));
      }
      const rotation = particle.spin * (system.samples.angle_curve?.sampleGodot(phase).x ?? 1);
      preview.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0,system.process.particle_flag_rotate_y ? 1 : 0,system.process.particle_flag_rotate_y ? 0 : 1),rotation));
      const c = particle.initialColor.clone();
      const ramp = system.samples.color_ramp?.sampleGodot(phase);
      if (ramp) c.multiply(ramp);
      c.w *= system.samples.alpha_curve?.sampleGodot(phase).x ?? 1;
      const materials = Array.isArray(preview.material) ? preview.material : [preview.material];
      for (const material of materials) if (material instanceof ShaderMaterial) {
        (material.uniforms.u_particleColor.value as Vector4).copy(c);
        (material.uniforms.u_instanceCustom.value as Vector4).set(rotation,phase,0,1);
        material.uniforms.u_billboard.value = system.nodeProperties.transform_align === 1;
      }
      if (system.nodeProperties.trail_enabled) updateTrail(preview,particle,age);
      preview.visible = emitter.visible;
    }
  });
}

/** Integrate at the emitter's fixed FPS. Damping is constant deceleration in Godot. */
function particleState(particle: ParticlePreviewData, age: number): {position:Vector3;velocity:Vector3} {
  const velocity = particle.direction.clone().multiplyScalar(particle.velocity);
  const position = particle.origin.clone();
  const fps = number(particle.system.nodeProperties.fixed_fps,30);
  const steps = Math.max(1,Math.ceil(Math.max(0,age)*Math.max(1,fps)));
  const dt = Math.max(0,age)/steps;
  for (let i=0;i<steps;i++) {
    velocity.addScaledVector(particle.gravity,dt);
    const phase = (i * dt) / particle.system.lifetime;
    const acceleration = (name: string, salt: number) => {
      const props = particle.system.process;
      const min = number(props[name + '_min'], 0), max = number(props[name + '_max'], min);
      return (min + (max - min) * random01(particle.seed + salt * 1013)) * (particle.system.samples[name + '_curve']?.sampleGodot(phase).x ?? 1);
    };
    if (velocity.lengthSq() > 1e-12) velocity.addScaledVector(velocity.clone().normalize(), acceleration('linear_accel', 11) * dt);
    // Radial force points from the emission origin toward the particle.
    const radial = position.clone().sub(vector3(particle.system.process.emission_shape_offset));
    if (radial.lengthSq() > 1e-12) {
      radial.normalize();
      velocity.addScaledVector(radial, acceleration('radial_accel', 12) * dt);
      const axis = particle.gravity.lengthSq() > 0 ? particle.gravity.clone().normalize() : new Vector3(0,-1,0);
      velocity.addScaledVector(radial.clone().cross(axis).normalize(), acceleration('tangential_accel', 13) * dt);
    }
    const speed = velocity.length();
    const damping = particle.damping*(particle.system.samples.damping_curve?.sampleGodot((i*dt)/particle.system.lifetime).x ?? 1);
    if (speed>0) velocity.multiplyScalar(Math.max(0,speed-damping*dt)/speed);
    position.addScaledVector(velocity,dt);
  }
  return {position,velocity};
}

function updateTrail(mesh: Mesh, particle: ParticlePreviewData, age: number): void {
  const system = particle.system, positions = mesh.geometry.getAttribute('position'), uv = mesh.geometry.getAttribute('uv');
  const duration = number(system.nodeProperties.trail_lifetime,0.3);
  const head = particleState(particle,age).position;
  const scale = Math.max(0.0001,particle.particleScale);
  const radius = Number(mesh.geometry.userData.godotTrailRadius ?? 0.1);
  const inverseRotation = mesh.quaternion.clone().invert();
  const history=new Map<number,ReturnType<typeof particleState>>();
  for (let i=0;i<positions.count;i++) {
    const phase = uv.getY(i)*2, trailAge = Math.max(0,age-phase*duration);
    let state=history.get(trailAge);
    if(!state) {state=particleState(particle,trailAge);history.set(trailAge,state);}

    const tangent = state.velocity.lengthSq()>0 ? state.velocity.clone().normalize() : new Vector3(0,1,0);
    const side = new Vector3().crossVectors(tangent,new Vector3(0,0,1)).normalize();
    const up = new Vector3().crossVectors(side,tangent).normalize();
    const angle = uv.getX(i)*Math.PI*2;
    const taper = system.trailCurve ? sampleCurve(system.trailCurve,phase) : 1;
    const v = state.position.clone().sub(head).addScaledVector(side,Math.sin(angle)*radius*taper).addScaledVector(up,Math.cos(angle)*radius*taper);
    v.applyQuaternion(particle.emitter.quaternion).applyQuaternion(inverseRotation).divideScalar(scale);
    positions.setXYZ(i,v.x,v.y,v.z);
  }
  positions.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.frustumCulled = false;
}

function directionInCone(direction: Vector3, spread: number, angleRandom: number, rotationRandom: number): Vector3 {
  const axis = direction.clone().normalize();
  const reference = Math.abs(axis.y) > 0.98 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const tangent = new Vector3().crossVectors(reference, axis).normalize();
  const bitangent = new Vector3().crossVectors(axis, tangent).normalize();
  const theta = Math.acos(1 - angleRandom * (1 - Math.cos(Math.min(Math.PI, spread))));
  const phi = rotationRandom * Math.PI * 2;
  return axis.multiplyScalar(Math.cos(theta))
    .addScaledVector(tangent, Math.sin(theta) * Math.cos(phi))
    .addScaledVector(bitangent, Math.sin(theta) * Math.sin(phi))
    .normalize();
}
function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}
function random01(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

function number(value: GodotValue | undefined, fallback:number):number {return typeof value==='number' ? value : fallback;}
function vector3(value: GodotValue | undefined): Vector3 {return isGodotCall(value) ? new Vector3(Number(value.args[0]??0),Number(value.args[1]??0),Number(value.args[2]??0)) : new Vector3();}
function isResourceSection(value:unknown):value is GodotResourceSection {return typeof value==='object' && value!==null && 'resourceType' in value;}
function isBufferGeometry(value:unknown):value is BufferGeometry {return typeof value==='object' && value!==null && 'isBufferGeometry' in value;}
function isMaterial(value:unknown):value is Material {return typeof value==='object' && value!==null && 'isMaterial' in value;}
function ensureColorAttribute(geometry:BufferGeometry):void {
  let color=geometry.getAttribute('color');
  if(!color){
    const position=geometry.getAttribute('position');
    if(!position)return;
    color=new Float32BufferAttribute(new Float32Array(position.count*4).fill(1),4);
    geometry.setAttribute('color',color);
  }
  geometry.setAttribute('godotVertexColor',color);
  geometry.userData.godotGeometryRecipe = { ...geometry.userData.godotGeometryRecipe, kind: geometry.userData.godotGeometryRecipe?.kind ?? 'none', colorItemSize: 4 };
}
