# 数据模型

## CodeTaskInput

```ts
{
  task: string;
  workspace: string;
  allowed_paths?: string[];
  allowed_commands?: string[];
  max_steps?: number;
  timeout_ms?: number;
}
```

## CodeTaskResult

```ts
{
  id: string;
  workspace?: string;
  status: "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
  summary: string;
  diff: string;
  changed_files: string[];
  checks: Array<{
    command: string;
    status: "passed" | "failed" | "skipped";
    output: string;
  }>;
  steps: Array<{
    index: number;
    action: string;
    status: "started" | "completed" | "failed" | "cancelled";
  }>;
  created_at: string;
  expires_at: string;
}
```

`awaiting_approval` 的结果包含 sandbox 产生的 diff，但不会把 sandbox 写回原 workspace。应用操作只接受未过期、归属当前用户且尚未应用的结果。

中心 Store 中的任务记录额外保存 owner、真实 workspace、beforeHash、待应用文本及 applied 标志，使用 master key 加密。外部接口只返回相对工作区；缓存采用副本，持久化失败不会使内存预览可审批。running 记录重启后标为 failed；已过期结果不可读取/应用，已应用操作幂等。
