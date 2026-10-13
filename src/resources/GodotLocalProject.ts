import { stripShaderComments } from '../converters/GodotShaderConverter.js';
import { TSCNParser } from '../tscn/TSCNParser.js';

export interface GodotLocalFile { path: string; file: Blob }
export interface GodotLocalScene { id: string; name: string; path: string; effect: boolean }

/** A dropped directory is a temporary browser resource map; files stay on this computer. */
export class GodotLocalProject {
  readonly scenes: GodotLocalScene[] = [];
  readonly files: GodotLocalFile[] = [];
  readonly resourceMap: Record<string, string> = {};
  readonly warnings: string[] = [];
  private readonly urls = new Set<string>();
  private readonly pathsByUrl = new Map<string, string>();
  private readonly localEntries: Array<{ path: string; relative: string; url: string }> = [];
  private disposed = false;

  private constructor(private readonly revoke: (url: string) => void) {}

  static async create(files: GodotLocalFile[], createUrl = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), preserveRoot = false): Promise<GodotLocalProject> {
    const project = new GodotLocalProject(revoke);
    const parser = new TSCNParser();
    const entries = files.map(entry => ({ ...entry, path: normalize(entry.path) })).filter(entry => !entry.path.split('/').some(p => p === '.godot' || p === '.git' || p === 'node_modules'));
    const first = entries[0]?.path.split('/')[0];
    const stripRoot = !preserveRoot && entries.length > 0 && entries.every(e => e.path.startsWith(first + '/'));
    const indexed = entries.map(entry => ({...entry, relative: stripRoot ? entry.path.slice(first.length + 1) : entry.path, url: ''}));
    try {
      for (const entry of indexed) {
        project.files.push({path:entry.relative,file:entry.file});
        entry.url = createUrl(entry.file);project.urls.add(entry.url);project.pathsByUrl.set(entry.url,entry.relative);
        project.localEntries.push({path:entry.path,relative:entry.relative,url:entry.url});
        project.resourceMap['res://' + entry.path] = entry.url;
        project.resourceMap['res://' + entry.relative] = entry.url;
      }
      for (const entry of indexed) {
        if (!/\.(tscn|tres)$/i.test(entry.path)) continue;
        if (/\.tscn$/i.test(entry.path)) project.scenes.push({id:entry.relative,name:entry.relative,path:'res://' + entry.relative,effect:entry.relative.split('/').includes('effects')});
        try {
          const source=await entry.file.text();
          const parsed = /\.tres$/i.test(entry.path) ? parser.parseResource(source) : parser.parse(source);
          const uid = parsed.scene?.attributes.uid;
          if (typeof uid === 'string') project.resourceMap[uid] = entry.url;
          for (const resource of parsed.externalResources) {
            const path = resource.attributes.path;
            if (typeof path !== 'string' || !path.startsWith('res://')) continue;
            let resolved = project.resourceMap[path];
            if (!resolved) {
              const sourcePath = path.slice(6);
              let matches = findPathMatches(indexed, sourcePath);
              const scopedMatches = findProjectMatches(entry,matches);
              if(scopedMatches.length)matches=scopedMatches;
              // Some StatusFXFree downloads omit poison_overlay.tres while
              // retaining the compatible status overlay material.
              const fallbackPath = sourcePath.endsWith('/StatusFX/effects/overlay/poison_overlay.tres')
                ? sourcePath.replace(/poison_overlay\.tres$/, 'shatter_overlay.tres')
                : undefined;
              if (!matches.length && fallbackPath) {
                matches = findPathMatches(indexed, fallbackPath);
                const scopedFallbacks = findProjectMatches(entry,matches);
                if(scopedFallbacks.length)matches=scopedFallbacks;
              }
              if (matches.length === 1) resolved = project.resourceMap[path] = matches[0].url;
              else project.warnings.push(`${entry.relative}: ${matches.length ? '候補が複数あります' : 'フォルダ内に見つかりません'}: ${path}`);
            }
            if (resolved && typeof resource.attributes.uid === 'string') project.resourceMap[resource.attributes.uid] = resolved;
          }
        } catch (error) { project.warnings.push(`${entry.relative}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      // Include files are not ext_resources. Register their logical aliases as well.
      for (const entry of indexed) {
        if (!/\.gdshader(?:inc)?$/i.test(entry.path)) continue;
        const source = stripShaderComments(await entry.file.text());
        const owners = Object.entries(project.resourceMap).filter(([key, url]) => url === entry.url && key.startsWith('res://')).map(([key]) => key);
        for (const include of source.matchAll(/^[ \t]*#include[ \t]+"([^"\n]+)"[ \t]*\r?$/gm)) {
          for (const owner of owners) {
            const logical = include[1].startsWith('res://') ? include[1] : 'res://' + normalize(owner.slice(6, owner.lastIndexOf('/') + 1) + include[1]);
            if (project.resourceMap[logical]) continue;
            let matches = findPathMatches(indexed, logical.slice(6));
            const scopedMatches = findProjectMatches(entry,matches);
            if(scopedMatches.length)matches=scopedMatches;
            if (matches.length === 1) project.resourceMap[logical] = matches[0].url;
            else project.warnings.push(`${entry.relative}: include ${matches.length ? '候補が複数あります' : 'フォルダ内に見つかりません'}: ${logical}`);
          }
        }
      }
      project.scenes.sort((a,b) => Number(b.effect)-Number(a.effect) || a.name.localeCompare(b.name));
      return project;
    } catch (error) { project.dispose();throw error; }
  }

  /** Add another folder or loose files without changing existing scene IDs. */
  async append(files:GodotLocalFile[], createUrl=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL)):Promise<GodotLocalProject>{
    if(this.disposed)throw new Error('Local project is disposed');
    const incoming=await GodotLocalProject.create(files,createUrl,revoke);
    try {
      const merged=new Map(this.files.map(file=>[file.path,file]));
      for(const file of incoming.files){
        const candidates=this.files.filter(existing=>existing.path.endsWith('/'+file.path));
        const path=merged.has(file.path)?file.path:candidates.length===1?candidates[0].path:file.path;
        merged.set(path,{path,file:file.file});
      }
      return await GodotLocalProject.create([...merged.values()],createUrl,revoke,true);
    }finally{incoming.dispose();}
  }

  /** Reject missing local resources instead of fetching a similarly named server asset. */
  readonly fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!this.urls.has(url) || this.disposed) return new Response('Local resource not found', { status:404 });
    return fetch(input, init);
  };

  /** Resolve a res:// alias relative to the Godot project containing its owner file. */
  resolveResourcePath(path: string, ownerUrl: string): string | null | undefined {
    const ownerPath=this.pathsByUrl.get(ownerUrl);
    if(!ownerPath)return undefined;
    if(!path.startsWith('res://')) {
      if(/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path))return undefined;
      const relative=normalize(ownerPath.slice(0,ownerPath.lastIndexOf('/')+1)+path);
      return this.localEntries.find(entry=>entry.relative===relative)?.url ?? null;
    }
    const matches=findPathMatches(this.localEntries,path.slice(6));
    if(!matches.length)return null;
    const scoped=findProjectMatches({relative:ownerPath},matches);
    const candidates=scoped.length?scoped:matches;
    return candidates.length===1?candidates[0].url:null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const url of this.urls) this.revoke(url);
    this.urls.clear();
    this.pathsByUrl.clear();
    this.localEntries.length=0;
  }
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\','/').split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** Some downloaded Godot asset packs omit the `assets/` project folder on disk. */
function findPathMatches<T extends { path: string; relative: string }>(entries: T[], sourcePath: string): T[] {
  const target = normalize(sourcePath);
  const candidates = [target, target.startsWith('assets/') ? target.slice('assets/'.length) : target];
  const matches = entries.filter(entry => candidates.some(candidate =>
    candidate === entry.relative || candidate === entry.path ||
    candidate.endsWith('/' + entry.relative) || entry.path.endsWith('/' + candidate),
  ));
  return [...new Set(matches)];
}

function findProjectMatches<T extends {relative:string}>(owner:{relative:string},matches:T[]):T[]{
  const scope=projectScope(owner.relative);
  return matches.filter(entry=>projectScope(entry.relative)===scope);
}

function projectScope(path:string):string{
  const parts=path.split('/');
  const projectFolder=parts.findIndex(part=>part==='assets'||part==='addons');
  return (projectFolder>0?parts.slice(0,projectFolder):parts.slice(0,1)).join('/');
}
