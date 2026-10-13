import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/** Apply Godot's ACES exposure and white normalization after HDR alpha/additive compositing. */
export class GodotOutputPass extends ShaderPass {
  constructor(exposure = 1, white = 1) {
    super({
      uniforms: {tDiffuse:{value:null}, exposure:{value:exposure}, white:{value:white}},
      vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float exposure;
        uniform float white;
        varying vec2 vUv;
        vec3 curve(vec3 x){return (x*(x+0.0245786)-0.000090537)/(x*(0.983729*x+0.432951)+0.238081);}
        void main(){
          vec4 pixel=texture2D(tDiffuse,vUv);
          vec3 c=max(pixel.rgb*exposure,vec3(0.0));
          const mat3 inputMatrix=mat3(0.59719,0.07600,0.02840,0.35458,0.90834,0.13383,0.04823,0.01566,0.83777);
          const mat3 outputMatrix=mat3(1.60475,-0.10208,-0.00327,-0.53108,1.10813,-0.07276,-0.07367,-0.00605,1.07602);
          c=inputMatrix*c*1.8;
          c=outputMatrix*curve(c);
          c/=curve(vec3(white*1.8)).r;
          c=clamp(c,0.0,1.0);
          c=mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
          gl_FragColor=vec4(c,pixel.a);
        }`,
    });
    this.material.toneMapped=false;
  }
}
