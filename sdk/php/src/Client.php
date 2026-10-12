<?php
declare(strict_types=1);
namespace LightMoni;

final class Protocol {
    public static function json(mixed $v): string { return json_encode($v, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION); }
    public static function nano(): string {
        [$fraction, $seconds] = explode(' ', microtime());
        return $seconds . str_pad(substr($fraction, 2, 6), 9, '0');
    }
    public static function uuid(): string {
        $b = random_bytes(16); $b[6] = chr((ord($b[6]) & 15) | 64); $b[8] = chr((ord($b[8]) & 63) | 128);
        $s = bin2hex($b); return substr($s,0,8).'-'.substr($s,8,4).'-'.substr($s,12,4).'-'.substr($s,16,4).'-'.substr($s,20);
    }
    public static function table(string $v): string {
        if (!preg_match('/^[a-z][a-z0-9_]{0,47}$/D', $v) || preg_match('/^(log|metric|trace)_/', $v)) throw new \InvalidArgumentException('invalid logical table');
        return $v;
    }
    public static function attrs(array $values): array {
        if (count($values)>32) throw new \InvalidArgumentException('attribute count exceeded');
        ksort($values, SORT_STRING); $result=[];
        foreach ($values as $key=>$value) {
            if (!is_string($key) || $key==='' || strlen($key)>128) throw new \InvalidArgumentException('invalid attribute key');
            $v = match(true) {
                is_string($value) => ['stringValue'=>$value],
                is_bool($value) => ['boolValue'=>$value],
                is_int($value) => ['intValue'=>(string)$value],
                is_float($value) && is_finite($value) => ['doubleValue'=>$value],
                default => throw new \InvalidArgumentException('attributes require string/bool/Int64/finite float')
            };
            $result[]=['key'=>$key,'value'=>$v];
        }
        if (strlen(self::json($result))>4096) throw new \InvalidArgumentException('attribute bytes exceeded');
        return $result;
    }
}
final class TraceContext {
    public function __construct(public readonly string $traceId, public readonly string $spanId, public readonly int $flags=1, public readonly string $traceState='') {
        if (!preg_match('/^[0-9a-f]{32}$/D',$traceId) || $traceId===str_repeat('0',32) || !preg_match('/^[0-9a-f]{16}$/D',$spanId) || $spanId===str_repeat('0',16) || $flags<0 || $flags>255 || strlen($traceState)>512) throw new \InvalidArgumentException('invalid trace context');
    }
    public function inject(): array {
        $h=['traceparent'=>sprintf('00-%s-%s-%02x',$this->traceId,$this->spanId,$this->flags)];
        if ($this->traceState!=='') $h['tracestate']=$this->traceState;
        return $h;
    }
    public static function extract(array $headers): ?self {
        $h=array_change_key_case($headers,CASE_LOWER);
        if (!preg_match('/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/D',$h['traceparent']??'', $m)) return null;
        try { return new self($m[1],$m[2],hexdec($m[3]),$h['tracestate']??''); } catch (\InvalidArgumentException) { return null; }
    }
}
final class State {
    public array $metrics=[], $records=[], $queue=[], $stats=[];
    public array $limits;
    public string $endpoint, $key;
    public bool $closed=false;
    public ?string $failure=null;
    public int $sequence=0;
    private array $resource;
    public bool $selfEnabled=true; public string $selfTable="";
    private float $selfLast=-INF; private bool $selfStarted=false; private array $selfPrevious=[];
    public function __construct(string $service,string $endpoint,string $key,array $limits) {
        $url=parse_url($endpoint);
        if (PHP_INT_SIZE!==8 || $service==='' || strlen($service)>128 || !$url || !in_array($url['scheme']??'', ['http','https'], true) || empty($url['host']) || isset($url['user']) || isset($url['query']) || isset($url['fragment'])) throw new \InvalidArgumentException('64-bit PHP, valid service and HTTP(S) endpoint required');
        $this->endpoint=rtrim($endpoint,'/'); $this->key=$key;
        $this->selfEnabled=$limits['self_telemetry']??true;unset($limits['self_telemetry']);
        $defaults=['queue_bytes'=>8<<20,'queue_batches'=>256,'buffer_bytes'=>8<<20,'max_batch_bytes'=>1<<20,'cardinality_limit'=>2000,'max_instruments'=>256];
        if (array_diff_key($limits,$defaults)) throw new \InvalidArgumentException('unknown SDK limit');
        $this->limits=array_replace($defaults,$limits);
        foreach ($this->limits as $v) if (!is_int($v) || $v<=0) throw new \InvalidArgumentException('invalid SDK limits');
        if ($this->limits['max_batch_bytes']>$this->limits['queue_bytes']) throw new \InvalidArgumentException('invalid SDK limits');
        $this->resource=['attributes'=>Protocol::attrs(['service.name'=>$service,'service.instance.id'=>Protocol::uuid()])];
        foreach (['pending_batches','pending_bytes','buffer_bytes','delivered_batches','retried_batches','invalid_records','overflow_records','dropped_records','rejected_records'] as $n) $this->stats[$n]=0;
        $this->stats['last_error']='';
    }
    public function invalid(string $message): void { $this->stats['invalid_records']++; $this->stats['last_error']=$message; }
    public function lost(int $count,string $message): void { $this->stats['dropped_records']+=$count; $this->failure=$this->stats['last_error']=$message; }
    public function reserve(int $size): bool {
        if ($this->stats['buffer_bytes']+$size>$this->limits['buffer_bytes']) { $this->lost(1,'SDK active buffer exceeded'); return false; }
        $this->stats['buffer_bytes']+=$size; return true;
    }
    public function store(string $table,string $signal,array $record): void {
        if ($this->closed) { $this->invalid('record after shutdown'); return; }
        if ($this->reserve(strlen(Protocol::json($record))+64)) $this->records[$table."\0".$signal][]=$record;
    }
    private function payload(string $signal,array $rows): string {
        if ($signal==='metrics') {
            $merged=[];
            foreach ($rows as $row) {
                $kind=isset($row['sum'])?'sum':(isset($row['gauge'])?'gauge':'histogram');
                if (!isset($merged[$row['name']])) $merged[$row['name']]=$row;
                else $merged[$row['name']][$kind]['dataPoints']=array_merge($merged[$row['name']][$kind]['dataPoints'],$row[$kind]['dataPoints']);
            }
            $rows=array_values($merged);
        }
        [$resource,$scope,$field]=match($signal) {
            'metrics'=>['resourceMetrics','scopeMetrics','metrics'],
            'logs'=>['resourceLogs','scopeLogs','logRecords'],
            default=>['resourceSpans','scopeSpans','spans']
        };
        return Protocol::json([$resource=>[['resource'=>$this->resource,$scope=>[['scope'=>['name'=>'lightmoni/sdk/php','version'=>'0.1.0'],$field=>$rows]]]]]);
    }
    public function collect(): void {
        $now=(int)Protocol::nano();
        foreach ($this->metrics as $m) {
            $end=max($now,$m->start);
            foreach ($m->series as $p) {
                $row=['attributes'=>$p['attrs'],'timeUnixNano'=>(string)($m->kind==='gauge'?$p['at']:$end)];
                $record=['name'=>$m->name,'unit'=>$m->unit];
                if ($m->kind==='counter') {
                    $row['startTimeUnixNano']=(string)$m->start; $row['asInt']=(string)$p['integer'];
                    $record['sum']=['dataPoints'=>[$row],'aggregationTemporality'=>1,'isMonotonic'=>true];
                } elseif ($m->kind==='gauge') { $row['asDouble']=$p['value']; $record['gauge']=['dataPoints'=>[$row]]; }
                else {
                    $row+=['startTimeUnixNano'=>(string)$m->start,'count'=>(string)$p['count'],'sum'=>$p['value'],'min'=>$p['min'],'max'=>$p['max'],'explicitBounds'=>$m->bounds,'bucketCounts'=>array_map('strval',$p['buckets'])];
                    $record['histogram']=['dataPoints'=>[$row],'aggregationTemporality'=>1];
                }
                $this->records[$m->table."\0metrics"][]=$record;
            }
            $m->series=[]; $m->start=$end;
        }
        $created=gmdate('Y-m-d\TH:i:s').'.'.substr(Protocol::nano(),-9).'Z';
        ksort($this->records);
        foreach ($this->records as $id=>$rows) {
            [$table,$signal]=explode("\0",$id);
            $group=[]; $base=strlen($this->payload($signal,[])); $size=$base;
            foreach ($rows as $row) {
                $cost=strlen(Protocol::json($row))+1;
                if ($group && $size+$cost>$this->limits['max_batch_bytes']) { $this->enqueue($table,$signal,$group,$created);$group=[];$size=$base; }
                $group[]=$row; $size+=$cost;
            }
            if ($group) $this->enqueue($table,$signal,$group,$created);
        }
        $this->records=[]; $this->stats['buffer_bytes']=0;
        $this->collectSelf();
    }
    private function enqueueSelf(string $signal,array $rows,string $at): bool {
        $size=strlen($this->payload($signal,$rows));
        if ($size>$this->limits['max_batch_bytes'] || count($this->queue)>=$this->limits['queue_batches'] || $this->stats['pending_bytes']+$size>$this->limits['queue_bytes']) return false;
        $this->enqueue($this->selfTable,$signal,$rows,$at);return true;
    }
    private function collectSelf(): void {
        $clock=hrtime(true)/1e9;if (!$this->selfEnabled || $clock-$this->selfLast<30) return;
        $this->selfLast=$clock;$at=gmdate('Y-m-d\TH:i:s').'.'.substr(Protocol::nano(),-9).'Z';$time=Protocol::nano();
        $attributes=Protocol::attrs(['lightmoni.component'=>'sdk','sdk.language'=>'php','sdk.version'=>'0.1.0']);
        $values=['heartbeat'=>1];foreach (['pending_batches','pending_bytes','retried_batches','dropped_records','rejected_records','invalid_records','overflow_records'] as $name) $values[$name]=$this->stats[$name];
        $rows=[];foreach ($values as $name=>$value) $rows[]=['name'=>'lightmoni.sdk.'.$name,'gauge'=>['dataPoints'=>[['timeUnixNano'=>$time,'asDouble'=>$value,'attributes'=>$attributes]]]];
        $this->enqueueSelf('metrics',$rows,$at);
        $changed=false;foreach (['retried_batches','dropped_records','rejected_records','invalid_records','overflow_records'] as $name) if ($this->stats[$name]>($this->selfPrevious[$name]??0)) $changed=true;
        if (!$this->selfStarted || $changed) {
            $row=['timeUnixNano'=>$time,'severityText'=>$changed?'WARN':'INFO','severityNumber'=>$changed?13:9,'body'=>['stringValue'=>$changed?'LightMoni SDK delivery, buffer or input diagnostics changed':'LightMoni SDK started'],'attributes'=>array_merge($attributes,Protocol::attrs(['event'=>$this->selfStarted?'diagnostics_changed':'started']))];
            if ($this->enqueueSelf('logs',[$row],$at)) {$this->selfStarted=true;$this->selfPrevious=$this->stats;}
        }
    }
    private function enqueue(string $table,string $signal,array $rows,string $created): void {
        $raw=$this->payload($signal,$rows); $this->sequence++;
        if (strlen($raw)>$this->limits['max_batch_bytes'] || count($this->queue)>=$this->limits['queue_batches'] || $this->stats['pending_bytes']+strlen($raw)>$this->limits['queue_bytes']) { $this->lost(count($rows),'SDK queue or batch capacity exceeded');return; }
        $this->queue[]=[$this->sequence,Protocol::uuid(),$created,$table,$signal,$raw,count($rows)];
        $this->stats['pending_batches']++; $this->stats['pending_bytes']+=strlen($raw);
    }
}
final class Metric {
    public array $series=[];
    public int $start;
    public function __construct(private State $s,public readonly string $table,public readonly string $name,public readonly string $kind,public readonly string $unit,public readonly array $bounds) { $this->start=(int)Protocol::nano(); }
    public function add(int $value=1,array $attributes=[]): void {
        if ($this->kind!=='counter') throw new \LogicException('add requires counter');
        $this->record($value,$attributes);
    }
    public function record(int|float $value,array $attributes=[]): void {
        try {
            if ($this->s->closed || !is_finite((float)$value) || ($this->kind==='counter' && (!is_int($value) || $value<0))) throw new \InvalidArgumentException('invalid metric value or closed SDK');
            $attrs=Protocol::attrs($attributes); $key=Protocol::json($attrs);
            if (!isset($this->series[$key]) && count($this->series)>=$this->s->limits['cardinality_limit']) { $key='overflow';$attrs=Protocol::attrs(['otel.metric.overflow'=>true]);$this->s->stats['overflow_records']++; }
            if (!isset($this->series[$key])) {
                if (!$this->s->reserve(strlen($key)+160+8*(count($this->bounds)+1))) return;
                $this->series[$key]=['attrs'=>$attrs,'integer'=>0,'value'=>0.0,'count'=>0,'buckets'=>array_fill(0,count($this->bounds)+1,0),'min'=>$value,'max'=>$value,'at'=>0];
            }
            $p=&$this->series[$key];
            if ($this->kind==='counter') {
                if ($p['integer']>PHP_INT_MAX-$value) throw new \InvalidArgumentException('counter overflow');
                $p['integer']+=$value;
            } elseif ($this->kind==='gauge') $p['value']=(float)$value;
            else {
                if (!is_finite($p['value']+$value) || $p['count']===PHP_INT_MAX) throw new \InvalidArgumentException('histogram overflow');
                $p['value']+=(float)$value; $p['count']++; $i=0; while ($i<count($this->bounds) && $value>$this->bounds[$i]) $i++;
                $p['buckets'][$i]++; $p['min']=min($p['min'],$value);$p['max']=max($p['max'],$value);
            }
            $p['at']=(int)Protocol::nano();
        } catch (\InvalidArgumentException|\JsonException $e) { $this->s->invalid($e->getMessage()); }
    }
}
final class Span {
    public readonly TraceContext $context;
    private array $data;
    private bool $ended=false;
    public function __construct(private State $s,private string $table,string $name,array $attributes,?TraceContext $parent) {
        if ($name==='' || strlen($name)>255) throw new \InvalidArgumentException('invalid span name');
        $this->context=new TraceContext($parent?->traceId??bin2hex(random_bytes(16)),bin2hex(random_bytes(8)),$parent?->flags??1,$parent?->traceState??'');
        $this->data=['name'=>$name,'kind'=>1,'traceId'=>$this->context->traceId,'spanId'=>$this->context->spanId,'flags'=>$this->context->flags,'startTimeUnixNano'=>Protocol::nano(),'attributes'=>Protocol::attrs($attributes)];
        if ($parent) { $this->data['parentSpanId']=$parent->spanId; if ($parent->traceState!=='') $this->data['traceState']=$parent->traceState; }
    }
    public function setError(string $message): void { if (!$this->ended) $this->data['status']=['code'=>2,'message'=>substr($message,0,4096)]; }
    public function end(): void {
        if ($this->ended) return;
        $this->ended=true; $this->data['endTimeUnixNano']=(string)max((int)Protocol::nano(),(int)$this->data['startTimeUnixNano']);
        $this->s->store($this->table,'traces',$this->data);
    }
}
final class Client {
    private State $s;
    private string $table;
    public function __construct(string $service,string $table,string $endpoint='http://127.0.0.1:4318',string $key='',array $limits=[]) { $this->table=Protocol::table($table);$this->s=new State($service,$endpoint,$key,$limits);$this->s->selfTable=$this->table; }
    public function withTable(string $table): self { $child=clone $this; $child->table=Protocol::table($table); return $child; }
    public function counter(string $name,string $unit=''): Metric { return $this->instrument($name,'counter',$unit,[]); }
    public function gauge(string $name,string $unit=''): Metric { return $this->instrument($name,'gauge',$unit,[]); }
    public function histogram(string $name,array $boundaries=[5,10,25,50,100,250,500,1000],string $unit=''): Metric { return $this->instrument($name,'histogram',$unit,$boundaries); }
    private function instrument(string $name,string $kind,string $unit,array $bounds): Metric {
        if ($this->s->closed) throw new \RuntimeException('SDK is closed');
        foreach ($bounds as $n) if (!is_int($n) && !is_float($n)) throw new \InvalidArgumentException('invalid histogram boundaries');
        $bounds=array_values(array_map('floatval',$bounds));
        if ($name==='' || strlen($name)>255 || strlen($unit)>64 || count($bounds)>128) throw new \InvalidArgumentException('invalid metric identity');
        foreach ($bounds as $i=>$n) if (!is_finite($n) || ($i && $bounds[$i-1]>=$n)) throw new \InvalidArgumentException('invalid histogram boundaries');
        $id=$this->table."\0".$name;
        if (isset($this->s->metrics[$id])) {
            $m=$this->s->metrics[$id];
            if ([$m->kind,$m->unit,$m->bounds]!==[$kind,$unit,$bounds]) throw new \InvalidArgumentException('conflicting metric registration');
            return $m;
        }
        if (count($this->s->metrics)>=$this->s->limits['max_instruments']) throw new \InvalidArgumentException('instrument limit exceeded');
        return $this->s->metrics[$id]=new Metric($this->s,$this->table,$name,$kind,$unit,$bounds);
    }
    public function log(string $severity,string $body,array $attributes=[],?TraceContext $context=null): void {
        try {
            $level=strtolower($severity);$i=array_search($level,['trace','debug','info','warn','error','fatal'],true);
            if ($i===false || strlen($body)>65536) throw new \InvalidArgumentException('invalid log severity/body');
            $now=Protocol::nano();$row=['timeUnixNano'=>$now,'observedTimeUnixNano'=>$now,'severityText'=>$level,'severityNumber'=>1+4*$i,'body'=>['stringValue'=>$body],'attributes'=>Protocol::attrs($attributes)];
            if ($context) $row+=['traceId'=>$context->traceId,'spanId'=>$context->spanId,'flags'=>$context->flags];
            $this->s->store($this->table,'logs',$row);
        } catch (\InvalidArgumentException|\JsonException $e) { $this->s->invalid($e->getMessage()); }
    }
    public function startSpan(string $name,array $attributes=[],?TraceContext $parent=null): Span { if ($this->s->closed) throw new \RuntimeException('SDK is closed');return new Span($this->s,$this->table,$name,$attributes,$parent); }
    public function stats(): array { return $this->s->stats; }
    public function updateKey(string $key): void { $this->s->key=$key; }
    public function flush(float $timeout=10): void {
        if (!is_finite($timeout) || $timeout<=0) throw new \InvalidArgumentException('timeout must be positive');
        if ($this->s->closed) throw new \RuntimeException('SDK is closed');
        $deadline=hrtime(true)/1e9+$timeout; $this->s->collect(); $target=$this->s->sequence; $backoff=.2;
        while ($this->s->queue && $this->s->queue[0][0]<=$target) {
            $remaining=$deadline-hrtime(true)/1e9;
            if ($remaining<=0) throw new \RuntimeException('flush deadline exceeded; batches retained');
            [, $id,$created,$table,$signal,$raw,$count]=$this->s->queue[0];
            $headers="Content-Type: application/json\r\nX-Lightmoni-Table: $table\r\nX-Lightmoni-Batch-ID: $id\r\nX-Lightmoni-Batch-Created-At: $created\r\n";
            if ($this->s->key!=='') {
                if (strpbrk($this->s->key,"\r\n")!==false) throw new \InvalidArgumentException('invalid Key');
                $headers.="Authorization: Bearer ".$this->s->key."\r\n";
            }
            $context=stream_context_create(['http'=>['method'=>'POST','header'=>$headers,'content'=>$raw,'timeout'=>min(10,$remaining),'ignore_errors'=>true,'follow_location'=>0,'protocol_version'=>1.1]]);
            $status=0;$delay=0;$rejected=0;$ack=false;
            $http_response_header=[];
            $stream=@fopen($this->s->endpoint.'/v1/'.$signal,'rb',false,$context);
            if ($stream!==false) {
                foreach ($http_response_header as $line) {
                    if (preg_match('/^HTTP\/\S+ (\d+)/',$line,$m)) $status=(int)$m[1];
                    if (stripos($line,'Retry-After:')===0) { $retry=trim(substr($line,12)); $delay=ctype_digit($retry)?(float)$retry:max(0,(strtotime($retry)?:0)-time()); }
                }
                $body='';
                while (!feof($stream) && strlen($body)<=65536) {
                    $remaining=$deadline-hrtime(true)/1e9;
                    if ($remaining<=0) break;
                    $wait=min(10,$remaining);stream_set_timeout($stream,(int)$wait,(int)(($wait-(int)$wait)*1e6));
                    $part=@fread($stream,min(4096,65537-strlen($body)));
                    if ($part===false || $part==='') break;
                    $body.=$part;
                }
                $meta=stream_get_meta_data($stream);$complete=feof($stream) && !$meta['timed_out'];fclose($stream);
                if ($status===200 && $complete && strlen($body)<=65536) {
                    try {
                        $result=json_decode($body===''?'{}':$body,false,512,JSON_THROW_ON_ERROR);
                        if (!is_object($result)) throw new \RuntimeException('invalid acknowledgment');
                        if (isset($result->partialSuccess) && !is_object($result->partialSuccess)) throw new \RuntimeException('invalid partial success');
                        $field=match($signal) {'logs'=>'rejectedLogRecords','metrics'=>'rejectedDataPoints',default=>'rejectedSpans'};
                        $value=$result->partialSuccess->$field??0;
                        if (!is_int($value) && (!is_string($value) || !ctype_digit($value))) throw new \RuntimeException('invalid partial success');
                        $rejected=(int)$value;if ($rejected<0) throw new \RuntimeException('invalid partial success');
                        $ack=true;
                    } catch (\JsonException|\RuntimeException) { $status=0; }
                } elseif ($status===200) $status=0;
            }
            if ($ack || !in_array($status,[0,401,403,429,502,503,504],true)) {
                array_shift($this->s->queue);$this->s->stats['pending_batches']--;$this->s->stats['pending_bytes']-=strlen($raw);
                if ($ack && !$rejected) $this->s->stats['delivered_batches']++;
                else { $this->s->stats['rejected_records']+=$rejected?:$count;$this->s->failure=$this->s->stats['last_error']=$ack?'OTLP partial success; not retried':"telemetry rejected with HTTP $status"; }
                $backoff=.2;continue;
            }
            $this->s->stats['retried_batches']++;$this->s->stats['last_error']="telemetry delivery failed (HTTP $status)";
            $delay=max($delay,in_array($status,[401,403],true)?30:$backoff*(.8+mt_rand()/mt_getrandmax()*.4));
            usleep((int)(min($delay,max(0,$deadline-hrtime(true)/1e9))*1e6));$backoff=min(30,$backoff*2);
        }
        if ($this->s->failure!==null) throw new \RuntimeException($this->s->failure);
    }
    public function shutdown(float $timeout=10): void { try { $this->flush($timeout); } finally { $this->s->closed=true; } }
}
