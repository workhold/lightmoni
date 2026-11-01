# Research: 应用商店扩展

日期：2026-11-01。参考 1Panel 分类，模板根据各项目官方容器接口独立编写，不复制 1Panel GPL 配方。

## 决策与依据

1. **模板构建职责**：新模板分模块注册，公开声明与安装构建分离；服务端检查类型、长度、范围、枚举、URL、稳定端口。旧模板行为单独保留。替代方案是继续堆砌 ID 分支，难以保证 27 个模板的一致性。
2. **数据隔离**：Compose named volumes 由每安装项目限定，无固定全局 volume name；适配非 root 镜像的自动卷初始化。避免空宿主 bind 目录覆盖镜像数据及引发写权限失败。
3. **秘密**：密码/API key 只填入服务 environment；URI 密码 URL 编码。生成内部共享 secret 不使用固定默认值；命令和配置文件只引用容器环境，不嵌入输入值。
4. **稳定地址应用**：Kafka advertised listeners 与显式命名宿主端口一致；RocketMQ broker IP、GitLab external_url、Harbor external_url 必填。此类模板不支持自动换机，避免对外地址错误；Kafka/RocketMQ 使用单节点配方并明确无复制承诺。
5. **复杂应用**：Dify 必须包含 API/worker/web/plugin-daemon/数据库/缓存/向量库/反向代理/沙箱等依赖；FastGPT 包含 Mongo 副本集、向量库和模型网关，并要求已有 S3 兼容存储及两个不同的公有/私有 Bucket；Harbor 必须有官方配置生成及共享秘密。具体版本/来源在模板表与验收证据中记录。
6. **初始化**：使用 io.lightmoni.platform.oneshot=true 标签；只有正常退出 0 才完成，不能仅凭 stopped 或 restart=no 放行。常驻服务必须运行且健康。
7. **资源和 GPU**：表单读取每应用默认资源，不统一给 128 MiB；vLLM 使用 Compose NVIDIA reservation，清晰告知驱动/显存/模型要求。
8. **DBX**：t8y2/dbx，4224，/app/data，必填 DBX_PASSWORD。独立数据库工作台，不自动接入平台内部数据或凭据。

## 官方来源

- [1Panel 应用商店](https://github.com/1Panel-dev/appstore)
- [DBX](https://hub.docker.com/r/t8y2/dbx)、[文档](https://dbxio.com/en/docs/getting-started)
- [Harbor](https://github.com/goharbor/harbor)、[Dify](https://github.com/langgenius/dify)、[FastGPT](https://github.com/labring/FastGPT)
- [Kafka Docker](https://github.com/apache/kafka/tree/trunk/docker)、[RocketMQ Docker](https://github.com/apache/rocketmq-docker)
- [Nacos Docker](https://github.com/nacos-group/nacos-docker)、[vLLM Docker](https://docs.vllm.ai/en/latest/deployment/docker/)

## Alternatives considered

不引入远程目录自动同步；不把单个核心镜像当完整应用；不自动授予第三方 AI 应用 LightMoni 工具权限；不使用 privileged、宿主 docker.sock 或安装器 shell 获得新权限。

## 实现后核对

- 上游镜像标签、架构和入口按官方 registry manifest/config 核对，公开摘要见 evidence/upstream-images.json；固定标签不承诺不可变，后续升级须重新验收。
- FastGPT 4.17.2 上游 Compose 引用的 code-sandbox 4.17.1 标签未能在公开仓库取得；选用已存在的 4.17.0，其 code-sandbox 源码树与 4.17.1/4.17.2 相同（801db384de77109b9d946597d5dbfab1c381e27d）。不引入不可取得的 MinIO 镜像，明确要求用户提供外部 S3。工作流代码沙箱与数据库分网，保留联网；自主 Agent 沙箱不启用。
- Dify 1.14.2 配套 plugin-daemon 0.6.1-local 可自行创建插件数据库；使用该版本的 opendal 本地文件系统键。Squid 显式覆盖入口避免重复二进制参数，沙箱流量经拒绝私网目的地址的代理。
- Harbor 2.14.6 官方镜像为 amd64；使用 Engine 26 / Compose 2.26 的 volume subpath，prepare 生成配置后修正非 root 组件读取权限。配置由受保护环境按字面值生成，重复相同配置不重建签名密钥。
- 资源沿用平台既有每容器限制语义；复杂应用表单明确显示容器数量及总预留，不将每容器值误称为整套应用总额。
- 依赖一次性初始化的任务增加 operations.platform.oneshot.v1 领取能力要求；旧 Agent 无法领取，不会在旧执行器上误判成功。
- URL 参数仅接受 http/https origin；拒绝路径部署、查询、片段和 URL 内凭据。数据库/应用秘密只经环境与加密修订传递。
