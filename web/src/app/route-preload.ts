type PageLoader=()=>Promise<unknown>;

export const loadMcpAccessPage=()=>import('./McpAccessPage');
export const loadAdminPage=()=>import('./AdminPage');
export const loadHostMonitoring=()=>import('./HostMonitoring');
export const loadSystemMonitoring=()=>import('./SystemMonitoring');
export const loadBackupTools=()=>import('./BackupTools');
export const loadDashboardPage=()=>import('../features/dashboards/DashboardPage');
export const loadLogExplorePage=()=>import('../features/logs/LogExplorePage');
export const loadAlertsPage=()=>import('../features/alerts/AlertsPage');
export const loadTracePage=()=>import('../features/alerts/TracePage');
export const loadAssistantPage=()=>import('../features/assistant/AssistantPage');
export const loadImageManagementPage=()=>import('./ImageManagementPage');
export const loadOperationsPage=()=>import('./OperationsPage');
export const loadHostsNodesPage=()=>import('./HostsNodesPage');
export const loadDataManagementPage=()=>import('./DataManagementPage');
export const loadConnectionCredentialsPage=()=>import('./ConnectionCredentialsPage');

const dynamicPageLoaders:[RegExp,PageLoader][]=[
 [/^\/machines\/[^/]+\/monitoring$/,loadHostMonitoring],
];
const pageLoaders:Record<string,PageLoader>={
 '/mcp-access':loadMcpAccessPage,
 '/mcp/authorize':loadMcpAccessPage,
 '/admin':loadAdminPage,
 '/system/monitoring':loadSystemMonitoring,
 '/system/backups':loadBackupTools,
 '/dashboards':loadDashboardPage,
 '/logs':loadLogExplorePage,
 '/alerts':loadAlertsPage,
 '/traces':loadTracePage,
 '/assistant':loadAssistantPage,
 '/image-management':loadImageManagementPage,
 '/clusters':loadOperationsPage,
 '/applications':loadOperationsPage,
 '/websites':loadOperationsPage,
 '/domains':loadOperationsPage,
 '/certificates':loadOperationsPage,
 '/agents':loadHostsNodesPage,
 '/machines':loadHostsNodesPage,
 '/data-management':loadDataManagementPage,
 '/connection-credentials':loadConnectionCredentialsPage,
};

export function preloadRoute(path:string):void{
 const target=path.split('?')[0];
 const loader=dynamicPageLoaders.find(([pattern])=>pattern.test(target))?.[1]??pageLoaders[target]??Object.entries(pageLoaders).find(([key])=>target.startsWith(key+'/'))?.[1];
 if(loader)void loader().catch(()=>{});
}

export function schedulePreloadAllRoutes():()=>void{
 if((navigator as Navigator&{connection?:{saveData?:boolean}}).connection?.saveData)return()=>{};
 const start=()=>{void(async()=>{for(const load of new Set([...Object.values(pageLoaders),...dynamicPageLoaders.map(([,load])=>load)]))try{await load()}catch{}})()};
 if(typeof window.requestIdleCallback==='function'){const id=window.requestIdleCallback(start,{timeout:3000});return()=>window.cancelIdleCallback(id)}
 const timer=window.setTimeout(start,1500);return()=>window.clearTimeout(timer);
}
