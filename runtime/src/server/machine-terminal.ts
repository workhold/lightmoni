import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { Client, type ClientChannel } from "ssh2";
import { WebSocket, WebSocketServer } from "ws";
import { id, hash } from "../shared/crypto.js";
import { checkRequestOrigin, fail, HTTPError } from "../shared/http.js";
import type { Dependencies, Module } from "../shared/types.js";
import { cookie } from "./auth.js";
import type { MachineTerminalAccess, TerminalLease } from "./managed-machines.js";

const OUTPUT_WINDOW = 256 << 10, BUFFER_LIMIT = 1 << 20, INPUT_LIMIT = 16 << 10;
const defaults = { pendingMs: 60_000, connectMs: 20_000, idleMs: 600_000, maxMs: 1_800_000, checkMs: 5_000, globalLimit: 20, userLimit: 3 };
type Limits = typeof defaults;
interface Session {
  id: string; machineID: string; actorID: string; loginHash: string;
  lease: TerminalLease; state: "pending" | "connecting" | "connected" | "closed";
  expires: number; cols: number; rows: number; lastInput: number; started: number; unacked: number;
  ws?: WebSocket; client?: Client; stream?: ClientChannel; req: IncomingMessage;
  deadline?: NodeJS.Timeout; check?: NodeJS.Timeout; alive: boolean;
}
const dimension = (value: unknown, fallback: number, max: number) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 2 || Number(value) > max) fail(400, "invalid terminal dimensions");
  return Number(value);
};
const loginHash = (req: IncomingMessage) => {
  const value = cookie(req, "lm_session");
  if (!value) fail(401, "请先登录");
  return hash(value);
};
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid terminal request");
  return value;
};
const fields = (value: Record<string, any>, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, "unknown terminal parameter");
};

