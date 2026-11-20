import {Link} from 'react-router-dom';
import {useI18n} from '../shared/i18n';
import {version as appVersion} from '../../package.json';

export default function BrandMark({homepage}:{homepage:string}){
 const {t}=useI18n();
 return <Link to={homepage} className="lm-brand" aria-label={t('返回默认首页','Go to default homepage')}>
  <span className="lm-brand-mark" aria-hidden="true">L</span>
  <span className="lm-brand-copy">
   <span>LightMoni</span>
   <small>
    {t('监控工作台','Monitoring workspace')}
    <span className="lm-brand-version" title={t('LightMoni 版本','LightMoni version')}>v{appVersion}</span>
   </small>
  </span>
 </Link>;
}
