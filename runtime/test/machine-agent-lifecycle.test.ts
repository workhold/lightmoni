import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { agentBootstrapCommand, agentProbeCommand, agentUninstallCommand, parseAgentProbe, agentRemovalProbeCommand, parseAgentRemovalProbe, agentRemovalCommand, freshAgentGuard } from "../src/server/machine-agent-lifecycle.js";
import { rewriteMaintenancePaths, writeMaintenanceStatShim } from "./helpers/maintenance-shell.js";
function fixture(t: any, failStop = false) {
  const root = mkdtempSync(join(tmpdir(), "lm-uninstall-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const commandDir = join(root, "commands"); mkdirSync(commandDir);
  writeMaintenanceStatShim(commandDir);
  for (const path of ["run", "tmp", "etc/systemd/system", "etc/lightmoni-agent", "var/lib/lightmoni-agent", "opt/lightmoni-agent", "usr/local/bin"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "etc/lightmoni-agent/config.json"), '{"control_credential":"secret-not-for-output"}');
  writeFileSync(join(root, "var/lib/lightmoni-agent/identity.json"), '{"agent_id":"known-agent","host_id":"host"}');
  writeFileSync(join(root, "var/lib/lightmoni-agent/queue.sqlite"), "must survive");
  writeFileSync(join(root, "etc/systemd/system/lightmoni-agent.service"), "unit");
  writeFileSync(join(root, "usr/local/bin/lightmoni-agent"), "launcher");
  const state = join(root, "state.json"); writeFileSync(state, JSON.stringify({ active: true, enabled: true, failStop }));
  writeFileSync(join(commandDir, "id"), '#!/bin/sh\necho 0\n', { mode: 0o755 });
  writeFileSync(join(commandDir, "systemctl"), `#!${process.execPath}\nconst fs=require('node:fs');const path=${JSON.stringify(state)};const s=JSON.parse(fs.readFileSync(path));const action=process.argv[2];if(action==='stop'){if(s.failStop)process.exit(1);s.active=false;}else if(action==='disable')s.enabled=false;else if(action==='show'){if(s.failShow)process.exit(1);const exists=fs.existsSync(${JSON.stringify(join(root, "etc/systemd/system/lightmoni-agent.service"))});process.stdout.write(process.argv.includes('--property=FragmentPath')?(exists?${JSON.stringify(join(root, "etc/systemd/system/lightmoni-agent.service"))}:""):process.argv.includes('--property=LoadState')?(exists?'loaded':'not-found'):(s.active?'active':'inactive'));process.stdout.write('\\n');}fs.writeFileSync(path,JSON.stringify(s));`, { mode: 0o755 });
  const rewrite = (script: string) => {
    return rewriteMaintenancePaths(script,root).replaceAll("/tmp/lightmoni-agent-bootstrap.XXXXXX", join(root, "tmp/lightmoni-agent-bootstrap.XXXXXX"));
  };
  const run = (command: string, input?: string) => spawnSync("sh", ["-c", rewrite(command)], { encoding: "utf8", input, env: { ...process.env, PATH: commandDir + ":" + process.env.PATH } });
  return { root, run, commandDir, state };
}
test("fixed Agent probe and uninstall preserve identity, configuration and accepted queue", t => {
  const f = fixture(t); const before = f.run(agentProbeCommand()); assert.equal(before.status, 0, before.stderr);
  assert.deepEqual(parseAgentProbe(before.stdout), { agent_id: "known-agent", installation: "present", service_running: true, operation_lock: false, lifecycle_locked: false, program_complete: true, unit_managed: true, data_retained: true });
  const removed = f.run(agentUninstallCommand("known-agent")); assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.stdout.includes("secret-not-for-output"), false);
  assert.deepEqual(parseAgentProbe(removed.stdout), { agent_id: "known-agent", installation: "absent", service_running: false, operation_lock: false, lifecycle_locked: false, program_complete: false, unit_managed: true, data_retained: true });
  assert.equal(readFileSync(join(f.root, "var/lib/lightmoni-agent/queue.sqlite"), "utf8"), "must survive");
  assert.equal(existsSync(join(f.root, "etc/lightmoni-agent/config.json")), true);
  assert.equal(existsSync(join(f.root, "usr/local/bin/lightmoni-agent")), false);
  assert.equal(existsSync(join(f.root, "run/lightmoni-agent-lifecycle.lock")), false);
  assert.notEqual(f.run(freshAgentGuard).status,0,"preserved identity/config still require explicit cleanup before fresh install");
});
test("stop failure and identity mismatch never remove Agent files", t => {
  const f = fixture(t, true); assert.notEqual(f.run(agentUninstallCommand("known-agent")).status, 0);
  assert.equal(existsSync(join(f.root, "usr/local/bin/lightmoni-agent")), true);
  assert.notEqual(f.run(agentUninstallCommand("other-agent")).status, 0);
  assert.equal(existsSync(join(f.root, "opt/lightmoni-agent")), true);
});
test("remote unfinished operation and malformed identity fail closed", t => {
  const f = fixture(t); mkdirSync(join(f.root, "var/lib/lightmoni-agent/operations"));
  writeFileSync(join(f.root, "var/lib/lightmoni-agent/operations/execution.lock"), "unknown");
  assert.equal(parseAgentProbe(f.run(agentProbeCommand()).stdout).operation_lock, true);
  assert.notEqual(f.run(agentUninstallCommand("known-agent")).status, 0);
  writeFileSync(join(f.root, "var/lib/lightmoni-agent/identity.json"), '{"agent_id":"bad\\nidentity"}');
  assert.notEqual(f.run(agentProbeCommand()).status, 0);
  assert.throws(() => parseAgentProbe("LMAGENT=1\nagent_id=secret\n"), /invalid_response/);
});
test("local task-run markers block probe approval and fixed uninstall without stopping the Agent", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "var/lib/lightmoni-agent/task-run-state.json"), '{"id":"running-script","lease_token":"fixture"}');
  const probed = f.run(agentProbeCommand()); assert.equal(probed.status, 0, probed.stderr);
  assert.equal(parseAgentProbe(probed.stdout).operation_lock, true);
  const removed = f.run(agentUninstallCommand("known-agent")); assert.notEqual(removed.status, 0);
  assert.equal(existsSync(join(f.root, "usr/local/bin/lightmoni-agent")), true);
  assert.equal(JSON.parse(readFileSync(f.state, "utf8")).active, true);
});
test("bootstrap uses protected curl config and stdin, and refuses existing install before download", t => {
  const f = fixture(t); const command = agentBootstrapCommand("https://monitor.example.com", "0.1.0");
  assert.equal(spawnSync("sh", ["-n"], { input: command, encoding: "utf8" }).status, 0);
  assert.ok(command.includes('Authorization: Bearer %s'));
  assert.ok(command.includes('--config "$tmp_dir/curl.conf"'));
  assert.ok(command.includes('--fresh')); assert.notEqual(f.run(command).status, 0);
});

