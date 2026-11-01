# Tasks: 应用商店扩展与 DBX

**Input**: spec.md、plan.md、research.md、data-model.md、contracts/catalog.md、quickstart.md。

## Phase 1: Setup

- [X] T001 核对 origin/main、创建功能分支并在 specs/066-app-catalog-expansion/ 完成规格和设计。
- [X] T002 核对 .gitignore/.dockerignore 和现有 Node/Docker/浏览器验证工具，不新增依赖。

## Phase 2: Foundational

- [X] T003 在 runtime/src/ops/catalog/types.ts 和 index.ts 实现模板元数据、参数边界与构建器。
- [X] T004 在 runtime/test/application-catalog.test.ts 先建立范围、参数负例、依赖和秘密不泄露验收。

## Phase 3: US1 - 完整商店目录

独立验收：GET catalog 含 31 个唯一标识、6 类且工具仅 DBX。

- [X] T005 [US1] 在 runtime/src/ops/catalog/ 注册全部 27 个新模板与官方来源、固定版本。
- [X] T006 [US1] 在 runtime/src/ops/catalog.ts 整合旧模板及分类并保持兼容。
- [X] T007 [US1] 在 web/src/app/ops/model.ts 和 CatalogDrawer.tsx 显示中英文描述、分类和资源建议。

## Phase 4: US2 - 安装闭环

独立验收：全部安装配置可验证；DBX 与代表性服务真实 Docker 冒烟；复杂参数和初始化有负例。

- [X] T008 [US2] 在 runtime/src/ops/catalog/ 实现数据库、中间件、DevOps、AI 与 DBX 的安装构建和内部依赖。
- [X] T009 [US2] 在 runtime/src/operations/platform.ts 实现一次性初始化正常退出判定和有界重型启动等待。
- [X] T010 [US2] 在 web/src/app/ops/CatalogInstallFields.tsx 展示参数规则、安装要求与受限部署模式。
- [X] T011 [US2] 在 runtime/test/platform-clusters.test.ts 验证实际 HTTP/SQLite 资源、回读脱敏与 Agent 配方投影。
- [X] T012 [US2] 在 web/src/app/ops/verify-catalog-ui.mjs 验证中英文分类、搜索、DBX、复杂应用、390px和深浅色。

## Phase 5: Polish & Evidence

- [X] T013 在 docs/system-design.md 和 Doca 系统设计基线同步目录构建/初始化/第三方 AI 边界并回读保留原生图。
- [X] T014 在 specs/066-app-catalog-expansion/validation.md 记录类型、定向测试、Compose 与真实 Docker/浏览器覆盖及限制。
- [X] T015 在 specs/066-app-catalog-expansion/validation.md 记录最终 diff、远端主干同步和交付状态。

## Dependencies

T001→T002→T003/T004→T005→T006→T007；T008 依赖 T003/T004/T005，T009/T010 依赖安装契约，T011/T012 依赖实现；T013/T014/T015 完成交付。独立研究可并行，应用代码顺序编辑。

## Parallel examples

US1 的官方镜像研究和 UI 文案核对可独立进行；US2 的 Compose 静态检查与浏览器检查在实现完成后可并行运行。共享代码文件顺序修改。

## Implementation strategy

先生成所有条目和参数契约，再补齐依赖与安装表单，最后真实验证和架构同步。本轮范围包含全部批准项目，不以首批 MVP 取代完整需求。
