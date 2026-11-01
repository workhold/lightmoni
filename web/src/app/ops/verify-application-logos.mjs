import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { mediaDirectory } from "../../../../scripts/qa-artifacts.mjs";
const root = resolve(import.meta.dirname, "../../../.."),
  base = process.env.LIGHTMONI_LOGOS_UI_URL ?? "http://127.0.0.1:5198";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw Error("Loopback required");
const out = resolve(root, "specs/068-application-logos/evidence"),
  media = mediaDirectory(out),
  checks = [],
  errors = [];
await mkdir(out, { recursive: true });
async function api(path, method = "GET", body) {
  const r = await fetch(base + "/api/v1" + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw Error(path + ": " + r.status + " " + value.error);
  return value;
}
if ((await api("/auth/me")).id !== "qa-admin")
  throw Error("Disposable QA administrator required");
const overview = await api("/ops/overview");
let cluster = overview.resources.find((r) => r.kind === "cluster");
if (!cluster)
  cluster = (
    await api("/ops/resources", "POST", {
      kind: "cluster",
      name: "Logo YAML QA",
      spec: {
        machine_ids: ["qa-machine"],
        port_start: 25000,
        port_end: 25999,
        nodes: [
          {
            machine_id: "qa-machine",
            address: "10.0.0.7",
            cpu: 16,
            memory_mb: 32768,
          },
        ],
      },
    })
  ).resource;
const historical = (
  await api("/ops/resources", "POST", {
    kind: "application",
    name: "Historical Compose " + Date.now(),
    spec: {
      mode: "compose",
      source: { type: "custom" },
      role: "generic",
      deployment_mode: "managed",
      deployments: [
        { cluster_id: cluster.id, replicas: 1, cpu: 0.25, memory_mb: 128 },
      ],
      ports: [
        {
          name: "http",
          service: "web",
          container_port: 8080,
          host_port: 0,
          host_ip: "127.0.0.1",
          protocol: "tcp",
          app_protocol: "http",
        },
      ],
      compose: {
        services: {
          web: {
            image: "nginx:alpine",
            environment: { TOKEN: "qa-yaml-secret" },
            ports: ["8080:8080"],
            expose: [6379],
          },
        },
      },
    },
  })
).resource;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
let custom;
try {
  for (const [language, appearance, width] of [
    ["zh-CN", "dark", 1440],
    ["en-US", "light", 1440],
    ["zh-CN", "light", 390],
    ["en-US", "dark", 390],
  ]) {
    const en = language === "en-US",
      context = await browser.newContext({
        viewport: { width, height: 1000 },
        reducedMotion: "reduce",
      });
    await context.addInitScript(
      ({ language, appearance }) => {
        localStorage.setItem("lightmoni.language", language);
        localStorage.setItem("lightmoni.appearance", appearance);
      },
      { language, appearance },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => errors.push(e.message));
    const shot = (name) =>
      page.screenshot({
        path: resolve(media, `${name}-${language}-${appearance}-${width}.png`),
        animations: "disabled",
      });
    try {
      await page.goto(base + "/applications?view=store");
      const logos = page.locator(".lm-catalog-app img");
      await expect(logos).toHaveCount(31);
      await expect
        .poll(() =>
          logos.evaluateAll((imgs) =>
            imgs.every((i) => i.complete && i.naturalWidth > 0),
          ),
        )
        .toBe(true);
      expect(
        await logos.evaluateAll((imgs) =>
          imgs.every(
            (i) =>
              new URL(i.src).origin === location.origin ||
              i.src.startsWith("data:image/"),
          ),
        ),
      ).toBe(true);
      await shot("store");
      await page.goto(base + "/applications?cluster=" + cluster.id);
      const payloads = await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = 180;
        c.height = 100;
        const x = c.getContext("2d");
        return ["#e24a60", "#397cf6", "#10a56f"].map((color, i) => {
          x.clearRect(0, 0, c.width, c.height);
          x.fillStyle = color;
          x.fillRect(10, 10, 160, 80);
          return c.toDataURL(["image/png", "image/jpeg", "image/webp"][i]);
        });
      });
      const file = (i) => ({
        name: ["logo.png", "logo.jpg", "logo.webp"][i],
        mimeType: ["image/png", "image/jpeg", "image/webp"][i],
        buffer: Buffer.from(payloads[i].split(",")[1], "base64"),
      });
      if (!custom) {
        const name = "Uploaded application " + Date.now();
        await page
          .getByRole("button", { name: "部署自定义应用", exact: true })
          .click();
        let dialog = page.getByRole("dialog");
        await dialog.getByLabel("展示名", { exact: true }).fill(name);
        await dialog.getByLabel("部署机器", { exact: true }).click();
        await page
          .locator(".ant-select-dropdown:visible")
          .getByText("QA Docker 节点", { exact: true })
          .click();
        await page.keyboard.press("Escape");
        await dialog.getByLabel("配置方式", { exact: true }).click();
        await page
          .locator(".ant-select-dropdown:visible")
          .getByText("高级 YAML", { exact: true })
          .click();
        const yaml = dialog.getByLabel("Compose 配置（YAML）", { exact: true });
        await expect(yaml).toHaveValue(/^services:/);
        await yaml.fill(
          'services:\n  app:\n    image: nginx:alpine\n    environment:\n      TOKEN: qa-created-secret\n    ports:\n      - "127.0.0.1:0:8080"\n',
        );
        await dialog.locator("input[type=file]").setInputFiles(file(0));
        await expect(dialog.locator(".lm-logo-upload img")).toHaveAttribute(
          "src",
          /^data:image\/png/,
        );
        let fail = true;
        await page.route("**/api/v1/ops/resources", (route) => {
          if (fail && route.request().method() === "POST") {
            fail = false;
            return route.fulfill({
              status: 503,
              contentType: "application/json",
              body: '{"error":"qa_create_failure"}',
            });
          }
          return route.continue();
        });
        await dialog
          .getByRole("button", { name: "保存配置", exact: true })
          .click();
        await expect(
          dialog.getByText("保存失败，输入已保留", { exact: true }),
        ).toBeVisible();
        await expect(yaml).toHaveValue(/qa-created-secret/);
        await expect(dialog.locator(".lm-logo-upload img")).toHaveAttribute(
          "src",
          /^data:image\/png/,
        );
        const response = page.waitForResponse(
          (r) =>
            r.url() === base + "/api/v1/ops/resources" &&
            r.request().method() === "POST" &&
            r.status() === 201,
        );
        await dialog
          .getByRole("button", { name: "保存配置", exact: true })
          .click();
        custom = (await (await response).json()).resource;
        await expect(dialog).not.toBeVisible();
        await page.reload();
        let card = page.getByRole("article", { name, exact: true });
        await expect(card.locator("img")).toHaveAttribute(
          "src",
          custom.logo_url,
        );
        expect(custom.spec.mode).toBe("container");
        expect(custom.revision).toBe(1);
        await card
          .getByRole("button", { name: /配\s*置/, exact: true })
          .click();
        dialog = page.getByRole("dialog");
        const edit = dialog.getByLabel("Compose 配置（YAML）", { exact: true });
        await expect(edit).toHaveValue(/^services:/);
        await expect(edit).toHaveValue(/\[redacted\]/);
        await edit.fill(
          'services:\n  app:\n    image: nginx:alpine\n    environment:\n      TOKEN: "[redacted]"\n    ports:\n      - "127.0.0.1:23456:8081"\n',
        );
        await dialog
          .getByRole("button", { name: "保存配置", exact: true })
          .click();
        await expect(dialog).not.toBeVisible();
        custom = (await api("/ops/resources/" + custom.id)).resource;
        expect(custom.revision).toBe(2);
        expect(custom.spec.ports[0].container_port).toBe(8081);
        expect(custom.spec.ports[0].host_port).toBe(23456);
        await card.getByRole("button", { name: "Logo", exact: true }).click();
        dialog = page.getByRole("dialog");
        await dialog.locator("input[type=file]").setInputFiles(file(1));
        await expect(dialog.locator(".lm-logo-upload img")).toHaveAttribute(
          "src",
          /^data:image\/png/,
        );
        await dialog
          .getByRole("button", { name: /取\s*消/, exact: true })
          .click();
        expect(
          (await api("/ops/resources/" + custom.id)).resource.logo_url,
        ).toBe(custom.logo_url);
        await card.getByRole("button", { name: "Logo", exact: true }).click();
        dialog = page.getByRole("dialog");
        await dialog.locator("input[type=file]").setInputFiles(file(1));
        await expect(dialog.locator(".lm-logo-upload img")).toHaveAttribute(
          "src",
          /^data:image\/png/,
        );
        let failLogo = true;
        await page.route("**/api/v1/ops/resources/*/logo", (route) => {
          if (failLogo && route.request().method() === "PUT") {
            failLogo = false;
            return route.fulfill({
              status: 503,
              contentType: "application/json",
              body: '{"error":"qa_logo_failure"}',
            });
          }
          return route.continue();
        });
        await dialog
          .getByRole("button", { name: "保存 Logo", exact: true })
          .click();
        await expect(
          dialog.getByText("保存失败，图片已保留", { exact: true }),
        ).toBeVisible();
        expect(
          (await api("/ops/resources/" + custom.id)).resource.logo_url,
        ).toBe(custom.logo_url);
        await expect(dialog.locator(".lm-logo-upload img")).toHaveAttribute(
          "src",
          /^data:image\/png/,
        );
        await dialog
          .getByRole("button", { name: "保存 Logo", exact: true })
          .click();
        await expect(dialog).not.toBeVisible();
        const changed = (await api("/ops/resources/" + custom.id)).resource;
        expect(changed.revision).toBe(custom.revision);
        expect(changed.logo_url).not.toBe(custom.logo_url);
        custom = changed;
        await card.getByRole("button", { name: "Logo", exact: true }).click();
        dialog = page.getByRole("dialog");
        await dialog
          .locator("input[type=file]")
          .setInputFiles({
            name: "bad.svg",
            mimeType: "image/svg+xml",
            buffer: Buffer.from('<svg onload="alert(1)"/>'),
          });
        await expect(
          dialog.getByText("请选择 PNG、JPG 或 WebP 图片", { exact: true }),
        ).toBeVisible();
        await dialog.locator("input[type=file]").setInputFiles(file(2));
        await expect(dialog.locator(".lm-logo-upload img")).toHaveAttribute(
          "src",
          /^data:image\/png/,
        );
        await api("/ops/resources/" + custom.id + "/logo", "PUT", {
          revision: custom.logo_revision,
          data_url: payloads[0],
        });
        await dialog
          .getByRole("button", { name: "保存 Logo", exact: true })
          .click();
        await expect(
          dialog.getByText("Logo 已被其他人修改，请加载最新图片后再操作。", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(dialog.locator(".lm-logo-upload img")).toHaveAttribute(
          "src",
          /^data:image\/png/,
        );
        await dialog
          .getByRole("button", { name: "加载最新 Logo", exact: true })
          .click();
        await expect(dialog.locator(".lm-logo-upload img")).toHaveAttribute(
          "src",
          /^\/api\/v1/,
        );
        await dialog
          .getByRole("button", { name: "使用默认 Logo", exact: true })
          .click();
        await dialog
          .getByRole("button", { name: "保存 Logo", exact: true })
          .click();
        await expect(dialog).not.toBeVisible();
        custom = (await api("/ops/resources/" + custom.id)).resource;
        expect(custom.logo_url).toBeUndefined();
        await expect(card.locator("img")).toHaveCount(0);
        await card.getByRole("button", { name: "Logo", exact: true }).click();
        dialog = page.getByRole("dialog");
        await dialog.locator("input[type=file]").setInputFiles(file(2));
        await expect(dialog.locator(".lm-logo-upload img")).toHaveAttribute(
          "src",
          /^data:image\/png/,
        );
        await dialog
          .getByRole("button", { name: "保存 Logo", exact: true })
          .click();
        await expect(dialog).not.toBeVisible();
        custom = (await api("/ops/resources/" + custom.id)).resource;
        checks.push(
          "Real create with PNG, failure retry without duplicate, refresh, YAML create/edit preserving masked environment and runtime type, JPEG/WebP conversion, cancel, failed replacement, conflict/reload, remove/default and re-upload",
        );
      }
      const card = page.getByRole("article", {
        name: custom.name,
        exact: true,
      });
      await expect(card.locator("img")).toHaveAttribute("src", custom.logo_url);
      await expect
        .poll(() =>
          card.locator("img").evaluate((i) => i.complete && i.naturalWidth > 0),
        )
        .toBe(true);
      await shot("installed");
      await card.getByRole("button", { name: "Logo", exact: true }).click();
      let dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("button", {
          name: en ? "Upload logo" : "上传 Logo",
          exact: true,
        }),
      ).toBeVisible();
      await expect(dialog).not.toHaveClass(/ant-zoom-(appear|enter)/);
      await expect(dialog).toBeInViewport({ ratio: 0.5 });
      await shot("logo-editor");
      await dialog
        .getByRole("button", { name: en ? "Cancel" : /取\s*消/, exact: true })
        .click();
      await page
        .getByRole("article", { name: historical.name, exact: true })
        .getByRole("button", {
          name: en ? "Configure" : /配\s*置/,
          exact: true,
        })
        .click();
      dialog = page.getByRole("dialog");
      const yaml = dialog.getByLabel(
        en ? "Compose configuration (YAML)" : "Compose 配置（YAML）",
        { exact: true },
      );
      await expect(yaml).toHaveValue(/^services:/);
      await expect(
        dialog.getByText(
          en
            ? "Container ports are discovered from YAML. The platform assigns host ports; YAML host mappings are ignored."
            : "从 YAML 自动识别容器端口；宿主端口由平台分配，YAML 宿主映射不生效。",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(dialog).not.toHaveClass(/ant-zoom-(appear|enter)/);
      await expect(dialog).toBeInViewport({ ratio: 0.5 });
      await expect(
        dialog.getByRole("button", {
          name: en ? "Save configuration" : "保存配置",
          exact: true,
        }),
      ).toBeInViewport();
      await yaml.scrollIntoViewIfNeeded();
      await shot("managed-yaml");
      if (!en && width === 1440) {
        await yaml.fill(
          'services:\n  web:\n    image: nginx:alpine\n    environment:\n      TOKEN: "[redacted]"\n    ports:\n      - "45678:8080"\n    expose: [6379]\n',
        );
        await dialog
          .getByRole("button", { name: "保存配置", exact: true })
          .click();
        await expect(dialog).not.toBeVisible();
        const r = (await api("/ops/resources/" + historical.id)).resource;
        expect(r.spec.ports).toHaveLength(1);
        expect(r.spec.ports[0].host_port).toBe(0);
        expect(r.spec.ports[0].host_ip).toBe("127.0.0.1");
        expect(r.spec.ports[0].name).toBe("http");
      } else
        await dialog
          .getByRole("button", { name: en ? "Cancel" : /取\s*消/, exact: true })
          .click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      checks.push(
        `${language}/${appearance}/${width}: all 31 brand images decoded locally, persisted logo and editor, historical Compose displays YAML, managed-port guidance, no page overflow`,
      );
    } catch (error) {
      await shot("failure");
      await writeFile(
        resolve(out, "ui-failure.txt"),
        await page.locator("body").innerText(),
      );
      throw error;
    } finally {
      await context.close();
    }
  }
  expect(errors).toEqual([]);
  await writeFile(
    resolve(out, "ui.json"),
    JSON.stringify(
      {
        checks,
        errors,
        media: relative(root, media),
        backend: "Real HTTP/SQLite fixture; no remote Agent execution",
        network_failures: "Browser-injected 503 only for retry cases",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ checks, errors }));
} finally {
  await browser.close();
}