test("systemd query failure cannot produce a successful absence receipt", t => {
  const f = fixture(t); const state = JSON.parse(readFileSync(f.state, "utf8")); state.failShow = true; writeFileSync(f.state, JSON.stringify(state));
  assert.notEqual(f.run(agentProbeCommand()).status, 0);
  assert.notEqual(f.run(agentUninstallCommand("known-agent")).status, 0);
  assert.equal(existsSync(join(f.root, "usr/local/bin/lightmoni-agent")), true);
});

test("bootstrap sends real Authorization from a 0600 file and feeds installer through stdin", t => {
  const f = fixture(t), expectedToken = "lm_enroll_fixture_only";
  for (const path of ["etc/lightmoni-agent/config.json", "var/lib/lightmoni-agent/identity.json", "opt/lightmoni-agent", "usr/local/bin/lightmoni-agent", "etc/systemd/system/lightmoni-agent.service"]) rmSync(join(f.root, path), { force: true, recursive: true });
  const marker = join(f.root, "bootstrap-ok"), installer = `#!/bin/sh\nIFS= read -r received\ntest "$received" = '${expectedToken}' || exit 1\ntest "$1" = --fresh || exit 1\nprintf success > '${marker}'\n`;
  writeFileSync(join(f.commandDir, "curl"), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2),config=args[args.indexOf('--config')+1];if(args.some(arg=>arg.includes(${JSON.stringify(expectedToken)})))process.exit(7);if((fs.statSync(config).mode&0o777)!==0o600)process.exit(8);if(fs.readFileSync(config,'utf8')!==${JSON.stringify('header = "Authorization: Bearer '+expectedToken+'"\n')})process.exit(9);fs.writeFileSync(args[args.indexOf('-o')+1],${JSON.stringify(installer)});`, { mode: 0o755 });
  const result = f.run(agentBootstrapCommand("https://monitor.example.com", "0.1.0"), expectedToken + "\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(marker, "utf8"), "success");
  assert.equal(result.stdout.includes(expectedToken), false); assert.equal(result.stderr.includes(expectedToken), false);
  assert.equal(existsSync(join(f.root, "tmp/lightmoni-agent-bootstrap.XXXXXX")), false);
});

test("offline uninstall is idempotent, retains data and never deletes on systemd failure", t => {
  const f = fixture(t);
  const script = readFileSync(new URL("../../deploy/agent/uninstall.sh", import.meta.url), "utf8");
  const failed = JSON.parse(readFileSync(f.state, "utf8")); failed.failShow = true; writeFileSync(f.state, JSON.stringify(failed));
  assert.notEqual(f.run(script).status, 0); assert.equal(existsSync(join(f.root, "usr/local/bin/lightmoni-agent")), true);
  failed.failShow = false; writeFileSync(f.state, JSON.stringify(failed));
  assert.equal(f.run(script).status, 0); assert.equal(f.run(script).status, 0);
  assert.equal(readFileSync(join(f.root, "var/lib/lightmoni-agent/queue.sqlite"), "utf8"), "must survive");
});

test("bounded recovery observation supports missing and damaged identities without disclosing contents",t=>{
 const f=fixture(t),path=join(f.root,"var/lib/lightmoni-agent/identity.json");
 for(const [content,state] of [[undefined,"missing"],["broken secret-not-for-output","invalid"],['{"agent_id":"known-agent","host_id":"host"}',"valid"]] as const){
  if(content===undefined)rmSync(path);else writeFileSync(path,content);
  const result=f.run(agentRemovalProbeCommand());assert.equal(result.status,0,result.stderr);
  const observed=parseAgentRemovalProbe(result.stdout);assert.equal(observed.identity_state,state);assert.equal(observed.agent_id,state==="valid"?"known-agent":"");assert.ok(!result.stdout.includes("secret-not-for-output"));
 }
 assert.throws(()=>parseAgentRemovalProbe("x".repeat(8193)),/invalid_response/);
});

test("approved recovery removal can purge damaged identity while preserving business data",t=>{
 const f=fixture(t),identity=join(f.root,"var/lib/lightmoni-agent/identity.json");writeFileSync(identity,"broken");
 const business=join(f.root,"business.db");writeFileSync(business,"business");
 const before=f.run(agentRemovalProbeCommand());assert.equal(before.status,0,before.stderr);const observed=parseAgentRemovalProbe(before.stdout);
 const result=f.run(agentRemovalCommand(observed,true));assert.equal(result.status,0,result.stderr);const after=parseAgentRemovalProbe(result.stdout);
 assert.equal(after.identity_state,"missing");assert.equal(after.installation,"absent");assert.equal(after.config_present,false);assert.equal(after.data_present,false);assert.equal(readFileSync(business,"utf8"),"business");
 assert.equal(f.run(freshAgentGuard).status,0,"approved purge makes the same fixed paths eligible for fresh installation");
});

test('fresh Agent purge preserves application data stored inside the Agent operations directory',t=>{
 const f=fixture(t),data=join(f.root,'var/lib/lightmoni-agent/operations/platform/workloads/old/data/0');mkdirSync(data,{recursive:true});writeFileSync(join(data,'database'),'persistent business data');
 const observed=parseAgentRemovalProbe(f.run(agentRemovalProbeCommand()).stdout);
 assert.equal(observed.business_data_retained,true);
 const result=f.run(agentRemovalCommand(observed,true));assert.equal(result.status,0,result.stderr);
 const after=parseAgentRemovalProbe(result.stdout);assert.equal(after.identity_state,'missing');assert.equal(after.agent_state_present,false);assert.equal(after.business_data_retained,true);
 assert.equal(readFileSync(join(data,'database'),'utf8'),'persistent business data');assert.equal(existsSync(join(f.root,'var/lib/lightmoni-agent/queue.sqlite')),false);
 assert.equal(f.run(freshAgentGuard).status,0);
});

test("approved current release changes are detected even when identity, launcher and unit are unchanged",t=>{
 const f=fixture(t),base=join(f.root,"opt/lightmoni-agent"),releases=join(base,"releases");mkdirSync(releases);
 for(const name of ["one","two"]){mkdirSync(join(releases,name));writeFileSync(join(releases,name,"release.json"),JSON.stringify({version:name}));}
 symlinkSync(join(releases,"one"),join(base,"current"));
 const before=f.run(agentRemovalProbeCommand());assert.equal(before.status,0,before.stderr);const observed=parseAgentRemovalProbe(before.stdout);assert.equal(observed.paths_safe,true);
 unlinkSync(join(base,"current"));symlinkSync(join(releases,"two"),join(base,"current"));
 const after=parseAgentRemovalProbe(f.run(agentRemovalProbeCommand()).stdout);assert.notEqual(after.program_sha256,observed.program_sha256);
 const result=f.run(agentRemovalCommand(observed));assert.notEqual(result.status,0);assert.equal(existsSync(join(f.root,"usr/local/bin/lightmoni-agent")),true);assert.equal(JSON.parse(readFileSync(f.state,"utf8")).active,true);
});

test("post-stop task markers and unsafe paths refuse deletion after a valid reviewed probe",t=>{
 for(const mode of ["marker","symlink"]){const f=fixture(t),before=parseAgentRemovalProbe(f.run(agentRemovalProbeCommand()).stdout);
  const systemctl=join(f.commandDir,"systemctl"),source=readFileSync(systemctl,"utf8");
  const mutate=mode==="marker"?`fs.writeFileSync(${JSON.stringify(join(f.root,"var/lib/lightmoni-agent/task-run-state.json"))},'broken marker');`:`fs.unlinkSync(${JSON.stringify(join(f.root,"usr/local/bin/lightmoni-agent"))});fs.symlinkSync(${JSON.stringify(join(f.root,"business"))},${JSON.stringify(join(f.root,"usr/local/bin/lightmoni-agent"))});`;
  writeFileSync(join(f.root,"business"),"must survive");writeFileSync(systemctl,source.replace("s.active=false;",`s.active=false;${mutate}`),{mode:0o755});
  const result=f.run(agentRemovalCommand(before,true));assert.notEqual(result.status,0,mode);assert.equal(existsSync(join(f.root,"opt/lightmoni-agent")),true);assert.equal(readFileSync(join(f.root,"business"),"utf8"),"must survive");assert.equal(existsSync(join(f.root,"etc/lightmoni-agent/config.json")),true);
 }
});
