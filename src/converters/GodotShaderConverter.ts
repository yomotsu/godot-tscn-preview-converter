import { Color, DataTexture, RGBAFormat, Matrix4, SRGBColorSpace, Vector2, Vector3, Vector4 } from 'three';
import { GodotValueParser } from '../tscn/GodotValueParser.js';
import { isGodotCall, type GodotValue } from '../tscn/types.js';

export interface ShaderConversionWarning { message: string }
export interface ShaderConversionResult {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
  transparent: boolean;
  blending: 'normal' | 'additive' | 'subtractive' | 'multiply';
  side: 'front' | 'double';
  sourceColorUniforms: string[];
  textureUniforms: string[];
  depthUniforms: string[];
  warnings: ShaderConversionWarning[];
}

/** PropertyBinding-friendly direct property alias used by AnimationMixer tracks. */
export function shaderUniformPropertyName(name: string): string { return `godotUniform_${name}`; }

interface Token { kind: 'id' | 'number' | 'string' | 'punct'; text: string }
interface UniformDeclaration { type: string; name: string; sourceColor: boolean; depthTexture: boolean; defaultExpression?: string }

/** Converts a useful VFX-oriented subset of Godot spatial shaders to ShaderMaterial GLSL. */
export class GodotShaderConverter {
  convert(source: string): ShaderConversionResult {
    const warnings: ShaderConversionWarning[] = [];
    const clean = stripShaderComments(source);
    const tokens = tokenize(clean);
    if (!tokens.some((token, i) => token.text === 'shader_type' && tokens[i + 1]?.text === 'spatial')) {
      throw new Error("Only 'shader_type spatial' is supported");
    }

    const renderModes = collectRenderModes(tokens);
    const declarations = collectUniforms(tokens);
    const varyingSource = collectVaryings(tokens);
    const functions = collectFunctions(tokens);
    const vertexBody = functions.get('vertex')?.body ?? '';
    const fragmentBody = functions.get('fragment')?.body ?? '';
    if (!functions.has('fragment')) warnings.push({ message: 'Shader has no fragment() function; using Godot defaults' });


    const helpers = [...functions.entries()].filter(([name]) => !['vertex', 'fragment', 'light'].includes(name)).map(([, fn]) => fn.source);
    const uniformSource = declarations.map((uniform) => `uniform ${uniform.type} ${uniform.name};`).join('\n');
    const uniforms: Record<string, { value: unknown }> = {};
    for (const declaration of declarations) uniforms[declaration.name] = { value: uniformDefault(declaration) };

    const depthUniforms=declarations.filter(d=>d.depthTexture).map(d=>d.name);
    if(depthUniforms.length){const emptyDepth=new DataTexture(new Uint8Array([255,255,255,255]),1,1,RGBAFormat);emptyDepth.needsUpdate=true;for(const name of depthUniforms)uniforms[name]={value:emptyDepth};}
    uniforms.u_screenSize={value:new Vector2(1,1)};
    uniforms.u_invProjection={value:new Matrix4()};
    uniforms.u_instanceId = { value: 0 };
    uniforms.u_time = { value: 0 };
    uniforms.u_particleColor = { value: new Vector4(1,1,1,1) };
    uniforms.u_instanceCustom = { value: new Vector4() };
    uniforms.u_billboard = { value: false };
    uniforms.u_fogDensity = {value:0};
    uniforms.u_fogColor = {value:new Color(0,0,0)};
    uniforms.u_volumetricDensity = {value:0};
    uniforms.u_ambient = { value: new Color(0.15,0.15,0.15) };
    uniforms.u_lightCount = { value: 0 };
    uniforms.u_lightPosition = { value: Array.from({length:8},()=>new Vector4()) };
    uniforms.u_lightColor = { value: Array.from({length:8},()=>new Color(0,0,0)) };
    uniforms.u_lightDirection = { value: Array.from({length:8},()=>new Vector4(0,0,0,-1)) };
    uniforms.u_lightDecay = {value:Array(8).fill(1)};
    uniforms.u_spotDecay = {value:Array(8).fill(1)};
    uniforms.u_lightRange = { value: Array(8).fill(0) };
    const sharedHeader = `precision highp float;
${uniformSource}
uniform float u_time;
uniform int u_instanceId;
uniform vec4 u_particleColor;
uniform vec4 u_instanceCustom;
const float PI = 3.1415926535897932384626433832795;
const float TAU = 6.283185307179586476925286766559;
varying vec2 vGodotUv;
varying vec4 vGodotColor;
varying vec3 vGodotNormal;
varying vec3 vGodotPosition;
${varyingSource}
${collectConstants(tokens)}
`;
    const vertex = `${sharedHeader}
// Use a dedicated attribute name so Godot uniforms such as color cannot collide with it.
attribute vec4 godotVertexColor;
uniform bool u_billboard;
mat4 godotModelViewMatrix;
mat3 godotModelViewNormalMatrix;
mat4 godotCameraMatrix;
${helpers.map((helper) => transformStage(helper, 'vertex')).join('\n')}
void main() {
  vGodotUv = uv;
  vGodotColor = godotVertexColor * u_particleColor;
  vec3 godotVertex = position;
  godotModelViewMatrix = modelViewMatrix;
  godotModelViewNormalMatrix = normalMatrix;
  godotCameraMatrix = mat4(
    vec4(viewMatrix[0].x,viewMatrix[1].x,viewMatrix[2].x,0.0),
    vec4(viewMatrix[0].y,viewMatrix[1].y,viewMatrix[2].y,0.0),
    vec4(viewMatrix[0].z,viewMatrix[1].z,viewMatrix[2].z,0.0),
    vec4(cameraPosition,1.0));
${indent(transformStage(vertexBody, 'vertex'))}
  vec4 viewPosition = godotModelViewMatrix * vec4(godotVertex,1.0);
  if (u_billboard) {
    vec3 modelScale = vec3(length(modelMatrix[0].xyz),length(modelMatrix[1].xyz),length(modelMatrix[2].xyz));
    viewPosition = modelViewMatrix * vec4(0.0,0.0,0.0,1.0) + vec4(godotVertex * modelScale,0.0);
  }
  vGodotNormal = normalize(godotModelViewNormalMatrix * normal);
  vGodotPosition = viewPosition.xyz;
  gl_Position = projectionMatrix * viewPosition;
}`;
    const lightBody = functions.get('light')?.body;
    const shading = /\bunshaded\b/.test(renderModes) ? '' : `
  vec3 godotNormal = normalize(vGodotNormal);
  vec3 godotView = normalize(-vGodotPosition);
  ${/\bNORMAL_MAP\b/.test(fragmentBody) ? `
  vec3 q0=dFdx(vGodotPosition), q1=dFdy(vGodotPosition);
  vec2 st0=dFdx(vGodotUv), st1=dFdy(vGodotUv);
  vec3 tangent=normalize(q0*st1.y-q1*st0.y);
  vec3 bitangent=normalize(-q0*st1.x+q1*st0.x);
  godotNormal=normalize(mat3(tangent,bitangent,godotNormal)*(godotNormalMap*2.0-1.0));` : ''}
  vec3 godotDiffuse = u_ambient;
  vec3 godotSpecularLight = vec3(0.0);
  for (int i=0;i<8;i++) {
    if(i>=u_lightCount) break;
    vec3 toLight=(viewMatrix * u_lightPosition[i]).xyz;
    if(u_lightPosition[i].w>0.5) toLight-=vGodotPosition;
    float distanceToLight=length(toLight);
    vec3 godotLight=normalize(toLight);
    vec3 godotLightColor=u_lightColor[i];
    float godotAttenuation=1.0;
    if(u_lightPosition[i].w>0.5) {
      float range=u_lightRange[i];
      float falloff=range>0.0 ? pow(clamp(1.0-pow(distanceToLight/range,4.0),0.0,1.0),2.0) : 1.0;
      godotAttenuation=falloff*pow(max(distanceToLight,0.0001),-u_lightDecay[i]);
      if(u_lightDirection[i].w>=0.0){
        vec3 axis=normalize((viewMatrix*vec4(u_lightDirection[i].xyz,0.0)).xyz);
        float cone=dot(-godotLight,axis);
        float rim=max(0.0001,(1.0-max(cone,u_lightDirection[i].w))/max(1.0-u_lightDirection[i].w,0.0001));
        godotAttenuation*=1.0-pow(rim,u_spotDecay[i]);
      }
    }
    ${lightBody ? transformStage(lightBody,'light') : `float NdotL=max(dot(godotNormal,godotLight),0.0);
    float NdotV=max(dot(godotNormal,godotView),0.0);
    vec3 halfVector=normalize(godotLight+godotView);
    float LdotH=max(dot(godotLight,halfVector),0.0);
    float FD90=2.0*LdotH*LdotH*godotRoughness-0.5;
    float diffuse=(1.0+FD90*pow(1.0-NdotL,5.0))*(1.0+FD90*pow(1.0-NdotV,5.0));
    godotDiffuse += godotLightColor * NdotL * diffuse * godotAttenuation / PI;`}
  }
  godotColor.rgb *= godotDiffuse;
  godotColor.rgb += godotSpecularLight;
`;
    const fragment = `${sharedHeader}
uniform float u_fogDensity;
uniform vec3 u_fogColor;
uniform float u_volumetricDensity;
uniform vec2 u_screenSize;
uniform mat4 u_invProjection;
uniform vec3 u_ambient;
uniform int u_lightCount;
uniform vec4 u_lightPosition[8];
uniform vec3 u_lightColor[8];
uniform float u_lightRange[8];
uniform float u_lightDecay[8];
uniform float u_spotDecay[8];
uniform vec4 u_lightDirection[8];
${helpers.map((helper) => transformStage(helper, 'fragment')).join('\n')}
void main() {
  vec4 godotColor = vec4(1.0);
  vec3 godotEmission = vec3(0.0);
  vec3 godotNormalMap = vec3(0.5, 0.5, 1.0);
  vec3 godotTangent = normalize(dFdx(vGodotPosition) * dFdy(vGodotUv).y - dFdy(vGodotPosition) * dFdx(vGodotUv).y);
  if (length(godotTangent) < 0.0001) {
    vec3 tangentAxis = abs(vGodotNormal.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    godotTangent = normalize(cross(tangentAxis, vGodotNormal));
  }
  float godotAlphaThreshold = 0.0;
  // Godot exposes this output even for unshaded/additive materials. Keeping
  // it available lets those shaders compile when they assign it.
  float godotPremulAlphaFactor = 1.0;
  float godotSpecular = 0.5;
  float godotRoughness = 1.0;
${indent(transformStage(fragmentBody, 'fragment'))}
${shading}
  godotColor.rgb += godotEmission;
  if (godotAlphaThreshold > 0.0 && godotColor.a < godotAlphaThreshold) discard;
  ${/\bfog_disabled\b/.test(renderModes) ? '' : `
  float godotFogDistance=length(vGodotPosition);
  godotColor.rgb=mix(u_fogColor,godotColor.rgb,exp(-godotFogDistance*u_fogDensity));
  godotColor.rgb*=exp(-godotFogDistance*u_volumetricDensity);
  `}
  gl_FragColor = godotColor;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

    return {
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms,
      transparent: /\bblend_(?:mix|add|sub|mul|premul_alpha)\b/.test(renderModes) || /\bALPHA\b/.test(fragmentBody),
      blending: /\bblend_add\b/.test(renderModes) ? 'additive' : /\bblend_sub\b/.test(renderModes) ? 'subtractive' : /\bblend_mul\b/.test(renderModes) ? 'multiply' : 'normal',
      side: /\bcull_disabled\b/.test(renderModes) ? 'double' : 'front',
      sourceColorUniforms: declarations.filter(d=>d.sourceColor).map(d=>d.name),
      textureUniforms: declarations.filter(d=>d.type.startsWith('sampler')&&!d.depthTexture).map(d=>d.name),
      depthUniforms,
      warnings,
    };
  }
}

export function stripShaderComments(source: string): string {
  let output = '';
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') { output += '\n'; lineComment = false; }
      else output += ' ';
    } else if (blockComment) {
      if (char === '*' && next === '/') { output += '  '; i++; blockComment = false; }
      else output += char === '\n' ? '\n' : ' ';
    } else if (quote) {
      output += char;
      if (char === '\\') { output += source[++i] ?? ''; }
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") { quote = char; output += char; }
    else if (char === '/' && next === '/') { output += '  '; i++; lineComment = true; }
    else if (char === '/' && next === '*') { output += '  '; i++; blockComment = true; }
    else output += char;
  }
  return output;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const compoundOperators = ['<<=', '>>=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '->', '<<', '>>', '&=', '|=', '^='];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i++; continue; }
    const rest = source.slice(i);
    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (identifier) { tokens.push({ kind: 'id', text: identifier }); i += identifier.length; continue; }
    const number = rest.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)?.[0];
    if (number) { tokens.push({ kind: 'number', text: number }); i += number.length; continue; }
    const char = source[i++];
    if (char === '"' || char === "'") {
      let text = char;
      while (i < source.length) {
        const current = source[i++]; text += current;
        if (current === '\\' && i < source.length) text += source[i++];
        else if (current === char) break;
      }
      tokens.push({ kind: 'string', text });
    } else {
      const operator = compoundOperators.find((candidate) => source.startsWith(candidate, i - 1));
      if (operator) {
        tokens.push({ kind: 'punct', text: operator });
        i += operator.length - 1;
      } else tokens.push({ kind: 'punct', text: char });
    }
  }
  return tokens;
}

function collectRenderModes(tokens: Token[]): string {
  let modes = '';
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== 'render_mode') continue;
    for (i++; i < tokens.length && tokens[i].text !== ';'; i++) modes += `${tokens[i].text} `;
  }
  return modes;
}

function collectUniforms(tokens: Token[]): UniformDeclaration[] {
  const declarations: UniformDeclaration[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== 'uniform') continue;
    const type = tokens[i + 1]?.text;
    const name = tokens[i + 2]?.text;
    if (!type || !name) continue;
    let sourceColor = false;
    let depthTexture=false;
    let equals = -1;
    let end = i + 3;
    for (; end < tokens.length && tokens[end].text !== ';'; end++) {
      if(tokens[end].text==='hint_depth_texture')depthTexture=true;
      if (tokens[end].text === 'source_color') sourceColor = true;
      if (tokens[end].text === '=' && equals < 0) equals = end;
    }
    const defaultExpression = equals >= 0 ? tokens.slice(equals + 1, end).map((token) => token.text).join('') : undefined;
    declarations.push({ type, name, sourceColor, depthTexture, defaultExpression });
    i = end;
  }
  return declarations;
}

function collectVaryings(tokens: Token[]): string {
  const declarations: string[] = [];
  const interpolationQualifiers = new Set(['flat', 'smooth', 'noperspective', 'centroid', 'sample']);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== 'varying') continue;
    let end = i + 1;
    while (end < tokens.length && tokens[end].text !== ';') end++;
    const declaration = tokens.slice(i + 1, end);
    let typeIndex = 0;
    while (typeIndex < declaration.length && interpolationQualifiers.has(declaration[typeIndex].text)) typeIndex++;
    if (declaration[typeIndex]?.kind !== 'id' || declaration[typeIndex + 1]?.kind !== 'id') continue;

    // Three.js rewrites `varying` to `out`/`in` for its WebGL 2 shaders, where
    // interpolation qualifiers must come first (for example, `flat out int id`).
    const qualifiers = declaration.slice(0, typeIndex).map((token) => token.text).join(' ');
    const body = tokensToSource(declaration.slice(typeIndex));
    declarations.push(`${qualifiers ? `${qualifiers} ` : ''}varying ${body};`);
    i = end;
  }
  return declarations.join('\n');
}

function collectConstants(tokens: Token[]): string {
  const declarations: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (depth === 0 && token.text === 'const') {
      const start = i;
      while (i < tokens.length && tokens[i].text !== ';') i++;
      if (i < tokens.length) {
        const declaration = tokensToSource(tokens.slice(start, i + 1));
        declarations.push(declaration.replace(/(\d(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*f\b/gi, '$1'));
      }
      continue;
    }
    if (token.text === '{') depth++;
    else if (token.text === '}') depth = Math.max(0, depth - 1);
  }
  return declarations.join('\n');
}

function collectFunctions(tokens: Token[]): Map<string, { body: string; source: string }> {
  const functions = new Map<string, { body: string; source: string }>();
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].kind !== 'id' || tokens[i + 1]?.kind !== 'id' || tokens[i + 2]?.text !== '(') { i++; continue; }
    const start = i;
    const name = tokens[i + 1].text;
    let parens = 0;
    while (i < tokens.length) {
      if (tokens[i].text === '(') parens++;
      else if (tokens[i].text === ')') parens--;
      else if (tokens[i].text === '{' && parens === 0) break;
      i++;
    }
    if (tokens[i]?.text !== '{') { i++; continue; }
    const bodyStart = ++i;
    let braces = 1;
    while (i < tokens.length && braces) {
      if (tokens[i].text === '{') braces++;
      else if (tokens[i].text === '}') braces--;
      i++;
    }
    if (braces) throw new Error(`Unclosed body for ${name}()`);
    const body = tokensToSource(tokens.slice(bodyStart, i - 1));
    functions.set(name, { body, source: tokensToSource(tokens.slice(start, i)) });
  }
  return functions;
}

function transformStage(source: string, stage: 'vertex' | 'fragment' | 'light'): string {
  const tokens = tokenize(source);
  const names: Record<string, string> = {
    INSTANCE_CUSTOM: 'u_instanceCustom', TIME: 'u_time', UV: 'vGodotUv', COLOR: 'vGodotColor', texture: 'texture2D', FRONT_FACING: 'gl_FrontFacing', MODEL_MATRIX: 'modelMatrix', CAMERA_POSITION_WORLD: 'cameraPosition',
  };
  if (stage === 'vertex') {
    names.VERTEX = 'godotVertex';
    names.INSTANCE_ID = 'u_instanceId';
    names.MODELVIEW_MATRIX = 'godotModelViewMatrix';
    names.MODELVIEW_NORMAL_MATRIX = 'godotModelViewNormalMatrix';
    names.VIEW_MATRIX = 'viewMatrix';
    names.MAIN_CAM_INV_VIEW_MATRIX = 'godotCameraMatrix';
    names.INV_VIEW_MATRIX = 'godotCameraMatrix';
    names.NORMAL = 'normal';
    names.MODEL_NORMAL_MATRIX='(transpose(mat3(viewMatrix))*normalMatrix)';
  } else {
    names.NORMAL = 'normalize(vGodotNormal)';
    names.TANGENT = 'godotTangent';
    names.VERTEX='vGodotPosition';
    names.FRAGCOORD = 'gl_FragCoord';
    names.SCREEN_UV='(gl_FragCoord.xy/u_screenSize)';
    names.INV_PROJECTION_MATRIX='u_invProjection';
    names.OUTPUT_IS_SRGB='true';
    names.VIEW = 'normalize(-vGodotPosition)';
    names.ALBEDO = 'godotColor.rgb';
    names.ALPHA = 'godotColor.a';
    names.EMISSION = 'godotEmission';
    names.ALPHA_SCISSOR_THRESHOLD = 'godotAlphaThreshold';
    names.PREMUL_ALPHA_FACTOR = 'godotPremulAlphaFactor';
    names.NORMAL_MAP = 'godotNormalMap';
    names.SPECULAR = 'godotSpecular';
    names.ROUGHNESS = 'godotRoughness';
  }
  if (stage === 'light') Object.assign(names, {NORMAL:'godotNormal', VIEW:'godotView', LIGHT:'godotLight', LIGHT_COLOR:'godotLightColor', ATTENUATION:'godotAttenuation', DIFFUSE_LIGHT:'godotDiffuse', SPECULAR_LIGHT:'godotSpecularLight'});
  const output: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'id' && token.text === 'pow' && tokens[i + 1]?.text === '(') {
      const { args, end } = readCallArgs(tokens, i + 1);
      if (args.length === 2) {
        const base = transformStage(tokensToSource(args[0]), stage);
        const exponent = transformStage(tokensToSource(args[1]), stage);
        const integerExponent = integerLiteral(args[1]);
        // GLSL pow() is undefined for negative bases even when the exponent is
        // an integer. Godot VFX commonly raises VIEW·NORMAL to an even power;
        // keep that mathematical result while preventing NaNs from reaching
        // additive blending and bloom. Fractional powers use a zero-clamped
        // base, which also gives fades a stable zero beyond their valid range.
        const safeBase = integerExponent === null
          ? `max(${base}, 0.0)`
          : `abs(${base})`;
        const power = `pow(${safeBase}, ${exponent})`;
        output.push(integerExponent !== null && Math.abs(integerExponent % 2) === 1
          ? `sign(${base}) * ${power}`
          : power);
        i = end;
        continue;
      }
    }
    if (token.kind === 'id' && token.text === 'textureLod' && tokens[i + 1]?.text === '(') {
      const { args, end } = readCallArgs(tokens, i + 1);
      // All generated shaders target WebGL 2 / GLSL ES 3.00, where textureLod
      // is available in both vertex and fragment stages. The EXT spelling is
      // a WebGL 1 compatibility helper and is not defined in Three's vertex
      // shader prefix.
      output.push(`textureLod(${args.slice(0, 3).map((arg) => transformStage(tokensToSource(arg), stage)).join(', ')})`);
      i = end;
      continue;
    }
    if (token.kind === 'id' && ['max', 'min'].includes(token.text) && tokens[i + 1]?.text === '(') {
      const { args, end } = readCallArgs(tokens, i + 1);
      if (args.length === 2 && args.some((arg) => arg.some((part) => part.kind === 'id' && ['pow', 'length', 'dot', 'sqrt', 'sin', 'cos'].includes(part.text)))) {
        const converted = args.map((arg) => {
          const value = tokensToSource(arg);
          return /^[-+]?\d+$/.test(value) ? `${value}.0` : transformStage(value, stage);
        });
        output.push(`${token.text}(${converted.join(', ')})`);
        i = end;
        continue;
      }
    }
    if (token.kind === 'id') {
      // Godot's VisualShader code generator names intermediate values with a
      // double underscore (for example `__dir`). GLSL ES reserves those
      // identifiers, so give generated locals a portable prefix before they
      // reach WebGL's shader compiler.
      const portableName = token.text.replace(/^__([A-Za-z_]\w*)$/, 'godot_$1');
      output.push(names[token.text] ?? portableName);
    }
    else output.push(token.text);
  }
  return output.join(' ');
}

function integerLiteral(tokens: Token[]): number | null {
  const source = tokens.map((token) => token.text).join('');
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(source)) return null;
  const value = Number(source);
  return Number.isSafeInteger(value) ? value : null;
}

function readCallArgs(tokens: Token[], openIndex: number): { args: Token[][]; end: number } {
  const args: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.text === '(' || token.text === '[') depth++;
    else if (token.text === ')' || token.text === ']') {
      if (token.text === ')' && depth === 0) { if (current.length) args.push(current); return { args, end: i }; }
      depth--;
    }
    if (token.text === ',' && depth === 0) { args.push(current); current = []; }
    else current.push(token);
  }
  return { args, end: tokens.length - 1 };
}

function tokensToSource(tokens: Token[]): string {
  let source = '';
  let previous = '';
  for (const token of tokens) {
    const noSpace = !source || token.text === '.' || previous === '.' || token.text === '(' || token.text === '[' || previous === '(' || previous === '[' || [',', ';', ')', ']'].includes(token.text);
    if (!noSpace) source += ' ';
    source += token.text;
    previous = token.text;
  }
  return source;
}
function indent(source: string): string { return source.split('\n').map((line) => `  ${line}`).join('\n'); }

function uniformDefault(declaration: UniformDeclaration): unknown {
  let parsed: GodotValue | undefined;
  if (declaration.defaultExpression) {
    try { parsed = new GodotValueParser(declaration.defaultExpression).parse(); } catch { parsed = undefined; }
  }
  if (parsed === undefined) {
    if (declaration.type === 'sampler2D') return null;
    if (declaration.type === 'bool') return false;
    if (declaration.type === 'int' || declaration.type === 'float') return 0;
    if (declaration.type === 'vec2') return new Vector2();
    if (declaration.type === 'vec3') return declaration.sourceColor ? new Color(1, 1, 1) : new Vector3();
    if (declaration.type === 'vec4') return new Vector4();
    return 0;
  }
  const tuple = isGodotCall(parsed) ? parsed.args.map(Number) : [];
  if (declaration.type === 'vec2' && tuple.length >= 1) return new Vector2(tuple[0], tuple[1] ?? tuple[0]);
  if (declaration.type === 'vec3' && tuple.length >= 1) return declaration.sourceColor ? new Color(tuple[0], tuple[1] ?? tuple[0], tuple[2] ?? tuple[0]) : new Vector3(tuple[0], tuple[1] ?? tuple[0], tuple[2] ?? tuple[0]);
  if (declaration.type === 'vec4' && tuple.length >= 1) return new Vector4(tuple[0], tuple[1] ?? tuple[0], tuple[2] ?? tuple[0], tuple[3] ?? tuple[0]);
  if (isGodotCall(parsed) && parsed.name === 'Color') return new Color(Number(parsed.args[0] ?? 1), Number(parsed.args[1] ?? 1), Number(parsed.args[2] ?? 1));
  return parsed;
}
