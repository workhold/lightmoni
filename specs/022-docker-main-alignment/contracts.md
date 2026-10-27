# SDD 022：构建与部署契约

| Compose 环境变量 | Docker build 参数 | 默认值 |
| --- | --- | --- |
| `LIGHTMONI_NPM_REGISTRY` | `NPM_REGISTRY` | `https://registry.npmjs.org` |
| `LIGHTMONI_NODE_DIST_URL` | `NODE_DIST_URL` | `https://nodejs.org/dist` |
| `LIGHTMONI_DEBIAN_MIRROR` | `DEBIAN_MIRROR` | `http://deb.debian.org/debian` |
| `LIGHTMONI_DEBIAN_SECURITY_MIRROR` | `DEBIAN_SECURITY_MIRROR` | `http://deb.debian.org/debian-security` |
| `LIGHTMONI_BUILD_REVISION` | `BUILD_REVISION` | `unknown` |

以上地址仅用于公开构建依赖，不能携带用户名、密码、token 或查询参数。npm 内容仍由锁文件 integrity 校验，Debian 使用已有归档签名密钥。HTTP/OTLP、SDK 文件名、Agent 安装参数、数据库和数据卷名称规则不变。

`LIGHTMONI_NODE_DIST_URL` 同时可直接用于 Agent 打包脚本；只接受无凭据、query 和 fragment 的 HTTPS 基地址。归档路径仍固定为 `/v24.15.0/<固定架构文件名>`，校验清单独立读取 `https://nodejs.org/dist/v24.15.0/SHASUMS256.txt`。

默认镜像标签仍兼容 `lightmoni:0.1.0`。更新部署应设置 `LIGHTMONI_IMAGE` 为明确修订标签，并设置匹配的 `LIGHTMONI_BUILD_REVISION`；使用已构建镜像时执行 `up --no-build --wait`。

本地实例的 `.env`、备份和回滚文件放在 git 忽略目录并设为 0600/0700；仓库只提供无凭据示例和操作说明。架构同步不适用，见 spec。
