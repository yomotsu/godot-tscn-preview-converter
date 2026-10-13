import { describe,it,expect } from 'vitest';
import { Color,FogExp2,Scene,Texture,Mesh,SpotLight,ShaderMaterial,Vector3 } from 'three';
import { TSCNLoader } from '../src/TSCNLoader.js';
import { GodotEnvironmentConverter } from '../src/converters/GodotEnvironmentConverter.js';
import { call } from '../src/tscn/types.js';
describe('Godot environments',()=>{
  it('converts sky rotation, exposure and fog and applies them to a Scene',async()=>{
    const texture=new Texture(),resources=new Map<string,unknown>([
      ['sky',{resourceType:'Sky',properties:{sky_material:'mat'}}],
      ['mat',{resourceType:'PanoramaSkyMaterial',properties:{panorama:'hdr',energy_multiplier:.5}}],['hdr',texture],
    ]);
    const warnings:string[]=[];
    const object=await new GodotEnvironmentConverter().convert({type:'sub_resource',line:1,attributes:{},id:'env',resourceType:'Environment',properties:{sky:'sky',background_mode:2,sky_rotation:call('Vector3',0,1,0),tonemap_exposure:1.2,tonemap_mode:3,fog_enabled:true,fog_sky_affect:0,fog_density:.03}},async key=>resources.get(String(key)),w=>warnings.push(w));
    const settings=GodotEnvironmentConverter.find(object)!;
    const scene=new Scene();GodotEnvironmentConverter.apply(scene,settings);
    expect(scene.background).toBe(texture);expect(scene.environmentIntensity).toBe(.5);
    expect(scene.backgroundRotation.y).toBe(1);expect(settings.exposure).toBe(1.2);
    expect(settings.fog!.density).toBe(.03);expect(warnings).toEqual([]);
  });

  it('aims spotlights along Godot local -Z and updates spatial shader cone uniforms',async()=>{
    const result=await new TSCNLoader().parseAsync('[node name="Root" type="Node3D"]\n[node name="Spot" type="SpotLight3D" parent="."]\nposition=Vector3(3,5,0)\nrotation=Vector3(-1.57079632679,0,0)\nspot_range=10\nspot_angle=30');
    const light=result.scene.getObjectByName('Spot') as SpotLight;
    const converted=new (await import('../src/converters/GodotShaderConverter.js')).GodotShaderConverter().convert('shader_type spatial; void fragment(){ALBEDO=vec3(1.0);}');
    const material=new ShaderMaterial({uniforms:converted.uniforms,vertexShader:converted.vertexShader,fragmentShader:converted.fragmentShader});result.scene.add(new Mesh(undefined,material));result.updateTime(0);
    const target=light.target.getWorldPosition(new Vector3());
    expect(target.x).toBeCloseTo(3);expect(target.y).toBeCloseTo(4);
    expect(material.uniforms.u_lightCount.value).toBe(1);
    expect(material.uniforms.u_lightDirection.value[0].y).toBeCloseTo(-1);
    expect(material.uniforms.u_lightDirection.value[0].w).toBeCloseTo(Math.cos(Math.PI/6));
  });
  it('applies fixed fog to sky and forwards exponential surface fog to custom shaders',async()=>{
    const converter=new GodotEnvironmentConverter();
    const object=await converter.convert({type:'sub_resource',line:1,attributes:{},id:'env',resourceType:'Environment',properties:{fog_enabled:true,fog_density:.05,fog_light_color:call('Color',0,0,0,1),volumetric_fog_enabled:true,volumetric_fog_density:.03,ambient_light_source:3,reflected_light_source:2}},async v=>v,()=>{});
    const settings=GodotEnvironmentConverter.find(object)!,scene=new Scene();GodotEnvironmentConverter.apply(scene,settings);
    expect((scene.background as import('three').Color).getHex()).toBe(0);
    expect(scene.environment).toBe(null);expect(settings.ambientColor.getHex()).toBe(0);
    const result=await new TSCNLoader().parseAsync('[node name="Root" type="Node3D"]');scene.add(result.scene);
    const shader=new (await import('../src/converters/GodotShaderConverter.js')).GodotShaderConverter().convert('shader_type spatial; void fragment(){ALBEDO=vec3(1.0);}');
    const material=new ShaderMaterial({uniforms:shader.uniforms});result.scene.add(new Mesh(undefined,material));result.updateTime(0);
    expect(material.uniforms.u_fogDensity.value).toBe(.05);expect(material.uniforms.u_volumetricDensity.value).toBe(.03);
    expect(shader.fragmentShader).toContain('exp(-godotFogDistance*u_fogDensity)');
    const disabled=new (await import('../src/converters/GodotShaderConverter.js')).GodotShaderConverter().convert('shader_type spatial;render_mode fog_disabled; void fragment(){}');
    expect(disabled.fragmentShader).not.toContain('godotFogDistance');
  });
  it('applies the preview fog scale to shader uniforms without changing the source settings',async()=>{
    const result=await new TSCNLoader().parseAsync('[node name="Root" type="Node3D"]');
    const converted=new (await import('../src/converters/GodotShaderConverter.js')).GodotShaderConverter().convert('shader_type spatial; void fragment(){ALBEDO=vec3(1.0);}');
    const material=new ShaderMaterial({uniforms:converted.uniforms,vertexShader:converted.vertexShader,fragmentShader:converted.fragmentShader});
    result.scene.add(new Mesh(undefined,material));
    const sourceFog=new FogExp2(new Color(0.2,0.1,0.3),.05);
    result.scene.userData.godotEnvironment={fog:sourceFog,fogDensity:.05,volumetricDensity:.03,ambientColor:new Color(0.1,0.1,0.1)};
    result.scene.userData.godotPreviewFogScale=.4;
    result.updateTime(0);
    expect(material.uniforms.u_fogDensity.value).toBeCloseTo(.02);
    expect(material.uniforms.u_volumetricDensity.value).toBeCloseTo(.012);
    expect(sourceFog.density).toBe(.05);
  });
  it('keeps Godot default omni and spot ranges and distance falloff',async()=>{
    const result=await new TSCNLoader().parseAsync('[node name="Root" type="Node3D"]\n[node name="Omni" type="OmniLight3D" parent="."]\n[node name="Spot" type="SpotLight3D" parent="."]');
    for(const name of ['Omni','Spot']){const light=result.scene.getObjectByName(name) as SpotLight;expect(light.distance).toBe(5);expect(light.decay).toBe(1);}
  });
  it('preserves physics node transforms without adding visible collision geometry',async()=>{
    const result=await new TSCNLoader().parseAsync('[node name="Root" type="Node3D"]\n[node name="Body" type="StaticBody3D" parent="."]\nposition=Vector3(0,-2,0)\n[node name="Shape" type="CollisionShape3D" parent="Body"]');
    expect(result.warnings).toEqual([]);expect(result.scene.getObjectByName('Body')!.position.y).toBe(-2);
    expect(result.scene.getObjectByName('Shape')!.userData.godotPhysicsEnabled).toBe(false);
  });
});
