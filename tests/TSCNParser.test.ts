import { describe, expect, it } from 'vitest';
import { TSCNParser } from '../src/tscn/TSCNParser.js';
import { isGodotCall } from '../src/tscn/types.js';

describe('TSCNParser', () => {
  it('reads the [resource] properties block in standalone tres resources', () => {
    const parsed = new TSCNParser().parseResource(`[gd_resource type="StandardMaterial3D" format=3]\n[resource]\nalbedo_color = Color(0.2, 0.4, 0.8, 1)\nroughness = 0.35`);
    expect(parsed.resourceProperties.roughness).toBe(0.35);
    expect(parsed.resourceProperties.albedo_color).toMatchObject({ kind: 'call', name: 'Color' });
  });
  it('parses sections, references, nested values and multiline dictionaries', () => {
    const parsed = new TSCNParser().parse(`
[gd_scene format=3]
[ext_resource type="Shader" path="res://fx.gdshader" id="shader"]
[sub_resource type="ShaderMaterial" id="mat"]
shader = ExtResource("shader")
shader_parameter/color = Color(1, 0.5, 0.25, 1)
[sub_resource type="AnimationLibrary" id="library"]
_data = {
&"main": SubResource("animation"),
}
[node name="Root" type="Node3D"]
transform = Transform3D(
  Basis(1, 0, 0, 0, 1, 0, 0, 0, 1),
  Vector3(1, 2, 3)
)
values = [Vector2(1, 2), {"nested": [true, false]}]
`);
    expect(parsed.externalResources[0].attributes.path).toBe('res://fx.gdshader');
    expect(isGodotCall(parsed.subResources[0].properties.shader)).toBe(true);
    const root = parsed.nodes[0];
    expect(isGodotCall(root.properties.transform)).toBe(true);
    expect(root.properties.values).toHaveLength(2);
    expect(parsed.subResources[1].properties._data).toHaveProperty('main');
  });

  it('reports malformed and unclosed input with a line number', () => {
    expect(() => new TSCNParser().parse('[node name="Root" type="Node3D"]\ntransform = Vector3(1, 2')).toThrow(/Line 2/);
  });
});
