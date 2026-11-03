import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { checkReadiness } from '../src/operations/platform.js';
import type { OperationExecutionContext } from '../src/operations/types.js';

const context = { signal: new AbortController().signal } as OperationExecutionContext;
async function listener(t: any, host: string) {
  const server = createServer((_req, res) => { res.writeHead(200); res.end('ready'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

test('HTTP and TCP readiness reach the actual non-loopback bind, rather than another host address', async t => {
  const host = Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address;
  if (!host) return t.skip('No non-loopback IPv4 interface available');
  const port = await listener(t, host);
  for (const type of ['http', 'tcp']) {
    assert.equal(await checkReadiness({ health: { type, host, port, path: '/v2/' } }, context), true, type);
    assert.equal(await checkReadiness({ health: { type, host: '127.0.0.1', port } }, context), false, type);
  }
});

test('wildcard bindings probe local loopback, including bracketed IPv6 HTTP URLs', async t => {
  const ipv4 = await listener(t, '127.0.0.1');
  for (const type of ['http', 'tcp']) {
    assert.equal(await checkReadiness({ health: { type, host: '0.0.0.0', port: ipv4 } }, context), true);
  }
  const ipv6 = await listener(t, '::1');
  for (const host of ['::', '::1']) for (const type of ['http', 'tcp']) {
    assert.equal(await checkReadiness({ health: { type, host, port: ipv6 } }, context), true, host + ' ' + type);
  }
});

test('readiness rejects non-IP destinations before making any request', async () => {
  for (const host of ['example.com', 'user@127.0.0.1', '[::1]', '127.0.0.1/path', '', 123, '127.0.0.1\n']) {
    await assert.rejects(checkReadiness({ health: { type: 'http', host, port: 8080 } }, context), /INVALID_HEALTH_HOST/);
  }
});