// Only the human-facing HTTP/WebSocket boundary uses this module. Shell input
// and output never enter the assistant tool registry, database, or logger.
export function registerMachineTerminal(deps: Dependencies, machines: MachineTerminalAccess, server: Server, options: Partial<Limits> = {}): Module {
  const limits = { ...defaults, ...options }, sessions = new Map<string, Session>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 << 10, perMessageDeflate: false });
  let stopped = false;
  deps.db.exec(`CREATE TABLE IF NOT EXISTS machine_terminal_events(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,credential_id TEXT NOT NULL,actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,connected_at TEXT NOT NULL DEFAULT '',closed_at TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT ''
  )`);
  const at = () => deps.now().toISOString();
  const send = (s: Session, value: unknown) => {
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(value));
  };
  const close = (s: Session, reason: string) => {
    if (s.state === "closed") return;
    s.state = "closed";
    sessions.delete(s.id);
    clearTimeout(s.deadline); clearInterval(s.check);
    s.stream?.destroy(); s.client?.destroy(); s.lease.release();
    deps.db.run("UPDATE machine_terminal_events SET closed_at=?,reason=? WHERE id=?", at(), reason, s.id);
    send(s, { type: "status", status: "closed", reason });
    if (s.ws) {
      const ws = s.ws;
      if (stopped) ws.terminate();
      else {
        ws.close(1000, reason);
        const timer = setTimeout(() => ws.terminate(), 1000); timer.unref();
        ws.once("close", () => clearTimeout(timer));
      }
    }
  };
  const authorized = (s: Session) => {
    const user = deps.auth.user(s.req);
    if (!user || user.role !== "admin" || user.id !== s.actorID) { close(s, "login_expired"); return false; }
    if (!s.lease.valid()) { close(s, "credential_invalid"); return false; }
    return true;
  };
  const connect = (s: Session, ws: WebSocket, req: IncomingMessage) => {
    clearTimeout(s.deadline);
    s.state = "connecting"; s.ws = ws; s.req = req;
    s.started = s.lastInput = Date.now(); s.alive = true;
    send(s, { type: "status", status: "connecting" });
    s.deadline = setTimeout(() => close(s, "connect_timeout"), limits.connectMs); s.deadline.unref();
    s.check = setInterval(() => {
      if (!authorized(s)) return;
      if (Date.now() - s.started >= limits.maxMs) return close(s, "session_limit");
      if (Date.now() - s.lastInput >= limits.idleMs) return close(s, "idle_timeout");
      if (!s.alive) return close(s, "connection_lost");
      s.alive = false; ws.ping();
    }, limits.checkMs); s.check.unref();
    ws.on("pong", () => { s.alive = true; });
    ws.on("error", () => close(s, "connection_lost"));
    ws.on("close", () => close(s, "disconnected"));
    ws.on("message", (raw, binary) => {
      if (s.state === "closed" || !authorized(s)) return;
      try {
        if (binary) throw Error();
        const message = record(JSON.parse(raw.toString()));
        if (message.type === "ack") {
          fields(message, ["type", "bytes"]);
          if (!Number.isSafeInteger(message.bytes) || message.bytes <= 0 || message.bytes > s.unacked) throw Error();
          s.unacked -= message.bytes;
          if (s.unacked < OUTPUT_WINDOW) { s.stream?.resume(); s.stream?.stderr.resume(); }
        } else if (message.type === "resize") {
          fields(message, ["type", "cols", "rows"]);
          if (message.cols === undefined || message.rows === undefined) throw Error();
          s.cols = dimension(message.cols, s.cols, 500); s.rows = dimension(message.rows, s.rows, 200);
          s.stream?.setWindow(s.rows, s.cols, 0, 0);
        } else if (message.type === "input") {
          fields(message, ["type", "data"]);
          if (s.state !== "connected" || typeof message.data !== "string" || Buffer.byteLength(message.data) > INPUT_LIMIT) throw Error();
          if ((s.stream?.writableLength ?? 0) > (64 << 10)) return close(s, "input_overflow");
          if (message.data) { s.lastInput = Date.now(); s.stream!.write(message.data); }
        } else throw Error();
      } catch { close(s, "invalid_message"); }
    });
    const client = s.client = new Client();
    let mismatch = false;
    client.on("error", (error: Error & { level?: string }) => close(s, mismatch ? "host_key_mismatch" : error.level === "client-authentication" ? "authentication_failed" : "ssh_failed"));
    client.on("close", () => close(s, "remote_closed"));
    client.on("ready", () => {
      if (s.state === "closed" || !authorized(s)) return;
      client.shell({ term: "xterm-256color", cols: s.cols, rows: s.rows, width: 0, height: 0 }, (error, stream) => {
        if (s.state === "closed") { stream?.destroy(); return; }
        if (error) return close(s, "pty_failed");
        clearTimeout(s.deadline);
        s.stream = stream; s.state = "connected"; s.lease.markUsed();
        deps.db.run("UPDATE machine_terminal_events SET connected_at=? WHERE id=?", at(), s.id);
        send(s, { type: "status", status: "connected" });
        const output = (data: Buffer) => {
          if (s.state !== "connected") return;
          if (ws.bufferedAmount + data.length > BUFFER_LIMIT || s.unacked + data.length > BUFFER_LIMIT) return close(s, "output_overflow");
          s.unacked += data.length;
          ws.send(data, { binary: true }, error => { if (error) close(s, "connection_lost"); });
          if (s.unacked >= OUTPUT_WINDOW) { stream.pause(); stream.stderr.pause(); }
        };
        stream.on("data", output); stream.stderr.on("data", output);
        stream.on("error", () => close(s, "ssh_failed"));
        stream.on("close", () => close(s, "remote_closed"));
      });
    });
    try {
      const m = s.lease.machine;
      client.connect({
        host: m.address.replace(/^\[|\]$/g, ""), port: m.port, username: m.username,
        privateKey: s.lease.privateKey, readyTimeout: limits.connectMs,
        keepaliveInterval: 15_000, keepaliveCountMax: 2,
        hostVerifier(key: Buffer) {
          const actual = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
          mismatch = actual !== m.host_key_fingerprint;
          return !mismatch;
        },
      });
    } catch { close(s, "invalid_private_key"); }
    // ssh2 has parsed the key; do not retain a second plaintext copy in the lease.
    s.lease.privateKey = "";
  };
  const path = "/api/v1/machines/:id/terminal-sessions";
  deps.router.post(path, async ctx => {
    deps.auth.requireAdmin(ctx);
    const identity = loginHash(ctx.req), input = record(await ctx.body());
    fields(input, ["credential_id", "cols", "rows"]);
    if (input.credential_id !== undefined && (typeof input.credential_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.credential_id))) fail(400, "invalid credential_id");
    const cols = dimension(input.cols, 100, 500), rows = dimension(input.rows, 30, 200);
    if (stopped) fail(503, "terminal service stopped");
    if (ctx.signal.aborted) return;
    if (sessions.size >= limits.globalLimit || [...sessions.values()].filter(s => s.actorID === ctx.user.id).length >= limits.userLimit) fail(429, "终端会话已达上限，请先关闭其他终端");
    let s: Session | undefined;
    const lease = machines.acquireTerminal(ctx.params.id, input.credential_id, () => { if (s) close(s, "credential_invalid"); });
    try {
      s = { id: id(), machineID: ctx.params.id, actorID: ctx.user.id, loginHash: identity, lease,
        state: "pending", expires: Date.now() + limits.pendingMs, cols, rows, unacked: 0, started: 0, lastInput: 0, req: ctx.req, alive: true };
      deps.db.run("INSERT INTO machine_terminal_events(id,machine_id,credential_id,actor_id,created_at) VALUES(?,?,?,?,?)", s.id, s.machineID, lease.credentialID, s.actorID, at());
      sessions.set(s.id, s);
      const session = s;
      s.deadline = setTimeout(() => close(session, "connect_expired"), limits.pendingMs); s.deadline.unref();
      ctx.res.once("close", () => { if (!ctx.res.writableFinished) close(session, "disconnected"); });
      ctx.json({ id: s.id, status: "pending", websocket_path: `/api/v1/machines/${s.machineID}/terminal-sessions/${s.id}/ws`,
        connect_expires_at: new Date(Date.now() + limits.pendingMs).toISOString(), idle_seconds: limits.idleMs / 1000, max_seconds: limits.maxMs / 1000 }, 201);
    } catch (error) { if (s && sessions.has(s.id)) close(s, "ssh_failed"); else lease.release(); throw error; }
  });
  deps.router.delete(path + "/:sessionId", ctx => {
    deps.auth.requireAdmin(ctx);
    const s = sessions.get(ctx.params.sessionId);
    // Closing twice is harmless. A foreign live session must never be closed.
    if (s && (s.machineID !== ctx.params.id || s.actorID !== ctx.user.id || s.loginHash !== loginHash(ctx.req))) fail(403, "terminal session forbidden");
    if (s) close(s, "disconnected");
    ctx.json({ ok: true });
  });
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const match = /^\/api\/v1\/machines\/([A-Za-z0-9_-]+)\/terminal-sessions\/([A-Za-z0-9_-]+)\/ws$/.exec(url.pathname);
      if (!match || url.search || req.method !== "GET") fail(404, "not found");
      if (stopped) fail(503, "terminal service stopped");
      checkRequestOrigin(req, deps.externalURL, true);
      const user = deps.auth.user(req);
      if (!user) fail(401, "login required");
      if (user.role !== "admin") fail(403, "administrator required");
      const s = sessions.get(match[2]);
      if (!s || s.machineID !== match[1]) fail(404, "terminal session not found");
      if (s.actorID !== user.id || s.loginHash !== loginHash(req)) fail(403, "terminal session forbidden");
      if (s.state === "pending" && Date.now() >= s.expires) { close(s, "connect_expired"); fail(410, "terminal session expired"); }
      if (s.state !== "pending") fail(409, "terminal session already used");
      if (!authorized(s)) fail(403, "terminal session expired");
      wss.handleUpgrade(req, socket, head, ws => connect(s, ws, req));
    } catch (error) {
      const status = error instanceof HTTPError ? error.status : 500;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  };
  server.on("upgrade", upgrade);
  return { close() {
    stopped = true;
    server.off("upgrade", upgrade);
    for (const s of sessions.values()) close(s, "server_shutdown");
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  } };
}
