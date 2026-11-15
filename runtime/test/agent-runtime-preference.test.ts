import test from 'node:test';
import assert from 'node:assert/strict';
import {DB} from '../src/shared/sqlite.js';
import {preferredAgentRuntimeMode} from '../src/server/machine-agent-runtime.js';

test('runtime preference uses actual mode before successful history and never invents evidence', t => {
 const db=new DB(':memory:');t.after(()=>db.close());
 assert.equal(preferredAgentRuntimeMode(db,'missing'),undefined);
 db.exec("CREATE TABLE machine_agent_runtime(machine_id TEXT PRIMARY KEY,runtime_mode TEXT);CREATE TABLE machine_deployments(id TEXT,machine_id TEXT,status TEXT,plan_json TEXT,created_at TEXT)");
 db.run("INSERT INTO machine_deployments VALUES('old','host','succeeded',?,?)",JSON.stringify({runtime_mode:'root'}),'2026-01-01');
 assert.equal(preferredAgentRuntimeMode(db,'host'),'root');
 db.run("INSERT INTO machine_agent_runtime VALUES('host','user')");
 assert.equal(preferredAgentRuntimeMode(db,'host'),'user');
 db.run("DELETE FROM machine_agent_runtime");db.run("UPDATE machine_deployments SET plan_json='invalid'");
 assert.equal(preferredAgentRuntimeMode(db,'host'),undefined);
});
