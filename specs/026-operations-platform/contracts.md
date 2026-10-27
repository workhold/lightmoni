# SDD 026：接口与执行契约

日期：2026-10-27。以下是实际支持的受限配置和 typed 动作；不存在任意 shell、任意 YAML 或无需批准的 AI 执行接口。

## 资源、方案和运行 API

全部管理 API 要求当前管理员会话。

| 接口 | 请求与返回 |
| --- | --- |
| `GET /api/v1/operations/agents` | `{agents:[{id,host_id,last_seen}]}`，最多 1000 节点 |
| `GET /api/v1/operations/resources?kind=website\|certificate\|compose\|backup` | `{resources}`，公开脱敏 config，最多 1000 条 |
| `POST /api/v1/operations/resources` | `{kind,name,agent_id,config}` → `{resource}`；节点须已登记，revision 从 1 开始，保存不执行 |
| `PUT /api/v1/operations/resources/:id` | `{revision,name?,config}` → `{resource}`；对旧 config 合并并重新校验，revision 冲突或执行中为 409 |
| `DELETE /api/v1/operations/resources/:id` | `{revision}` → `{deleted:true,remote_data_deleted:false}`；拒绝活跃任务、引用/计划；有写历史网站须最后成功 disable，Compose 保留登记 |
| `POST /api/v1/operations/resources/:id/plans` | `{operation,input?}` → `{run}`；不可变载荷、30 分钟有效期，创建不执行 |
| `POST /api/v1/operations/runs/:id/approve` | `{revision}` → `{run}`；核对目标当前 revision、有效期、同资源活跃任务，重复批准返回同一 job |
| `GET /api/v1/operations/runs?resource_id=...` | `{runs}`，最新最多 100 条 |
| `GET /api/v1/operations/runs/:id` | `{run}`，公开 preview、job 状态、脱敏回执及 review_url |
| `POST /api/v1/operations/runs/:id/cancel` | 仅取消草稿/未领取 job；已领取不能被当作安全取消 |

`resource` 含 id、kind、name、agent_id、revision、config、created_at、updated_at。网站/Compose 可用 service_id 关联已登记服务；更新设为 null/空串可清除。证书和备份首期不提供服务关联。

`run` 含 id、resource_id/resource_revision、operation、state、preview、created/expires 时间、created_by/approved_by、job_id、receipt 和 `/operations?run=<id>`。真实运维数据位于 `receipt.snapshot.operations.data`；配置登记不代表现场状态。

状态为 awaiting_approval → queued → leased/accepted/staging/activating/verifying → succeeded/failed/cancelled/unknown。成功必须有匹配 operation/resource 的健康证据。原始业务日志仅供管理员页面，不能由此保证业务自行写入的未知秘密已全部过滤。

## Typed 配置与动作

### 网站 website

配置：

```ts
{
  domains: string[]; // 1..30 个规范化域名，每个 <=253 字符
  mode: "static" | "proxy";
  listen_port?: number; // 默认8088，1..65535
  static_files?: Record<string, string>; // static：最多200文件、512KiB UTF-8、900KiB序列化配置
  upstream?: string; // proxy：HTTP(S)，禁止userinfo、query、fragment和配置注入
  upstream_tls_verify?: boolean; // 默认true
  certificate_id?: string; // 同节点证书、覆盖全部domains
  https_port?: number; // 有证书时默认8443，不能等于listen_port
  service_id?: string;
}
```

| 动作 | input |
| --- | --- |
| inspect、apply、disable、check | `{}` |
| restore | `{version}`，必须是该站保存版本 |
| logs | `{stream?:"access"\|"error",lines?:1..200}`，默认 access/100 |

inspect/logs/check 为只读，其余为写。日志按 JSON 字节有界，版本列表最多 100 条并标 versions_total/truncated。语法检查、配置证明、真实 TLS 指纹和失败恢复属于执行验收；没有这些证据不能据命令退出码宣称成功。

### 证书 certificate

配置：`{domains:string[],email?:string,certificate_pem?:string,private_key_pem?:string}`。上传成对 PEM，证书最多 128 KiB、私钥 64 KiB；校验公私钥与域名，安装还检查有效期。公开 config 仅返回 domains、email、has_certificate、has_private_key；更新两个 PEM 为空表示复用已保存材料，不返回私钥。

