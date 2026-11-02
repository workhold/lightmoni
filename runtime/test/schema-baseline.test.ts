import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DB} from '../src/shared/sqlite.js';
import {createApp} from '../src/server/app.js';
import {initializeCenterSchema} from '../src/server/schema.js';

test('fresh center creates the final schema and restart preserves edits without upgrade DDL', async t=>{
  const directory=mkdtempSync(join(tmpdir(),'lm-baseline-')),statements:string[]=[];
  const ch=createServer((req,res)=>{
    const chunks:Buffer[]=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      statements.push(Buffer.concat(chunks).toString());res.setHeader('content-type','application/json');res.end('{"meta":[],"data":[],"rows":0}');
    });
  });
  await new Promise<void>(resolve=>ch.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{ch.closeAllConnections();await new Promise<void>(resolve=>ch.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
  const config={dataDir:directory,chURL:'http://127.0.0.1:'+(ch.address() as any).port,chUser:'writer',chPassword:'fixture-only',externalURL:'http://127.0.0.1:8080',monitor:false};
  let app=await createApp(config);
  try {
    assert.deepEqual(app.deps.db.all('SELECT version FROM center_schema'),[{version:1}]);
    for(const table of ['catalog','machine_credentials','machine_deployments','agent_jobs','task_runs','ops_platform_resources','ops_cluster_instances'])
      assert.ok(app.deps.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",table),table);
    const tables=app.deps.db.all<{name:string}>("SELECT name FROM sqlite_master WHERE type='table'").map(row=>row.name);
    assert.equal(tables.some(name=>/migration|legacy/.test(name)),false);
    for(const table of ['agent_groups','agent_node_labels','ops_platform_instances','ops_system_application_aliases'])assert.equal(tables.includes(table),false);
    assert.equal(app.deps.db.get<{n:number}>('SELECT count(*) n FROM agent_tasks')?.n,3);
    await assert.rejects(app.deps.cat.ensure('lightmoni_agent','log'),/unsupported system table name/);
    app.deps.db.run("UPDATE agent_tasks SET enabled=0 WHERE id='platform-default:host'");
    app.deps.db.run("DELETE FROM dashboards WHERE id='system-center'");
  } finally {await app.close();}
  app=await createApp(config);
  try {
    assert.equal(app.deps.db.get<{enabled:number}>("SELECT enabled FROM agent_tasks WHERE id='platform-default:host'")?.enabled,0);
    assert.equal(app.deps.db.get<{n:number}>('SELECT count(*) n FROM agent_tasks')?.n,3);
    assert.equal(app.deps.db.get("SELECT id FROM dashboards WHERE id='system-center'"),undefined);
    assert.equal(statements.some(sql=>/ALTER TABLE|lightmoni_(?:center|agent|sdk)|value Decimal/i.test(sql)),false);
    assert.equal(app.router.list().some(route=>route.path.includes('agent-groups')||route.path.endsWith('/agents/:id/group')),false);
  } finally {await app.close();}
});

test('pre-release center is rejected without rewriting development records',()=>{
  const db=new DB(':memory:');
  try {
    db.exec("CREATE TABLE catalog(id TEXT PRIMARY KEY); INSERT INTO catalog VALUES('development-record');");
    assert.throws(()=>initializeCenterSchema(db),/Pre-release center database is unsupported/);
    assert.deepEqual(db.all('SELECT id FROM catalog'),[{id:'development-record'}]);
    assert.equal(db.get("SELECT 1 FROM sqlite_master WHERE name='center_schema'"),undefined);
  } finally {db.close();}
});
