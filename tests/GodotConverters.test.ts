import { describe, expect, it } from 'vitest';
import { MeshStandardMaterial, ShaderMaterial } from 'three';
import { GodotAnimationConverter } from '../src/converters/GodotAnimationConverter.js';
import { GodotMaterialConverter } from '../src/converters/GodotMaterialConverter.js';
import { GodotShaderConverter } from '../src/converters/GodotShaderConverter.js';
import { TSCNParser } from '../src/tscn/TSCNParser.js';
import { isGodotCall, type GodotResourceSection } from '../src/tscn/types.js';

describe('Godot converters', () => {
  it('converts StandardMaterial3D PBR values', async () => {
    const resource: GodotResourceSection = {
      type: 'sub_resource', line: 1, attributes: {}, id: 'pbr', resourceType: 'StandardMaterial3D',
      properties: { albedo_color: { kind: 'call', name: 'Color', args: [0.4, 0.2, 0.1, 0.5] }, roughness: 0.25, metallic: 0.8 },
    };
    const warnings: string[] = [];
    const material = await new GodotMaterialConverter().convert(resource, async (value) => value, (message) => warnings.push(message));
    expect(material).toBeInstanceOf(MeshStandardMaterial);
    expect((material as MeshStandardMaterial).roughness).toBe(0.25);
    expect((material as MeshStandardMaterial).metalness).toBe(0.8);
    expect((material as MeshStandardMaterial).transparent).toBe(true);
  });

  it('converts ShaderMaterial parameters and exposes AnimationMixer aliases', async () => {
    const resource: GodotResourceSection = {
      type: 'sub_resource', line: 1, attributes: {}, id: 'shader-material', resourceType: 'ShaderMaterial',
      properties: { shader: { kind: 'call', name: 'ExtResource', args: ['shader'] }, 'shader_parameter/decay': 0.25 },
    };
    const shader = 'shader_type spatial; uniform float decay = 0.0; void fragment() { ALPHA = decay; }';
    const material = await new GodotMaterialConverter().convert(resource, async (value) => {
      return isGodotCall(value) && value.name === 'ExtResource' ? shader : value;
    }, () => undefined);
    expect(material).toBeInstanceOf(ShaderMaterial);
    const animated = material as ShaderMaterial & { godotUniform_decay: number };
    expect(animated.uniforms.decay.value).toBe(0.25);
    animated.godotUniform_decay = 0.75;
    expect(animated.uniforms.decay.value).toBe(0.75);
  });

  it('converts VFX spatial shader stages, uniforms and TIME', () => {
    const converted = new GodotShaderConverter().convert(`
shader_type spatial;
render_mode unshaded, blend_add, cull_disabled;
uniform vec2 flow = vec2(0.0, 0.2);
void vertex() { VERTEX += NORMAL * COLOR.a; }
void fragment() { ALBEDO = vec3(UV, 0.0); ALPHA = sin(TIME); }
`);
    expect(converted.vertexShader).toMatch(/godotVertex \+= normal \* vGodotColor\s*\.\s*a/);
    expect(converted.fragmentShader).toMatch(/sin\s*\(\s*u_time\s*\)/);
    expect(converted.transparent).toBe(true);
    expect(converted.blending).toBe('additive');
    expect(converted.side).toBe('double');
    expect(converted.uniforms).toHaveProperty('flow');
  });

  it('retains Godot per-key easing in standard tracks',()=>{
    const parsed=new TSCNParser().parse('[sub_resource type="Animation" id="a"]\ntracks/0/type="value"\ntracks/0/path=NodePath("Mesh:value")\ntracks/0/keys={"times":PackedFloat32Array(0,1),"transitions":PackedFloat32Array(0.5,1),"values":[0.0,1.0]}\n[node name="Root" type="Node3D"]');
    const track=new GodotAnimationConverter().convert(parsed,'Root').animations[0].tracks[0];
    expect(track.InterpolantFactoryMethodLinear().evaluate(.5)[0]).toBeCloseTo(.75,5);
    expect(track.clone().InterpolantFactoryMethodLinear().evaluate(.5)[0]).toBeCloseTo(.75,5);
  });
  it('converts AnimationLibrary value tracks to three.js keyframe tracks', () => {
    const parsed = new TSCNParser().parse(`
[sub_resource type="Animation" id="run"]
length = 1.0
loop_mode = 1
tracks/0/type = "position_3d"
tracks/0/enabled = true
tracks/0/path = NodePath("Mesh:position")
tracks/0/keys = {
"times": PackedFloat32Array(0, 1),
"values": [Vector3(0, 0, 0), Vector3(2, 3, 4)]
}
tracks/1/type = "value"
tracks/1/enabled = true
tracks/1/path = NodePath("Mesh:material_override:shader_parameter/emission")
tracks/1/keys = {
"times": PackedFloat32Array(0, 1),
"values": [0.0, 1.0]
}
[sub_resource type="AnimationLibrary" id="library"]
_data = { &"main": SubResource("run") }
[node name="Root" type="Node3D"]
[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
libraries/ = SubResource("library")
`);
    const result = new GodotAnimationConverter().convert(parsed, 'Root');
    expect(result.animations).toHaveLength(1);
    expect(result.animations[0].name).toBe('main');
    expect(result.animations[0].tracks.map((track) => track.name)).toEqual([
      'Mesh.position', 'Mesh.material.godotUniform_emission',
    ]);
    expect(result.animations[0].userData.godotLoopMode).toBe(1);
  });
});
