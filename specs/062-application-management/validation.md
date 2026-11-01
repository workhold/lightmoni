# 验收记录

日期：2026-11-01（Asia/Shanghai）。基线：c088bb4；功能分支：codex/062-application-management。

## 行为与兼容

应用管理增加已安装/商店视图、应用卡片、状态/主机/集群筛选和直接管理入口。端口映射明确显示监听IP、宿主与容器端口；商店安装沿用基础/高级配置及真实进度。普通应用可选全部网卡或仅本机，OpenResty继续使用固定host网络80/443。配置、重新部署、停止、卸载容器和删除登记保持独立语义；持久化数据不随容器卸载删除。

系统镜像仓库三个命名端口可按集群分别指定或自动分配。HTTP/SQLite测试核对固定端口进入不可变Agent载荷、跨集群隔离、遗漏字段继承、非法/重复输入拒绝且不产生新revision，以及旧端口在新部署验证前保留、成功后释放。旧parameters.port、无host_ports记录和既有自动分配保持兼容。

任务忙时可能没有生成新执行，页面明确提示核对记录后重试。此次没有改变调度器的忙任务策略，也不把配置保存当成执行成功。备份/恢复、模板升级迁移、宿主文件管理不在当前实现能力中，没有伪造相应入口。

## 定向检查

运行时40项全部通过（0失败/0跳过）：

```sh
cd runtime
node --import tsx --test --test-concurrency=1 test/application-install.test.ts test/platform-clusters.test.ts test/platform-executor.test.ts test/platform-image-cache.test.ts
```

runtime/web类型检查、两份浏览器脚本语法检查及git diff --check通过。没有运行生产构建或全量测试。

## 浏览器与视觉

独立loopback API使用真实路由、SQLite、加密资源及AgentJobStore，浏览器通过独立Vite入口访问；使用受控Agent回执，不连接真实Docker或外部仓库。与线上Redis权限修复是两项独立工作，本次代码尚未发布到生产。

安装与仓库脚本的逐轮结果在evidence/install-1～3/results.json及evidence/registry/report.json。仓库覆盖三个命名端口、重复拒绝后输入保留、配置回读、资源/缓存更新保留端口、真实revision冲突重试以及外部网站鉴权。安装覆盖商店读取失败重试、保存失败保留、阶段与历史回读、日志503恢复、成功/失败/unknown及停止确认。

视口1440×1000、390×844、720×500（200%等效），中英文、深浅色及减少动态效果；窄屏表格仅容器内滚动，安装抽屉/仓库弹窗正文独立滚动。媒体按仓库约定留在artifacts/screenshots/specs/062-application-management/evidence/（不加入公开Git）。代表画面为install-1/installed-cards.png、install-1/basic-install.png和registry/round-3-installation.png；各轮page@*.webm包含提交loading、视图/抽屉切换与首次卡片入场。高频轮询不重播入场，减少动态效果直接到位。

沿用现有Ant Design和主题变量，主动作是从商店安装或管理已有部署。合并筛选工具栏，移除重复“已安装数量”；资源限制折叠，端口优先。没有引入新的视觉风格或装饰动画。独立视觉评审结论单独记录。

## 架构同步

适用：新增既有JSON修订中的deployments[].host_ports和商店输入字段，扩展端口投影路径；无新表、Agent协议或凭据权限。仓库位置为docs/system-design.md第62节；[Doca系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)已保存并以最新版本回读。四段正文逐字匹配，原有674块内容/顺序及33个原生图的节点、连线和完整属性保持；见evidence/doca-readback.json。标题数字被宿主规范化的问题已按真实块ID修复并再次回读，文档原标题恢复并保持。
