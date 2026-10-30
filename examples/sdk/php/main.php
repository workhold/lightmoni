<?php
declare(strict_types=1);
require __DIR__.'/../../../sdk/php/src/Client.php';
use LightMoni\Client;
use LightMoni\TraceContext;
function env(string $n,string $fallback): string { return getenv($n)===false?$fallback:getenv($n); }
function check(bool $v): void { if (!$v) throw new RuntimeException('SDK conformance assertion'); }
$mode=env('LIGHTMONI_TEST_MODE','demo');
$limits=$mode==='overflow'?['cardinality_limit'=>2]:($mode==='capacity'?['queue_bytes'=>1024,'max_batch_bytes'=>1024,'buffer_bytes'=>64]:[]);
$limits['self_telemetry']=in_array($mode,['demo','selfmonitor'],true);
$mon=new Client(env('LIGHTMONI_SERVICE','example-php-api'),'http',env('LIGHTMONI_ENDPOINT','https://monitor.example.com'),env('LIGHTMONI_KEY',''),$limits);
$counter=$mon->counter('http.requests');
switch ($mode) {
case 'selfmonitor':
    $counter->add(-1);$mon->flush(5);sleep(32);$mon->shutdown(5);break;
case 'fixture':
    $dims=['route'=>'/payments','method'=>'POST','status'=>200];
    $counter->add(1,$dims);$dims['status']=999;
    $counter->add(2,['status'=>200,'method'=>'POST','route'=>'/payments']);$counter->add(1,['status'=>500,'method'=>'POST','route'=>'/payments']);
    $counter->add(1,['typed'=>1]);$counter->add(1,['typed'=>'1']);$counter->add(-1);
    $mon->counter('exact')->add(9007199254740993);
    $gauge=$mon->gauge('active');$gauge->record(5);$gauge->record(7);
    $histogram=$mon->histogram('duration',[5,10]);foreach ([-1,5,6,10,11] as $n) $histogram->record($n);
    $parent=TraceContext::extract(['traceparent'=>'00-'.str_repeat('a',32).'-'.str_repeat('b',16).'-01','tracestate'=>'foo=bar']);
    check(TraceContext::extract(['traceparent'=>'00-'.str_repeat('0',32).'-'.str_repeat('b',16).'-01'])===null);
    check(TraceContext::extract($parent->inject())==$parent);
    $app=$mon->withTable('app');
    $app->log('info','without trace',['trace_id'=>'attribute-only']);
    $span=$app->startSpan('fixture',[],$parent);
    $app->log('info','中文 fixture',['exact'=>9007199254740993,'ok'=>true,'fraction'=>.125],$span->context);$span->end();
    $app->log('info','after trace');
    $mon->flush();$counter->add(2,['window'=>'next']);$mon->flush();break;
case 'trace_scope':
    $app=$mon->withTable('app');$parent=new TraceContext(str_repeat('a',32),str_repeat('b',16),0,'vendor=scope');
    $app->log('info','without trace');
    $app->withSpan('request',function()use($app){
        $app->log('info','scope root');check(TraceContext::extract(TraceContext::injectCurrent())==TraceContext::current());
        try{$app->withSpan('child',function()use($app){$app->log('info','scope child');throw new RuntimeException('scope failure');});}catch(RuntimeException){}
        $app->log('info','scope restored');$app->log('info','scope explicit',[],new TraceContext(str_repeat('c',32),str_repeat('d',16)));
    },[],$parent);
    $fibers=[];foreach([1,2]as$i)$fibers[]=new Fiber(function()use($app,$i){
        (new TraceContext(str_repeat((string)$i,32),str_repeat((string)$i,16)))->run(function()use($app,$i){Fiber::suspend();$app->log('info','scope concurrent '.$i);});
    });
    foreach($fibers as$fiber)$fiber->start();foreach($fibers as$fiber)$fiber->resume();
    check(TraceContext::current()===null);$app->log('info','after trace');$mon->flush();break;
case 'overflow':
    for ($i=0;$i<4;$i++) $counter->add(1,['dimension'=>$i]);$mon->flush();break;
case 'retry':
case 'auth':
    $counter->add(1,['window'=>'first']);$failed=false;
    try {$mon->flush(.45);}catch (RuntimeException) {$failed=true;}
    check($failed && $mon->stats()['pending_batches']===1);
    $counter->add(2,['window'=>'next']);$mon->updateKey('rotated');$mon->flush();break;
case 'permanent':
case 'partial':
case 'capacity':
    $counter->add(1);
    for ($i=0;$i<2;$i++) {$failed=false;try{$mon->flush();}catch(RuntimeException){$failed=true;}check($failed);}
    check($mon->stats()['pending_batches']===0);break;
default:
    $app=$mon->withTable('app');$duration=$mon->histogram('http.duration',[5,10,25,50,100,250]);$active=$mon->gauge('http.active');
    for ($i=0;$i<(int)env('LIGHTMONI_COUNT','20');$i++) {
        $status=$i%5===0?500:200;
        $app->withSpan('POST /payments',function($span)use($app,$counter,$duration,$active,$i,$status){
            $dims=['route'=>'/payments','method'=>'POST','status'=>$status];
            $counter->add(1,$dims);$duration->record(5+$i*2,$dims);$active->record($i%4);
            $app->log($status===500?'error':'info','sample payment completed',['sample_id'=>$i,'status'=>$status]);
            if ($status===500) $span->setError('sample payment failed');
        });
    }
    $mon->shutdown(15);
}
echo json_encode($mon->stats(),JSON_THROW_ON_ERROR)."\n";
