import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { TestContext } from "node:test";
import ssh2 from "ssh2";

/** Real SSH password/PTY protocol fixture, with no subprocess or OS account. */
export async function passwordSSHServer(t: TestContext, options: { password?: string } = {}) {
  const { Server, utils } = ssh2;
  const key = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs1" }, publicKeyEncoding: { format: "pem", type: "pkcs1" } });
  const parsed = utils.parseKey(key.privateKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw Error("invalid fixture SSH host key");
  const pin = "SHA256:" + createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "");
  const password = options.password ?? randomBytes(24).toString("base64url"), clients = new Set<any>();
  const authMethods: string[] = [], ptys: { cols: number; rows: number; term: string }[] = [], commands: string[] = [];
  const server = new Server({ hostKeys: [key.privateKey] }, client => {
    clients.add(client); client.on("close", () => clients.delete(client)); client.on("error", () => {});
    client.on("authentication", context => {
      authMethods.push(context.method);
      if (context.method === "password" && context.username === "fixture" && context.password === password) context.accept();
      else context.reject(["password"]);
    });
    client.on("ready", () => client.on("session", accept => {
      const session = accept();
      session.on("pty", (accept, _reject, info) => { ptys.push({ cols: info.cols, rows: info.rows, term: info.term }); accept?.(); });
      session.on("shell", accept => {
        const stream = accept(); stream.write("FIXTURE_READY\r\n");
        let input = "";
        stream.on("data", (data: Buffer) => {
          input += data.toString();
          while (/[\r\n]/.test(input)) {
            const index = input.search(/[\r\n]/), command = input.slice(0, index); input = input.slice(index + 1);
            if (!command) continue;
            commands.push(command);
            if (command === "fixture-identify") stream.write("FIXTURE_USER=fixture\r\nFIXTURE_HOST=loopback\r\n");
            else if (command === "fixture-exit") { stream.exit(0); stream.end(); }
            else stream.write("FIXTURE_UNSUPPORTED\r\n");
          }
        });
      });
    }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { address: "127.0.0.1", port: (server.address() as { port: number }).port, username: "fixture", pin, password, authMethods, ptys, commands };
}
