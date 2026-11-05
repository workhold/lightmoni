生产追测与第二轮修复（2026-11-06）

中心已通过1Panel升级到固定测试版20261106-operations-adaf7a6，01:58:01 CST报告升级成功。zz-bj-1维护入口恢复可用；升级只读预检尚未产生新计划或远端写操作。

目标仍为历史root常驻Agent，实际uid/gid均0、无统一helper，固定unit SHA19f0b122cfff85f5397b5cc4afeeb6342df36634a35f981c562a1ab6f3ef826e。原版卸载器和发行内uninstall.sh摘要一致（6de6177299a8f9ebb6a87bd3bfd54c1bc54eed42571dcede3c11446cecb15208）；旧managed-status为fenced:null、pending_results:0。已核对旧安装需要原版本卸载/重新接入，未冒充可直接升级。

机器本地curl及内置Node到HTTPS中心探测通过TLS校验。认证/v1/center-endpoints返回200，71ms/9ms读取中心身份与端点表；控制凭据只在内存使用，未输出。旧Agent运行日志仍有间歇upstream network error，持续传输及升级后复测尚未完成。

第二轮代码：内部心跳/事件补机器名；内置Agent/SDK大盘及通用主机模板以名称显示；已有内置查询仅精确匹配旧配方时做一次带版本更新，保留用户编辑和删除。旧root/user固定unit升级预检返回明确409指引，未知安装继续拒绝。

验证：219项相关测试全部通过（agent-update-runner、machine-agent-updates、domains、nodes、routes）；runtime类型/构建通过。真实隔离ClickHouse26.8执行25条内置查询通过；两台同名机器保留不同短ID，SDK图例含orders-service / zz-bj-1；证据见readable-dashboard-sql.json和readable-name-fixtures.json。Doca原生三段补充保存并回读seq1747，完整现有图10节点8边与写前逐字段一致，见doca-followup.json。

这些是已完成代码/诊断证据；应用全生命周期、Agent卸载重装、三轮观测、告警触发恢复和最终线上矩阵仍在进行，不计为通过。
