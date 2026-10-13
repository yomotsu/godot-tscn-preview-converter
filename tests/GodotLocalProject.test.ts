import { describe, it, expect } from 'vitest';
import { GodotLocalProject } from '../src/resources/GodotLocalProject.js';
import { GodotResourceResolver } from '../src/resources/GodotResourceResolver.js';
import { TSCNLoader } from '../src/TSCNLoader.js';

const file = (path:string,text:string) => ({path,file:new Blob([text])});
describe('Dropped Godot projects',()=>{
  it('maps an asset-only folder to its original res paths and discovers effects first',async()=>{
    let count=0;const revoked:string[]=[];
    const project=await GodotLocalProject.create([
      file('BinbunVFX_Vol2/DarkMagicFX/effects/球.tscn','[gd_scene format=3 uid="uid://scene"]\n[ext_resource type="Shader" path="res://assets/BinbunVFX_Vol2/DarkMagicFX/shader/ball.gdshader" uid="uid://shader" id="s"]\n[node name="Root" type="Node3D"]'),
      file('BinbunVFX_Vol2/DarkMagicFX/shader/ball.gdshader','shader_type spatial;'),
      file('BinbunVFX_Vol2/demo.tscn','[gd_scene format=3]\n[node name="Demo" type="Node3D"]'),
      file('BinbunVFX_Vol2/.godot/cache.tscn','not a scene'),
    ],()=>`blob:local-${++count}`,url=>revoked.push(url));
    expect(project.warnings).toEqual([]);
    expect(project.scenes).toHaveLength(2);
    expect(project.scenes[0].effect).toBe(true);
    expect(project.resourceMap['uid://scene']).toBe('blob:local-1');
    expect(project.resourceMap['res://assets/BinbunVFX_Vol2/DarkMagicFX/shader/ball.gdshader']).toBe('blob:local-2');
    expect(project.resourceMap['uid://shader']).toBe('blob:local-2');
    project.dispose();project.dispose();expect(revoked).toHaveLength(3);
  });
  it('maps omitted assets/ roots and loads OBJ geometry from Godot scenes',async()=>{
    const project=await GodotLocalProject.create([
      file('BinbunVFX/magic_projectiles/effects/test.tscn','[gd_scene format=3]\n[ext_resource type="ArrayMesh" path="res://assets/BinbunVFX/shared/mesh.obj" id="mesh"]\n[node name="Root" type="Node3D"]\n[node name="Imported" type="MeshInstance3D" parent="."]\nmesh=ExtResource("mesh")'),
      file('BinbunVFX/shared/mesh.obj','o Triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'),
    ]);
    expect(project.warnings).toEqual([]);
    expect(project.resourceMap['res://assets/BinbunVFX/shared/mesh.obj']).toBeDefined();
    const loader=new TSCNLoader({resourceMap:project.resourceMap,fetcher:project.fetcher});
    const result=await loader.loadAsync(project.scenes[0].path);
    const object=result.scene.getObjectByName('Imported');
    expect(object).toBeDefined();
    expect(object!.getObjectByProperty('isMesh',true)).toBeDefined();
    expect(result.warnings).toEqual([]);
    project.dispose();
  });
  it('indexes standalone tres resources and their UID without requiring a scene node',async()=>{
    const project=await GodotLocalProject.create([file('Pack/material.tres','[gd_resource type="StandardMaterial3D" format=3 uid="uid://mat"]\n[resource]\nroughness=0.5')],()=> 'blob:mat',()=>{});
    expect(project.warnings).toEqual([]);expect(project.resourceMap['uid://mat']).toBe('blob:mat');project.dispose();
  });
  it('resolves relative references even when the owner is a blob URL',()=>{
    const resolver=new GodotResourceResolver({resourceMap:{'res://assets/Pack/scenes/main.tscn':'blob:scene','res://assets/Pack/shader/a.gdshader':'blob:shader','res://assets/Pack/shader/魔法.gdshader':'blob:unicode'}});
    expect(resolver.resolvePath('../shader/a.gdshader','blob:scene')).toBe('blob:shader');
    expect(resolver.resolvePath('../shader/魔法.gdshader','blob:scene')).toBe('blob:unicode');
  });
  it('appends effect folders and dependencies without losing existing scenes or changing IDs',async()=>{
    let counter=0;const url=()=>`blob:${++counter}`,revoke=()=>{};
    const base=await GodotLocalProject.create([file('PackA/effects/one.tscn','[node name="One" type="Node3D"]')],url,revoke);
    const added=await base.append([
      file('PackB/effects/two.tscn','[ext_resource type="Shader" path="res://assets/PackB/shader/fire.gdshader" id="shader"]\n[node name="Two" type="Node3D"]'),
      file('PackB/shader/fire.gdshader','shader_type spatial;'),
    ],url,revoke);
    expect(added.scenes.map(s=>s.id)).toEqual(['effects/one.tscn','effects/two.tscn']);
    expect(added.warnings).toEqual([]);
    expect(added.resourceMap['res://assets/PackB/shader/fire.gdshader']).toBeTruthy();
    const withLoose=await added.append([file('extra.tscn','[node name="Extra" type="Node3D"]')],url,revoke);
    expect(withLoose.scenes.map(s=>s.id)).toContain('effects/one.tscn');expect(withLoose.scenes).toHaveLength(3);
    base.dispose();added.dispose();withLoose.dispose();
  });
  it('fills a missing dependency later and replaces a matching existing file',async()=>{
    let counter=0;const url=()=>`blob:${++counter}`,revoke=()=>{};
    const base=await GodotLocalProject.create([file('effects/main.tscn','[ext_resource type="Shader" path="res://shader/noise.gdshader" id="s"]\n[node name="Root" type="Node3D"]')],url,revoke,true);
    expect(base.warnings).toHaveLength(1);
    const added=await base.append([file('shader/noise.gdshader','shader_type spatial;')],url,revoke);
    expect(added.warnings).toEqual([]);
    const replaced=await added.append([file('main.tscn','[node name="New" type="Node3D"]')],url,revoke);
    expect(replaced.scenes).toHaveLength(1);expect(replaced.scenes[0].id).toBe('effects/main.tscn');
    expect(await replaced.files.find(f=>f.path==='effects/main.tscn')!.file.text()).toContain('New');
    base.dispose();added.dispose();replaced.dispose();
  });

  it('resolves nested shader includes from their physical owner regardless of alias indexing order',async()=>{
    const project=await GodotLocalProject.create([
      file('Pack/shared/util/alpha.gdshaderinc','#include "dithering.gdshaderinc"\nfloat alphaValue(){return ditherValue();}'),
      file('Pack/shared/util/dithering.gdshaderinc','float ditherValue(){return 1.0;}'),
      file('Pack/shared/main.gdshader','#include "util/alpha.gdshaderinc"\nshader_type spatial;'),
      file('Pack/main.tscn','[ext_resource type="Shader" path="res://assets/shared/main.gdshader" id="s"]\n[node name="Root" type="Node3D"]'),
    ]);
    const resolver=new GodotResourceResolver({resourceMap:project.resourceMap,fetcher:project.fetcher,resourceMapResolver:(path,owner)=>project.resolveResourcePath(path,owner)});
    const shader=await resolver.loadShaderSource('res://assets/shared/main.gdshader');
    expect(shader).toContain('float ditherValue()');
    expect(shader).not.toContain('#include');
    project.dispose();
  });

  it('reports missing files without fetching server assets',async()=>{
    const project=await GodotLocalProject.create([file('Pack/main.tscn','[gd_scene format=3]\n[ext_resource type="Shader" path="res://missing.gdshader" id="s"]\n[node name="Root" type="Node3D"]')],()=> 'blob:test',()=>{});
    expect(project.warnings[0]).toContain('res://missing.gdshader');
    expect((await project.fetcher('/missing.gdshader')).status).toBe(404);
    project.dispose();
  });
});
