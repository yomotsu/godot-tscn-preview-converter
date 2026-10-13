import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, ShaderMaterial } from 'three';
import { GodotDepthPass } from '../src/converters/GodotDepthPass.js';
import { GodotShaderConverter } from '../src/converters/GodotShaderConverter.js';
const source=`shader_type spatial;
uniform sampler2D depth_texture : hint_depth_texture;
void fragment(){float depth=textureLod(depth_texture,SCREEN_UV,0.0).r;vec4 ndc=OUTPUT_IS_SRGB?vec4(vec3(SCREEN_UV,depth)*2.0-1.0,1.0):vec4(SCREEN_UV*2.0-1.0,depth,1.0);vec4 view_pos=INV_PROJECTION_MATRIX*ndc;ALPHA=clamp(view_pos.z-VERTEX.z,0.0,1.0);}`;
describe('Godot depth fade',()=>{
 it('maps fragment screen/depth built-ins and identifies renderer-owned depth samplers',()=>{
  const shader=new GodotShaderConverter().convert(source);
  expect(shader.depthUniforms).toEqual(['depth_texture']);expect(shader.textureUniforms).toEqual([]);
  expect(shader.fragmentShader).not.toMatch(/\bSCREEN_UV\b|\bINV_PROJECTION_MATRIX\b|\bOUTPUT_IS_SRGB\b|\bVERTEX\b/);
  expect(shader.fragmentShader).toContain('gl_FragCoord.xy/u_screenSize');expect(shader.uniforms.depth_texture.value).toBeTruthy();
 });
 it('captures opaque depth and restores scene and renderer state, including failures',()=>{
  const shader=new GodotShaderConverter().convert(source),material=new ShaderMaterial({uniforms:shader.uniforms,vertexShader:shader.vertexShader,fragmentShader:shader.fragmentShader,transparent:true});material.userData.godotDepthUniforms=shader.depthUniforms;
  const scene=new Scene(),effect=new Mesh(undefined,material),opaque=new Mesh(undefined,new MeshBasicMaterial());scene.add(effect,opaque);
  const camera=new PerspectiveCamera(),pass=new GodotDepthPass();let target:any=null;
  const renderer={autoClear:false,getDrawingBufferSize:(size:any)=>size.set(320,200),getRenderTarget:()=>target,setRenderTarget:(value:any)=>target=value,clear:()=>{},render:()=>{expect(effect.visible).toBe(false);expect(opaque.visible).toBe(true);}};
  pass.render(renderer as any,scene,camera);
  expect(effect.visible).toBe(true);expect(scene.overrideMaterial).toBeNull();expect(renderer.autoClear).toBe(false);expect(target).toBeNull();
  expect(material.uniforms.u_screenSize.value.toArray()).toEqual([320,200]);expect(material.uniforms.depth_texture.value.isDepthTexture).toBe(true);
  renderer.render=()=>{throw new Error('GPU failure');};expect(()=>pass.render(renderer as any,scene,camera)).toThrow();expect(effect.visible).toBe(true);expect(scene.overrideMaterial).toBeNull();expect(target).toBeNull();pass.dispose();
 });
});
