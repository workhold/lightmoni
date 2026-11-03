#!/usr/bin/env python3
"""Exercise the generated single-store Registry template via real OCI HTTP and restart."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def main():
    spec = json.loads(subprocess.check_output([
        'node', '--import', 'tsx', '--input-type=module', '-e',
        "import {registryTemplateSpec} from './src/ops/registry-runtime.ts';console.log(JSON.stringify(registryTemplateSpec()))",
    ], cwd=ROOT / 'runtime', text=True))
    assert list(spec['compose']['services']) == ['registry'] and len(spec['mounts']) == 1
    assert len(spec['ports']) == 1 and spec['ports'][0]['container_port'] == 5000
    service = spec['compose']['services']['registry']
    name = 'lightmoni-sdd091-registry-' + uuid.uuid4().hex[:10]
    cache = ROOT / '.lightmoni'
    cache.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='registry-091-', dir=cache) as data:
        def start():
            args = ['docker', 'run', '--detach', '--name', name, '-p', '127.0.0.1::5000', '-v', data + ':/var/lib/registry']
            for key, value in service['environment'].items():
                args += ['-e', key + '=' + value]
            command(*args, service['image'])
            port = command('docker', 'port', name, '5000/tcp').split(':')[-1]
            base = 'http://127.0.0.1:' + port
            for attempt in range(100):
                try:
                    urllib.request.urlopen(base + '/v2/', timeout=1).close()
                    return base
                except OSError:
                    time.sleep(.1)
            raise AssertionError('Registry did not become ready')

        def request(base, path, method='GET', data=None, media=None):
            headers = {'Accept': 'application/vnd.oci.image.manifest.v1+json'}
            if media:
                headers['Content-Type'] = media
            with urllib.request.urlopen(urllib.request.Request(base + path, data=data, method=method, headers=headers), timeout=5) as response:
                return response.status, response.headers, response.read()

        try:
            base = start()
            config = b'{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}'
            digest = 'sha256:' + hashlib.sha256(config).hexdigest()
            status, headers, _ = request(base, '/v2/acceptance/image/blobs/uploads/', 'POST', b'')
            assert status == 202
            location = headers['Location']
            if location.startswith(base):
                location = location[len(base):]
            request(base, location + ('&' if '?' in location else '?') + 'digest=' + digest, 'PUT', config, 'application/octet-stream')
            media = 'application/vnd.oci.image.manifest.v1+json'
            manifest = json.dumps({'schemaVersion': 2, 'mediaType': media, 'config': {'mediaType': 'application/vnd.oci.image.config.v1+json', 'digest': digest, 'size': len(config)}, 'layers': []}).encode()
            assert request(base, '/v2/acceptance/image/manifests/reused', 'PUT', manifest, media)[0] == 201
            assert request(base, '/v2/acceptance/image/blobs/' + digest)[2] == config
            assert request(base, '/v2/acceptance/image/manifests/reused')[2] == manifest
            command('docker', 'rm', '--force', name)
            base = start()
            assert request(base, '/v2/acceptance/image/blobs/' + digest)[2] == config
            assert request(base, '/v2/acceptance/image/manifests/reused')[2] == manifest
            print(json.dumps({'single_service': True, 'single_store': True, 'container_port': 5000, 'oci_push': True, 'oci_pull': True, 'restart_preserves_data': True}))
        finally:
            subprocess.run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


if __name__ == '__main__':
    main()
