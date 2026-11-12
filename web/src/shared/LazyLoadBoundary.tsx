import {Component,type ReactNode} from 'react';
import {Alert,Button,Space} from './ui';
import {useI18n} from './i18n';

export class LazyLoadBoundary extends Component<{children:ReactNode;fallback:ReactNode},{failed:boolean}>{
 state={failed:false};
 // React.lazy keeps a rejected import; a page reload picks up the latest HTML and asset hashes.
 static getDerivedStateFromError(){return {failed:true}}
 render(){return this.state.failed?this.props.fallback:this.props.children}
}

export function LazyLoadFailure({onClose}:{onClose?:()=>void}){
 const {t}=useI18n();
 return <div><Alert role="alert" type="error" showIcon title={t('界面资源加载失败','Unable to load this interface')} description={t('请刷新页面后重试。','Refresh the page and try again.')}/><Space><Button type="primary" onClick={()=>window.location.reload()}>{t('刷新页面','Refresh page')}</Button>{onClose&&<Button onClick={onClose}>{t('关闭','Close')}</Button>}</Space></div>;
}
