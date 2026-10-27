#!/usr/bin/env python3
"""Isolated native Linux release-image HTTP smoke; never builds or pushes.

Usage: python3 /tmp/lightmoni-ops-image-smoke.py IMAGE SOURCE_REVISION WORK_DIR

Requires Python 3 and Docker on a Linux amd64 or arm64 Docker host. The tested LightMoni
image must already exist locally. ClickHouse 26.8 is explicitly pulled with a
900-second timeout before startup. Center/ClickHouse memory is capped at
512/768 MiB with no additional swap. Only dedicated, labelled resources are removed.
Passwords/tokens/cookies remain in memory or temporary 0600 environment files;
neither raw HTTP errors, Docker output nor container logs are printed.

This checks the real center HTTP boundary and native-platform Agent entry point;
it does not launch an Agent, approve a job, operate a host, issue ACME, or test
real S3. The other architecture receives SHA/ELF/module inspection only; no QEMU is used.
"""
import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import secrets
import signal
import socket
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:26.8"
CAPABILITIES = ["operations.website", "operations.certificate", "operations.compose", "operations.backup"]
DOMAINS = ["websites", "certificates", "containers", "backups"]
LABEL_KEY = "io.lightmoni.qa.run"
CLICKHOUSE_SERVER_XML = """<clickhouse>
  <logger><level>warning</level></logger>
  <max_server_memory_usage>536870912</max_server_memory_usage>
  <max_connections>32</max_connections>
  <max_concurrent_queries>4</max_concurrent_queries>
  <max_thread_pool_size>128</max_thread_pool_size>
  <max_thread_pool_free_size>8</max_thread_pool_free_size>
  <thread_pool_queue_size>256</thread_pool_queue_size>
  <background_pool_size>4</background_pool_size>
  <background_schedule_pool_size>4</background_schedule_pool_size>
  <background_buffer_flush_schedule_pool_size>1</background_buffer_flush_schedule_pool_size>
  <background_message_broker_schedule_pool_size>1</background_message_broker_schedule_pool_size>
  <background_distributed_schedule_pool_size>1</background_distributed_schedule_pool_size>
  <background_fetches_pool_size>2</background_fetches_pool_size>
  <background_move_pool_size>2</background_move_pool_size>
  <background_common_pool_size>2</background_common_pool_size>
  <mark_cache_size>16777216</mark_cache_size>
  <uncompressed_cache_size>8388608</uncompressed_cache_size>
  <merge_tree>
    <number_of_free_entries_in_pool_to_execute_mutation>2</number_of_free_entries_in_pool_to_execute_mutation>
    <number_of_free_entries_in_pool_to_lower_max_size_of_merge>2</number_of_free_entries_in_pool_to_lower_max_size_of_merge>
    <number_of_free_entries_in_pool_to_execute_optimize_entire_partition>2</number_of_free_entries_in_pool_to_execute_optimize_entire_partition>
  </merge_tree>
  <query_log remove="1"/><query_thread_log remove="1"/><part_log remove="1"/>
  <trace_log remove="1"/><text_log remove="1"/><metric_log remove="1"/>
  <asynchronous_metric_log remove="1"/><processors_profile_log remove="1"/>
</clickhouse>
"""
CLICKHOUSE_USERS_XML = """<clickhouse><profiles><default>
  <max_threads>2</max_threads>
  <max_insert_threads>1</max_insert_threads>
  <max_memory_usage>134217728</max_memory_usage>
  <max_memory_usage_for_user>268435456</max_memory_usage_for_user>
  <max_bytes_before_external_group_by>67108864</max_bytes_before_external_group_by>
  <max_bytes_before_external_sort>67108864</max_bytes_before_external_sort>
</default></profiles></clickhouse>
"""


class SmokeError(Exception):
    """Only fixed, credential-free summaries may be placed in this exception."""


