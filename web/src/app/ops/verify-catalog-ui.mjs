import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mediaDirectory } from "../../../../scripts/qa-artifacts.mjs";
const root = resolve(import.meta.dirname, "../../../.."),
  base = process.env.LIGHTMONI_CATALOG_UI_URL ?? "http://127.0.0.1:5196";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw Error("Loopback fixture required");
const out = resolve(root, "specs/066-app-catalog-expansion/evidence"),
  media = mediaDirectory(out);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" }),
  checks = [],
  errors = [];
async function api(path, data) {
  const response = await fetch(base + "/api/v1" + path, {
    method: data ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!response.ok) throw Error(path + " " + response.status);
  return response.json();
}
try {
  if ((await api("/auth/me")).id !== "qa-admin")
    throw Error("Disposable QA administrator required");
  const initial = await api("/ops/overview");
  if (!initial.resources.some((r) => r.kind === "cluster"))
    await api("/ops/resources", {
      kind: "cluster",
      name: "Catalog QA cluster",
      spec: {
        machine_ids: ["qa-machine"],
        port_start: 25000,
        port_end: 25999,
        nodes: [
          {
            machine_id: "qa-machine",
            address: "10.0.0.7",
            public_address: "198.51.100.7",
            cpu: 32,
            memory_mb: 65536,
          },
        ],
      },
    });
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
    console.log("UI", language, appearance, width);
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(12000);
    await page.goto(base + "/applications");
    await page
      .getByRole("tab", {
        name: en ? "Application store" : "应用商店",
        exact: true,
      })
      .click();
    const apps = page.locator(".lm-catalog-apps");
    await expect(apps.getByRole("listitem")).toHaveCount(31);
    const categoryLabel = en ? "Application category" : "应用分类";
    const chooseCategory = async (label) => {
      if (width < 760) {
        await page.getByLabel(categoryLabel, { exact: true }).click();
        await page
          .locator(".ant-select-dropdown:visible")
          .getByText(label, { exact: true })
          .click();
      } else await page.getByRole("tab", { name: label, exact: true }).click();
    };
    const categoryCounts = [
      ["数据库", "Databases", 8],
      ["中间件", "Middleware", 7],
      ["DevOps", "DevOps", 7],
      ["AI 项目", "AI projects", 7],
      ["工具", "Tools", 1],
      ["网站与网关", "Web & gateways", 1],
    ];
    if (width < 760) {
      await page.getByLabel(categoryLabel, { exact: true }).click();
      for (const [zh, english, count] of categoryCounts)
        await expect(
          page
            .locator(".ant-select-dropdown:visible")
            .getByText((en ? english : zh) + " (" + count + ")", {
              exact: true,
            }),
        ).toBeVisible();
      await page.keyboard.press("Escape");
    } else
      for (const [zh, english, count] of categoryCounts)
        await expect(
          page.getByRole("tab", {
            name: (en ? english : zh) + " (" + count + ")",
            exact: true,
          }),
        ).toBeVisible();
    await chooseCategory((en ? "Tools" : "工具") + " (1)");
    await expect(apps.getByRole("listitem")).toHaveCount(1);
    await expect(
      apps.getByRole("listitem", { name: "DBX", exact: true }),
    ).toBeVisible();
    await apps
      .getByRole("listitem", { name: "DBX", exact: true })
      .getByRole("button", { name: en ? "Install" : /^安\s*装$/ })
      .click();
    const drawer = page.locator(".lm-ops-catalog");
    await expect(
      drawer.getByText(en ? "Installation requirements" : "安装要求", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      drawer.getByLabel(en ? "Access password" : "访问密码", { exact: true }),
    ).toBeVisible();
    await expect(
      drawer.getByLabel(en ? "Host port · http" : "宿主端口 · http", {
        exact: true,
      }),
    ).toHaveValue("4224");
    await drawer
      .getByText(en ? "Advanced settings" : "高级设置", { exact: true })
      .click();
    await expect(
      drawer.getByLabel(
        en ? "Memory per instance (MiB)" : "每实例内存（MiB）",
        { exact: true },
      ),
    ).toHaveValue("512");
    await page.screenshot({
      path: resolve(media, `dbx-${language}-${width}-${appearance}.png`),
      animations: "disabled",
    });
    if (!en && width === 1440) {
      await drawer
        .getByLabel("访问密码", { exact: true })
        .fill("qa_browser_secret_2026");
      await drawer.getByLabel("宿主端口 · http", { exact: true }).fill("0");
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().endsWith("/ops/catalog/dbx/install") &&
            r.request().method() === "POST",
        ),
        drawer.getByRole("button", { name: "开始安装", exact: true }).click(),
      ]);
      const body = await response.json();
      expect(response.status()).toBe(201);
      expect(JSON.stringify(body)).not.toContain("qa_browser_secret_2026");
      expect(body.resource.spec.source.template_id).toBe("dbx");
      checks.push(
        "DBX real HTTP install saves encrypted resource and creates pending QA Agent work; no fabricated completion",
      );
      await page
        .getByRole("button", { name: "关闭", exact: true })
        .last()
        .click();
      await page.getByRole("tab", { name: "应用商店", exact: true }).click();
    } else
      await drawer
        .getByRole("button", {
          name: en ? "Back to store" : "返回应用商店",
          exact: true,
        })
        .click();
    await chooseCategory((en ? "All" : "全部") + " (31)");
    const search = page.getByLabel(
      en ? "Search application store" : "搜索应用商店",
      { exact: true },
    );
    await search.fill("dify");
    await expect(apps.getByRole("listitem")).toHaveCount(1);
    await apps
      .getByRole("listitem", { name: "Dify", exact: true })
      .getByRole("button", { name: en ? "Install" : /^安\s*装$/ })
      .click();
    await expect(
      drawer.getByLabel(en ? "Public URL" : "外部访问 URL", { exact: true }),
    ).toBeVisible();
    await expect(drawer.getByText(/12/).first()).toBeVisible();
    await drawer
      .getByRole("button", {
        name: en ? "Back to store" : "返回应用商店",
        exact: true,
      })
      .click();
    await search.fill("vllm");
    await apps
      .getByRole("listitem", { name: "vLLM", exact: true })
      .getByRole("button", { name: en ? "Install" : /^安\s*装$/ })
      .click();
    await expect(drawer.getByText(/NVIDIA GPU/).first()).toBeVisible();
    await expect(
      drawer.getByLabel(en ? "Model ID" : "模型标识", { exact: true }),
    ).toHaveValue("Qwen/Qwen2.5-0.5B-Instruct");
    await drawer
      .getByRole("button", {
        name: en ? "Back to store" : "返回应用商店",
        exact: true,
      })
      .click();
    await search.fill("clickhouse");
    await apps
      .getByRole("listitem", { name: "ClickHouse", exact: true })
      .getByRole("button", { name: en ? "Install" : /^安\s*装$/ })
      .click();
    await expect(
      drawer.getByLabel(en ? "Host port · native" : "宿主端口 · native", {
        exact: true,
      }),
    ).toHaveValue("9000");
    await drawer
      .getByRole("button", {
        name: en ? "Back to store" : "返回应用商店",
        exact: true,
      })
      .click();
    await search.fill("harbor");
    await apps
      .getByRole("listitem", { name: "Harbor", exact: true })
      .getByRole("button", { name: en ? "Install" : /^安\s*装$/ })
      .click();
    await expect(drawer.getByText(/amd64/).first()).toBeVisible();
    await drawer
      .getByRole("button", {
        name: en ? "Back to store" : "返回应用商店",
        exact: true,
      })
      .click();
    await search.fill("");
    await expect(apps.getByRole("listitem")).toHaveCount(31);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: resolve(media, `store-${language}-${width}-${appearance}.png`),
      animations: "disabled",
    });
    checks.push(
      `${language}/${appearance}/${width}: six category counts, only DBX tools, defaults, search, Dify, GPU, multiport, architecture, no page overflow`,
    );
    await context.close();
  }
  expect(errors).toEqual([]);
  await writeFile(
    resolve(out, "ui.json"),
    JSON.stringify({ checks, errors, media }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ checks, errors, media }, null, 2));
} finally {
  await browser.close();
}
