import { createServer, isIP } from "node:net";
import { createSocket } from "node:dgram";
import { OperationRejectedError } from "./errors.js";

type HostPort = { host_port: number; host_ip: string; protocol: string };

/** Best-effort preflight; Docker's eventual port publication remains authoritative. */
export async function availablePort(p: HostPort, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const listener = p.protocol === "udp"
      ? createSocket(isIP(p.host_ip) === 6 ? "udp6" : "udp4")
      : createServer();
    listener.once("error", (error: NodeJS.ErrnoException) => {
      // An unbound UDP socket may already have closed after a failed bind.
      try { listener.close(); } catch {}
      // The non-root Agent may not bind 80/443 even though Docker can publish them.
      // Continue the existing Docker preflight/start path to verify the real bind.
      if (error.code === "EACCES" && p.host_port < 1024) return resolve();
      reject(new OperationRejectedError(
        error.code === "EADDRINUSE" ? "HOST_PORT_OCCUPIED" : "HOST_PORT_CHECK_FAILED",
      ));
    });
    listener.once("listening", () => listener.close(() => resolve()));
    if (p.protocol === "udp")
      (listener as ReturnType<typeof createSocket>).bind(p.host_port, p.host_ip);
    else
      (listener as ReturnType<typeof createServer>).listen(p.host_port, p.host_ip);
  });
}
