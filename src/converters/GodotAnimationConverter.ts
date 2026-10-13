import {
  AnimationClip, Euler, Quaternion, BooleanKeyframeTrack, ColorKeyframeTrack, InterpolateDiscrete, InterpolateLinear,
  InterpolateSmooth, NumberKeyframeTrack, QuaternionKeyframeTrack, VectorKeyframeTrack,
  type KeyframeTrack, type Object3D,
} from 'three';
import { isGodotCall, type GodotResourceSection, type GodotValue, type ParsedTSCN } from '../tscn/types.js';
import { shaderUniformPropertyName } from './GodotShaderConverter.js';

export interface AnimationConversionResult { animations: AnimationClip[]; warnings: string[] }

/** Converts Godot Animation resources and AnimationLibrary entries into three.js clips. */
export class GodotAnimationConverter {
  convert(parsed: ParsedTSCN, rootName: string, root?: Object3D): AnimationConversionResult {
    const warnings: string[] = [];
    const resources = new Map(parsed.subResources.map((resource) => [resource.id, resource]));
    const namedAnimations = new Map<string, GodotResourceSection>();
    let hasLibrary = false;

    for (const node of parsed.nodes.filter((item) => item.nodeType === 'AnimationPlayer')) {
      for (const [property, value] of Object.entries(node.properties)) {
        if (!property.startsWith('libraries/')) continue;
        const library = resolveSubResource(value, resources);
        if (!library || library.resourceType !== 'AnimationLibrary') continue;
        hasLibrary = true;
        const data = library.properties._data;
        if (!isRecord(data)) continue;
        for (const [name, animationValue] of Object.entries(data)) {
          const animation = resolveSubResource(animationValue, resources);
          if (animation?.resourceType === 'Animation') namedAnimations.set(name, animation);
        }
      }
    }

    if (!hasLibrary) {
      for (const resource of parsed.subResources.filter((item) => item.resourceType === 'Animation')) {
        namedAnimations.set(stringValue(resource.properties.resource_name) || resource.id, resource);
      }
    }

    const animations: AnimationClip[] = [];
    for (const [name, resource] of namedAnimations) {
      if (name === 'RESET') continue;
      const clip = convertAnimation(resource, name, rootName, warnings, parsed.nodes);
      if (clip) {
        if(root){clip.userData.godotRootUUID=root.uuid;clip.userData.godotRootName=root.name;}
        if(root)for(const track of clip.tracks){
          const separator=track.name.indexOf('.'),target=track.name.slice(0,separator);
          let object=target===rootName?root:root.getObjectByName(target);
          if(!object&&target.includes('/'))object=target.split('/').reduce<Object3D|undefined>((parent,name)=>parent?.children.find(c=>c.name===name),root);
          if(object)track.name=object.uuid+track.name.slice(separator);
        }
        animations.push(clip);
      }
    }
    return { animations, warnings };
  }
}

