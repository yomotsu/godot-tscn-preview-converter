import { describe, expect, it } from 'vitest';
import { DataTexture, Mesh, ShaderMaterial } from 'three';
import { TSCNLoader } from '../src/TSCNLoader.js';
import { GodotCurveConverter, sampleCurve } from '../src/converters/GodotCurveConverter.js';
import { GodotTextureConverter } from '../src/converters/GodotTextureConverter.js';
import { GodotMeshConverter } from '../src/converters/GodotMeshConverter.js';
import { GodotShaderConverter } from '../src/converters/GodotShaderConverter.js';
import { TSCNParser } from '../src/tscn/TSCNParser.js';
import { call, type GodotResourceSection } from '../src/tscn/types.js';

function resource(type:string,properties:GodotResourceSection['properties'],id='r'):GodotResourceSection {
  return {type:'sub_resource',resourceType:type,properties,id,attributes:{},line:1};
}

describe('Godot VFX resource behavior',()=>{
  it('samples cubic slopes and keeps scalar and XYZ curve components',async()=>{
    const curve=resource('Curve',{_data:[call('Vector2',0,1),0,2,0,0,call('Vector2',1,3),2,0,0,0]});
    expect(sampleCurve(curve,0.5)).toBeCloseTo(2);
    expect(sampleCurve(curve,-1)).toBe(1);
    expect(sampleCurve(curve,2)).toBe(3);
    const texture=await new GodotCurveConverter().convert(resource('CurveXYZTexture',{curve_x:'x',curve_z:'z'}),async()=>curve);
    expect(texture?.sampleGodot(.5).toArray()).toEqual([2,1,2,1]);
  });

  it('uses FastNoiseLite seed and settings independently of resource IDs',async()=>{
    const converter=new GodotTextureConverter();
    const props={width:32,height:16,seamless:true,noise:'noise'};
    const noise=resource('FastNoiseLite',{noise_type:1,seed:17,domain_warp_amplitude:10});
    const a=await converter.convert(resource('NoiseTexture2D',props,'a'),async()=>noise,()=>{}) as DataTexture;
    const b=await converter.convert(resource('NoiseTexture2D',props,'b'),async()=>noise,()=>{}) as DataTexture;
    expect(a?.image.width).toBe(32);
    expect(a?.image.height).toBe(16);
    expect(Array.from(a!.image.data!)).toEqual(Array.from(b!.image.data!));
    noise.properties.domain_warp_enabled=true;
    const c=await converter.convert(resource('NoiseTexture2D',props),async()=>noise,()=>{}) as DataTexture;
    expect(Array.from(c!.image.data!)).not.toEqual(Array.from(a!.image.data!));
  });

  it('keeps Godot sphere sizes and cylinder UV atlas used by ring shaders',()=>{
    const converter=new GodotMeshConverter();
    const sphere=converter.convert(resource('SphereMesh',{}),()=>{})!;
    sphere.computeBoundingBox();
    expect(sphere.boundingBox!.max.y).toBeCloseTo(.5);
    const cylinder=converter.convert(resource('CylinderMesh',{cap_top:false,cap_bottom:false}),()=>{})!;
    const uv=cylinder.getAttribute('uv');
    expect(Math.max(...Array.from({length:uv.count},(_,i)=>uv.getY(i)))).toBe(.5);
    expect(Math.min(...Array.from({length:uv.count},(_,i)=>uv.getY(i)))).toBe(0);
  });

  it('retains custom light stage, normal maps, mip LOD and color output conversion',()=>{
    const converted=new GodotShaderConverter().convert(`shader_type spatial;
      uniform sampler2D normal_texture;
      void fragment(){NORMAL_MAP=textureLod(normal_texture,UV,2.0).rgb;ALBEDO=vec3(0.2);}
      void light(){DIFFUSE_LIGHT+=LIGHT_COLOR*max(dot(NORMAL,LIGHT),0.0)*ATTENUATION;}`);
    expect(converted.warnings).toEqual([]);
    expect(converted.fragmentShader).toContain('textureLod(normal_texture, vGodotUv, 2.0)');
    expect(converted.fragmentShader).toContain('godotDiffuse += godotLightColor');
    expect(converted.fragmentShader).toContain('#include <colorspace_fragment>');
  });

  it('converts writable billboard matrices used by DarkMagic aura shaders',()=>{
    const converted=new GodotShaderConverter().convert(`shader_type spatial;render_mode unshaded;
      void vertex(){MODELVIEW_MATRIX=VIEW_MATRIX*mat4(MAIN_CAM_INV_VIEW_MATRIX[0],MAIN_CAM_INV_VIEW_MATRIX[1],MAIN_CAM_INV_VIEW_MATRIX[2],MODEL_MATRIX[3]);MODELVIEW_NORMAL_MATRIX=mat3(MODELVIEW_MATRIX);}
      void fragment(){ALBEDO=vec3(1.0);ALPHA=0.5;}`);
    expect(converted.vertexShader).toContain('godotModelViewMatrix = viewMatrix');
    expect(converted.vertexShader).toContain('vec4 viewPosition = godotModelViewMatrix');
    expect(converted.vertexShader).not.toMatch(/\bMODELVIEW_MATRIX\b|\bMAIN_CAM_INV_VIEW_MATRIX\b/);
  });

  it('prevents negative-base pow from producing NaNs in VFX and keeps odd integer signs',()=>{
    const converted=new GodotShaderConverter().convert(`shader_type spatial;render_mode unshaded;
      void fragment(){
        float fresnel=pow(dot(VIEW,NORMAL),4.0);
        float fade=pow((1.0-UV.y)*2.0-1.0,0.2);
        float signed_power=pow(dot(VIEW,NORMAL),3.0);
        ALPHA=clamp(fresnel*fade+signed_power,0.0,1.0);
      }`);
    expect(converted.fragmentShader).toContain('pow(abs(dot (');
    expect(converted.fragmentShader).toContain('pow(max(');
    expect(converted.fragmentShader).toContain('sign(dot (');
  });

  it('simulates unfamiliar emitter names from material values and respects visibility',async()=>{
    const result=await new TSCNLoader().parseAsync(`
[sub_resource type="Curve" id="scale"]
_data=[Vector2(0,1),0,2,0,0,Vector2(1,3),2,0,0,0]
[sub_resource type="CurveTexture" id="scaleTexture"]
curve=SubResource("scale")
[sub_resource type="Curve" id="alpha"]
_data=[Vector2(0,1),0,-1,0,0,Vector2(1,0),-1,0,0,0]
[sub_resource type="CurveTexture" id="alphaTexture"]
curve=SubResource("alpha")
[sub_resource type="ParticleProcessMaterial" id="process"]
direction=Vector3(0,1,0)
spread=0.0
initial_velocity_min=8.0
initial_velocity_max=8.0
gravity=Vector3(0,0,0)
damping_min=4.0
damping_max=4.0
scale_curve=SubResource("scaleTexture")
alpha_curve=SubResource("alphaTexture")
[sub_resource type="SphereMesh" id="sphere"]
[node name="Root" type="Node3D"]
[node name="UnfamiliarEmitter" type="GPUParticles3D" parent="."]
amount=2
one_shot=true
explosiveness=1.0
process_material=SubResource("process")
draw_pass_1=SubResource("sphere")
`);
    result.updateTime(0);result.updateTime(.5);
    const particle=result.scene.getObjectByName('UnfamiliarEmitter__particle_1') as Mesh;
    expect(particle.position.y).toBeCloseTo(3.4667,3);
    expect(particle.scale.x).toBeCloseTo(2);
    result.scene.getObjectByName('UnfamiliarEmitter')!.visible=false;
    result.updateTime(.6);
    expect(particle.visible).toBe(false);
    result.updateTime(1.1);
    expect(particle.visible).toBe(false);
  });
});