def require(condition, summary):
    if not condition:
        raise SmokeError(summary)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect(),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, method="GET", body=None, bearer=None, limit=8 << 20):
        headers = {"Accept": "application/json"}
        if body is not None:
            headers.update({"Content-Type": "application/json", "Origin": self.base})
        if bearer:
            headers["Authorization"] = "Bearer " + bearer
        req = urllib.request.Request(self.base + path,
            data=None if body is None else json.dumps(body).encode(), method=method, headers=headers)
        try:
            response = self.opener.open(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(limit + 1)
            require(len(data) <= limit, "HTTP response exceeded smoke limit")
            return response.code, response.headers, data

    def json(self, path, method="GET", body=None, expect=200, bearer=None):
        status, _, data = self.request(path, method, body, bearer)
        require(status == expect, "Unexpected HTTP status for " + path.split("?")[0] + ": " + str(status))
        try:
            return json.loads(data)
        except (ValueError, UnicodeError):
            raise SmokeError("Expected JSON response") from None

    def download(self, path, destination, bearer):
        req = urllib.request.Request(self.base + path, headers={"Authorization": "Bearer " + bearer})
        try:
            response = self.opener.open(req, timeout=90)
        except urllib.error.HTTPError:
            raise SmokeError("Authenticated Agent download failed") from None
        digest, total = hashlib.sha256(), 0
        with response, open(destination, "xb") as target:
            os.chmod(destination, 0o600)
            require(response.code == 200, "Agent download did not return 200")
            require("no-store" in response.headers.get("Cache-Control", ""), "Agent download lacks no-store")
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                require(total <= 256 << 20, "Agent archive exceeds smoke download limit")
                digest.update(chunk)
                target.write(chunk)
        return total, digest.hexdigest()


class Smoke:
    def __init__(self, args):
        self.args = args
        self.run_id = "ops-image-" + secrets.token_hex(6)
        self.work = Path(tempfile.mkdtemp(prefix=self.run_id + "-", dir=args.work_dir))
        self.work.chmod(0o700)
        self.owned = {"container": [], "network": [], "volume": []}
        self.temp_files = []
        self.stage = "preflight"
        self.report = {"passed": False, "image": args.image, "expected_source_revision": args.source_revision,
            "docker_platform": None, "checks": [], "downloads": [],
            "resource_limits": {"center_memory_bytes": 512 << 20, "clickhouse_memory_bytes": 768 << 20,
                "additional_swap_bytes": 0, "clickhouse_server_memory_bytes": 512 << 20,
                "clickhouse_query_memory_bytes": 128 << 20, "clickhouse_query_threads": 2},
            "limitations": ["Agent execution is limited to the detected native architecture; the other package is inspected statically",
                "No Agent daemon or approved job was run", "No live Nginx/Docker/ACME/S3 operation executed",
                "HTTP assets are checked; this is not interactive browser acceptance"]}

    def command(self, argv, stdin=None, timeout=180, checked=True):
        try:
            result = subprocess.run(argv, input=stdin, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise SmokeError("External command unavailable or timed out during " + self.stage) from None
        if checked and result.returncode:
            raise SmokeError("External command failed during " + self.stage)
        return result

    def docker(self, *argv, stdin=None, timeout=180, checked=True):
        return self.command(["docker", *argv], stdin, timeout, checked)

    def labels(self):
        return ["--label", LABEL_KEY + "=" + self.run_id, "--label", "io.lightmoni.qa=ops-image-smoke"]

    def private_file(self, name, content):
        path = self.work / name
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(content)
        self.temp_files.append(path)
        return str(path)

    def env_file(self, name, values):
        for value in values.values():
            require("\n" not in str(value), "Invalid generated environment value")
        return self.private_file(name, "".join(key + "=" + str(value) + "\n" for key, value in values.items()))

    def create(self, kind, name, *argv):
        self.owned[kind].append(name)
        # network/volume create take the name positionally; unlike run they do
        # not have a common --name option.
        return self.docker(kind, "create", *self.labels(), *argv, name)

    def check(self, name, **details):
        self.report["checks"].append({"check": name, "passed": True, **details})

    def cleanup(self):
        results = {"removed": {}, "errors": []}
        for kind in ["container", "volume", "network"]:
            removed = 0
            for name in reversed(self.owned[kind]):
                inspected = self.docker(kind, "inspect", name, checked=False, timeout=30)
                if inspected.returncode:
                    continue
                try:
                    item = json.loads(inspected.stdout)[0]
                    labels = item.get("Config", {}).get("Labels", {}) if kind == "container" else item.get("Labels", {})
                    if not labels or labels.get(LABEL_KEY) != self.run_id:
                        results["errors"].append(kind + ": ownership label mismatch")
                        continue
                    flags = ["-f", "-v"] if kind == "container" else []
                    deleted = self.docker(kind, "rm", *flags, name, checked=False, timeout=60)
                    if deleted.returncode:
                        results["errors"].append(kind + ": removal failed")
                    else:
                        removed += 1
                except (ValueError, KeyError, IndexError):
                    results["errors"].append(kind + ": inspect shape invalid")
            results["removed"][kind] = removed
        for path in self.temp_files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                results["errors"].append("temporary configuration file removal failed")
        self.report["cleanup"] = results
        if results["errors"]:
            self.report["passed"] = False

    def execute(self):
        docker_info = self.docker("info", "--format", "{{json .}}").stdout
        info = json.loads(docker_info)
        self.native_arch = {"amd64": "amd64", "x86_64": "amd64", "arm64": "arm64", "aarch64": "arm64"}.get(info.get("Architecture"))
        require(info.get("OSType") == "linux" and self.native_arch is not None,
            "A native Linux amd64 or arm64 Docker daemon is required; no QEMU execution is assumed")
        self.native_platform = "linux/" + self.native_arch
        other_arch = "arm64" if self.native_arch == "amd64" else "amd64"
        self.report.update({"docker_platform": self.native_platform, "native_agent_platform": self.native_platform,
            "static_agent_platform": "linux/" + other_arch})
        self.report["limitations"][0] = "linux/" + other_arch + " Agent package statically verified only; no emulated execution"
        image = json.loads(self.docker("image", "inspect", self.args.image).stdout)[0]
        require(image.get("Os") == "linux" and image.get("Architecture") == self.native_arch, "Selected image does not match the native Linux Docker architecture")
        revision = image.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.revision", "")
        require(re.fullmatch(r"[0-9a-f]{40}", revision) and revision.startswith(self.args.source_revision), "OCI source revision mismatch")
        self.image_id = image["Id"]
        self.report.update({"image_id": self.image_id, "source_revision": revision})
        self.check("OCI revision and native image", platform=self.native_platform)
        self.stage = "ClickHouse image pull"
        self.docker("pull", "--platform", self.native_platform, CLICKHOUSE_IMAGE, timeout=900)
        self.check("ClickHouse 26.8 image explicitly pulled")
        network, telemetry, state = (self.run_id + "-" + suffix for suffix in ["network", "telemetry", "state"])
        self.create("network", network, "--internal")
        self.create("volume", telemetry)
        self.create("volume", state)
        ch_name, center = self.run_id + "-ch", self.run_id + "-center"
        ch_user, ch_password = "smoke_" + secrets.token_hex(4), secrets.token_urlsafe(30)
        ch_env = self.env_file("clickhouse.env", {"CLICKHOUSE_USER": ch_user,
            "CLICKHOUSE_PASSWORD": ch_password, "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT": "1"})
        ch_server_xml = self.private_file("clickhouse-server.xml", CLICKHOUSE_SERVER_XML)
        ch_users_xml = self.private_file("clickhouse-users.xml", CLICKHOUSE_USERS_XML)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        base = "http://127.0.0.1:" + str(port)
        center_env = self.env_file("center.env", {"LIGHTMONI_ADDR": ":8080", "LIGHTMONI_DATA": "/data/state",
            "LIGHTMONI_EXTERNAL_URL": base, "LIGHTMONI_CH_URL": "http://" + ch_name + ":8123",
            "LIGHTMONI_CH_USER": ch_user, "LIGHTMONI_CH_PASSWORD": ch_password})
        self.stage = "isolated ClickHouse startup"
        self.owned["container"].append(ch_name)
        # Host XML files remain 0600. The root wrapper copies them into this
        # disposable container as clickhouse-owned 0600 files before the official
        # entrypoint drops privileges. No host configuration is modified.
        ch_entrypoint = """cp /run/lightmoni-smoke-server.xml /etc/clickhouse-server/config.d/qa-lightmoni-limits.xml
cp /run/lightmoni-smoke-users.xml /etc/clickhouse-server/users.d/qa-lightmoni-limits.xml
chown clickhouse:clickhouse /etc/clickhouse-server/config.d/qa-lightmoni-limits.xml /etc/clickhouse-server/users.d/qa-lightmoni-limits.xml
chmod 600 /etc/clickhouse-server/config.d/qa-lightmoni-limits.xml /etc/clickhouse-server/users.d/qa-lightmoni-limits.xml
exec /entrypoint.sh
"""
        self.docker("run", "-d", "--pull", "never", "--name", ch_name, *self.labels(), "--platform", self.native_platform,
            "--network", network, "--env-file", ch_env, "--ulimit", "nofile=262144:262144",
            "--memory", "768m", "--memory-swap", "768m", "--entrypoint", "/bin/sh",
            "--mount", "type=bind,source=" + ch_server_xml + ",target=/run/lightmoni-smoke-server.xml,readonly",
            "--mount", "type=bind,source=" + ch_users_xml + ",target=/run/lightmoni-smoke-users.xml,readonly",
            "--mount", "type=volume,source=" + telemetry + ",target=/var/lib/clickhouse",
            CLICKHOUSE_IMAGE, "-ec", ch_entrypoint)
        # Probe authenticated ClickHouse HTTP using the same immutable center image.
        # No password is placed in argv, a URL, a query string or emitted output.
        probe = self.run_id + "-ch-probe"
        self.owned["container"].append(probe)
        probe_js = b'''const end=Date.now()+150000;let ok=false;while(Date.now()<end){try{const r=await fetch(process.env.LIGHTMONI_CH_URL,{method:'POST',headers:{authorization:'Basic '+Buffer.from(process.env.LIGHTMONI_CH_USER+':'+process.env.LIGHTMONI_CH_PASSWORD).toString('base64')},body:'SELECT version()',signal:AbortSignal.timeout(3000)});const t=await r.text();if(r.ok&&/^26[.]8[.]/.test(t.trim())){ok=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}if(!ok)process.exit(1);console.log(JSON.stringify({clickhouse_http:true}));'''
        self.docker("run", "--rm", "-i", "--name", probe, *self.labels(), "--platform", self.native_platform, "--network", network,
            "--memory", "128m", "--memory-swap", "128m", "--env-file", center_env,
            "--entrypoint", "node", self.image_id, "--input-type=module", "-", stdin=probe_js, timeout=165)
        self.check("ClickHouse 26.8 authenticated real HTTP")
        self.stage = "center startup and health"
        self.owned["container"].append(center)
        self.docker("run", "-d", "--pull", "never", "--name", center, *self.labels(), "--platform", self.native_platform,
            "--network", network, "--env-file", center_env, "--publish", "127.0.0.1:" + str(port) + ":8080",
            "--memory", "512m", "--memory-swap", "512m",
            "--mount", "type=volume,source=" + state + ",target=/data", self.image_id)
        anonymous = Client(base)
        deadline, healthy = time.monotonic() + 150, False
        while time.monotonic() < deadline:
            try:
                healthy = anonymous.json("/healthz").get("status") == "ok"
                if healthy:
                    break
            except (SmokeError, OSError):
                pass
            time.sleep(1)
        require(healthy, "Center did not become healthy")
        require(anonymous.json("/api/v1/setup").get("required") is True, "Fresh isolated state was not empty")
        self.check("real center healthz and fresh state")
        self.stage = "administrator CLI and login"
        admin_name, admin_password = "smoke-admin", secrets.token_urlsafe(28)
        self.docker("exec", "-i", center, "lightmoni-admin", "init", "--name", admin_name, "--password-stdin",
            stdin=(admin_password + "\n").encode())
        require(anonymous.json("/api/v1/setup").get("required") is False, "CLI initialization was not persisted")
        admin = Client(base)
        require(admin.json("/api/v1/auth/login", "POST", {"name": admin_name, "password": admin_password}).get("role") == "admin", "Admin login role mismatch")
        require(admin.json("/api/v1/auth/me").get("role") == "admin", "Admin session missing")
        self.check("admin init from stdin, login and session")
        self.stage = "operations HTTP assets and administrator permissions"
        status, headers, html = anonymous.request("/operations")
        require(status == 200 and "text/html" in headers.get("Content-Type", "") and b'id="root"' in html, "Operations HTML route missing")
        assets = re.findall(rb'<script[^>]+src=["\']([^"\']+)["\']', html)
        require(bool(assets), "Web entry script missing")
        operations_route = False
        for asset in assets:
            path = asset.decode()
            require(path.startswith("/assets/") and not path.startswith("//"), "Unexpected web asset location")
            code, _, content = anonymous.request(path)
            require(code == 200 and len(content) > 0, "Web entry asset unavailable")
            operations_route = operations_route or b"/operations" in content
        require(operations_route, "Web entry assets do not contain the operations route")
        member_name, member_password = "smoke-member", secrets.token_urlsafe(28)
        admin.json("/api/v1/users", "POST", {"name": member_name, "password": member_password, "role": "member"}, expect=201)
        member = Client(base)
        require(member.json("/api/v1/auth/login", "POST", {"name": member_name, "password": member_password}).get("role") == "member", "Member login role mismatch")
        for path, key in [("/api/v1/operations/resources", "resources"), ("/api/v1/operations/runs", "runs"),
                ("/api/v1/operations/agents", "agents"), ("/api/v1/operation-schedules", "schedules")]:
            anonymous.json(path, expect=401)
            member.json(path, expect=403)
            require(isinstance(admin.json(path).get(key), list), "Administrator collection response mismatch")
        # Validate all four typed resource definitions through the real HTTP route,
        # but never register a synthetic running Agent or approve an operation.
        configurations = {
            "website": {"domains": ["smoke.invalid"], "mode": "static", "static_files": {"index.html": "smoke"}},
            "certificate": {"domains": ["smoke.invalid"], "email": "smoke@example.invalid"},
            "compose": {"project_name": "smoke", "compose": {"services": {"app": {"image": "busybox:1.37.0"}}}},
            "backup": {"source_path": "/srv/lightmoni-smoke/source", "storage": {"type": "local", "path": "/var/lib/lightmoni-smoke/backups"}},
        }
        for kind, config in configurations.items():
            body = {"kind": kind, "name": "Smoke", "agent_id": "smoke-not-registered", "config": config}
            member.json("/api/v1/operations/resources", "POST", body, expect=403)
            error = admin.json("/api/v1/operations/resources", "POST", body, expect=400)
            require(error.get("error") == "registered_agent_required", "Typed resource validator or registered-node boundary mismatch")
        require(admin.json("/api/v1/operations/resources")["resources"] == [], "No resource should have been created")
        self.check("operations page and four typed APIs", anonymous_status=401, member_status=403, approved_jobs=0)
        self.stage = "packaged center modules and AI boundary"
        module_js = b'''import{pathToFileURL}from'node:url';const root='/opt/lightmoni/runtime/dist/';const defs=[];for(const [file,name]of[['websites','website'],['certificates','certificate'],['containers','compose'],['backups','backup']]){const mod=await import(pathToFileURL(root+'operations/'+file+'.js'));const def=mod[name+'Definition'];if(def.kind!==name)throw Error('definition');defs.push(def.kind);}for(const file of ['server/operations.js','server/operation-schedules.js','agent/operation-lock.js'])await import(pathToFileURL(root+file));const{operationCapabilities}=await import(pathToFileURL(root+'agent/operations.js'));const{operationTools}=await import(pathToFileURL(root+'assistant/operation-tools.js'));const tools=operationTools({}).map(({name,effect})=>({name,effect}));console.log(JSON.stringify({definitions:defs,capabilities:operationCapabilities,tools}));'''
        modules = json.loads(self.docker("exec", "-i", center, "node", "--input-type=module", "-", stdin=module_js).stdout)
        require(set(modules["definitions"]) == set(configurations), "Four center definitions are not packaged")
        require(sorted(modules["capabilities"]) == sorted(CAPABILITIES), "Center operation capability mismatch")
        require({item["name"] for item in modules["tools"]} == {"list_operations_resources", "get_operations_run", "propose_operations_action"}, "Unexpected operations AI tool registration")
        require(all(item["effect"] in ["read", "draft"] for item in modules["tools"]), "AI operations tool can execute")
        self.check("center imports, four operation capabilities and AI read/draft tools")
        self.stage = "two-architecture Agent download and static validation"
        install = admin.json("/api/v1/agent-install")
        version = install.get("version")
        require(isinstance(version, str) and re.fullmatch(r"[0-9A-Za-z._-]+", version), "Invalid release version metadata")
        issued = admin.json("/api/v1/agent-enrollments", "POST", {"endpoint_origin": base, "version": version,
            "allowed_arch": ["amd64", "arm64"], "expires_in_seconds": 900}, expect=201)
        enrollment = issued["token_display_once"]
        anonymous.json("/downloads/agent/SHA256SUMS", expect=401)
        status, _, checksum_bytes = anonymous.request("/downloads/agent/SHA256SUMS", bearer=enrollment)
        require(status == 200, "Agent checksums unavailable")
        checksum_map = {}
        for line in checksum_bytes.decode().splitlines():
            match = re.fullmatch(r"([0-9a-f]{64})\s+([0-9A-Za-z._-]+)", line)
            require(bool(match), "Malformed Agent SHA256SUMS")
            checksum_map[match[2]] = match[1]
        for arch, machine in [("amd64", 62), ("arm64", 183)]:
            filename = "lightmoni-agent_" + version + "_linux_" + arch + ".tar.gz"
            require(filename in install.get("bundles", []) and filename in checksum_map, "Agent architecture bundle missing")
            destination = self.work / filename
            length, digest = anonymous.download("/downloads/agent/" + filename, destination, enrollment)
            require(digest == checksum_map[filename], "Agent archive SHA256 mismatch")
            bundle = inspect_bundle(destination, arch, machine, version)
            self.report["downloads"].append({"file": filename, "bytes": length, "sha256": digest, **bundle})
        self.check("AMD and ARM archive SHA256, ELF and operation modules", native_platform=self.native_platform,
            static_platform="linux/" + other_arch)
        self.stage = "native embedded Node Agent entry point"
        filename = "lightmoni-agent_" + version + "_linux_" + self.native_arch + ".tar.gz"
        # Run only `version` and imports. This never calls createAgent/run or an installer.
        embedded_js = b'''import fs from'node:fs';import{join}from'node:path';import{spawnSync}from'node:child_process';import{pathToFileURL}from'node:url';const dir=fs.mkdtempSync('/tmp/lightmoni-ops-bundle-');const run=(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8',timeout:60000,maxBuffer:1048576});if(r.status!==0)throw Error('embedded check failed');return r.stdout.trim();};try{run('tar',['-xzf','/opt/lightmoni/runtime/downloads/'''+filename.encode()+b'''','-C',dir]);const root=join(dir,'lightmoni-agent-runtime'),node=join(root,'node'),main=join(root,'app/runtime/dist/agent/main.js');const version=run(node,[main,'version']);const runtime=run(node,['-p',"process.platform+'/'+process.arch"]);const url=pathToFileURL(join(root,'app/runtime/dist/agent/operations.js')).href;const caps=JSON.parse(run(node,['--input-type=module','-e','const m=await import('+JSON.stringify(url)+');console.log(JSON.stringify(m.operationCapabilities))']));console.log(JSON.stringify({version,runtime,capabilities:caps}));}finally{fs.rmSync(dir,{recursive:true,force:true});}'''
        embedded = json.loads(self.docker("exec", "-i", center, "node", "--input-type=module", "-", stdin=embedded_js, timeout=120).stdout)
        expected_runtime = "linux/" + ("x64" if self.native_arch == "amd64" else "arm64")
        require(embedded.get("version") == version and embedded.get("runtime") == expected_runtime, "Embedded Agent version or runtime mismatch")
        require(sorted(embedded.get("capabilities", [])) == sorted(CAPABILITIES), "Embedded native Agent capabilities are stale")
        for bundle in self.report["downloads"]:
            if bundle["platform"] == self.native_platform:
                bundle["executed"] = True
        self.check("embedded native Node entry point", version=version, runtime=expected_runtime,
            platform=self.native_platform, command="version", agent_daemon_started=False)
        self.report["passed"] = True


def inspect_bundle(path, arch, machine, version):
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        require(len(members) <= 50000 and sum(item.size for item in members) <= 2 << 30, "Agent archive exceeds inspection limits")
        for item in members:
            normalized = posixpath.normpath(item.name)
            require(not item.name.startswith("/") and not normalized.startswith("../") and normalized != "..", "Unsafe Agent archive path")
            require(PurePosixPath(normalized).parts[0] in ["lightmoni-agent", "lightmoni-agent.service", "lightmoni-agent-runtime"], "Unexpected Agent archive root")
            require(item.isfile() or item.isdir() or item.issym() or item.islnk(), "Special file in Agent archive")
            if item.issym() or item.islnk():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(normalized) if item.issym() else "", item.linkname))
                require(not item.linkname.startswith("/") and target != ".." and not target.startswith("../"), "Unsafe Agent archive link")
        root = "lightmoni-agent-runtime/"
        node_member = archive.getmember(root + "node")
        with archive.extractfile(node_member) as handle:
            header = handle.read(20)
        require(header[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", header, 18)[0] == machine, "Agent Node ELF architecture mismatch")
        require(node_member.mode & 0o111, "Agent Node is not executable")
        release = json.load(archive.extractfile(root + "release.json"))
        require(release.get("platform") == "linux" and release.get("arch") == arch and release.get("version") == version, "Agent release metadata mismatch")
        for domain in DOMAINS:
            require(archive.getmember(root + "app/runtime/dist/operations/" + domain + ".js").isfile(), "Agent operation module missing")
        require(archive.getmember(root + "app/runtime/dist/agent/operation-lock.js").isfile(), "Agent durable lock module missing")
        capabilities = archive.extractfile(root + "app/runtime/dist/agent/operations.js").read(1 << 20)
        require(all(capability.encode() in capabilities for capability in CAPABILITIES), "Static Agent operation capabilities missing")
        return {"platform": "linux/" + arch, "elf_machine": machine, "node_version": release.get("node_version"), "operation_modules": 4, "executed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image")
    parser.add_argument("source_revision")
    parser.add_argument("work_dir", type=Path)
    args = parser.parse_args()
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}", args.image), "Invalid image reference")
    require(re.fullmatch(r"[0-9a-f]{7,40}", args.source_revision), "Expected a 7-40 character lowercase commit SHA")
    args.work_dir = args.work_dir.resolve()
    require(args.work_dir.is_dir(), "Work directory must already exist")
    smoke = Smoke(args)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        smoke.execute()
    except SmokeError as error:
        smoke.report["error"] = str(error)
    except KeyboardInterrupt:
        smoke.report["error"] = "Interrupted"
    except Exception as error:
        smoke.report["error"] = "Unexpected " + type(error).__name__ + " during " + smoke.stage
    finally:
        smoke.report["last_stage"] = smoke.stage
        try:
            smoke.cleanup()
        except BaseException:
            smoke.report["passed"] = False
            smoke.report["cleanup"] = {"errors": ["Cleanup interrupted; inspect only this run's labelled resources"], "run_id": smoke.run_id}
        report_path = smoke.work / "report.json"
        descriptor = os.open(report_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump(smoke.report, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print(json.dumps({"passed": smoke.report["passed"], "report": str(report_path), "run_id": smoke.run_id}, ensure_ascii=False))
    return 0 if smoke.report["passed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SmokeError as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        sys.exit(1)
