import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AnimationMixer, Group, Mesh, ShaderMaterial, SpotLight, Vector3 } from 'three';
import { TSCNLoader } from '../src/TSCNLoader.js';

describe('TSCNLoader integration', () => {
  it('converts Transform3D and parent paths into a three.js hierarchy', async () => {
    const loader = new TSCNLoader();
    const result = await loader.parseAsync(`
[sub_resource type="BoxMesh" id="box"]
size = Vector3(2, 3, 4)
[node name="Root" type="Node3D"]
[node name="Child" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7)
mesh = SubResource("box")
[node name="Nested" type="Node3D" parent="Child"]
`);
    const child = result.scene.getObjectByName('Child');
    expect(child).toBeInstanceOf(Mesh);
    expect(child?.position.toArray()).toEqual([5, 6, 7]);
    expect(result.scene.getObjectByName('Nested')?.parent).toBe(child);
  });

  it('reads serialized matrix rows so Godot downward spotlights remain downward',async()=>{
    const result=await new TSCNLoader().parseAsync(`
[node name="Root" type="Node3D"]
[node name="Spot" type="SpotLight3D" parent="."]
transform=Transform3D(1,0,0,0,0,1,0,-1,0,0,5,0)
[node name="NumericBasis" type="Node3D" parent="."]
basis=Basis(1,0,0,0,0,1,0,-1,0)
[node name="AxisBasis" type="Node3D" parent="."]
basis=Basis(Vector3(1,0,0),Vector3(0,0,-1),Vector3(0,1,0))
`);
    result.scene.updateMatrixWorld(true);
    const spot=result.scene.getObjectByName('Spot') as SpotLight;
    const direction=spot.target.getWorldPosition(new Vector3()).sub(spot.getWorldPosition(new Vector3())).normalize();
    expect(direction.x).toBeCloseTo(0);expect(direction.y).toBeCloseTo(-1);expect(direction.z).toBeCloseTo(0);
    for(const name of ['NumericBasis','AxisBasis']) {
      const axis=new Vector3(0,0,-1).applyQuaternion(result.scene.getObjectByName(name)!.quaternion);
      expect(axis.y).toBeCloseTo(-1);
    }
  });

  it('loads the repository ground explosion scene and its VFX shader resources', async () => {
    const scenePath = new URL('../examples/assets/ExplosionFX/effects/ground/vfx_ground_explosion_01.tscn', import.meta.url);
    const source = await readFile(scenePath, 'utf8');
    const loader = new TSCNLoader({
      resourcePath: '/godot/',
      fetcher: async (input) => {
        const url = String(input);
        const prefix = '/godot/assets/BinbunVFX_Vol2/';
        if (!url.startsWith(prefix)) return new Response('Not found', { status: 404 });
        try { return new Response(await readFile(new URL(url.slice(prefix.length), new URL('../', import.meta.url)), 'utf8')); }
        catch { return new Response('Not found', { status: 404 }); }
      },
    });
    const result = await loader.parseAsync(source, '/godot/assets/BinbunVFX_Vol2/examples/assets/ExplosionFX/effects/ground/vfx_ground_explosion_01.tscn');
    expect(result.scene).toBeInstanceOf(Group);
    expect(result.scene.getObjectByName('Core')).toBeDefined();
    expect(result.scene.getObjectByName('Rings')).toBeInstanceOf(Mesh);
    const coreMaterial = (result.scene.getObjectByName('Core') as Mesh).material as ShaderMaterial;
    expect(coreMaterial).toBeInstanceOf(ShaderMaterial);
    expect(coreMaterial.vertexShader).toContain('noise_texture');
    expect(coreMaterial.vertexShader).toContain('godotVertex');
    expect(coreMaterial.fragmentShader).toContain('u_time');
    expect(result.animations.some((clip) => clip.name === 'main')).toBe(true);
    expect(result.resources.has('SubResource:SphereMesh_wqpyr')).toBe(true);
    expect(result.warnings).toEqual([]);
    const smokeParticle = result.scene.getObjectByName('Smoke__particle_1');
    expect(smokeParticle).toBeDefined();
    const mixer = new AnimationMixer(result.scene);
    mixer.clipAction(result.animations.find((clip) => clip.name === 'main')!).play();
    mixer.update(0);
    result.updateTime(0);
    const initialPosition = smokeParticle!.position.clone();
    mixer.update(0.3);
    result.updateTime(0.3);
    expect(smokeParticle!.visible).toBe(true);
    expect(smokeParticle!.position.distanceTo(initialPosition)).toBeGreaterThan(0.01);
    const material=(smokeParticle as Mesh).material as ShaderMaterial;
    expect(material.uniforms.u_particleColor.value.w).toBeLessThan(1);
    expect(result.scene.children.filter(o=>o.name.startsWith('Smoke__particle_'))).toHaveLength(32);
    const trail=result.scene.getObjectByName('Shrapnel__particle_1') as Mesh;
    const initialTrail=Array.from(trail.geometry.getAttribute('position').array);
    mixer.update(.3);result.updateTime(.6);
    expect(Array.from(trail.geometry.getAttribute('position').array)).not.toEqual(initialTrail);
    expect(result.scene.children.filter(o=>o.name.startsWith('BitsTrail__particle_') && o.visible).length).toBeGreaterThan(0);
    mixer.setTime(0);result.updateTime(0);
    expect(smokeParticle!.position.distanceTo(initialPosition)).toBeLessThan(.0001);
  });
});

