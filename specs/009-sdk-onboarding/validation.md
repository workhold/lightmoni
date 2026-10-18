# SDK 接入验收

日期：2026-10-18。分支：`codex/sdk-onboarding`；提交前同步 `origin/main`，基线 `88b2108`。

## 结果

- 导航改为 SDK 接入，页面恰有 SDK 样例 / SDK 密钥 / 豁免表三个 Tab；四种样例及安装目录为 Go / Node.js / Rust / Python。
- 空密钥下拉仅含创建按钮；非空下拉底部有创建入口。就地创建仅填名称，授权当前逻辑表并选中，完整值只存当前页面内存；旧密钥指名占位，不恢复历史明文。
- 无密钥显式选择，仅接受已启用的精确豁免表。推荐名有 16 位随机后缀，需管理员保存后才授权；错误/禁用密钥不得降级，匿名身份为空，匿名批次独立去重，不路由系统表，撤销后重试也拒绝。
- 执行节点安装移至 `/agents/install`，单表保留/日志规则移至 `/admin?tab=tables`，旧链接兼容；大盘编辑器继续提供模板。
- 实际样例联调发现并修复 Python 3.9 完整 HTTP 响应关闭 socket 后的误报；修复已进入可下载 Python 包。

## 自动与真实联调

| 检查 | 结果 |
| --- | --- |
| runtime / web 类型检查、git diff --check | 通过 |
| core/security/routes/nodes/ingest/domains/otlp 相关后端检查 | 74 项，73 通过，1 个既有 Go 对照基线用例跳过，无失败 |
| 四语言生成、无密钥清除旧环境变量、shell 转义和复杂表名 | 4 项通过 |
| Python SDK 完整检查（含真实 close/chunked 响应回归） | Python 3.9.6，26 项通过 |
| 实际 Go / Node.js / Python 样例 | 带密钥与无密钥共 6 组通过，真实 ClickHouse 读回服务/密钥身份匹配 |
| 浏览器流程 | 主 Agent 连续 3 轮通过，pageerror 均为 0；真实 API/ClickHouse，只有创建失败场景注入 503 |
| 源码打包、后端和前端构建、本地镜像构建 | 通过；保留既有基础镜像及未变更的 AI/Agent 运行时 |
| 原有实例更新 | `http://localhost:18380/data`，健康、管理员登录、前端字节、Python 下载包均核验通过 |

Go 对照基线用例要求旧实现基线夹具，本机未提供该夹具；真实 Go 1.26.3 样例已另行运行通过。Rust 通过生成/界面校验，因本机无 Cargo 未运行 Rust 编译或实际上报，不声称四语言全部实机验收。前端生产构建沿用现有模块级 use client 提示，无编译失败。

## 页面与视觉

沿用现有深色工作台、AntD 和蓝色主操作，配置先于代码。独立存量界面评审未发现阻断问题，不评分；采纳安装代码横向滚动/复制、放大后推荐卡自动换列与删去页头重复 Tab 说明。390px、CSS 200% 溢出检查通过。200% 截图额外用 720 CSS px / 2x 密度模拟 1440px 屏幕放大，避免 Chromium 对 CSS zoom 的整页拼接失真。

动效为配置区首屏 220ms 淡入、认证区域切换 160ms 淡入，以及创建按钮 loading → 已创建并选中。前两者实际采集 0/50%/100% 时刻的 opacity/transform；创建记录开始、进行中、完成三帧，完成帧遮罩密钥正文。减少动态效果模式已检查。

文字减法删除原八语言说明、浏览器/JVM 旁支说明和重复页头副标题，保留认证范围、复杂表名依据与密钥一次性展示说明。

## 证据与复跑

文本报告位于 [docs/evidence/sdk-onboarding](../../docs/evidence/sdk-onboarding/README.md)，截图与动效帧位于 `artifacts/screenshots/docs/evidence/sdk-onboarding/`（本地媒体不纳入 Git）。隔离浏览器与 SDK 联调不得并行清理同一套测试密钥/豁免名单。

```sh
npm --prefix web run typecheck
npm --prefix runtime run typecheck
node --test web/src/app/sdkExamples.test.mjs
(cd runtime && node --import tsx --test test/core.test.ts test/security-compat.test.ts test/routes.test.ts test/nodes.test.ts test/ingest-compat.test.ts test/domains.test.ts test/otlp.test.ts)
PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests
```

隔离中心 18886 / Vite 15176 / ClickHouse 18123 准备好后，依次运行 `node web/src/app/verify-sdk-onboarding.mjs`、`LIGHTMONI_QA_RUN=2 node web/src/app/verify-sdk-onboarding.mjs`、`LIGHTMONI_QA_RUN=3 node web/src/app/verify-sdk-onboarding.mjs`，随后运行 `node scripts/verify-sdk-demos.mjs` 和 `node scripts/verify-sdk-motion.mjs`。脚本只用于上述隔离测试账号和数据，不指向用户运行实例。
