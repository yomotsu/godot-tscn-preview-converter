import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AbstractVFXMesh } from '../src/app/three-class/runtime.js';
import { buildSceneData, exportThreeClass, restoreGodotGeometryDrawRanges } from '../src/app/three-class/export.js';

function unpackGeometryBuffers(data) {
  for (const geometry of data.geometries ?? []) {
    const buffers = [...Object.values(geometry.data?.attributes ?? {}), geometry.data?.index];
    for (const buffer of buffers) {
      if (buffer?.encoding !== 'base64') continue;
      const binary = atob(buffer.array);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      buffer.array = bytes.buffer;
      delete buffer.encoding;
    }
  }
}

describe('three-class export', () => {
  it('preserves empty emitter draw ranges without hiding their particle meshes', () => {
    const root = new THREE.Group();
    const emitterGeometry = new THREE.SphereGeometry(1, 8, 6);
    emitterGeometry.setDrawRange(0, 0);
    const emitter = new THREE.Mesh(emitterGeometry, new THREE.MeshBasicMaterial());
    emitter.name = 'Smoke';
    root.add(emitter);

    const particle = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial());
    particle.name = 'Smoke__particle_1';
    particle.visible = false;
    root.add(particle);

    const data = buildSceneData(root, [], null);
    const emitterData = data.geometries?.find(geometry => geometry.uuid === emitterGeometry.uuid);
    expect(emitterData.userData.godotDrawRange).toEqual([0, 0]);

    unpackGeometryBuffers(data);
    const restored = new THREE.ObjectLoader().parse(data);
    restoreGodotGeometryDrawRanges(restored);

    expect(restored.getObjectByName('Smoke')?.geometry.drawRange).toEqual({ start: 0, count: 0 });
    expect(restored.getObjectByName('Smoke__particle_1')?.geometry.drawRange.count).toBe(Infinity);
    expect(restored.getObjectByName('Smoke__particle_1')?.visible).toBe(false);
    expect(restored.getObjectByName('Smoke')?.geometry.userData.godotDrawRange).toBeUndefined();
  });

  it('embeds draw-range restoration in the exported class', async () => {
    const root = new THREE.Group();
    const emitterGeometry = new THREE.SphereGeometry(1, 8, 6);
    emitterGeometry.setDrawRange(0, 0);
    const emitter = new THREE.Mesh(emitterGeometry, new THREE.MeshBasicMaterial());
    emitter.name = 'Smoke';
    root.add(emitter);

    let classBlob;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      classBlob = blob;
      return 'blob:three-class-export-test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('Terser', { minify: async source => ({ code: source }) });
    vi.stubGlobal('document', { createElement: () => ({ click() {} }) });

    try {
      await exportThreeClass({
        target: 'webgl',
        effect: { id: 'vfx_ground_explosion_01', name: '地上爆発' },
        entry: { result: { scene: root, updateTime() {}, particleRuntimeData: { systems: [] } }, mixer: null, actions: [] },
        actions: [],
      });
      const source = await classBlob.text();
      expect(source).toContain("import { AbstractVFXMesh } from './AbstractVFXMesh.min.js'");
      expect(source).not.toContain('previewView');
      const packed = JSON.parse(source.match(/const PACKED_DATA = (.*);/)[1]);
      const keys = JSON.parse(source.match(/const DATA_KEY_MAP = (.*);/)[1]);
      const features = JSON.parse(source.match(/const FEATURES = (.*);/)[1]);
      class Effect extends AbstractVFXMesh {
        static config = { ...AbstractVFXMesh.decodeDataKeys(packed, keys), features };
      }
      const effect = new Effect();
      expect(effect.effectRoot.getObjectByName('Smoke').geometry.drawRange.count).toBe(0);
      effect.dispose();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
