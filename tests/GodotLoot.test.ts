import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Mesh, ShaderMaterial, Vector3 } from 'three';
import { TSCNLoader } from '../src/TSCNLoader.js';
import { GodotResourceResolver } from '../src/resources/GodotResourceResolver.js';
import { GodotLocalProject } from '../src/resources/GodotLocalProject.js';
import { GodotMeshConverter } from '../src/converters/GodotMeshConverter.js';

it('expands nested shader includes, ignores commented includes and detects cycles', async () => {
  const sources: Record<string,string> = {
    '/pack/main.gdshader':'shader_type spatial;\n// #include "missing"\n#include "util/a.gdshaderinc"\nvoid fragment(){ALBEDO=vec3(helper());}',
    '/pack/util/a.gdshaderinc':'#include "b.gdshaderinc"\nfloat helper(){return VALUE;}',
    '/pack/util/b.gdshaderinc':'const float VALUE=1.0;',
    '/pack/cycle.gdshader':'#include "cycle.gdshader"',
  };
  const resolver = new GodotResourceResolver({fetcher:async input=>new Response(sources[String(input)],{status:sources[String(input)] ? 200 : 404})});
  const source = await resolver.loadShaderSource('/pack/main.gdshader');
  expect(source).toContain('float helper()');expect(source).toContain('const float VALUE');expect(source).not.toContain('#include');
  await expect(resolver.loadShaderSource('/pack/cycle.gdshader')).rejects.toThrow('include cycle');
});

it('resolves relative include aliases in a dropped BinbunVFX folder', async () => {
  const file=(path:string,source:string)=>({path:'BinbunVFX/'+path,file:new Blob([source])});
  const project=await GodotLocalProject.create([
    file('loot_effects/a.tscn','[ext_resource type="Shader" path="res://assets/BinbunVFX/loot_effects/src/shader/a.gdshader" id="s"]\n[node name="Root" type="Node3D"]'),
    file('loot_effects/src/shader/a.gdshader','shader_type spatial;\n#include "../../../shared/shader/util/a.gdshaderinc"'),
    file('shared/shader/util/a.gdshaderinc','float helper(){return 1.0;}'),
  ]);
  expect(project.warnings).toEqual([]);
  const resolver=new GodotResourceResolver({resourceMap:project.resourceMap,fetcher:project.fetcher});
  expect(await resolver.loadShaderSource('res://assets/BinbunVFX/loot_effects/src/shader/a.gdshader')).toContain('float helper()');
  project.dispose();
});

it('converts Godot torus inner/outer radii to an XZ ring',()=>{
  const geometry=new GodotMeshConverter().convert({type:'sub_resource',id:'ring',resourceType:'TorusMesh',line:1,attributes:{},properties:{inner_radius:.15,outer_radius:.3,rings:32,ring_segments:8}},()=>{} )!;
  geometry.computeBoundingBox();const bounds=geometry.boundingBox!;
  expect(bounds.max.x).toBeCloseTo(.3);expect(bounds.max.z).toBeCloseTo(.3);expect(bounds.max.y).toBeCloseTo(.075);
});

// The requested third party pack stays outside the repository; skip when unavailable.
const root=process.env.BINBUN_VFX_ROOT ?? '';
describe.skipIf(!root || !existsSync(root))('Actual Binbun Loot FX',()=>{
  it('loads all twelve effects with included shaders and animated particles',async()=>{
    const loader=new TSCNLoader({resourcePath:'/godot/',fetcher:async input=>{
      const path=String(input).replace('/godot/assets/BinbunVFX/',root+'/');
      try{return new Response(new Uint8Array(await readFile(path)));}catch{return new Response('missing',{status:404});}
    }});
    for(const folder of ['floating','ground'])for(const name of await readdir(root+'/loot_effects/effects/'+folder)){
      if(!name.endsWith('.tscn'))continue;
      const result=await loader.loadAsync('/godot/assets/BinbunVFX/loot_effects/effects/'+folder+'/'+name);
      expect(result.warnings,name).toEqual([]);
      const ring=result.scene.getObjectByName('Ring_01') as Mesh;
      expect(ring.geometry.type).toBe('TorusGeometry');
      const material=ring.material as ShaderMaterial;
      expect(material.fragmentShader).toContain('shift_hue');
      expect(material.fragmentShader).not.toContain('gdshaderinc');
      result.updateTime(.2);
      const particles:Mesh[]=[];result.scene.traverse(o=>{if(o.name.includes('__particle_'))particles.push(o as Mesh);});
      const before=particles.map(p=>p.position.clone());result.updateTime(.7);
      expect(particles.some((p,i)=>p.position.distanceTo(before[i])>1e-6),name).toBe(true);
      expect(material.uniforms.u_time.value).toBe(.7);
      const particleMaterial=particles[0].material as ShaderMaterial;
      expect(particleMaterial.vertexShader).toContain('u_instanceId');
      expect(particleMaterial.vertexShader).not.toMatch(/\bINSTANCE_ID\b/);
      expect(particles[0].position.distanceTo(new Vector3())).toBeGreaterThan(0);
    }
  },20000);
});
