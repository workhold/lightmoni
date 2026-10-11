use lightmoni::{Attributes,Client,Limits,TraceContext};
use std::{collections::BTreeMap,env,time::Duration};
fn var(n:&str,fallback:&str)->String{env::var(n).unwrap_or_else(|_|fallback.into())}
fn run()->lightmoni::Result<()> {
    let mode=var("LIGHTMONI_TEST_MODE","demo");let mut limits=Limits::default();
    if mode=="overflow"{limits.cardinality_limit=2;}
    if mode=="capacity"{limits.queue_bytes=1024;limits.max_batch_bytes=1024;limits.buffer_bytes=64;}
    let mon=Client::with_limits(&var("LIGHTMONI_SERVICE","example-rust-api"),"http",&var("LIGHTMONI_ENDPOINT","http://127.0.0.1:4318"),&var("LIGHTMONI_KEY",""),limits)?;
    let counter=mon.counter("http.requests")?;
    match mode.as_str() {
        "fixture"=>{
            let mut dims=Attributes::from([("route".into(),"/payments".into()),("method".into(),"POST".into()),("status".into(),200i64.into())]);
            counter.add(1,&dims);dims.insert("status".into(),999i64.into());
            counter.add(2,&Attributes::from([("status".into(),200i64.into()),("method".into(),"POST".into()),("route".into(),"/payments".into())]));
            counter.add(1,&Attributes::from([("status".into(),500i64.into()),("method".into(),"POST".into()),("route".into(),"/payments".into())]));
            counter.add(1,&Attributes::from([("typed".into(),1i64.into())]));counter.add(1,&Attributes::from([("typed".into(),"1".into())]));counter.add(-1,&Attributes::new());
            mon.counter("exact")?.add(9007199254740993,&Attributes::new());
            let gauge=mon.gauge("active")?;gauge.record(5.0,&Attributes::new());gauge.record(7.0,&Attributes::new());
            let histogram=mon.histogram("duration",&[5.0,10.0])?;for n in [-1.0,5.0,6.0,10.0,11.0]{histogram.record(n,&Attributes::new());}
            let parent=TraceContext::extract(&BTreeMap::from([("traceparent".into(),format!("00-{}-{}-01","a".repeat(32),"b".repeat(16))),("tracestate".into(),"foo=bar".into())])).unwrap();
            assert!(TraceContext::extract(&BTreeMap::from([("traceparent".into(),format!("00-{}-{}-01","0".repeat(32),"b".repeat(16)))])).is_none());
            assert_eq!(TraceContext::extract(&parent.inject()?),Some(parent.clone()));
            let app=mon.with_table("app")?;let mut span=app.start_span("fixture",&Attributes::new(),Some(&parent))?;
            app.log("info","中文 fixture",&Attributes::from([("exact".into(),9007199254740993i64.into()),("ok".into(),true.into()),("fraction".into(),0.125f64.into())]),Some(&span.context));span.end();
            mon.flush(Duration::from_secs(10))?;counter.add(2,&Attributes::from([("window".into(),"next".into())]));mon.flush(Duration::from_secs(10))?;
        }
        "overflow"=>{for n in 0..4{counter.add(1,&Attributes::from([("dimension".into(),(n as i64).into())]));}mon.flush(Duration::from_secs(10))?;}
        "retry"|"auth"=>{
            counter.add(1,&Attributes::from([("window".into(),"first".into())]));
            assert!(mon.flush(Duration::from_millis(450)).is_err());assert_eq!(mon.stats()["pending_batches"],1);
            counter.add(2,&Attributes::from([("window".into(),"next".into())]));mon.update_key("rotated");mon.flush(Duration::from_secs(10))?;
        }
        "permanent"|"partial"|"capacity"=>{
            counter.add(1,&Attributes::new());for _ in 0..2{assert!(mon.flush(Duration::from_secs(10)).is_err());}assert_eq!(mon.stats()["pending_batches"],0);
        }
        _=>{
            let app=mon.with_table("app")?;let duration=mon.histogram("http.duration",&[5.0,10.0,25.0,50.0,100.0,250.0])?;let active=mon.gauge("http.active")?;
            for i in 0..var("LIGHTMONI_COUNT","20").parse::<i64>().unwrap(){
                let status=if i%5==0{500}else{200};let mut span=app.start_span("POST /payments",&Attributes::new(),None)?;
                let attrs=Attributes::from([("route".into(),"/payments".into()),("method".into(),"POST".into()),("status".into(),status.into())]);
                counter.add(1,&attrs);duration.record((5+i*2) as f64,&attrs);active.record((i%4) as f64,&Attributes::new());
                app.log(if status==500{"error"}else{"info"},"sample payment completed",&Attributes::from([("sample_id".into(),i.into()),("status".into(),status.into())]),Some(&span.context));
                if status==500{span.set_error("sample payment failed");}span.end();
            }
            mon.shutdown(Duration::from_secs(15))?;
        }
    }
    println!("{}",mon.stats());Ok(())
}
fn main(){if let Err(error)=run(){eprintln!("{error}");std::process::exit(1);}}
