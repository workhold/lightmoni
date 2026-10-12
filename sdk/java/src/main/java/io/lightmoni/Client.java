package io.lightmoni;

import com.google.gson.*;
import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.Flow;
import java.nio.ByteBuffer;
import java.util.concurrent.locks.ReentrantLock;

/** Recording uses bounded memory; flush performs synchronous, deadline-bounded delivery. */
public final class Client implements AutoCloseable {
    private static final Gson JSON = new GsonBuilder().disableHtmlEscaping().create();
    private static final List<Double> BOUNDS = List.of(5d, 10d, 25d, 50d, 100d, 250d, 500d, 1000d);
    public static final class Limits {
        public long queueBytes = 8 << 20, bufferBytes = 8 << 20;
        public boolean selfTelemetry = true;
        public int queueBatches = 256, maxBatchBytes = 1 << 20, cardinalityLimit = 2000, maxInstruments = 256;
        private Limits copy() {
            Limits n = new Limits(); n.queueBytes=queueBytes; n.bufferBytes=bufferBytes; n.queueBatches=queueBatches;
            n.selfTelemetry=selfTelemetry; n.maxBatchBytes=maxBatchBytes; n.cardinalityLimit=cardinalityLimit; n.maxInstruments=maxInstruments;
            if (queueBytes<=0 || bufferBytes<=0 || queueBatches<=0 || maxBatchBytes<=0 || maxBatchBytes>queueBytes || cardinalityLimit<=0 || maxInstruments<=0)
                throw new IllegalArgumentException("invalid SDK limits");
            return n;
        }
    }
    public record TraceContext(String traceId, String spanId, int flags, String traceState) {
        public TraceContext {
            if (traceId == null || !traceId.matches("[0-9a-f]{32}") || traceId.equals("0".repeat(32))
                || spanId == null || !spanId.matches("[0-9a-f]{16}") || spanId.equals("0".repeat(16))
                || flags<0 || flags>255 || traceState==null || traceState.length()>512) throw new IllegalArgumentException("invalid trace context");
        }
        public Map<String,String> inject() {
            Map<String,String> h = new HashMap<>(); h.put("traceparent", "00-"+traceId+"-"+spanId+"-"+String.format("%02x",flags));
            if (!traceState.isEmpty()) h.put("tracestate",traceState); return h;
        }
        public static TraceContext extract(Map<String,String> headers) {
            Map<String,String> h=new HashMap<>(); headers.forEach((k,v)->h.put(k.toLowerCase(Locale.ROOT),v));
            String p=h.getOrDefault("traceparent","");
            if (!p.matches("00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}")) return null;
            try { return new TraceContext(p.substring(3,35),p.substring(36,52),Integer.parseInt(p.substring(53),16),h.getOrDefault("tracestate","")); }
            catch (IllegalArgumentException e) { return null; }
        }
    }
    private record Batch(long sequence, String id, String created, String table, String signal, byte[] payload, int count) {}
    private static class State {
        final Limits limits;
        final String endpoint;
        final Object resource;
        final HttpClient http=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
        final ReentrantLock delivery=new ReentrantLock();
        final Map<String,Metric> metrics=new TreeMap<>();
        final Map<String,List<Object>> records=new TreeMap<>();
        final Deque<Batch> queue=new ArrayDeque<>();
        final Map<String,Object> stats=new LinkedHashMap<>();
        String key, failure;
        boolean closed;
        long sequence;
        String selfTable; long selfLast = Long.MIN_VALUE; boolean selfStarted;
        final Map<String,Long> selfPrevious=new HashMap<>();
        java.util.concurrent.ScheduledExecutorService heartbeat;
        State(String service,String endpoint,String key,Limits limits) {
            URI url=URI.create(endpoint);
            if (service==null || service.isEmpty() || bytes(service).length>128 || !List.of("http","https").contains(url.getScheme())
                || url.getHost()==null || url.getUserInfo()!=null || url.getQuery()!=null || url.getFragment()!=null)
                throw new IllegalArgumentException("valid service and HTTP(S) endpoint required");
            this.endpoint=endpoint.replaceAll("/+$",""); this.key=key; this.limits=limits.copy();
            resource=Map.of("attributes",attrs(Map.of("service.name",service,"service.instance.id",UUID.randomUUID().toString())));
            for (String n:List.of("pending_batches","pending_bytes","buffer_bytes","delivered_batches","retried_batches","invalid_records","overflow_records","dropped_records","rejected_records")) stats.put(n,0L);
            stats.put("last_error","");
        }
        long number(String name) { return (Long)stats.get(name); }
        void inc(String name,long delta) { stats.put(name,number(name)+delta); }
        void invalid(String message) { inc("invalid_records",1); stats.put("last_error",message); }
        void lost(int count,String message) { inc("dropped_records",count); failure=message; stats.put("last_error",message); }
        boolean reserve(long n) {
            if (number("buffer_bytes")+n>limits.bufferBytes) { lost(1,"SDK active buffer exceeded"); return false; }
            inc("buffer_bytes",n); return true;
        }
        synchronized void store(String table,String signal,Object record) {
            if (closed) { invalid("record after shutdown"); return; }
            if (reserve(encode(record).length+64)) records.computeIfAbsent(table+"\0"+signal,k->new ArrayList<>()).add(record);
        }
        @SuppressWarnings("unchecked")
        byte[] payload(String signal,List<Object> records) {
            if (signal.equals("metrics")) {
                Map<String,Object> merged=new LinkedHashMap<>();
                for(Object item:records) {
                    Map<String,Object> record=(Map<String,Object>)item;
                    String name=(String)record.get("name"),kind=List.of("sum","gauge","histogram").stream().filter(record::containsKey).findFirst().orElseThrow();
                    Map<String,Object> part=(Map<String,Object>)record.get(kind);
                    if(!merged.containsKey(name)) {
                        Map<String,Object> copy=new LinkedHashMap<>(record), body=new LinkedHashMap<>(part);
                        body.put("dataPoints",new ArrayList<>((List<Object>)part.get("dataPoints")));copy.put(kind,body);merged.put(name,copy);
                    } else {
                        Map<String,Object> existing=(Map<String,Object>)((Map<String,Object>)merged.get(name)).get(kind);
                        ((List<Object>)existing.get("dataPoints")).addAll((List<Object>)part.get("dataPoints"));
                    }
                }
                records=new ArrayList<>(merged.values());
            }
            String resourceKey,scopeKey,field;
            switch(signal) {
                case "metrics" -> { resourceKey="resourceMetrics";scopeKey="scopeMetrics";field="metrics"; }
                case "logs" -> { resourceKey="resourceLogs";scopeKey="scopeLogs";field="logRecords"; }
                default -> { resourceKey="resourceSpans";scopeKey="scopeSpans";field="spans"; }
            }
            return encode(Map.of(resourceKey,List.of(Map.of("resource",resource,scopeKey,List.of(Map.of("scope",Map.of("name","lightmoni/sdk/java","version","0.1.0"),field,records))))));
        }
        synchronized void collect() {
            long now=nano();
            for (Metric m:metrics.values()) {
                long end=Math.max(now,m.start);
                for (Point p:m.series.values()) {
                    Map<String,Object> row=new LinkedHashMap<>(); row.put("attributes",p.attrs); row.put("timeUnixNano",Long.toString(m.kind.equals("gauge")?p.at:end));
                    Map<String,Object> record=new LinkedHashMap<>();record.put("name",m.name);record.put("unit",m.unit);
                    switch(m.kind) {
                        case "counter" -> { row.put("startTimeUnixNano",Long.toString(m.start));row.put("asInt",Long.toString(p.integer));record.put("sum",Map.of("dataPoints",List.of(row),"aggregationTemporality",1,"isMonotonic",true)); }
                        case "gauge" -> { row.put("asDouble",p.value);record.put("gauge",Map.of("dataPoints",List.of(row))); }
                        default -> {
                            row.put("startTimeUnixNano",Long.toString(m.start));row.put("count",Long.toString(p.count));row.put("sum",p.value);row.put("min",p.min);row.put("max",p.max);
                            row.put("explicitBounds",m.bounds);row.put("bucketCounts",Arrays.stream(p.buckets).mapToObj(Long::toString).toList());
                            record.put("histogram",Map.of("dataPoints",List.of(row),"aggregationTemporality",1));
                        }
                    }
                    records.computeIfAbsent(m.table+"\0metrics",k->new ArrayList<>()).add(record);
                }
                m.series.clear();m.start=end;
            }
            String created=Instant.now().toString();
            for (var entry:records.entrySet()) {
                String[] parts=entry.getKey().split("\0");String table=parts[0],signal=parts[1];
                List<Object> group=new ArrayList<>();int base=payload(signal,List.of()).length,size=base;
                for (Object record:entry.getValue()) {
                    int cost=encode(record).length+1;
                    if (!group.isEmpty() && size+cost>limits.maxBatchBytes) { enqueue(table,signal,group,created);group=new ArrayList<>();size=base; }
                    group.add(record);size+=cost;
                }
                if (!group.isEmpty()) enqueue(table,signal,group,created);
            }
            records.clear();stats.put("buffer_bytes",0L);
            collectSelf();
        }
        boolean enqueueSelf(String signal,List<Object> rows,String at) {
            int size=payload(signal,rows).length;
            if(size>limits.maxBatchBytes || queue.size()>=limits.queueBatches || number("pending_bytes")+size>limits.queueBytes)return false;
            enqueue(selfTable,signal,rows,at);return true;
        }
        void collectSelf() {
            long clock=System.nanoTime();
            if(!limits.selfTelemetry || (selfLast!=Long.MIN_VALUE && clock-selfLast<30_000_000_000L))return;
            selfLast=clock;String at=Instant.now().toString(),time=Long.toString(nano());
            List<Object> attributes=attrs(Map.of("lightmoni.component","sdk","sdk.language","java","sdk.version","0.1.0"));
            List<Object> metrics=new ArrayList<>();metrics.add(Map.of("name","lightmoni.sdk.heartbeat","gauge",Map.of("dataPoints",List.of(Map.of("timeUnixNano",time,"asDouble",1,"attributes",attributes)))));
            for(String name:List.of("pending_batches","pending_bytes","retried_batches","dropped_records","rejected_records","invalid_records","overflow_records"))metrics.add(Map.of("name","lightmoni.sdk."+name,"gauge",Map.of("dataPoints",List.of(Map.of("timeUnixNano",time,"asDouble",number(name),"attributes",attributes)))));
            enqueueSelf("metrics",metrics,at);
            boolean changed=List.of("retried_batches","dropped_records","rejected_records","invalid_records","overflow_records").stream().anyMatch(n->number(n)>selfPrevious.getOrDefault(n,0L));
            if(!selfStarted || changed) {
                List<Object> logAttrs=new ArrayList<>(attributes);logAttrs.addAll(attrs(Map.of("event",selfStarted?"diagnostics_changed":"started")));
                Object row=Map.of("timeUnixNano",time,"severityText",changed?"WARN":"INFO","severityNumber",changed?13:9,"body",Map.of("stringValue",changed?"LightMoni SDK delivery, buffer or input diagnostics changed":"LightMoni SDK started"),"attributes",logAttrs);
                if(enqueueSelf("logs",List.of(row),at)){selfStarted=true;for(String n:List.of("retried_batches","dropped_records","rejected_records","invalid_records","overflow_records"))selfPrevious.put(n,number(n));}
            }
        }
        void enqueue(String table,String signal,List<Object> records,String created) {
            byte[] raw=payload(signal,records);sequence++;
            if (raw.length>limits.maxBatchBytes || queue.size()>=limits.queueBatches || number("pending_bytes")+raw.length>limits.queueBytes) { lost(records.size(),"SDK queue or batch capacity exceeded");return; }
            queue.add(new Batch(sequence,UUID.randomUUID().toString(),created,table,signal,raw,records.size()));inc("pending_bytes",raw.length);inc("pending_batches",1);
        }
    }
    private static class Point {
        Object attrs;
        long integer,count,at;
        double value,min,max;
        long[] buckets;
        Point(Object attrs,double value,int buckets) { this.attrs=attrs;this.min=value;this.max=value;this.buckets=new long[buckets]; }
    }
    public static final class Metric {
        private final State s;
        private final String table,name,kind,unit;
        private final List<Double> bounds;
        private final Map<String,Point> series=new TreeMap<>();
        private long start=nano();
        Metric(State s,String table,String name,String kind,String unit,List<Double> bounds) { this.s=s;this.table=table;this.name=name;this.kind=kind;this.unit=unit;this.bounds=bounds; }
        public void add(long value,Map<String,?> attributes) { if (!kind.equals("counter")) throw new IllegalStateException("add requires counter");recordNumber(value,attributes); }
        public void add(long value) { add(value,Map.of()); }
        public void record(double value,Map<String,?> attributes) { if (kind.equals("counter")) throw new IllegalStateException("use add(long)");recordNumber(value,attributes); }
        public void record(double value) { record(value,Map.of()); }
        private void recordNumber(Number number,Map<String,?> attributes) {
            synchronized(s) {
                try {
                    if (s.closed || !Double.isFinite(number.doubleValue()) || (kind.equals("counter") && number.longValue()<0)) throw new IllegalArgumentException("invalid metric value or closed SDK");
                    Object a=attrs(attributes);String key=JSON.toJson(a);
                    if (!series.containsKey(key) && series.size()>=s.limits.cardinalityLimit) { key="overflow";a=attrs(Map.of("otel.metric.overflow",true));s.inc("overflow_records",1); }
                    Point p=series.get(key);
                    if (p==null) { if (!s.reserve(bytes(key).length+160+8L*(bounds.size()+1))) return;p=new Point(a,number.doubleValue(),bounds.size()+1);series.put(key,p); }
                    if (kind.equals("counter")) p.integer=Math.addExact(p.integer,number.longValue());
                    else if (kind.equals("gauge")) p.value=number.doubleValue();
                    else {
                        double n=number.doubleValue();
                        if (!Double.isFinite(p.value+n) || p.count==Long.MAX_VALUE) throw new IllegalArgumentException("histogram overflow");
                        p.value+=n;p.count++;int i=0;while(i<bounds.size() && n>bounds.get(i)) i++;p.buckets[i]++;p.min=Math.min(p.min,n);p.max=Math.max(p.max,n);
                    }
                    p.at=nano();
                } catch (IllegalArgumentException | ArithmeticException e) { s.invalid(e.getMessage()); }
            }
        }
    }
    public final class Span implements AutoCloseable {
        public final TraceContext context;
        private final Map<String,Object> data=new LinkedHashMap<>();
        private boolean ended;
        Span(String name,Map<String,?> attributes,TraceContext parent) {
            if (name.isEmpty() || bytes(name).length>255) throw new IllegalArgumentException("invalid span name");
            context=new TraceContext(parent==null?hexUUID():parent.traceId(),hexUUID().substring(0,16),parent==null?1:parent.flags(),parent==null?"":parent.traceState());
            data.put("name",name);data.put("kind",1);data.put("traceId",context.traceId());data.put("spanId",context.spanId());data.put("flags",context.flags());data.put("startTimeUnixNano",Long.toString(nano()));data.put("attributes",attrs(attributes));
            if (parent!=null) { data.put("parentSpanId",parent.spanId());if (!parent.traceState().isEmpty()) data.put("traceState",parent.traceState()); }
        }
        public synchronized void setError(String message) { if(!ended)data.put("status",Map.of("code",2,"message",message.substring(0,Math.min(message.length(),4096)))); }
        public synchronized void end() {
            if(ended)return;ended=true;data.put("endTimeUnixNano",Long.toString(Math.max(nano(),Long.parseLong((String)data.get("startTimeUnixNano")))));s.store(table,"traces",data);
        }
        @Override public void close() { end(); }
    }
    private final State s;
    private final String table;
    public Client(String service,String table) { this(service,table,"http://127.0.0.1:4318","",new Limits()); }
    public Client(String service,String table,String endpoint,String key) { this(service,table,endpoint,key,new Limits()); }
    public Client(String service,String table,String endpoint,String key,Limits limits) { this.table=validTable(table);this.s=new State(service,endpoint,key,limits); s.selfTable=this.table;
        if(s.limits.selfTelemetry) {
            s.heartbeat=java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"lightmoni-heartbeat");t.setDaemon(true);return t;});
            s.heartbeat.scheduleWithFixedDelay(()->{try{flush(Duration.ofSeconds(5));}catch(IOException | InterruptedException | RuntimeException e){if(e instanceof InterruptedException)Thread.currentThread().interrupt();}},30,30,TimeUnit.SECONDS);
        }
    }
    private Client(State s,String table) { this.s=s;this.table=validTable(table); }
    public Client withTable(String table) { return new Client(s,table); }
    public Metric counter(String name) { return metric(name,"counter","",List.of()); }
    public Metric gauge(String name) { return metric(name,"gauge","",List.of()); }
    public Metric histogram(String name,List<Double> bounds) { return metric(name,"histogram","",bounds); }
    public Metric histogram(String name) { return histogram(name,BOUNDS); }
    public Metric metric(String name,String kind,String unit,List<Double> boundaries) {
        List<Double> bounds=kind.equals("histogram")?List.copyOf(boundaries):List.of();
        if (name.isEmpty() || bytes(name).length>255 || bytes(unit).length>64 || !List.of("counter","gauge","histogram").contains(kind) || bounds.size()>128) throw new IllegalArgumentException("invalid metric identity");
        for(int i=0;i<bounds.size();i++) if(!Double.isFinite(bounds.get(i)) || (i>0 && bounds.get(i-1)>=bounds.get(i))) throw new IllegalArgumentException("invalid histogram boundaries");
        synchronized(s) {
            if(s.closed)throw new IllegalStateException("SDK is closed");
            String id=table+"\0"+name;Metric m=s.metrics.get(id);
            if(m!=null) { if(!m.kind.equals(kind) || !m.unit.equals(unit) || !m.bounds.equals(bounds)) throw new IllegalArgumentException("conflicting metric registration");return m; }
            if(s.metrics.size()>=s.limits.maxInstruments)throw new IllegalArgumentException("instrument limit exceeded");
            m=new Metric(s,table,name,kind,unit,bounds);s.metrics.put(id,m);return m;
        }
    }
    public void log(String severity,String body,Map<String,?> attributes,TraceContext context) {
        synchronized(s) {
            try {
                String level=severity.toLowerCase(Locale.ROOT);int index=List.of("trace","debug","info","warn","error","fatal").indexOf(level);
                if(index<0 || bytes(body).length>65536)throw new IllegalArgumentException("invalid log severity/body");
                String at=Long.toString(nano());Map<String,Object> row=new LinkedHashMap<>();
                row.put("timeUnixNano",at);row.put("observedTimeUnixNano",at);row.put("severityText",level);row.put("severityNumber",1+4*index);row.put("body",Map.of("stringValue",body));row.put("attributes",attrs(attributes));
                if(context!=null) { row.put("traceId",context.traceId());row.put("spanId",context.spanId());row.put("flags",context.flags()); }
                s.store(table,"logs",row);
            } catch(IllegalArgumentException e) { s.invalid(e.getMessage()); }
        }
    }
    public void log(String severity,String body) { log(severity,body,Map.of(),null); }
    public Span startSpan(String name,Map<String,?> attrs,TraceContext parent) { synchronized(s) { if(s.closed)throw new IllegalStateException("SDK is closed");return new Span(name,attrs,parent); } }
    public Span startSpan(String name) { return startSpan(name,Map.of(),null); }
    public Map<String,Object> stats() { synchronized(s) { return Map.copyOf(s.stats); } }
    public void updateKey(String key) { synchronized(s) { s.key=key; } }
    public void flush(Duration timeout) throws IOException,InterruptedException {
        if(timeout.isZero() || timeout.isNegative())throw new IllegalArgumentException("timeout must be positive");
        long deadline=System.nanoTime()+timeout.toNanos();
        if(!s.delivery.tryLock(timeout.toNanos(),TimeUnit.NANOSECONDS))throw new IOException("flush deadline exceeded");
        try {
            long target;synchronized(s) { if(s.closed)throw new IOException("SDK is closed");s.collect();target=s.sequence; }
            long backoff=200;
            while(true) {
                Batch b;String key;
                synchronized(s) { b=s.queue.peek();if(b==null || b.sequence()>target) { if(s.failure!=null)throw new IOException(s.failure);return; }key=s.key; }
                long remaining=deadline-System.nanoTime();
                if(remaining<=0)throw new IOException("flush deadline exceeded; batches retained");
                int status=0;long delay=0,rejected=0;boolean ack=false;
                try {
                    var req=HttpRequest.newBuilder(URI.create(s.endpoint+"/v1/"+b.signal())).timeout(Duration.ofNanos(Math.min(remaining,10_000_000_000L)))
                        .header("Content-Type","application/json").header("X-Lightmoni-Table",b.table()).header("X-Lightmoni-Batch-ID",b.id()).header("X-Lightmoni-Batch-Created-At",b.created());
                    if(key!=null && !key.isEmpty())req.header("Authorization","Bearer "+key);
                    var future=s.http.sendAsync(req.POST(HttpRequest.BodyPublishers.ofByteArray(b.payload())).build(), info -> new AckSubscriber());
                    HttpResponse<byte[]> response;
                    try { response=future.get(Math.min(remaining,10_000_000_000L),TimeUnit.NANOSECONDS); }
                    catch(TimeoutException | InterruptedException e) { future.cancel(true);throw e; }
                    status=response.statusCode();
                    String raw=response.headers().firstValue("Retry-After").orElse("");
                    try { delay=raw.matches("[0-9]+")?Math.multiplyExact(Long.parseLong(raw),1000):Math.max(0,Duration.between(Instant.now(),ZonedDateTime.parse(raw,DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()).toMillis()); }
                    catch(RuntimeException ignored) { delay=0; }
                    if(status==200) {
                        JsonElement parsed=JsonParser.parseString(response.body().length==0?"{}":new String(response.body(),StandardCharsets.UTF_8));
                        if(!parsed.isJsonObject())throw new IllegalArgumentException("invalid acknowledgment");
                        JsonObject result=parsed.getAsJsonObject();
                        if(result.has("partialSuccess") && !result.get("partialSuccess").isJsonNull()) {
                            JsonObject partial=result.getAsJsonObject("partialSuccess");
                            String field=switch(b.signal()) { case "logs" -> "rejectedLogRecords";case "metrics" -> "rejectedDataPoints";default -> "rejectedSpans"; };
                            if(partial.has(field))rejected=partial.get(field).getAsLong();
                            if(rejected<0)throw new IllegalArgumentException("invalid partial success");
                        }
                        ack=true;
                    }
                } catch(ExecutionException | TimeoutException | IllegalArgumentException | IllegalStateException | JsonParseException e) { status=0; }
                synchronized(s) {
                    if(ack || !List.of(0,401,403,429,502,503,504).contains(status)) {
                        s.queue.remove();s.inc("pending_batches",-1);s.inc("pending_bytes",-b.payload().length);
                        if(ack && rejected==0)s.inc("delivered_batches",1);
                        else { s.inc("rejected_records",rejected>0?rejected:b.count());s.failure=ack?"OTLP partial success; not retried":"telemetry rejected with HTTP "+status;s.stats.put("last_error",s.failure); }
                        backoff=200;continue;
                    }
                    s.inc("retried_batches",1);s.stats.put("last_error","telemetry delivery failed (HTTP "+status+")");
                }
                delay=Math.max(delay,status==401 || status==403?30000:(long)(backoff*(.8+Math.random()*.4)));
                long wait=Math.min(TimeUnit.MILLISECONDS.toNanos(delay),Math.max(0,deadline-System.nanoTime()));
                TimeUnit.NANOSECONDS.sleep(wait);backoff=Math.min(30000,backoff*2);
            }
        } finally { s.delivery.unlock(); }
    }
    public void shutdown(Duration timeout) throws IOException,InterruptedException { if(s.heartbeat!=null)s.heartbeat.shutdownNow();try { flush(timeout); } finally { synchronized(s) { s.closed=true; } } }
    @Override public void close() throws IOException { try { shutdown(Duration.ofSeconds(10)); } catch(InterruptedException e) { Thread.currentThread().interrupt();throw new IOException("shutdown interrupted"); } }
    private static String validTable(String t) { if(t==null || !t.matches("[a-z][a-z0-9_]{0,47}") || t.matches("^(log|metric|trace)_.*"))throw new IllegalArgumentException("invalid logical table");return t; }
    private static final class AckSubscriber implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> future=new CompletableFuture<>();
        private final ByteArrayOutputStream data=new ByteArrayOutputStream();
        private Flow.Subscription subscription;
        public CompletionStage<byte[]> getBody() { return future; }
        public void onSubscribe(Flow.Subscription subscription) { this.subscription=subscription;subscription.request(Long.MAX_VALUE); }
        public void onNext(List<ByteBuffer> parts) {
            for(ByteBuffer part:parts) {
                if(data.size()+part.remaining()>65536) { subscription.cancel();future.completeExceptionally(new IOException("ACK too large"));return; }
                byte[] raw=new byte[part.remaining()];part.get(raw);data.writeBytes(raw);
            }
        }
        public void onError(Throwable error) { future.completeExceptionally(error); }
        public void onComplete() { future.complete(data.toByteArray()); }
    }
    private static byte[] bytes(String t) { return t.getBytes(StandardCharsets.UTF_8); }
    private static byte[] encode(Object v) { return bytes(JSON.toJson(v)); }
    private static String hexUUID() { return UUID.randomUUID().toString().replace("-",""); }
    private static long nano() { Instant at=Instant.now();return at.getEpochSecond()*1_000_000_000L+at.getNano(); }
    private static List<Object> attrs(Map<String,?> values) {
        if(values.size()>32)throw new IllegalArgumentException("attribute count exceeded");
        List<Object> result=new ArrayList<>();
        for(String key:new TreeSet<>(values.keySet())) {
            if(key.isEmpty() || bytes(key).length>128)throw new IllegalArgumentException("invalid attribute key");
            Object v=values.get(key),a;
            if(v instanceof String)a=Map.of("stringValue",v);
            else if(v instanceof Boolean)a=Map.of("boolValue",v);
            else if(v instanceof Byte || v instanceof Short || v instanceof Integer || v instanceof Long)a=Map.of("intValue",v.toString());
            else if((v instanceof Double || v instanceof Float) && Double.isFinite(((Number)v).doubleValue()))a=Map.of("doubleValue",v);
            else throw new IllegalArgumentException("attributes require string/bool/Int64/finite float");
            result.add(Map.of("key",key,"value",a));
        }
        if(encode(result).length>4096)throw new IllegalArgumentException("attribute bytes exceeded");return result;
    }
}
