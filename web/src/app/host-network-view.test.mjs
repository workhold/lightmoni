import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from '../features/dashboards/test-module.mjs';

const { ipAddressCategory, interfaceRole, classifyNetworkAddresses, sshAddressCategory } = loadSource(new URL('./host-network-view.ts', import.meta.url));

test('IPv4 private and shared ranges keep their boundaries separate from public range', () => {
  for (const address of ['10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0', '192.168.255.255']) assert.equal(ipAddressCategory(address), 'private', address);
  for (const address of ['100.64.0.0', '100.127.255.255']) assert.equal(ipAddressCategory(address), 'shared', address);
  for (const address of ['8.8.8.8', '1.1.1.1', '9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '192.167.255.255', '192.169.0.0']) assert.equal(ipAddressCategory(address), 'public', address);
});

test('IPv4 local, documentation, benchmarking, multicast and reserved ranges are never public', () => {
  for (const address of ['127.0.0.1', '127.255.255.255']) assert.equal(ipAddressCategory(address), 'loopback', address);
  for (const address of ['169.254.0.0', '169.254.255.255']) assert.equal(ipAddressCategory(address), 'link_local', address);
  for (const address of ['0.0.0.0', '0.1.2.3', '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.10', '203.0.113.10', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255']) assert.equal(ipAddressCategory(address), 'special', address);
});

test('dual-stack private, link-local and ordinary global unicast are classified without scope labels', () => {
  for (const address of ['fc00::1', 'fdff:ffff::1']) assert.equal(ipAddressCategory(address), 'private', address);
  for (const address of ['fe80::1', 'febf:ffff::1', 'fe80::1%eth0']) assert.equal(ipAddressCategory(address), 'link_local', address);
  for (const address of ['::1', '0:0:0:0:0:0:0:1']) assert.equal(ipAddressCategory(address), 'loopback', address);
  for (const address of ['2001:4860:4860::8888', '2606:4700:4700::1111', '2001:4860:0:0:0:0:0:8888', '2a00:1450::1']) assert.equal(ipAddressCategory(address), 'public', address);
});

test('IPv6 special allocations, transitional addresses and documentation remain conservative', () => {
  for (const address of ['::', '::8.8.8.8', '100::1', '64:ff9b::808:808', '64:ff9b:1::1', '2001::1', '2001:2::1', '2001:10::1', '2001:20::1', '2001:db8::1', '2002:0808:0808::1', '3ffe::1', '3fff::1', '3fff:fff::1', 'fec0::1', 'ff02::1', '4000::1']) assert.equal(ipAddressCategory(address), 'special', address);
  assert.equal(ipAddressCategory('3fff:1000::1'), 'public');
});

test('IPv4 mapped IPv6 inherits IPv4 categories in compressed, expanded and dotted forms', () => {
  const cases = [['::ffff:172.18.0.1', 'private'], ['0:0:0:0:0:ffff:ac12:1', 'private'], ['::FFFF:0808:0808', 'public'], ['::ffff:100.64.0.1', 'shared'], ['::ffff:127.0.0.1', 'loopback'], ['::ffff:169.254.1.1', 'link_local'], ['::ffff:203.0.113.10', 'special']];
  for (const [address, expected] of cases) assert.equal(ipAddressCategory(address), expected, address);
});

test('malformed literals, shortened IPv4, leading zeros and ports never become public', () => {
  for (const address of ['', 'example.test', '127.1', '2130706433', '0x7f000001', '010.0.0.1', '1.2.3.04', '256.1.1.1', '1.2.3.4.5', '1.2.3.-1', '1.2.3.4:22', '2001::db8::1', '2001:4860:0:0:0:0:8888', '12345::1', '::ffff:1.2.3.999', '::ffff:010.0.0.1', '[2001:4860::1]:22', 'fe80::1%', 'fe80::1%eth0%eth1']) assert.equal(ipAddressCategory(address), 'invalid', address);
  assert.equal(ipAddressCategory(' 10.0.0.1 '), 'private');
});

test('only explicit container and VM naming patterns fold their addresses', () => {
  for (const name of ['docker0', 'docker_gwbridge', 'br-12ab34cd56ef', 'vethab12cd3', 'vethab12cd3@if8', 'cni0', 'flannel.1', 'cali12ab34cd56e', 'virbr0', 'vnet3', 'vmnet8']) assert.equal(interfaceRole(name), 'container', name);
  for (const name of ['', 'eth0', 'enp1s0', 'enp1s0.10', 'ens5', 'br0', 'br1', 'br-lan', 'br-prod', 'br-1234', 'bond0', 'team0', 'eth0.100', 'vlan100', 'mydocker0', 'dockerprod', 'vethnic', 'cni-prod', 'california']) assert.equal(interfaceRole(name), 'ordinary', name);
});

test('VPN and tunnel naming patterns remain visible in a separate address group', () => {
  for (const name of ['wg0', 'wg-home', 'tun0', 'tap2', 'utun3', 'tailscale0', 'ztabc123456']) assert.equal(interfaceRole(name), 'tunnel', name);
  for (const name of ['tuna0', 'tunnel-prod', 'taproom', 'wgi0', 'mytailscale0']) assert.equal(interfaceRole(name), 'ordinary', name);
});

const entry = (name, address, scope = 'public') => ({ interface: name, address, family: address.includes(':') ? 'IPv6' : 'IPv4', scope });

test('screenshot network prioritizes eth0 and folds Docker bridges without treating its private peer as public', () => {
  const real = entry('eth0', '10.41.0.2');
  const bridges = [entry('docker0', '172.18.0.1', 'private'), ...['19', '20', '21', '22', '23'].map((suffix, index) => entry(`br-1234567890a${index}`, `172.${suffix}.0.1`, 'private'))];
  const raw = [...bridges, real];
  const grouped = classifyNetworkAddresses(raw);
  assert.deepEqual(grouped.privateAddresses, [real]);
  assert.deepEqual(grouped.publicAddresses, []);
  assert.deepEqual(grouped.otherAddresses, bridges);
  assert.equal(ipAddressCategory('172.24.0.1'), 'private');
  assert.deepEqual(raw, [...bridges, real]);
  assert.strictEqual(grouped.privateAddresses[0], real);
});

test('classification preserves unknown bridges, shared ranges, dual-stack, tunnel and every raw fact', () => {
  const ordinary = [entry('br0', '172.18.0.1', 'public'), entry('bond0', '100.64.0.2'), entry('eth0.100', 'fd00::2')];
  const external = [entry('eth0', '8.8.8.8', 'private'), entry('ens5', '2606:4700::1111', 'private')];
  const tunnel = [entry('wg0', '10.10.0.1'), entry('tailscale0', '100.100.1.2')];
  const other = [entry('lo', '127.0.0.1'), entry('eth0', '169.254.1.1'), entry('eth0', '2001:db8::1'), entry('eth0', 'bad'), entry('vethabcdef', '8.8.4.4'), entry('utun2', 'fe80::1', 'link_local')];
  const raw = [...ordinary, ...external, ...tunnel, ...other], before = JSON.stringify(raw);
  const grouped = classifyNetworkAddresses(raw);
  assert.deepEqual(grouped, { privateAddresses: ordinary, publicAddresses: external, tunnelAddresses: tunnel, otherAddresses: other });
  assert.equal(Object.values(grouped).flat().length, raw.length);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(classifyNetworkAddresses([]), { privateAddresses: [], publicAddresses: [], tunnelAddresses: [], otherAddresses: [] });
});

test('a tunnel naming hint cannot promote local, reserved or malformed addresses into the summary', () => {
  const other = ['::1', 'fe80::1', '2001:db8::1', '203.0.113.1', 'bad'].map(address => entry('wg0', address));
  assert.deepEqual(classifyNetworkAddresses(other), { privateAddresses: [], publicAddresses: [], tunnelAddresses: [], otherAddresses: other });
});

test('SSH address classification keeps administrator targets distinct from DNS or observed reachability', () => {
  const cases = [['', 'unconfigured'], ['  ', 'unconfigured'], ['vchive', 'hostname'], ['ssh.example.test', 'hostname'], ['SSH.EXAMPLE.TEST.', 'hostname'], ['10.0.0.2', 'private'], ['100.64.0.1', 'shared'], ['8.8.8.8', 'public'], ['[2606:4700::1111]', 'public'], ['[fe80::1%eth0]', 'link_local'], ['::ffff:172.18.0.1', 'private']];
  for (const [address, expected] of cases) assert.equal(sshAddressCategory(address), expected, address);
  for (const address of ['256.0.0.1', '127.1', '0x7f000001', '010.0.0.1', '[8.8.8.8]', '1.2.3.4:22', '[::1]:22', 'ssh.example.test:22', 'https://ssh.example.test', 'root@host', '-bad-host', 'bad..host', 'bad host']) assert.equal(sshAddressCategory(address), 'invalid', address);
});
