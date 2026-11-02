use super::*;

#[derive(Default)]
pub struct Options {
    pub service: String,
    pub env: String,
    pub service_version: Option<String>,
    pub instance_id: Option<String>,
    pub endpoint: Option<String>,
    pub key: Option<String>,
}
impl Options {
    pub fn new(service: &str, env: &str) -> Self {
        Self {
            service: service.into(),
            env: env.into(),
            ..Self::default()
        }
    }
}

pub(crate) struct Observation {
    pub table: String,
    name: String,
    attributes: Value,
    start: u128,
    seconds:u64,
    pub(crate) cost:usize,
    scale: i32,
    positive: BTreeMap<i32, u64>,
    negative: BTreeMap<i32, u64>,
    zero: u64,
    count: u64,
    sum: f64,
    min: f64,
    max: f64,
    summary_count: u64,
    summary_sum: f64,
    pub(crate) bytes: usize,
}
impl Observation {
    fn new(table: &str, name: &str, attributes: Value) -> Self {
        Self {
            table: table.into(),
            name: name.into(),
            attributes,
            start: nano(), seconds:30,cost:0,
            scale: 8,
            positive: BTreeMap::new(),
            negative: BTreeMap::new(),
            zero: 0,
            count: 0,
            sum: 0.,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            summary_count: 0,
            summary_sum: 0.,
            bytes: 0,
        }
    }
    fn observe(&mut self, value: f64, count: u64, available: usize) -> Result<i64> {
        if count > 1 {
            self.summary_count = self
                .summary_count
                .checked_add(count)
                .ok_or("summary count overflow")?;
            if !(self.summary_sum + value).is_finite() {
                self.summary_count -= count;
                return Err("summary sum overflow".into());
            }
            self.summary_sum += value;
            return Ok(0);
        }
        if self.count == u64::MAX || !(self.sum + value).is_finite() {
            return Err("distribution overflow".into());
        }
        let mut change = 0;
        if value != 0. {
            let mut index = (value.abs().log2() * 2f64.powi(self.scale)).ceil() as i32 - 1;
            loop {
                let span=|side:&BTreeMap<i32,u64>,extra:bool|->i64{let low=side.keys().next().copied();let high=side.keys().next_back().copied();if extra{(high.unwrap_or(index).max(index)as i64)-(low.unwrap_or(index).min(index)as i64)+1}else{match(low,high){(Some(l),Some(h))=>h as i64-l as i64+1,_=>0}}};
                if span(&self.positive,value>0.)+span(&self.negative,value<0.)<=1024 {break;}
                for side in [&mut self.positive, &mut self.negative] {
                    let mut next = BTreeMap::new();
                    for (i, n) in side.iter() {
                        *next.entry(i.div_euclid(2)).or_insert(0) += *n;
                    }
                    *side = next;
                }
                self.scale -= 1;
                index = index.div_euclid(2);
            }
            let entries = self.positive.len() + self.negative.len();
            let side = if value < 0. {
                &mut self.negative
            } else {
                &mut self.positive
            };
            let size = (entries + usize::from(!side.contains_key(&index))) * 32;
            if size > self.bytes + available {
                return Err("SDK distribution capacity exceeded".into());
            }
            *side.entry(index).or_insert(0) += 1;
            change = size as i64 - self.bytes as i64;
            self.bytes = size;
        } else {
            self.zero += 1;
        }
        self.count += 1;
        self.sum += value;
        self.min = self.min.min(value);
        self.max = self.max.max(value);
        Ok(change)
    }
    pub(crate) fn finish(&self)->u128{self.start+self.seconds as u128*1_000_000_000}
    pub fn records(&self, end: u128) -> Vec<Value> {
        fn buckets(side: &BTreeMap<i32, u64>) -> Value {
            match (side.keys().next(), side.keys().next_back()) {
                (Some(low), Some(high)) => {
                    json!({"offset":low,"bucketCounts":(*low..=*high).map(|i|side.get(&i).copied().unwrap_or(0).to_string()).collect::<Vec<_>>()})
                }
                _ => json!({"offset":0,"bucketCounts":[]}),
            }
        }
        let mut rows = Vec::new();
        let end = end.min(self.finish()).max(self.start).to_string();
        let mut attributes=self.attributes.as_array().unwrap().clone();attributes.push(json!({"key":"lightmoni.window_seconds","value":{"intValue":self.seconds.to_string()}}));
        if self.count > 0 {
            rows.push(json!({"name":self.name,"exponentialHistogram":{"aggregationTemporality":1,"dataPoints":[{"attributes":attributes,"startTimeUnixNano":self.start.to_string(),"timeUnixNano":end,"count":self.count.to_string(),"sum":self.sum,"min":self.min,"max":self.max,"scale":self.scale,"zeroCount":self.zero.to_string(),"positive":buckets(&self.positive),"negative":buckets(&self.negative)}]}}));
        }
        if self.summary_count > 0 {
            rows.push(json!({"name":self.name,"summary":{"dataPoints":[{"attributes":attributes,"startTimeUnixNano":self.start.to_string(),"timeUnixNano":end,"count":self.summary_count.to_string(),"sum":self.summary_sum,"quantileValues":[]}]}}));
        }
        rows
    }
}
impl Client {
    pub fn init(options: Options) -> Result<Self> {
        for value in [
            &options.env,
            options.service_version.as_ref().unwrap_or(&options.env),
            options.instance_id.as_ref().unwrap_or(&options.env),
        ] {
            if value.trim().is_empty() || value.len() > 128 {
                return Err("invalid resource identity".into());
            }
        }
        let endpoint = options.endpoint.unwrap_or_else(|| {
            std::env::var("LIGHTMONI_ENDPOINT").unwrap_or_default()
        });
        let key = options
            .key
            .unwrap_or_else(|| std::env::var("LIGHTMONI_KEY").unwrap_or_default());
        let client = Self::connect(&options.service, &endpoint, &key)?;
        {
            let mut s = client.state.lock().unwrap();
            let resource = s.resource["attributes"].as_array_mut().unwrap();
            for (name, value) in [
                ("deployment.environment.name", Some(options.env)),
                ("service.version", options.service_version),
                ("service.instance.id", options.instance_id),
            ] {
                if let Some(value) = value {
                    resource.retain(|v| v["key"] != name);
                    resource.push(json!({"key":name,"value":{"stringValue":value}}));
                }
            }
        }
        Ok(client)
    }
    pub fn record(
        &self,
        table_name: &str,
        metric_name: &str,
        dimensions: &Attributes,
        value: f64,
        count: u64,
    ) {
        let mut s = self.state.lock().unwrap();
        let result = (|| {
            if s.closed {
                return Err("record after shutdown".into());
            }
            table(table_name)?;
            if [
                "lightmoni",
                ]
            .contains(&table_name)
                || metric_name.is_empty()
                || metric_name.len() > 255
                || !value.is_finite()
                || count == 0
            {
                return Err("invalid record identity, value or count".into());
            }
            if !s.resource["attributes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| {
                    a["key"] == "deployment.environment.name"
                        && a["value"]["stringValue"]
                            .as_str()
                            .is_some_and(|v| !v.is_empty())
                })
            {
                return Err("record requires env".into());
            }
            let mut normalized = Attributes::new();
            for (k, v) in dimensions {
                let number = k.strip_prefix("key").and_then(|v| v.parse::<u8>().ok());
                if !number.is_some_and(|n| (1..=16).contains(&n) && k == &format!("key{n}")) {
                    return Err("dimensions must be key1..key16".into());
                }
                match v {
                    Attribute::String(v) if !v.is_empty() => {
                        normalized.insert(k.clone(), Attribute::String(v.clone()));
                    }
                    Attribute::String(_) => {}
                    _ => return Err("dimension values must be strings".into()),
                }
            }
            let attributes = attrs(&normalized)?;
            let(start,seconds)=windows::window_at(&s.metric_windows,table_name,nano());
            let id = format!("{table_name}\0{metric_name}\0{attributes}\0{start}/{seconds}");
            if !s.observations.contains_key(&id) {
                if s.observations.len()>=s.limits.cardinality_limit{s.collect(false);}
                if s.observations.len() >= s.limits.cardinality_limit {
                    *s.stats.get_mut("overflow_records").unwrap() += 1;
                    return Ok(());
                }
                if !s.reserve(id.len() + 256) {
                    return Ok(());
                }
                s.observations.insert(
                    id.clone(),
                    {let mut o=Observation::new(table_name,metric_name,attributes);o.start=start;o.seconds=seconds;o.cost=id.len()+256;o},
                );
            }
            let mut observation = s.observations.remove(&id).unwrap();
            let change = observation.observe(
                value,
                count,
                s.limits.buffer_bytes - s.stats["buffer_bytes"] as usize,
            );
            s.observations.insert(id, observation);
            match change {
                Ok(change) => {
                    let old = s.stats["buffer_bytes"] as i64;
                    s.stats.insert("buffer_bytes".into(), (old + change) as u64);
                    Ok(())
                }
                Err(e) => Err(e),
            }
        })();
        if let Err(error) = result {
            s.invalid(error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distribution_is_bounded_and_summary_is_not_a_synthetic_sample() {
        let mut observation = Observation::new("app", "duration", json!([]));
        for i in 1..=10000 {
            observation.observe(i as f64, 1, 8 << 20).unwrap();
        }
        observation.observe(100., 5, 8 << 20).unwrap();
        assert_eq!(observation.count, 10000);
        assert_eq!(observation.sum, 50005000.);
        assert_eq!(observation.summary_count, 5);
        assert_eq!(observation.summary_sum, 100.);
        let rows = observation.records(nano());
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[1]["summary"]["dataPoints"][0]["quantileValues"],
            json!([])
        );
        let total: u64 = observation.positive.values().sum::<u64>()
            + observation.negative.values().sum::<u64>()
            + observation.zero;
        assert_eq!(total, observation.count);
        assert!(
            observation.positive.keys().next_back().unwrap()
                - observation.positive.keys().next().unwrap()
                < 1024
        );
    }
}
