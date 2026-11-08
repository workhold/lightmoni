# 验收证据

本轮实现与检查在隔离功能分支完成；未部署生产环境，未操作真实业务主机文件。容器UI使用包含运行/停止、平台/外部容器的固定清单；现有Docker实现确实使用`docker --context default ps --all --no-trunc`。文件验收使用临时OpenSSH/SFTP服务、临时密钥与临时目录，经真实HTTP与SSH协议读写，不将模拟结果当成生产验收。

- `runtime-tests.txt`：28项通过，覆盖文件路径、真实目录/隐藏文件/中文路径、UTF-8编辑及回读、权限继承、二进制上传/覆盖、并发摘要冲突、符号链接/目录/二进制/超限拒绝、权限/会话/主机指纹、审计无正文，以及原网页终端和Compose回归。
- `typecheck.txt`：runtime、ai-runtime和web类型检查通过。
- `ui-report.json`与`ui-runs.json`：主机入口、全部容器筛选、真实文件保存回读、保存冲突保留草稿、放弃确认、上传与同名覆盖取消、中英文/窄屏/200%等效布局；最终版本连续三次结果见ui-runs.json。
- `visual-review.md`：独立静态评审与修正记录；动效为弹窗进入、编辑器切换、操作加载/成功反馈，时间与视频见UI报告。
- `doca-sync.json`：仓库第107章与Doca章节保存回读确认，962个原内容块和53个原生图块含节点/连线保持一致。

限制：容器清单依赖Agent当前Docker观测权限；文件管理需要有效可复用SSH账户及SFTP。文本编辑1MiB、上传8MiB、目录最多2000项并显示截断。原子发布要求OpenSSH扩展；保留基本uid/gid/普通mode，不保证xattr/扩展ACL/硬链接关系继承。SFTP最终检查与rename之间不具备远端事务CAS。SHA256回读不确认时保留草稿并提示核对。
