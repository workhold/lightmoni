import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createSocket} from 'node:dgram';
import {once} from 'node:events';
import {availablePort} from '../../../runtime/dist/operations/host-ports.js';

assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0);
assert.equal((await readFile('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8')).trim(), '1024');
assert.match(await readFile('/proc/self/status', 'utf8'), /CapEff:\s+0+\n/);
console.log(`Linux ${process.arch}; uid=${process.getuid()}; capabilities=0; privileged threshold=1024`);
const signal = AbortSignal.timeout(10000);
let checks = 0;
for (const protocol of ['tcp', 'udp']) {
  for (const host_ip of ['127.0.0.1', '::1']) {
    const open = port => {
      const socket = protocol === 'tcp' ? createServer() : createSocket(host_ip === '::1' ? 'udp6' : 'udp4');
      const listening = once(socket, 'listening');
      if (protocol === 'tcp') socket.listen(port, host_ip);
      else socket.bind(port, host_ip);
      return {socket, listening};
    };
    for (const host_port of [80, 443]) {
      const denied = open(host_port);
      await assert.rejects(denied.listening, {code: 'EACCES'});
      try { denied.socket.close(); } catch {}
      await availablePort({host_port, host_ip, protocol}, signal);
      console.log(`PASS ${protocol} ${host_ip}:${host_port}: real EACCES defers to Docker`);
      checks++;
    }
    const busy = open(0);
    await busy.listening;
    const host_port = busy.socket.address().port;
    try {
      await assert.rejects(availablePort({host_port, host_ip, protocol}, signal), {message: 'HOST_PORT_OCCUPIED'});
    } finally {
      await new Promise(resolve => busy.socket.close(resolve));
    }
    await availablePort({host_port, host_ip, protocol}, signal);
    console.log(`PASS ${protocol} ${host_ip}: real occupied port rejected; released port reusable`);
    checks++;
  }
}
await assert.rejects(availablePort({host_port: 18080, host_ip: '198.51.100.1', protocol: 'tcp'}, signal), {message: 'HOST_PORT_CHECK_FAILED'});
console.log('PASS non-local bind address has its own failure cause');
console.log(`PASS ${checks + 1} real Linux socket checks`);
