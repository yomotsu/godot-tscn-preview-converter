/** Capture handles during the drop event, before DataTransfer access expires. */
export async function collectDroppedFiles(dataTransfer) {
  const roots = [...(dataTransfer.items??[])].filter(item => item.kind === 'file').map(item => {
    let handle,entry,file,captureError;
    try { handle=item.getAsFileSystemHandle?.(); } catch(error) { captureError=error; }
    try { entry=item.webkitGetAsEntry?.(); } catch(error) { captureError=error; }
    try { file=item.getAsFile(); } catch(error) { captureError=error; }
    return {handle,entry,file,captureError};
  });
  const files = [];
  if(!roots.length)return [...(dataTransfer.files??[])].map(file=>({path:file.webkitRelativePath||file.name,file}));
  const ignored = name => ['.godot','.git','node_modules'].includes(name);
  async function visitHandle(handle,parent='') {
    const path=parent+handle.name;
    if(handle.kind==='file') files.push({path,file:await handle.getFile()});
    else if(handle.kind==='directory'&&!ignored(handle.name)) {
      for await(const [,child] of handle.entries()) await visitHandle(child,path+'/');
    }
  }
  async function visit(entry, parent = '') {
    const path = parent + entry.name;
    if (entry.isFile) {
      const file = await new Promise((resolve,reject) => entry.file(resolve,reject));
      files.push({path,file});
    } else if (entry.isDirectory && !ignored(entry.name)) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve,reject) => reader.readEntries(resolve,reject));
        if (!batch.length) break;
        await Promise.all(batch.map(child => visit(child,path + '/')));
      }
    }
  }
  for (const root of roots) {
    let handle;
    if(root.handle)try{handle=await root.handle;}catch{/* Older browsers can fall back to directory entries. */}
    try {
      if(handle)await visitHandle(handle);
      else if(root.entry)await visit(root.entry);
      else if(root.file)files.push({path:root.file.webkitRelativePath||root.file.name,file:root.file});
      else if(root.captureError)throw root.captureError;
    }catch(error){throw new Error(`フォルダ '${handle?.name??root.entry?.name??root.file?.name??''}' を読み取れませんでした。「フォルダを選択」でも読み込めます。${error instanceof Error?error.message:String(error)}`);}
  }
  return files;
}
