use super::*;
#[derive(Clone)]
pub(crate) struct MetricWindow{pub seconds:u64,pub effective_at:u64}
pub(crate) fn window_at(policies:&BTreeMap<String,Vec<MetricWindow>>,table:&str,at:u128)->(u128,u64){let second=(at/1_000_000_000)as u64;let mut period=30;for p in policies.get(table).into_iter().flatten(){if p.effective_at<=second{period=p.seconds;}}((second/period*period)as u128*1_000_000_000,period)}
impl Client{
 pub fn refresh_metric_windows(&self)->Result<()>{
  let(http,_bootstrap,key)={let s=self.state.lock().unwrap();if s.closed{return Err("SDK is closed".into());}(s.http.clone(),s.endpoint.clone(),s.key.clone())};
  let deadline=Instant::now()+Duration::from_secs(5);let endpoint=self.resolve_endpoint(false,deadline)?;
  let mut request=http.get(format!("{endpoint}/v1/sdk-config?metric_windows=1")).timeout(deadline.saturating_duration_since(Instant::now()));if !key.is_empty(){request=request.bearer_auth(key);}
  let response=request.send().map_err(|error|{if endpoints::transport_failure(&error){self.mark_endpoint_failure(&endpoint);}"SDK configuration unavailable"})?;if response.status().as_u16()!=200{return Err("SDK configuration rejected".into());}
  use std::io::Read;let mut bytes=Vec::new();response.take((1<<20)+1).read_to_end(&mut bytes).map_err(|_|{self.mark_endpoint_failure(&endpoint);"SDK configuration unavailable"})?;if bytes.len()>1<<20{return Err("SDK configuration too large".into());}
  let value:Value=serde_json::from_slice(&bytes).map_err(|_|"invalid SDK configuration")?;
  if !value.is_object() || value["revision"].as_str().is_none_or(str::is_empty) || !value["log_sampling"].is_object() || !value["disable_rules"].is_array(){return Err("invalid SDK configuration".into());}
  let object=value.get("metric_windows").cloned().unwrap_or(json!({}));let object=object.as_object().ok_or("invalid metric windows")?;let mut policies=BTreeMap::new();
  for(name,history)in object{let mut entries=Vec::new();for p in history.as_array().ok_or("invalid metric history")?{let item=p.as_object().ok_or("invalid metric history")?;if item.len()!=2{return Err("invalid metric history fields".into());}entries.push(MetricWindow{seconds:p["seconds"].as_u64().ok_or("invalid metric period")?,effective_at:p["effective_at"].as_u64().ok_or("invalid metric effective time")?});}policies.insert(name.clone(),entries);}
  if policies.len()>200{return Err("too many metric policies".into());}for(name,history)in &policies{table(name)?;if history.len()>256{return Err("too much window history".into());}let mut previous=None;for p in history{if ![10,30,60,300,600,1800,3600].contains(&p.seconds)||previous.is_some_and(|v|p.effective_at<=v)||p.effective_at%p.seconds!=0{return Err("invalid metric window history".into());}previous=Some(p.effective_at);}}
  let mut s=self.state.lock().unwrap();if !s.closed{s.metric_windows=policies;}Ok(())
 }
}

#[cfg(test)]
mod tests {
 use super::*;
 use std::{io::{Read,Write},net::TcpListener};

 #[test]
 fn policies_choose_one_effective_period_per_table() {
  let policies=BTreeMap::from([
   ("fast".into(),vec![MetricWindow{seconds:10,effective_at:0},MetricWindow{seconds:60,effective_at:1800000000}]),
   ("slow".into(),vec![MetricWindow{seconds:300,effective_at:0}]),
  ]);
  for(name,at,expected)in[("fast",1799999999u128,10),("fast",1800000000,60),("slow",1800000000,300),("default",1800000000,30)] {
   let(start,seconds)=window_at(&policies,name,at*1_000_000_000);
   assert_eq!(seconds,expected);assert_eq!(start%(seconds as u128*1_000_000_000),0);
  }
 }

 #[test]
 fn remote_periods_drive_export_and_invalid_updates_keep_snapshot() {
  let listener=TcpListener::bind("127.0.0.1:0").unwrap();
  let endpoint=format!("http://{}",listener.local_addr().unwrap());
  let periods=[10,30,60,300,600,1800,3600];
  let policies:serde_json::Map<String,Value>=periods.into_iter().map(|seconds|(format!("table_{seconds}"),json!([{"seconds":seconds,"effective_at":0}]))).collect();
  let valid=json!({"revision":"windows","log_sampling":{},"disable_rules":[],"metric_windows":policies});
  let worker=std::thread::spawn(move||{
   for body in [serde_json::Value::Null,valid,json!({"revision":"invalid","log_sampling":{},"disable_rules":[],"metric_windows":{"table_10":[{"seconds":20,"effective_at":0}]}}),json!([])] {
    let(mut stream,_)=listener.accept().unwrap();
    let mut request=Vec::new();let mut buffer=[0;1024];
    while !request.windows(4).any(|part|part==b"\r\n\r\n") {let n=stream.read(&mut buffer).unwrap();assert!(n>0);request.extend_from_slice(&buffer[..n]);}
    if String::from_utf8_lossy(&request).starts_with("GET /v1/center-endpoints "){write!(stream,"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();continue;}
    assert!(String::from_utf8_lossy(&request).starts_with("GET /v1/sdk-config?metric_windows=1 "));
    let body=body.to_string();
    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
   }
  });
  let client=Client::init(Options{endpoint:Some(endpoint),key:Some(String::new()),..Options::new("periods","test")}).unwrap();
  client.refresh_metric_windows().unwrap();
  for seconds in periods {client.record(&format!("table_{seconds}"),"duration",&Attributes::new(),10.,1);}
  assert!(client.refresh_metric_windows().is_err());
  assert!(client.refresh_metric_windows().is_err());
  client.record("table_10","duration",&Attributes::new(),20.,1);
  client.record("default_table","duration",&Attributes::new(),30.,1);
  let mut state=client.state.lock().unwrap();state.collect(true);
  let mut samples=0;
  for batch in &state.queue {
   let expected=if batch.table=="default_table"{30}else{batch.table.trim_start_matches("table_").parse::<u64>().unwrap()};
   let payload:Value=serde_json::from_slice(&batch.raw).unwrap();
   for scope in payload["resourceMetrics"][0]["scopeMetrics"].as_array().unwrap(){for metric in scope["metrics"].as_array().unwrap(){for point in metric["exponentialHistogram"]["dataPoints"].as_array().unwrap(){
    let attr=point["attributes"].as_array().unwrap().iter().find(|a|a["key"]=="lightmoni.window_seconds").unwrap();
    assert_eq!(attr["value"]["intValue"],expected.to_string());
    assert_eq!(point["startTimeUnixNano"].as_str().unwrap().parse::<u128>().unwrap()%(expected as u128*1_000_000_000),0);
    samples+=point["count"].as_str().unwrap().parse::<u64>().unwrap();
   }}}
  }
  assert_eq!(samples,9);assert_eq!(state.stats["invalid_records"],0);state.closed=true;
  drop(state);worker.join().unwrap();
 }
}