describe('All bundled effects', () => {
  it.each(['air', 'nuke'])('loads and animates the %s explosion without conversion warnings', async (kind) => {
    const loader = new TSCNLoader({
      resourcePath: '/godot/',
      fetcher: async input => {
        const relative = String(input).replace('/godot/assets/BinbunVFX_Vol2/', '');
        try { return new Response(await readFile(new URL(relative, new URL('../', import.meta.url)), 'utf8')); }
        catch { return new Response('Not found', { status: 404 }); }
      },
    });
    const result = await loader.loadAsync(`/godot/assets/BinbunVFX_Vol2/examples/assets/ExplosionFX/effects/${kind}/vfx_${kind}_explosion_01.tscn`);
    expect(result.warnings).toEqual([]);
    const main = result.animations.find(c => c.name === 'main')!;
    expect(main).toBeDefined();
    const mixer = new AnimationMixer(result.scene);
    mixer.clipAction(main).play();mixer.update(0);result.updateTime(0);
    mixer.update(.6);result.updateTime(.6);
    expect(result.scene.children.some(o => o.visible && o.name.includes('__particle_'))).toBe(true);
    if (kind === 'nuke') {
      const mesh = result.scene.getObjectByName('MeshInstance3D') as Mesh;
      expect(mesh.quaternion.toArray().every(Number.isFinite)).toBe(true);
      expect(Math.abs(mesh.quaternion.x)).toBeCloseTo(1);
      expect(mesh.scale.x).toBeGreaterThan(0);
      expect(main.tracks.some(t => t.name === mesh.uuid+'.quaternion')).toBe(true);
    }
  });
});

describe('Instanced scenes',()=>{
  it('reads header instances, preserves both copies and binds animations to each copy',async()=>{
    const child=`[gd_scene format=3]
[sub_resource type="BoxMesh" id="mesh"]
[sub_resource type="Animation" id="anim"]
length=1.0
tracks/0/type="value"
tracks/0/path=NodePath("Mesh:position")
tracks/0/keys={"times":PackedFloat32Array(0,1),"values":[Vector3(0,0,0),Vector3(0,2,0)]}
[sub_resource type="AnimationLibrary" id="lib"]
_data={"open":SubResource("anim")}
[node name="Effect" type="Node3D"]
[node name="Mesh" type="MeshInstance3D" parent="."]
mesh=SubResource("mesh")
[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
libraries/=SubResource("lib")`;
    const loader=new TSCNLoader({fetcher:async()=>new Response(child)});
    const result=await loader.parseAsync(`[gd_scene format=3]
[ext_resource type="PackedScene" path="res://effect.tscn" id="effect"]
[node name="Root" type="Node3D"]
[node name="A" parent="." instance=ExtResource("effect")]
[node name="B" parent="." instance=ExtResource("effect")]
position=Vector3(5,0,0)`);
    expect(result.warnings).toEqual([]);
    expect(result.scene.getObjectByName('A')?.children).toHaveLength(2);
    expect(result.scene.getObjectByName('B')?.position.x).toBe(5);
    const mixer=new AnimationMixer(result.scene);
    for(const clip of result.animations)mixer.clipAction(clip).play();
    mixer.update(.5);
    expect(result.scene.getObjectByName('A')?.getObjectByName('Mesh')?.position.y).toBeCloseTo(1);
    expect(result.scene.getObjectByName('B')?.getObjectByName('Mesh')?.position.y).toBeCloseTo(1);
    expect(result.animations[0].tracks[0].name).not.toBe(result.animations[1].tracks[0].name);
  });
});
