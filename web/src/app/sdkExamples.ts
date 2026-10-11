export interface SDKPackage {id:string;language:string;runtime:string;file:string;url:string;available:boolean}
export interface SDKInstall {version:string;node_url:string;go_url:string;packages:SDKPackage[];checksums_url:string}
export const sdkExamples:Record<string,{language:string;install:string;sample:string}> = {
  typescript:{
    language:'typescript',
    install:'npm install ./lightmoni-sdk-0.1.0.tgz',
    sample:"import {createLightMoni} from '@lightmoni/sdk';\n\nconst moni = createLightMoni({\n  service: 'order-api', table: 'business',\n  endpoint: 'http://127.0.0.1:4318'\n});\nmoni.counter('orders_created').add(1, {region:'cn'});\nmoni.log('info', 'order created', {order_id:'123'});\nawait moni.shutdown({timeoutMs:5000});",
  },
  go:{
    language:'go',
    install:'tar -xzf lightmoni-go-sdk_0.1.0.tar.gz\ngo mod edit -replace github.com/lightmoni/lightmoni=./lightmoni-go-sdk\ngo get github.com/lightmoni/lightmoni/sdk/go\ngo mod tidy',
    sample:'import (\n  "context"\n  "time"\n  moni "github.com/lightmoni/lightmoni/sdk/go"\n)\n\nclient, err := moni.New(moni.Config{\n  Service:"order-api", Table:"business",\n  Endpoint:"http://127.0.0.1:4318",\n})\nif err != nil { panic(err) }\norders, err := client.Counter("orders_created", moni.MetricOptions{})\nif err != nil { panic(err) }\norders.Add(context.Background(), 1, moni.Attributes{"region":"cn"})\nctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)\ndefer cancel()\nif err := client.Shutdown(ctx); err != nil { panic(err) }',
  },
  python:{
    language:'python',
    install:'tar -xzf lightmoni-python-sdk_0.1.0.tar.gz\npython3 -m pip install ./lightmoni-python-sdk/sdk/python',
    sample:'from lightmoni import Client\n\nmoni = Client(service="order-api", table="business")\nmoni.counter("orders_created").add(1, {"region":"cn"})\nwith moni.start_span("create_order"):\n    moni.log("info", "order created", {"order_id":"123"})\nmoni.shutdown(timeout=5)',
  },
  java:{
    language:'java',
    install:'tar -xzf lightmoni-java-sdk_0.1.0.tar.gz\nmvn -f lightmoni-java-sdk/sdk/java/pom.xml install\n# 业务依赖：io.lightmoni:lightmoni-sdk:0.1.0',
    sample:'import io.lightmoni.Client;\nimport java.time.Duration;\nimport java.util.Map;\n\nvar moni = new Client("order-api", "business");\nmoni.counter("orders_created").add(1, Map.of("region","cn"));\ntry (var span = moni.startSpan("create_order")) {\n  moni.log("info", "order created", Map.of(), span.context);\n}\nmoni.shutdown(Duration.ofSeconds(5));',
  },
  dotnet:{
    language:'csharp',
    install:'tar -xzf lightmoni-dotnet-sdk_0.1.0.tar.gz\ndotnet add YourApp.csproj reference ./lightmoni-dotnet-sdk/sdk/dotnet/LightMoni.csproj',
    sample:'using LightMoni;\n\nvar moni = new Client("order-api", "business");\nmoni.Counter("orders_created").Add(1,\n  new Dictionary<string,object> {["region"]="cn"});\nusing (var span = moni.StartSpan("create_order"))\n  moni.Log("info", "order created", context:span.Context);\nawait moni.ShutdownAsync(TimeSpan.FromSeconds(5));',
  },
  php:{
    language:'php',
    install:'tar -xzf lightmoni-php-sdk_0.1.0.tar.gz\n# 直接 require 源码，或通过 composer.json 配置 path repository。',
    sample:"require './lightmoni-php-sdk/sdk/php/src/Client.php';\n\n$moni = new \\LightMoni\\Client('order-api', 'business');\n$moni->counter('orders_created')->add(1, ['region'=>'cn']);\n$span = $moni->startSpan('create_order');\n$moni->log('info', 'order created', [], $span->context);\n$span->end();\n$moni->shutdown(5);",
  },
  ruby:{
    language:'ruby',
    install:'tar -xzf lightmoni-ruby-sdk_0.1.0.tar.gz\ncd lightmoni-ruby-sdk/sdk/ruby\ngem build lightmoni.gemspec\ngem install ./lightmoni-sdk-0.1.0.gem',
    sample:"require 'lightmoni'\n\nmoni = LightMoni::Client.new(service:'order-api', table:'business')\nmoni.counter('orders_created').add(1, 'region'=>'cn')\nspan = moni.start_span('create_order')\nmoni.log('info', 'order created', {}, context:span.context)\nspan.finish\nmoni.shutdown(timeout:5)",
  },
  rust:{
    language:'rust',
    install:'tar -xzf lightmoni-rust-sdk_0.1.0.tar.gz\n# Cargo.toml [dependencies]\n# lightmoni = { path = "./lightmoni-rust-sdk/sdk/rust" }',
    sample:'use lightmoni::{Client, Attributes};\nuse std::time::Duration;\n\nlet moni = Client::new("order-api", "business",\n  "http://127.0.0.1:4318", "")?;\nmoni.counter("orders_created")?.add(1,\n  &Attributes::from([("region".into(), "cn".into())]));\nlet mut span = moni.start_span("create_order", &Attributes::new(), None)?;\nmoni.log("info", "order created", &Attributes::new(), Some(&span.context));\nspan.end();\nmoni.shutdown(Duration::from_secs(5))?;',
  },
};
