//! Native synchronous OTLP/HTTP client. Recording does not perform network I/O.
mod record;
pub use record::Options;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, VecDeque}, io::Read, sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use uuid::Uuid;

pub type Attributes = BTreeMap<String, Attribute>;
#[derive(Clone, Debug)]
pub enum Attribute { String(String), Bool(bool), Int(i64), Double(f64) }
impl From<&str> for Attribute { fn from(v: &str) -> Self { Self::String(v.into()) } }
impl From<String> for Attribute { fn from(v: String) -> Self { Self::String(v) } }
impl From<bool> for Attribute { fn from(v: bool) -> Self { Self::Bool(v) } }
impl From<i64> for Attribute { fn from(v: i64) -> Self { Self::Int(v) } }
impl From<f64> for Attribute { fn from(v: f64) -> Self { Self::Double(v) } }
pub type Result<T> = std::result::Result<T, String>;
fn nano() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() }
fn attrs(values: &Attributes) -> Result<Value> {
    if values.len()>32 { return Err("attribute count exceeded".into()); }
    let mut result=Vec::new();
    for (key,value) in values {
        if key.is_empty() || key.len()>128 { return Err("invalid attribute key".into()); }
        let v=match value {
            Attribute::String(v)=>json!({"stringValue":v}), Attribute::Bool(v)=>json!({"boolValue":v}),
            Attribute::Int(v)=>json!({"intValue":v.to_string()}),
            Attribute::Double(v) if v.is_finite()=>json!({"doubleValue":v}),
            _=>return Err("nonfinite attribute".into())
        };
        result.push(json!({"key":key,"value":v}));
    }
    let result=json!(result);
    if result.to_string().len()>4096 { return Err("attribute bytes exceeded".into()); }
    Ok(result)
}
fn table(v:&str)->Result<String> {
    if v.is_empty() || v.len()>48 || !v.as_bytes()[0].is_ascii_lowercase()
        || !v.bytes().all(|c|c.is_ascii_lowercase() || c.is_ascii_digit() || c==b'_')
        || ["log_","metric_","trace_"].iter().any(|p|v.starts_with(p)) { return Err("invalid logical table".into()); }
    Ok(v.into())
}
#[derive(Clone, Debug)]
pub struct Limits {
    pub queue_bytes:usize, pub queue_batches:usize, pub buffer_bytes:usize,
    pub max_batch_bytes:usize, pub cardinality_limit:usize, pub max_instruments:usize,
    pub self_telemetry:bool,
}
impl Default for Limits {
    fn default()->Self { Self {queue_bytes:8<<20,queue_batches:256,buffer_bytes:8<<20,max_batch_bytes:1<<20,cardinality_limit:2000,max_instruments:256,self_telemetry:true} }
}
#[derive(Clone, Debug, PartialEq)]
pub struct TraceContext { pub trace_id:String, pub span_id:String, pub flags:u8, pub trace_state:String }
impl TraceContext {
    pub fn valid(&self)->bool {
        let hex=|v:&str,n:usize|v.len()==n && v.bytes().all(|c|c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) && v.bytes().any(|c|c!=b'0');
        hex(&self.trace_id,32) && hex(&self.span_id,16) && self.trace_state.len()<=512
    }
    pub fn inject(&self)->Result<BTreeMap<String,String>> {
        if !self.valid() {return Err("invalid trace context".into());}
        let mut h=BTreeMap::from([("traceparent".into(),format!("00-{}-{}-{:02x}",self.trace_id,self.span_id,self.flags))]);
        if !self.trace_state.is_empty(){h.insert("tracestate".into(),self.trace_state.clone());} Ok(h)
    }
    pub fn extract(headers:&BTreeMap<String,String>)->Option<Self> {
        let h:BTreeMap<_,_>=headers.iter().map(|(k,v)|(k.to_lowercase(),v)).collect();
        let p:Vec<_>=h.get("traceparent")?.split('-').collect();
        if p.len()!=4 || p[0]!="00" || p[3].len()!=2 || !p[3].bytes().all(|c|c.is_ascii_digit() || (b'a'..=b'f').contains(&c)){return None;}
        let ctx=Self {trace_id:p[1].into(),span_id:p[2].into(),flags:u8::from_str_radix(p[3],16).ok()?,trace_state:h.get("tracestate").map(|v|v.to_string()).unwrap_or_default()};
        ctx.valid().then_some(ctx)
    }
}
#[derive(Clone)]
struct Batch { seq:u64,id:String,created:String,table:String,signal:String,raw:Vec<u8>,count:usize }
struct Point { attrs:Value,integer:i64,value:f64,count:u64,buckets:Vec<u64>,min:f64,max:f64,at:u128 }
struct Instrument { table:String,name:String,kind:String,unit:String,bounds:Vec<f64>,start:u128,series:BTreeMap<String,Point> }
struct State {
    observations:BTreeMap<String,record::Observation>,
    endpoint:String,key:String,limits:Limits,resource:Value,http:reqwest::blocking::Client,
    metrics:BTreeMap<String,Instrument>,records:BTreeMap<(String,String),Vec<Value>>,queue:VecDeque<Batch>,
    stats:BTreeMap<String,u64>,last_error:String,failure:Option<String>,seq:u64,closed:bool,
    self_table:String,self_last:Option<Instant>,self_started:bool,self_previous:BTreeMap<String,u64>,
}
impl State {
    fn invalid(&mut self,message:String){*self.stats.get_mut("invalid_records").unwrap()+=1;self.last_error=message;}
    fn lost(&mut self,count:usize,message:&str){*self.stats.get_mut("dropped_records").unwrap()+=count as u64;self.last_error=message.into();self.failure=Some(message.into());}
    fn reserve(&mut self,size:usize)->bool {
        if self.stats["buffer_bytes"]+size as u64>self.limits.buffer_bytes as u64 {self.lost(1,"SDK active buffer exceeded");return false;}
        *self.stats.get_mut("buffer_bytes").unwrap()+=size as u64;true
    }
    fn store(&mut self,table:&str,signal:&str,record:Value) {
        if self.closed{self.invalid("record after shutdown".into());return;}
        if self.reserve(record.to_string().len()+64){self.records.entry((table.into(),signal.into())).or_default().push(record);}
    }
    fn payload(&self,signal:&str,rows:&[Value])->Vec<u8> {
        let (resource,scope,field)=match signal {"metrics"=>("resourceMetrics","scopeMetrics","metrics"),"logs"=>("resourceLogs","scopeLogs","logRecords"),_=>("resourceSpans","scopeSpans","spans")};
        if signal=="metrics" {
            let mut scopes:BTreeMap<String,BTreeMap<String,Value>>=BTreeMap::new();
            for row in rows{let name=row["name"].as_str().unwrap().to_string();let kind=["sum","gauge","histogram","exponentialHistogram","summary"].into_iter().find(|k|!row[*k].is_null()).unwrap();let scope=match scopes.get("").and_then(|m|m.get(&name)){Some(existing)if existing[kind].is_null()=>kind,_=>""};let merged=scopes.entry(scope.into()).or_default();if let Some(existing)=merged.get_mut(&name){existing[kind]["dataPoints"].as_array_mut().unwrap().extend(row[kind]["dataPoints"].as_array().unwrap().iter().cloned());}else{merged.insert(name,row.clone());}}
            return json!({"resourceMetrics":[{"resource":self.resource,"scopeMetrics":scopes.into_iter().map(|(kind,rows)|json!({"scope":{"name":if kind.is_empty(){"lightmoni/sdk/rust".to_string()}else{format!("lightmoni/sdk/rust/{kind}")},"version":"0.1.0"},"metrics":rows.into_values().collect::<Vec<_>>()})).collect::<Vec<_>>()}]}).to_string().into_bytes();
        }
        json!({resource:[{"resource":self.resource,scope:[{"scope":{"name":"lightmoni/sdk/rust","version":"0.1.0"},field:rows}]}]}).to_string().into_bytes()
    }
    fn collect(&mut self) {
        let now=nano();
        for(_,observation)in std::mem::take(&mut self.observations){let rows=observation.records(now);self.records.entry((observation.table,"metrics".into())).or_default().extend(rows);}
        for m in self.metrics.values_mut() {
            let end=now.max(m.start);
            for p in m.series.values() {
                let mut row=json!({"attributes":p.attrs,"timeUnixNano":if m.kind=="gauge"{p.at}else{end}.to_string()});
                let mut record=json!({"name":m.name,"unit":m.unit});
                match m.kind.as_str() {
                    "counter"=>{row["startTimeUnixNano"]=json!(m.start.to_string());row["asInt"]=json!(p.integer.to_string());record["sum"]=json!({"dataPoints":[row],"aggregationTemporality":1,"isMonotonic":true});}
                    "gauge"=>{row["asDouble"]=json!(p.value);record["gauge"]=json!({"dataPoints":[row]});}
                    _=>{
                        row["startTimeUnixNano"]=json!(m.start.to_string());row["count"]=json!(p.count.to_string());row["sum"]=json!(p.value);
                        row["min"]=json!(p.min);row["max"]=json!(p.max);row["explicitBounds"]=json!(m.bounds);row["bucketCounts"]=json!(p.buckets.iter().map(u64::to_string).collect::<Vec<_>>());
                        record["histogram"]=json!({"dataPoints":[row],"aggregationTemporality":1});
                    }
                }
                self.records.entry((m.table.clone(),"metrics".into())).or_default().push(record);
            }
            m.series.clear();m.start=end;
        }
        let n=nano();let created=format_rfc3339(n);
        let records=std::mem::take(&mut self.records);
        for ((table,signal),rows) in records {
            let base=self.payload(&signal,&[]).len();let mut size=base;let mut group=Vec::new();
            for row in rows {
                let cost=row.to_string().len()+1;
                if !group.is_empty() && size+cost>self.limits.max_batch_bytes {self.enqueue(&table,&signal,&group,&created);group.clear();size=base;}
                group.push(row);size+=cost;
            }
            if !group.is_empty(){self.enqueue(&table,&signal,&group,&created);}
        }
        self.stats.insert("buffer_bytes".into(),0);
        self.collect_self();
    }
    fn enqueue_self(&mut self,signal:&str,rows:&[Value],at:&str)->bool {
        let size=self.payload(signal,rows).len();
        if size>self.limits.max_batch_bytes || self.queue.len()>=self.limits.queue_batches || self.stats["pending_bytes"]+size as u64>self.limits.queue_bytes as u64{return false;}
        let table=self.self_table.clone();self.enqueue(&table,signal,rows,at);true
    }
    fn collect_self(&mut self) {
        if self.key.is_empty() || !self.limits.self_telemetry || self.self_last.is_some_and(|at|at.elapsed()<Duration::from_secs(30)){return;}
        self.self_last=Some(Instant::now());let at=format_rfc3339(nano());let time=nano().to_string();
        let attributes=json!([{"key":"lightmoni.component","value":{"stringValue":"sdk"}},{"key":"sdk.language","value":{"stringValue":"rust"}},{"key":"sdk.version","value":{"stringValue":"0.1.0"}}]);
        let mut values=BTreeMap::from([("heartbeat",1)]);
        for name in ["pending_batches","pending_bytes","retried_batches","dropped_records","rejected_records","invalid_records","overflow_records"]{values.insert(name,self.stats[name]);}
        let rows:Vec<_>=values.iter().map(|(name,value)|json!({"name":format!("lightmoni.sdk.{name}"),"gauge":{"dataPoints":[{"timeUnixNano":time,"asDouble":value,"attributes":attributes}]}})).collect();
        self.enqueue_self("metrics",&rows,&at);
        let changed=["retried_batches","dropped_records","rejected_records","invalid_records","overflow_records"].iter().any(|n|self.stats[*n]>*self.self_previous.get(*n).unwrap_or(&0));
        if !self.self_started || changed {
            let mut logattrs=attributes.as_array().unwrap().clone();logattrs.push(json!({"key":"event","value":{"stringValue":if self.self_started{"diagnostics_changed"}else{"started"}}}));
            let row=json!({"timeUnixNano":time,"severityText":if changed{"WARN"}else{"INFO"},"severityNumber":if changed{13}else{9},"body":{"stringValue":if changed{"LightMoni SDK delivery, buffer or input diagnostics changed"}else{"LightMoni SDK started"}},"attributes":logattrs});
            if self.enqueue_self("logs",&[row],&at){self.self_started=true;self.self_previous=self.stats.clone();}
        }
    }
    fn enqueue(&mut self,table:&str,signal:&str,rows:&[Value],created:&str) {
        let raw=self.payload(signal,rows);self.seq+=1;
        if raw.len()>self.limits.max_batch_bytes || self.queue.len()>=self.limits.queue_batches || self.stats["pending_bytes"]+raw.len() as u64>self.limits.queue_bytes as u64{self.lost(rows.len(),"SDK queue or batch capacity exceeded");return;}
        *self.stats.get_mut("pending_batches").unwrap()+=1;*self.stats.get_mut("pending_bytes").unwrap()+=raw.len() as u64;
        self.queue.push_back(Batch {seq:self.seq,id:Uuid::new_v4().to_string(),created:created.into(),table:table.into(),signal:signal.into(),raw,count:rows.len()});
    }
}
// Civil-date conversion avoids a calendar dependency for one protocol header.
fn format_rfc3339(n:u128)->String {
    let seconds=(n/1_000_000_000) as i64;let z=seconds/86400+719468;let era=z/146097;let doe=z-era*146097;
    let yoe=(doe-doe/1460+doe/36524-doe/146096)/365;let mut year=yoe+era*400;
    let doy=doe-(365*yoe+yoe/4-yoe/100);let mp=(5*doy+2)/153;let day=doy-(153*mp+2)/5+1;let month=mp+if mp<10{3}else{-9};if month<=2{year+=1;}
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:09}Z",(seconds/3600)%24,(seconds/60)%60,seconds%60,n%1_000_000_000)
}
#[derive(Clone)]
pub struct Client { state:Arc<Mutex<State>>,delivery:Arc<Mutex<()>>,table:String,context:Option<TraceContext> }
impl Client {
    /// Initialize without binding a business table; use with_table before recording.
    pub fn connect(service:&str,endpoint:&str,key:&str)->Result<Self>{Self::with_limits(service,"",endpoint,key,Limits::default())}
    pub fn new(service:&str,table_name:&str,endpoint:&str,key:&str)->Result<Self>{Self::with_limits(service,table_name,endpoint,key,Limits::default())}
    pub fn with_limits(service:&str,table_name:&str,endpoint:&str,key:&str,limits:Limits)->Result<Self> {
        let table=if table_name.is_empty(){String::new()}else{table(table_name)?};let url=reqwest::Url::parse(endpoint).map_err(|_|"invalid endpoint")?;
        if service.is_empty() || service.len()>128 || !["http","https"].contains(&url.scheme()) || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some(){return Err("valid service and HTTP(S) endpoint required".into());}
        if [limits.queue_bytes,limits.queue_batches,limits.buffer_bytes,limits.max_batch_bytes,limits.cardinality_limit,limits.max_instruments].contains(&0) || limits.max_batch_bytes>limits.queue_bytes{return Err("invalid SDK limits".into());}
        let http=reqwest::blocking::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"cannot initialize HTTP transport")?;
        let stats=["pending_batches","pending_bytes","buffer_bytes","delivered_batches","retried_batches","invalid_records","overflow_records","dropped_records","rejected_records"].iter().map(|n|(n.to_string(),0)).collect();
        let resource=json!({"attributes":attrs(&BTreeMap::from([("service.name".into(),service.into()),("service.instance.id".into(),Uuid::new_v4().to_string().into())]))?});
        let s=State{observations:BTreeMap::new(),endpoint:endpoint.trim_end_matches('/').into(),key:key.into(),limits,resource,http,metrics:BTreeMap::new(),records:BTreeMap::new(),queue:VecDeque::new(),stats,last_error:String::new(),failure:None,seq:0,closed:false,self_table:"lightmoni_sdk".into(),self_last:None,self_started:false,self_previous:BTreeMap::new()};
        let enabled=true;
        let client=Self{state:Arc::new(Mutex::new(s)),delivery:Arc::new(Mutex::new(())),table,context:None};
        if enabled {
            let state=Arc::downgrade(&client.state);let delivery=Arc::downgrade(&client.delivery);let table=client.table.clone();
            std::thread::Builder::new().name("lightmoni-heartbeat".into()).spawn(move || loop {
                std::thread::sleep(Duration::from_secs(10));
                let (Some(state),Some(delivery))=(state.upgrade(),delivery.upgrade()) else {break;};
                if state.lock().unwrap().closed{break;}
                let root=Client{state,delivery,table:table.clone(),context:None};let _=root.flush(Duration::from_secs(5));
            }).map_err(|_|"cannot start SDK heartbeat worker")?;
        }
        Ok(client)
    }
    pub fn with_table(&self,name:&str)->Result<Self>{Ok(Self{table:table(name)?,..self.clone()})}
    /// Immutable task binding; safe when an async task moves between threads.
    pub fn with_trace(&self,context:&TraceContext)->Result<Self>{
        if !context.valid(){return Err("invalid trace context".into());}
        Ok(Self{context:Some(context.clone()),..self.clone()})
    }
    pub fn current_trace(&self)->Option<&TraceContext>{self.context.as_ref()}
    pub fn trace_headers(&self)->Result<BTreeMap<String,String>>{match &self.context{Some(context)=>context.inject(),None=>Ok(BTreeMap::new())}}
    pub fn with_span<T>(&self,name:&str,attributes:&Attributes,parent:Option<&TraceContext>,action:impl FnOnce(&Client,&mut Span)->T)->Result<T>{
        let mut span=self.start_span(name,attributes,parent)?;
        let client=self.with_trace(&span.context)?;
        let result=action(&client,&mut span);span.end();Ok(result)
    }
    pub fn counter(&self,name:&str)->Result<Metric>{self.instrument(name,"counter","",&[])}
    pub fn gauge(&self,name:&str)->Result<Metric>{self.instrument(name,"gauge","",&[])}
    pub fn histogram(&self,name:&str,bounds:&[f64])->Result<Metric>{self.instrument(name,"histogram","",bounds)}
    pub fn instrument(&self,name:&str,kind:&str,unit:&str,bounds:&[f64])->Result<Metric> {
        table(&self.table)?;
        if name.is_empty() || name.len()>255 || unit.len()>64 || !["counter","gauge","histogram"].contains(&kind) || bounds.len()>128 || bounds.iter().any(|n|!n.is_finite()) || bounds.windows(2).any(|p|p[0]>=p[1]){return Err("invalid metric identity/boundaries".into());}
        let bounds=if kind=="histogram"{bounds.to_vec()}else{Vec::new()};let id=format!("{}\0{}",self.table,name);let mut s=self.state.lock().unwrap();
        if s.closed{return Err("SDK is closed".into());}
        if let Some(m)=s.metrics.get(&id){if m.kind!=kind || m.unit!=unit || m.bounds!=bounds{return Err("conflicting metric registration".into());}}
        else{if s.metrics.len()>=s.limits.max_instruments{return Err("instrument limit exceeded".into());}s.metrics.insert(id.clone(),Instrument{table:self.table.clone(),name:name.into(),kind:kind.into(),unit:unit.into(),bounds,start:nano(),series:BTreeMap::new()});}
        Ok(Metric{state:self.state.clone(),id,kind:kind.into()})
    }
    pub fn log(&self,severity:&str,body:&str,attributes:&Attributes,context:Option<&TraceContext>) {
        let context=context.or(self.context.as_ref());
        let result=(||{
            table(&self.table)?;
            let level=severity.to_lowercase();let i=["trace","debug","info","warn","error","fatal"].iter().position(|n|*n==level).ok_or("invalid log severity")?;
            if body.len()>65536 || context.is_some_and(|c|!c.valid()){return Err("invalid log body/context".into());}
            let now=nano().to_string();let mut row=json!({"timeUnixNano":now,"observedTimeUnixNano":now,"severityText":level,"severityNumber":1+4*i,"body":{"stringValue":body},"attributes":attrs(attributes)?});
            if let Some(c)=context{row["traceId"]=json!(c.trace_id);row["spanId"]=json!(c.span_id);row["flags"]=json!(c.flags);}
            Ok(row)
        })();
        let mut s=self.state.lock().unwrap();match result{Ok(row)=>s.store(&self.table,"logs",row),Err(e)=>s.invalid(e)}
    }
    pub fn start_span(&self,name:&str,attributes:&Attributes,parent:Option<&TraceContext>)->Result<Span> {
        table(&self.table)?;
        let parent=parent.or(self.context.as_ref());
        if self.state.lock().unwrap().closed{return Err("SDK is closed".into());}
        if name.is_empty() || name.len()>255 || parent.is_some_and(|p|!p.valid()){return Err("invalid span name/context".into());}
        let context=TraceContext{trace_id:parent.map(|p|p.trace_id.clone()).unwrap_or_else(||Uuid::new_v4().simple().to_string()),span_id:Uuid::new_v4().simple().to_string()[..16].into(),flags:parent.map(|p|p.flags).unwrap_or(1),trace_state:parent.map(|p|p.trace_state.clone()).unwrap_or_default()};
        let mut data=json!({"name":name,"kind":1,"traceId":context.trace_id,"spanId":context.span_id,"flags":context.flags,"startTimeUnixNano":nano().to_string(),"attributes":attrs(attributes)?});
        if let Some(p)=parent{data["parentSpanId"]=json!(p.span_id);if !p.trace_state.is_empty(){data["traceState"]=json!(p.trace_state);}}
        Ok(Span{client:self.clone(),context,data,ended:false})
    }
    pub fn stats(&self)->Value {let s=self.state.lock().unwrap();let mut value=json!(s.stats);value["last_error"]=json!(s.last_error);value}
    pub fn update_key(&self,key:&str){self.state.lock().unwrap().key=key.into();}
    pub fn flush(&self,timeout:Duration)->Result<()> {
        if timeout.is_zero(){return Err("timeout must be positive".into());}
        let deadline=Instant::now()+timeout;
        let _guard=loop{if let Ok(g)=self.delivery.try_lock(){break g;}if Instant::now()>=deadline{return Err("flush deadline exceeded".into());}std::thread::sleep(Duration::from_millis(1));};
        let target={let mut s=self.state.lock().unwrap();if s.closed{return Err("SDK is closed".into());}s.collect();s.seq};
        let mut backoff=0.2;
        loop {
            let (b,http,url,key)={let s=self.state.lock().unwrap();match s.queue.front(){Some(b) if b.seq<=target=>(b.clone(),s.http.clone(),s.endpoint.clone(),s.key.clone()),_=>return s.failure.clone().map_or(Ok(()),Err)}};
            if b.table=="lightmoni_sdk" && key.is_empty(){let mut s=self.state.lock().unwrap();s.queue.pop_front();*s.stats.get_mut("pending_batches").unwrap()-=1;*s.stats.get_mut("pending_bytes").unwrap()-=b.raw.len() as u64;continue;}
            let remaining=deadline.saturating_duration_since(Instant::now());if remaining.is_zero(){return Err("flush deadline exceeded; batches retained".into());}
            let mut status=0;let mut delay=0.0;let mut rejected=0;let mut ack=false;
            let mut request=http.post(format!("{url}/v1/{}",b.signal)).timeout(remaining.min(Duration::from_secs(10))).header("Content-Type","application/json").header("X-Lightmoni-Table",&b.table).header("X-Lightmoni-Batch-ID",&b.id).header("X-Lightmoni-Batch-Created-At",&b.created).body(b.raw.clone());
            if !key.is_empty(){request=request.bearer_auth(key);}
            if let Ok(response)=request.send(){
                status=response.status().as_u16();
                if let Some(raw)=response.headers().get("Retry-After").and_then(|v|v.to_str().ok()){
                    delay=raw.parse::<u64>().map(|n|n as f64).unwrap_or_else(|_|httpdate::parse_http_date(raw).ok().and_then(|d|d.duration_since(SystemTime::now()).ok()).map(|d|d.as_secs_f64()).unwrap_or(0.0));
                }
                if status==200 {
                    let mut body=Vec::new();
                    if response.take(65537).read_to_end(&mut body).is_ok() && body.len()<=65536{
                        if let Ok(value)=serde_json::from_slice::<Value>(if body.is_empty(){b"{}"}else{&body}){
                            if value.is_object() && (value["partialSuccess"].is_null() || value["partialSuccess"].is_object()){
                                let field=match b.signal.as_str(){"logs"=>"rejectedLogRecords","metrics"=>"rejectedDataPoints",_=>"rejectedSpans"};
                                let partial=&value["partialSuccess"][field];
                                let count=if partial.is_null(){Some(0)}else{partial.as_u64().or_else(||partial.as_str().and_then(|v|v.parse().ok()))};
                                if let Some(n)=count{rejected=n;ack=true;}
                            }
                        }
                    }
                    if !ack{status=0;}
                }
            }
            {
                let mut s=self.state.lock().unwrap();
                if ack || ![0,401,403,429,502,503,504].contains(&status){
                    s.queue.pop_front();*s.stats.get_mut("pending_batches").unwrap()-=1;*s.stats.get_mut("pending_bytes").unwrap()-=b.raw.len() as u64;
                    if ack && rejected==0{*s.stats.get_mut("delivered_batches").unwrap()+=1;}
                    else{*s.stats.get_mut("rejected_records").unwrap()+=if rejected>0{rejected}else{b.count as u64};s.last_error=if ack{"OTLP partial success; not retried".into()}else{format!("telemetry rejected with HTTP {status}")};s.failure=Some(s.last_error.clone());}
                    backoff=0.2;continue;
                }
                *s.stats.get_mut("retried_batches").unwrap()+=1;s.last_error=format!("telemetry delivery failed (HTTP {status})");
            }
            let jitter=Uuid::new_v4().as_bytes()[0] as f64/255.0;
            delay=delay.max(if status==401 || status==403{30.0}else{backoff*(0.8+jitter*0.4)});
            std::thread::sleep(Duration::from_secs_f64(delay.min(deadline.saturating_duration_since(Instant::now()).as_secs_f64())));
            backoff=(backoff*2.0).min(30.0);
        }
    }
    pub fn shutdown(&self,timeout:Duration)->Result<()> {let result=self.flush(timeout);self.state.lock().unwrap().closed=true;result}
}
#[derive(Clone)]
pub struct Metric {state:Arc<Mutex<State>>,id:String,kind:String}
impl Metric {
    pub fn add(&self,value:i64,attributes:&Attributes){if self.kind!="counter"{self.state.lock().unwrap().invalid("add requires counter".into());return;}self.record_number(value,value as f64,attributes);}
    pub fn record(&self,value:f64,attributes:&Attributes){if self.kind=="counter"{self.state.lock().unwrap().invalid("use add(i64)".into());return;}self.record_number(0,value,attributes);}
    fn record_number(&self,integer:i64,value:f64,attributes:&Attributes){
        let mut s=self.state.lock().unwrap();
        if s.closed || !value.is_finite() || (self.kind=="counter" && integer<0){s.invalid("invalid metric value or closed SDK".into());return;}
        let mut a=match attrs(attributes){Ok(v)=>v,Err(e)=>{s.invalid(e);return;}};let mut key=a.to_string();
        let m=&s.metrics[&self.id];
        if !m.series.contains_key(&key) && m.series.len()>=s.limits.cardinality_limit{key="overflow".into();a=json!([{"key":"otel.metric.overflow","value":{"boolValue":true}}]);*s.stats.get_mut("overflow_records").unwrap()+=1;}
        if !s.metrics[&self.id].series.contains_key(&key){
            let buckets=s.metrics[&self.id].bounds.len()+1;if !s.reserve(key.len()+160+8*buckets){return;}
            s.metrics.get_mut(&self.id).unwrap().series.insert(key.clone(),Point{attrs:a,integer:0,value:0.0,count:0,buckets:vec![0;buckets],min:value,max:value,at:0});
        }
        let m=s.metrics.get_mut(&self.id).unwrap();let p=m.series.get_mut(&key).unwrap();
        if self.kind=="counter"{if let Some(n)=p.integer.checked_add(integer){p.integer=n;}else{s.invalid("counter overflow".into());return;}}
        else if self.kind=="gauge"{p.value=value;}
        else{
            if !(p.value+value).is_finite() || p.count==u64::MAX{s.invalid("histogram overflow".into());return;}
            p.value+=value;p.count+=1;let bucket=m.bounds.iter().position(|b|value<=*b).unwrap_or(m.bounds.len());p.buckets[bucket]+=1;p.min=p.min.min(value);p.max=p.max.max(value);
        }
        p.at=nano();
    }
}
pub struct Span {client:Client,pub context:TraceContext,data:Value,ended:bool}
impl Span {
    pub fn set_error(&mut self,message:&str){if !self.ended{self.data["status"]=json!({"code":2,"message":message.chars().take(4096).collect::<String>()});}}
    pub fn end(&mut self){if self.ended{return;}self.ended=true;let start=self.data["startTimeUnixNano"].as_str().unwrap().parse::<u128>().unwrap();self.data["endTimeUnixNano"]=json!(nano().max(start).to_string());self.client.state.lock().unwrap().store(&self.client.table,"traces",self.data.clone());}
}
impl Drop for Span {fn drop(&mut self){if !self.ended && std::thread::panicking(){self.set_error("span scope panicked");}self.end();}}
