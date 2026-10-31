use std::{sync::{Arc,Mutex}, collections::BTreeMap, io::Read, time::{Duration, Instant}};
use serde_json::Value;

pub(crate) struct CenterEndpoints {
    bootstrap: String,
    selected: String,
    expires: Option<Instant>,
    selected_until: Option<Instant>,
    manifest: Option<Value>,
    failed: BTreeMap<String, Instant>,
    pending: Arc<Mutex<BTreeMap<String,Instant>>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Attributes,Client};
    use serde_json::json;
    use std::{net::{TcpListener},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},thread};

    fn entrance(name:&str, manifest:Arc<Mutex<Value>>, seen:Arc<Mutex<Vec<String>>>, secrets:Arc<Mutex<Vec<String>>>)->(String,Arc<AtomicBool>){
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
        let url=format!("http://{}",listener.local_addr().unwrap());let stop=Arc::new(AtomicBool::new(false));let stopped=stop.clone();let label=name.to_string();
        thread::spawn(move||while !stopped.load(Ordering::Relaxed){
            let Ok((mut stream,_))=listener.accept() else{thread::sleep(Duration::from_millis(1));continue;};
            let mut bytes=Vec::new();let mut chunk=[0u8;4096];stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            loop{let n=stream.read(&mut chunk).unwrap_or(0);if n==0{break;}bytes.extend_from_slice(&chunk[..n]);if bytes.windows(4).any(|w|w==b"\r\n\r\n"){break;}}
            let request=String::from_utf8_lossy(&bytes);let identity=request.starts_with("GET /v1/center-identity ");let discovery=request.starts_with("GET /v1/center-endpoints ");
            let has_secret=request.to_lowercase().contains("authorization:");
            if identity{assert!(!has_secret);}else if has_secret{secrets.lock().unwrap().push(label.clone());}
            let body=if identity{json!({"center_id":if label=="foreign"{"other"}else{"same"}})}else if discovery{manifest.lock().unwrap().clone()}else{seen.lock().unwrap().push(label.clone());json!({})};
            let body=body.to_string();use std::io::Write;let _=write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
        });
        (url,stop)
    }
    #[test]
    fn sdk_internal_public_and_new_port(){
        let manifest=Arc::new(Mutex::new(json!({})));let seen=Arc::new(Mutex::new(Vec::new()));let secrets=Arc::new(Mutex::new(Vec::new()));
        let(public,public_stop)=entrance("public",manifest.clone(),seen.clone(),secrets.clone());let(private,private_stop)=entrance("private",manifest.clone(),seen.clone(),secrets.clone());
        let publish=|internal:&str,revision:&str|{*manifest.lock().unwrap()=json!({"version":1,"center_id":"same","revision":revision,"endpoints":[{"url":internal,"scope":"internal"},{"url":public,"scope":"public"}]});};
        publish(&private,"one");let client=Client::new("routing","business",&public,"secret").unwrap();
        assert_eq!(client.refresh_endpoints().unwrap(),private);client.log("info","one",&Attributes::new(),None);client.flush(Duration::from_secs(3)).unwrap();assert_eq!(seen.lock().unwrap().last().unwrap(),"private");
        private_stop.store(true,Ordering::Relaxed);thread::sleep(Duration::from_millis(10));client.log("info","two",&Attributes::new(),None);client.flush(Duration::from_secs(3)).unwrap();assert_eq!(seen.lock().unwrap().last().unwrap(),"public");
        let(next,next_stop)=entrance("replacement",manifest.clone(),seen.clone(),secrets.clone());publish(&next,"two");assert_eq!(client.refresh_endpoints().unwrap(),next);client.log("info","three",&Attributes::new(),None);client.flush(Duration::from_secs(3)).unwrap();assert_eq!(seen.lock().unwrap().last().unwrap(),"replacement");
        let(foreign,foreign_stop)=entrance("foreign",manifest.clone(),seen.clone(),secrets.clone());publish(&foreign,"three");assert_eq!(client.refresh_endpoints().unwrap(),public);assert!(!secrets.lock().unwrap().contains(&"foreign".to_string()));
        client.shutdown(Duration::from_secs(2)).unwrap();public_stop.store(true,Ordering::Relaxed);next_stop.store(true,Ordering::Relaxed);foreign_stop.store(true,Ordering::Relaxed);
    }
}
fn center_url(value: &str) -> Option<String> {
    let u = reqwest::Url::parse(value).ok()?;
    if !["http", "https"].contains(&u.scheme()) || u.host_str().is_none() || u.port()==Some(0) || !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() || value.chars().any(|c| c.is_whitespace() || c=='\\' || c=='?' || c=='#') { return None; }
    Some(value.trim_end_matches('/').into())
}
fn json(http: &reqwest::blocking::Client, url: &str, key: &str, deadline: Instant) -> Result<Value, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() { return Err("center discovery deadline exceeded".into()); }
    let mut request = http.get(url).timeout(remaining.min(Duration::from_secs(1)));
    if !key.is_empty() { request=request.bearer_auth(key); }
    let response = request.send().map_err(|_| "center discovery unavailable")?;
    if [401,403].contains(&response.status().as_u16()) { return Err("center discovery access denied".into()); }
    if response.status().as_u16()!=200 { return Err("center discovery unsupported or unavailable".into()); }
    let mut bytes=Vec::new();response.take(65537).read_to_end(&mut bytes).map_err(|_|"center discovery unavailable")?;
    if bytes.len()>65536 { return Err("center discovery response too large".into()); }
    serde_json::from_slice(&bytes).map_err(|_|"invalid center discovery response".into())
}
impl CenterEndpoints {
    pub(crate) fn new(bootstrap:&str,pending:Arc<Mutex<BTreeMap<String,Instant>>>)->Self { Self {bootstrap:bootstrap.trim_end_matches('/').into(),selected:String::new(),expires:None,selected_until:None,manifest:None,failed:BTreeMap::new(),pending} }
    pub(crate) fn resolve(&mut self,http:&reqwest::blocking::Client,key:&str,force:bool,deadline:Instant)->Result<String,String> {
        let now=Instant::now();let mut verified=String::new();{let mut pending=self.pending.lock().unwrap();if !pending.is_empty(){self.failed.append(&mut pending);self.selected_until=None;}}if force {self.expires=None;self.selected_until=None;}
        if self.selected_until.is_some_and(|v|now<v) {return Ok(self.selected.clone());}
        if self.expires.is_none_or(|v|now>=v) {
            self.expires=Some(now+Duration::from_secs(30));
            let mut sources=vec![self.bootstrap.clone()];if !self.selected.is_empty() && self.selected!=self.bootstrap {sources.insert(0,self.selected.clone());}
            if let Some(manifest)=&self.manifest{for candidate in manifest["endpoints"].as_array().unwrap(){if candidate["scope"]=="public"{let candidate=candidate["url"].as_str().unwrap().to_string();if !sources.contains(&candidate){sources.push(candidate);}}}}
            for source in sources {
                if let Some(manifest)=&self.manifest {match json(http,&format!("{source}/v1/center-identity"),"",deadline){Ok(v) if v["center_id"]==manifest["center_id"]=>{},_=>continue}}
                let raw=match json(http,&format!("{source}/v1/center-endpoints"),key,deadline) {Ok(v)=>v,Err(e)=>{if e=="center discovery access denied" {return Err(e);}continue;}};
                let Some(id)=raw["center_id"].as_str().filter(|v|!v.is_empty()&&v.len()<=128) else {continue;};
                let Some(addresses)=raw["endpoints"].as_array() else {continue;};
                if raw["version"]!=1 || raw["revision"].as_str().is_none_or(str::is_empty) || addresses.is_empty() || addresses.len()>20 || self.manifest.as_ref().is_some_and(|v|v["center_id"]!=id) {continue;}
                if !addresses.iter().all(|e|e["url"].as_str().and_then(center_url).is_some() && [Some("internal"),Some("public")].contains(&e["scope"].as_str())) || !addresses.iter().any(|e|e["scope"]=="public") {continue;}
                if self.manifest.as_ref().is_none_or(|v|v["revision"]!=raw["revision"]) {self.failed.clear();}
                self.manifest=Some(raw);verified=source;break;
            }
        }
        let Some(manifest)=&self.manifest else {self.selected=self.bootstrap.clone();self.selected_until=self.expires;return Ok(self.selected.clone());};
        let identity=manifest["center_id"].clone();
        let mut candidates:Vec<(String,bool)>=manifest["endpoints"].as_array().unwrap().iter().map(|e|(center_url(e["url"].as_str().unwrap()).unwrap(),e["scope"]=="public")).collect();
        candidates.sort_by_key(|e|e.1);if !candidates.iter().any(|e|e.0==self.bootstrap){candidates.push((self.bootstrap.clone(),true));}
        candidates.sort_by_key(|e|(e.1,e.0!=verified && e.0!=self.bootstrap));
        let probe_deadline=Instant::now()+Duration::from_secs(3);
        for (url,public) in candidates {
            if self.failed.get(&url).is_some_and(|v|now<*v) || (!public && Instant::now()>=probe_deadline) {continue;}
            if url==verified{self.selected=url.clone();self.selected_until=self.expires;return Ok(url);}
            if Instant::now()>=deadline{break;}
            if let Ok(value)=json(http,&format!("{url}/v1/center-identity"),"",deadline) {if value["center_id"]==identity {self.selected=url.clone();self.selected_until=self.expires;return Ok(url);}}
            if Instant::now()<deadline{self.failed.insert(url,now+Duration::from_secs(30));}
        }
        Err("no verified center endpoint is reachable".into())
    }
}

pub(crate) fn transport_failure(error:&reqwest::Error)->bool {
 let mut cause:Option<&(dyn std::error::Error+'static)>=Some(error);
 while let Some(value)=cause {if value.to_string().to_ascii_lowercase().contains("certificate"){return false;}cause=value.source();}
 true
}
