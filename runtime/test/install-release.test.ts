import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  existsSync,
  statSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const repo = resolve(import.meta.dirname, "../.."),
  artifact = "lightmoni-agent_0.1.0_linux_amd64.tar.gz";
/** Execute the real shell installer with every writable absolute destination
 * rewritten into one temporary root. Root/Linux/systemd/install/checksum/mv are
 * command shims. The service-user check examines POSIX mode bits rather than
 * changing UID, and does not claim Linux Node/systemd or ownership validation. */
function fixture(
  t: any,
  options: {
    old?: "node" | "go" | "none";
    active?: boolean;
    failRestart?: boolean;
    failRestartStatus?: number;
    startupStates?: boolean[];
    failShow?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lightmoni-install-")),
    bin = join(root, "commands"),
    release = join(root, "release"),
    packageDir = join(root, "package"),
    system = join(root, "system.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    bin,
    release,
    packageDir,
    join(root, "opt"),
    join(root, "etc/systemd/system"),
    join(root, "usr/local/bin"),
  ])
    mkdirSync(path, { recursive: true });
  const locations = [
    "/etc/lightmoni-agent",
    "/var/lib/lightmoni-agent",
    "/opt/lightmoni-agent",
    "/usr/local/bin",
    "/etc/systemd/system",
  ];
  let installer = readFileSync(join(repo, "deploy/agent/install.sh"), "utf8");
  for (const path of locations)
    installer = installer.replaceAll(path, join(root, path.slice(1)));
  const script = join(root, "install.sh");
  writeFileSync(script, installer);
  const js = (path: string, source: string) =>
    writeFileSync(path, "#!" + process.execPath + "\n" + source, {
      mode: 0o755,
    });
  const config = join(root, "etc/lightmoni-agent/config.json"),
    data = join(root, "var/lib/lightmoni-agent"),
    current = join(root, "opt/lightmoni-agent/current"),
    launcher = join(root, "usr/local/bin/lightmoni-agent"),
    service = join(root, "etc/systemd/system/lightmoni-agent.service");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  chmodSync(data, 0o700);
  writeFileSync(
    join(data, "identity.json"),
    '{"agent_id":"synthetic-agent","host_id":"synthetic-host"}\n',
    { mode: 0o600 },
  );
  writeFileSync(
    join(data, "queue.sqlite"),
    Buffer.from("unchanged synthetic spool\0\xff", "latin1"),
    { mode: 0o600 },
  );
  writeFileSync(join(data, "remote-config.json"), '{"revision":"old-tasks"}', {
    mode: 0o600,
  });
  const old = options.old ?? "node",
    oldConfig = {
      endpoint: "http://old.example",
      key: "test-old-key",
      data_dir: data,
      group_id: "old",
    };
  if (old !== "none") {
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    writeFileSync(config, JSON.stringify(oldConfig), { mode: 0o600 });
    writeFileSync(
      launcher,
      "#!/bin/sh\necho synthetic old " + old + " agent\n",
      { mode: 0o750 },
    );
    writeFileSync(service, "synthetic previous service\n", { mode: 0o640 });
    if (old === "node") {
      const oldRuntime = join(root, "opt/lightmoni-agent/releases/old");
      mkdirSync(oldRuntime, { recursive: true });
      writeFileSync(join(oldRuntime, "node"), "synthetic old node");
      symlinkSync(oldRuntime, current);
    }
  }
  // An earlier attempt under umask 077 can leave this existing ancestor root-only.
  const runtimeParent = join(root, "opt/lightmoni-agent");
  mkdirSync(runtimeParent, { recursive: true });
  chmodSync(runtimeParent, 0o700);
  const before = {
    launcher: old === "none" ? undefined : readFileSync(launcher),
    service: old === "none" ? undefined : readFileSync(service),
    config: old === "none" ? undefined : readFileSync(config),
    current: old === "node" ? readlinkSync(current) : undefined,
    identity: readFileSync(join(data, "identity.json")),
    queue: readFileSync(join(data, "queue.sqlite")),
    remote: readFileSync(join(data, "remote-config.json")),
  };
  writeFileSync(
    system,
    JSON.stringify({
      active: options.active ?? old !== "none",
      enabled: old !== "none",
      calls: [],
      restarts: 0,
      startupChecks: 0,
      startupStates: options.startupStates,
      runtimeAccessible: false,
      sleeps: [],
    }),
  );
  writeFileSync(
    join(bin, "id"),
    '#!/bin/sh\nif [ "$1" = "-u" ]; then echo 0; fi\nexit 0\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "uname"),
    '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n',
    { mode: 0o755 },
  );
  js(
    join(bin, "sha256sum"),
    `const fs=require('fs'),crypto=require('crypto');const p=process.argv[2];console.log(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')+'  '+p);`,
  );
  js(
    join(bin, "mv"),
    `const fs=require('fs');const args=process.argv.slice(2).filter(v=>!v.startsWith('-'));fs.renameSync(args[0],args[1]);`,
  );
  js(
    join(bin, "install"),
    `const fs=require('fs'),path=require('path');let args=process.argv.slice(2),mode=0o755,directory=false,files=[];for(let i=0;i<args.length;i++){if(args[i]==='-d')directory=true;else if(args[i]==='-m')mode=parseInt(args[++i],8);else if(['-o','-g'].includes(args[i]))i++;else files.push(args[i]);}if(directory){for(const p of files){fs.mkdirSync(p,{recursive:true});fs.chmodSync(p,mode);}}else{fs.copyFileSync(files[0],files[1]);fs.chmodSync(files[1],mode);}`,
  );
  js(
    join(bin, "systemctl"),
    `const fs=require('fs'),path=require('path'),file=process.env.TEST_SYSTEM_STATE,s=JSON.parse(fs.readFileSync(file)),args=process.argv.slice(2),op=args[0];
s.calls.push(args.join(' '));let status=0;
function accessibleRuntime(){
  const parent=process.env.TEST_RUNTIME_PARENT,current=path.join(parent,'current');
  try{
    const release=fs.realpathSync(current);
    const directories=[parent,path.join(parent,'releases'),release,path.join(release,'app'),path.join(release,'app/agent'),path.join(release,'node_modules'),path.join(release,'node_modules/synthetic'),path.join(release,'bin')];
    const files=['app/agent/main.js','node_modules/synthetic/index.js','package.json'];
    const executables=['node','bin/helper'];
    return directories.every(p=>(fs.statSync(p).mode&0o005)===0o005)&&files.every(p=>(fs.statSync(path.join(release,p)).mode&0o004)!==0)&&executables.every(p=>(fs.statSync(path.join(release,p)).mode&0o005)===0o005);
  }catch{return false;}
}
if(op==='is-active'){
  if(s.restarts===1){
    const index=s.startupChecks++;
    if(s.startupStates)s.active=s.runtimeAccessible&&(s.startupStates[index]??false);
  }
  status=s.active?0:3;
}else if(op==='is-enabled')status=s.enabled?0:1;
else if(op==='enable')s.enabled=true;
else if(op==='disable')s.enabled=false;
else if(op==='stop')s.active=false;
else if(op==='restart'){
  s.restarts++;
  if(process.env.TEST_FAIL_RESTART==='yes'&&s.restarts===1){s.active=false;status=Number(process.env.TEST_FAIL_RESTART_STATUS);}
  else if(s.restarts===1){s.runtimeAccessible=accessibleRuntime();s.active=s.runtimeAccessible;}
  else s.active=true;
}else if(op==='show'){
  if(process.env.TEST_FAIL_SHOW==='yes')status=1;
  else console.log('LoadState=loaded\\nActiveState='+ (s.active?'active':'failed')+'\\nSubState='+ (s.active?'running':'failed')+'\\nResult=exit-code\\nExecMainCode=exited\\nExecMainStatus=1');
}
fs.writeFileSync(file,JSON.stringify(s));process.exit(status);`,
  );
  js(
    join(bin, "sleep"),
    `const fs=require('fs'),file=process.env.TEST_SYSTEM_STATE,s=JSON.parse(fs.readFileSync(file));s.sleeps.push(process.argv.slice(2));fs.writeFileSync(file,JSON.stringify(s));`,
  );
  const packagedRuntime = join(packageDir, "lightmoni-agent-runtime");
  for (const path of ["app/agent", "node_modules/synthetic", "bin"])
    mkdirSync(join(packagedRuntime, path), { recursive: true, mode: 0o755 });
  writeFileSync(
    join(packagedRuntime, "node"),
    "#!/bin/sh\necho v24.15.0\n",
    { mode: 0o755 },
  );
  writeFileSync(join(packagedRuntime, "app/agent/main.js"), "// agent entry\n", {
    mode: 0o644,
  });
  writeFileSync(join(packagedRuntime, "node_modules/synthetic/index.js"), "export {};\n", {
    mode: 0o644,
  });
  writeFileSync(join(packagedRuntime, "package.json"), '{"type":"module"}\n', {
    mode: 0o644,
  });
  writeFileSync(join(packagedRuntime, "bin/helper"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  js(
    join(packageDir, "lightmoni-agent"),
    `const fs=require('fs'),args=process.argv.slice(2),command=args.shift(),get=key=>args[args.indexOf(key)+1],path=get('--config'),dir=get('--require-data-dir');if(command==='configure'){let c=fs.existsSync(path)?JSON.parse(fs.readFileSync(path)):{};c.endpoint=get('--endpoint');c.group_id=get('--group-id');c.data_dir=dir;c.key=fs.readFileSync(0,'utf8').trim();fs.writeFileSync(path,JSON.stringify(c));}else if(command==='check'){const c=JSON.parse(fs.readFileSync(path));if(c.data_dir!==dir)process.exit(1);}else process.exit(1);`,
  );
  writeFileSync(
    join(packageDir, "lightmoni-agent.service"),
    "synthetic new service\n",
  );
  execFileSync("tar", [
    "-czf",
    join(release, artifact),
    "-C",
    packageDir,
    "lightmoni-agent",
    "lightmoni-agent.service",
    "lightmoni-agent-runtime",
  ]);
  const checksum = createHash("sha256")
    .update(readFileSync(join(release, artifact)))
    .digest("hex");
  writeFileSync(join(release, "SHA256SUMS"), checksum + "  " + artifact + "\n");
  const run = () =>
    spawnSync(
      "/bin/sh",
      [
        script,
        "--release-dir",
        release,
        "--endpoint",
        "http://new.example",
        "--group-id",
        "new",
        "--key-stdin",
      ],
      {
        input: "test-new-key\n",
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin + ":" + process.env.PATH,
          TEST_SYSTEM_STATE: system,
          TEST_FAIL_RESTART: options.failRestart ? "yes" : "no",
          TEST_FAIL_RESTART_STATUS: String(options.failRestartStatus ?? 1),
          TEST_FAIL_SHOW: options.failShow ? "yes" : "no",
          TEST_RUNTIME_PARENT: runtimeParent,
        },
        timeout: 20000,
      },
    );
  const state = () => JSON.parse(readFileSync(system, "utf8"));
  const unchangedData = () => {
    assert.deepEqual(
      readFileSync(join(data, "identity.json")),
      before.identity,
    );
    assert.deepEqual(readFileSync(join(data, "queue.sqlite")), before.queue);
    assert.deepEqual(
      readFileSync(join(data, "remote-config.json")),
      before.remote,
    );
    assert.equal(statSync(data).mode & 0o777, 0o700);
    for (const name of ["identity.json", "queue.sqlite", "remote-config.json"])
      assert.equal(statSync(join(data, name)).mode & 0o777, 0o600);
  };
  const restored = () => {
    unchangedData();
    for (const [path, saved] of [
      [config, before.config],
      [launcher, before.launcher],
      [service, before.service],
    ] as const) {
      if (saved) assert.deepEqual(readFileSync(path), saved);
      else assert(!existsSync(path));
    }
    if (before.current) assert.equal(readlinkSync(current), before.current);
    else assert(!existsSync(current));
    if (old !== "none") {
      assert.equal(statSync(launcher).mode & 0o777, 0o750);
      assert.equal(statSync(service).mode & 0o777, 0o640);
    }
  };
  return {
    root,
    release,
    config,
    current,
    launcher,
    service,
    data,
    runtimeParent,
    before,
    run,
    state,
    unchangedData,
    restored,
  };
}
function assertRuntimePermissions(f: ReturnType<typeof fixture>) {
  const runtime = readlinkSync(f.current);
  for (const path of [
    f.runtimeParent,
    join(f.runtimeParent, "releases"),
    runtime,
    join(runtime, "app"),
    join(runtime, "app/agent"),
    join(runtime, "node_modules"),
    join(runtime, "node_modules/synthetic"),
    join(runtime, "bin"),
  ])
    assert.equal(statSync(path).mode & 0o777, 0o755, path);
  for (const path of ["app/agent/main.js", "node_modules/synthetic/index.js", "package.json"])
    assert.equal(statSync(join(runtime, path)).mode & 0o777, 0o644, path);
  for (const path of ["node", "bin/helper"])
    assert.equal(statSync(join(runtime, path)).mode & 0o777, 0o755, path);
  assert.equal(statSync(dirname(f.config)).mode & 0o777, 0o700);
  assert.equal(statSync(f.config).mode & 0o777, 0o600);
  assert.equal(f.state().runtimeAccessible, true);
}
function assertSafeStartupDiagnostics(
  f: ReturnType<typeof fixture>,
  result: ReturnType<ReturnType<typeof fixture>["run"]>,
  phase: "restart" | "startup-check",
) {
  assert.match(result.stderr, new RegExp(phase));
  assert.match(result.stderr, /journalctl\s+-u\s+lightmoni-agent\.service/);
  const calls: string[] = f.state().calls,
    showIndex = calls.findIndex((call) => call.startsWith("show ")),
    stopIndex = calls.findIndex((call) => call.startsWith("stop "));
  assert(showIndex >= 0, "systemd state is inspected before rollback");
  assert(stopIndex > showIndex, "diagnostics precede stopping the failed service");
  const query = calls[showIndex];
  for (const property of ["LoadState", "ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus"])
    assert(query.includes(property), "missing safe property " + property);
  assert(!/ExecStart|Environment|status /.test(query));
  assert(!calls.some((call) => call.startsWith("status ")));
  assert(!result.stdout.includes("test-new-key"));
  assert(!result.stderr.includes("test-new-key"));
  assert(!result.stdout.includes("test-old-key"));
  assert(!result.stderr.includes("test-old-key"));
}
test("checksum rejection leaves the installed release, service, config, queue and identity unchanged", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.release, artifact), "tampered release");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum verification failed/);
  f.restored();
  assert.deepEqual(f.state().calls, []);
});
test("verified release switches atomically, configures and restarts while preserving old runtime and spool", (t) => {
  const f = fixture(t),
    result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent installed/);
  assert.notEqual(readlinkSync(f.current), f.before.current);
  assert(existsSync(f.before.current!));
  assert.match(readFileSync(f.service, "utf8"), /new service/);
  assert.equal(
    JSON.parse(readFileSync(f.config, "utf8")).endpoint,
    "http://new.example",
  );
  assert.equal(statSync(f.config).mode & 0o777, 0o600);
  assert.equal(f.state().restarts, 1);
  assert(f.state().active);
  assert.equal(f.state().startupChecks, 2);
  assertRuntimePermissions(f);
  f.unchangedData();
});
test("first installation publishes readable runtime and executable helpers without exposing config or persisted state", (t) => {
  const f = fixture(t, { old: "none", active: false }),
    result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assertRuntimePermissions(f);
  f.unchangedData();
});
test("startup observation tolerates delayed activation and requires two consecutive active checks", (t) => {
  const f = fixture(t, { startupStates: [false, false, true, true] }),
    result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.state().startupChecks, 4);
  assert.equal(f.state().sleeps.length, 3);
  assert(f.state().sleeps.every((args: string[]) => args.length === 1 && args[0] === "1"));
  assert(!f.state().calls.some((call: string) => call.startsWith("show ")));
  assertRuntimePermissions(f);
  f.unchangedData();
});
test("isolated active observations do not count as successful startup and rollback remains intact", (t) => {
  const f = fixture(t, { startupStates: [true, false, true, false, true, false, true, false, true, false] }),
    result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(f.state().startupChecks, 10);
  assert.equal(f.state().sleeps.length, 9);
  assertSafeStartupDiagnostics(f, result, "startup-check");
  assert.match(result.stderr, /LoadState=loaded/);
  assert.match(result.stderr, /ExecMainStatus=1/);
  assert(!result.stdout.includes("Agent installed"));
  f.restored();
  assert.equal(f.state().restarts, 2);
  assert(f.state().active);
  assert(f.state().enabled);
});
test("persistently inactive first installation stops after ten checks and removes new live files", (t) => {
  const f = fixture(t, { old: "none", active: false, startupStates: [] }),
    result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(f.state().startupChecks, 10);
  assert.equal(f.state().sleeps.length, 9);
  assertSafeStartupDiagnostics(f, result, "startup-check");
  assert(!result.stdout.includes("Agent installed"));
  f.restored();
  assert.equal(f.state().restarts, 1);
  assert.equal(f.state().active, false);
  assert.equal(f.state().enabled, false);
});
test("failed diagnostic collection cannot prevent restoring the previous installation", (t) => {
  const f = fixture(t, { startupStates: [], failShow: true }),
    result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(f.state().startupChecks, 10);
  assertSafeStartupDiagnostics(f, result, "startup-check");
  f.restored();
  assert.equal(f.state().restarts, 2);
  assert(f.state().active);
  assert(f.state().enabled);
  assert(!result.stderr.includes("Automatic restoration needs attention"));
});
test("restart exit status survives diagnostic failure and successful restoration", (t) => {
  const f = fixture(t, { failRestart: true, failRestartStatus: 7, failShow: true }),
    result = f.run();
  assert.equal(result.status, 7);
  assertSafeStartupDiagnostics(f, result, "restart");
  f.restored();
  assert.equal(f.state().restarts, 2);
  assert(f.state().active);
  assert(f.state().enabled);
});
for (const old of ["node", "go"] as const)
  test(
    "restart failure restores the old " +
      old +
      " install, permissions, config and previously active service",
    (t) => {
      const f = fixture(t, { old, active: true, failRestart: true }),
        result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /restoring the previous/);
      assertSafeStartupDiagnostics(f, result, "restart");
      assert(!result.stdout.includes("Agent installed"));
      f.restored();
      assert.equal(f.state().restarts, 2);
      assert(f.state().active);
      assert(f.state().enabled);
      assert.deepEqual(
        readdirSync(join(f.root, "opt/lightmoni-agent/releases")),
        old === "node" ? ["old"] : [],
      );
    },
  );
test("restart rollback keeps a previously inactive service stopped", (t) => {
  const f = fixture(t, { active: false, failRestart: true }),
    result = f.run();
  assert.notEqual(result.status, 0);
  f.restored();
  assert.equal(f.state().restarts, 1);
  assert.equal(f.state().active, false);
});
test("first-install restart failure removes new live files and does not claim installation succeeded", (t) => {
  const f = fixture(t, { old: "none", active: false, failRestart: true }),
    result = f.run();
  assert.notEqual(result.status, 0);
  assert(!result.stdout.includes("Agent installed"));
  f.restored();
  assert.equal(f.state().active, false);
  assert.equal(f.state().enabled, false);
  assert.equal(f.state().restarts, 1);
});
