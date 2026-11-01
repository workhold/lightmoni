import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mediaDirectory } from "../../../../scripts/qa-artifacts.mjs";
const base = process.env.LIGHTMONI_REGISTRY_UI_URL ?? "http://127.0.0.1:19960";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw Error("Disposable loopback QA server required");
const out = resolve(process.env.LIGHTMONI_REGISTRY_UI_OUT ?? "specs/059-service-image-lifecycle/evidence/ui"),
  media = mediaDirectory(out);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" }),
  rounds = [];
try {
  for (let round = 1; round <= 3; round++) {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        recordVideo: { dir: media, size: { width: 1440, height: 1000 } },
      }),
      page = await context.newPage(),
      errors = [],
      checks = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(15000);
    await context.addInitScript(() => {
      localStorage.setItem("lightmoni.language", "zh-CN");
      localStorage.setItem("lightmoni.appearance", "light");
    });
    const json = async (path, method = "GET", data) => {
      const r = await context.request.fetch(base + "/api/v1" + path, {
        method,
        data,
      });
      if (!r.ok())
        throw Error(path + " " + r.status() + ": " + (await r.text()));
      return r.json();
    };
    const closeProgress=async()=>{const p=page.locator('.lm-install-progress:visible');if(await p.count()){await p.getByRole('button',{name:'关闭',exact:true}).click();await expect(p).toHaveCount(0)}};
    const dialog = () => page.locator(".ant-modal:visible").last();
    const choose = async (label, value) => {
      await dialog().getByLabel(label, { exact: true }).click();
      await page
        .locator(".ant-select-dropdown:visible")
        .getByText(value, { exact: true })
        .click();
      await page.keyboard.press("Escape");
    };
    const shot = async (name) => {
      await expect
        .poll(() =>
          page.evaluate(() =>
            document
              .getAnimations()
              .filter(
                (a) => a.effect?.getComputedTiming().iterations !== Infinity,
              )
              .every((a) => a.playState !== "running"),
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: resolve(media, `round-${round}-${name}.png`),
        fullPage: true,
      });
    };
    try {
      if ((await json("/auth/me")).id !== "qa-admin")
        throw Error("QA administrator required");
      let all = (await json("/ops/overview")).resources;
      let c = all.find((r) => r.kind === "cluster" && r.name === "Registry QA");
      if (!c) {
        const machine = (await json("/ops/overview")).machines[0];
        c = (
          await json("/ops/resources", "POST", {
            kind: "cluster",
            name: "Registry QA",
            spec: {
              machine_ids: [machine.id],
              port_start: 22100,
              port_end: 22140,
              nodes: [
                {
                  machine_id: machine.id,
                  address: "127.0.0.1",
                  cpu: 4,
                  memory_mb: 4096,
                },
              ],
            },
          })
        ).resource;
      }
      const machine = (await json("/ops/overview")).machines.find((m) =>
        c.spec.machine_ids.includes(m.id),
      );
      await page.goto(base + "/websites");
      await page
        .getByRole("link", { name: "私有镜像管理", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "私有镜像管理", exact: true }),
      ).toBeVisible();
      let view = await json("/ops/private-registry");
      if (!view.application) {
        await expect(
          page.getByRole("button", {
            name: "安装 Docker Registry",
            exact: true,
          }),
        ).toBeVisible();
        await shot("empty");
        await page
          .getByRole("button", { name: "安装 Docker Registry", exact: true })
          .click();
      } else
        await page
          .getByRole("button", { name: "配置 / 重新部署", exact: true })
          .first()
          .click();
      await expect(dialog()).toBeVisible();
      await choose("部署集群", c.name);
      if (!view.application) await choose("部署机器", machine.name);
      await expect(
        dialog().getByLabel("内网监听 IP", { exact: true }),
      ).toHaveValue("127.0.0.1");
      await dialog()
        .getByRole("switch", { name: "开启内网镜像缓存", exact: true })
        .setChecked(true);
      await dialog().getByRole("checkbox").check();
      await dialog().getByLabel('宿主端口 · 私有仓库',{exact:true}).fill('24500');
      await dialog().getByLabel('宿主端口 · Docker Hub 缓存',{exact:true}).fill('24501');
      await dialog().getByLabel('宿主端口 · 发布源缓存',{exact:true}).fill('24502');
      await shot("installation");
      await dialog().getByLabel('宿主端口 · Docker Hub 缓存',{exact:true}).fill('24500');
      await dialog().getByRole('button',{name:'保存并部署',exact:true}).click();
      await expect(dialog().getByText('宿主端口不能重复；使用不同端口，或填 0 自动分配。',{exact:true})).toBeVisible();
      await expect(dialog().getByLabel('宿主端口 · 私有仓库',{exact:true})).toHaveValue('24500');
      await dialog().getByLabel('宿主端口 · Docker Hub 缓存',{exact:true}).fill('24501');
      await dialog()
        .getByRole("button", { name: "保存并部署", exact: true })
        .click();
      await expect(dialog()).toBeHidden();await closeProgress();
      view = await json("/ops/private-registry");
      expect(view.deployments[0].cache_enabled).toBe(true);expect(view.deployments[0].host_ports.registry).toBe(24500);
      expect(view.application.spec.service_name).toBe("sys-docker-registry");
      checks.push(
        "Navigation, private placement, three named host port mappings, duplicate rejection with input retention, fixed-port saved readback",
      );
      await page.reload();
      await expect(
        page.getByRole("switch", { name: "内网缓存 Registry QA", exact: true }),
      ).toBeChecked();
      await shot("deployed");
      await page
        .getByRole("switch", { name: "内网缓存 Registry QA", exact: true })
        .click();
      await expect(
        page.getByRole("switch", { name: "内网缓存 Registry QA", exact: true }),
      ).not.toBeChecked();
      expect(
        (await json("/ops/resources/" + c.id)).resource.spec.image_cache
          .enabled,
      ).toBe(false);
      await page.goto(base + "/clusters");
      const row = page
        .getByRole("row")
        .filter({ hasText: "Registry QA" })
        .first();
      await row.getByRole("button", { name: /^编\s*辑$/ }).click();
      await expect(
        dialog().getByRole("switch", { name: "集群内网镜像缓存", exact: true }),
      ).not.toBeChecked();
      await dialog()
        .getByRole("switch", { name: "集群内网镜像缓存", exact: true })
        .click();
      await dialog()
        .getByRole("button", { name: "保存配置", exact: true })
        .click();
      await expect(dialog()).toBeHidden();await closeProgress();
      await page.goto(base + "/private-images");
      await expect(
        page.getByRole("switch", { name: "内网缓存 Registry QA", exact: true }),
      ).toBeChecked();
      checks.push(
        "Both cache editors share one cluster setting and survive refresh",
      );
      await page
        .getByRole("button", { name: "配置 / 重新部署", exact: true })
        .first()
        .click();
      await expect(dialog().getByLabel('宿主端口 · 私有仓库',{exact:true})).toHaveValue('24500');
      await dialog().getByRole("checkbox").check();
      view = await json("/ops/private-registry");
      await json("/ops/private-registry/deployments", "POST", {
        confirmed: true,
        trusted_network_acknowledged: true,
        revision: view.revision,
        cluster_id: c.id,
        machine_id: machine.id,
        address: "127.0.0.1",
        cache_enabled: true,
      });
      await dialog()
        .getByRole("button", { name: "保存并部署", exact: true })
        .click();
      await expect(
        dialog().getByText("配置已更新，请刷新后重试。输入已保留。", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        dialog().getByLabel("内网监听 IP", { exact: true }),
      ).toHaveValue("127.0.0.1");
      await shot("revision-error");
      await dialog()
        .getByRole("button", { name: "保存并部署", exact: true })
        .click();
      await expect(dialog()).toBeHidden();await closeProgress();
      checks.push(
        "Real revision conflict retains form input and retry reuses the same registered service",
      );
      all = (await json("/ops/overview")).resources;
      let cert = all.find(
        (r) =>
          r.kind === "certificate" &&
          r.spec.domains.includes("registry.example.test"),
      );
      if (!cert)
        cert = (
          await json("/ops/resources", "POST", {
            kind: "certificate",
            name: "Registry QA TLS",
            spec: {
              source: "self_signed",
              domains: ["registry.example.test"],
              validity_days: 3,
            },
          })
        ).resource;
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await expect(page.locator(".ant-spin-spinning:visible")).toHaveCount(0);
      const publish = page.getByRole("button", {
        name: /设置对外入口|配置入口/,
        exact: true,
      });
      await publish.click();
      await expect(dialog()).toBeVisible();
      await dialog()
        .getByLabel("仓库域名", { exact: true })
        .fill("registry.example.test");
      await choose("HTTPS 证书", cert.name);
      await dialog().getByLabel("登录账号", { exact: true }).fill("qa-builder");
      if (!(await json("/ops/private-registry")).external.website)
        await dialog()
          .getByLabel("登录密码", { exact: true })
          .fill("synthetic-qa-password");
      await dialog().getByRole("checkbox").check();
      await shot("publishing");
      await dialog()
        .getByRole("button", { name: "保存并部署", exact: true })
        .click();
      await expect(dialog()).toBeHidden();await closeProgress();
      view = await json("/ops/private-registry");
      expect(view.external.website.spec.auth.mode).toBe("basic");
      expect(JSON.stringify(view)).not.toContain("password_hash");
      expect(JSON.stringify(view)).not.toContain("synthetic-qa-password");
      checks.push(
        "Publishing form links a real HTTPS/Basic website and returns no password/hash",
      );
      await page
        .getByRole("link", { name: "私有镜像仓库入口", exact: true })
        .click();
      await page
        .getByRole("row")
        .filter({ hasText: "私有镜像仓库入口" })
        .first()
        .getByRole("button", { name: /^编\s*辑$/ })
        .click();
      await expect(
        dialog().getByLabel("网站访问鉴权", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog().getByLabel("账号", { exact: true }).last(),
      ).toHaveValue("qa-builder");
      await expect(
        dialog().getByLabel("密码（同名账号留空保留）", { exact: true }).last(),
      ).toHaveValue("");
      await dialog()
        .getByLabel("网站访问鉴权", { exact: true })
        .scrollIntoViewIfNeeded();
      await shot("website-auth");
      await dialog()
        .getByLabel("路径访问鉴权", { exact: true })
        .first()
        .scrollIntoViewIfNeeded();
      await shot("website-path-auth");
      await dialog()
        .getByRole("button", { name: /^取\s*消$/ })
        .click();
      checks.push(
        "Linked website editor exposes site/path auth; write-only password stays empty",
      );
      await page.goto(base + "/private-images");
      await expect(
        page.getByText("https://registry.example.test", { exact: true }),
      ).toBeVisible();
      await shot("complete");
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      await shot("zoom-200");
      await page.evaluate(() => {
        document.documentElement.style.zoom = "1";
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("button", { name: "配置入口", exact: true }).click();
      await expect(dialog()).toBeVisible();
      await dialog()
        .getByRole("button", { name: /^取\s*消$/ })
        .click();
      await expect(dialog()).toBeHidden();await closeProgress();
      checks.push("200% view and reduced-motion modal open/close");
      await page.setViewportSize({ width: 390, height: 844 });
      await shot("mobile");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      checks.push("Narrow layout keeps horizontal overflow inside the table");
      expect(errors).toEqual([]);
      rounds.push({ round, ok: true, checks, errors });
    } catch (e) {
      await page.screenshot({
        path: resolve(media, `round-${round}-failure.png`),
        fullPage: true,
      });
      rounds.push({ round, ok: false, checks, errors, error: e.message });
      throw e;
    } finally {
      await context.close();
      await writeFile(
        resolve(out, "report.json"),
        JSON.stringify({ rounds, media }, null, 2),
      );
    }
  }
  // Freeze the real CSS entrance at 80 ms so review does not miss its short middle frame.
  const visual = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await visual.addInitScript(() => {
    localStorage.setItem("lightmoni.language", "zh-CN");
    localStorage.setItem("lightmoni.appearance", "dark");
    const timer = setInterval(() => {
      const entry = document.querySelector(".lm-registry-entry");
      const animation = entry
        ?.getAnimations()
        .find((a) => a.animationName === "lm-ops-enter");
      if (animation) {
        animation.pause();
        animation.currentTime = 80;
        window.__qaEntry = animation;
        clearInterval(timer);
      }
    }, 5);
  });
  const visualPage = await visual.newPage();
  await visualPage.goto(base + "/private-images");
  await expect(visualPage.locator(".lm-registry-entry")).toBeVisible();
  await expect
    .poll(() => visualPage.evaluate(() => !!window.__qaEntry))
    .toBe(true);
  await visualPage.screenshot({
    path: resolve(media, "entry-middle-dark.png"),
    fullPage: true,
  });
  await visualPage.evaluate(() => window.__qaEntry.finish());
  await visualPage.screenshot({
    path: resolve(media, "current-dark.png"),
    fullPage: true,
  });
  const primary = visualPage.locator(".lm-page-heading .ant-btn-primary");
  await primary.hover();
  await visualPage.mouse.down();
  await expect
    .poll(() => primary.evaluate((el) => getComputedStyle(el).transform))
    .not.toBe("none");
  await visualPage.screenshot({
    path: resolve(media, "primary-pressed-dark.png"),
    fullPage: true,
  });
  await visualPage.mouse.up();
  await expect(visualPage.locator(".ant-modal:visible")).toBeVisible();
  await expect
    .poll(() =>
      visualPage.evaluate(() =>
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .every((a) => a.playState !== "running"),
      ),
    )
    .toBe(true);
  await visualPage.screenshot({
    path: resolve(media, "modal-current-dark.png"),
    fullPage: true,
  });
  await visual.close();
} finally {
  await browser.close();
}
process.stdout.write(JSON.stringify({ rounds, media }, null, 2) + "\n");
