# SDD 020：实施计划

## 方案

把规则放在仓库级 `AGENTS.md`，使后续 Codex 会话在项目根目录直接继承；在 constitution 中固化为治理原则；在 `docs/system-design.md` 放置权威规则和 Doca 链接；用本 SDD 记录判定、流程和验收。Spec Kit 上游模板保持不变，避免修改第三方模板。

## 变更面

- `AGENTS.md`：所有开发者必须执行的硬规则。
- `.specify/memory/constitution.md`：SDD 工作流和版本治理。
- `docs/system-design.md`：总设计的维护规则与在线副本链接。
- `specs/020-architecture-design-sync/*`：需求、计划、任务和验证证据。
- Doca 在线文档：追加同语义的原生富文本章节，保留已有图块。

## 风险与控制

- Doca 写入冲突：先读最新 `seq`/`epochId`，失败后重新读取，不重复追加。
- 图示破坏：只操作目标原生块，写入后读取节点/边，不整文重建。
- 凭据泄露：token 仅由运行时受保护凭据提供，检查 diff、日志和 PR 内容。
