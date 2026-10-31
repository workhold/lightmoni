use lightmoni::{Attributes,Client,Limits,TraceContext};
use std::{collections::BTreeMap,env,time::Duration};
fn var(n:&str,fallback:&str)->String{env::var(n).unwrap_or_else(|_|fallback.into())}
fn run()->lightmoni::Result<()> {
    let mode=var("LIGHTMONI_TEST_MODE","demo");let mut limits=Limits::default();limits.self_telemetry=mode=="demo" || mode=="selfmonitor";
    if mode=="overflow"{limits.cardinality_limit=2;}
    if mode=="capacity"{limits.queue_bytes=1024;limits.max_batch_bytes=1024;limits.buffer_bytes=64;}
    let mon=Client::with_limits(&var("LIGHTMONI_SERVICE","example-rust-api"),"http",&var("LIGHTMONI_ENDPOINT","https://monitor.example.com"),&var("LIGHTMONI_KEY",""),limits)?;
    let counter=mon.counter("http.requests")?;
    match mode.as_str() {
        "selfmonitor"=>{counter.add(-1,&Attributes::new());std::thread::sleep(Duration::from_secs(35));mon.shutdown(Duration::from_secs(5))?;}
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
            let app=mon.with_table("app")?;
            app.log("info","without trace",&Attributes::from([("trace_id".into(),"attribute-only".into())]),None);
            let mut span=app.start_span("fixture",&Attributes::new(),Some(&parent))?;
            app.log("info","中文 fixture",&Attributes::from([("exact".into(),9007199254740993i64.into()),("ok".into(),true.into()),("fraction".into(),0.125f64.into())]),Some(&span.context));span.end();
            app.log("info","after trace",&Attributes::new(),None);
            mon.flush(Duration::from_secs(10))?;counter.add(2,&Attributes::from([("window".into(),"next".into())]));mon.flush(Duration::from_secs(10))?;
        }
        "trace_scope"=>{
            let app=mon.with_table("app")?;let parent=TraceContext{trace_id:"a".repeat(32),span_id:"b".repeat(16),flags:0,trace_state:"vendor=scope".into()};
            app.log("info","without trace",&Attributes::new(),None);
            app.with_span("request",&Attributes::new(),Some(&parent),|scoped,_|{
                scoped.log("info","scope root",&Attributes::new(),None);
                assert_eq!(TraceContext::extract(&scoped.trace_headers().unwrap()).as_ref(),scoped.current_trace());
                let failed=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
                    let _=scoped.with_span("child",&Attributes::new(),None,|nested,_|{nested.log("info","scope child",&Attributes::new(),None);panic!("scope failure");});
                }));assert!(failed.is_err());
                scoped.log("info","scope restored",&Attributes::new(),None);
                scoped.log("info","scope explicit",&Attributes::new(),Some(&TraceContext{trace_id:"c".repeat(32),span_id:"d".repeat(16),flags:1,trace_state:String::new()}));
            })?;
            let barrier=std::sync::Arc::new(std::sync::Barrier::new(2));let mut tasks=Vec::new();
            for i in 1..=2{
                let client=app.with_trace(&TraceContext{trace_id:i.to_string().repeat(32),span_id:i.to_string().repeat(16),flags:1,trace_state:String::new()})?;let barrier=barrier.clone();
                tasks.push(std::thread::spawn(move||{barrier.wait();client.log("info",&format!("scope concurrent {i}"),&Attributes::new(),None);}));
            }
            for task in tasks{task.join().unwrap();}
            assert!(app.current_trace().is_none());app.log("info","after trace",&Attributes::new(),None);mon.flush(Duration::from_secs(10))?;
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
                let status=if i%5==0{500}else{200};
                let attrs=Attributes::from([("route".into(),"/payments".into()),("method".into(),"POST".into()),("status".into(),status.into())]);
                counter.add(1,&attrs);duration.record((5+i*2) as f64,&attrs);active.record((i%4) as f64,&Attributes::new());
                app.with_span("POST /payments",&Attributes::new(),None,|scoped,span|{
                    scoped.log(if status==500{"error"}else{"info"},"sample payment completed",&Attributes::from([("sample_id".into(),i.into()),("status".into(),status.into())]),None);
                    if status==500{span.set_error("sample payment failed");}
                })?;
            }
            mon.shutdown(Duration::from_secs(15))?;
        }
    }
    println!("{}",mon.stats());Ok(())
}
fn main(){if let Err(error)=run(){eprintln!("{error}");std::process::exit(1);}}
