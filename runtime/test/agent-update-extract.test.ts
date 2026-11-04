import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gzipSync, createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const { AgentMaintenance } = await import(pathToFileURL(resolve(import.meta.dirname, '../../deploy/agent/update-runner.mjs')).href);

type Member = { name: string; body?: Buffer | string; type?: string; link?: string; mode?: number };
function member({ name, body = '', type = '0', link = '', mode = 0o644 }: Member) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body), header = Buffer.alloc(512);
  header.write(name, 0, 100); header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
  header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.fill(32, 148, 156); header.write(type, 156, 1); header.write(link, 157, 100);
  header.write('ustar\0', 257, 6);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const required = (): Member[] => [
  { name: 'lightmoni-agent', body: '#!/bin/sh\n', mode: 0o755 },
  { name: 'lightmoni-agent.service', body: '[Service]\n' },
  { name: 'lightmoni-agent-helper.service', body: '[Service]\n' },
  { name: 'lightmoni-agent-runtime', type: '5', mode: 0o755 },
  { name: 'lightmoni-agent-runtime/node', body: 'trusted runtime', mode: 0o755 },
  { name: 'lightmoni-agent-runtime/release.json', body: '{}' },
];
const tar = (members: Member[]) => Buffer.concat([...members.map(member), Buffer.alloc(1024)]);
function fixture(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lm-extract-'))), destination = join(root, 'unpacked'), archive = join(root, 'bundle.tar.gz');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(destination, { mode: 0o700 });
  const maintenance = new AgentMaintenance({ root, uid: process.getuid?.() ?? 0 });
  const pack = (members: Member[], transform: (bytes: Buffer) => Buffer = value => value) => fs.writeFileSync(archive, gzipSync(transform(tar(members))));
  const noTemporary = () => assert.equal(fs.readdirSync(destination).some(name => name.startsWith('.maintenance-')), false);
  return { root, destination, archive, maintenance, pack, noTemporary };
}
const paxRecord = (key: string, value: string) => {
  const body = key + '=' + value + '\n';
  let length = Buffer.byteLength(body) + 2;
  for (;;) { const actual = Buffer.byteLength(body) + String(length).length + 1; if (actual === length) return length + ' ' + body; length = actual; }
};

