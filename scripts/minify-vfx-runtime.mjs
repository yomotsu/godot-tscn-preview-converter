// After editing AbstractVFXMesh.js, run `npm run minify:runtime` or `npm run build`.
// Keep table packing and Terser options here so the dist runtime is regenerated
// with the same transforms and settings.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const runtimePath = fileURLToPath(new URL('src/app/three-class/AbstractVFXMesh.js', root));
const minifiedPath = fileURLToPath(new URL('dist/three-class/AbstractVFXMesh.min.js', root));
const terserPath = fileURLToPath(new URL('src/app/vendor/terser.bundle.min.js', root));
export async function minifyVfxRuntime() {
  const terserSource = await readFile(terserPath, 'utf8');
  const context = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder };
  context.globalThis = context;
  context.self = context;
  vm.runInNewContext(terserSource, context, { filename: terserPath });

  const packedTableDefinitions = [];
  const tableExpectations = new Map();
  const fastNoiseEnums = [
    'NoiseType', 'RotationType3D', 'FractalType', 'CellularDistanceFunction',
    'CellularReturnType', 'DomainWarpType', 'TransformType3D',
  ];

  function inlineFastNoiseEnums(source) {
    for (const name of fastNoiseEnums) {
      const declaration = new RegExp(`const ${name} = (\\{[^\\n]*\\});`);
      const match = source.match(declaration);
      if (!match) throw new Error(`${name} enum が見つかりません`);
      const members = Object.entries(JSON.parse(match[1]))
        .filter(([key, value]) => typeof value === 'number' && !/^\d+$/.test(key));
      const values = new Map(members);
      const memberNames = members.map(([key]) => key).join('|');
      source = source.replace(new RegExp(`FastNoiseLite\\.${name}\\.(${memberNames})\\b`, 'g'), (_match, member) => String(values.get(member)));
      source = source.replace(new RegExp(`\\b${name}\\.(${memberNames})\\b`, 'g'), (_match, member) => String(values.get(member)));
      source = source.replace(new RegExp(`^[\\t ]*static ${name} = ${name};[\\t ]*\\r?\\n`, 'gm'), '');
      source = source.replace(declaration, '');
    }
    return source;
  }

  function packNumericTable(source, field, tableName, bitsPerValue) {
    const pattern = new RegExp(`(${field}\\s*=\\s*)\\[([\\s\\S]*?)\\]`);
    const match = source.match(pattern);
    if (!match) throw new Error(`${field} テーブルが見つかりません`);

    const values = match[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
    tableExpectations.set(tableName, values.map(Number));
    const palette = [];
    const indices = new Map();
    const limit = 1 << bitsPerValue;
    for (const value of values) {
      if (!indices.has(value)) {
        if (palette.length >= limit) throw new Error(`${field} の値種類が圧縮上限を超えています`);
        indices.set(value, palette.length);
        palette.push(value);
      }
    }

    const bytes = Buffer.alloc(Math.ceil(values.length * bitsPerValue / 8));
    values.forEach((value, index) => {
      const bitOffset = index * bitsPerValue;
      const shift = 8 - bitsPerValue - bitOffset % 8;
      bytes[bitOffset >> 3] |= indices.get(value) << shift;
    });
    const payload = JSON.stringify(bytes.toString('base64'));
    packedTableDefinitions.push(`const ${tableName}=decodePackedNoiseTable(${payload},[${palette.join(',')}],${bitsPerValue},${values.length});`);
    return source.replace(pattern, (_match, prefix) => `${prefix}${tableName}`);
  }

  function encodeBase85(bytes) {
    const alphabet = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33))
      .filter((character) => character !== '"' && character !== '\\').slice(0, 85).join('');
    let encoded = '';
    for (let offset = 0; offset < bytes.length; offset += 4) {
      let value = 0;
      for (let index = 0; index < 4; index++) value = value * 256 + (bytes[offset + index] ?? 0);
      const chunk = Array(5);
      for (let index = 4; index >= 0; index--) { chunk[index] = alphabet[value % 85]; value = Math.floor(value / 85); }
      encoded += chunk.join('');
    }
    return `${bytes.length}:${encoded}`;
  }

  function packDecimalTable(source, field, tableName, paddingStride = 0) {
    const pattern = new RegExp(`(${field}\\s*=\\s*)\\[([\\s\\S]*?)\\]`);
    const match = source.match(pattern);
    if (!match) throw new Error(`${field} テーブルが見つかりません`);
    const values = match[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
    tableExpectations.set(tableName, values.map(Number));
    const decimals = [];
    values.forEach((value, index) => {
      // 3D vectors use a fourth, zero-valued padding component.
      if (paddingStride && index % paddingStride === paddingStride - 1) {
        if (Number(value) !== 0) throw new Error(`${field} padding is not zero`);
        return;
      }
      const decimal = value.match(/^(-?)(\d+)(?:\.(\d+))?$/);
      if (!decimal) throw new Error(`${field} contains an unsupported decimal: ${value}`);
      let exponent = (decimal[3] ?? '').length;
      let coefficient = Number(decimal[2] + (decimal[3] ?? ''));
      // Normalize short literals so most scales coincide without rounding digits.
      while (coefficient && coefficient < 1e9) { coefficient *= 10; exponent++; }
      if (!Number.isSafeInteger(coefficient)) {
        throw new Error(`${field} decimal exceeds the packing limit: ${value}`);
      }
      decimals.push({ coefficient: coefficient * 2 + Number(decimal[1] === '-'), exponent });
    });
    const exponentBase = Math.min(...decimals.map((value) => value.exponent));
    const exponentRange = Math.max(...decimals.map((value) => value.exponent)) - exponentBase + 1;
    const exponentScale = 2 ** Math.ceil(Math.log2(exponentRange));
    const packedValues = decimals.map(({ coefficient, exponent }) => coefficient * exponentScale + exponent - exponentBase);
    const bits = Math.ceil(Math.log2(Math.max(...packedValues) + 1));
    // Each accumulator holds at most bits + 7 bits, below Number's exact range.
    if (bits > 45) throw new Error(`${field} decimal exceeds the bit packing limit`);
    const bytes = [];
    let buffer = 0, available = 0;
    for (const packed of packedValues) {
      buffer = buffer * 2 ** bits + packed; available += bits;
      while (available >= 8) {
        available -= 8;
        const divisor = 2 ** available;
        bytes.push(Math.floor(buffer / divisor)); buffer %= divisor;
      }
    }
    if (available) bytes.push(buffer * 2 ** (8 - available));
    packedTableDefinitions.push(`const ${tableName}=decodePackedDecimalNoiseTable(${JSON.stringify(encodeBase85(Buffer.from(bytes)))},${values.length},${paddingStride},${bits},${exponentScale},${exponentBase});`);
    return source.replace(pattern, (_match, prefix) => `${prefix}${tableName}`);
  }

  const originalSource = await readFile(runtimePath, 'utf8');
  let source = originalSource;
  source = inlineFastNoiseEnums(source);
  source = packNumericTable(source, '_Gradients2D', 'noiseGradients2D', 4);
  source = packNumericTable(source, '_Gradients3D', 'noiseGradients3D', 2);
  source = packDecimalTable(source, '_RandVecs2D', 'noiseRandomVectors2D');
  source = packDecimalTable(source, '_RandVecs3D', 'noiseRandomVectors3D', 4);
  const decoder = `
  const decodePackedNoiseTable=(data,palette,bits,length)=>{
    const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0)),mask=(1<<bits)-1,values=Array(length);
    for(let i=0;i<length;i++){const offset=i*bits;values[i]=palette[bytes[offset>>3]>>((8-bits)-(offset&7))&mask]}
    return values;
  };
  const decodePackedDecimalNoiseTable=(data,length,stride,bits,scale,base)=>{
    const bytes=decodeBase85Data(data),values=Array(length);let offset=0,buffer=0,available=0;
    for(let i=0;i<length;i++){
      if(stride&&i%stride===stride-1){values[i]=0;continue}
      while(available<bits){buffer=buffer*256+bytes[offset++];available+=8}
      available-=bits;const divisor=2**available,packed=Math.floor(buffer/divisor);buffer%=divisor;
      const coefficient=Math.floor(packed/scale);
      values[i]=Number((coefficient%2?-1:1)*Math.floor(coefficient/2)+'e-'+(packed%scale+base));
    }
    return values;
  };
  `;
  // Execute the actual emitted decoders and require bit-for-bit numeric parity.
  const base85Decoder = source.match(/function decodeBase85Data[\s\S]*?(?=\nfunction decodeCompressedData)/)?.[0];
  if (!base85Decoder) throw new Error('Base85 decoder not found');
  const restoredTables = vm.runInNewContext(
    `${base85Decoder}\n${decoder}\n${packedTableDefinitions.join('\n')}\n({${[...tableExpectations.keys()].join(',')}})`,
    { atob }, { timeout: 1000 },
  );
  for (const [name, expected] of tableExpectations) {
    const restored = restoredTables[name];
    if (restored.length !== expected.length || expected.some((value, i) => !Object.is(value, restored[i]))) {
      throw new Error(`${name} packing changed a numeric value`);
    }
  }
  source = source.replace(/(import\s+\*\s+as\s+THREE\s+from\s+['"]three['"];?)/, (statement) => `${statement}${decoder}${packedTableDefinitions.join('\n')}`);
  const license = source.match(/\/\*! FastNoiseLite\.js[\s\S]*?\*\//)?.[0];
  if (!license) throw new Error('FastNoiseLite のライセンス表示が見つかりません');
  // These public-looking methods belong to the module-private noise class only.
  const noiseMethods = [...originalSource.slice(0, originalSource.indexOf('const generateGodotNoiseTextureData')).matchAll(/^    ([A-Z]\w*)\(/gm)].map((match) => match[1]);
  const result = await context.Terser.minify(source, {
    ecma: 2022,
    module: true,
    compress: { passes: 10, toplevel: true },
    mangle: {
      properties: {
        regex: new RegExp(`^_|^(?:${noiseMethods.join('|')})$`),
        reserved: ['_clips', '_config', '_mixer', '_playback', '_time', '_updateParticles'],
      },
    },
    format: { comments: false },
  });
  if (result.error) throw result.error;
  if (!result.code) throw new Error('AbstractVFXMesh.min.js を生成できませんでした');

  const output = Buffer.from(`${license}\n${result.code}\n`);
  console.log(`${runtimePath}: ${Buffer.byteLength(originalSource)} bytes (packed: ${Buffer.byteLength(source)})`);
  console.log(`AbstractVFXMesh.min.js: ${output.length} bytes (gzip: ${gzipSync(output).length}, Brotli: ${brotliCompressSync(output).length})`);

  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await minifyVfxRuntime();
  await mkdir(new URL('dist/three-class/', root), { recursive: true });
  await writeFile(minifiedPath, output);
}
