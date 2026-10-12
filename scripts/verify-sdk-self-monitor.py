#!/usr/bin/env python3
"""Verify idle heartbeat and bounded diagnostics for the six native SDKs."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import threading

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('runner',ROOT/'scripts/test-sdks.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
receiver=runner.Receiver('0.0.0.0')
threading.Thread(target=receiver.serve_forever,daemon=True).start()
def run(language):
    host='host.docker.internal' if language in runner.IMAGES else '127.0.0.1'
    env=dict(os.environ,LIGHTMONI_ENDPOINT=f'http://{host}:{receiver.server_port}',LIGHTMONI_SERVICE='conformance-'+language,LIGHTMONI_KEY='private-test-placeholder',LIGHTMONI_TEST_MODE='selfmonitor',PYTHONPATH=str(ROOT/'sdk/python'))
    result=subprocess.run(runner.command(language,True),cwd=ROOT,env=env,capture_output=True,text=True,timeout=50)
    assert result.returncode==0,(language,result.stderr)
    stats=json.loads(result.stdout.strip().splitlines()[-1]);assert stats['pending_batches']==0
    with receiver.lock:
        attempts=[a for a in receiver.attempts if any(any(k['key']=='service.name' and k['value'].get('stringValue')=='conformance-'+language for k in resource['resource']['attributes']) for resource in a['body'].get('resourceMetrics',a['body'].get('resourceLogs',[])))]
    metrics=runner.records(attempts,'metrics');heartbeat=[m for m in metrics if m['name']=='lightmoni.sdk.heartbeat'];invalid=[m for m in metrics if m['name']=='lightmoni.sdk.invalid_records']
    assert heartbeat and heartbeat[0]['gauge']['dataPoints'][0]['asDouble']==1
    assert invalid and invalid[0]['gauge']['dataPoints'][0]['asDouble']==1
    logs=runner.records(attempts,'logs');assert logs and all('private-test-placeholder' not in row['body']['stringValue'] for row in logs)
    assert all(a['table']=='http' for a in attempts)
    return {'language':language,'passed':True,'heartbeats':len(heartbeat),'internal_logs':len(logs),'idle_periodic':language!='php','pending_batches':stats['pending_batches']}
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        report=list(pool.map(run,['python','ruby','java','dotnet','php','rust']))
    target=ROOT/'docs/evidence/self-monitoring/native-sdk-heartbeats.json';target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
finally:
    receiver.shutdown();receiver.server_close()
