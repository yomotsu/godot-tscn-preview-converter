import { AudioListener, PositionalAudio, type Object3D } from 'three';

export interface GodotAudioTarget { id:string; name:string; path:string; volume:number; pitch:number; loop:boolean }
interface AudioBinding {node:Object3D; player?:PositionalAudio; request:number; paused:boolean}

/** Lazy Web Audio playback: call setListener() from the application's audio setup. */
export class GodotAudioController {
  readonly targets:GodotAudioTarget[]=[];
  private readonly bindings=new Map<string,AudioBinding>();
  private listener?:AudioListener;
  constructor(root:Object3D){
    root.traverse(node=>{
      const settings=node.userData.godotAudio;
      if(!settings)return;
      const names:string[]=[];for(let parent:Object3D|null=node;parent&&parent!==root;parent=parent.parent)names.unshift(parent.name);
      const id=names.join('/')||root.name;
      this.targets.push({id,name:id,path:'',volume:Math.pow(10,(settings.volume_db??0)/20),pitch:settings.pitch_scale??1,loop:false});
      this.bindings.set(id,{node,request:0,paused:false});
    });
  }
  setListener(listener:AudioListener):void {
    if(this.listener&&this.listener!==listener)throw new Error('Audio listener is already attached');
    this.listener=listener;
  }
  async setAudio(id:string,source:string|Blob,assetPath?:string):Promise<void>{
    const binding=this.bindings.get(id),target=this.targets.find(t=>t.id===id);
    if(!binding||!target)throw new Error(`Unknown audio target: ${id}`);
    if(!this.listener)throw new Error('Call audio.setListener(listener) before loading audio');
    const request=++binding.request;
    const data=source instanceof Blob?await source.arrayBuffer():await fetch(source).then(async response=>{if(!response.ok)throw new Error(`Audio load failed: ${response.status} ${source}`);return response.arrayBuffer();});
    const buffer=await this.listener.context.decodeAudioData(data);
    if(request!==binding.request)return;
    if(!binding.player){
      binding.player=new PositionalAudio(this.listener);
      const settings=binding.node.userData.godotAudio;
      binding.player.setRefDistance(Math.max(.01,settings.unit_size??1));
      binding.player.setMaxDistance(Math.max(.01,settings.max_distance??2000));
      binding.player.setDistanceModel(settings.attenuation_model===2?'exponential':settings.attenuation_model===1?'inverse':'inverse');
      binding.node.add(binding.player);
    }
    if(binding.player.isPlaying)binding.player.stop();
    binding.paused=false;
    binding.player.setBuffer(buffer);
    target.path=assetPath??(typeof source==='string'?source:typeof File!=='undefined'&&source instanceof File?'/godot/custom/'+source.name:'');
    this.setSettings(id,{volume:target.volume,pitch:target.pitch,loop:target.loop});
  }
  setSettings(id:string,settings:{volume?:number;pitch?:number;loop?:boolean}):void{
    const binding=this.bindings.get(id),target=this.targets.find(t=>t.id===id);
    if(!binding||!target)throw new Error(`Unknown audio target: ${id}`);
    if(settings.pitch!==undefined&&(!Number.isFinite(settings.pitch)||settings.pitch<=0))throw new Error('Invalid audio pitch');
    if(settings.volume!==undefined){if(!Number.isFinite(settings.volume)||settings.volume<0)throw new Error('Invalid audio volume');target.volume=settings.volume;}
    if(settings.pitch!==undefined){if(!Number.isFinite(settings.pitch)||settings.pitch<=0)throw new Error('Invalid audio pitch');target.pitch=settings.pitch;}
    if(settings.loop!==undefined)target.loop=settings.loop;
    binding.player?.setVolume(target.volume);binding.player?.setPlaybackRate(target.pitch);binding.player?.setLoop(target.loop);
  }
  async play(id?:string):Promise<void>{
    if(!this.listener)return;
    await this.listener.context.resume();
    for(const [key,binding] of this.bindings){if(id!==undefined&&key!==id||!binding.player?.buffer)continue;if(binding.player.isPlaying)binding.player.stop();binding.paused=false;binding.player.play();}
  }
  pause():void{for(const b of this.bindings.values())if(b.player?.isPlaying){b.paused=true;b.player.pause();}}
  resume():void{for(const b of this.bindings.values())if(b.paused&&b.player?.buffer&&!b.player.isPlaying){b.paused=false;b.player.play();}}
  stop():void{for(const b of this.bindings.values()){b.paused=false;if(b.player?.buffer)b.player.stop();}}
  reset():void{this.stop();for(const [id,b] of this.bindings){b.request++;b.player?.disconnect();if(b.player)b.node.remove(b.player);b.player=undefined;const target=this.targets.find(t=>t.id===id)!;target.path='';target.volume=Math.pow(10,(b.node.userData.godotAudio.volume_db??0)/20);target.pitch=b.node.userData.godotAudio.pitch_scale??1;target.loop=false;}}
  dispose():void{this.reset();}
  getOverrides():GodotAudioTarget[]{return this.targets.filter(t=>t.path).map(t=>({...t}));}
}
