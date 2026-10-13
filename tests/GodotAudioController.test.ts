import { describe, expect, it, vi } from 'vitest';
vi.mock('three',async()=>{
 const original=await vi.importActual<typeof import('three')>('three');
 class Listener extends original.Object3D {context={decodeAudioData:vi.fn(async()=>({duration:1})),resume:vi.fn(async()=>{})};}
 class Player extends original.Object3D {
  buffer?:unknown;isPlaying=false;volume=1;rate=1;loop=false;
  setRefDistance(){return this;}setMaxDistance(){return this;}setDistanceModel(){return this;}
  setBuffer(buffer:unknown){this.buffer=buffer;return this;}setVolume(v:number){this.volume=v;return this;}setPlaybackRate(v:number){this.rate=v;return this;}setLoop(v:boolean){this.loop=v;return this;}
  play(){this.isPlaying=true;return this;}stop(){this.isPlaying=false;return this;}pause(){this.isPlaying=false;return this;}disconnect(){return this;}
 }
 return {...original,AudioListener:Listener,PositionalAudio:Player};
});
import { AudioListener, Group } from 'three';
import { GodotAudioController } from '../src/customization/GodotAudioController.js';
function setup(){const root=new Group(),node=new Group();node.name='Sound';node.userData.godotAudio={volume_db:-6,pitch_scale:1.2};root.add(node);return {controller:new GodotAudioController(root),node};}
describe('Godot audio replacement',()=>{
 it('loads decoded audio, configures spatial player and supports play/pause/reset',async()=>{
  const {controller,node}=setup();controller.setListener(new AudioListener());
  await controller.setAudio('Sound',new Blob(['audio']),'/godot/custom/impact.wav');
  controller.setSettings('Sound',{volume:.3,pitch:1.5,loop:true});await controller.play('Sound');
  const player=node.children[0] as any;expect(player.isPlaying).toBe(true);expect(player.volume).toBe(.3);expect(player.rate).toBe(1.5);expect(player.loop).toBe(true);
  expect(controller.getOverrides()[0].path).toBe('/godot/custom/impact.wav');
  controller.pause();expect(player.isPlaying).toBe(false);controller.resume();expect(player.isPlaying).toBe(true);
  controller.reset();expect(node.children).toHaveLength(0);expect(controller.getOverrides()).toEqual([]);
 });
 it('rejects missing listener, unknown targets and invalid playback values',async()=>{
  const {controller}=setup();await expect(controller.setAudio('Sound',new Blob())).rejects.toThrow('setListener');
  expect(()=>controller.setSettings('Sound',{pitch:0})).toThrow();expect(()=>controller.setSettings('Sound',{volume:-1})).toThrow();await expect(controller.setAudio('unknown',new Blob())).rejects.toThrow('Unknown');
 });
 it('ignores a pending decode when reset is requested',async()=>{
  const {controller,node}=setup();const listener=new AudioListener();let finish:(value:any)=>void=()=>{};
  (listener.context.decodeAudioData as any).mockImplementation(()=>new Promise(resolve=>finish=resolve));controller.setListener(listener);
  const loading=controller.setAudio('Sound',new Blob(['audio']));await Promise.resolve();await Promise.resolve();controller.reset();finish({duration:1});await loading;
  expect(node.children).toHaveLength(0);expect(controller.getOverrides()).toEqual([]);
 });
});
