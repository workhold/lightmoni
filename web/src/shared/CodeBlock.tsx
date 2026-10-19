import {useMemo} from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import typescript from 'highlight.js/lib/languages/typescript';
import go from 'highlight.js/lib/languages/go';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import './code-block.css';

const highlighter=hljs.newInstance();
for(const [name,grammar] of Object.entries({bash,typescript,go,python,ruby,rust}))highlighter.registerLanguage(name,grammar);

export default function CodeBlock({code,language,ariaLabel}:{code:string;language:string;ariaLabel?:string}){
 const highlighted=useMemo(()=>highlighter.getLanguage(language)?highlighter.highlight(code,{language,ignoreIllegals:true}).value:undefined,[code,language]);
 return <pre className="lm-code lm-highlighted-code" aria-label={ariaLabel} tabIndex={0} data-language={language}>
  {highlighted===undefined?<code>{code}</code>:<code className={`hljs language-${language}`} dangerouslySetInnerHTML={{__html:highlighted}}/>}
 </pre>;
}
