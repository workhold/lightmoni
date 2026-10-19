import {useEffect,useRef,useState} from 'react';
import Editor,{loader} from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import {Button,Tooltip} from './ui';
import type {CatalogTable} from './types';
import './sql.css';
import {useAppearance} from './appearance';
import {useI18n} from './i18n';
const scope=globalThis as typeof globalThis & {MonacoEnvironment?:{getWorker:()=>Worker}};
scope.MonacoEnvironment={getWorker:()=>new EditorWorker()};
loader.config({monaco});
const language='lightmoni-sql';
const keywords=['SELECT','FROM','WHERE','GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','AS','WITH','AND','OR','NOT','IN','IS','NULL','DISTINCT','ALL','ASC','DESC','JOIN','LEFT','RIGHT','INNER','OUTER','CROSS','FULL','ON','UNION','CASE','WHEN','THEN','ELSE','END','BETWEEN','LIKE','ILIKE','EXISTS','OVER','PARTITION','ROWS','RANGE','PRECEDING','FOLLOWING','CURRENT','ROW','TRUE','FALSE','SETTINGS','FORMAT','FINAL','SAMPLE','ARRAY'];
const functions=['count','countIf','sum','sumIf','avg','min','max','uniq','uniqExact','quantile','quantileExact','toStartOfInterval','toDateTime64','toDecimal256','JSONExtractString','JSONExtractInt','JSONExtractFloat','JSONExtractBool','JSONExtractRaw','if','coalesce','round','lower','upper','positionCaseInsensitive','match','multiIf','argMax','any','now','dateDiff','toString','toUInt64','toFloat64'];
monaco.languages.register({id:language});
monaco.languages.setMonarchTokensProvider(language,{ignoreCase:true,keywords,tokenizer:{
 root:[[/--.*$/,'comment'],[/\/\*/,'comment','@comment'],[/\$__[\w]+|\$[A-Za-z_]\w*/,'variable'],[/\{[A-Za-z_]\w*:[^}\n]+\}/,'variable'],[/'/,'string','@string'],[/`/,'identifier','@backtick'],[/"/,'identifier','@quoted'],[/\b(?:U?Int\d*|Float\d*|Decimal\d*|DateTime\d*|String|Nullable|Map|Bool)\b/,'type'],[/[A-Za-z_][\w]*(?=\s*\()/,'function'],[/[A-Za-z_][\w]*/,{cases:{'@keywords':'keyword','@default':'identifier'}}],[/0x[\da-f]+|(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/,'number'],[/[()[\]{}]/,'@brackets'],[/[=<>!+*/%~-]+/,'operator'],[/[.,;:]/,'delimiter'],[/\s+/,'white']],
 comment:[[/\/\*/,'comment','@push'],[/\*\//,'comment','@pop'],[/[^*/]+/,'comment'],[/[*/]/,'comment']],
 string:[[/\\./,'string.escape'],[/''/,'string.escape'],[/'/,'string','@pop'],[/[^'\\]+/,'string']],
 backtick:[[/``/,'identifier'],[/`/,'identifier','@pop'],[/[^`]+/,'identifier']],
 quoted:[[/""/,'identifier'],[/"/,'identifier','@pop'],[/[^"]+/,'identifier']]
}});
monaco.languages.setLanguageConfiguration(language,{comments:{lineComment:'--',blockComment:['/*','*/']},brackets:[['(',')'],['[',']'],['{','}']],autoClosingPairs:[{open:'(',close:')'},{open:'[',close:']'},{open:'{',close:'}'},{open:"'",close:"'",notIn:['string','comment']},{open:'`',close:'`',notIn:['string','comment']}],surroundingPairs:[{open:'(',close:')'},{open:"'",close:"'"},{open:'`',close:'`'}]});
monaco.editor.defineTheme('lightmoni-sql-light',{base:'vs',inherit:true,rules:[{token:'keyword',foreground:'7540A5',fontStyle:'bold'},{token:'function',foreground:'006B8F'},{token:'string',foreground:'2B7742'},{token:'string.escape',foreground:'5F8F36'},{token:'number',foreground:'B65511'},{token:'variable',foreground:'AA3D72'},{token:'type',foreground:'006B8F'},{token:'comment',foreground:'748193',fontStyle:'italic'},{token:'identifier',foreground:'27364B'}],colors:{'editor.background':'#FAFBFD','editorLineNumber.foreground':'#96A0AF','editorLineNumber.activeForeground':'#425674','editor.lineHighlightBackground':'#EDF2F8','editor.selectionBackground':'#DCE8FF','editorIndentGuide.background1':'#E2E8F0','editorCursor.foreground':'#2563EB'}});

monaco.editor.defineTheme('lightmoni-sql-dark',{base:'vs-dark',inherit:true,rules:[{token:'keyword',foreground:'C792EA',fontStyle:'bold'},{token:'function',foreground:'82AAFF'},{token:'string',foreground:'A3BE8C'},{token:'string.escape',foreground:'C3E88D'},{token:'number',foreground:'F78C6C'},{token:'variable',foreground:'FFCB6B'},{token:'type',foreground:'89DDFF'},{token:'comment',foreground:'7F8A9B',fontStyle:'italic'},{token:'identifier',foreground:'D8DEE9'}],colors:{'editor.background':'#181B1F','editorLineNumber.foreground':'#687283','editorLineNumber.activeForeground':'#C0C8D3','editor.lineHighlightBackground':'#22252B','editor.selectionBackground':'#304C70','editorIndentGuide.background1':'#313640','editorCursor.foreground':'#82AAFF'}});

