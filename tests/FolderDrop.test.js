import { describe, it, expect } from 'vitest';
import { collectDroppedFiles } from '../src/app/folder-drop.js';

const leaf=name=>({name,isFile:true,file:resolve=>resolve(new Blob([name]))});
const directory=(name,batches)=>({name,isDirectory:true,createReader:()=>({readEntries:resolve=>resolve(batches.shift()??[])})});
describe('Folder drop traversal',()=>{
  it('accepts a FileList when the browser does not provide drag items',async()=>{
    const file=Object.assign(new Blob(['scene']),{name:'extra.tscn'});
    expect(await collectDroppedFiles({files:[file]})).toEqual([{path:'extra.tscn',file}]);
  });
  it('reads every directory batch and preserves relative paths',async()=>{
    const children=Array.from({length:130},(_,i)=>leaf(i+'.tscn'));
    const root=directory('Pack',[children.slice(0,100),children.slice(100),[]]);
    const result=await collectDroppedFiles({items:[{kind:'file',webkitGetAsEntry:()=>root,getAsFile:()=>null}]});
    expect(result).toHaveLength(130);
    expect(result[129].path).toBe('Pack/129.tscn');
  });
  it('ignores Godot import caches and supports individual files',async()=>{
    const root=directory('Pack',[[directory('.godot',[[leaf('cache')]]),leaf('main.tscn')],[]]);
    const file=new Blob(['shader']);
    const result=await collectDroppedFiles({items:[{kind:'file',webkitGetAsEntry:()=>root,getAsFile:()=>null},{kind:'file',getAsFile:()=>Object.assign(file,{name:'a.gdshader'})}]});
    expect(result.map(e=>e.path)).toEqual(['Pack/main.tscn','a.gdshader']);
  });
  it('uses modern handles when the legacy directory API throws EncodingError',async()=>{
    const blob=new Blob(['[gd_scene format=3]']);
    const handle={kind:'directory',name:'Pack',async *entries(){yield ['main.tscn',{kind:'file',name:'main.tscn',getFile:async()=>blob}];}};
    const result=await collectDroppedFiles({items:[{kind:'file',getAsFileSystemHandle:()=>Promise.resolve(handle),webkitGetAsEntry:()=>{throw new DOMException('Malformed URI','EncodingError');},getAsFile:()=>null}]});
    expect(result).toEqual([{path:'Pack/main.tscn',file:blob}]);
  });
  it('reports an unreadable folder with a useful path',async()=>{
    const entry={name:'Pack',isDirectory:true,createReader:()=>({readEntries:(_,reject)=>reject(new DOMException('Malformed URI','EncodingError'))})};
    await expect(collectDroppedFiles({items:[{kind:'file',webkitGetAsEntry:()=>entry,getAsFile:()=>null}]})).rejects.toThrow("フォルダ 'Pack'");
  });

});
