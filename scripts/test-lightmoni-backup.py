import argparse
import hashlib
import hmac
import importlib.util
import io
import json
import os
import signal
from pathlib import Path
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('lightmoni-backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def tar_bytes(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as archive:
        for name, content, kind, target in entries:
            info = tarfile.TarInfo(name)
            info.uid, info.gid, info.mode = 1234, 2345, 0o640
            info.type, info.linkname = kind, target
            if kind == tarfile.REGTYPE:
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            else:
                archive.addfile(info)
    return out.getvalue()


class ArchiveTests(unittest.TestCase):
    def test_image_identity_accepts_classic_manifest_and_oci_index_and_rejects_tampering(self):
        config = b'{"architecture":"arm64","os":"linux"}'
        config_id = 'sha256:' + hashlib.sha256(config).hexdigest()
        image_manifest = json.dumps({'schemaVersion':2, 'config':{'digest':config_id}}).encode()
        manifest_id = 'sha256:' + hashlib.sha256(image_manifest).hexdigest()
        index = json.dumps({'schemaVersion':2, 'manifests':[{'digest':manifest_id}, {'digest':'sha256:'+'f'*64}]}).encode()
        index_id = 'sha256:' + hashlib.sha256(index).hexdigest()
        blobs = [('blobs/sha256/'+config_id[7:],config), ('blobs/sha256/'+manifest_id[7:],image_manifest),
                 ('blobs/sha256/'+index_id[7:],index)]
        def content(tags=None, corrupt=False):
            values = [('manifest.json',json.dumps([{'Config':blobs[0][0],'RepoTags':tags,'Layers':[]}]).encode())] + blobs
            if corrupt:
                values[-1] = (values[-1][0], b'{}')
            return tar_bytes([(name,data,tarfile.REGTYPE,'') for name,data in values])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'images.tar'
            path.write_bytes(content())
            for image in (config_id,manifest_id,index_id):
                info = {} if image == config_id else {'Descriptor':{'digest':image}}
                backup.validate_image_archive(path,{image:info})
            path.write_bytes(content(tags=['existing:tag']))
            with self.assertRaisesRegex(backup.BackupError,'overwrite_tags'):
                backup.validate_image_archive(path,{index_id:{'Descriptor':{'digest':index_id}}})
            path.write_bytes(content(corrupt=True))
            with self.assertRaisesRegex(backup.BackupError,'checksum_mismatch'):
                backup.validate_image_archive(path,{index_id:{'Descriptor':{'digest':index_id}}})

    def test_partial_stop_failure_resumes_only_original_unchanged_containers(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = {cid: {'Id': cid, 'Config': {}, 'HostConfig': {}, 'Mounts': [], 'State': {'Running': True}} for cid in ('one', 'two')}
            originals = json.loads(json.dumps(list(rows.values())))
            calls = []
            def fake_docker(*args, **_):
                calls.append(args)
                if args[0] == 'ps':
                    return ''
                if args[0] == 'stop':
                    rows['one']['State']['Running'] = False
                    raise backup.BackupError('partial_stop_failed')
                if args[0] == 'start':
                    self.assertEqual(args[1:], ('one',))
                    rows['one']['State']['Running'] = True
                    return ''
                self.fail('unexpected Docker mutation')
            args = argparse.Namespace(application='a' * 32, project=None, execute=True, confirm_stop=True,
                output=str(Path(tmp) / 'out.tar.gz'), helper_image='helper', include_images=False, leave_stopped=False, s3_config=None)
            with patch.object(backup, 'discover', return_value=(originals, [{'type':'bind','source':'/var/lib/isolated-backup-test'}])), \
                 patch.object(backup, 'image_info', return_value={'Id':'helper'}), patch.object(backup, 'docker', side_effect=fake_docker), \
                 patch.object(backup, 'current', side_effect=lambda ids: {cid: rows[cid] for cid in ids}):
                with self.assertRaisesRegex(backup.BackupError, 'partial_stop'):
                    backup.export_backup(args)
            self.assertTrue(all(c['State']['Running'] for c in rows.values()))
            self.assertFalse(Path(args.output).exists())

    def test_output_overlap_rejected_before_any_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = argparse.Namespace(application='a' * 32, project=None, execute=True, confirm_stop=True,
                output=str(Path(tmp) / 'out.tar.gz'), helper_image='helper', include_images=False, leave_stopped=False, s3_config=None)
            with patch.object(backup, 'discover', return_value=([], [{'type':'bind','source':tmp}])), patch.object(backup, 'docker') as docker:
                with self.assertRaisesRegex(backup.BackupError, 'overlaps'):
                    backup.export_backup(args)
                docker.assert_not_called()

    def test_sigterm_cancellation_runs_the_source_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            row = {'Id':'one','Config':{},'HostConfig':{},'Mounts':[], 'State':{'Running':True,'ExitCode':0}}
            original = json.loads(json.dumps(row))
            def fake_docker(*args, **_):
                if args[0] == 'ps':
                    return ''
                if args[0] == 'stop':
                    row['State']['Running'] = False
                if args[0] == 'start':
                    row['State']['Running'] = True
                return ''
            previous = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGHUP)}
            try:
                with patch.object(backup, 'discover', return_value=([original], [{'type':'bind','source':'/var/lib/isolated-backup-test','slot':'0'}])), \
                     patch.object(backup, 'image_info', return_value={'Id':'helper'}), patch.object(backup, 'docker', side_effect=fake_docker), \
                     patch.object(backup, 'current', return_value={'one':row}), patch.object(backup, 'frozen'), \
                     patch.object(backup, 'helper', side_effect=lambda *_a, **_k: signal.raise_signal(signal.SIGTERM)), patch('sys.stderr', new_callable=io.StringIO):
                    self.assertEqual(backup.main(['export','--application','a'*32,'--output',str(Path(tmp)/'out.tar.gz'),'--execute','--confirm-stop']),1)
                self.assertTrue(row['State']['Running'])
                self.assertFalse((Path(tmp) / 'out.tar.gz').exists())
            finally:
                for s, handler in previous.items():
                    signal.signal(s, handler)

    def test_paths_links_devices_and_headers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'data.tar'
            path.write_bytes(tar_bytes([('./file', b'hello', tarfile.REGTYPE, ''), ('link', b'', tarfile.SYMTYPE, 'file')]))
            self.assertEqual(backup.validate_tar(path), 2)
            value = backup.tree_digest(path)
            self.assertEqual(value, backup.tree_digest(path))
            for name, kind, target in [('../escape', tarfile.REGTYPE, ''), ('/absolute', tarfile.REGTYPE, ''),
                                       ('link', tarfile.SYMTYPE, '../escape'), ('link', tarfile.LNKTYPE, '/etc/passwd'),
                                       ('device', tarfile.CHRTYPE, '')]:
                path.write_bytes(tar_bytes([(name, b'hello', kind, target)]))
                with self.assertRaises(backup.BackupError):
                    backup.validate_tar(path)

    def test_ownership_affects_tree_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'a.tar'
            p.write_bytes(tar_bytes([('a', b'hello', tarfile.REGTYPE, '')]))
            initial = backup.tree_digest(p)
            content = io.BytesIO()
            with tarfile.open(fileobj=content, mode='w') as out:
                info = tarfile.TarInfo('a')
                info.uid, info.gid, info.mode, info.size = 1234, 2345, 0o600, 5
                out.addfile(info, io.BytesIO(b'hello'))
            p.write_bytes(content.getvalue())
            self.assertNotEqual(initial, backup.tree_digest(p))

    @unittest.skipUnless(os.geteuid() == 0, 'root schedule generation tested in isolated Linux container')
    def test_schedule_generation_is_private_and_never_installs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / 'archives'
            output.mkdir(mode=0o700)
            creds = root / 'credentials'
            creds.write_text('LIGHTMONI_BACKUP_ACCESS_KEY_ID=fixture\nLIGHTMONI_BACKUP_SECRET_ACCESS_KEY=not-printed\n')
            creds.chmod(0o600)
            s3 = root / 's3.json'
            s3.write_text(json.dumps({'endpoint': 'https://s3.example.test', 'bucket': 'backup-test'}))
            args = argparse.Namespace(application='a' * 32, directory=str(root / 'timer'),
                output_directory=str(output), credentials_file=str(creds), s3_config=str(s3),
                helper_image='helper@sha256:' + 'b' * 64, on_calendar='daily')
            result = backup.schedule_files(args)
            self.assertFalse(result['installed'])
            self.assertTrue(result['generated'])
            files = list((root / 'timer').iterdir())
            self.assertEqual(len(files), 4)
            self.assertTrue(all(p.stat().st_mode & 0o077 == 0 for p in files))
            self.assertFalse(any('not-printed' in p.read_text() for p in files))
            self.assertIn('Persistent=false', (root / 'timer' / ('lightmoni-backup-' + 'a' * 32 + '.timer')).read_text())
            args.on_calendar = 'daily\nExecStart=/evil'
            with self.assertRaises(backup.BackupError):
                backup.schedule_files(args)

    def test_outer_archive_refuses_checksum_changes_and_missing_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = tar_bytes([('a', b'hello', tarfile.REGTYPE, '')])
            (root / 'data.tar').write_bytes(data)
            files = {'compose.json': {'sha256': hashlib.sha256(b'{}').hexdigest(), 'size': 2},
                     'data/0.tar': {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'tree_sha256': backup.tree_digest(root / 'data.tar')}}
            manifest = {'format': 'lightmoni.offline-backup', 'version': 1, 'kind': 'application',
                        'consistency': 'stopped', 'mounts': [{'slot': '0'}], 'files': files}
            archive = root / 'a.tar.gz'
            def write(compose=b'{}', include_data=True):
                with tarfile.open(archive, 'w:gz') as out:
                    for name, value in [('manifest.json', json.dumps(manifest).encode()), ('compose.json', compose), *([('data/0.tar', data)] if include_data else [])]:
                        info = tarfile.TarInfo(name)
                        info.size = len(value)
                        out.addfile(info, io.BytesIO(value))
            write()
            self.assertTrue(backup.verify_backup(archive)['verified'])
            write(b'[]')
            with self.assertRaisesRegex(backup.BackupError, 'checksum'):
                backup.verify_backup(archive)
            write(include_data=False)
            with self.assertRaisesRegex(backup.BackupError, 'incomplete'):
                backup.verify_backup(archive)