function convertAnimation(resource: GodotResourceSection, name: string, rootName: string, warnings: string[], nodes: ParsedTSCN['nodes']): AnimationClip | null {
  const tracks: KeyframeTrack[] = [];
  const indexes = new Set<number>();
  for (const key of Object.keys(resource.properties)) {
    const match = key.match(/^tracks\/(\d+)\/type$/);
    if (match) indexes.add(Number(match[1]));
  }
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const prefix = `tracks/${index}/`;
    if (resource.properties[`${prefix}enabled`] === false) continue;
    const type = stringValue(resource.properties[`${prefix}type`]);
    const path = nodePath(resource.properties[`${prefix}path`]);
    const keyData = resource.properties[`${prefix}keys`];
    if (type === 'method') {
      if (isRecord(keyData) && arrayValue(keyData.values).length === 0) continue;
      warnings.push(`Animation '${name}' track ${index} is a method track and was skipped`); continue;
    }
    if (type && !['value', 'position_3d', 'rotation_3d', 'scale_3d'].includes(type)) {
      warnings.push(`Animation '${name}' track ${index} uses unsupported track type '${type}'`); continue;
    }
    if (!path || !isRecord(keyData)) { warnings.push(`Animation '${name}' track ${index} is missing a path or key dictionary`); continue; }
    const times = numericArray(keyData.times);
    const values = arrayValue(keyData.values);
    if (!times.length || !values.length || times.length !== values.length) {
      warnings.push(`Animation '${name}' track ${index} has mismatched or empty key times/values`); continue;
    }
    const target = convertTrackPath(path, rootName, type);
    const property = target.property;
    const valueScale = target.multiplier ? customLightScale(path, nodes) : 1;
    const raw = values.map((value) => {
      const converted = convertKeyValue(value, property, target.degrees);
      return typeof converted === 'number' ? converted * valueScale : converted;
    });
    const colorKeys = values.every((value) => isGodotCall(value) && value.name === 'Color');
    const interpolation = Number(resource.properties[`${prefix}interp`] ?? 1) === 0 ? InterpolateDiscrete : Number(resource.properties[`${prefix}interp`] ?? 1) === 2 ? InterpolateSmooth : InterpolateLinear;
    const transitions=numericArray(keyData.transitions);
    const samples=interpolation===InterpolateLinear?bakeTransitions(times,raw,transitions,property==='quaternion'):{times,values:raw};
    const track = makeTrack(target.binding, property, samples.times, samples.values, type, colorKeys);
    if (!track) { warnings.push(`Animation '${name}' track ${index} property '${property}' could not be converted`); continue; }
    if (!(track instanceof BooleanKeyframeTrack)) track.setInterpolation(interpolation);
    tracks.push(track);
  }
  if (!tracks.length) return null;
  const duration = Math.max(Number(resource.properties.length ?? 0), ...tracks.map((track) => track.times.at(-1) ?? 0));
  const clip = new AnimationClip(name, duration, tracks);
  const loopMode = Number(resource.properties.loop_mode ?? 0);
  clip.userData.godotLoopMode = loopMode; // 0: once, 1: repeat, 2: ping-pong
  return clip;
}

function makeTrack(binding: string, property: string, times: number[], values: unknown[], type: string, colorKeys: boolean): KeyframeTrack | null {
  if (property === 'visible' || property === 'emitting' || property === 'playing') return new BooleanKeyframeTrack(binding, times, values.map(Boolean));
  if (property === 'quaternion' && values.every((value) => Array.isArray(value) && value.length === 4)) return new QuaternionKeyframeTrack(binding, times, values.flat() as number[]);
  if (values.every((value) => typeof value === 'number')) return new NumberKeyframeTrack(binding, times, values as number[]);
  if (values.every((value) => Array.isArray(value))) {
    const size = (values[0] as unknown[]).length;
    if (size === 3 && (colorKeys || property === 'color' || property === 'emissive')) return new ColorKeyframeTrack(binding, times, values.flat() as number[]);
    if (size >= 2 && size <= 4) return new VectorKeyframeTrack(binding, times, values.flat() as number[]);
  }
  return null;
}

