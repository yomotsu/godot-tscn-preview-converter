import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GodotCurveConverter, sampleGradient } from '../src/converters/GodotCurveConverter.ts';
import { buildSceneData } from '../src/app/three-class/export.js';
import { AbstractVFXMesh as Runtime } from '../src/app/three-class/runtime.js';
import { AbstractVFXMesh as MinRuntime } from '../dist/three-class/AbstractVFXMesh.min.js';

const resource = (resourceType, properties) => ({ resourceType, properties, id: 'gradient', type: 'sub_resource', attributes: {}, line: 1 });
const call = (name, ...args) => ({ kind: 'call', name, args });

describe('procedural gradient class export', () => {
  for (const hdr of [false, true]) for (const interpolationMode of [0, 1]) it(`preserves radial gradient pixels and texture settings (HDR=${hdr}, interpolation=${interpolationMode})`, async () => {
    const gradient = resource('Gradient', {
      interpolation_mode: interpolationMode,
      offsets: call('PackedFloat32Array', 0, 0.4, 1),
      colors: call('PackedColorArray', 0, 0.2, 2, 0, 2, 0.7, 0, 0.8, 0.3, 0.1, 0.5, 1),
    });
    const texture = await new GodotCurveConverter().convertGradientTexture2D(resource('GradientTexture2D', {
      gradient: 'gradient', width: 17, height: 9, fill: 1, use_hdr: hdr,
      fill_from: call('Vector2', 0.5, 0.5), fill_to: call('Vector2', 0.5, 1),
    }), async () => gradient);
    const original = Array.from(texture.image.data);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShaderMaterial({ uniforms: { mask: { value: texture } } })));
    const data = buildSceneData(root, [], null);
    expect(data.images[0].url.encoding).toBe('godot-gradient');
    expect(data.images[0].url.data).toBeUndefined();
    for (const Base of [Runtime, MinRuntime]) {
      class Effect extends Base { static config = { sceneData: data, features: {} }; }
      const effect = new Effect();
      const restored = effect.effectRoot.children[0].material.uniforms.mask.value;
      expect(Array.from(restored.image.data)).toEqual(original);
      expect(restored.image.data.constructor).toBe(hdr ? Float32Array : Uint8Array);
      expect(restored.flipY).toBe(texture.flipY);
      expect(restored.minFilter).toBe(texture.minFilter);
      effect.dispose();
    }
  });

  it('keeps default gradients horizontal and matches the existing gradient sampler', async () => {
    const gradient = resource('Gradient', {});
    const texture = await new GodotCurveConverter().convertGradientTexture2D(resource('GradientTexture2D', { gradient: 'gradient' }), async () => gradient);
    expect([texture.image.width, texture.image.height]).toEqual([64, 64]);
    for (let x = 0; x < 64; x++) {
      const expected = sampleGradient(gradient, x / 63).toArray().map(value => Math.round(value * 255));
      expect(Array.from(texture.image.data.slice(x * 4, x * 4 + 4))).toEqual(expected);
      expect(Array.from(texture.image.data.slice((63 * 64 + x) * 4, (63 * 64 + x) * 4 + 4))).toEqual(expected);
    }
  });

  it('keeps baked pixels from older previews with incomplete gradient metadata', () => {
    const texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
    texture.userData.godotGradientTexture = { fill: 'linear', from: [0, 0], to: [1, 0] };
    const root = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: texture }));
    expect(buildSceneData(root, [], null).images[0].url.encoding).toBe('base64');
  });
});
