#!/usr/bin/env python3
"""Offline, streaming application backup and Compose deployment migration.

No shell, daemon credentials, dependency installation or automatic image pulls.
Archives contain secrets. Only explicitly selected Docker objects are stopped.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import uuid

VERSION = 1
APP = 'io.lightmoni.platform.application'
OWNER = 'io.lightmoni.platform.owner'
PROJECT = 'com.docker.compose.project'
SERVICE = 'com.docker.compose.service'
MAX_METADATA = 16 << 20
DOCKER_ENV = None


class BackupError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise BackupError(code)


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as src:
        for block in iter(lambda: src.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def docker(*args, output=None, stdin=None):
    # subprocess diagnostics can contain environment secrets. Only expose codes.
    result = subprocess.run(['docker', *args], stdout=output or subprocess.PIPE, stdin=stdin,
                            stderr=subprocess.PIPE, timeout=3600, check=False, env=DOCKER_ENV)
    require(result.returncode == 0, 'docker_command_failed:' + args[0])
    if output is not None:
        return None
    require(len(result.stdout) <= MAX_METADATA, 'docker_metadata_limit')
    return result.stdout.decode('utf-8')


def inspect(ids):
    require(0 < len(ids) <= 128, 'container_count_limit_or_empty')
    return json.loads(docker('inspect', *ids))


def image_info(image):
    value = json.loads(docker('image', 'inspect', image))[0]
    return {k: value.get(k) for k in ('Id', 'Os', 'Architecture', 'RepoDigests', 'Descriptor')}


def mount_option(mount, readonly=True):
    kind = mount['type']
    source = mount['source']
    require(kind in ('volume', 'bind') and isinstance(source, str)
            and not any(c in source for c in ',\r\n\x00'), 'unsupported_mount')
    if kind == 'volume':
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', source), 'invalid_volume')
    else:
        require(source.startswith('/') and source != '/'
                and not any(source == p or source.startswith(p + '/')
                            for p in ('/proc', '/sys', '/dev', '/etc', '/boot', '/usr', '/bin', '/sbin')),
                'system_bind_mount_not_supported')
    return f'type={kind},src={source},dst=/source' + (',readonly' if readonly else '')


def helper(image, mount, *args, output=None, writable=False, stdin=None):
    with tempfile.TemporaryDirectory(prefix='lightmoni-helper-') as tmp:
      cidfile = Path(tmp) / 'cid'
      try:
        return docker('run', '--rm', *(['-i'] if stdin is not None else []), '--cidfile', str(cidfile), '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                  # Read and restore arbitrary container uid/gid without exposing
                  # another host path or the daemon socket to the helper.
                  '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'DAC_READ_SEARCH',
                  '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges',
                  '--user', '0:0', '--mount', mount_option(mount, not writable),
                  '--entrypoint', '/bin/tar', image, *args, output=output, stdin=stdin)
      finally:
        if cidfile.is_file():
            cid = cidfile.read_text().strip()
            if re.fullmatch(r'[a-f0-9]{64}', cid):
                try:
                    docker('rm', '-f', cid)
                except BackupError:
                    pass  # --rm already removed a completed helper.


def valid_archive_path(name):
    p = PurePosixPath(name)
    require(not p.is_absolute() and '..' not in p.parts and '\x00' not in name
            and '\\' not in name and len(name) <= 4096, 'unsafe_archive_path')


def validate_tar(path):
    """Stream every header; never extract untrusted paths on the host."""
    count = 0
    with tarfile.open(path, mode='r|*') as archive:
        for item in archive:
            count += 1
            require(count <= 2_000_000, 'archive_entry_limit')
            valid_archive_path(item.name)
            require(item.isfile() or item.isdir() or item.issym() or item.islnk(),
                    'archive_special_file_not_supported')
            if item.issym() or item.islnk():
                target = item.linkname
                require(not PurePosixPath(target).is_absolute(), 'absolute_archive_link_not_supported')
                # Resolve relative links without ever traversing above the root.
                parts = list(PurePosixPath(item.name).parent.parts) if item.issym() else []
                for part in PurePosixPath(target).parts:
                    if part == '..':
                        require(bool(parts), 'escaping_archive_link')
                        parts.pop()
                    elif part != '.':
                        parts.append(part)
                require('\\' not in target and '\x00' not in target, 'unsafe_archive_link')
    return count


def tree_digest(path):
    rows = []
    with tarfile.open(path, 'r|*') as archive:
        for item in archive:
            h = hashlib.sha256()
            if item.isfile():
                src = archive.extractfile(item)
                for block in iter(lambda: src.read(1 << 20), b''):
                    h.update(block)
            rows.append([str(PurePosixPath(item.name)), item.type.decode(), item.uid, item.gid,
                         item.mode, item.linkname, item.size, h.hexdigest()])
    return hashlib.sha256(json.dumps(sorted(rows), separators=(',', ':')).encode()).hexdigest()


def discover(application=None, project=None):
    require(bool(application) != bool(project), 'select_application_or_project')
    if application:
        require(re.fullmatch(r'[a-f0-9]{32}', application), 'invalid_application_id')
    if project:
        require(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', project), 'invalid_project')
    label = f'{APP}={application}' if application else f'{PROJECT}={project}'
    ids = docker('ps', '-aq', '--no-trunc', '--filter', 'label=' + label).split()
    containers = inspect(ids)
    for c in containers:
        labels = c['Config'].get('Labels') or {}
        require(labels.get(APP) == application and labels.get(OWNER) == 'lightmoni'
                if application else labels.get(PROJECT) == project, 'container_ownership_changed')
        require(not c['HostConfig'].get('Privileged') and not c['HostConfig'].get('Devices')
                and not c['HostConfig'].get('DeviceRequests') and not c['HostConfig'].get('StorageOpt')
                and c['HostConfig'].get('Runtime', 'runc') in ('', 'runc')
                and c['HostConfig'].get('NetworkMode') not in ('host', 'none')
                and not str(c['HostConfig'].get('NetworkMode', '')).startswith('container:')
                and not c['HostConfig'].get('Links') and not c['HostConfig'].get('CgroupParent')
                and c['HostConfig'].get('UsernsMode') in ('', None)
                and c['HostConfig'].get('CgroupnsMode') in ('', None, 'private')
                and c['HostConfig'].get('PidMode') in ('', None)
                and c['HostConfig'].get('IpcMode') in ('', None, 'private', 'shareable')
                and c['HostConfig'].get('UTSMode') in ('', None)
                and not c['HostConfig'].get('CapAdd'), 'unsupported_container_privileges_or_network')
    if project:
        require({c['Config']['Labels'].get(SERVICE) for c in containers} == {'lightmoni', 'clickhouse'},
                'migration_requires_lightmoni_and_clickhouse_project')
        center = next(c for c in containers if c['Config']['Labels'].get(SERVICE) == 'lightmoni')
        env = dict(v.split('=', 1) for v in center['Config'].get('Env', []) if '=' in v)
        require(urllib.parse.urlsplit(env.get('LIGHTMONI_CH_URL', 'http://clickhouse:8123')).hostname == 'clickhouse',
                'external_clickhouse_requires_separate_backup')
    mounts, mappings = [], {}
    for c in containers:
        for m in c.get('Mounts', []):
            if m['Type'] == 'tmpfs':
                continue  # Ephemeral by definition; recorded in full inspection.
            require(m['Type'] in ('volume', 'bind'), 'unsupported_persistent_mount')
            src = m.get('Name') if m['Type'] == 'volume' else m['Source']
            key = (m['Type'], src)
            if key not in mappings:
                entry = {'type': m['Type'], 'source': src, 'slot': str(len(mounts)), 'targets': []}
                mount_option(entry)
                mappings[key] = entry
                mounts.append(entry)
            mappings[key]['targets'].append({'container': c['Id'], 'target': m['Destination'], 'read_only': not m.get('RW', False)})
    require(bool(mounts) and len(mounts) <= 256, 'no_persistent_mounts_or_mount_limit')
    if project:
        destinations = {m['Destination'] for c in containers for m in c.get('Mounts', [])}
        require('/data' in destinations and '/var/lib/clickhouse' in destinations, 'incomplete_deployment_storage')
    return containers, mounts


def current(ids):
    return {c['Id']: c for c in inspect(ids)}


def frozen(containers):
    rows = current([c['Id'] for c in containers])
    for original in containers:
        c = rows[original['Id']]
        require(not c['State'].get('Running') and not c['State'].get('Paused'), 'source_must_remain_stopped')
        require(c['Config'] == original['Config'] and c['HostConfig'] == original['HostConfig']
                and c.get('Mounts') == original.get('Mounts'), 'source_configuration_changed')


def private_write(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out:
        out.write(data)


def export_backup(args):
    containers, mounts = discover(args.application, args.project)
    summary = {'kind': 'application' if args.application else 'deployment',
               'application': args.application, 'project': args.project,
               'containers': len(containers), 'persistent_sources': len(mounts),
               'running': sum(bool(c['State'].get('Running')) for c in containers),
               'requires_stop': True, 'includes_images': args.include_images or bool(args.project)}
    if not args.execute:
        return summary
    require(args.confirm_stop and args.output, 'explicit_stop_confirmation_and_output_required')
    output = Path(args.output).absolute()
    require(not output.exists() and not output.is_symlink(), 'output_already_exists')
    require(output.parent.is_dir(), 'output_parent_missing')
    destination = output.parent.resolve()
    for m in mounts:
        root = (json.loads(docker('volume', 'inspect', m['source']))[0]['Mountpoint']
                if m['type'] == 'volume' else m['source'])
        source = Path(root).resolve()
        require(destination != source and destination not in source.parents and source not in destination.parents,
                'backup_output_overlaps_source')
    helper_image = image_info(args.helper_image)['Id']
    ids = [c['Id'] for c in containers]
    # Shared running consumers would invalidate the offline consistency claim.
    for m in mounts:
        consumers = docker('ps', '-q', '--no-trunc', '--filter', 'volume=' + m['source']).split()
        require(all(c in ids for c in consumers), 'persistent_source_has_other_running_consumers')
    running = [c['Id'] for c in containers if c['State'].get('Running')]
    require(not any(c['State'].get('Paused') for c in containers), 'paused_container_not_supported')
    stop_attempted, completed = False, False
    try:
        if running:
            stop_attempted = True
            if args.project:
                for service in ('lightmoni', 'clickhouse'):
                    targets = [c['Id'] for c in containers if c['Id'] in running and c['Config']['Labels'].get(SERVICE) == service]
                    if targets:
                        docker('stop', '--time', '60', *targets)
            else:
                docker('stop', '--time', '60', *running)
        frozen(containers)
        snapshot_started = dt.datetime.now(dt.timezone.utc).isoformat()
        # Exit 137 can mean the grace period expired; never label it a clean DB snapshot.
        after_stop = current(ids)
        require(all(after_stop[cid]['State'].get('ExitCode') != 137 for cid in running), 'unclean_stop_requires_database_recovery')
        with tempfile.TemporaryDirectory(prefix='.lightmoni-backup-', dir=output.parent) as tmp:
            stage = Path(tmp)
            files = {}
            for m in mounts:
                name = 'data/' + m['slot'] + '.tar'
                path = stage / name
                path.parent.mkdir(exist_ok=True)
                with open(path, 'xb') as out:
                    helper(helper_image, m, '--numeric-owner', '-cpf', '-', '-C', '/source', '.', output=out)
                validate_tar(path)
                files[name] = {'sha256': digest(path), 'size': path.stat().st_size, 'tree_sha256': tree_digest(path)}
                frozen(containers)
            images = {c['Image']: image_info(c['Image']) for c in containers}
            if args.include_images or args.project:
                with open(stage / 'images.tar', 'xb') as out:
                    docker('image', 'save', *images, output=out)
                files['images.tar'] = {'sha256': digest(stage / 'images.tar'), 'size': (stage / 'images.tar').stat().st_size}
            compose = compose_from_inspect(containers, mounts)
            private_write(stage / 'compose.json', json.dumps(compose).encode())
            files['compose.json'] = {'sha256': digest(stage / 'compose.json'), 'size': (stage / 'compose.json').stat().st_size}
            manifest = {'format': 'lightmoni.offline-backup', 'version': VERSION, 'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                        **summary, 'containers': containers, 'mounts': mounts, 'images': images, 'files': files,
                        'consistency': 'stopped', 'source_left_stopped': bool(args.project or args.leave_stopped)}
            private_write(stage / 'manifest.json', json.dumps(manifest).encode())
            frozen(containers)
            until = dt.datetime.now(dt.timezone.utc).isoformat()
            for cid in ids:
                events = docker('events', '--since', snapshot_started, '--until', until,
                    '--filter', 'container=' + cid, '--filter', 'event=start', '--filter', 'event=unpause',
                    '--filter', 'event=destroy', '--filter', 'event=die', '--format', '{{json .}}')
                require(not events.strip(), 'source_changed_during_backup')
            # Compression and output are streaming; no 256 MiB in-memory archive limit.
            partial = stage / 'archive.partial'
            with os.fdopen(os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as raw:
                with tarfile.open(fileobj=raw, mode='w|gz', format=tarfile.PAX_FORMAT) as archive:
                    for name in ['manifest.json', *files]:
                        archive.add(stage / name, arcname=name, recursive=False)
                raw.flush()
                os.fsync(raw.fileno())
            verified = verify_backup(partial)
            # Exclusive publication: never overwrite a backup created meanwhile.
            os.link(partial, output)
        if args.s3_config:
            verified['cloud'] = upload_s3(output, read_config(args.s3_config))
        completed = True
        return {**verified, 'path': str(output), 'source_left_stopped': bool(args.project or args.leave_stopped)}
    finally:
        # A migration deliberately leaves the old center stopped to prevent two schedulers.
        if stop_attempted and running and not args.leave_stopped and (not args.project or not completed):
            rows = current(running)
            resume = []
            for original in containers:
                if original['Id'] in running:
                    c = rows[original['Id']]
                    require(c['Config'] == original['Config'] and c['HostConfig'] == original['HostConfig']
                            and c.get('Mounts') == original.get('Mounts'), 'source_changed_resume_requires_review')
                    if not c['State'].get('Running'):
                        resume.append(c['Id'])
            if resume:
                docker('start', *resume)
            require(all(current(running)[cid]['State'].get('Running') for cid in running), 'source_restart_not_verified')


def compose_from_inspect(containers, mounts):
    result = {'services': {}, 'volumes': {m['slot']: {} for m in mounts}, 'networks': {}}
    names = set()
    network_keys = {}
    service_names = [(c['Config'].get('Labels') or {}).get(SERVICE) or c['Name'].lstrip('/') for c in containers]
    for c in containers:
        cfg, host = c['Config'], c['HostConfig']
        name = (cfg.get('Labels') or {}).get(SERVICE) or c['Name'].lstrip('/')
        if service_names.count(name) > 1:
            name = name + '-' + c['Id'][:12]
        require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', name) and name not in names, 'duplicate_service_name_use_per_instance_backup')
        names.add(name)
        service = {'image': c['Image'], 'environment': cfg.get('Env') or [],
                   'entrypoint': cfg.get('Entrypoint'), 'command': cfg.get('Cmd'),
                   'volumes': [], 'restart': host.get('RestartPolicy', {}).get('Name') or 'no'}
        if service['restart'] == 'on-failure' and host.get('RestartPolicy', {}).get('MaximumRetryCount'):
            service['restart'] += ':' + str(host['RestartPolicy']['MaximumRetryCount'])
        for key, value in [('user', cfg.get('User')), ('working_dir', cfg.get('WorkingDir')), ('healthcheck', cfg.get('Healthcheck'))]:
            if value:
                service[key] = ({'test': value.get('Test'), 'interval': str(value.get('Interval', 0)) + 'ns',
                                 'timeout': str(value.get('Timeout', 0)) + 'ns', 'retries': value.get('Retries', 0),
                                 'start_period': str(value.get('StartPeriod', 0)) + 'ns'} if key == 'healthcheck' else value)
        if host.get('Memory'):
            service['mem_limit'] = host['Memory']
        if host.get('NanoCpus'):
            service['cpus'] = host['NanoCpus'] / 1e9
        for key, value in [('extra_hosts', host.get('ExtraHosts')), ('dns', host.get('Dns')),
                           ('read_only', host.get('ReadonlyRootfs')), ('tmpfs', host.get('Tmpfs')),
                           ('init', host.get('Init')), ('shm_size', host.get('ShmSize')),
                           ('cap_drop', host.get('CapDrop')), ('security_opt', host.get('SecurityOpt')),
                           ('pids_limit', host.get('PidsLimit')), ('mem_reservation', host.get('MemoryReservation')),
                           ('memswap_limit', host.get('MemorySwap')), ('cpuset', host.get('CpusetCpus')),
                           ('cpu_shares', host.get('CpuShares')), ('stop_signal', cfg.get('StopSignal')),
                           ('group_add', host.get('GroupAdd')), ('sysctls', host.get('Sysctls')),
                           ('oom_kill_disable', host.get('OomKillDisable')), ('oom_score_adj', host.get('OomScoreAdj')),
                           ('tty', cfg.get('Tty')), ('stdin_open', cfg.get('OpenStdin')), ('domainname', cfg.get('Domainname'))]:
            if value:
                service[key] = value
        if cfg.get('StopTimeout') is not None:
            service['stop_grace_period'] = str(cfg['StopTimeout']) + 's'
        if cfg.get('Hostname') and cfg['Hostname'] != c['Id'][:12]:
            service['hostname'] = cfg['Hostname']
        if host.get('LogConfig', {}).get('Type'):
            service['logging'] = {'driver': host['LogConfig']['Type'], 'options': host['LogConfig'].get('Config') or {}}
        if host.get('Ulimits'):
            service['ulimits'] = {u['Name']: {'soft': u['Soft'], 'hard': u['Hard']} for u in host['Ulimits']}
        if not host.get('NanoCpus'):
            for key, field in [('cpu_period','CpuPeriod'),('cpu_quota','CpuQuota')]:
                if host.get(field):
                    service[key] = host[field]
        service['labels'] = {k: v for k, v in (cfg.get('Labels') or {}).items()
                             if not k.startswith(('io.lightmoni.platform.', 'com.docker.compose.'))}
        ports = []
        for target, bindings in (host.get('PortBindings') or {}).items():
            port, protocol = target.split('/')
            for b in bindings or []:
                ports.append({'target': int(port), 'published': b['HostPort'], 'host_ip': b.get('HostIp') or '0.0.0.0', 'protocol': protocol})
        if ports:
            service['ports'] = ports
        service['networks'] = {}
        for network, config in c.get('NetworkSettings', {}).get('Networks', {}).items():
            require(not config.get('IPAMConfig'), 'static_container_ip_not_supported')
            key = network_keys.setdefault(network, 'network' + str(len(network_keys)))
            result['networks'][key] = {}
            service['networks'][key] = {'aliases': config.get('Aliases') or [name]}
        for m in mounts:
            for target in m['targets']:
                if target['container'] == c['Id']:
                    service['volumes'].append({'type': 'volume', 'source': m['slot'], 'target': target['target'], 'read_only': target['read_only']})
        result['services'][name] = service
    def escape(value):
        if isinstance(value, str):
            return value.replace('$', '$$')
        if isinstance(value, list):
            return [escape(v) for v in value]
        if isinstance(value, dict):
            return {k: escape(v) for k, v in value.items()}
        return value
    return escape(result)


def read_manifest(archive):
    members = archive.getmembers()
    require(len(members) <= 260, 'outer_archive_entry_limit')
    require(len({m.name for m in members}) == len(members), 'duplicate_archive_member')
    for m in members:
        valid_archive_path(m.name)
        require(m.isfile(), 'outer_archive_requires_regular_files')
    info = archive.getmember('manifest.json')
    require(info.size <= MAX_METADATA, 'manifest_size_limit')
    manifest = json.load(archive.extractfile(info))
    require(manifest.get('format') == 'lightmoni.offline-backup' and manifest.get('version') == VERSION
            and manifest.get('consistency') == 'stopped', 'invalid_backup_format')
    files = manifest.get('files', {})
    require(isinstance(files, dict) and 1 <= len(files) <= 258 and 'compose.json' in files
            and {m.name for m in members} == {'manifest.json', *files}, 'incomplete_archive_members')
    require(archive.getmember('compose.json').size <= MAX_METADATA, 'compose_metadata_limit')
    require(manifest.get('kind') in ('application', 'deployment'), 'invalid_backup_kind')
    mounts = manifest.get('mounts')
    require(isinstance(mounts, list) and 0 < len(mounts) <= 256, 'invalid_backup_mounts')
    require({m.get('slot') for m in mounts} == {str(i) for i in range(len(mounts))}, 'invalid_backup_slots')
    require({name for name in files if name.startswith('data/')} == {'data/' + m['slot'] + '.tar' for m in mounts}, 'missing_backup_volume')
    for name, meta in files.items():
        require(re.fullmatch(r'(?:compose\.json|images\.tar|data/[0-9]+\.tar)', name)
                and isinstance(meta, dict) and re.fullmatch(r'[a-f0-9]{64}', meta.get('sha256', ''))
                and archive.getmember(name).size == meta.get('size'), 'invalid_archive_file')
    return manifest


def validate_image_archive(path, images):
    # docker save by image ID must not import or overwrite mutable repository tags.
    with tarfile.open(path, 'r:') as archive:
        names = set(archive.getnames())
        def image_configs(image, value):
            descriptor = value.get('Descriptor') or {}
            if not descriptor:
                return {image}  # Classic store: image ID is the configuration digest.
            require(descriptor.get('digest') == image, 'image_descriptor_mismatch')
            configs, visited = set(), set()
            def visit(digest, required=False):
                require(isinstance(digest, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', digest),
                        'invalid_image_descriptor_digest')
                name = 'blobs/sha256/' + digest[7:]
                # An OCI index can reference platforms absent from a local export.
                if name not in names and not required:
                    return
                require(name in names, 'missing_image_manifest')
                if digest in visited:
                    return
                require(len(visited) < 256, 'image_descriptor_limit')
                visited.add(digest)
                item = archive.getmember(name)
                require(item.isfile() and item.size <= MAX_METADATA, 'invalid_image_manifest')
                content = archive.extractfile(item).read()
                require('sha256:' + hashlib.sha256(content).hexdigest() == digest,
                        'image_manifest_checksum_mismatch')
                node = json.loads(content)
                if isinstance(node.get('config'), dict):
                    configs.add(node['config']['digest'])
                for child in node.get('manifests', []):
                    visit(child['digest'])
            visit(image, required=True)
            require(configs, 'missing_image_configuration_descriptor')
            return configs
        expected = {image: image_configs(image, value) for image, value in images.items()}
        member = archive.getmember('manifest.json')
        require(member.isfile() and member.size <= MAX_METADATA, 'invalid_image_archive_manifest')
        entries = json.load(archive.extractfile(member))
        require(isinstance(entries, list) and len(entries) == len(images), 'image_archive_identity_mismatch')
        found = set()
        for entry in entries:
            require(not entry.get('RepoTags'), 'image_archive_must_not_overwrite_tags')
            name = entry['Config']
            valid_archive_path(name)
            config = archive.getmember(name)
            require(config.isfile() and config.size <= MAX_METADATA, 'invalid_image_configuration')
            config_id = 'sha256:' + hashlib.sha256(archive.extractfile(config).read()).hexdigest()
            matches = [image for image, configs in expected.items() if config_id in configs]
            require(len(matches) == 1, 'unexpected_archived_image')
            image = matches[0]
            found.add(image)
        require(found == set(images), 'image_archive_identity_mismatch')


def unpack_verified(path, stage):
    with tarfile.open(path, 'r:gz') as archive:
        manifest = read_manifest(archive)
        require(shutil.disk_usage(stage).free > sum(v['size'] for v in manifest['files'].values()) + (16 << 20),
                'insufficient_staging_disk')
        for name, meta in manifest['files'].items():
            target = stage / name
            target.parent.mkdir(exist_ok=True)
            with open(target, 'xb') as out:
                shutil.copyfileobj(archive.extractfile(name), out, 1 << 20)
            require(digest(target) == meta['sha256'], 'backup_checksum_mismatch')
            if name.startswith('data/'):
                validate_tar(target)
                require(tree_digest(target) == meta.get('tree_sha256'), 'backup_tree_checksum_mismatch')
            if name == 'images.tar':
                validate_image_archive(target, manifest['images'])
    return manifest


def verify_backup(path):
    # Verification does not contact Docker, mutate volumes or print private metadata.
    with tempfile.TemporaryDirectory(prefix='lightmoni-verify-') as tmp:
        manifest = unpack_verified(path, Path(tmp))
    return {'verified': True, 'version': VERSION, 'kind': manifest['kind'], 'application': manifest.get('application'),
            'project': manifest.get('project'), 'persistent_sources': len(manifest['mounts']),
            'sha256': digest(path), 'size': Path(path).stat().st_size}


def restore_backup_data(args, operation):
    require(args.execute and args.confirm_empty_targets, 'restore_requires_execute_and_empty_target_confirmation')
    require(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', args.target_project), 'invalid_target_project')
    require(not docker('ps', '-aq', '--filter', f'label={PROJECT}={args.target_project}').strip(), 'target_project_not_empty')
    output = Path(args.directory).absolute()
    require(not output.exists() and output.parent.is_dir(), 'restore_directory_must_not_exist')
    with tempfile.TemporaryDirectory(prefix='lightmoni-restore-') as tmp:
        stage = Path(tmp)
        manifest = unpack_verified(args.archive, stage)
        require(isinstance(manifest.get('containers'), list) and 0 < len(manifest['containers']) <= 128,
                'invalid_backup_containers')
        expected_compose = compose_from_inspect(manifest['containers'], manifest['mounts'])
        require(json.loads((stage / 'compose.json').read_text()) == expected_compose,
                'backup_compose_does_not_match_inspection')
        helper_image = image_info(args.helper_image)['Id']
        target_platform = docker('info', '--format', '{{.OSType}}/{{.Architecture}}').strip()
        arch = {'aarch64': 'arm64', 'x86_64': 'amd64'}
        target_os, target_arch = target_platform.split('/')
        require(all(i.get('Os') == target_os and i.get('Architecture') == arch.get(target_arch, target_arch)
                    for i in manifest['images'].values()), 'target_platform_differs')
        targets = [{'type': 'volume', 'source': args.target_project + '-backup-' + operation[:12] + '-' + m['slot']} for m in manifest['mounts']]
        existing = set(docker('volume', 'ls', '--format', '{{.Name}}').splitlines())
        require(not any(t['source'] in existing for t in targets), 'target_volume_already_exists')
        # Fully verify every archive and all targets before creating anything.
        if 'images.tar' in manifest['files']:
            docker('image', 'load', '--input', str(stage / 'images.tar'))
        for image in manifest['images']:
            require(image_info(image)['Id'] == image, 'exact_backup_image_unavailable')
        for m, target in zip(manifest['mounts'], targets):
            docker('volume', 'create', '--label', 'io.lightmoni.backup.project=' + args.target_project, '--label', 'io.lightmoni.backup.operation=' + operation, target['source'])
            created = json.loads(docker('volume', 'inspect', target['source']))[0]
            require(created.get('Labels', {}).get('io.lightmoni.backup.operation') == operation, 'restore_volume_identity_changed')
            require(not docker('ps', '-aq', '--filter', 'volume=' + target['source']).strip(), 'restore_volume_has_consumers')
            empty = stage / ('empty-' + m['slot'] + '.tar')
            with open(empty, 'xb') as out:
                helper(helper_image, target, '-cpf', '-', '-C', '/source', '.', output=out)
            with tarfile.open(empty) as check:
                require(all(str(PurePosixPath(e.name)) == '.' and e.isdir() for e in check), 'restore_volume_not_empty')
            empty.unlink()
            # Container stdin streams the already verified tar; no host extraction.
            with open(stage / ('data/' + m['slot'] + '.tar'), 'rb') as src:
                helper(helper_image, target, '--numeric-owner', '-xpf', '-', '-C', '/source', stdin=src, writable=True)
            restored = stage / ('restored-' + m['slot'] + '.tar')
            with open(restored, 'xb') as out:
                helper(helper_image, target, '--numeric-owner', '-cpf', '-', '-C', '/source', '.', output=out)
            validate_tar(restored)
            require(tree_digest(restored) == manifest['files']['data/' + m['slot'] + '.tar']['tree_sha256'],
                    'restored_content_or_ownership_mismatch')
            restored.unlink()
        output.mkdir(mode=0o700)
        compose = json.loads((stage / 'compose.json').read_text())
        # Use fresh volumes and omit platform ownership labels: restoring data
        # does not impersonate an Agent or silently register another application.
        compose['volumes'] = {m['slot']: {'external': True, 'name': target['source']} for m, target in zip(manifest['mounts'], targets)}
        private_write(output / 'compose.json', json.dumps(compose).encode())
        private_write(output / 'backup-manifest.json', json.dumps(manifest).encode())
        docker('compose', '-p', args.target_project, '-f', str(output / 'compose.json'), 'config', '--quiet')
        # Deliberately do not start a second center or containers automatically.
        return {'verified': True, 'restored_volumes': len(targets), 'started': False, 'directory': str(output), 'volume_names': [t['source'] for t in targets],
                'next': ['docker', 'compose', '-p', args.target_project, '-f', str(output / 'compose.json'), 'up', '-d']}


@contextmanager
def restore_lock(project, image):
    operation = uuid.uuid4().hex
    # Container names are exclusive in the daemon, unlike idempotent volume create.
    lock = docker('create', '--name', 'lightmoni-restore-lock-' + project, '--network', 'none',
                  '--label', 'io.lightmoni.backup.operation=' + operation,
                  '--entrypoint', '/bin/true', image).strip()
    try:
        yield operation
    finally:
        docker('rm', lock)


def restore_backup(args):
    require(args.execute and args.confirm_empty_targets, 'restore_requires_execute_and_empty_target_confirmation')
    require(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', args.target_project), 'invalid_target_project')
    # Every byte is verified before acquiring the daemon lock or mutating images/volumes.
    verify_backup(args.archive)
    image = image_info(args.helper_image)['Id']
    with restore_lock(args.target_project, image) as operation:
        return restore_backup_data(args, operation)


def read_config(path, private=False):
    p = Path(path)
    require(p.is_file() and not p.is_symlink() and p.stat().st_size < 65536, 'invalid_config_file')
    if private:
        require(p.stat().st_mode & 0o077 == 0 and p.stat().st_uid == os.geteuid(), 'configuration_must_be_private_and_owned')
    return json.loads(p.read_text())


def unit_quote(value):
    require(isinstance(value, str) and not any(ord(c) < 32 for c in value), 'invalid_unit_value')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def root_owned(path, private=False):
    p = Path(path).absolute()
    require(os.geteuid() == 0, 'scheduled_backups_require_root')
    for at in reversed([p, *p.parents]):
        st = at.lstat()
        require(not at.is_symlink() and st.st_uid == 0
                and (not st.st_mode & 0o022 or at.is_dir() and st.st_mode & 0o1000),
                'scheduled_path_must_be_root_owned_and_protected')
    if private:
        require(p.stat().st_mode & 0o077 == 0, 'scheduled_path_must_be_private')
    return p


def schedule_credentials(path):
    p = root_owned(path, private=True)
    require(p.is_file() and p.stat().st_size <= 16384, 'invalid_schedule_credentials')
    allowed = {'LIGHTMONI_BACKUP_ACCESS_KEY_ID', 'LIGHTMONI_BACKUP_SECRET_ACCESS_KEY', 'LIGHTMONI_BACKUP_SESSION_TOKEN'}
    result = {}
    for line in p.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        require('=' in line, 'invalid_schedule_credentials')
        key, value = line.split('=', 1)
        require(key in allowed and key not in result and 0 < len(value) <= 8192
                and not any(ord(c) < 32 for c in value), 'invalid_schedule_credential_variable')
        result[key] = value
    require(result.get('LIGHTMONI_BACKUP_ACCESS_KEY_ID') and result.get('LIGHTMONI_BACKUP_SECRET_ACCESS_KEY'),
            'schedule_credentials_missing')
    return result


def schedule_files(args):
    root_owned(Path(__file__).resolve())
    require(re.fullmatch(r'[a-f0-9]{32}', args.application), 'invalid_application_id')
    require(re.fullmatch(r'[A-Za-z0-9*:,./~_ +\-]{1,128}', args.on_calendar), 'invalid_calendar')
    root = Path(args.directory).absolute()
    require(not root.exists() and root.parent.is_dir(), 'schedule_directory_must_not_exist')
    root_owned(root.parent)
    output, credentials = Path(args.output_directory).absolute(), Path(args.credentials_file).absolute()
    require(output.is_dir() and not output.is_symlink() and output.stat().st_mode & 0o077 == 0,
            'backup_output_directory_must_be_private')
    require(credentials.is_file() and not credentials.is_symlink() and credentials.stat().st_mode & 0o077 == 0,
            'credential_file_must_be_private')
    root_owned(output, private=True)
    schedule_credentials(credentials)
    root_owned(args.s3_config)
    s3 = read_config(args.s3_config)
    require(not any('secret' in key or 'access_key' in key or 'token' in key for key in s3),
            'use_environment_file_for_s3_secrets')
    # Parse-only generation. It never installs a service or starts a backup.
    root.mkdir(mode=0o700)
    private_write(root / 's3.json', json.dumps(s3).encode())
    config = {'application': args.application, 'output_directory': str(output),
              's3_config': str(root / 's3.json'), 'helper_image': args.helper_image, 'credentials_file': str(credentials)}
    private_write(root / 'schedule.json', json.dumps(config).encode())
    name = 'lightmoni-backup-' + args.application
    command = ' '.join(unit_quote(v) for v in ['/usr/bin/python3', '-I', str(Path(__file__).resolve()), 'scheduled-export', '--config', str(root / 'schedule.json')])
    service = '[Unit]\nDescription=LightMoni application backup\nAfter=docker.service network-online.target\n[Service]\nType=oneshot\nUser=root\nUMask=0077\nExecStart=' + command + '\nTimeoutStartSec=2h\nTimeoutStopSec=5min\n'
    timer = '[Unit]\nDescription=LightMoni scheduled application backup\n[Timer]\nOnCalendar=' + args.on_calendar + '\nPersistent=false\nUnit=' + name + '.service\n[Install]\nWantedBy=timers.target\n'
    private_write(root / (name + '.service'), service.encode())
    private_write(root / (name + '.timer'), timer.encode())
    return {'generated': True, 'installed': False, 'directory': str(root), 'timer': name + '.timer'}


def scheduled_export(args):
    import fcntl
    global DOCKER_ENV
    root_owned(Path(__file__).resolve())
    root_owned(args.config, private=True)
    cfg = read_config(args.config, private=True)
    root_owned(cfg['s3_config'], private=True)
    credentials = schedule_credentials(cfg['credentials_file'])
    # No EnvironmentFile or inherited LD_PRELOAD/PYTHONPATH/DOCKER_HOST enters
    # the root child process. Credential files accept only three named values.
    DOCKER_ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C', 'LC_ALL': 'C'}
    for key in ('LIGHTMONI_BACKUP_ACCESS_KEY_ID', 'LIGHTMONI_BACKUP_SECRET_ACCESS_KEY', 'LIGHTMONI_BACKUP_SESSION_TOKEN'):
        os.environ.pop(key, None)
    os.environ.update(credentials)
    output = Path(cfg['output_directory'])
    root_owned(output, private=True)
    require(output.is_dir() and not output.is_symlink() and output.stat().st_mode & 0o077 == 0,
            'backup_output_directory_must_be_private')
    fd = os.open(output / '.backup.lock', os.O_CREAT | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'skipped': True, 'reason': 'previous_backup_running'}
        name = cfg['application'] + '-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8] + '.lmb.tar.gz'
        return export_backup(argparse.Namespace(application=cfg['application'], project=None, execute=True,
            confirm_stop=True, output=str(output / name), helper_image=cfg['helper_image'],
            include_images=False, leave_stopped=False, s3_config=cfg['s3_config']))
    finally:
        os.close(fd)


def upload_s3(path, config):
    u = urllib.parse.urlsplit(config.get('endpoint', ''))
    require(u.scheme == 'https' or u.scheme == 'http' and u.hostname in ('localhost', '127.0.0.1', '::1'), 's3_requires_tls')
    require(u.hostname and not u.username and not u.password and not u.query and not u.fragment and u.path in ('', '/'), 'invalid_s3_endpoint')
    bucket, region, prefix = config.get('bucket', ''), config.get('region', 'us-east-1'), config.get('prefix', 'lightmoni')
    require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket) and re.fullmatch(r'[a-z0-9-]{1,63}', region), 'invalid_s3_bucket_or_region')
    require(isinstance(prefix, str) and not prefix.startswith('/') and '..' not in prefix.split('/'), 'invalid_s3_prefix')
    key = '/'.join([prefix.rstrip('/'), Path(path).name]).lstrip('/')
    access, secret, token = [os.getenv(n, '') for n in ('LIGHTMONI_BACKUP_ACCESS_KEY_ID', 'LIGHTMONI_BACKUP_SECRET_ACCESS_KEY', 'LIGHTMONI_BACKUP_SESSION_TOKEN')]
    require(access and secret, 's3_credentials_missing_from_environment')
    uri = '/' + urllib.parse.quote(bucket + '/' + key, safe='/~')
    expected = digest(path)

    def request(method, body=None):
        now = dt.datetime.now(dt.timezone.utc)
        timestamp, date = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
        payload_hash = expected if body else hashlib.sha256(b'').hexdigest()
        headers = {'host': u.netloc, 'x-amz-date': timestamp, 'x-amz-content-sha256': payload_hash}
        if method == 'PUT':
            headers['if-none-match'] = '*'
        if token:
            headers['x-amz-security-token'] = token
        signed = ';'.join(sorted(headers))
        canonical = '\n'.join([method, uri, '', ''.join(k + ':' + headers[k].strip() + '\n' for k in sorted(headers)), signed, payload_hash])
        scope = date + '/' + region + '/s3/aws4_request'
        signing = ('AWS4' + secret).encode()
        for value in (date, region, 's3', 'aws4_request'):
            signing = hmac.new(signing, value.encode(), hashlib.sha256).digest()
        message = '\n'.join(['AWS4-HMAC-SHA256', timestamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
        signature = hmac.new(signing, message.encode(), hashlib.sha256).hexdigest()
        headers['authorization'] = f'AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={signed}, Signature={signature}'
        if body:
            headers['content-length'] = str(Path(path).stat().st_size)
        conn = (http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection)(u.hostname, u.port, timeout=300)
        try:
            conn.request(method, uri, body=body, headers=headers)
            response = conn.getresponse()
            require(200 <= response.status < 300, 's3_request_failed:' + str(response.status))
            h, size = hashlib.sha256(), 0
            while True:
                data = response.read(1 << 20)
                if not data:
                    break
                size += len(data)
                require(size <= (Path(path).stat().st_size if method == 'GET' else 1 << 20), 's3_response_limit')
                h.update(data)
            return h.hexdigest(), size
        except (OSError, http.client.HTTPException) as error:
            raise BackupError('s3_write_result_unknown' if method == 'PUT' else 's3_readback_failed') from error
        finally:
            conn.close()

    # Single PUT's 5 GiB bound is explicit. Local backups remain streaming/unbounded.
    require(Path(path).stat().st_size <= 5 << 30, 's3_single_put_limit_5gib')
    with open(path, 'rb') as src:
        request('PUT', src)
    actual, size = request('GET')
    require(actual == expected and size == Path(path).stat().st_size, 's3_readback_mismatch')
    return {'verified': True, 'bucket': bucket, 'key': key, 'sha256': expected}


def main(argv=None):
    os.umask(0o077)
    def cancel(_signum, _frame):
        # Allow the finally block time to verify and resume original containers.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if hasattr(signal, 'SIGHUP'):
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
        raise BackupError('backup_cancelled')
    signal.signal(signal.SIGTERM, cancel)
    if hasattr(signal, 'SIGHUP'):
        signal.signal(signal.SIGHUP, cancel)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    export = commands.add_parser('export', help='Preview or export an application / complete two-service deployment')
    select = export.add_mutually_exclusive_group(required=True)
    select.add_argument('--application')
    select.add_argument('--project')
    export.add_argument('--output')
    export.add_argument('--helper-image', default='debian:bookworm-slim')
    export.add_argument('--execute', action='store_true')
    export.add_argument('--confirm-stop', action='store_true')
    export.add_argument('--include-images', action='store_true')
    export.add_argument('--leave-stopped', action='store_true')
    export.add_argument('--s3-config')
    verify = commands.add_parser('verify', help='Verify all bytes without Docker or extracting on the host')
    verify.add_argument('archive')
    restore = commands.add_parser('restore', help='Restore into fresh volumes and leave the deployment stopped')
    restore.add_argument('archive')
    restore.add_argument('--target-project', required=True)
    restore.add_argument('--directory', required=True)
    restore.add_argument('--helper-image', default='debian:bookworm-slim')
    restore.add_argument('--execute', action='store_true')
    restore.add_argument('--confirm-empty-targets', action='store_true')
    cloud = commands.add_parser('upload', help='Upload an already verified backup to S3 and read back its digest')
    cloud.add_argument('archive')
    cloud.add_argument('--s3-config', required=True)
    schedule = commands.add_parser('schedule', help='Generate reviewable systemd service/timer files; does not install them')
    schedule.add_argument('--application', required=True)
    schedule.add_argument('--directory', required=True)
    schedule.add_argument('--output-directory', required=True)
    schedule.add_argument('--credentials-file', required=True)
    schedule.add_argument('--s3-config', required=True)
    schedule.add_argument('--helper-image', default='debian:bookworm-slim')
    schedule.add_argument('--on-calendar', default='daily')
    scheduled = commands.add_parser('scheduled-export', help='Timer entry point with a non-overlapping local lock')
    scheduled.add_argument('--config', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'export':
            result = export_backup(args)
        elif args.command == 'restore':
            result = restore_backup(args)
        elif args.command == 'upload':
            result = verify_backup(args.archive)
            result['cloud'] = upload_s3(args.archive, read_config(args.s3_config))
        elif args.command == 'schedule':
            result = schedule_files(args)
        elif args.command == 'scheduled-export':
            result = scheduled_export(args)
        else:
            result = verify_backup(args.archive)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (BackupError, OSError, ValueError, KeyError, TypeError, tarfile.TarError, subprocess.SubprocessError):
        # Do not print Docker stderr, URLs, env or archive contents.
        error = sys.exc_info()[1]
        code = str(error) if isinstance(error, BackupError) else 'backup_operation_failed'
        print(json.dumps({'verified': False, 'error': code}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
