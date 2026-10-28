"""Machine declarations are process configuration, not credentials."""
import json
import os
import unittest
from unittest import mock
from lightmoni import Client
from test_reporting import Receiver, attributes


class MachineIdentityTests(unittest.TestCase):
    def setUp(self):
        proxy_environment = mock.patch.dict(os.environ, {
            'http_proxy': '', 'https_proxy': '', 'all_proxy': '',
            'HTTP_PROXY': '', 'HTTPS_PROXY': '', 'ALL_PROXY': '',
            'no_proxy': '*', 'NO_PROXY': '*',
        })
        proxy_environment.start()
        self.addCleanup(proxy_environment.stop)

    def capture(self, resource=None):
        receiver = Receiver()
        try:
            client = Client('identity-test', 'business', endpoint=receiver.url, key='',
                            instance_id='instance-1', resource=resource,
                            self_telemetry=False, remote_config=False)
            client.counter('requests').add(1)
            client.log('info', 'hello')
            with client.start_span('work'):
                pass
            client.shutdown()
            resources = []
            for request in receiver.observed('POST'):
                payload = json.loads(request['body'])
                resources.extend(attributes(group['resource']) for groups in payload.values() for group in groups)
            self.assertEqual(len(resources), 3)
            return resources
        finally:
            receiver.close()

    def test_environment_reaches_all_otlp_signals_and_preserves_host_identity(self):
        with mock.patch.dict(os.environ, {'LIGHTMONI_MACHINE_ID': 'machine-1', 'LIGHTMONI_MACHINE_NAME': '生产 主机'}):
            for resource in self.capture({'host.id': 'agent-host'}):
                self.assertEqual(resource['lightmoni.machine.id'], 'machine-1')
                self.assertEqual(resource['lightmoni.machine.name'], '生产 主机')
                self.assertEqual(resource['host.id'], 'agent-host')
                self.assertEqual(resource['service.name'], 'identity-test')
                self.assertEqual(resource['service.instance.id'], 'instance-1')

    def test_explicit_resource_wins_without_mutating_input(self):
        explicit = {'lightmoni.machine.id': 'explicit', 'lightmoni.machine.name': 'custom'}
        with mock.patch.dict(os.environ, {'LIGHTMONI_MACHINE_ID': 'environment', 'LIGHTMONI_MACHINE_NAME': '环境'}):
            for resource in self.capture(explicit):
                self.assertEqual(resource['lightmoni.machine.id'], 'explicit')
                self.assertEqual(resource['lightmoni.machine.name'], 'custom')
        self.assertEqual(explicit, {'lightmoni.machine.id': 'explicit', 'lightmoni.machine.name': 'custom'})

    def test_missing_invalid_and_utf8_boundaries(self):
        for machine_id, name, valid in [(None, None, False), ('', '   ', False),
                ('a' * 65, '界' * 43, False), ('bad\nvalue', 'bad\u0085value', False),
                ('界' * 21 + 'a', '界' * 42 + 'ab', True)]:
            with self.subTest(valid=valid, byte_length=len((machine_id or '').encode())):
                with mock.patch.dict(os.environ, {'LIGHTMONI_MACHINE_ID': machine_id or '', 'LIGHTMONI_MACHINE_NAME': name or ''}):
                    if machine_id is None:
                        os.environ.pop('LIGHTMONI_MACHINE_ID', None)
                        os.environ.pop('LIGHTMONI_MACHINE_NAME', None)
                    for resource in self.capture():
                        self.assertEqual('lightmoni.machine.id' in resource, valid)
                        self.assertEqual('lightmoni.machine.name' in resource, valid)
