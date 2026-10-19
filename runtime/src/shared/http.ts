import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Context,
  Handler,
  Router as RouterContract,
  Auth,
} from "./types.js";
import { parseJSON, stringifyJSON } from "./json.js";
export class HTTPError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new HTTPError(status, message);
}
export class Router implements RouterContract {
  private routes: {
    method: string;
    path: string;
    regex: RegExp;
    names: string[];
    handler: Handler;
    public: boolean;
  }[] = [];
  auth?: Auth;
  externalURL = "";
  constructor(readonly onError: (error: unknown) => void = () => {}) {}
  private add(
    method: string,
    path: string,
    handler: Handler,
    options?: { public?: boolean },
  ) {
    const names: string[] = [];
    const regex = new RegExp(
      "^" +
        path
          .split("/")
          .map((part) =>
            part.startsWith(":")
              ? (names.push(part.slice(1)), "([^/]+)")
              : part === "*"
                ? (names.push("wildcard"), "(.*)")
                : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          )
          .join("/") +
        "/?$",
    );
    this.routes.push({
      method,
      path,
      regex,
      names,
      handler,
      public: !!options?.public,
    });
  }
  get(path: string, handler: Handler, options?: { public?: boolean }) {
    this.add("GET", path, handler, options);
  }
  post(path: string, handler: Handler, options?: { public?: boolean }) {
    this.add("POST", path, handler, options);
  }
  put(path: string, handler: Handler, options?: { public?: boolean }) {
    this.add("PUT", path, handler, options);
  }
  delete(path: string, handler: Handler, options?: { public?: boolean }) {
    this.add("DELETE", path, handler, options);
  }
  patch(path: string, handler: Handler, options?: { public?: boolean }) {
    this.add("PATCH", path, handler, options);
  }
  list() {
    return this.routes.map(({ method, path, public: publicRoute }) => ({
      method,
      path,
      public: publicRoute,
    }));
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(
      req.url ?? "/",
      "http://" + (req.headers.host ?? "localhost"),
    );
    const route = this.routes.find(
      (route) =>
        (route.method === req.method ||
          (req.method === "HEAD" && route.method === "GET")) &&
        route.regex.test(url.pathname),
    );
    if (!route) return false;
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const match = route.regex.exec(url.pathname)!;
    let cache: Promise<Buffer> | undefined;
    const raw = (limit = 2 << 20) => {
      cache ??= (async () => {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > limit) fail(413, "request body too large");
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      })();
      return cache.then((value) => {
        if (value.length > limit) fail(413, "request body too large");
        return value;
      });
    };
    const ctx: Context = {
      req,
      res,
      url,
      signal: controller.signal,
      params: {},
      user: { id: "", name: "", role: "" },
      raw,
      body: async <T>() => {
        try {
          return parseJSON<T>((await raw()).toString());
        } catch (error) {
          if (error instanceof HTTPError) throw error;
          return fail(400, "invalid JSON request");
        }
      },
      json: (value, status = 200) => {
        if (res.writableEnded) return;
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(stringifyJSON(value) + "\n");
      },
      error: fail,
    };
    try {
      try {
        ctx.params = Object.fromEntries(
          route.names.map((name, i) => [
            name,
            decodeURIComponent(match[i + 1]),
          ]),
        );
      } catch {
        fail(400, "invalid URL path");
      }
      if (!route.public) {
        const user = this.auth?.user(req);
        if (!user) fail(401, "请先登录");
        ctx.user = user;
        this.checkOrigin(req);
      }
      await route.handler(ctx);
      if (!res.writableEnded && !res.headersSent) ctx.json({ ok: true });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
      } else if (!controller.signal.aborted) {
        const status = error instanceof HTTPError ? error.status : 500;
        if (status === 500) this.onError(error);
        ctx.json(
          {
            error: error instanceof HTTPError ? error.message : "服务暂不可用",
          },
          status,
        );
      }
    }
    return true;
  }
  checkOrigin(req: IncomingMessage): void {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method ?? "")) return;
    checkRequestOrigin(req, this.externalURL);
  }
}
export function checkRequestOrigin(req: IncomingMessage, externalURL: string, required = false): void {
  const origin = req.headers.origin;
  if (!origin) {
    if (required) fail(403, "invalid request origin");
    return;
  }
  let expected: URL, actual: URL;
  try {
    expected = new URL(externalURL || "http://" + req.headers.host);
    actual = new URL(origin);
  } catch {
    return fail(403, "invalid request origin");
  }
  if (
    !["http:", "https:"].includes(actual.protocol) ||
    actual.username ||
    actual.password ||
    actual.pathname !== "/" ||
    actual.search ||
    actual.hash
  )
    fail(403, "invalid request origin");
  const local = (u: URL) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname.toLowerCase());
  if (actual.origin === expected.origin) return;
  if (
    local(expected) &&
    local(actual) &&
    actual.protocol === expected.protocol &&
    (actual.port === expected.port || actual.port === "5173")
  )
    return;
  fail(403, "invalid request origin");
}
