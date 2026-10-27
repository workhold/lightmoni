import { constants } from 'node:fs';
import { open, mkdir, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Durable, fail-closed writer exclusion across runners sharing the node data directory.
 * A crash/unknown result deliberately keeps the marker. An operator must inspect
 * both processes and daemon state before removing it; PID expiry alone is not fencing.
 */
export async function acquireOperationLock(dataDir: string, operationID: string, now: Date) {
  const directory=join(dataDir,'operations');
  await mkdir(directory,{recursive:true,mode:0o700});
  const dir=await lstat(directory);
  if(!dir.isDirectory()||dir.isSymbolicLink())throw Object.assign(Error('unsafe_operations_lock_directory'),{code:'unsafe_operations_lock_directory'});
  await syncDirectory(dataDir);
  const path=join(directory,'execution.lock');
  let handle;
  try {handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}
  catch(e:any){if(e.code==='EEXIST')throw Object.assign(Error('operations_node_locked'),{code:'operations_node_locked'});throw e;}
  const stamp={version:1,operation_id:operationID,pid:process.pid,created_at:now.toISOString()};
  try {await handle.writeFile(JSON.stringify({...stamp,state:'executing'}));await handle.sync();await syncDirectory(directory);}
  catch(e){await handle.close();throw e;}
  const own=await handle.stat();
  return {
    async finish(unknown: boolean) {
      try {
        if(unknown){await handle.truncate(0);await handle.write(JSON.stringify({...stamp,state:'unknown'}),0,'utf8');await handle.sync();}
      }finally{await handle.close();}
      if(!unknown){const current=await lstat(path);if(current.ino===own.ino&&current.dev===own.dev&&!current.isSymbolicLink()){await unlink(path);await syncDirectory(directory);}}
    },
  };
}
