import test from "node:test";
import assert from "node:assert/strict";
import { assertOrdinaryAgentIdentity } from "../src/shared/execution-role.js";
test("ordinary run refuses both real and effective root identities",()=>{
  assert.doesNotThrow(()=>assertOrdinaryAgentIdentity(1001,1001));
  for(const [uid,euid] of [[0,0],[1001,0],[0,1001]]) assert.throws(()=>assertOrdinaryAgentIdentity(uid,euid),/root/);
});
