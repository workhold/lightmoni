# SDD 020：验证记录

## 文档与规则

- [x] `AGENTS.md` 明确架构变更范围、仓库/Doca 双端同步、原生图块保留、写入后回读和失败处理。
- [x] `.specify/memory/constitution.md` 升级到 1.3.0，并把双端一致性纳入 SDD 工作流。
- [x] `docs/system-design.md` 提供维护规则、固定 Doca 链接和 SDD 020 索引。
- [x] 本 SDD 的 spec、plan、tasks、validation 已建立。

## Doca 同步证据

- 目标：[Doca：LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)
- 写入结果：成功，返回 `saved: true`，文档版本序列从 192 更新到 193。
- 回读结果：成功读取新增标题及三段规则，确认双端同步、原生图块保留、回读验收、失败处理和凭据禁入要求均已保存。
- 视觉限制：本次只追加原生富文本规则，没有声称浏览器视觉验收；已有图块未重建。

## 安全与链接

- [x] 使用 `rg` 检查本次变更，未把 Doca token、密钥或密码写入仓库文件。
- [x] 固定 Doca 链接可访问格式正确，仓库相对链接指向存在的文件。
- [x] PR #24 已创建并保持待评审、未合并；PR 描述包含架构影响判断、仓库章节、Doca 链接、写入与回读证据。
