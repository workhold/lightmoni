# SDD 022：设计与实施计划

## 构建

在构建阶段声明公开 npm registry 参数，由环境配置传给所有 npm 子进程，继续使用 `npm ci` 与原锁文件。运行阶段只替换 Debian 源地址，保留仓库签名与正常包安装；没有证书校验豁免。默认源不变，受限网络可选择镜像源。Compose 将参数显式传给 Dockerfile，两容器版本通过既有 extends 继承。

镜像增加 OCI revision 标签，参数由调用者提供。该标签用于核对部署，不改变应用对外的 `0.1.0` 协议版本。

原生可选依赖使用固定 Node 构建镜像自带的 `/usr/local/include/node` 头文件，避免 node-gyp 再访问慢速官方发行站。Agent 的固定 Node 归档可选择公开 HTTPS 镜像，版本与架构不变；SHA256 清单仍从官方 `nodejs.org` 读取，镜像 URL 的凭据、查询和 fragment 在下载前拒绝。

## 部署

应用源码取 main 基线；本分支只修改构建/Compose/运维说明。先在独立 Compose 项目构建并验证，再读取当前容器配置到受保护的运行时 `.env`，沿用项目名 `lightmoni-acceptance` 和既有两个数据卷。创建 SQLite/主密钥备份，保留旧镜像及回滚 `.env`。使用 `deploy/with-clickhouse/compose.yaml` 管理服务，不把当前实例的秘密或端口硬编码到仓库。

## 架构同步

不适用，理由见 spec：执行已存在的部署拓扑，未引入新组件、数据路径、存储、协议或权限边界。

## 验证与回滚

完整构建与独立容器验收通过后才切换现有实例；检查健康、修订号、静态资源、目录/只读 SQL、最新下载包和原有用户。标准 Compose 重建保留命名卷。失败时切回保留的旧镜像；若 SQLite 迁移无法向后兼容，停中心并恢复配套 SQLite 与主密钥备份，ClickHouse 数据卷保持保留。
