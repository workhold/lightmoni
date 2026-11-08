# 实现设计

1. 在 cloud.ts 提供 CNAME value 比较键：ASCII A–Z 转小写，去掉已有的一个末尾点后统一追加点；ensureDnsRecords 的现有 identity 与人工 DNS CRUD 回读共用，不改输入、数据库原值和厂商回读值。
2. 将 DNSPod 普通及加权夹具改为实际末尾点回读。新增跨厂商 SQLite 回归，验证 verifying/applied 历史日志、稳定 ID、TTL 更新和外部记录保持归属。
3. 增加真实外部目标变化及 TXT 大小写/末尾点变化拒绝用例，保持保护边界。
4. 先运行未修复代码复现，再运行相关完整回归与 runtime 类型检查，记录现场只读证据和部署边界。

参考：[RFC 1034 3.1](https://www.rfc-editor.org/rfc/rfc1034.html#section-3.1) 的末尾根标签点表示法、[RFC 4343](https://www.rfc-editor.org/rfc/rfc4343.html) 的 ASCII DNS 名字大小写语义。厂商 API 中 CNAME 目标已是域名，不按 zone-file 相对名称追加后缀。

## 发行设计

- 固定 PR153 的 main 合并提交，使用 git archive 输入双架构构建，验收成品中心、下载包和编译后的 CNAME/DNS 回归；只发布已测试镜像。
- 使用已有固定标签发布流程，逐一核对本地 blob、远端 manifest/config 与 OCI 索引，保留既有 Docker latest；GitHub Release 附带发行说明和已验收的下载制品。
- 通过已登录生产管理终端建立 root-only 配置、主密钥及 SQLite 一致性备份，保留可回退的旧镜像。只原子替换 Compose 中心镜像，在签名作业空闲边界更新并校验数据卷、环境、端口、网络和其他容器。
- 生产以实际网站 DNS 错误清空、厂商回读确认和公网可信 HTTPS 健康为验收；若切换失败回退程序配置，不自动替换线上数据库。发行与部署沿用现有拓扑，架构同步不适用。
