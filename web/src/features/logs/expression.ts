import type {Filter} from './model';

// A deliberately small field-expression grammar. Expressions become visible,
// editable filter chips; unqualified words continue to search the log body.
export function parseExpression(text:string,columns:{name:string;type:string}[],attributes:string[]):{keyword:string;filters:Filter[]}{
 let quote='',escaped=false;for(const char of text){if(escaped){escaped=false;continue}if(char==='\\'&&quote){escaped=true;continue}if(quote){if(char===quote)quote=''}else if(char==='"'||char==="'")quote=char}if(quote)throw new Error('字段值引号未闭合。');
 const tokens=text.match(/(?:[^\s"']|"(?:[^"\\]|\\.)*"|'[^']*')+/g)??[];
 const filters:Filter[]=[],words:string[]=[];
 for(const token of tokens){
  if(token==='AND')continue;
  if(['OR','NOT','(',')'].includes(token))throw new Error('字段表达式支持 AND；组合条件可使用 SQL 模式。');
  const match=token.match(/^([@a-zA-Z_][\w.@:-]*?)(>=|<=|!=|=|>|<|:)(.+)$/);
  if(!match){words.push(token.startsWith('"')?JSON.parse(token):token);continue}
  const [,input,operator,literal]=match,key=input==='level'?'severity':input;
  const name=key.replace(/^@|^attributes\.|^attr:/,'');
  const column=columns.find(c=>c.name===name),attr=!column&&(attributes.includes(name)||key.startsWith('@')||key.startsWith('attributes.')||key.startsWith('attr:'));
  if(!column&&!attr)throw new Error(`未知字段 ${input}；自定义属性可写 @${name}:值。`);
  if(column&&/Map|Array/.test(column.type))throw new Error(`请使用 @属性名 查询 ${name} 内的属性。`);
  const quoted=/^["']/.test(literal);let value:unknown=literal;
  if(literal.startsWith('"')){try{value=JSON.parse(literal)}catch{throw new Error('字段值引号未闭合。')}}else if(literal.startsWith("'")){if(!literal.endsWith("'"))throw new Error('字段值引号未闭合。');value=literal.slice(1,-1)}
  let type:Filter['type']='string';
  if(column&&/Int|Float|Decimal/.test(column.type)||attr&&!quoted&&/^-?\d+(?:\.\d+)?$/.test(literal)){type='number';value=Number.isSafeInteger(Number(literal))||literal.includes('.')?Number(literal):literal}
  else if(attr&&!quoted&&(literal==='true'||literal==='false')){type='boolean';value=literal==='true'}
  const op=literal==='*'&&!quoted?'exists':({':':'eq','=':'eq','!=':'ne','>':'gt','>=':'gte','<':'lt','<=':'lte'} as Record<string,string>)[operator];
  if(['gt','gte','lt','lte'].includes(op)&&type!=='number')throw new Error(`${name} 的大小比较需要数字。`);
  filters.push({scope:attr?'attribute':'column',field:name,type,op,value:op==='exists'?undefined:value});
 }
 return {keyword:words.join(' '),filters};
}
