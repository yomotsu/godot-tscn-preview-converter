import { GodotCustomization } from '../src/customization/GodotCustomization.js';
import { describe, expect, it, vi } from 'vitest';
import { Vector4, PointLight, SpotLight, DirectionalLight, Mesh, ShaderMaterial, MeshStandardMaterial, Color, Texture, Group } from 'three';
import { TSCNLoader } from '../src/TSCNLoader.js';

const source=`
[ext_resource type="Shader" path="/custom.gdshader" id="shader"]
[sub_resource type="ShaderMaterial" id="material"]
shader=ExtResource("shader")
[sub_resource type="SphereMesh" id="mesh"]
[node name="Root" type="Node3D"]
[node name="Core" type="MeshInstance3D" parent="."]
mesh=SubResource("mesh")
material_override=SubResource("material")
`;
function loader(){return new TSCNLoader({fetcher:async()=>new Response('shader_type spatial;uniform vec3 primary_color:source_color=vec3(1.0);uniform vec2 noise_scale=vec2(1.0);uniform float emission=2.0;void fragment(){ALBEDO=primary_color;}')});}
describe('Godot customization',()=>{
  it('writes real shader and PBR colors without changing compile hooks or accumulating hue',()=>{
    const root=new Group();
    const material=new ShaderMaterial({uniforms:{primary_color:{value:new Color(1,0,0)}}});
    const core=new Mesh(undefined,material);core.name='Core';root.add(core);
    const particleMaterial=new MeshStandardMaterial({color:0xff0000,map:new Texture(),emissive:0xff0000});
    const originalHook=vi.fn();particleMaterial.onBeforeCompile=originalHook;
    const particle=new Mesh(undefined,particleMaterial);particle.name='Core__particle_1';root.add(particle);
    const customization=new GodotCustomization(root);
    customization.setHueShift(120);
    for(let i=0;i<10;i++)customization.apply();
    expect(material.uniforms.primary_color.value.g).toBeCloseTo(1);
    expect(particleMaterial.color.g).toBeCloseTo(1);
    expect(particleMaterial.emissive.g).toBeCloseTo(1);
    expect(customization.parameters[0].value).toBe('#00ff00');
    expect(particleMaterial.onBeforeCompile).toBe(originalHook);
    expect(material.uniforms.u_godotCustomizationHueShift).toBeUndefined();
    customization.resetHueShift();
    expect(material.uniforms.primary_color.value).toEqual(new Color(1,0,0));
    customization.setParameter('Core:primary_color','#4080ff');
    customization.setHueShift(-180);customization.resetHueShift();
    expect(customization.getOverrides()).toEqual({'Core:primary_color':'#4080ff'});
    expect(material.uniforms.primary_color.value).toEqual(new Color('#4080ff'));
    customization.reset();expect(material.uniforms.primary_color.value).toEqual(new Color(1,0,0));
    expect(()=>customization.setHueShift(NaN)).toThrow();
  });
  it('commits actual colors, preserves HDR and alpha, and reproduces them on a fresh scene',()=>{
    const make=()=>{
      const root=new Group(),material=new ShaderMaterial({uniforms:{tint:{value:new Vector4(4,0.25,0.25,0.4)},noise_scale:{value:new Vector4(1,2,3,4)}}});
      material.userData.godotSourceColorUniforms=['tint'];
      const mesh=new Mesh(undefined,material);mesh.name='Core';root.add(mesh);
      const light=new PointLight();light.name='Light';light.color.setRGB(3,0,0);root.add(light);
      return {material,light,customization:new GodotCustomization(root)};
    };
    const a=make();a.customization.setHueShift(120);a.customization.applyHueShift();
    expect(a.customization.getHueShift()).toBe(0);
    expect(a.material.uniforms.tint.value.y).toBeCloseTo(4);
    expect(a.material.uniforms.tint.value.w).toBe(0.4);
    expect(a.material.uniforms.noise_scale.value.toArray()).toEqual([1,2,3,4]);
    const saved=a.customization.getColorOverrides(),b=make();
    for(const [id,value] of Object.entries(saved))b.customization.setColor(id,value);
    a.material.uniforms.tint.value.set(0,0,0,0);a.light.color.setRGB(0,0,1);
    a.customization.apply();a.customization.resetHueShift();
    expect(a.material.uniforms.tint.value.toArray()).toEqual(b.material.uniforms.tint.value.toArray());
    expect(a.light.color.toArray()).toEqual(b.light.color.toArray());
    const before=a.material.uniforms.tint.value.toArray();a.customization.applyHueShift();
    expect(a.material.uniforms.tint.value.toArray()).toEqual(before);
    saved['Core:tint'][0]=999;expect(a.customization.getColorOverrides()['Core:tint'][0]).not.toBe(999);
    expect(()=>a.customization.setColor('Core:tint',[1,2,3])).toThrow();
    a.customization.reset();expect(a.material.uniforms.tint.value.toArray()).toEqual([4,0.25,0.25,0.4]);
    expect(a.customization.getColorOverrides()).toEqual({});
  });
  it('allows individual editing of shared part colors after applying Hue',()=>{
    const root=new Group(),material=new ShaderMaterial({uniforms:{tint:{value:new Color(1,0,0)}}});
    for(const name of ['Core','Shared']){const mesh=new Mesh(undefined,material);mesh.name=name;root.add(mesh);}
    const customization=new GodotCustomization(root);
    customization.setHueShift(120);customization.applyHueShift();
    customization.setParameter('Shared:tint','#0000ff');customization.apply();
    expect(material.uniforms.tint.value).toEqual(new Color('#0000ff'));
    expect(customization.parameters.map(p=>p.value)).toEqual(['#0000ff','#0000ff']);
    expect(customization.getColorOverrides()).toEqual({});
    customization.setHueShift(120);customization.applyHueShift();customization.apply();
    expect(material.uniforms.tint.value.r).toBeCloseTo(1);
    expect(customization.getOverrides()).toEqual({});
  });
  it('shifts asset lights without accumulating or changing preview lights and restores animated colors',()=>{
    const preview=new Group(),root=new Group(),outside=new PointLight(0xff0000);preview.add(root,outside);
    const lights=[new PointLight(),new SpotLight(),new DirectionalLight()];
    for(const [index,light] of lights.entries()){light.name=`Light${index}`;light.color.setRGB(3,0.25,0.25);light.intensity=5;root.add(light);}
    const customization=new GodotCustomization(root);
    customization.setHueShift(120);
    for(let i=0;i<10;i++)customization.apply();
    for(const light of lights){expect(light.color.r).toBeCloseTo(0.25);expect(light.color.g).toBeCloseTo(3);expect(light.color.b).toBeCloseTo(0.25);expect(light.intensity).toBe(5);}
    expect(outside.color.getHexString()).toBe('ff0000');
    lights[0].color.setRGB(0,0,2);customization.apply();
    expect(lights[0].color.r).toBeCloseTo(2);expect(lights[0].color.b).toBeCloseTo(0);
    customization.resetHueShift();expect(lights[0].color.toArray()).toEqual([0,0,2]);
    customization.setHueShift(-120);customization.dispose();
    expect(lights[0].color.toArray()).toEqual([3,0.25,0.25]);
  });
  it('forwards shifted lights to Godot shaders without inserting a rendering color filter',async()=>{
    const result=await loader().parseAsync(source+'\n[node name="Light" type="OmniLight3D" parent="."]\nlight_color=Color(1,0,0,1)\nlight_energy=2\n');
    const material=(result.scene.getObjectByName('Core') as Mesh).material as ShaderMaterial;
    result.customization.setHueShift(120);result.updateTime(0.5);
    const color=material.uniforms.u_lightColor.value[0] as Color;
    expect(color.r).toBeCloseTo(0);expect(color.g).toBeGreaterThan(0);expect(color.b).toBeCloseTo(0);
    expect(material.fragmentShader).not.toContain('godotCustomizationRotateHue');
    result.customization.resetHueShift();result.updateTime(1);
    expect(color.r).toBeGreaterThan(0);expect(color.g).toBeCloseTo(0);
  });
  it('replaces texture uniforms and restores originals without disposing caller textures',async()=>{
    const root=new Group(),material=new ShaderMaterial({uniforms:{noise_texture:{value:new Texture()}}});
    const original=material.uniforms.noise_texture.value;original.name='Original';const mesh=new Mesh(undefined,material);mesh.name='Core';root.add(mesh);
    const customization=new GodotCustomization(root),replacement=new Texture();
    expect(customization.parameters[0].type).toBe('texture');
    await customization.setTexture('Core:noise_texture',replacement,'/godot/custom/noise.png');
    customization.apply();expect(material.uniforms.noise_texture.value).toBe(replacement);
    expect(customization.getTextureOverrides()).toEqual({'Core:noise_texture':'/godot/custom/noise.png'});
    customization.reset();expect(material.uniforms.noise_texture.value).toBe(original);
    expect(customization.getTextureOverrides()).toEqual({});
  });
  it('exposes shader parameters and persists edited color/vector values across updates',async()=>{
    const result=await loader().parseAsync(source);
    expect(result.customization.parameters.map(p=>p.id)).toEqual(['Core:primary_color','Core:noise_scale','Core:emission']);
    result.customization.setParameter('Core:primary_color','#4080ff');
    result.customization.setParameter('Core:noise_scale',[3,4]);
    const material=(result.scene.getObjectByName('Core') as Mesh).material as ShaderMaterial;
    material.uniforms.noise_scale.value.set(0,0);
    result.updateTime(1);
    expect(material.uniforms.noise_scale.value.toArray()).toEqual([3,4]);
    expect(material.uniforms.primary_color.value).toEqual(new Color('#4080ff'));
    const overrides=result.customization.getOverrides();
    (overrides['Core:noise_scale'] as number[])[0]=99;
    expect(result.customization.getOverrides()['Core:noise_scale']).toEqual([3,4]);
    result.customization.reset();result.updateTime(2);
    expect(material.uniforms.noise_scale.value.toArray()).toEqual([1,1]);
    expect(result.customization.getOverrides()).toEqual({});
  });
  it('rejects invalid values and uses stable IDs on a new load',async()=>{
    const a=await loader().parseAsync(source),b=await loader().parseAsync(source);
    expect(a.customization.parameters.map(p=>p.id)).toEqual(b.customization.parameters.map(p=>p.id));
    for(const [id,value] of [['Core:noise_scale',[1]],['Core:emission',NaN],['Core:primary_color','bad'],['missing',1]] as const){
      expect(()=>a.customization.setParameter(id,value as any)).toThrow();
    }
  });
});
