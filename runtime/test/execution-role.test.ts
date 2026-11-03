import test from "node:test";
import assert from "node:assert/strict";
import { assertOrdinaryAgentIdentity, assertAgentRuntimeIdentity } from "../src/shared/execution-role.js";
test("ordinary run refuses both real and effective root identities",()=>{
  assert.doesNotThrow(()=>assertOrdinaryAgentIdentity(1001,1001));
  for(const [uid,euid] of [[0,0],[1001,0],[0,1001]]) assert.throws(()=>assertOrdinaryAgentIdentity(uid,euid),/root/);
});
test("Agent modes verify the real OS identity and permission generation",()=>{
  for (const mode of ["root", "user"] as const)
    assert.deepEqual(assertAgentRuntimeIdentity(mode,2,999,999,987,"linux"),{mode,permission_generation:2,uid:999,gid:987});
  assert.throws(()=>assertAgentRuntimeIdentity("root",2,0,0,0,"linux"));
  assert.deepEqual(assertAgentRuntimeIdentity("user",1,999,999,987,"linux"),{mode:"user",permission_generation:1,uid:999,gid:987});
  for(const args of [["root",1,0,0,0,"darwin"],["user",1,0,0,0,"linux"],["root",0,999,999,987,"linux"]] as const)
    assert.throws(()=>assertAgentRuntimeIdentity(...args));
});