class S3Tests(unittest.TestCase):
    def test_actual_http_signature_streaming_readback_and_no_overwrite(self):
        stored = {}
        errors = []
        secret, access = 'fixture-secret-key', 'fixture-access'
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def handle_request(self):
                auth = self.headers.get('Authorization', '')
                try:
                    parts = dict(p.strip().split('=', 1) for p in auth.removeprefix('AWS4-HMAC-SHA256 ').split(','))
                    key, scope = parts['Credential'].split('/', 1)
                    selftest.assertEqual(key, access)
                    signed = parts['SignedHeaders']
                    canonical = '\n'.join([self.command, self.path, '', ''.join(k + ':' + self.headers[k].strip() + '\n' for k in signed.split(';')), signed, self.headers['x-amz-content-sha256']])
                    date, region, service, term = scope.split('/')
                    signature_key = ('AWS4' + secret).encode()
                    for part in (date, region, service, term):
                        signature_key = hmac.new(signature_key, part.encode(), hashlib.sha256).digest()
                    to_sign = '\n'.join(['AWS4-HMAC-SHA256', self.headers['x-amz-date'], scope, hashlib.sha256(canonical.encode()).hexdigest()])
                    selftest.assertEqual(parts['Signature'], hmac.new(signature_key, to_sign.encode(), hashlib.sha256).hexdigest())
                    if self.command == 'PUT':
                        selftest.assertEqual(self.headers['If-None-Match'], '*')
                        content = self.rfile.read(int(self.headers['Content-Length']))
                        if self.path in stored:
                            self.send_response(412)
                            self.end_headers()
                            return
                        selftest.assertEqual(hashlib.sha256(content).hexdigest(), self.headers['x-amz-content-sha256'])
                        stored[self.path] = content
                        body = b''
                    else:
                        body = stored[self.path]
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except Exception as error:
                    errors.append(type(error).__name__)
                    self.send_response(403)
                    self.end_headers()
            do_PUT = handle_request
            do_GET = handle_request
        selftest = self
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'LIGHTMONI_BACKUP_ACCESS_KEY_ID': access, 'LIGHTMONI_BACKUP_SECRET_ACCESS_KEY': secret}):
                path = Path(tmp) / 'private archive.tar.gz'
                path.write_bytes(os.urandom(2 << 20))
                cfg = {'endpoint': 'http://127.0.0.1:' + str(server.server_port), 'bucket': 'test-backups', 'prefix': 'daily'}
                result = backup.upload_s3(path, cfg)
                self.assertTrue(result['verified'])
                self.assertEqual(result['sha256'], backup.digest(path))
                with self.assertRaisesRegex(backup.BackupError, '412'):
                    backup.upload_s3(path, cfg)
                self.assertFalse(errors)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


