/** Replays the same deterministic CPU particle preview used by TSCNLoader. */
export function createGodotParticleRuntime(root, data, THREE) {
  const objects = new Map();
  root.traverse((object) => objects.set(object.uuid, object));
  const systems = (data?.systems ?? []).map((source) => {
    const bakedParticles = Array.isArray(source.particles);
    return {
      ...source,
      emitter: objects.get(source.emitterUuid),
      wasEmitting: false,
      emissionStart: undefined,
      emissionStoppedAt: undefined,
      recipeParticles: !bakedParticles,
      particles: bakedParticles ? source.particles.map((particle) => ({
        ...particle,
        mesh: objects.get(particle.uuid),
        origin: vector3(particle.origin),
        direction: vector3(particle.direction),
        gravity: vector3(particle.gravity),
        initialColor: new THREE.Vector4().fromArray(particle.initialColor),
      })) : [],
    };
  });
  const systemsByEmitter = new Map(systems.map((system) => [system.emitterUuid, system]));
  for (const system of systems) {
    system.sourceEmitter = systemsByEmitter.get(system.sourceEmitterUuid);
    if (!system.recipeParticles) {
      for (const particle of system.particles) particle.sourceParticle = objects.get(particle.sourceParticleUuid);
      continue;
    }

    const emitter = system.emitter, template = objects.get(system.templateUuid);
    if (!emitter || !template?.isMesh || !template.parent) continue;
    const count = Math.min(2048, Math.max(0, Math.floor(number(system.count, 0))));
    const parent = template.parent, geometry = template.geometry, material = template.material;
    const sourceCount = Math.max(1, number(system.sourceEmitter?.count, system.sourceEmitter?.particles.length ?? 0));
    const emissionSpread = system.oneShot ? system.lifetime * (1 - Math.min(1, Math.max(0, number(system.explosiveness, 0)))) : system.lifetime;
    for (let index = 0; index < count; index++) {
      const particle = createParticleRecipe(system, emitter, index, count, emissionSpread, sourceCount, THREE);
      const mesh = index === 0
        ? template
        : new THREE.Mesh(system.properties.trailEnabled ? geometry.clone() : geometry, cloneParticleMaterials(material, index));
      if (index === 0) mesh.material = cloneParticleMaterials(material, index);
      else parent.add(mesh);
      mesh.name = `${emitter.name}__particle_${index + 1}`;
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      particle.mesh = mesh;
      system.particles.push(particle);
    }
  }
  for (const system of systems) if (system.recipeParticles && system.sourceEmitter) {
    const sourceCount = Math.max(1, system.sourceEmitter.particles.length);
    for (let index = 0; index < system.particles.length; index++) {
      system.particles[index].sourceParticle = system.sourceEmitter.particles[index % sourceCount]?.mesh;
    }
  }

  let previousTime;
  return function updateGodotParticles(timeSeconds) {
    const time = Math.max(0, Number(timeSeconds) || 0);
    if (previousTime !== undefined && time < previousTime) {
      for (const system of systems) {
        system.wasEmitting = false;
        system.emissionStart = undefined;
        system.emissionStoppedAt = undefined;
      }
    }
    previousTime = time;

    for (const system of systems) {
      const emitter = system.emitter;
      if (!emitter) continue;
      const source = system.sourceEmitter;
      const isEmitting = Boolean(emitter.emitting);
      if (source) system.emissionStart = source.emissionStart;
      else if (isEmitting && (!system.wasEmitting || (system.emissionStart !== undefined && time < system.emissionStart))) {
        system.emissionStart = time;
        system.emissionStoppedAt = undefined;
      } else if (!isEmitting && system.wasEmitting) system.emissionStoppedAt = time;
      system.wasEmitting = isEmitting;
      if (isEmitting && system.emissionStart === undefined && !source) system.emissionStart = time;

      for (const particle of system.particles) {
        const mesh = particle.mesh;
        if (!mesh) continue;
        if (system.emissionStart === undefined) { mesh.visible = false; continue; }
        const life = Math.max(0.05, system.lifetime);
        let spawnTime = system.emissionStart + particle.delay;
        if (source) {
          const sourceCount = source.particles.length;
          const frequency = number(source.process.sub_emitter_frequency, 4);
          const period = Math.ceil(system.particles.length / sourceCount) / frequency;
          const cutoff = system.emissionStart + source.lifetime;
          const cycle = Math.floor((Math.min(time, cutoff - 0.00001) - spawnTime) / period);
          if (cycle < 0) { mesh.visible = false; continue; }
          spawnTime += cycle * period;
        } else if (!system.oneShot) {
          const cycle = Math.floor(((isEmitting ? time : Math.min(time, system.emissionStoppedAt ?? time)) - spawnTime) / life);
          if (cycle < 0) { mesh.visible = false; continue; }
          spawnTime += cycle * life;
        }
        const age = time - spawnTime;
        if (age < 0 || age >= life) { mesh.visible = false; continue; }

        const phase = age / life;
        const state = particleState(particle, age, system, THREE);
        let position = state.position;
        if (particle.sourceParticle && source) {
          const parentParticle = source.particles.find((item) => item.mesh === particle.sourceParticle);
          if (parentParticle) position = particleState(parentParticle, spawnTime - system.emissionStart, source, THREE).position.add(position);
        }
        position.multiply(emitter.scale).applyQuaternion(emitter.quaternion);
        mesh.position.copy(emitter.position).add(position);
        const scale = sample(system, 'scale_curve', phase);
        mesh.scale.copy(emitter.scale).multiply(new THREE.Vector3(scale.x, scale.y, scale.z)).multiplyScalar(particle.particleScale);
        mesh.quaternion.copy(emitter.quaternion);
        if ((system.process.particle_flag_align_y || system.properties.transformAlign === 2) && state.velocity.lengthSq() > 0.000001) {
          mesh.quaternion.multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), state.velocity.clone().normalize()));
        }
        const rotation = particle.spin * sample(system, 'angle_curve', phase).x;
        mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, system.process.particle_flag_rotate_y ? 1 : 0, system.process.particle_flag_rotate_y ? 0 : 1), rotation,
        ));

        const color = particle.initialColor.clone();
        const ramp = sample(system, 'color_ramp', phase);
        if (system.samples.color_ramp) color.multiply(ramp);
        color.w *= sample(system, 'alpha_curve', phase).x;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const uniforms = material?.uniforms ?? material?.userData?.godotShaderUniforms;
          uniforms?.u_particleColor?.value?.copy?.(color);
          uniforms?.u_instanceCustom?.value?.set?.(rotation, phase, 0, 1);
          if (uniforms?.u_billboard) uniforms.u_billboard.value = system.properties.transformAlign === 1;
        }
        if (system.properties.trailEnabled) updateTrail(mesh, particle, system, age, THREE);
        mesh.visible = emitter.visible;
      }
    }
  };

  function sample(system, name, time) {
    const descriptor = system.samples?.[name];
    if (!descriptor) return new THREE.Vector4(1, 1, 1, 1);
    if (descriptor.kind === 'curve') {
      const value = sampleCurve(descriptor.data, time);
      return new THREE.Vector4(value, value, value, 1);
    }
    if (descriptor.kind === 'curveXYZ') {
      const [x, y, z] = descriptor.curves.map((curve) => curve ? sampleCurve(curve, time) : 1);
      return new THREE.Vector4(x, y, z, 1);
    }
    if (descriptor.kind === 'gradient') return sampleGradient(descriptor, time, THREE);
    return new THREE.Vector4(1, 1, 1, 1);
  }

  function createParticleRecipe(system, emitter, index, count, emissionSpread, sourceCount, THREE) {
    const props = system.process ?? {};
    const seed = hashSeed(`${emitter.name}:${index}`);
    const random = (step) => random01(seed + step * 1013);
    const shape = number(props.emission_shape, 0);
    const origin = vector3(props.emission_shape_offset);
    if (shape === 1 || shape === 2) {
      const radius = number(props.emission_sphere_radius, 1);
      const shapeScale = props.emission_shape_scale ? vector3(props.emission_shape_scale) : new THREE.Vector3(1, 1, 1);
      const theta = Math.acos(1 - random(0) * 2), phi = random(1) * Math.PI * 2;
      origin.add(new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi))
        .multiply(shapeScale).multiplyScalar(radius * (shape === 1 ? Math.cbrt(random(10)) : 1)));
    }
    if (shape === 6) {
      const axis = vector3(props.emission_ring_axis);
      if (axis.lengthSq() === 0) axis.set(0, 1, 0);
      axis.normalize();
      const reference = Math.abs(axis.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const tangent = new THREE.Vector3().crossVectors(axis, reference).normalize();
      const bitangent = new THREE.Vector3().crossVectors(axis, tangent).normalize();
      const angle = random(4) * Math.PI * 2;
      const outerRadius = Math.max(0, number(props.emission_ring_radius, 1));
      const innerRadius = Math.min(outerRadius, Math.max(0, number(props.emission_ring_inner_radius, 0)));
      const radius = Math.sqrt(innerRadius * innerRadius + random(10) * (outerRadius * outerRadius - innerRadius * innerRadius));
      const radial = tangent.multiplyScalar(Math.cos(angle)).addScaledVector(bitangent, Math.sin(angle));
      origin.addScaledVector(axis, (random(11) - 0.5) * number(props.emission_ring_height, 0)).addScaledVector(radial, radius);
    }
    const baseDirection = vector3(props.direction);
    if (baseDirection.lengthSq() === 0) baseDirection.set(0, 1, 0);
    const direction = directionInCone(baseDirection, number(props.spread, 45) * Math.PI / 180, random(2), random(3));
    const velocityMin = number(props.initial_velocity_min, 0), velocityMax = number(props.initial_velocity_max, velocityMin);
    const scaleMin = number(props.scale_min, 1), scaleMax = number(props.scale_max, scaleMin);
    const dampingMin = number(props.damping_min, number(props.damping_max, 0));
    const dampingMax = number(props.damping_max, dampingMin);
    const angleMin = number(props.angle_min, 0), angleMax = number(props.angle_max, 0);
    const sourceFrequency = number(system.sourceEmitter?.process?.sub_emitter_frequency, 4);
    return {
      seed,
      delay: system.sourceEmitter ? Math.floor(index / sourceCount) / sourceFrequency : number(system.delay, 0) + (count > 1 ? index / count * emissionSpread : 0),
      origin,
      direction,
      velocity: velocityMin + (velocityMax - velocityMin) * random(5),
      gravity: props.gravity ? vector3(props.gravity) : new THREE.Vector3(0, -9.8, 0),
      damping: dampingMin + (dampingMax - dampingMin) * random(6),
      particleScale: scaleMin + (scaleMax - scaleMin) * random(7),
      spin: (angleMin + (angleMax - angleMin) * random(8)) * Math.PI / 180,
      initialColor: sample(system, 'color_initial_ramp', random(9)),
    };
  }

  function particleState(particle, age, system, THREE) {
    const velocity = particle.direction.clone().multiplyScalar(particle.velocity);
    const position = particle.origin.clone();
    const fps = system.properties.fixedFps;
    const steps = Math.max(1, Math.ceil(Math.max(0, age) * Math.max(1, fps)));
    const dt = Math.max(0, age) / steps;
    for (let i = 0; i < steps; i++) {
      velocity.addScaledVector(particle.gravity, dt);
      const phase = (i * dt) / system.lifetime;
      const acceleration = (name, salt) => {
        const min = number(system.process[name + '_min'], 0);
        const max = number(system.process[name + '_max'], min);
        return (min + (max - min) * random01(particle.seed + salt * 1013)) * sample(system, name + '_curve', phase).x;
      };
      if (velocity.lengthSq() > 1e-12) velocity.addScaledVector(velocity.clone().normalize(), acceleration('linear_accel', 11) * dt);
      const radial = position.clone().sub(vector3(system.process.emission_shape_offset));
      if (radial.lengthSq() > 1e-12) {
        radial.normalize();
        velocity.addScaledVector(radial, acceleration('radial_accel', 12) * dt);
        const axis = particle.gravity.lengthSq() > 0 ? particle.gravity.clone().normalize() : new THREE.Vector3(0, -1, 0);
        velocity.addScaledVector(radial.clone().cross(axis).normalize(), acceleration('tangential_accel', 13) * dt);
      }
      const speed = velocity.length();
      const damping = particle.damping * sample(system, 'damping_curve', (i * dt) / system.lifetime).x;
      if (speed > 0) velocity.multiplyScalar(Math.max(0, speed - damping * dt) / speed);
      position.addScaledVector(velocity, dt);
    }
    return { position, velocity };
  }

  function updateTrail(mesh, particle, system, age, THREE) {
    const positions = mesh.geometry.getAttribute('position');
    const uv = mesh.geometry.getAttribute('uv');
    const head = particleState(particle, age, system, THREE).position;
    const scale = Math.max(0.0001, particle.particleScale);
    const radius = system.properties.trailRadius;
    const inverseRotation = mesh.quaternion.clone().invert();
    const history = new Map();
    for (let i = 0; i < positions.count; i++) {
      const phase = uv.getY(i) * 2;
      const trailAge = Math.max(0, age - phase * system.properties.trailLifetime);
      let state = history.get(trailAge);
      if (!state) { state = particleState(particle, trailAge, system, THREE); history.set(trailAge, state); }
      const tangent = state.velocity.lengthSq() > 0 ? state.velocity.clone().normalize() : new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 0, 1)).normalize();
      const up = new THREE.Vector3().crossVectors(side, tangent).normalize();
      const angle = uv.getX(i) * Math.PI * 2;
      const taper = system.trailCurveData ? sampleCurve(system.trailCurveData, phase) : 1;
      const value = state.position.clone().sub(head)
        .addScaledVector(side, Math.sin(angle) * radius * taper)
        .addScaledVector(up, Math.cos(angle) * radius * taper);
      value.applyQuaternion(system.emitter.quaternion)
        .applyQuaternion(inverseRotation).divideScalar(scale);
      positions.setXYZ(i, value.x, value.y, value.z);
    }
    positions.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.frustumCulled = false;
  }

  function sampleCurve(raw, x) {
    if (!Array.isArray(raw) || raw.length < 5) return 1;
    const points = [];
    for (let i = 0; i + 4 < raw.length; i += 5) {
      const point = raw[i];
      if (!isCall(point)) continue;
      points.push({ x: Number(point.args[0]), y: Number(point.args[1]), left: Number(raw[i + 1]), right: Number(raw[i + 2]), leftMode: Number(raw[i + 3]), rightMode: Number(raw[i + 4]) });
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
      return (2 * t * t * t - 3 * t * t + 1) * a.y + (t * t * t - 2 * t * t + t) * m0
        + (-2 * t * t * t + 3 * t * t) * b.y + (t * t * t - t * t) * m1;
    }
    return points.at(-1).y;
  }

  function sampleGradient(descriptor, time, THREE) {
    const offsets = packed(descriptor.offsets), colors = packed(descriptor.colors);
    const colorValues = colors.length ? colors : [0, 0, 0, 1, 1, 1, 1, 1];
    const offsetValues = offsets.length ? offsets : [0, 1];
    const colorAt = (index) => new THREE.Vector4(...colorValues.slice(index * 4, index * 4 + 4));
    if (time <= offsetValues[0]) return colorAt(0);
    for (let i = 1; i < offsetValues.length; i++) if (time <= offsetValues[i]) {
      let amount = (time - offsetValues[i - 1]) / (offsetValues[i] - offsetValues[i - 1]);
      if (Number(descriptor.interpolationMode ?? 0) === 1) amount = 0;
      return colorAt(i - 1).lerp(colorAt(i), amount);
    }
    return colorAt(offsetValues.length - 1);
  }

  function packed(value) {
    if (isCall(value)) return value.args.map(Number);
    return Array.isArray(value) ? value.map(Number) : [];
  }
  function vector3(value) {
    if (isCall(value)) return new THREE.Vector3(Number(value.args[0] ?? 0), Number(value.args[1] ?? 0), Number(value.args[2] ?? 0));
    if (Array.isArray(value)) return new THREE.Vector3(Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0));
    return new THREE.Vector3(Number(value?.x ?? 0), Number(value?.y ?? 0), Number(value?.z ?? 0));
  }
  function isCall(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) && value.kind === 'call'; }
  function number(value, fallback) { return typeof value === 'number' ? value : fallback; }
  function hashSeed(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return hash >>> 0;
  }
  function directionInCone(direction, spread, angleRandom, rotationRandom) {
    const axis = direction.clone().normalize();
    if (axis.lengthSq() === 0) axis.set(0, 1, 0);
    const reference = Math.abs(axis.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const tangent = new THREE.Vector3().crossVectors(reference, axis).normalize();
    const bitangent = new THREE.Vector3().crossVectors(axis, tangent).normalize();
    const theta = Math.acos(1 - angleRandom * (1 - Math.cos(Math.min(Math.PI, spread))));
    const phi = rotationRandom * Math.PI * 2;
    return axis.multiplyScalar(Math.cos(theta))
      .addScaledVector(tangent, Math.sin(theta) * Math.cos(phi))
      .addScaledVector(bitangent, Math.sin(theta) * Math.sin(phi))
      .normalize();
  }
  function cloneParticleMaterials(source, instanceId) {
    const clone = (material) => {
      if (!material?.isShaderMaterial) return material;
      const local = new Set(['u_particleColor', 'u_instanceCustom', 'u_billboard', 'u_instanceId']);
      // ShaderMaterial.clone() delegates to cloneUniforms(), which assumes that
      // every object in a uniform array implements clone(). ObjectLoader can
      // restore Godot shader arrays as plain objects, so copy the material
      // fields without asking Three.js to clone its uniforms.
      const copy = new THREE.ShaderMaterial();
      for (const key of Object.keys(material)) {
        if (key !== 'uuid' && key !== '_listeners' && key !== 'uniforms' && key !== 'uniformsGroups') copy[key] = material[key];
      }
      copy.defines = { ...material.defines };
      copy.extensions = { ...material.extensions };
      copy.defaultAttributeValues = { ...material.defaultAttributeValues };
      copy.userData = { ...material.userData };
      if (material.blendColor?.clone) copy.blendColor = material.blendColor.clone();
      if (material.clippingPlanes) copy.clippingPlanes = material.clippingPlanes.map((plane) => plane?.clone?.() ?? plane);
      copy.uniformsGroups = material.uniformsGroups ?? [];
      copy.uniforms = {};
      for (const [name, uniform] of Object.entries(material.uniforms ?? {})) {
        copy.uniforms[name] = local.has(name)
          ? { ...uniform, value: cloneUniformValue(uniform?.value) }
          : uniform;
      }
      if (copy.uniforms?.u_instanceId) copy.uniforms.u_instanceId.value = instanceId;
      copy.userData.godotBaseMaterialUuid = material.userData?.godotBaseMaterialUuid ?? material.uuid;
      return copy;
    };
    return Array.isArray(source) ? source.map(clone) : clone(source);
  }
  function cloneUniformValue(value) {
    if (typeof value?.clone === 'function') return value.clone();
    if (Array.isArray(value)) return value.map(cloneUniformValue);
    if (value && typeof value === 'object') return { ...value };
    return value;
  }
  function random01(seed) {
    const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return value - Math.floor(value);
  }
}
