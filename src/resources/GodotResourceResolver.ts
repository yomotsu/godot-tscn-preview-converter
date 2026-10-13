import { stripShaderComments } from '../converters/GodotShaderConverter.js';
import { TextureLoader, SRGBColorSpace, type Texture } from 'three';

export interface GodotResourceResolverOptions {
  resourcePath?: string;
  resourceMap?: Record<string, string>;
  /** Resolve duplicate Godot paths using the project that owns the requesting file. */
  resourceMapResolver?: (path: string, ownerUrl: string) => string | null | undefined;
  fetcher?: typeof fetch;
}

/** Maps Godot resource identifiers to browser URLs and caches loaded resources. */
export class GodotResourceResolver {
  private resourcePath: string;
  private readonly resourceMap: Map<string, string>;
  private readonly fetcher: typeof fetch;
  private readonly resourceMapResolver?: GodotResourceResolverOptions['resourceMapResolver'];
  private readonly textCache = new Map<string, Promise<string>>();
  private readonly bufferCache = new Map<string, Promise<ArrayBuffer>>();
  private readonly textureCache = new Map<string, Promise<Texture>>();
  private readonly textureLoader = new TextureLoader();

  constructor(options: GodotResourceResolverOptions = {}) {
    this.resourcePath = options.resourcePath ?? '';
    this.resourceMap = new Map(Object.entries(options.resourceMap ?? {}));
    this.resourceMapResolver = options.resourceMapResolver;
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
  }

  setResourcePath(path: string): this {
    this.resourcePath = path ? `${path.replace(/\/$/, '')}/` : '';
    return this;
  }

  setResourceMap(map: Record<string, string>): this {
    for (const [key, value] of Object.entries(map)) this.resourceMap.set(key, value);
    return this;
  }

  /** Resolve res://, uid:// or relative paths to a URL. Exact path maps take priority. */
  resolvePath(path: string, ownerUrl = ''): string {
    const ownerScoped = this.resourceMapResolver?.(path, ownerUrl);
    if (ownerScoped === null) throw new Error(`Cannot resolve '${path}' in the project that owns '${ownerUrl}'`);
    if (ownerScoped) return ownerScoped;
    const mapped = this.resourceMap.get(path);
    if (mapped) return mapped;

    if (path.startsWith('uid://')) throw new Error(`Cannot resolve '${path}' without an ext_resource path or explicit resource map entry`);
    if (path.startsWith('res://')) return joinUrl(this.resourcePath, path.slice('res://'.length));
    if (/^(https?:|data:|blob:|\/)/.test(path)) return path;
    // Blob URLs have no directory. Recover their logical Godot path for relative references.
    const logicalOwner = [...this.resourceMap].filter(([key,value]) => value === ownerUrl && key.startsWith('res://')).sort((a,b) => b[0].length-a[0].length)[0]?.[0] ?? ownerUrl;
    const base = logicalOwner ? logicalOwner.slice(0, logicalOwner.lastIndexOf('/') + 1) : this.resourcePath;
    const joined = joinUrl(base, path);
    return this.resourceMap.get(joined) ?? this.resourceMap.get(decodeURI(joined)) ?? joined;
  }

  loadText(path: string, ownerUrl = ''): Promise<string> {
    const url = this.resolvePath(path, ownerUrl);
    let pending = this.textCache.get(url);
    if (!pending) {
      pending = this.fetcher(url).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} while loading '${url}'`);
        return response.text();
      }).catch((error: unknown) => {
        this.textCache.delete(url);
        throw new Error(`Failed to load text resource '${path}' (${url}): ${messageOf(error)}`);
      });
      this.textCache.set(url, pending);
    }
    return pending;
  }

  /** Expand quoted Godot includes relative to each source, with cycle detection. */
  async loadShaderSource(path: string, ownerUrl = '', stack: string[] = []): Promise<string> {
    const url = this.resolvePath(path, ownerUrl);
    if (stack.includes(url)) throw new Error(`Shader include cycle: ${[...stack, url].join(' -> ')}`);
    if (stack.length >= 64) throw new Error(`Shader include nesting exceeds 64 at '${path}'`);
    const source = await this.loadText(url);
    const clean = stripShaderComments(source);
    const directives = [...clean.matchAll(/^[ \t]*#include[ \t]+"([^"\n]+)"[ \t]*\r?$/gm)];
    let output = '', offset = 0;
    for (const directive of directives) {
      output += clean.slice(offset, directive.index);
      output += '\n' + await this.loadShaderSource(directive[1], url, [...stack, url]) + '\n';
      offset = directive.index! + directive[0].length;
    }
    return output + clean.slice(offset);
  }

  loadArrayBuffer(path: string, ownerUrl = ''): Promise<ArrayBuffer> {
    const url = this.resolvePath(path, ownerUrl);
    let pending = this.bufferCache.get(url);
    if (!pending) {
      pending = this.fetcher(url).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} while loading '${url}'`);
        return response.arrayBuffer();
      }).catch((error: unknown) => {
        this.bufferCache.delete(url);
        throw new Error(`Failed to load binary resource '${path}' (${url}): ${messageOf(error)}`);
      });
      this.bufferCache.set(url, pending);
    }
    return pending;
  }

  loadTexture(path: string, ownerUrl = '', colorTexture = false): Promise<Texture> {
    const url = this.resolvePath(path, ownerUrl);
    const key = `${url}|${colorTexture ? 'color' : 'data'}`;
    let pending = this.textureCache.get(key);
    if (!pending) {
      pending = this.textureLoader.loadAsync(url).then((texture) => {
        if (colorTexture) texture.colorSpace = SRGBColorSpace;
        return texture;
      }).catch((error: unknown) => {
        this.textureCache.delete(key);
        throw new Error(`Failed to load texture '${path}' (${url}): ${messageOf(error)}`);
      });
      this.textureCache.set(key, pending);
    }
    return pending;
  }

  clearCache(): void {
    this.textCache.clear();
    this.bufferCache.clear();
    for (const texturePromise of this.textureCache.values()) void texturePromise.then((texture) => texture.dispose()).catch(() => undefined);
    this.textureCache.clear();
  }
}

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  try { return new URL(path, base).toString(); }
  catch { return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`; }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
