import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CenterEndpoints } from '../src/endpoints.js';
import { createLightMoni } from '../src/index.js';
async function entrance(t, handler) {
    const server = createServer(handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(() => r())); });
    return { url: `http://127.0.0.1:${server.address().port}`, server };
}
test('SDK prefers internal, retries frozen data through public, and discovers changed internal port', async (t) => {
    const seen = [];
    let revision = 'one';
    let internalURL = '';
    let publicURL = '';
    let loseACK = false;
    const handler = (name) => (req, res) => {
        if (req.url === '/v1/center-identity') {
            assert.equal(req.headers.authorization, undefined);
            res.end(JSON.stringify({ center_id: 'same-center' }));
            return;
        }
        if (req.url === '/v1/center-endpoints') {
            assert.equal(req.headers.authorization, 'Bearer sdk-secret');
            res.end(JSON.stringify({ version: 1, center_id: 'same-center', revision, endpoints: [{ url: internalURL, scope: 'internal' }, { url: publicURL, scope: 'public' }], refresh_after_seconds: 30 }));
            return;
        }
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => { seen.push({ entrance: name, path: req.url, id: String(req.headers['x-lightmoni-batch-id'] ?? ''), body: Buffer.concat(chunks).toString() }); if (name === 'internal-one' && loseACK) {
            req.socket.destroy();
            return;
        } res.setHeader('content-type', 'application/json'); res.end('{}'); });
    };
    const pub = await entrance(t, handler('public'));
    publicURL = pub.url;
    const first = await entrance(t, handler('internal-one'));
    internalURL = first.url;
    const mon = createLightMoni({ service: 'routing', endpoint: publicURL, key: 'sdk-secret', selfTelemetry: false, remoteConfig: false, retryMinMs: 10, retryMaxMs: 20 });
    t.after(() => mon.shutdown());
    await mon.refreshEndpoints();
    mon.withTable('business').counter('requests').add(1);
    await mon.flush();
    assert.equal(seen.at(-1)?.entrance, 'internal-one');
    loseACK = true;
    mon.withTable('business').counter('requests').add(2);
    await mon.flush({ timeoutMs: 3000 });
    assert.equal(seen.at(-1)?.entrance, 'public');
    assert.equal(seen.at(-2)?.id, seen.at(-1)?.id);
    assert.equal(seen.at(-2)?.body, seen.at(-1)?.body);
    first.server.closeAllConnections();
    await new Promise(r => first.server.close(() => r()));
    const next = await entrance(t, handler('internal-two'));
    internalURL = next.url;
    revision = 'two';
    await mon.refreshEndpoints();
    mon.withTable('business').counter('requests').add(3);
    await mon.flush();
    assert.equal(seen.at(-1)?.entrance, 'internal-two');
    assert.equal(mon.endpointStatus()?.scope, 'internal');
});
test('changed private identity never receives discovery or business credentials', async (t) => {
    let identity = 'same-center', privateCredentials = 0, privateURL = '', publicURL = '';
    const privateServer = await entrance(t, (req, res) => { if (req.headers.authorization)
        privateCredentials++; if (req.url === '/v1/center-identity') {
        res.end(JSON.stringify({ center_id: identity }));
        return;
    } res.end(JSON.stringify({ version: 1, center_id: 'same-center', revision: 'one', endpoints: [{ url: privateURL, scope: 'internal' }, { url: publicURL, scope: 'public' }] })); });
    privateURL = privateServer.url;
    const pub = await entrance(t, (req, res) => { if (req.url === '/v1/center-identity') {
        res.end('{"center_id":"same-center"}');
        return;
    } res.end(JSON.stringify({ version: 1, center_id: 'same-center', revision: 'one', endpoints: [{ url: privateURL, scope: 'internal' }, { url: publicURL, scope: 'public' }] })); });
    publicURL = pub.url;
    const endpoints = new CenterEndpoints(publicURL, () => ({ Authorization: 'Bearer sdk-secret' }));
    t.after(() => endpoints.close());
    assert.equal(await endpoints.resolve(), privateURL);
    identity = 'another-center';
    assert.equal(await endpoints.refresh(), publicURL);
    assert.equal(privateCredentials, 0);
});
test('redirect probes do not forward credentials and known public bootstrap cannot be starved', async (t) => {
    let redirected = 0, publicURL = '', privateURL = '';
    const target = await entrance(t, (_req, res) => { redirected++; res.end('{}'); });
    const privateServer = await entrance(t, (req, res) => { assert.equal(req.headers.authorization, undefined); res.writeHead(302, { location: target.url }); res.end(); });
    privateURL = privateServer.url;
    const publicServer = await entrance(t, (req, res) => {
        if (req.url === '/v1/center-identity') {
            res.end('{"center_id":"same"}');
            return;
        }
        res.end(JSON.stringify({ version: 1, center_id: 'same', revision: 'one', endpoints: [{ url: privateURL, scope: 'internal' }, ...Array.from({ length: 6 }, (_, i) => ({ url: `http://127.0.0.1:${i + 1}`, scope: 'public' })), { url: publicURL, scope: 'public' }] }));
    });
    publicURL = publicServer.url;
    const endpoints = new CenterEndpoints(publicURL, () => ({ Authorization: 'Bearer secret' }));
    t.after(() => endpoints.close());
    assert.equal(await endpoints.resolve(), publicURL);
    assert.equal(redirected, 0);
});
test('request timeout invalidates internal choice and independent discovery waiters can cancel', async (t) => {
    const responses = (url) => url.endsWith('center-endpoints') ? { version: 1, center_id: 'one', revision: 'one', endpoints: [{ url: 'http://internal', scope: 'internal' }, { url: 'http://public', scope: 'public' }] } : { center_id: 'one' };
    const fetcher = async (input, init) => { const url = String(input); if (url.includes('/v1/logs'))
        return new Promise((_r, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal.reason)); }); return new Response(JSON.stringify(responses(url))); };
    const endpoints = new CenterEndpoints('http://public', () => ({}), fetcher);
    t.after(() => endpoints.close());
    assert.equal(await endpoints.resolve(), 'http://internal');
    await assert.rejects(endpoints.request('/v1/logs', { method: 'POST', signal: AbortSignal.timeout(10) }));
    assert.equal(await endpoints.resolve(), 'http://public');
    const slow = new CenterEndpoints('http://public', () => ({}), async () => { await new Promise(r => setTimeout(r, 30)); return new Response('{}', { status: 404 }); });
    t.after(() => slow.close());
    const waiting = slow.resolve();
    await assert.rejects(slow.resolve(AbortSignal.timeout(5)));
    assert.equal(await waiting, 'http://public');
});
