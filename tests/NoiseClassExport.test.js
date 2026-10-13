import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import FastNoiseLite from '../src/vendor/FastNoiseLite.ts';
import { createGodotNoiseTextureDataGenerator } from '../src/converters/GodotNoiseTexture.ts';
import { buildSceneData } from '../src/app/three-class/export.js';
import { AbstractVFXMesh as SourceRuntime } from '../src/app/three-class/AbstractVFXMesh.js';
import { AbstractVFXMesh as MinRuntime } from '../dist/three-class/AbstractVFXMesh.min.js';

const generateNoise = createGodotNoiseTextureDataGenerator(FastNoiseLite);

describe('compressed runtime noise texture parity', () => {
  for (let noiseType = 0; noiseType < 6; noiseType++) {
    for (let domainWarpType = 0; domainWarpType < 3; domainWarpType++) {
      it(`preserves every pixel for noise=${noiseType}, warp=${domainWarpType}`, () => {
        const recipe = {
          width: 19, height: 17, seed: -731, frequency: 0.17,
          octaves: 3, lacunarity: 2.1, gain: 0.45, noiseType,
          fractalType: (noiseType + domainWarpType) % 4,
          weightedStrength: 0.25, pingPongStrength: 2.3,
          cellularDistanceFunction: domainWarpType,
          cellularReturnType: noiseType, cellularJitter: 0.9,
          invert: true, normalMap: domainWarpType === 1,
          seamless: true, seamlessBlendSkirt: 0.25,
          normalize: true, generateMipmaps: false, bumpStrength: 8,
          domainWarpEnabled: true, domainWarpFrequency: 0.13,
          domainWarpType, domainWarpAmplitude: 12,
          domainWarpFractalType: domainWarpType,
          domainWarpFractalOctaves: 3, domainWarpFractalLacunarity: 2,
          domainWarpFractalGain: 0.5, offset: [-37.125, 19.75], ramp: null,
        };
        const expected = generateNoise(recipe);
        const texture = new THREE.DataTexture(expected, recipe.width, recipe.height);
        texture.userData.godotNoiseTexture = recipe;
        const scene = new THREE.Group();
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: texture })));
        const sceneData = buildSceneData(scene, [], null);
        expect(sceneData.images[0].url.encoding).toBe('godot-noise');
        for (const Base of [SourceRuntime, MinRuntime]) {
          class Effect extends Base { static config = { sceneData, features: {} }; }
          const effect = new Effect();
          try {
            const restored = effect.effectRoot.children[0].material.map.image;
            expect(restored.width).toBe(recipe.width);
            expect(restored.height).toBe(recipe.height);
            expect(Array.from(restored.data)).toEqual(Array.from(expected));
          } finally { effect.dispose(); }
        }
        scene.children[0].geometry.dispose(); scene.children[0].material.dispose(); texture.dispose();
      });
    }
  }
});
