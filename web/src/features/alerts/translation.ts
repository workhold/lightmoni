import type {Language,Translator} from '../../shared/i18n';

export const chinese:Translator=(chinese)=>chinese;
export const translator=(language:Language):Translator=>(chinese,english)=>language==='en-US'?english:chinese;