interface ConvertedPath { binding: string; property: string; degrees: boolean; multiplier: boolean }
function convertTrackPath(path: string, rootName: string, type: string): ConvertedPath {
  const separator = path.indexOf(':');
  let node = separator < 0 ? '.' : path.slice(0, separator);
  let propertyPath = separator < 0 ? path : path.slice(separator + 1);
  node = node.replace(/^\.\//, '').replace(/^\.\.$/, '.');
  const target = node === '.' || node === '' ? rootName : node.replace(/^\.\//, '');
  const parts = propertyPath.split(':');
  let property = parts.at(-1) ?? propertyPath;
  let objectProperty = property;
  let targetPrefix = target;
  const degrees = property === 'rotation_degrees';
  const multiplier = property === 'light_mult' || property === 'light_multiplier';
  if (property === 'rotation' || degrees) property = objectProperty = 'quaternion';
  if (type === 'rotation_3d') property = objectProperty = 'quaternion';
  // GPUParticles3D exposes an `emitting` controller property in TSCNLoader;
  // mapping it to `visible` would hide already emitted particles when emission stops.
  if (property === 'light_energy' || property === 'light_mult' || property === 'light_multiplier') property = objectProperty = 'intensity';
  const shaderParameter = propertyPath.match(/shader_parameter\/([^/:]+)/)?.[1];
  if (shaderParameter) {
    property = objectProperty = `material.${shaderUniformPropertyName(shaderParameter)}`;
    property = objectProperty.split('.').at(-1) ?? property;
  } else if (parts.includes('material') || parts.includes('material_override')) {
    objectProperty = property === 'albedo_color' ? 'material.color' : property === 'emission' ? 'material.emissive' : `material.${property}`;
    property = objectProperty.split('.').at(-1) ?? property;
  }
  const binding = `${targetPrefix}.${objectProperty}`;
  return { binding, property, degrees, multiplier };
}

function customLightScale(path: string, nodes: ParsedTSCN['nodes']): number {
  const nodePath = path.slice(0, path.indexOf(':'));
  const node = nodes.find((item) => item.name === nodePath || nodePath.endsWith(`/${item.name}`));
  return Number(node?.properties.vfx_light_energy ?? node?.properties.light_energy ?? 1);
}

function convertKeyValue(value: GodotValue, property: string, degrees = false): unknown {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return degrees ? value * Math.PI / 180 : value;
  if (isGodotCall(value)) {
    const args = value.args.map(Number);
    switch (value.name) {
      case 'Vector2': return args.slice(0, 2);
      case 'Vector3': {
        const v = degrees ? args.slice(0, 3).map(item => item * Math.PI / 180) : args.slice(0, 3);
        if (property === 'quaternion') return new Quaternion().setFromEuler(new Euler(v[0],v[1],v[2],'YXZ')).toArray();
        return v;
      }
      case 'Vector4': return args.slice(0, 4);
      case 'Quaternion': return args.slice(0, 4);
      case 'Color': return args.slice(0, 3);
      default: return args.length ? args : value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => convertKeyValue(item, property));
  return value;
}

function resolveSubResource(value: GodotValue, resources: Map<string, GodotResourceSection>): GodotResourceSection | undefined {
  return isGodotCall(value) && value.name === 'SubResource' ? resources.get(stringValue(value.args[0])) : undefined;
}
function nodePath(value: GodotValue | undefined): string | undefined { return isGodotCall(value) && value.name === 'NodePath' ? stringValue(value.args[0]) : typeof value === 'string' ? value : undefined; }
function numericArray(value: GodotValue | undefined): number[] { return isGodotCall(value) && value.name.endsWith('Array') ? value.args.map(Number) : Array.isArray(value) ? value.map(Number) : []; }
function arrayValue(value: GodotValue | undefined): GodotValue[] { return Array.isArray(value) ? value : []; }
function isRecord(value: GodotValue | undefined): value is { [key: string]: GodotValue } { return typeof value === 'object' && value !== null && !Array.isArray(value) && !isGodotCall(value); }
function stringValue(value: GodotValue | undefined): string { return typeof value === 'string' ? value : ''; }

/** Bake Godot per-key easing at 120 Hz so standard three.js tracks retain it when cloned or serialized. */
function bakeTransitions(times:number[],values:unknown[],transitions:number[],quaternion:boolean):{times:number[];values:unknown[]} {
  if(!transitions.some(v=>v!==1)||values.some(v=>typeof v!=='number'&&!Array.isArray(v)))return {times,values};
  const outputTimes:number[]=[],outputValues:unknown[]=[];
  for(let i=0;i<times.length-1;i++){
    const duration=times[i+1]-times[i],steps=Math.max(1,Math.ceil(duration*120)),curve=transitions[i]??1;
    for(let j=0;j<steps;j++){
      const t=j/steps,e=ease(t,curve);outputTimes.push(times[i]+duration*t);
      const a=values[i],b=values[i+1];
      if(typeof a==='number'&&typeof b==='number')outputValues.push(a+(b-a)*e);
      else if(Array.isArray(a)&&Array.isArray(b)){
        if(quaternion){const q=new Quaternion().fromArray(a).slerp(new Quaternion().fromArray(b),e);outputValues.push(q.toArray());}
        else outputValues.push(a.map((v,k)=>v+(b[k]-v)*e));
      }
    }
  }
  outputTimes.push(times[times.length-1]);outputValues.push(values[values.length-1]);
  return {times:outputTimes,values:outputValues};
}
function ease(t:number,curve:number):number{
  if(curve>0)return curve<1?1-Math.pow(1-t,1/curve):Math.pow(t,curve);
  if(curve<0)return t<.5?Math.pow(t*2,-curve)*.5:(1-Math.pow(1-(t-.5)*2,-curve))*.5+.5;
  return 0;
}
