import io.lightmoni.Client;
import java.time.Duration;
import java.util.*;
import com.google.gson.Gson;

public class Main {
    static String env(String key,String fallback) { return System.getenv().getOrDefault(key,fallback); }
    static void require(boolean value) { if(!value)throw new AssertionError("SDK conformance assertion"); }
    public static void main(String[] args) throws Exception {
        String mode=env("LIGHTMONI_TEST_MODE","demo");
        Client.Limits limits=new Client.Limits();
        if(mode.equals("overflow"))limits.cardinalityLimit=2;
        if(mode.equals("capacity")){limits.queueBytes=1024;limits.maxBatchBytes=1024;limits.bufferBytes=64;}
        Client mon=new Client(env("LIGHTMONI_SERVICE","example-java-api"),"http",env("LIGHTMONI_ENDPOINT","http://127.0.0.1:4318"),env("LIGHTMONI_KEY",""),limits);
        var counter=mon.counter("http.requests");
        switch(mode) {
            case "fixture" -> {
                Map<String,Object> dims=new HashMap<>(Map.of("route","/payments","method","POST","status",200));
                counter.add(1,dims);dims.put("status",999);
                counter.add(2,Map.of("status",200,"method","POST","route","/payments"));counter.add(1,Map.of("status",500,"method","POST","route","/payments"));
                counter.add(1,Map.of("typed",1));counter.add(1,Map.of("typed","1"));counter.add(-1);
                mon.counter("exact").add(9007199254740993L);
                var gauge=mon.gauge("active");gauge.record(5);gauge.record(7);
                var histogram=mon.histogram("duration",List.of(5d,10d));for(double n:new double[]{-1,5,6,10,11})histogram.record(n);
                var parent=Client.TraceContext.extract(Map.of("traceparent","00-"+"a".repeat(32)+"-"+"b".repeat(16)+"-01","tracestate","foo=bar"));
                require(Client.TraceContext.extract(Map.of("traceparent","00-"+"0".repeat(32)+"-"+"b".repeat(16)+"-01"))==null);
                require(Client.TraceContext.extract(parent.inject()).equals(parent));
                var app=mon.withTable("app");
                try(var span=app.startSpan("fixture",Map.of(),parent)){app.log("info","中文 fixture",Map.of("exact",9007199254740993L,"ok",true,"fraction",.125),span.context);}
                mon.flush(Duration.ofSeconds(10));counter.add(2,Map.of("window","next"));mon.flush(Duration.ofSeconds(10));
            }
            case "overflow" -> {for(int i=0;i<4;i++)counter.add(1,Map.of("dimension",i));mon.flush(Duration.ofSeconds(10));}
            case "retry","auth" -> {
                counter.add(1,Map.of("window","first"));
                boolean failed=false;try{mon.flush(Duration.ofMillis(450));}catch(java.io.IOException e){failed=true;}
                require(failed && (Long)mon.stats().get("pending_batches")==1);
                counter.add(2,Map.of("window","next"));mon.updateKey("rotated");mon.flush(Duration.ofSeconds(10));
            }
            case "permanent","partial","capacity" -> {
                counter.add(1);for(int i=0;i<2;i++){boolean failed=false;try{mon.flush(Duration.ofSeconds(10));}catch(java.io.IOException e){failed=true;}require(failed);}
                require((Long)mon.stats().get("pending_batches")==0);
            }
            default -> {
                var app=mon.withTable("app");var duration=mon.histogram("http.duration",List.of(5d,10d,25d,50d,100d,250d));var active=mon.gauge("http.active");
                for(int i=0;i<Integer.parseInt(env("LIGHTMONI_COUNT","20"));i++){
                    int status=i%5==0?500:200;var dims=Map.of("route","/payments","method","POST","status",status);
                    try(var span=app.startSpan("POST /payments")){counter.add(1,dims);duration.record(5+i*2,dims);active.record(i%4);app.log(status==500?"error":"info","sample payment completed",Map.of("sample_id",i,"status",status),span.context);if(status==500)span.setError("sample payment failed");}
                }
                mon.shutdown(Duration.ofSeconds(15));
            }
        }
        System.out.println(new Gson().toJson(mon.stats()));
    }
}
