import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  cacheReference,
  cachePolicy,
  importCachedImage,
  prepareCachedImages,
} from "../src/operations/image-cache.js";
test("cache references explicitly map Hub and selected publishing host; unknown registries keep their path", () => {
  const policy = {
    version: 1,
    allow_upstream: true,
    origin_host: "registry.example.test",
    hub_endpoint: "http://10.1.0.1:5001",
    origin_endpoint: "http://10.1.0.2:5002",
  };
  assert.deepEqual(cacheReference("alpine:3.23", policy), {
    endpoint: policy.hub_endpoint,
    repository: "library/alpine",
    reference: "3.23",
  });
  assert.equal(
    cacheReference("registry.example.test/team/app:v2", policy)?.repository,
    "team/app",
  );
  assert.equal(
    cacheReference("unrelated.example.test/team/app:v2", policy),
    undefined,
  );
  for (const endpoint of [
    "http://8.8.8.8:80",
    "http://169.254.169.254:80",
    "http://name.internal:5000",
    "http://10.0.0.1:5000/path",
    "http://user:secret@10.0.0.1:5000",
  ])
    assert.throws(() => cachePolicy({ ...policy, hub_endpoint: endpoint }));
});
test("cache import verifies content addresses, rejects redirects/corruption and cleans temporary data on every failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lm-cache-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = Buffer.from(
      JSON.stringify({
        os: "linux",
        architecture: "amd64",
        rootfs: { type: "layers", diff_ids: [] },
      }),
    ),
    digest = "sha256:" + createHash("sha256").update(config).digest("hex");
  const manifest = { schemaVersion: 2, config: { digest }, layers: [] };
  let mode = "ok";
  const server = createServer((req, res) => {
    if (mode === "redirect") {
      res.writeHead(302, { Location: "http://169.254.169.254/" });
      res.end();
      return;
    }
    res.end(
      req.url?.includes("/manifests/")
        ? JSON.stringify(manifest)
        : mode === "corrupt"
          ? "wrong"
          : config,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const policy = {
    version: 1,
    allow_upstream: false,
    origin_host: "registry.example.test",
    origin_endpoint: "http://127.0.0.1:" + (server.address() as any).port,
  };
  const commands: string[][] = [],
    context: any = {
      signal: new AbortController().signal,
      command: async (_: string, args: string[]) => {
        commands.push(args);
        if(args[1]==='inspect'&&!args.at(-1)?.startsWith('lightmoni-cache/verified:'))throw Error('No such image');
        return {
          stdout:
            args[0] === "info"
              ? "linux/amd64"
              : args[1] === "inspect"
                ? JSON.stringify({
                    Id: digest,
                    Os: "linux",
                    Architecture: "amd64",
                    RootFS: { Layers: [] },
                  })
                : "",
          stderr: "",
        };
      },
    };
  const imported = await importCachedImage(
    "registry.example.test/test:v1",
    policy,
    root,
    context,
  );
  assert.equal(imported?.image_id, digest);
  assert(commands.some((a) => a[1] === "load"));
  assert.deepEqual(await readdir(root), []);
  mode = "corrupt";
  await assert.rejects(
    importCachedImage("registry.example.test/test:v1", policy, root, context),
    /CACHE_DIGEST_MISMATCH/,
  );
  assert.deepEqual(await readdir(root), []);
  mode = "redirect";
  await assert.rejects(
    importCachedImage("registry.example.test/test:v1", policy, root, context),
  );
  assert.deepEqual(await readdir(root), []);
  const services = { app: { image: "registry.example.test/test:v1" } };
  const result = await prepareCachedImages(
    { services },
    { ...policy, allow_upstream: true },
    root,
    context,
  );
  assert.equal(result[0].source, "upstream-fallback");
  assert.equal(services.app.image, "registry.example.test/test:v1");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    importCachedImage("registry.example.test/test:v1", policy, root, {
      ...context,
      signal: aborted.signal,
    }),
  );
  assert.deepEqual(await readdir(root), []);
});

test('local Docker references precede cache requests, including latest, while platform/digest mismatches are not reused',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lm-local-first-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let requests=0;const server=createServer((_,res)=>{requests++;res.writeHead(503);res.end()});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});
 const policy={version:1,allow_upstream:true,origin_host:'registry.example.test',origin_endpoint:'http://127.0.0.1:'+(server.address() as any).port};
 const id='sha256:'+'a'.repeat(64),expected='sha256:'+'b'.repeat(64);
 async function run(image:string,architecture='amd64',repoDigest=expected){
  const manifest:any={services:{app:{image}}},commands:string[][]=[];
  const context:any={signal:new AbortController().signal,command:async(_:string,args:string[])=>{commands.push(args);if(args[0]==='info')return{stdout:'linux/amd64',stderr:''};if(args[1]==='inspect'&&args.at(-1)===image)return{stdout:JSON.stringify({Id:id,Os:'linux',Architecture:architecture,RepoDigests:['registry.example.test/app@'+repoDigest]}),stderr:''};throw Error('No such image')}};
  return {manifest,commands,result:await prepareCachedImages(manifest,policy,root,context)};
 }
 for(const image of ['registry.example.test/app:latest','registry.example.test/app@'+expected]){
  const hit=await run(image);assert.equal(hit.result[0].source,'local');assert.equal(hit.result[0].downloaded_bytes,0);assert.equal(hit.manifest.services.app.image,id);assert.equal(hit.manifest.services.app.pull_policy,'never');assert(!hit.commands.some(a=>a[1]==='load'));
 }
 assert.equal(requests,0);
 assert.equal((await run('registry.example.test/app:v1','arm64')).result[0].source,'upstream-fallback');
 assert.equal((await run('registry.example.test/app@'+expected,'amd64','sha256:'+'c'.repeat(64))).result[0].source,'upstream-fallback');assert.equal(requests,2);
});

test('a registry alias reuses a local manifest without downloading config/layers or importing another image',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lm-local-alias-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=Buffer.from(JSON.stringify({os:'linux',architecture:'amd64',rootfs:{type:'layers',diff_ids:[]}}));
 const configDigest='sha256:'+createHash('sha256').update(config).digest('hex');
 const manifest=Buffer.from(JSON.stringify({schemaVersion:2,config:{digest:configDigest},layers:[]}));const manifestDigest='sha256:'+createHash('sha256').update(manifest).digest('hex');
 const paths:string[]=[];const server=createServer((req,res)=>{paths.push(req.url!);res.end(req.url?.includes('/manifests/')?manifest:config)});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()});
 const commands:string[][]=[],id='sha256:'+'d'.repeat(64);
 const context:any={signal:new AbortController().signal,command:async(_:string,args:string[])=>{commands.push(args);if(args[0]==='info')return{stdout:'linux/amd64',stderr:''};if(args[1]==='ls')return{stdout:JSON.stringify({Repository:'original.example.test/team/app',Digest:manifestDigest}),stderr:''};if(args[1]==='inspect')return{stdout:JSON.stringify({Id:id,Os:'linux',Architecture:'amd64',RepoDigests:['original.example.test/team/app@'+manifestDigest]}),stderr:''};throw Error('Unexpected Docker mutation')}};
 const result=await importCachedImage('registry.example.test/team/app:v1',{version:1,allow_upstream:false,origin_host:'registry.example.test',origin_endpoint:'http://127.0.0.1:'+(server.address() as any).port},root,context);
 assert.equal(result?.source,'local');assert.equal(result?.image_id,id);assert.deepEqual(paths,['/v2/team/app/manifests/v1']);assert(!commands.some(a=>a[1]==='load'));assert.deepEqual(await readdir(root),[]);
});
