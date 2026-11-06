# 旧 libcap-ng 的降权兼容

## 实际根因

Agent 安装 abb0c9e13054c6275af223a002eef33c 以退出码 1 结束，平台正确保留 unknown。远端只读核查：CentOS Linux 8、glibc 2.28，服务 not-found/inactive，程序及 helper 均已回滚移除，配置和状态目录为空，无生命周期锁。专用账户 UID/GID=994/991；三个业务容器和 /var/lib/lightmoni-managed/operations 保留。

固定身份探针复现 setpriv 的 `libcap-ng is too old for "all" caps`，返回 127。内核 cap_last_cap=40。用 -cap_0 至 -cap_40 完整编号集替代三类 -all 后，实际执行返回 0；/proc/self/status 显示 UID=994、GID=991、Groups 为空、NoNewPrivs=1，CapInh/Prm/Eff/Bnd/Amb 全部为 0000000000000000。此探针只运行 id/cat，不部署程序、不修改账户或权限。

util-linux 2.32.1 的 [setpriv 源码](https://github.com/util-linux/util-linux/blob/v2.32.1/sys-utils/setpriv.c) 明确在内核能力上界大于编译时 CAP_LAST_CAP 时拒绝 all，同时支持 cap_N 数字语法。以实际最终能力集合全零作为验收，不能仅凭命令退出成功推断降权完成。

## 实现与验证

- ordinaryTaskCommand 每次严格读取内核上界，接受规范 0..63 整数，完整枚举三类能力；无缺省猜测、截断或 root 回退。安装身份探针及每次脚本共用同一参数构造，原五集合全零要求保持。
- 无法执行实际身份检查时，返回固定 ordinary_task_identity_check_failed；中心只识别完整安全诊断行，不保存远端原文。
- runtime typecheck/build 通过。
- 首轮相关 261 项：260 通过，1 项 Mac 上的纯命令参数测试仍依赖旧 -all 形式、未显式提供内核值而失败。更新两个跨平台纯测试的输入与期望后，运行账户/脚本参数/SSH/密码 SSH 四套件共 24 项全部通过；其余相关套件的安装、回滚、运行模式、升级及状态恢复结果全部通过。没有把首轮描述为全绿。
- Linux ARM64 隔离容器对最新编译模块执行真实任务：1 项通过、0 跳过，实际核验专用 UID/GID、空附加组、NNP 和五种零能力集合。测试容器已经移除；没有更改宿主机账户或 Docker 权限。

修复版完整重新安装、激活和生命周期还需经 PR 合入、固定成品发布、1Panel 更新后在线上继续验证。本条只确认明确根因和参数兼容，不将探针当作新 Agent 安装成功。
