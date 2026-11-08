# 设计：主机容器与文件管理

容器 UI 复用 `/ops/inventory?machine_id=` 与 Docker inventory 作业，清单来自既有 Agent/root 管理组件，不按应用归属过滤。原受管操作保留独立入口。

文件管理使用 `ssh2` SFTP，复用 `MachineTerminalAccess.acquireTerminal` 的主机忙锁、账户绑定、凭据失效回调和主机指纹验证。每次请求独立租约，30秒总超时、断开/撤销/服务停止清理连接；只接受管理员浏览器会话，拒绝 Bearer/AI。运行权限等于 SSH 账户，不使用 sudo。

目录 canonical realpath、lstat 条目，最多2000项。读取只接受普通文件，1MiB UTF-8 文本；上传8MiB。拒绝文件目标符号链接与特殊文件。写入先核对原内容 SHA256、size、mtime、mode、uid/gid，使用随机同目录排他临时文件，保留已有普通权限（不继承特殊权限位）与属主后复查，再使用 OpenSSH posix-rename 原子替换；不支持原子替换扩展时明确拒绝覆盖。创建用 hardlink 排他发布，不支持时失败；不降级为会覆盖目标的 rename。SFTP 无远端事务锁，外部写入在最终检查与发布之间仍有极短竞争窗口，文档如实记录。成功后重新读取目标摘要；未确认时返回未知结果提示，不宣称保存成功。

审计只保存 actor/machine/account/action/path/result/time，不保存正文、SSH 输出或秘密。UI 保存文本草稿至当前弹窗内存，错误不丢稿；路径/账户/编辑切换与关闭确认放弃草稿，禁用并行请求，响应受组件生命周期和请求代次保护。

视觉沿用主机表格、Ant Design Modal/Table、现有颜色变量。主操作：文件列表与编辑器；工具栏路径、上级、刷新、上传。加载按钮反馈、弹窗进入与编辑面板短淡入使用现有动效并尊重 reduced-motion；无装饰动效。桌面宽弹窗，窄屏滚动表格与纵向编辑器。

验证：运行时文件业务边界与真实 SSH/SFTP 协议测试、容器与文件 UI 交互、中文英文/窄屏截图、类型检查。涉及既有授权/凭据租约测试一并回归。架构同步保存成功回执和目标章节回读证据。

原子替换会创建新inode；本轮只保留基本POSIX权限及uid/gid，不承诺扩展ACL、xattr或硬链接关系继承。生产部署与真实Docker主机验收不在本轮自动执行范围。
