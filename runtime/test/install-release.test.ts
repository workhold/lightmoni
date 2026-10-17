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
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const repo = resolve(import.meta.dirname, "../.."),
  artifact = "lightmoni-agent_0.1.0_linux_amd64.tar.gz";
/** Execute the real shell installer with every writable absolute destination
 * rewritten into one temporary root. Root/Linux/systemd/install/checksum/mv are
 * command shims; the fixture does not claim Linux Node/systemd execution. */
function fixture(
  t: any,
  options: {
    old?: "node" | "go" | "none";
    active?: boolean;
    failRestart?: boolean;
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
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "identity.json"),
    '{"agent_id":"synthetic-agent","host_id":"synthetic-host"}\n',
  );
  writeFileSync(
    join(data, "queue.sqlite"),
    Buffer.from("unchanged synthetic spool\0\xff", "latin1"),
  );
  writeFileSync(join(data, "remote-config.json"), '{"revision":"old-tasks"}');
  const old = options.old ?? "node",
    oldConfig = {
      endpoint: "http://old.example",
      key: "test-old-key",
      data_dir: data,
      group_id: "old",
    };
  if (old !== "none") {
    mkdirSync(dirname(config), { recursive: true });
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
    `const fs=require('fs'),file=process.env.TEST_SYSTEM_STATE,s=JSON.parse(fs.readFileSync(file)),args=process.argv.slice(2),op=args[0];s.calls.push(args.join(' '));let status=0;if(op==='is-active')status=s.active?0:3;else if(op==='is-enabled')status=s.enabled?0:1;else if(op==='enable')s.enabled=true;else if(op==='disable')s.enabled=false;else if(op==='stop')s.active=false;else if(op==='restart'){s.restarts++;if(process.env.TEST_FAIL_RESTART==='yes'&&s.restarts===1){s.active=false;status=1;}else s.active=true;}fs.writeFileSync(file,JSON.stringify(s));process.exit(status);`,
  );
  mkdirSync(join(packageDir, "lightmoni-agent-runtime"), { recursive: true });
  writeFileSync(
    join(packageDir, "lightmoni-agent-runtime/node"),
    "#!/bin/sh\necho v24.15.0\n",
    { mode: 0o755 },
  );
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
    before,
    run,
    state,
    unchangedData,
    restored,
  };
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
  f.unchangedData();
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
