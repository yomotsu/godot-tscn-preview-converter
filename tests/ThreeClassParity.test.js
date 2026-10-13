import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GodotMeshConverter } from '../src/converters/GodotMeshConverter.ts';
import { TSCNLoader } from '../src/index.ts';
import { exportThreeClass } from '../src/app/three-class/export.js';
import { AbstractVFXMesh as Runtime } from '../src/app/three-class/runtime.js';
import { AbstractVFXMesh as MinRuntime } from '../dist/three-class/AbstractVFXMesh.min.js';

async function exportConfig(result, mixer, actions, id = 'test') {
  const blobs = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob); return 'blob:test'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('document', { createElement: () => ({ click() {} }) });
  vi.stubGlobal('Terser', { minify: async source => ({ code: source }) });
  try {
    await exportThreeClass({ target: 'webgl', effect: { id }, entry: { result, mixer, actions }, actions });
    const source = await blobs[0].text();
    const packed = JSON.parse(source.match(/const PACKED_DATA = (.*);/)[1]);
    const keys = JSON.parse(source.match(/const DATA_KEY_MAP = (.*);/)[1]);
    const features = JSON.parse(source.match(/const FEATURES = (.*);/)[1]);
    return { ...Runtime.decodeDataKeys(packed, keys), features };
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
}

function compareMeshes(original, restored) {
  const meshes = [];
  original.traverse(object => { if (object.isMesh) meshes.push(object); });
  for (const mesh of meshes) {
    const copy = restored.getObjectByName(mesh.name);
    expect(copy, mesh.name).toBeDefined();
    expect(copy.visible, mesh.name).toBe(mesh.visible);
    if (!mesh.visible) continue;
    for (const property of ['position', 'quaternion', 'scale']) {
      mesh[property].toArray().forEach((value, i) => expect(copy[property].toArray()[i], `${mesh.name}.${property}`).toBeCloseTo(value, 5));
    }
    for (const name of ['u_particleColor', 'u_instanceCustom']) {
      const uniform = mesh.material.uniforms?.[name];
      if (uniform) expect(copy.material.uniforms[name].value.toArray(), `${mesh.name}.${name}`).toEqual(uniform.value.toArray());
    }
    for (const name of ['position', 'normal', 'uv', 'color', 'godotVertexColor']) {
      const attribute = mesh.geometry.getAttribute(name);
      if (!attribute) continue;
      const original = attribute.array, other = copy.geometry.getAttribute(name)?.array;
      expect(other?.length, `${mesh.name}.${name}`).toBe(original.length);
      let error = 0;
      for (let i = 0; i < original.length; i++) error = Math.max(error, Math.abs(other[i] - original[i]));
      expect(error, `${mesh.name}.${name}`).toBeLessThan(0.000005);
    }
  }
}

