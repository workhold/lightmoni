type RenderCallbacks<T> = {
  render: (value:T)=>Promise<unknown>;
  before: ()=>void;
  committed: ()=>void;
  idle: (success:boolean)=>void;
  error: (error:unknown)=>void;
};

/** Never mutate a chart's options while its previous async paint is running. */
export class ChartRefreshQueue<T> {
  private pending?: {value:T};
  private running=false;
  private active=true;
  constructor(private callbacks:RenderCallbacks<T>) {}
  submit(value:T) {
    if(!this.active)return;
    this.pending={value};
    if(!this.running)void this.drain();
  }
  dispose() {this.active=false;this.pending=undefined;}
  private async drain() {
    this.running=true;
    let success=false;
    while(this.active&&this.pending) {
      const {value}=this.pending;
      this.pending=undefined;
      try {
        this.callbacks.before();
        await this.callbacks.render(value);
        if(!this.active)break;
        this.callbacks.committed();
        success=true;
      } catch(error) {
        success=false;
        if(this.active)this.callbacks.error(error);
      }
    }
    this.running=false;
    if(this.active)this.callbacks.idle(success);
  }
}

/** Keep the last completed pixels visible while G2 updates its scene/axes. */
export class ChartFrameBuffer {
  private canvas?: HTMLCanvasElement;
  private ready=false;
  constructor(private container:HTMLElement) {}
  markReady() {this.ready=true;}
  capture() {
    if(!this.ready)return;
    const source=this.container.querySelector<HTMLCanvasElement>('canvas:not(.lm-chart-frame)');
    if(!source?.width||!source.height)return;
    const canvas=this.canvas??this.container.ownerDocument.createElement('canvas');
    if(!this.canvas){canvas.className='lm-chart-frame';canvas.setAttribute('aria-hidden','true');canvas.hidden=true;this.container.appendChild(canvas);this.canvas=canvas;}
    canvas.width=source.width;canvas.height=source.height;
    const context=canvas.getContext('2d');
    if(!context)return;
    // Canvas pixels are transparent between marks. Match the actual ancestor
    // background so a partially updated live chart cannot show through them.
    let background='var(--lm-surface)',element:HTMLElement|null=this.container;
    const view=this.container.ownerDocument.defaultView;
    while(element&&view){
      const color=view.getComputedStyle(element).backgroundColor;
      if(color&&color!=='transparent'&&!/^rgba\([^)]*,\s*0\)$/.test(color)){background=color;break;}
      element=element.parentElement;
    }
    canvas.style.backgroundColor=background;
    context.drawImage(source,0,0);
    canvas.hidden=false;
    // A failed/partial paint must never replace this completed snapshot on retry.
    this.ready=false;
  }
  release() {if(this.canvas)this.canvas.hidden=true;}
  dispose() {this.canvas?.remove();this.canvas=undefined;this.ready=false;}
}
