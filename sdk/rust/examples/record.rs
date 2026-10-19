use lightmoni::{Attributes, Client, Options};
use std::{env, time::Duration};
fn main() -> Result<(),Box<dyn std::error::Error>> {
 let moni=Client::init(Options::new("database-api","test"))?;
 let table=env::var("LIGHTMONI_TABLE").unwrap_or_else(|_|"business".into());
 moni.record(&table,"db.query.duration_ms",&Attributes::from([("key1".into(),"telecom".into()),("key2".into(),"zhejiang".into())]),128.0,1);
 moni.record(&table,"restaurant.spend",&Attributes::new(),100.0,5);
 moni.shutdown(Duration::from_secs(5))?;
 Ok(())
}
