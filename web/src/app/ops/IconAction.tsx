import {forwardRef,type ComponentProps} from 'react';
import {Button,Tooltip} from '../../shared/ui';

/** One accessible name and a visible hint for every compact operation. */
const IconAction=forwardRef<HTMLButtonElement,ComponentProps<typeof Button>&{label:string}>(function IconAction({label,className,...props},ref){
 return <Tooltip title={label} trigger={['hover','focus']}><Button ref={ref} aria-label={label} {...props} className={['lm-icon-action',className].filter(Boolean).join(' ')}/></Tooltip>;
});
export default IconAction;
