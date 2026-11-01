import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { canonicalJSON, executorActivationID, parseStrictJSON, strictRecord } from "../shared/privileged-executor.js";
import { executorPublicKey, type ExecutorConfig } from "./config.js";
import { boundedFile, refuse, sha256 } from "./security.js";

export const EXECUTOR_ACTIVATION_FILE="/opt/lightmoni-executor/install-state.json";
/** Captured exactly once by a new process. An old process cannot attest a later
 * activation merely because maintenance has rewritten the on-disk marker. */
export function validateExecutorActivation(value:unknown,config:ExecutorConfig,release:{version:string;release:{build_id:string;source_revision:string;artifact_sha256:string;state_schema:1}},
  directory:string,enrolling=false):string {
  const p=strictRecord(value,["schema","maintenance_protocol","phase","release_name","identity","release","source","updated_at","activation_id"],
    ["schema","maintenance_protocol","phase","release_name","identity","release","updated_at","activation_id"]);
  if(p.schema!==1||p.maintenance_protocol!==1||!executorActivationID(p.activation_id)||!["enrollment_pending","program","unit","start","ready"].includes(p.phase))refuse("invalid_executor_activation");
  const r=p.release;
  if(!r||r.release_dir!==resolve(directory)||r.version!==release.version||["build_id","source_revision","artifact_sha256","state_schema"].some(key=>r[key]!==release.release[key as keyof typeof release.release]))refuse("executor_activation_release_mismatch");
  if(p.identity===null){if(!enrolling||p.phase!=="enrollment_pending")refuse("executor_activation_identity_mismatch");}
  else {
    const expected={executor_id:config.executor_id,machine_id:config.machine_id,agent_id:config.agent_id,center_instance_id:config.center_instance_id,install_generation:config.install_generation,public_key_sha256:sha256(executorPublicKey(config))};
    if(canonicalJSON(strictRecord(p.identity,Object.keys(expected)))!==canonicalJSON(expected))refuse("executor_activation_identity_mismatch");
  }
  return p.activation_id;
}
export function readExecutorActivation(config:ExecutorConfig,release:Parameters<typeof validateExecutorActivation>[2],enrolling=false):string {
  const record=parseStrictJSON(boundedFile(EXECUTOR_ACTIVATION_FILE,65536,true),65536);
  return validateExecutorActivation(record,config,release,fileURLToPath(new URL("../../../../",import.meta.url)),enrolling);
}