describe('Noise color ramps',()=>{
  it('matches Godot forward-difference normals, Y direction and edge wrapping',async()=>{
    const converter=new GodotTextureConverter();
    const noise=resource('FastNoiseLite',{seed:17});
    const props={width:8,height:8,noise:'noise',bump_strength:2};
    const gray=await converter.convert(resource('NoiseTexture2D',props),async()=>noise,()=>{}) as DataTexture;
    const normal=await converter.convert(resource('NoiseTexture2D',{...props,as_normal_map:true}),async()=>noise,()=>{}) as DataTexture;
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){
      const i=y*8+x, data=gray.image.data!;
      const dx=(Number(data[(y*8+(x+1)%8)*4])-Number(data[i*4]))/255*2;
      const dy=(Number(data[(((y+1)%8)*8+x)*4])-Number(data[i*4]))/255*2;
      const length=Math.hypot(dx,dy,1);
      expect(Array.from(normal.image.data!.slice(i*4,i*4+4))).toEqual([
        Math.floor(127.5-dx/length*127.5),Math.floor(127.5+dy/length*127.5),Math.floor(127.5+127.5/length),255,
      ]);
    }
  });

  it('applies default-offset color ramps and preserves mipmap settings',async()=>{
    const converter=new GodotTextureConverter();
    const ramp=resource('Gradient',{colors:call('PackedColorArray',1,0,0,.5,1,0,0,.5)});
    const noise=resource('FastNoiseLite',{});
    const texture=await converter.convert(resource('NoiseTexture2D',{width:8,height:8,noise:'noise',color_ramp:'ramp',generate_mipmaps:false}),async v=>v==='ramp'?ramp:noise,()=>{}) as DataTexture;
    expect(Array.from(texture.image.data!.slice(0,4))).toEqual([255,0,0,127]);
    expect(texture.generateMipmaps).toBe(false);
    const normal=await converter.convert(resource('NoiseTexture2D',{width:8,height:8,noise:'noise',color_ramp:'ramp',as_normal_map:true}),async v=>v==='ramp'?ramp:noise,()=>{}) as DataTexture;
    expect(Array.from(normal.image.data!.slice(0,3))).toEqual([127,127,255]);
  });
});
