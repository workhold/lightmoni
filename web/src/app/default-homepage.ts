import {useSyncExternalStore} from 'react';
import type {User} from '../shared/types';
import {navigationLinks} from './navigation';

type HomepageUser=Pick<User,'id'|'role'>;
export const DEFAULT_HOMEPAGE='/assistant';
const storagePrefix='lightmoni.homepage.',changeEvent='lightmoni:homepage-change';

export function homepageStorageKey(userID:string){return storagePrefix+encodeURIComponent(userID)}
export function homepageOptions(role:User['role']){return navigationLinks.filter(link=>!link.adminOnly||role==='admin')}
export function isAllowedHomepage(value:unknown,role:User['role']):value is string{
 return typeof value==='string'&&homepageOptions(role).some(link=>link.path===value);
}

export function readDefaultHomepage(user:HomepageUser|null):string{
 if(!user?.id)return DEFAULT_HOMEPAGE;
 try{const stored=localStorage.getItem(homepageStorageKey(user.id));const value=stored==='/agents'?'/machines':stored==='/operations'?'/clusters':stored==='/services'?'/applications':stored;return isAllowedHomepage(value,user.role)?value:DEFAULT_HOMEPAGE}
 catch{return DEFAULT_HOMEPAGE}
}

// A preference is saved only after storage confirms the exact whitelisted path.
export function saveDefaultHomepage(user:HomepageUser,path:string):boolean{
 if(!user.id||!isAllowedHomepage(path,user.role))return false;
 try{
  const key=homepageStorageKey(user.id);
  localStorage.setItem(key,path);
  if(localStorage.getItem(key)!==path)return false;
 }catch{return false}
 window.dispatchEvent(new Event(changeEvent));
 return true;
}

function subscribeHomepage(onChange:()=>void){
 const onStorage=(event:StorageEvent)=>{if(event.key===null||event.key.startsWith(storagePrefix))onChange()};
 window.addEventListener(changeEvent,onChange);window.addEventListener('storage',onStorage);
 return()=>{window.removeEventListener(changeEvent,onChange);window.removeEventListener('storage',onStorage)};
}

export function useDefaultHomepage(user:HomepageUser|null){
 return useSyncExternalStore(subscribeHomepage,()=>readDefaultHomepage(user),()=>DEFAULT_HOMEPAGE);
}

export function isPageDeepLink(pathname:string):boolean{
 // Segment boundaries keep similarly named unknown paths out of login redirects.
 return pathname==='/mcp/authorize'||pathname==='/agents'||pathname.startsWith('/agents/')||navigationLinks.some(link=>pathname===link.path||pathname.startsWith(link.path+'/'))
  ||/^\/(a|traces)\/[^/]+\/?$/.test(pathname);
}

export function loginDestination(user:HomepageUser,pathname:string,search:string):string{
 return isPageDeepLink(pathname)?pathname+search:readDefaultHomepage(user);
}
