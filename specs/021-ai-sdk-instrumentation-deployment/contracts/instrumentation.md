# SDD 021：SDK 插桩契约

> 本文件是目标契约。当前扫描器返回 `plan_id`、`workspace`、`base_revision`、`languages`、`frameworks`、`package_managers`、`sdk`、`candidates`、`warnings` 和 `files_scanned`。AI 可以基于授权 workspace 生成只读、可审阅的结构化插桩计划；应用 diff、构建和部署仍由后续受控流程负责。

## 扫描报告

Scanner 是只读、无执行的分析器。输入为授权 workspace、base revision 和可选语言提示。输出必须包含：

```ts
interface ScanReport {
  baseRevision: string;
  languages: Array<"typescript"|"javascript"|"python"|"go"|"rust"|"unknown">;
  packageManagers: string[];
  frameworks: string[];
  sdk: {found: boolean; package?: string; version?: string; mode?: "direct"|"agent"};
  serviceCandidates: Array<{name: string; source: string; confidence: number}>;
  instrumentationCandidates: Array<{
    file: string;
    kind: "request_boundary"|"job_boundary"|"error_boundary"|"startup"|"custom_metric";
    confidence: number;
    reason: string;
  }>;
  warnings: string[];
}
```

扫描器不能读取 `.env`/私钥等 secret 内容；只报告配置键名和引用位置。解析失败或置信度低时保留报告并要求手动步骤。

## 插桩计划和 diff

### AI 工具：`propose_sdk_instrumentation`

该工具只生成计划，不写入 workspace、不执行项目代码、不安装依赖，也不代表管理员批准。调用者应先运行 `scan_sdk_instrumentation`，再把用户确认的意图传入：

```ts
interface ProposeSdkInstrumentationInput {
  workspace: string;
  intent: string;
  base_revision?: string;
  service?: string;
  env?: string;
  mode?: "direct" | "agent";
  table?: string;
  metric?: string;
}
```

如果调用者先执行扫描，应把扫描返回的 `base_revision` 原样传回；版本不匹配时提案返回 `revision conflict`，避免基于过期源码生成可应用 diff。

返回的 `state` 固定为 `awaiting_approval`，并绑定本次扫描得到的 `base_revision`：

```ts
interface InstrumentationPlan {
  plan_id: string;
  workspace: string;
  base_revision: string;
  state: "awaiting_approval";
  intent: string;
  files: Array<{
    path: string;
    summary: string;
    patch: string;
    operations: Array<{op: "insert"; line: number; content: string}>;
    risks: string[];
    validation_steps: string[];
  }>;
  manual_steps: string[];
  warnings: string[];
  validation_steps: string[];
}
```

当无法安全定位插桩位置时，`files` 可以为空，必须给出 `manual_steps` 和原因；工具不能为了生成 diff 而猜测业务语义或引入新依赖。

计划必须绑定 `baseRevision`。每个变更文件带相对路径、摘要、结构化 patch、风险和验证命令。允许的首批插桩目标：

- 程序启动：初始化 SDK 和服务/env 标识。
- HTTP/RPC 请求边界：记录请求计数、耗时和异常。
- 任务/消息边界：记录任务名称、耗时和失败。
- 自定义打点：按用户明确提供的表、字段和维度生成调用。

不得默认捕获原始请求体、Authorization、Cookie、私钥、密码或完整用户输入。涉及不确定业务语义、跨多个模块的重构或生成新依赖时，输出手动建议而非自动 patch。

## 应用规则

- 应用前检查 workspace 仍在 `baseRevision`；不匹配返回 `revision_conflict`。
- 只允许 workspace 根内的普通文件；拒绝绝对路径、`..`、符号链接逃逸、控制字符和超大文件。
- apply 记录 diff、操作者、时间、result revision 和验证结果；失败不得留下部分写入。
- SDK 模式变更只能写入公开 endpoint、service/env 和受保护 secret 引用；不把中心 credential 注入源码。

## 验证规则

应用后至少运行语言对应的格式/类型/单元检查（若项目存在），再运行 SDK dry-run 或最小本地事件构造。真实生产遥测由部署后验证负责，代码检查通过不等于数据已经入库。