export default function SQLInput({value,onChange,height=220,onRun,readOnly=false,tables=[],ariaLabel,dark:darkOverride}:{value:string;onChange?:(value:string)=>void;height?:number|string;onRun?:()=>void;readOnly?:boolean;tables?:CatalogTable[];ariaLabel?:string;dark?:boolean}){
 const {t}=useI18n(),translate=useRef(t);translate.current=t;
 const appearance=useAppearance(),dark=darkOverride??appearance.dark;
 const run=useRef(onRun),catalog=useRef(tables),editor=useRef<monaco.editor.IStandaloneCodeEditor|undefined>(undefined),provider=useRef<monaco.IDisposable|undefined>(undefined),[wrap,setWrap]=useState(true);
 useEffect(()=>{run.current=onRun},[onRun]);useEffect(()=>{catalog.current=tables},[tables]);useEffect(()=>()=>{provider.current?.dispose()},[]);
 function mounted(instance:monaco.editor.IStandaloneCodeEditor){
  editor.current=instance;provider.current?.dispose();instance.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.Enter,()=>run.current?.());
  provider.current=monaco.languages.registerCompletionItemProvider(language,{triggerCharacters:['.','$','{'],provideCompletionItems(model,position){
   if(model!==instance.getModel())return {suggestions:[]};
   const word=model.getWordUntilPosition(position),range={startLineNumber:position.lineNumber,endLineNumber:position.lineNumber,startColumn:word.startColumn,endColumn:word.endColumn},before=model.getLineContent(position.lineNumber).slice(0,word.startColumn-1),query=model.getValue(),kind=monaco.languages.CompletionItemKind;
   const suggestions:monaco.languages.CompletionItem[]=[];
   for(const [label,detail] of [['$__timeFilter',translate.current('当前时间范围','Current time range')],['$__timeInterval',translate.current('当前时间桶','Current time bucket')]]){const prefix=before.match(/\$[_\w]*$/);suggestions.push({label,insertText:label+'(${1:event_time})',detail,kind:kind.Variable,range:{...range,startColumn:prefix?word.startColumn-prefix[0].length:range.startColumn},insertTextRules:monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet});}
   for(const label of keywords)suggestions.push({label,insertText:label,kind:kind.Keyword,range});
   for(const label of functions)suggestions.push({label,insertText:label+'(${1})',kind:kind.Function,range,insertTextRules:monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet});
   for(const table of catalog.current)suggestions.push({label:table.name,insertText:table.name,detail:table.kind==='log'?translate.current('日志表','Log table'):table.kind==='metric'?translate.current('指标表','Metric table'):translate.current('链路表','Trace table'),kind:kind.Class,range});
   const referenced=catalog.current.filter(table=>new RegExp('\\b'+table.name+'\\b','i').test(query)),fields=new Map<string,string>();for(const table of referenced.length?referenced:catalog.current)for(const column of table.columns??[])fields.set(column.name,column.type);
   for(const [label,detail] of fields)suggestions.push({label,insertText:label,detail,kind:kind.Field,range});return {suggestions};
  }});
 }
 return <div className={`lm-sql-editor ${dark?'is-dark':''}`}><div className="lm-sql-editor-bar"><span className="lm-sql-language">SQL</span><span>ClickHouse</span><span className="lm-sql-editor-actions">{onRun&&<span>⌘ / Ctrl + Enter</span>}<Tooltip title={wrap?t('关闭自动换行','Disable word wrap'):t('开启自动换行','Enable word wrap')}><Button size="small" type="text" onClick={()=>setWrap(v=>!v)} aria-pressed={wrap}>{t('换行','Wrap')}</Button></Tooltip><Tooltip title={t('查找 SQL · ⌘ / Ctrl + F','Find SQL · ⌘ / Ctrl + F')}><Button size="small" type="text" onClick={()=>void editor.current?.getAction('actions.find')?.run()}>{t('查找','Find')}</Button></Tooltip></span></div><Editor height={height} language={language} theme={dark?'lightmoni-sql-dark':'lightmoni-sql-light'} value={value} onChange={value=>onChange?.(value??'')} options={{ariaLabel:ariaLabel??t('SQL 查询','SQL query'),minimap:{enabled:false},fontSize:13,fontFamily:'"SFMono-Regular",Consolas,"Liberation Mono",monospace',lineNumbers:'on',lineNumbersMinChars:3,scrollBeyondLastLine:false,automaticLayout:true,wordWrap:wrap?'on':'off',readOnly,padding:{top:10,bottom:10},tabSize:2,renderLineHighlight:'line',quickSuggestions:!readOnly,suggestOnTriggerCharacters:!readOnly,bracketPairColorization:{enabled:true},overviewRulerLanes:0,hideCursorInOverviewRuler:true,scrollbar:{verticalScrollbarSize:8,horizontalScrollbarSize:8}}} onMount={mounted}/></div>;
}