@unittest.skipUnless(os.getenv('LIGHTMONI_BACKUP_DOCKER_LIVE') == '1', 'requires isolated disposable Docker resources')
class DockerTests(unittest.TestCase):
    def test_two_container_export_restore_ownership_and_no_source_mutation(self):
        image = os.environ['LIGHTMONI_BACKUP_HELPER_IMAGE']
        key = 'lm-backup-test-' + uuid.uuid4().hex[:12]
        application = uuid.uuid4().hex
        containers, volumes = [], []
        with tempfile.TemporaryDirectory() as tmp:
            try:
                for index in range(2):
                    volume = key + '-' + str(index)
                    backup.docker('volume', 'create', volume)
                    volumes.append(volume)
                    backup.docker('run', '--rm', '--user', '0:0', '--mount', 'type=volume,src=' + volume + ',dst=/source',
                        '--entrypoint', '/bin/sh', image, '-c', 'printf archive-data > /source/file; chown 1234:2345 /source/file; chmod 640 /source/file; ln -s file /source/link')
                    if index == 0:
                        backup.docker('run', '--rm', '--user', '0:0', '--mount', 'type=volume,src=' + volume + ',dst=/source',
                            '--entrypoint', '/bin/sh', image, '-c', 'truncate -s 270M /source/large')
                    container = backup.docker('run', '-d', '--name', key + '-' + str(index), '--label', backup.APP + '=' + application,
                        '--label', backup.OWNER + '=lightmoni', '--label', backup.SERVICE + '=service' + str(index),
                        '--env', 'TEST_LITERAL=p$TOKEN-value', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                        '--mount', 'type=volume,src=' + volume + ',dst=/data', '--entrypoint', '/bin/sh', image, '-c', 'trap "exit 0" TERM; while :; do sleep 1 & wait $!; done').strip()
                    containers.append(container)
                args = argparse.Namespace(application=application, project=None, execute=False, confirm_stop=False,
                    output=str(Path(tmp) / 'application.lmb.tar.gz'), helper_image=image, include_images=False, leave_stopped=False, s3_config=None)
                preview = backup.export_backup(args)
                self.assertEqual(preview['persistent_sources'], 2)
                self.assertTrue(all(c['State']['Running'] for c in backup.inspect(containers)))
                args.execute, args.confirm_stop = True, True
                result = backup.export_backup(args)
                self.assertTrue(result['verified'])
                self.assertEqual(Path(args.output).stat().st_mode & 0o777, 0o600)
                self.assertTrue(all(c['State']['Running'] for c in backup.inspect(containers)))
                target = key + '-restored'
                restore = argparse.Namespace(archive=args.output, execute=True, confirm_empty_targets=True,
                    target_project=target, directory=str(Path(tmp) / 'restored'), helper_image=image)
                restored = backup.restore_backup(restore)
                volumes.extend(restored['volume_names'])
                self.assertTrue(restored['verified'])
                self.assertFalse(restored['started'])
                effective = json.loads(backup.docker('compose', '-p', target, '-f', str(Path(restore.directory) / 'compose.json'), 'config', '--format', 'json'))
                # Compose normalizes Env into a mapping but preserves literal dollars.
                self.assertTrue(all(s['environment']['TEST_LITERAL'] == 'p$$TOKEN-value' for s in effective['services'].values()))
                self.assertTrue(all(s['cap_drop'] == ['ALL'] for s in effective['services'].values()))
                # A second restore is refused before replacing the original volumes.
                with self.assertRaises(backup.BackupError):
                    backup.restore_backup(restore)
                self.assertTrue(all(c['State']['Running'] for c in backup.inspect(containers)))
            finally:
                if containers:
                    backup.docker('rm', '-f', *containers)
                if volumes:
                    backup.docker('volume', 'rm', *volumes)
                leftovers = backup.docker('volume', 'ls', '--filter', 'label=io.lightmoni.backup.project=' + key + '-restored', '--format', '{{.Name}}').split()
                if leftovers:
                    backup.docker('volume', 'rm', *leftovers)


