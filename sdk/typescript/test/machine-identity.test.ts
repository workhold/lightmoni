import test from 'node:test';
import assert from 'node:assert/strict';
import { createLightMoni, type FrozenBatch } from '../src/index.js';
import { createLightMoni as createBrowserClient } from '../src/browser.js';

const variables = ['LIGHTMONI_MACHINE_ID', 'LIGHTMONI_MACHINE_NAME'] as const;
test('Node host declarations reach all OTLP signals; explicit resource wins and initialization freezes them', async () => {
  const previous = variables.map(name => process.env[name]);
  try {
    process.env.LIGHTMONI_MACHINE_ID = 'machine-01'; process.env.LIGHTMONI_MACHINE_NAME = '生产 主机';
    const original = { 'lightmoni.machine.id': 'explicit', 'host.id': 'agent-host' };
    const batches: FrozenBatch[] = [];
    const mon = createLightMoni({ service: 'test', table: 'business', instance_id: 'instance-1', selfTelemetry: false, resource: original, intervalMs: 60_000, exporter: { async deliver(batch) { batches.push(batch); } } });
    process.env.LIGHTMONI_MACHINE_NAME = 'changed-after-init';
    try {
      mon.counter('requests').add(1); mon.log('info', 'hello'); mon.startSpan('work').end(); await mon.flush();
      assert.equal(batches.length, 3);
      for (const batch of batches) {
        const payload = JSON.parse(new TextDecoder().decode(batch.payload));
        const resource = Object.fromEntries(Object.values(payload).flatMap((groups: any) => groups[0].resource.attributes).map((a: any) => [a.key, a.value.stringValue]));
        assert.equal(resource['lightmoni.machine.id'], 'explicit'); assert.equal(resource['lightmoni.machine.name'], '生产 主机');
        assert.equal(resource['host.id'], 'agent-host'); assert.equal(resource['service.name'], 'test'); assert.equal(resource['service.instance.id'], 'instance-1');
      }
      assert.deepEqual(original, { 'lightmoni.machine.id': 'explicit', 'host.id': 'agent-host' });
    } finally { await mon.shutdown(); }
  } finally { variables.forEach((name, i) => previous[i] === undefined ? delete process.env[name] : process.env[name] = previous[i]); }
});

test('missing and invalid environment declarations are ignored, with UTF-8 byte limits', async () => {
  const previous = variables.map(name => process.env[name]);
  try {
    for (const [id, name, expected] of [
      [undefined, undefined, false], ['', '   ', false], ['a'.repeat(65), '界'.repeat(43), false],
      ['bad\nvalue', 'bad\u0085value', false], ['界'.repeat(21) + 'a', '界'.repeat(42) + 'ab', true],
    ] as const) {
      if (id === undefined) delete process.env.LIGHTMONI_MACHINE_ID; else process.env.LIGHTMONI_MACHINE_ID = id;
      if (name === undefined) delete process.env.LIGHTMONI_MACHINE_NAME; else process.env.LIGHTMONI_MACHINE_NAME = name;
      const batches: FrozenBatch[] = [];
      const mon = createLightMoni({ service: 'test', table: 'business', selfTelemetry: false, intervalMs: 60_000, exporter: { async deliver(batch) { batches.push(batch); } } });
      try {
        mon.counter('requests').add(1); await mon.flush();
        const attributes = JSON.parse(new TextDecoder().decode(batches[0].payload)).resourceMetrics[0].resource.attributes;
        assert.equal(attributes.some((a: any) => a.key === 'lightmoni.machine.id'), expected);
        assert.equal(attributes.some((a: any) => a.key === 'lightmoni.machine.name'), expected);
        assert.equal(mon.stats().invalidRecords, 0);
      } finally { await mon.shutdown(); }
    }
  } finally { variables.forEach((name, i) => previous[i] === undefined ? delete process.env[name] : process.env[name] = previous[i]); }
});

test('browser entry ignores Node environment declarations', async () => {
  const previous = variables.map(name => process.env[name]);
  try {
    process.env.LIGHTMONI_MACHINE_ID = 'must-not-enter-browser'; process.env.LIGHTMONI_MACHINE_NAME = 'server-only';
    const batches: FrozenBatch[] = [];
    const mon = createBrowserClient({ service: 'web', table: 'business', selfTelemetry: false, intervalMs: 60_000, exporter: { async deliver(batch) { batches.push(batch); } } });
    try {
      mon.counter('clicks').add(1); await mon.flush();
      const attributes = JSON.parse(new TextDecoder().decode(batches[0].payload)).resourceMetrics[0].resource.attributes;
      assert.ok(attributes.every((a: any) => !a.key.startsWith('lightmoni.machine.')));
    } finally { await mon.shutdown(); }
  } finally { variables.forEach((name, i) => previous[i] === undefined ? delete process.env[name] : process.env[name] = previous[i]); }
});
