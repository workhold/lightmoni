import {useRef} from 'react';
import Editor,{loader} from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/ini/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/dockerfile/register.js';
import {useAppearance} from './appearance';
import {ConfigProvider} from './ui';
import './code-editor.css';

const scope=globalThis as typeof globalThis&{MonacoEnvironment?:{getWorker:()=>Worker}};
scope.MonacoEnvironment={getWorker:()=>new EditorWorker()};
loader.config({monaco});
// Syntax tokens only: no remote schema, language server, CDN or telemetry.
monaco.languages.register({id:'lightmoni-json'});
monaco.languages.setMonarchTokensProvider('lightmoni-json',{tokenizer:{root:[[/"(?:[^"\\]|\\.)*"(?=\s*:)/,'key'],[/"(?:[^"\\]|\\.)*"/,'string'],[/\b(?:true|false|null)\b/,'keyword'],[/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/,'number'],[/[{}\[\]]/,'delimiter.bracket']]}});
monaco.languages.register({id:'lightmoni-nginx'});
monaco.languages.setMonarchTokensProvider('lightmoni-nginx',{tokenizer:{root:[[/#.*/,'comment'],[/\$[\w]+/,'variable'],[/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/,'string'],[/\b\d+(?:[kKmMgGsS])?\b/,'number'],[/[\w_]+(?=\s)/,'keyword'],[/[{};]/,'delimiter']]}});

export function codeLanguage(path='') {
 const name=path.split('/').pop()!.toLowerCase(),extension=name.split('.').pop();
 if(name==='dockerfile'||name.startsWith('dockerfile.'))return 'dockerfile';
 if(name==='nginx.conf')return 'lightmoni-nginx';
 if(name==='.env'||name.startsWith('.env.'))return 'ini';
 return ({yaml:'yaml',yml:'yaml',json:'lightmoni-json',sh:'shell',bash:'shell',zsh:'shell',js:'javascript',jsx:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',tsx:'typescript',py:'python',ini:'ini',conf:'ini',html:'html',htm:'html',xml:'xml',svg:'xml',css:'css',md:'markdown'} as Record<string,string>)[extension??'']??'plaintext';
}

type Props={value?:string;onChange?:(value:string)=>void;language?:string;filename?:string;height?:number|string;disabled?:boolean;readOnly?:boolean;ariaLabel?:string;'aria-label'?:string;id?:string;onSave?:()=>void};
export default function CodeEditor({value='',onChange,language,filename,height=300,disabled=false,readOnly=false,ariaLabel,'aria-label':label,id,onSave}:Props) {
 const {dark}=useAppearance(),{componentDisabled}=ConfigProvider.useConfig(),save=useRef(onSave);save.current=onSave;
 const locked=disabled||readOnly||componentDisabled;
 return <div id={id} className={'lm-code-editor'+(locked?' is-readonly':'')} data-language={language??codeLanguage(filename)} aria-disabled={disabled||componentDisabled}>
  <Editor height={height} language={language??codeLanguage(filename)} theme={dark?'vs-dark':'vs'} value={value} onChange={next=>{if(!locked)onChange?.(next??'')}}
   options={{ariaLabel:ariaLabel??label??'Code',readOnly:locked,domReadOnly:locked,automaticLayout:true,minimap:{enabled:false},lineNumbers:'on',lineNumbersMinChars:3,fontSize:13,fontFamily:'ui-monospace,SFMono-Regular,Consolas,monospace',tabSize:2,insertSpaces:true,detectIndentation:false,autoIndent:'none',formatOnPaste:false,formatOnType:false,trimAutoWhitespace:false,wordWrap:'on',scrollBeyondLastLine:false,padding:{top:10,bottom:10},quickSuggestions:false,suggestOnTriggerCharacters:false,autoClosingBrackets:'never',autoClosingQuotes:'never',unicodeHighlight:{ambiguousCharacters:false,nonBasicASCII:false},scrollbar:{verticalScrollbarSize:8,horizontalScrollbarSize:8}}}
   onMount={editor=>{editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>{if(!editor.getOption(monaco.editor.EditorOption.readOnly))save.current?.()})}}/>
 </div>;
}
