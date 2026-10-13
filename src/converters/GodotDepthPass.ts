import { DepthTexture, Mesh, MeshDepthMaterial, NearestFilter, ShaderMaterial, Vector2, WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer } from 'three';

/** Captures opaque scene depth for Godot hint_depth_texture proximity fades. */
export class GodotDepthPass {
  private readonly target=new WebGLRenderTarget(1,1);
  private readonly material=new MeshDepthMaterial();
  private readonly size=new Vector2();
  constructor(){this.target.depthTexture=new DepthTexture(1,1);this.target.depthTexture.minFilter=this.target.depthTexture.magFilter=NearestFilter;}
  render(renderer:WebGLRenderer,scene:Scene,camera:Camera):void{
    const consumers:ShaderMaterial[]=[];
    scene.traverseVisible(node=>{const m=(node as Mesh).material;for(const material of Array.isArray(m)?m:m?[m]:[])if(material instanceof ShaderMaterial&&material.userData.godotDepthUniforms?.length)consumers.push(material);});
    if(!consumers.length)return;
    renderer.getDrawingBufferSize(this.size);
    if(this.target.width!==this.size.x||this.target.height!==this.size.y)this.target.setSize(this.size.x,this.size.y);
    const hidden:Mesh[]=[];
    scene.traverseVisible(node=>{if(node instanceof Mesh){const materials=Array.isArray(node.material)?node.material:[node.material];if(materials.every(m=>m.transparent||!m.depthWrite)){hidden.push(node);node.visible=false;}}});
    const oldTarget=renderer.getRenderTarget(),oldOverride=scene.overrideMaterial,oldBackground=scene.background,oldAutoClear=renderer.autoClear;
    try{scene.overrideMaterial=this.material;scene.background=null;renderer.autoClear=true;renderer.setRenderTarget(this.target);renderer.clear();renderer.render(scene,camera);}
    finally{renderer.setRenderTarget(oldTarget);renderer.autoClear=oldAutoClear;scene.overrideMaterial=oldOverride;scene.background=oldBackground;for(const mesh of hidden)mesh.visible=true;}
    for(const material of consumers){for(const name of material.userData.godotDepthUniforms)material.uniforms[name].value=this.target.depthTexture;material.uniforms.u_screenSize.value.copy(this.size);material.uniforms.u_invProjection.value.copy(camera.projectionMatrixInverse);}
  }
  dispose():void{this.target.dispose();this.material.dispose();}
}
