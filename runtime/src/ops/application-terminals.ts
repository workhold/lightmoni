import { inventory } from './observability.js';
import type { OperationsPlatformStore } from './store.js';
import { fail } from '../shared/http.js';
import type { Handler } from '../shared/types.js';

export interface ContainerTerminalTarget {
  application_id: string; instance_id: string; container_id: string; shell: 'sh'|'bash'; revision: number;
}
export function containerTargetInput(input: unknown): Omit<ContainerTerminalTarget,'revision'> {
  const value = input as Record<string,any>;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(k => !['application_id','instance_id','container_id','shell'].includes(k)) ||
    !['application_id','instance_id'].every(k => typeof value[k] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value[k])) ||
    typeof value.container_id !== 'string' || !/^[a-f0-9]{64}$/.test(value.container_id) || !['sh','bash'].includes(value.shell)) fail(400,'invalid_container_terminal_target');
  return {application_id:value.application_id,instance_id:value.instance_id,container_id:value.container_id,shell:value.shell};
}
export function createApplicationTerminals(store: OperationsPlatformStore, safe: (fn: Handler) => Handler) {
  const targets = (applicationID: string) => {
    const application = store.get(applicationID,'application');
    const instances = store.deps.db.all<any>("SELECT id,machine_id,agent_id FROM ops_cluster_instances WHERE owner_id=? AND retired=0 AND state='running' AND desired_state='running'",application.id);
    const hosts = inventory(store.deps,store).hosts.filter(h => h.online && h.state === 'ready').map(h => ({
      id:h.id,name:h.name,containers:h.containers.filter((c:any) => c.application_id === application.id && c.state === 'running' && /^[a-f0-9]{64}$/.test(c.id) &&
        instances.some(i => i.id === c.deployment_id && i.machine_id === h.id && i.agent_id === h.agent_id)),
    })).filter(h => h.containers.length);
    return {revision:application.revision,hosts};
  };
  store.deps.router.get('/api/v1/ops/resources/:id/terminal-targets',safe(ctx => ctx.json(targets(ctx.params.id))));
  return (machineID: string, input: unknown): ContainerTerminalTarget => {
    const target = containerTargetInput(input), data = targets(target.application_id);
    if (!data.hosts.some(h => h.id === machineID && h.containers.some((c:any) => c.id === target.container_id && c.deployment_id === target.instance_id))) fail(409,'container_terminal_target_unavailable');
    return {...target,revision:data.revision};
  };
}

/** All substitutions are validated fixed identities. Never fall back to an interactive host shell. */
export function containerTerminalCommand(target: ContainerTerminalTarget) {
  containerTargetInput({application_id:target.application_id,instance_id:target.instance_id,container_id:target.container_id,shell:target.shell});
  return `if docker info >/dev/null 2>&1; then set -- docker; elif sudo -n docker info >/dev/null 2>&1; then set -- sudo -n docker; else printf 'Container terminal: Docker permission denied\\n' >&2; exit 126; fi
actual=$("$@" inspect --format '{{ index .Config.Labels "io.lightmoni.platform.instance" }}|{{ index .Config.Labels "io.lightmoni.platform.owner" }}|{{ .State.Running }}' ${target.container_id}) || exit 126
[ "$actual" = '${target.instance_id}|lightmoni|true' ] || { printf 'Container terminal: target changed\\n' >&2; exit 126; }
exec "$@" exec -it ${target.container_id} /bin/${target.shell}`;
}