describe('exported class playback parity', () => {
  it('preserves linear and HDR colors instead of quantizing them to sRGB hex', async () => {
    const scene = new THREE.Group();
    const light = new THREE.PointLight(new THREE.Color(0.945098, 0.356863, 0), 4);
    light.name = 'Light'; scene.add(light);
    const material = new THREE.ShaderMaterial({ uniforms: {
      u_ambient: { value: new THREE.Color(0.15, 0.15, 0.15) },
      primary_color: { value: new THREE.Color(2.17, 0.356863, 0.03) },
    } });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(), material); mesh.name = 'Head'; scene.add(mesh);
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    surface.name = 'Surface'; surface.material.color.setRGB(0.123456, 0.234567, 0.345678);
    surface.material.emissive.setRGB(2.17, 0.02, 0.1); scene.add(surface);
    const config = await exportConfig({ scene, updateTime() {}, particleRuntimeData: { systems: [] } }, null, []);
    for (const Base of [Runtime, MinRuntime]) {
      class Effect extends Base { static config = config; }
      const effect = new Effect();
      expect(effect.effectRoot.getObjectByName('Light').color.toArray()).toEqual(light.color.toArray());
      const restored = effect.effectRoot.getObjectByName('Head').material;
      for (const [name, uniform] of Object.entries(material.uniforms)) expect(restored.uniforms[name].value.toArray()).toEqual(uniform.value.toArray());
      const restoredSurface = effect.effectRoot.getObjectByName('Surface').material;
      expect(restoredSurface.color.toArray()).toEqual(surface.material.color.toArray());
      expect(restoredSurface.emissive.toArray()).toEqual(surface.material.emissive.toArray());
      effect.dispose();
    }
  });
  it('reconstructs parameter-only hemisphere geometry once', async () => {
    const geometry = new GodotMeshConverter().convert({ resourceType: 'SphereMesh', properties: { radius: 0.5, height: 1.3, is_hemisphere: true } }, () => {});
    const scene = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.name = 'Hemisphere'; scene.add(mesh);
    const config = await exportConfig({ scene, updateTime() {}, particleRuntimeData: { systems: [] } }, null, []);
    expect(config.sceneData.geometries[0].type).toBe('SphereGeometry');
    for (const Base of [Runtime, MinRuntime]) {
      class Effect extends Base { static config = config; }
      const effect = new Effect(); compareMeshes(scene, effect.effectRoot); effect.dispose();
    }
  });
  it('matches the ground explosion particles, animated materials and trails throughout playback and restart', async () => {
    const path = 'examples/assets/ExplosionFX/effects/ground/vfx_ground_explosion_01.tscn';
    const loader = new TSCNLoader({ resourcePath: '/godot/', fetcher: async input => {
      try { return new Response(await readFile(new URL('../' + String(input).replace('/godot/assets/BinbunVFX_Vol2/', ''), import.meta.url))); }
      catch { return new Response('', { status: 404 }); }
    } });
    const result = await loader.parseAsync(await readFile(new URL('../' + path, import.meta.url), 'utf8'), '/godot/assets/BinbunVFX_Vol2/' + path);
    const mixer = new THREE.AnimationMixer(result.scene);
    const action = mixer.clipAction(result.animations.find(clip => clip.name === 'main')).play();
    mixer.update(0); result.updateTime(0);
    const config = await exportConfig(result, mixer, [action]);
    for (const geometry of config.sceneData.geometries) {
      expect(geometry.userData?.godotGeometryRecipe).toBeUndefined();
      let original;
      result.scene.traverse(mesh => { if (mesh.geometry?.uuid === geometry.uuid) original = mesh.geometry; });
      if (original?.userData.godotGeometryRecipe) {
        geometry.userData = { ...geometry.userData, godotGeometryRecipe: original.userData.godotGeometryRecipe };
        config.features.geometryRecipes = true;
      }
    }
    for (const Base of [Runtime, MinRuntime]) {
      class Effect extends Base { static config = config; }
      const effect = new Effect();
      mixer.setTime(0); result.updateTime(0);
      for (const time of [0, 0.1, 0.3, 0.6, 1, 0, 0.3]) {
        mixer.setTime(time); result.updateTime(time); effect.updateTime(time);
        compareMeshes(result.scene, effect.effectRoot);
      }
      effect.dispose();
    }
  });

  it('preserves ring emission shape and delayed particle spawning', async () => {
    const result = await new TSCNLoader().parseAsync(`
[sub_resource type="ParticleProcessMaterial" id="process"]
emission_shape = 6
emission_ring_axis = Vector3(0, 1, 0)
emission_ring_radius = 3
emission_ring_inner_radius = 2
emission_ring_height = 0.4
gravity = Vector3(0, 0, 0)
[sub_resource type="SphereMesh" id="mesh"]
[node name="Root" type="Node3D"]
[node name="Ring" type="GPUParticles3D" parent="."]
amount = 8
lifetime = 2.0
process_material = SubResource("process")
draw_pass_1 = SubResource("mesh")
`);
    const config = await exportConfig(result, null, []);
    // Exercise the compact recipe's delay independently of an animation track.
    config.particleData.systems[0].delay = 0.4;
    for (const Base of [Runtime, MinRuntime]) {
      class Effect extends Base { static config = config; }
      const effect = new Effect();
      effect.updateTime(0.2);
      expect(effect.effectRoot.getObjectByName('Ring__particle_1').visible).toBe(false);
      effect.updateTime(0.4);
      result.updateTime(0);
      compareMeshes(result.scene, effect.effectRoot);
      effect.dispose();
    }
  });
});
