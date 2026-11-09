#!/usr/bin/env bash
set -euo pipefail
qa_root=/Users/zhangsiwen/.codex/worktrees/deployment-followups/lightmoni
qa_dir="$qa_root/.lightmoni/117-telemetry-qa"
qa_evidence="$qa_root/specs/117-deployment-followups/evidence/main-agent-ui"
cd "$qa_root"
test ! -e "$qa_dir"
mkdir -p "$qa_root/.lightmoni" "$qa_evidence"
mkdir -m 700 "$qa_dir"
qa_api_pid=""; qa_ui_pid=""; qa_ch_id=""
cleanup() {
 trap - EXIT
 test -z "$qa_ui_pid" || kill -TERM "$qa_ui_pid" 2>/dev/null || true
 test -z "$qa_api_pid" || kill -TERM "$qa_api_pid" 2>/dev/null || true
 test -z "$qa_ui_pid" || wait "$qa_ui_pid" 2>/dev/null || true
 test -z "$qa_api_pid" || wait "$qa_api_pid" 2>/dev/null || true
 test -z "$qa_ch_id" || docker stop "$qa_ch_id" >/dev/null 2>&1 || true
 QA_DIR="$qa_dir" python3 - <<'PY'
import os, shutil
from pathlib import Path
p=Path(os.environ['QA_DIR']).resolve()
assert p == Path('/Users/zhangsiwen/.codex/worktrees/deployment-followups/lightmoni/.lightmoni/117-telemetry-qa')
if p.is_dir(): shutil.rmtree(p)
PY
}
trap cleanup EXIT
wait_http() {
 for qa_attempt in $(seq 1 30); do
  if curl --connect-timeout 1 --max-time 2 -fsS "$1" >/dev/null 2>&1; then return 0; fi
  sleep 1
 done
 return 1
}
qa_ch_id=$(docker run --detach --rm --name lm117-telemetry-ch --memory 2g --tmpfs /var/lib/clickhouse:rw,size=1536m -p 127.0.0.1:18718:8123 -e CLICKHOUSE_USER=lightmoni -e CLICKHOUSE_PASSWORD=lightmoni_test_password -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server:26.8)
wait_http http://127.0.0.1:18718/ping
(cd "$qa_root/runtime"; exec env LIGHTMONI_ADDR=127.0.0.1:18717 LIGHTMONI_DATA="$qa_dir" LIGHTMONI_CH_URL=http://127.0.0.1:18718 LIGHTMONI_CH_USER=lightmoni LIGHTMONI_CH_PASSWORD=lightmoni_test_password LIGHTMONI_EXTERNAL_URL=http://127.0.0.1:5177 node --import tsx src/server/main.ts) >"$qa_dir/api.log" 2>&1 &
qa_api_pid=$!
wait_http http://127.0.0.1:18717/api/v1/setup
QA_DIR="$qa_dir" node --input-type=module <<'JS'
import {writeFileSync} from 'node:fs';import {join} from 'node:path';
const dir=process.env.QA_DIR;
writeFileSync(join(dir,'vite.config.mjs'),'export default '+JSON.stringify({cacheDir:join(dir,'vite-cache'),server:{hmr:false,watch:null,proxy:{'/api':{target:'http://127.0.0.1:18717',changeOrigin:true},'/v1':'http://127.0.0.1:18717','/downloads':'http://127.0.0.1:18717'}}})+';\n');
JS
(cd "$qa_root/web"; exec node node_modules/vite/bin/vite.js --config "$qa_dir/vite.config.mjs" --host 127.0.0.1 --port 5177 --strictPort) >"$qa_dir/vite.log" 2>&1 &
qa_ui_pid=$!
wait_http http://127.0.0.1:5177/
curl -fsS -X POST http://127.0.0.1:18717/api/v1/setup -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5177' --data '{"name":"local-admin","password":"local-demo-password"}' >/dev/null
node --input-type=module <<'JS'
import {createLightMoni} from './sdk/typescript/dist/src/index.js';
const endpoint='http://127.0.0.1:18717',headers={'Content-Type':'application/json',Origin:'http://127.0.0.1:5177'};
const login=await fetch(endpoint+'/api/v1/auth/login',{method:'POST',headers,body:JSON.stringify({name:'local-admin',password:'local-demo-password'})});
if(!login.ok)throw Error('QA login failed');headers.cookie=login.headers.get('set-cookie').split(';')[0];
const response=await fetch(endpoint+'/api/v1/keys',{method:'POST',headers,body:JSON.stringify({name:'117 isolated log performance schema'})});
const key=await response.json();if(!response.ok)throw Error('QA key creation failed');
const client=createLightMoni({service:'117-log-fixture',table:'followups',endpoint,key:key.key,selfTelemetry:false,remoteConfig:false});client.log('info','Isolated performance schema fixture');await client.shutdown();
const disabled=await fetch(endpoint+'/api/v1/keys/'+key.id,{method:'PUT',headers,body:JSON.stringify({active:false})});if(!disabled.ok)throw Error('QA key disable failed');
JS
export LIGHTMONI_UI_URL=http://127.0.0.1:5177
export LIGHTMONI_QA_CENTER_URL=http://127.0.0.1:18717
export LIGHTMONI_QA_ORIGIN=http://127.0.0.1:5177
export LIGHTMONI_TELEMETRY_QA_DATABASE="$qa_dir/lightmoni.db"
for qa_round in parent-1 parent-2 parent-3; do
 LIGHTMONI_QA_RUN="$qa_round" LIGHTMONI_QA_OUTPUT="$qa_evidence/native-monitoring" node web/src/app/verify-native-monitoring.mjs
 LIGHTMONI_QA_RUN="$qa_round" LIGHTMONI_PERF_PHASE="$qa_round" LIGHTMONI_QA_OUTPUT="$qa_evidence/log-performance" node web/src/features/logs/verify-performance.mjs
 LIGHTMONI_QA_RUN="$qa_round" LIGHTMONI_QA_OUTPUT="$qa_evidence/grafana-parity" node web/src/features/dashboards/verify-grafana-parity.mjs
 LIGHTMONI_QA_RUN="$qa_round" LIGHTMONI_QA_OUTPUT="$qa_evidence/grafana-deep-parity" node web/src/features/dashboards/verify-deep-parity.mjs
done
QA_EVIDENCE="$qa_evidence" python3 - <<'PY'
import json,os
from pathlib import Path
root=Path(os.environ['QA_EVIDENCE'])
for run in ['parent-1','parent-2','parent-3']:
 for name in ['native-monitoring','log-performance','grafana-parity','grafana-deep-parity']:
  p=root/name/(run+'-report.json')
  assert json.loads(p.read_text())['passed'] is True,str(p)
print('PASS: 3 rounds x 4 scripts')
PY