test('streamed TAR validates first and preserves executable files plus safe internal symlinks', async t => {
  const f = fixture(t);
  f.pack([...required(), { name: 'lightmoni-agent-runtime/node_modules/pkg', type: '5' }, { name: 'lightmoni-agent-runtime/node_modules/pkg/bin', type: '2', link: '../../node' }]);
  await f.maintenance.extract(f.archive, f.destination);
  assert.equal(fs.readFileSync(join(f.destination, 'lightmoni-agent-runtime/node'), 'utf8'), 'trusted runtime');
  assert.equal(fs.statSync(join(f.destination, 'lightmoni-agent')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(join(f.destination, 'lightmoni-agent-runtime/release.json')).mode & 0o777, 0o644);
  assert.equal(fs.readlinkSync(join(f.destination, 'lightmoni-agent-runtime/node_modules/pkg/bin')), '../../node');
  f.noTemporary();
});

for (const [label, members, error] of [
  ['parent traversal', [{ name: 'lightmoni-agent-runtime/../escape' }], /unsafe_archive_path/],
  ['absolute path', [{ name: '/tmp/escape' }], /unsafe_archive_path/],
  ['symlink escape', [{ name: 'lightmoni-agent-runtime/escape', type: '2', link: '../../escape' }], /unsafe_archive_link/],
  ['absolute symlink', [{ name: 'lightmoni-agent-runtime/escape', type: '2', link: '/etc/passwd' }], /unsafe_archive_link/],
  ['hard link', [{ name: 'lightmoni-agent-runtime/link', type: '1', link: 'lightmoni-agent-runtime/node' }], /unsupported_archive_entry/],
  ['duplicate member', [{ name: 'lightmoni-agent' }], /duplicate_archive_path/],
  ['symlink as parent', [{ name: 'lightmoni-agent-runtime/parent', type: '2', link: 'node' }, { name: 'lightmoni-agent-runtime/parent/child' }], /unsafe_archive_path/],
  ['PAX path traversal', [{ name: 'pax', type: 'x', body: paxRecord('path', '../escape') }, { name: 'lightmoni-agent-runtime/file' }], /unsafe_archive_path/],
  ['PAX link traversal', [{ name: 'pax', type: 'x', body: paxRecord('linkpath', '../../escape') }, { name: 'lightmoni-agent-runtime/link', type: '2', link: 'node' }], /unsafe_archive_link/],
  ['oversized PAX metadata', [{ name: 'pax', type: 'x', body: Buffer.alloc((64 << 10) + 1, 65) }], /archive_too_large/],
  ['oversized GNU name', [{ name: 'long', type: 'L', body: Buffer.alloc(4097, 65) }], /invalid_archive/],
] as Array<[string, Member[], RegExp]>) test('streamed TAR rejects ' + label + ' before creating any member', async t => {
  const f = fixture(t); f.pack([...required(), ...members]);
  await assert.rejects(f.maintenance.extract(f.archive, f.destination), error);
  f.noTemporary(); assert.deepEqual(fs.readdirSync(f.destination), []);
});

for (const label of ['gzip trailer checksum', 'truncated gzip', 'TAR checksum', 'truncated TAR body', 'nonzero data after end marker']) test('streamed TAR rejects ' + label + ' and removes its private temporary file', async t => {
  const f = fixture(t); f.pack(required());
  if (label === 'gzip trailer checksum') { const bytes = fs.readFileSync(f.archive); bytes[bytes.length - 8] ^= 1; fs.writeFileSync(f.archive, bytes); }
  else if (label === 'truncated gzip') { const bytes = fs.readFileSync(f.archive); fs.writeFileSync(f.archive, bytes.subarray(0, bytes.length - 9)); }
  else f.pack(required(), bytes => {
    if (label === 'TAR checksum') { bytes[0] ^= 1; return bytes; }
    if (label === 'truncated TAR body') return bytes.subarray(0, 520);
    return Buffer.concat([bytes, Buffer.from('unvalidated trailing payload')]);
  });
  await assert.rejects(f.maintenance.extract(f.archive, f.destination), /invalid_archive/);
  f.noTemporary(); assert.deepEqual(fs.readdirSync(f.destination), []);
});

test('expanded gzip is capped at 768 MiB without retaining it in memory; cancellation/error cleanup removes the TAR', { timeout: 120000 }, async t => {
  const f = fixture(t), chunk = Buffer.alloc(64 << 10);
  async function* zeros() { for (let size = 0; size <= 768 << 20; size += chunk.length) yield chunk; }
  await pipeline(Readable.from(zeros()), createGzip({ level: 1 }), fs.createWriteStream(f.archive, { mode: 0o600 }));
  let observedPrivate = false;
  const check = setInterval(() => {
    const temporary = fs.readdirSync(f.destination).find(name => name.startsWith('.maintenance-'));
    if (temporary) { const info = fs.lstatSync(join(f.destination, temporary)); assert.equal(info.mode & 0o777, 0o600); assert.equal(info.uid, process.getuid?.() ?? 0); observedPrivate = true; }
  }, 5);
  try { await assert.rejects(f.maintenance.extract(f.archive, f.destination), /archive_too_large/); }
  finally { clearInterval(check); }
  assert.equal(observedPrivate, true); f.noTemporary(); assert.deepEqual(fs.readdirSync(f.destination), []);
});

test('preparing cancellation during file copy removes the private TAR and never follows preexisting destination links', async t => {
  const f = fixture(t), controller = new AbortController(), target = join(f.destination, 'lightmoni-agent-runtime/large');
  f.pack([...required(), { name: 'lightmoni-agent-runtime/large', body: Buffer.alloc(16 << 20, 65) }]);
  const timer = setInterval(() => { if (fs.existsSync(target)) controller.abort(); }, 1);
  try { await assert.rejects(f.maintenance.extract(f.archive, f.destination, { signal: controller.signal }), /maintenance_cancelled/); }
  finally { clearInterval(timer); }
  assert.ok(fs.statSync(target).size < 16 << 20); f.noTemporary();
  const collision = fixture(t), outside = join(collision.root, 'outside'); fs.writeFileSync(outside, 'unchanged');
  fs.symlinkSync(outside, join(collision.destination, 'lightmoni-agent'));
  collision.pack(required());
  await assert.rejects(collision.maintenance.extract(collision.archive, collision.destination));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged'); collision.noTemporary();
});
