import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,extname} from 'node:path';
import ts from 'typescript';
const cache=new Map();
// Transpile local TS to CJS so Grafana's supported CJS export also works in Node.
export function loadSource(url){
 const file=typeof url==='string'?url:fileURLToPath(url);
 if(cache.has(file))return cache.get(file).exports;
 const module={exports:{}};cache.set(file,module);const require=createRequire(file);
 const localRequire=name=>{if(name.startsWith('.')){let path=resolve(dirname(file),name);if(!extname(path)&&existsSync(path+'.ts'))path+='.ts';if(path.endsWith('.ts'))return loadSource(path);}return require(name);};
 const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',code)(localRequire,module,module.exports);
 return module.exports;
}