inspect/install/issue/renew 的 input 均为 `{}`。install 要求已上传材料；issue/renew 要求有效 email 和公开 DNS 域名、同域受管 80 端口 HTTP challenge，renew 还要求先前以 ACME 签发。更换证书校验已有绑定站点 SAN/TLS，失败恢复并复验。到期元数据为观察回执，不保证已完成公网 CA 验收。

### Compose compose

配置：`{project_name,compose,service_id?}`。项目名最多 48 字符，一经登记不可更改；完整文档最多 128 KiB，1..20 个服务、最多 20 个命名卷和 20 个网络。顶层仅 services/volumes/networks；卷/网络只接受空的项目内声明。

服务允许 image、restart、ports、volumes、environment、command、entrypoint、working_dir、user、healthcheck、depends_on、networks、labels、mem_limit、cpus、read_only、init、stop_grace_period、cap_drop。image 必须显式 tag 或 sha256 digest，拒绝 latest/无 tag。ports 为 `[127.0.0.1:|0.0.0.0:]published:target[/tcp|/udp]`；挂载只能为已声明命名卷。拒绝 build、bind、env_file、docker.sock、privileged、host 网络/设备、cap_add 和用户指定 external/driver。

公开 config 遮蔽 environment 值、command/entrypoint、healthcheck.test；编辑默认保留密文正文，替换需完整文档，`[redacted]` 占位符不允许保存。节点固定 `docker --context default` 连接本机 daemon，不采用用户 currentContext。

| 动作 | input |
| --- | --- |
| discover、inspect | `{}` |
| logs | `{container_id,tail?:1..500}`，完整64位容器ID、默认200，须属于该项目 |
| apply | `{expected_generation,acknowledge_unknown?:boolean}` |
| adopt | `{expected_generation:0,inventory_sha256,acknowledge_recreate:true}` |
| start、stop、restart | `{expected_generation,service?:已声明服务名}` |
| rollback | `{expected_generation,target_generation,acknowledge_unknown?:boolean}`，目标1..当前generation |

generation 为节点成功写操作代数，不是中心资源 revision；每次写入必须使用真实 inspect/回执观察值。adopt 清单摘要必须匹配现场，容器可能重建/短暂停机；核验后的既有卷名称与数据保留，产品不执行卷删除。最多 1000 代，rollback 只恢复配置；容器 running/healthy 不等于已验证对外业务功能。unknown 后原 operation ID 不重放，须先核实节点/解除写锁，以新 apply/rollback＋acknowledge_unknown 收敛。

### 备份 backup

配置：

```ts
{
  source_path: string; // 规范绝对目录，禁止系统目录、链接/越界/不安全权限
  storage:
    | {type:"local",path:string} // 与source互不包含
    | {type:"s3",endpoint:string,bucket:string,region?:string,prefix?:string,
       access_key_id:string,secret_access_key:string,session_token?:string};
  max_bytes?: number; // 默认64MiB，上限256MiB
  max_files?: number; // 默认10000，上限20000
  retain_count?: number; // 默认7，1..1000
}
```

S3 endpoint 仅 origin，禁止 userinfo/path/query/fragment，默认 HTTPS；HTTP 仅 localhost/127.0.0.1/[::1] 测试。region 默认 us-east-1，prefix 默认 lightmoni，不能绝对路径或包含 ./.. 分段。SigV4 path-style 请求固定在 bucket/prefix/resource；不创建 bucket，不跟随重定向。公开读取只展示目标和 has_credentials；同 endpoint/bucket/region/prefix 更新留空密钥可复用，换目标必须重填。

| 动作 | input |
| --- | --- |
| create、list、prune | `{}` |
| verify | `{backup_id}` |
| restore | `{backup_id,expected_target_sha256}`，64位小写SHA256 |

归档为 gzip JSON manifest，含相对路径、文件模式/内容/SHA256、源目录模式及摘要；拒绝链接、硬链接、特殊文件、非法清单和超限内容。本地归档0600、按resource隔离。create 上传后回读校验；verify 返回归档/源摘要和 current_target_sha256。restore 以当前目标 CAS，保存 pre_restore、暂存校验、再做 CAS、rename 替换和现场复验。写入开始后结果不确定返回 unknown；恢复补偿失败标 recovery_required，成功但旧目录清理失败标 cleanup_pending，不假装数据已回退。

