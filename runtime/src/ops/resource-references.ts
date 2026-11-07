import type {PlatformResource,PlatformStore} from './types.js';

/** Match the existing saved-spec deletion guard without examining opaque content. */
function references(value: unknown, key: string): boolean {
  return value === key || (Array.isArray(value) && value.some(v=>references(v,key))) ||
    (!!value && typeof value === 'object' && Object.entries(value).some(([k,v])=>
      !['static_files','files','script','environment','env'].includes(k) && references(v,key)));
}
function publishedApplicationReference(spec: Record<string,any>, key: string): boolean {
  return spec.routing_mode === 'managed' && spec.service_application_id === key ||
    !!spec.bindings?.some((b:any)=>b.locations?.some((l:any)=>l.cluster_targets?.some((t:any)=>t.application_id===key)));
}

/** Public metadata only. Never return encrypted specs, field values or credentials. */
export function resourceReferences(store: PlatformStore, key: string) {
  const {db,decrypt}=store.deps;
  const hasPublications=!!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_platform_website_deployments'");
  return store.list().filter(r=>r.id!==key).flatMap((r:PlatformResource)=>{
    const sources:{type:'saved'|'published';revision:number}[]=[],domains=new Set<string>();
    const add=(spec:Record<string,any>,type:'saved'|'published',revision:number)=>{
      sources.push({type,revision});
      if(r.kind==='website')for(const b of spec.bindings??[])for(const domain of b.domains??[])if(typeof domain==='string')domains.add(domain);
    };
    if(references(r.spec,key))add(r.spec,'saved',r.revision);
    if(r.kind==='website'&&hasPublications)for(const d of db.all<{desired_revision:number}>(
      'SELECT DISTINCT desired_revision FROM ops_platform_website_deployments WHERE website_id=? AND desired_revision>0 AND enabled=1 ORDER BY desired_revision',r.id,
    )){
      const old=db.get<{spec_cipher:string}>('SELECT spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision=?',r.id,d.desired_revision);
      const spec=old?JSON.parse(decrypt(old.spec_cipher)):r.spec;
      if(publishedApplicationReference(spec,key))add(spec,'published',d.desired_revision);
    }
    return sources.length?[{id:r.id,kind:r.kind,name:r.name,domains:[...domains].sort(),sources}]:[];
  }).sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
}
