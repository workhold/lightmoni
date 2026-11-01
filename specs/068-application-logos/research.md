# Research

- Decision: 品牌素材本地静态打包，按稳定模板 ID 关联，来源/固定提交/摘要随素材记录。Rationale: 31 项目录离线可显示、既有记录立即兼容；不运行时访问第三方 CDN。Sources: Simple Icons 官方 CC0 及各项目官方仓库，素材研究独立进行。
- Decision: Logo 使用独立表和版本，GET 公共投影仅返回 URL/版本。Rationale: 应用配置不可变修订与 Agent 任务保持原边界；修改图形无需重部署，避免每次概览返回图片正文。Alternative: spec 内 data URL 会进入修订和执行投影，拒绝采用。
- Decision: 创建应用与可选 Logo 在同一现有 SQLite 事务提交，更新 Logo 使用单独版本比较。Rationale: 失败无应用孤儿，删除和替换没有并发覆盖或 ABA；不要求应用执行空闲。
- Decision: 浏览器把用户 PNG/JPEG/WebP 归一化为 PNG，中心验证全部 PNG 结构与有界解压并移除附加元数据。Rationale: 真实图片可用、透明背景可保留；不需要 SVG 清洗器、外部服务或新增解码依赖。
- Decision: 内置可信 SVG 作为 img 使用，用户上传不接收 SVG/HTML/URL；输出固定 MIME、nosniff、CSP，认证后 ETag 回应。Rationale: 用户文件不形成同源可执行内容；版本 URL 避免旧图缓存显示新内容。

- Decision: 统一用固定 yaml 2.9.1 生成可编辑 YAML，旧 Compose 对象直接转换；保存后回显规范化 YAML，不保留注释、原始字符串或锚点文本。Rationale: 避免原始源重复存储环境秘密，同时修复 JSON 展示；新增网页依赖与运行时版本一致。
- Decision: 中心先解析 YAML，再按服务和键恢复已有 [redacted] 值；解析后移除 x-* 扩展，公共投影也清理历史扩展别名。Rationale: 避免字符串模式丢失已有环境变量或扩展锚点绕过脱敏，新键占位仍拒绝。
- Decision: configuration_mode=yaml 时从 services.*.ports 发现发布目标；托管忽略 published，保持已有端口名称、应用协议与监听范围，expose 保持内部；手动模式采用 YAML 映射。Rationale: 保持平台分配和服务发现控制权，避免修改配置扩大监听范围或破坏网站引用。
- Decision: 单容器高级 YAML 使用 services.app，保留 container 类型和平台部署/挂载/健康信息；不支持的多服务和字段明确拒绝，用户可选择 Docker Compose。Rationale: 不静默丢失不可表达配置，不新增 Agent 协议。
- Final assets: 31 个唯一品牌图已固定提交、SHA256 和许可；Simple Icons、项目官方仓库、Devicon 和 EMQX Dashboard Icons 的具体来源随 sources.json 和许可文件交付，界面可查看来源。