list 返回 `{backups:[最多100],total,truncated,source_sha256,current_target_sha256}`。prune 对受支持清单中全部常规备份实施保留，只返回 `{removed:[最多100],removed_total,truncated,retained,pre_restore_retained:true}`。归档摘要含 backup_id、created_at、purpose、source_sha256、sha256、size、file_count、object_version（最多128字符）；pre_restore 不自动清理。备份是文件数据，不保证内容不含业务秘密，也不提供归档加密；用户须保护存储权限。

## 私有 payload、凭据和节点锁

`GET /api/v1/agents/:id/jobs/:jobId/operations` 要求 control credential 和 `X-LightMoni-Job-Lease`，核对节点、job/lease有效期、动作、批准及run/job关联。返回 `{payload:{version:1,operation_id,operation,resource,input}}`，`Cache-Control:no-store`；秘密来自加密存储，不进入普通job动作。Agent 禁止重定向，限制载荷1,200,000字节，并复核节点、operation/domain/capability和期限。

写动作取得 `dataDir/operations/execution.lock`，同dataDir跨runner互斥；unknown或崩溃保留锁，读操作不被该写锁禁止。仅管理员核实原进程/子进程、daemon和现场状态后人工解除，不能按租约或PID过期自动删除。禁止同一Agent身份复制到多个dataDir；这不是跨节点/跨dataDir分布式锁。

## 计划任务 API 与允许动作

全部为管理员接口：

| 接口 | 契约 |
| --- | --- |
| `GET /api/v1/operation-schedules` | `{schedules}` |
| `POST /api/v1/operation-schedules` | `{name?,resource_id,resource_revision,operation,input?,cron,timezone,enabled?}` → `{schedule}`；enabled默认false |
| `GET /api/v1/operation-schedules/:id` | `{schedule,fires}`，fires最新100条，含slot、schedule_revision、run_id/state |
| `PUT /api/v1/operation-schedules/:id` | `{revision,...变更}` → `{schedule}`；乐观锁，新revision、重新记录authorized_by |
| `DELETE /api/v1/operation-schedules/:id` | `{revision}`；活跃触发拒绝删除 |
| `POST /api/v1/operation-schedules/:id/run` | `{revision}` → 202 `{fire}`；unknown_result须先显式更新重新授权 |

仅允许 backup create/verify/prune、certificate renew、website inspect、compose inspect；verify绑定具体backup_id，不提供动态选择最新备份的隐式语义。输入校验沿用领域，最大16KiB并加密保存；不允许周期恢复、重启、发布或任意shell。

cron为分钟/小时/日/月/星期五字段，支持星号、列表、范围与步长，星期0/7为周日；日和星期均限定时采用OR。timezone为IANA时区。schedule_id＋UTC分钟slot持久唯一，DST回拨按不同UTC分钟分别处理，停机/错过分钟跳过。单计划不重叠，繁忙slot记skipped_busy；中心批准仍检查同资源活跃任务。人工运行使用独立manual slot，但不能绕过固定动作/授权检查。

每次触发重查授权者users.active和admin角色、资源revision；变化则停用。启动发现dispatching转unknown并冻结，当前schedule_revision的unknown停止后续触发；管理员明确更新才能重新授权新slot，不重放旧slot。即使重新授权，节点unknown写锁仍须独立核实解除。

## AI 工具契约

AI仅注册以下工具，调用时要求当前管理员：

| 工具 | input与输出 |
| --- | --- |
| `list_operations_resources` | `{kind?,offset?:0,limit?:1..50}` → `{resources,total,offset,limit,returned,next_offset,model_truncated}`；默认limit20，超过28KiB缩页，按next_offset续取 |
| `get_operations_run` | `{id}` → `{run}`，资源preview去正文，回执保留状态和CAS证据，已知列表按28KiB预算裁剪并标model_truncated_lists |
| `propose_operations_action` | `{resource_id,operation,input?}` → 轻量`{run}`，仅id/资源版本/动作/状态/时间/授权元数据/review_url，不能因已持久化的正文过大而丢失审阅链接 |

static_files仅返回file_count/content_bytes/body_omitted；Compose仅返回服务名/镜像、数量和文档字节摘要，不发送环境、命令、healthcheck或labels正文。资源单项异常过大则省略config详情；未知大型回执字段无法缩减时仅返回metadata和review_url。日志动作或sensitive_logs标记的receipt整段置null，提示管理员在UI查看。已知列表裁剪不改变保存回执；received/returned表示模型拿到的条数，不替代节点本身total/truncated。

工具没有approve/execute。方案不是执行成功，queued不是成功；需要人类在review_url批准，并读取真实绑定回执后才能报告结果。
