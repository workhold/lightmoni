# Data Model

## CatalogTemplate

稳定 id/name/category/version/versions/spec；新增 description_en、homepage、notes/notes_en、resources{cpu,memory_mb}、deployment_modes 与 architectures（可选）。parameters 包含 key/label/label_en/type/required/default/description/description_en/min/max/pattern/options。type 为 string/password/secret/number/select；format 为 url/host/ip，URL 仅允许 origin；秘密无默认值。resources 是每容器 CPU/内存上限，集群按容器总数预留。

## CatalogDefinition

公开 template 与服务端 build(parameters, context) 分离。context 包含经验证 host_ports、deployment_mode；构建时不从进程环境读取值。内部生成秘密仅出现在安装后的 environment。全部声明是内存目录，无新数据库表。

## One-shot service

Compose service 通过固定 label io.lightmoni.platform.oneshot=true 声明一次性初始化；运行中不 ready，exited+ExitCode=0+非OOM 才完成。未声明的退出容器仍视为不健康；summary 可标识 completed，持久化沿用既有 observed_json。

## Compatibility

原资源/修订结构和旧模板 ID、参数保留。新增 metadata 可由旧 UI 忽略；依赖一次性初始化的工作负载要求 Agent 声明 operations.platform.oneshot.v1，旧 Agent 不会领取。已知目标架构与模板 architectures 不符时服务端拒绝安装。
