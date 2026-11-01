import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StartDeadline, durableWrite, rootPath, type BootClock } from '../src/privileged-executor/security.js';

function clock(initial = 1000) {
  const state = { now: initial, boot: 'boot-a' };
  const source: BootClock = { now: () => state.now, bootID: () => state.boot };
  return { state, source };
}

test('a delayed permit response cannot restart or extend the original 30 second request deadline', () => {
  const f = clock(), deadline = new StartDeadline(f.source);
  f.state.now = 19000; deadline.shorten(30000); // Eighteen seconds were already spent awaiting the response.
  f.state.now = 30999; deadline.assert(); deadline.shorten(30000);
  f.state.now = 31000;
  assert.throws(() => deadline.assert(), /expired_permit/);
  assert.throws(() => deadline.shorten(30000), /expired_permit/);
});

test('a shorter center lifetime can only shrink the local window, even after another response', () => {
  const f = clock(), deadline = new StartDeadline(f.source);
  f.state.now = 6000; deadline.shorten(2000);
  f.state.now = 6500; deadline.shorten(30000);
  f.state.now = 7999; deadline.assert(); f.state.now = 8000;
  assert.throws(() => deadline.assert(), /expired_permit/);
});

test('late responses and suspend-inclusive time jumps reject permits without wall-clock grace', () => {
  const f = clock(), deadline = new StartDeadline(f.source);
  f.state.now += 30001; // Includes a machine suspend, rather than advancing only process CPU time.
  assert.throws(() => deadline.shorten(1000), /expired_permit/);
  assert.throws(() => deadline.assert(), /expired_permit/);
});

test('a boot change invalidates an otherwise unexpired local deadline', () => {
  const f = clock(), deadline = new StartDeadline(f.source);
  f.state.now = 2000; deadline.assert(); f.state.boot = 'boot-b';
  assert.throws(() => deadline.assert(), /expired_permit/);
  assert.throws(() => deadline.shorten(1000), /expired_permit/);
});

test('clock rollback is rejected both before the start and after an intermediate observation', () => {
  const initial = clock(), initialDeadline = new StartDeadline(initial.source);
  initial.state.now = 999; assert.throws(() => initialDeadline.assert(), /expired_permit|unreliable_clock/);
  const intermediate = clock(), deadline = new StartDeadline(intermediate.source);
  intermediate.state.now = 9000; deadline.assert(); intermediate.state.now = 8000;
  assert.throws(() => deadline.assert(), /expired_permit|unreliable_clock/);
});

test('non-finite or out-of-range permit windows and remaining lifetimes fail closed', () => {
  for (const window of [0, -1, 30001, NaN, Infinity, -Infinity]) {
    const f = clock(); assert.throws(() => new StartDeadline(f.source, window), /invalid_permit_window/);
  }
  const f = clock(), deadline = new StartDeadline(f.source);
  for (const remaining of [0, -1, 30001, NaN, Infinity, -Infinity]) assert.throws(() => deadline.shorten(remaining), /expired_permit/);
});

test('unprovable monotonic clock values cannot turn the deadline into an unlimited permit', () => {
  for (const value of [NaN, Infinity, -Infinity, -1]) {
    const initial = clock(value);
    assert.throws(() => new StartDeadline(initial.source), /unreliable_clock|expired_permit/);
    const later = clock(), deadline = new StartDeadline(later.source); later.state.now = value;
    assert.throws(() => deadline.assert(), /unreliable_clock|expired_permit/);
  }
  let reads = 0;
  const source: BootClock = { bootID: () => 'boot-a', now: () => ++reads <= 2 ? 1000 : NaN };
  const deadline = new StartDeadline(source);
  assert.throws(() => { deadline.shorten(1000); deadline.assert(); }, /unreliable_clock|expired_permit/);
});

test('durable write replaces a file with private mode and leaves no temporary file on rename failure', t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'lightmoni-executor-security-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'state.json');
  durableWrite(target, '{"generation":1}'); durableWrite(target, '{"generation":2}');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"generation":2}');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const cannotReplace = join(directory, 'existing-directory'); fs.mkdirSync(cannotReplace);
  assert.throws(() => durableWrite(cannotReplace, 'must-not-pretend-it-was-persisted'));
  assert.deepEqual(fs.readdirSync(directory).sort(), ['existing-directory', 'state.json']);
});

test('root path policy rejects ambiguous caller paths before touching the filesystem', () => {
  for (const path of ['relative/key.pem', '/etc/lightmoni/../key.pem', '/etc//key.pem', '/etc/key.pem\0suffix', '/etc/key.pem/']) assert.throws(() => rootPath(path), /unsafe_path/);
});
