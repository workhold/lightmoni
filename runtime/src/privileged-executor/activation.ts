import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {boundedFile,refuse} from './security.js';
import {parseStrictJSON} from '../shared/privileged-executor.js';
export function readActivation(dataDir:string,executorID:string,generation:number,artifactSHA?:string){
 const file=join(dataDir,'activation.json');if(!existsSync(file))return '';
 const v=parseStrictJSON(boundedFile(file,4096,true));
 if(!/^[a-f0-9-]{36}$/.test(v.id??'')||v.executor_id!==executorID||v.install_generation!==generation||!/^[a-f0-9]{64}$/.test(v.artifact_sha256??'')||artifactSHA&&v.artifact_sha256!==artifactSHA)refuse('executor_activation_mismatch');return v.id as string;
}
