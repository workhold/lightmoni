import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, fail } from "../src/shared/http.js";
import type { Dependencies } from "../src/shared/types.js";
import { registerInstall } from "../src/server/install.js";

async function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), "lm-uninstaller-download-")), router = new Router();
  let user: {id:string;name:string;role:string} | null = { id:"admin", name:"Admin", role:"admin" };
  const auth = { user: () => user, requireAdmin(c:any) { if (c.user?.role !== "admin") fail(403,"administrator required"); } };
  router.auth=auth as any;
  registerInstall({router,auth} as unknown as Dependencies,directory);
  const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end();}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
  return {directory,setUser(value:typeof user){user=value;},request:()=>fetch(`http://127.0.0.1:${(server.address() as any).port}/api/v1/agent-maintenance/uninstaller`)};
}

test("admin downloads the fixed offline script with exact SHA without an enrollment token",async t=>{
  const f=await fixture(t),script="#!/bin/sh\nprintf 'fixture offline cleanup\\n'\n";
  writeFileSync(join(f.directory,"uninstall.sh"),script);
  const response=await f.request();assert.equal(response.status,200);assert.match(response.headers.get("cache-control")??"",/no-store/);
  assert.deepEqual(await response.json(),{filename:"lightmoni-agent-uninstall.sh",sha256:createHash("sha256").update(script).digest("hex"),script});
  f.setUser({id:"member",name:"Member",role:"member"});assert.equal((await f.request()).status,403);
  f.setUser(null);assert.equal((await f.request()).status,401);
});

test("missing and unsafe script files are never returned",async t=>{
  const f=await fixture(t),path=join(f.directory,"uninstall.sh");
  assert.equal((await f.request()).status,404);
  mkdirSync(path);assert.equal((await f.request()).status,503);rmSync(path,{recursive:true});
  const outside=join(f.directory,"other.sh");writeFileSync(outside,"private fixture");symlinkSync(outside,path);
  assert.equal((await f.request()).status,503);rmSync(path);
  writeFileSync(path,"x".repeat(262145));assert.equal((await f.request()).status,503);
});
