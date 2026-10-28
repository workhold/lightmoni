use super::*;

struct EnvironmentRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);
impl Drop for EnvironmentRestore {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            match value { Some(value) => std::env::set_var(name, value), None => std::env::remove_var(name) }
        }
    }
}

// Run the SDK suite with --test-threads=1: the process environment is shared.
#[test]
fn machine_declarations_reach_otlp_and_explicit_resource_wins() {
    let variables = ["LIGHTMONI_MACHINE_ID", "LIGHTMONI_MACHINE_NAME"];
    let _restore = EnvironmentRestore(variables.iter().map(|name| (*name, std::env::var_os(name))).collect());
    let cases = [
        (None, None, false), (Some(String::new()), Some("   ".into()), false),
        (Some("a".repeat(65)), Some("界".repeat(43)), false),
        (Some("bad\nvalue".into()), Some("bad\u{85}value".into()), false),
        (Some("界".repeat(21)+"a"), Some("界".repeat(42)+"ab"), true),
        (Some("machine-1".into()), Some("生产 主机".into()), true),
    ];
    for (id, name, valid) in cases {
        for (variable, value) in variables.iter().zip([&id, &name]) {
            match value { Some(value) => std::env::set_var(variable,value), None => std::env::remove_var(variable) }
        }
        for explicit in [false, true] {
            let input = if explicit { Attributes::from([
                ("lightmoni.machine.id".into(), "explicit".into()),
                ("lightmoni.machine.name".into(), "custom".into()),
                ("host.id".into(), "agent-host".into()),
            ]) } else { Attributes::new() };
            let client = Client::with_resource("identity-test","business","http://127.0.0.1:1","",Limits {self_telemetry:false,..Limits::default()},input).unwrap();
            client.counter("requests").unwrap().add(1,&Attributes::new());
            client.log("info","hello",&Attributes::new(),None);
            client.start_span("work",&Attributes::new(),None).unwrap().end();
            let mut state=client.state.lock().unwrap(); state.collect(true);
            assert_eq!(state.queue.len(),3);
            for batch in &state.queue {
                let payload:Value=serde_json::from_slice(&batch.raw).unwrap();
                let attributes=payload.as_object().unwrap().values().next().unwrap()[0]["resource"]["attributes"].as_array().unwrap();
                let resource:BTreeMap<_,_>=attributes.iter().map(|item|(item["key"].as_str().unwrap(),item["value"]["stringValue"].as_str().unwrap())).collect();
                assert_eq!(resource["service.name"],"identity-test");
                assert!(!resource["service.instance.id"].is_empty());
                assert_eq!(resource.get("lightmoni.machine.id").copied(),if explicit{Some("explicit")}else if valid{id.as_deref()}else{None});
                assert_eq!(resource.get("lightmoni.machine.name").copied(),if explicit{Some("custom")}else if valid{name.as_deref()}else{None});
                if explicit {assert_eq!(resource["host.id"],"agent-host");}
            }
            state.closed=true;
        }
    }
}