@unittest.skipUnless(os.getenv('LIGHTMONI_BACKUP_MIGRATION_LIVE') == '1', 'requires isolated center and ClickHouse projects')
class MigrationTests(unittest.TestCase):
    def test_center_and_clickhouse_migration_retains_login_key_and_history(self):
        image = os.environ['LIGHTMONI_BACKUP_HELPER_IMAGE']
        source = 'lm-migration-test-' + uuid.uuid4().hex[:10]
        target = source + '-target'
        password = uuid.uuid4().hex
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = {'services': {
                'lightmoni': {'image': image, 'ports': ['127.0.0.1::8080'], 'volumes': ['state:/data'],
                    'environment': {'LIGHTMONI_ADDR': ':8080', 'LIGHTMONI_DATA': '/data/state', 'LIGHTMONI_EXTERNAL_URL': 'http://127.0.0.1',
                                    'LIGHTMONI_CH_URL': 'http://clickhouse:8123', 'LIGHTMONI_CH_USER':'qa','LIGHTMONI_CH_PASSWORD':password},
                    'stop_grace_period':'60s'},
                'clickhouse': {'image':'clickhouse/clickhouse-server:26.8','volumes':['telemetry:/var/lib/clickhouse'],
                    'environment': {'CLICKHOUSE_USER':'qa','CLICKHOUSE_PASSWORD':password,'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT':'1'},
                    'stop_grace_period':'60s'}}, 'volumes':{'state':{},'telemetry':{}}}
            compose = root / 'source.json'
            backup.private_write(compose, json.dumps(config).encode())
            restored_config = root / 'target' / 'compose.json'
            target_volumes = []
            def compose_call(project, file, *args):
                return backup.docker('compose','-p',project,'-f',str(file),*args)
            def wait_center(project, file):
                cid = compose_call(project,file,'ps','-q','lightmoni').strip()
                port = backup.inspect([cid])[0]['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort']
                url = 'http://127.0.0.1:' + port
                end = time.monotonic() + 90
                while time.monotonic() < end:
                    try:
                        if urllib.request.urlopen(url+'/healthz',timeout=2).status == 200:
                            return cid,url
                    except Exception:
                        time.sleep(.5)
                self.fail('isolated center did not become healthy')
            def api(url,path,body):
                request=urllib.request.Request(url+'/api/v1'+path,data=json.dumps(body).encode(),headers={'content-type':'application/json','origin':'http://127.0.0.1'})
                with urllib.request.urlopen(request,timeout=10) as response:
                    self.assertIn(response.status,(200,201))
                    return json.load(response)
            def ch(project,file,sql):
                cid=compose_call(project,file,'ps','-q','clickhouse').strip()
                return backup.docker('exec','--user','0',cid,'/bin/sh','-c',
                    'umask 077; printf "<config><user>%s</user><password>%s</password></config>" "$CLICKHOUSE_USER" "$CLICKHOUSE_PASSWORD" > /tmp/qa-client.xml; clickhouse-client --config-file /tmp/qa-client.xml --query "$1"; result=$?; rm -f /tmp/qa-client.xml; exit "$result"', 'qa',sql)
            try:
                compose_call(source,compose,'up','-d')
                cid,url=wait_center(source,compose)
                api(url,'/setup',{'name':'migration-admin','password':password})
                self.assertEqual(api(url,'/auth/login',{'name':'migration-admin','password':password})['name'],'migration-admin')
                ch(source,compose,'CREATE TABLE default.backup_migration_probe (value UInt64) ENGINE=MergeTree ORDER BY value')
                ch(source,compose,'INSERT INTO default.backup_migration_probe VALUES (117)')
                probe="import fs from 'node:fs';import {cipher} from '/opt/lightmoni/runtime/dist/shared/crypto.js';const c=cipher(fs.readFileSync('/data/state/master.key'));fs.writeFileSync('/data/state/migration-probe',c.encrypt('migration-probe-117'),{mode:0o600});console.log('verified');"
                self.assertEqual(backup.docker('exec',cid,'node','--input-type=module','-e',probe).strip(),'verified')
                args=argparse.Namespace(application=None,project=source,execute=True,confirm_stop=True,
                    output=str(root/'deployment.lmb.tar.gz'),helper_image=image,include_images=False,leave_stopped=False,s3_config=None)
                exported=backup.export_backup(args)
                self.assertTrue(exported['verified'])
                self.assertTrue(exported['source_left_stopped'])
                self.assertFalse(any(c['State']['Running'] for c in backup.inspect(compose_call(source,compose,'ps','-aq').split())))
                restored=backup.restore_backup(argparse.Namespace(archive=args.output,execute=True,confirm_empty_targets=True,
                    target_project=target,directory=str(root/'target'),helper_image=image))
                target_volumes=restored['volume_names']
                self.assertFalse(restored['started'])
                # Starting is an explicit validation action, separate from the restore tool.
                compose_call(target,restored_config,'up','-d')
                new_cid,new_url=wait_center(target,restored_config)
                self.assertEqual(api(new_url,'/auth/login',{'name':'migration-admin','password':password})['name'],'migration-admin')
                probe="import fs from 'node:fs';import {cipher} from '/opt/lightmoni/runtime/dist/shared/crypto.js';const c=cipher(fs.readFileSync('/data/state/master.key'));if(c.decrypt(fs.readFileSync('/data/state/migration-probe','utf8'))!=='migration-probe-117')process.exit(1);console.log('verified');"
                self.assertEqual(backup.docker('exec',new_cid,'node','--input-type=module','-e',probe).strip(),'verified')
                self.assertEqual(ch(target,restored_config,'SELECT value FROM default.backup_migration_probe').strip(),'117')
                quick="import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/data/state/lightmoni.db');console.log(db.prepare('PRAGMA quick_check').get().quick_check);"
                self.assertEqual(backup.docker('exec',new_cid,'node','--input-type=module','-e',quick).strip(),'ok')
            finally:
                if restored_config.exists():
                    compose_call(target,restored_config,'down','--remove-orphans')
                compose_call(source,compose,'down','--volumes','--remove-orphans')
                leftovers=backup.docker('volume','ls','--filter','label=io.lightmoni.backup.project='+target,'--format','{{.Name}}').split()
                if leftovers:
                    backup.docker('volume','rm',*leftovers)


if __name__ == '__main__':
    unittest.main()
