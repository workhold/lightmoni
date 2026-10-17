import { createApp } from "./app.js";
import { listenAddress } from "./address.js";

const env = (key: string, fallback: string) => process.env[key] || fallback;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  const at = listenAddress(env("LIGHTMONI_ADDR", "127.0.0.1:8080"));
  app = await createApp({
    dataDir: env("LIGHTMONI_DATA", ".lightmoni"),
    chURL: env("LIGHTMONI_CH_URL", "http://127.0.0.1:18123"),
    chUser: env("LIGHTMONI_CH_USER", "lightmoni"),
    chPassword: env("LIGHTMONI_CH_PASSWORD", "lightmoni_test_password"),
    externalURL: env("LIGHTMONI_EXTERNAL_URL", "http://localhost:8080").replace(
      /\/+$/,
      "",
    ),
    publicDir: process.env.LIGHTMONI_PUBLIC_DIR,
    downloadsDir: process.env.LIGHTMONI_DOWNLOADS_DIR,
  });
  const server = app.server;
  await new Promise<void>((resolve, reject) => {
    const error = (reason: Error) => reject(reason);
    server.once("error", error);
    server.listen(at.port, at.host, () => {
      server.removeListener("error", error);
      resolve();
    });
  });
  console.info("LightMoni Node listening on " + at.host + ":" + at.port);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app!.close();
    } catch {
      console.error("LightMoni shutdown failed");
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
} catch (error) {
  await app?.close();
  console.error(
    "LightMoni startup failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
}
