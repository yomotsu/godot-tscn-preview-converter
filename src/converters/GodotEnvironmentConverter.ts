import { Color, EquirectangularReflectionMapping, Euler, FogExp2, Group, Texture, type Scene } from 'three';
import { isGodotCall, type GodotResourceSection } from '../tscn/types.js';
import type { ResourceValueResolver, WarningReporter } from './GodotMaterialConverter.js';

export interface GodotEnvironmentSettings {
  background: Color | Texture | null;
  environment: Texture | null;
  skyRotation: Euler;
  skyEnergy: number;
  fog: FogExp2 | null;
  exposure: number;
  tonemapMode: number;
  glow: boolean;
  glowBloom: number;
  fogDensity: number;
  volumetricDensity: number;
  fogSkyAffect: number;
  ambientColor: Color;

}
const settings = new WeakMap<Group,GodotEnvironmentSettings>();

/** Convert the visible parts of WorldEnvironment; renderer-specific effects are reported. */
export class GodotEnvironmentConverter {
  async convert(resource: GodotResourceSection, resolve: ResourceValueResolver, warn: WarningReporter): Promise<Group> {
    const p=resource.properties, object=new Group();
    let panorama:Texture|null=null,energy=1;
    if(p.sky){const sky=await resolve(p.sky);if(isResource(sky)&&sky.properties.sky_material){const material=await resolve(sky.properties.sky_material);if(isResource(material)){
      const texture=material.properties.panorama?await resolve(material.properties.panorama):undefined;
      if(texture instanceof Texture){panorama=texture;panorama.mapping=EquirectangularReflectionMapping;energy=Number(material.properties.energy_multiplier??1);}
    }}}
    const rotation=isGodotCall(p.sky_rotation)?p.sky_rotation.args.map(Number):[0,0,0];
    const value:GodotEnvironmentSettings={
      background:Number(p.background_mode??0)===2?panorama:Number(p.background_mode??0)===1?color(p.background_color):null,
      environment:Number(p.reflected_light_source??0)===2?null:panorama,skyRotation:new Euler(rotation[0]??0,rotation[1]??0,rotation[2]??0,'YXZ'),skyEnergy:energy,
      fog:p.fog_enabled||p.volumetric_fog_enabled?new FogExp2(color(p.fog_light_color),Number(p.fog_density??p.volumetric_fog_density??.01)):null,
      fogDensity:p.fog_enabled?Number(p.fog_density??.01):0,
      volumetricDensity:p.volumetric_fog_enabled?Number(p.volumetric_fog_density??.05):0,
      fogSkyAffect:p.fog_enabled?Number(p.fog_sky_affect??1):0,
      ambientColor:Number(p.ambient_light_source??0)===3?new Color(0,0,0):color(p.ambient_light_color).multiplyScalar(Number(p.ambient_light_energy??1)),
      exposure:Number(p.tonemap_exposure??1),tonemapMode:Number(p.tonemap_mode??0),glow:Boolean(p.glow_enabled),glowBloom:Number(p.glow_bloom??0),
    };
    settings.set(object,value);
    object.userData.godotNodeType='WorldEnvironment';
    const unsupported=['ssr_enabled','ssao_enabled','ssil_enabled','sdfgi_enabled','volumetric_fog_enabled'].filter(key=>p[key]);
    if(unsupported.length)warn(`WorldEnvironment: ${unsupported.join(', ')} は Godot 固有の描画機能です。空・露出・距離フォグは変換済みで、ボリュームフォグは距離フォグで近似しています`);
    return object;
  }

  static find(root:Group):GodotEnvironmentSettings|undefined {
    let result:GodotEnvironmentSettings|undefined;
    root.traverse(object=>{result??=settings.get(object as Group);});return result;
  }
  static apply(scene:Scene,value:GodotEnvironmentSettings):void {
    // Godot fixed fog mixes the entire sky by fog_sky_affect, independently of distance.
    scene.background=value.fogSkyAffect>=1&&value.fog?value.fog.color.clone():value.background;
    scene.environment=value.environment;
    scene.userData.godotEnvironment=value;
    scene.backgroundIntensity=value.skyEnergy;scene.environmentIntensity=value.skyEnergy;
    scene.backgroundRotation.copy(value.skyRotation);scene.environmentRotation.copy(value.skyRotation);scene.fog=value.fog;
  }
}
function isResource(value:unknown):value is GodotResourceSection{return typeof value==='object'&&value!==null&&'properties' in value;}
function color(value:unknown):Color{if(typeof value==='object'&&value!==null&&'kind' in value&&'args' in value){const args=(value as {args:number[]}).args;return new Color(Number(args[0]),Number(args[1]),Number(args[2]));}return new Color(0,0,0);}
