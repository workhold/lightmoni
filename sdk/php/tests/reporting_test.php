<?php
declare(strict_types=1);
require __DIR__.'/../src/Client.php';

// Run with: php sdk/php/tests/reporting_test.php (no additional test packages).
function same(mixed $expected, mixed $actual): void {
    if ($expected!==$actual) throw new RuntimeException('unexpected result: '.var_export($actual,true));
}
function rejects(callable $action, string $message): void {
    try { $action(); }
    catch (Throwable $error) {
        if (!str_contains($error->getMessage(),$message)) throw $error;
        return;
    }
    throw new RuntimeException('expected rejection: '.$message);
}
function clear_connection_env(): void {
    foreach (getenv() as $name=>$value) if (str_starts_with($name,'LIGHTMONI_')) putenv($name);
}

$previous=array_filter(getenv(),fn($name)=>str_starts_with($name,'LIGHTMONI_'),ARRAY_FILTER_USE_KEY);
$directory=sys_get_temp_dir().'/lightmoni-reporting-'.bin2hex(random_bytes(8));
mkdir($directory,0700);
$missing=$directory.'/missing-secret';
$tests=[
    'direct ignores unused agent sources'=>function() use ($missing): void {
        putenv('LIGHTMONI_MODE=direct');
        putenv('LIGHTMONI_ENDPOINT=http://localhost:8080');
        putenv('LIGHTMONI_DATA_KEY=platform-key');
        putenv('LIGHTMONI_AGENT_ENDPOINT=invalid unused endpoint');
        putenv('LIGHTMONI_LOCAL_TOKEN=unused-env');
        putenv('LIGHTMONI_LOCAL_TOKEN_FILE='.$missing);
        $route=LightMoni\Protocol::connection(['local_token'=>'unused-explicit','local_token_file'=>$missing]);
        same('http://localhost:8080',$route[0]); same('platform-key',$route[1]);
        same('direct',$route[3]); same('not_probed',$route[4]);
        $client=LightMoni\Client::fromEnv('reporting-test','orders',['self_telemetry'=>false]);
        same('direct',$client->stats()['selected_route']);
    },
    'agent ignores unused platform and legacy sources'=>function() use ($missing): void {
        putenv('LIGHTMONI_MODE=agent');
        putenv('LIGHTMONI_AGENT_ENDPOINT=http://localhost:4318');
        putenv('LIGHTMONI_LOCAL_TOKEN=local-token');
        putenv('LIGHTMONI_ENDPOINT=invalid unused endpoint');
        putenv('LIGHTMONI_DATA_KEY=unused-env');
        putenv('LIGHTMONI_KEY=unused-legacy');
        putenv('LIGHTMONI_DATA_KEY_FILE='.$missing);
        $route=LightMoni\Protocol::connection(['data_key'=>'unused-explicit','data_key_file'=>$missing]);
        same('http://localhost:4318',$route[0]); same('local-token',$route[1]); same('agent',$route[3]);
        $client=LightMoni\Client::fromEnv('reporting-test','orders',['self_telemetry'=>false]);
        same('agent',$client->stats()['selected_route']);
    },
    'selected sources still reject conflicts'=>function(): void {
        putenv('LIGHTMONI_DATA_KEY=env-data');
        rejects(fn()=>LightMoni\Protocol::connection(['mode'=>'direct','endpoint'=>'http://localhost:8080','data_key'=>'explicit-data']),'credential_source_conflict: LIGHTMONI_DATA_KEY');
        putenv('LIGHTMONI_LOCAL_TOKEN=env-local');
        rejects(fn()=>LightMoni\Protocol::connection(['mode'=>'agent','local_token'=>'explicit-local']),'credential_source_conflict: LIGHTMONI_LOCAL_TOKEN');
    },
    'direct supports legacy alias and rejects mismatching alias'=>function(): void {
        putenv('LIGHTMONI_KEY=legacy-data');
        $route=LightMoni\Protocol::connection(['mode'=>'direct','endpoint'=>'http://localhost:8080']);
        same('legacy-data',$route[1]); same('legacy-env',$route[6]);
        putenv('LIGHTMONI_DATA_KEY=new-data');
        rejects(fn()=>LightMoni\Protocol::connection(['mode'=>'direct','endpoint'=>'http://localhost:8080']),'credential_source_conflict: LIGHTMONI_KEY');
    },
    'selected files are loaded and symlinks rejected'=>function() use ($directory): void {
        $path=$directory.'/secret'; file_put_contents($path,"file-secret\n");
        $direct=LightMoni\Protocol::connection(['mode'=>'direct','endpoint'=>'http://localhost:8080','data_key_file'=>$path]);
        $agent=LightMoni\Protocol::connection(['mode'=>'agent','local_token_file'=>$path]);
        same('file-secret',$direct[1]); same('file',$direct[6]); same('file-secret',$agent[1]); same('file',$agent[6]);
        $link=$directory.'/link'; symlink($path,$link);
        rejects(fn()=>LightMoni\Protocol::connection(['mode'=>'direct','endpoint'=>'http://localhost:8080','data_key_file'=>$link]),'file must be a regular file');
        rejects(fn()=>LightMoni\Protocol::connection(['mode'=>'agent','local_token_file'=>$link]),'file must be a regular file');
    },
    'unknown mode rejected before secret reads'=>function() use ($missing): void {
        putenv('LIGHTMONI_DATA_KEY_FILE='.$missing); putenv('LIGHTMONI_LOCAL_TOKEN_FILE='.$missing);
        rejects(fn()=>LightMoni\Protocol::connection(['mode'=>'unknown']),'mode must be agent, direct, or auto');
    },
    'auto still reads both secret paths'=>function() use ($missing): void {
        putenv('LIGHTMONI_LOCAL_TOKEN_FILE='.$missing);
        rejects(fn()=>LightMoni\Protocol::connection(['mode'=>'auto']),'local token file must be a regular file');
        putenv('LIGHTMONI_LOCAL_TOKEN_FILE'); putenv('LIGHTMONI_DATA_KEY_FILE='.$missing);
        rejects(fn()=>LightMoni\Protocol::connection(['mode'=>'auto']),'data key file must be a regular file');
    },
    'agent permits disabled local authentication'=>function(): void {
        $route=LightMoni\Protocol::connection(['mode'=>'agent']);
        same('http://127.0.0.1:4318',$route[0]); same('',$route[1]);
    },
];
try {
    foreach ($tests as $name=>$test) { clear_connection_env(); $test(); echo "PASS $name\n"; }
    echo count($tests)." reporting tests passed\n";
} finally {
    clear_connection_env(); foreach ($previous as $name=>$value) putenv($name.'='.$value);
    foreach (glob($directory.'/*') as $path) unlink($path);
    rmdir($directory);
}
