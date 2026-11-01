# Feature Specification: 应用商店扩展与 DBX

**Feature Branch**: `codex/066-app-catalog-expansion`
**Created**: 2026-11-01
**Status**: Implemented; validation evidence recorded
**Input**: 工具只加入 DBX，前一轮清单的数据库、中间件、DevOps、AI 项目全部加入商店。

## User Scenarios & Testing

### User Story 1 - 找到全部批准应用 (Priority: P1)

管理员按分类和名称查找常见服务与 AI 项目，避免自行编写部署配置。

**Why this priority**: 完整覆盖用户已确认的范围。
**Independent Test**: 核对 27 个新增条目，原有 4 个条目仍可用。

**Acceptance Scenarios**:

1. **Given** 商店打开，**When** 切换分类，**Then** 数据库新增 PostgreSQL、MariaDB、MongoDB、ClickHouse、Elasticsearch、Qdrant、InfluxDB；中间件新增 RabbitMQ、Nacos、EMQX、Memcached、Kafka、RocketMQ；DevOps 新增 Gitea、Jenkins、GitLab CE、Harbor、Nexus Repository、SonarQube Community Build；AI 新增 Ollama、Open WebUI、MaxKB、AnythingLLM、Dify、FastGPT、vLLM；工具只新增 DBX。
2. **Given** 旧安装记录，**When** 浏览与安装，**Then** MySQL、Redis、OpenResty、Docker Registry 的标识和配置兼容；Redis 归中间件，Registry 归 DevOps；共 31 个条目、6 个分类。
3. **Given** 中英文界面，**When** 搜索和查看，**Then** 分类、描述、参数与安装要求均可理解；不加入此前工具清单的其他 9 个项目。

### User Story 2 - 安装具有明确要求的服务 (Priority: P1)

管理员填写连接、凭据和外部地址等参数，在目标机器部署独立服务或多容器应用。

**Why this priority**: 上架必须有实际安装配方，卡片数量不代表服务可用。
**Independent Test**: 校验所有条目的版本、参数、端口、依赖、持久数据声明；对单服务、多服务和 DBX 执行集成验收。

**Acceptance Scenarios**:

1. **Given** 选择应用，**When** 打开表单，**Then** 展示必需参数、合理默认资源、官方文档和初始化要求；本地数据应用默认指定机器；GPU 模板明确运行前提。
2. **Given** 参数缺失、类型错误、非法 URL 或越界端口，**When** 提交，**Then** 创建前拒绝并返回固定错误码；凭据不进入日志、浏览器回读或非秘密配置文本。
3. **Given** 有持久数据或依赖服务，**When** 安装两次，**Then** 每套数据卷和网络独立；初始化任务退出 0 不误判应用故障，非 0 不视作安装成功。
4. **Given** Kafka、RocketMQ、GitLab 或 Harbor 依赖稳定地址，**When** 安装，**Then** 要求明确地址及固定端口、限制不兼容的自动调度，并说明作用；不生成无效广播地址。
5. **Given** DBX 安装，**When** 启动，**Then** 使用管理员设置的访问密码并持久保存数据；不自动连接 LightMoni 内部数据库或取得平台凭据。

### Edge Cases

- 多次安装、命名端口覆盖、手动/托管模式与旧参数兼容。
- 参数中引号、美元符号、换行与 URL 保留字符；秘密仅经环境传递。
- 非 root 镜像写卷权限；初始化服务退出成功与失败的区分。
- 内部依赖不发布宿主端口；秘密无固定默认值。
- 缺少镜像架构、模型授权或 GPU 驱动时真实失败，不虚构通过。

## Requirements

### Functional Requirements

- **FR-001** 必须包含批准的 27 个新增和原有 4 个应用；工具类仅 DBX。
- **FR-002** 每个新增应用提供固定镜像版本、官方来源、安装配方、明确端口和数据声明。
- **FR-003** 验证参数、稳定外部地址/端口与部署模式；沿用权限、修订、Agent 与回执。
- **FR-004** 复杂应用包含完整依赖或明确要求可连接的外部依赖，不能以单个前端冒充平台。
- **FR-005** 表单提供中英文说明、资源建议和必要运行前提。
- **FR-006** 凭据沿用加密存储与回读脱敏，不进入代码、日志、文档、URL 或 PR。
- **FR-007** 架构同步仓库与 Doca，保留原生图和无关内容，写后回读验证。

### Key Entities

- 应用模板：稳定标识、分类、版本、官方来源、说明、参数、资源建议与部署配方。
- 安装参数：公开配置和只在安装时提交的秘密；默认值与边界规则明确。
- 应用实例：沿用已有资源、修订、集群部署、端口预留和 Agent 状态。

## Success Criteria

- **SC-001** 展示 31 个应用，新增 27 个均可进入安装，工具只有 DBX。
- **SC-002** 新增配置通过参数负例、依赖、端口和一致性检查；旧行为回归通过。
- **SC-003** 浏览器验证分类搜索、DBX、多端口与复杂应用表单，移动宽度无溢出。
- **SC-004** 分别记录真实容器验证与受控回执覆盖范围。
- **SC-005** 仓库与 Doca 目标章节一致，原生图及无关内容保留。

## Assumptions & Dependencies

- 完成代码与验证，不自动安装生产机器、发布镜像或合并主干。
- 沿用现有容器执行与资源存储，不新增独立市场服务。
- 固定上游镜像版本；模型/插件下载由应用按用户配置处理。
- 第三方 AI 应用独立运行，不自动取得 LightMoni AI、MCP、凭据或平台权限。
