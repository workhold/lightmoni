import type {Resource,Spec} from './model';
export const INSTALL_PHASES:Record<string,[string,string]>={queued:['等待执行','Queued'],leased:['已分配给 Agent','Leased to Agent'],accepted:['Agent 已接收','Agent accepted'],staging:['准备安装','Preparing'],activating:['安装执行中','Installing'],checking_docker:['检查 Docker','Checking Docker'],checking_ports:['检查端口','Checking ports'],preparing_images:['按来源准备镜像','Preparing images'],validating_config:['校验应用配置','Validating configuration'],starting_containers:['拉取镜像并启动容器','Pulling images and starting containers'],checking_health:['检查服务健康','Checking service health'],validating_gateway:['校验 OpenResty 配置','Validating OpenResty configuration'],starting_gateway:['启动 / 重载 OpenResty','Starting / reloading OpenResty'],restoring_previous:['恢复旧部署 / 清理失败安装','Restoring / cleaning up'],verifying:['验证执行结果','Verifying result'],succeeded:['执行成功','Succeeded'],failed:['执行失败','Failed'],unknown:['结果未知','Unknown result'],cancelled:['已取消','Cancelled'],running:['执行中','Running'],pending:['等待处理','Pending'],warning:['注意','Attention']};
const DIAGNOSTICS:Record<string,[string,string,string,string]>={
 privileged_executor_required:['需要独立运维执行器','Independent privileged executor required','旧 Agent 写操作已停用；请使用已接入的受管执行能力。','Legacy Agent writes are disabled. Use a connected managed execution capability.'],
 privileged_profile_not_implemented:['主机执行能力未就绪','Host execution profile unavailable','此功能尚未接入独立运维执行器，没有下发任务。','This feature is not connected to the independent privileged executor yet; no task was dispatched.'],
 legacy_agent_payload_removed:['旧运维载荷通道已移除','Legacy operations payload channel removed','旧 Agent 通道不再提供运维正文或制品；不会自动迁移或重新执行。','The legacy Agent channel no longer serves operations payloads or artifacts. Nothing is migrated or replayed automatically.'],
 agent_reinstall_inspecting:['正在核验重装前的旧实例','Inspecting previous Agent instances','当前 Agent 正在只读核验，确认为空后释放旧占用。','The current Agent is checking for old containers before releasing reservations.'],
 agent_reinstall_containers_remain:['重装前的容器仍然存在','Previous containers remain','旧容器仍存在（可能已停止），请核对后处理；平台不会自动删除容器或数据。','Inspect the old containers, including stopped containers. The platform does not delete containers or data automatically.'],
 agent_reinstall_inspection_failed:['旧实例核验未通过','Old instance verification failed','旧 Agent 容器核验通道已停用，请通过受管执行器核对主机；不要授予普通 Agent Docker 权限。','Legacy Agent container inspection is disabled. Inspect the host through the managed executor; do not grant Docker access to the normal Agent.'],
 agent_reinstall_execution_unresolved:['旧 Agent 仍在线或有未结束执行','Previous Agent or execution is unresolved','先处理旧 Agent 连接及活动或未知结果的任务，避免重复执行。','Resolve the previous Agent connection and active or unknown jobs first.'],
 agent_reinstall_upgrade_required:['旧容器核验通道已移除','Legacy container inspection channel removed','旧记录需由受管执行器核对，升级普通 Agent 不会恢复此通道。','Use the managed executor to inspect old records. Upgrading the normal Agent does not restore this channel.'],
 agent_reinstall_stateful_review_required:['有状态旧实例需要人工核对','Stateful instance requires review','先核对旧容器与数据位置，平台不会自动迁移或创建空数据副本。','Check old containers and data locations. Stateful data is not automatically migrated or recreated.'],
 image_proxy_failed:['镜像代理拉取失败','Image proxy pull failed','检查镜像管理中的来源代理；未允许回源时不会尝试原站。','Check the image source proxy. Origin access is disabled unless explicitly allowed.'],
 image_sources_agent_upgrade_required:['镜像代理部署能力未接入','Image proxy deployment is not connected','应用部署需要受管执行能力，升级普通 Agent 不会启用旧通道。','Application deployment requires a managed execution profile. Upgrading the normal Agent does not enable the legacy channel.'],
 image_sources_policy_changed:['镜像代理配置已变化','Image proxy settings changed','通过应用重新部署，使用当前镜像代理规则。','Redeploy the application to use the current image source rules.'],

 host_port_occupied:['所需端口已被占用','A required port is occupied','释放冲突端口或修改应用端口后再部署。','Free the port or change the application port before deploying again.'],
 docker_cli_missing:['目标机器未安装 Docker','Docker is not installed on the target','补装 Docker 环境并确认 Agent 可访问后，重新部署此应用。','Install Docker and verify Agent access, then redeploy this application.'],
 docker_daemon_unavailable:['Docker 服务不可用','Docker service unavailable','检查并启动本机 Docker 服务后再部署。','Check and start the local Docker service before redeploying.'],
 operation_dependency_unavailable:['安装依赖不可用','Installation dependency unavailable','检查当前阶段所需的 Docker 和 Compose；旧记录未区分具体依赖。','Check Docker and Compose prerequisites for this stage; older records did not identify the dependency.'],

 host_port_check_failed:['宿主端口检查失败','Host port check failed','检查 Agent 的网络权限和应用监听地址后再部署。','Check the Agent’s network permissions and the application bind address before deploying again.'],
 docker_unavailable:['无法连接 Docker','Cannot connect to Docker','检查目标机器的 Docker 服务是否已安装并启动。','Check that Docker is installed and running on the target.'],
 docker_prerequisite_failed:['Docker 检查失败','Docker prerequisite check failed','检查目标机器的 Docker 服务和 Agent 访问权限。','Check Docker and the Agent’s permissions on the target.'],
 docker_permission_denied:['Agent 无权访问 Docker','Agent cannot access Docker','为 Agent 配置访问 Docker 的权限后再部署。','Grant the Agent access to Docker before deploying again.'],
 compose_unavailable:['缺少 Docker Compose 插件','Docker Compose plugin unavailable','在目标机器安装或修复 Docker Compose 插件。','Install or repair the Docker Compose plugin on the target.'],
 image_not_found:['镜像或版本不存在','Image or tag not found','核对镜像名称及版本是否在镜像仓库中存在。','Check the image name and tag in the registry.'],
 image_access_denied:['镜像仓库拒绝访问','Registry access denied','检查镜像是否公开及目标机器的仓库登录配置。','Check image visibility and registry authentication on the target.'],
 image_network_failed:['镜像下载网络异常','Image download network failure','检查目标机器到镜像仓库的 DNS、网络和代理配置。','Check the target’s DNS, network and proxy access to the registry.'],
 disk_full:['目标机器磁盘空间不足','Target disk is full','释放 Docker 数据目录所在磁盘空间后再部署。','Free disk space for Docker before deploying again.'],
 container_unhealthy:['容器未通过健康检查','Container health check failed','检查应用参数、依赖和容器日志。','Check application parameters, dependencies and container logs.'],
 target_agent_offline:['目标机器的 Agent 离线','Target Agent is offline','恢复 Agent 连接后，从此应用重新部署。','Reconnect the Agent, then deploy this application again.'],
 machine_agent_required:['目标机器尚未接入 Agent','Target has no Agent','先在主机管理接入 Agent。','Connect an Agent through host management first.'],
 insufficient_node_capacity:['目标机器可用资源不足','Insufficient target capacity','释放资源或在高级设置中调整 CPU / 内存限制。','Free resources or adjust CPU / memory limits in advanced settings.'],
 node_capacity_discovery:['正在读取机器容量','Discovering node capacity','等待在线 Agent 上报机器容量。','Wait for online Agents to report capacity.'],
 compose_preflight_failed:['应用配置校验失败','Application configuration validation failed','检查 Docker Compose 插件和应用配置。','Check Docker Compose and the application configuration.'],
 gateway_preflight_failed:['OpenResty 配置校验失败','OpenResty configuration validation failed','检查镜像下载、网站配置及证书文件。','Check image access, website configuration and certificate files.'],
 workload_health_not_verified:['容器健康状态未通过验证','Container health was not verified','检查容器启动日志和健康检查配置。','Inspect container startup logs and health checks.'],
 workload_readiness_not_verified:['服务就绪检查未通过','Service readiness check failed','检查服务监听端口和健康检查地址。','Check the service port and readiness endpoint.'],
 workload_apply_failed_restored:['安装失败，已完成恢复或清理','Installation failed; restoration or cleanup completed','修正配置后，通过此应用重新部署。','Correct the configuration, then deploy this application again.'],
 gateway_apply_failed_restored:['入口安装失败，已恢复旧状态','Gateway installation failed; previous state restored','检查网站入口配置后重新部署。','Check the gateway configuration before deploying again.'],
 operation_command_timeout:['安装命令执行超时','Installation command timed out','检查目标机器负载和镜像仓库连接。','Check target load and registry connectivity.'],
 operation_command_failed:['安装命令失败','Installation command failed','检查目标机器的 Docker 状态和应用配置。','Inspect Docker and application configuration on the target.'],
};
export function installDiagnostic(value:unknown):[string,string,string,string]{
 const code=String(value??'').toLowerCase();
 return DIAGNOSTICS[code]??['未记录更详细的原因','No detailed cause was recorded','请根据错误码检查目标机器和应用配置；旧记录无法还原原始日志。','Inspect the target and configuration using the error code; older logs cannot be reconstructed.'];
}
export function installationState(resource:Resource):string{
 const entries=Object.entries(resource.status.deployments??{}) as [string,Spec][];
 const deployments=entries.map(([,d])=>d);
 const current=(resource.status.instances??[]).filter((i:Spec)=>!i.retired&&i.desired_state!=='removed');
 const enabled=deployments.filter(d=>d.enabled&&d.desired_revision>0);
 if(deployments.length&&!enabled.length&&!resource.status.last_error)return 'stopped';
 if(current.some((i:Spec)=>i.state==='unknown'))return 'unknown';
 if(deployments.some(d=>d.last_error)||current.some((i:Spec)=>['failed','error'].includes(i.state)))return 'failed';
 const expected=(cid:string)=>{const d=resource.spec.deployments?.find((p:Spec)=>p.cluster_id===cid);return resource.spec.deployment_mode==='managed'?Number(d?.replicas??1):Number(d?.machine_ids?.length??1)};
 if(enabled.length&&entries.filter(([,d])=>d.enabled&&d.desired_revision>0).every(([cid,d])=>d.applied_revision===d.desired_revision&&Number(d.instances_total??current.filter((i:Spec)=>i.cluster_id===cid).length)>=expected(cid))&&current.some((i:Spec)=>i.state==='running'&&i.healthy))return 'succeeded';
 if(!enabled.length&&resource.status.last_error)return 'failed';
 if(deployments.length&&deployments.every(d=>!d.enabled)||current.length&&current.every((i:Spec)=>i.state==='stopped'))return 'stopped';
 return 'pending';
}
