import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { Auth } from "../src/server/auth.js";
import { Catalog } from "../src/server/catalog.js";
import { Ingest, normalize, stamp } from "../src/server/ingest.js";
import { decodeOTLP, encodeOTLP, nowNano } from "../src/shared/otlp.js";
import {
  Executor,
  referencedTables,
  expand,
  parameter,
} from "../src/server/query.js";
import { registerSettings } from "../src/server/settings.js";
import { stringifyJSON, parseJSON } from "../src/shared/json.js";
import { cipher, hash } from "../src/shared/crypto.js";
import { gzipSync } from "node:zlib";
import type { Dependencies, Table } from "../src/shared/types.js";
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-node-core-")),
    db = new DB(join(dir, "legacy.db")),
    router = new Router((e) => console.error(e)),
    a = new Auth(db, dir, "http://127.0.0.1:0", router);
  router.auth = a;
  const queries: any[] = [],
    inserts: any[] = [],
    ddls: string[] = [];
  let failDDL = "";
  const ch = {
    user: "writer",
    exec: async (sql: string) => {
      ddls.push(sql);
      if (failDDL && sql.includes(failDDL)) {
        failDDL = "";
        throw Error("injected DDL failure");
      }
    },
    query: async (sql: string, params: any) => {
      queries.push({ sql, params });
      return sql.includes("system.columns")
        ? {
            meta: [],
            data: [
              { name: "event_time", type: "DateTime64(9,'UTC')" },
              { name: "event_id", type: "String" },
              { name: "value_int", type: "Int64" },
            ],
            rows: 3,
          }
        : {
            meta: [{ name: "n", type: "UInt64" }],
            data: [{ n: "18446744073709551615" }],
            rows: 1,
          };
    },
    insert: async (table: string, rows: any[]) => {
      inserts.push({ table, rows });
    },
  };
  const cat = new Catalog(db, ch, { ...ch, user: "reader" }),
    executor = new Executor(ch, cat);
  a.register();
  const deps: Dependencies = {
    db,
    router,
    auth: a,
    cat,
    ch,
    reader: ch,
    query: executor.execute.bind(executor),
    referencedTables: executor.referencedTables.bind(executor),
    externalURL: a.externalURL,
    encrypt: a.encrypt,
    decrypt: a.decrypt,
    now: () => new Date(),
    logger: console,
  };
  registerSettings(deps);
  const ingest = new Ingest(cat, a);
  ingest.register();
  const server = createServer(
    (req, res) =>
      void router
        .handle(req, res)
        .then((found) => {
          if (!found) {
            res.writeHead(404);
            res.end();
          }
        })
        .catch((e) => {
          console.error(e);
          res.writeHead(500);
          res.end();
        }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  router.externalURL = base;
  let session = "";
  const request = async (
    path: string,
    method = "GET",
    body?: any,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(base + path, {
      method,
      body:
        body === undefined
          ? undefined
          : typeof body === "string" || body instanceof Uint8Array
            ? body
            : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(session ? { cookie: session } : {}),
        ...headers,
      },
    });
    if (response.headers.get("set-cookie"))
      session = response.headers.get("set-cookie")!.split(";")[0];
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      data: text ? JSON.parse(text) : undefined,
    };
  };
  return {
    dir,
    db,
    router,
    a,
    cat,
    executor,
    deps,
    ingest,
    base,
    request,
    ch,
    queries,
    inserts,
    ddls,
    setFail: (v: string) => (failDDL = v),
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("SQLite preserves old schema, BLOBs, Int64 and rolls back failed transactions", () => {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-sqlite-"));
  try {
    const path = join(dir, "db"),
      db = new DB(path);
    db.exec("CREATE TABLE old(n INTEGER,b BLOB)");
    db.run(
      "INSERT INTO old VALUES(?,?)",
      9223372036854775807n,
      Buffer.from([0, 255]),
    );
    assert.equal(db.get<any>("SELECT * FROM old")?.n, "9223372036854775807");
    assert.deepEqual(
      db.get<any>("SELECT * FROM old")?.b,
      Buffer.from([0, 255]),
    );
    assert.throws(() =>
      db.transaction(() => {
        db.run("DELETE FROM old");
        throw Error("fault");
      }),
    );
    assert.equal(db.all("SELECT * FROM old").length, 1);
    db.close();
    const reopened = new DB(path);
    assert.equal(reopened.all("SELECT * FROM old").length, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("existing master key ciphertext, bcrypt sessions and key grants survive reopen", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/api/v1/setup")).data.required, true);
    assert.equal(
      (
        await f.request("/api/v1/setup", "POST", {
          name: "admin",
          password: "password123",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await f.request("/api/v1/setup", "POST", {
          name: "other",
          password: "password123",
        })
      ).status,
      409,
    );
    assert.equal((await f.request("/api/v1/auth/me")).data.role, "admin");
    assert.equal(
      (
        await f.request("/api/v1/auth/login", "POST", {
          name: "admin",
          password: "bad",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request(
          "/api/v1/auth/login",
          "POST",
          { name: "admin", password: "password123" },
          { origin: "https://evil.test" },
        )
      ).status,
      403,
    );
    const key = await f.request("/api/v1/keys", "POST", {
      name: "test",
    });
    assert.equal(key.status, 201);
    assert(
      !JSON.stringify((await f.request("/api/v1/keys")).data).includes(
        key.data.key,
      ),
    );
    const aad = new Auth(f.db, f.dir, f.base, f.router);
    assert.equal(aad.decrypt(f.a.encrypt("fixture-secret")), "fixture-secret");
    const cookie = (
      await f.request("/api/v1/auth/login", "POST", {
        name: "admin",
        password: "password123",
      })
    ).headers
      .get("set-cookie")!
      .split(";")[0];
    assert.equal(aad.user({ headers: { cookie } } as any)?.name, "admin");
    const uid = f.db.get<any>("SELECT id FROM users")!.id;
    assert.equal(
      (
        await f.request("/api/v1/users/" + uid, "PUT", {
          name: "admin",
          role: "member",
          active: true,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request("/api/v1/users", "POST", {
          name: "member",
          password: "password123",
          role: "member",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await f.request("/api/v1/auth/login", "POST", {
          name: "member",
          password: "password123",
        })
      ).status,
      200,
    );
    assert.equal((await f.request("/api/v1/keys")).status, 403);
    assert.equal(
      (
        await f.request("/api/v1/auth/notification-profile", "PUT", {
          phone: "13800000000",
          email: "a@example.com",
        })
      ).data.phone,
      "+8613800000000",
    );
    assert.equal(
      (
        await f.request("/api/v1/auth/profile", "PUT", {
          nickname: "Name",
          phone: "13800000000",
          avatar_url: "",
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request("/api/v1/auth/profile")).data.email,
      "a@example.com",
    );
  } finally {
    await f.close();
  }
});
test("SELECT AST blocks writes, external functions, hidden tables and overrides in nested queries", () => {
  const allowed = new Set(["log_app"]);
  assert.deepEqual(
    referencedTables(
      "WITH a AS (SELECT * FROM log_app) SELECT * FROM a",
      allowed,
    ),
    ["log_app"],
  );
  for (const sql of [
    "SELECT * FROM system.tables",
    "SELECT * FROM _lm_log_app",
    "SELECT * FROM remote('server','t')",
    "SELECT dictGet('d','x',1)",
    "SELECT * FROM log_app SETTINGS readonly=0",
    "SELECT * FROM log_app FORMAT JSON",
    "SELECT 1; SELECT 2",
    "DELETE FROM log_app",
    "SELECT * FROM (SELECT * FROM url('http://local'))",
    "SELECT * FROM log_app INTO OUTFILE '/tmp/leak'",
  ])
    assert.throws(() => referencedTables(sql, allowed), sql);
  const macros = expand(
    "SELECT '$__timeFilter(x)' FROM log_app WHERE $__timeFilter(event_time) -- $__timeFilter(y)",
    { from: "2026-10-17T01:00:00.123456789Z", to: "2026-10-17T02:00:00Z" },
    100,
  );
  assert(macros.sql.includes("'$__timeFilter(x)'"));
  assert.equal(macros.params.__lm_from, "2026-10-17 01:00:00.123456789");
  assert.equal(
    parameter({ type: "UInt64", value: "18446744073709551615" }),
    "18446744073709551615",
  );
  assert.throws(() =>
    parameter({ type: "UInt64", value: "18446744073709551616" }),
  );
});
test("OTLP ingest retains exact fields, freezes retry ids, permits any business table, and validates before storage", async () => {
  const f = await fixture();
  try {
    await f.request("/api/v1/setup", "POST", {
      name: "admin",
      password: "password123",
    });
    const key = (
      await f.request("/api/v1/keys", "POST", {
        name: "test",
      })
    ).data.key;
    const at = nowNano().toString(),
      payload = {
        resourceMetrics: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "fixture" } },
              ],
            },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "requests",
                    sum: {
                      aggregationTemporality: 1,
                      isMonotonic: true,
                      dataPoints: [
                        { timeUnixNano: at, asInt: "9223372036854775807" },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      raw = encodeOTLP("metrics", payload),
      headers = {
        "content-type": "application/x-protobuf",
        authorization: "Bearer " + key,
        "x-lightmoni-table": "app",
        "x-lightmoni-batch-id": "frozen-batch",
      };
    assert.equal(
      (await f.request("/v1/metrics", "POST", raw, headers)).status,
      200,
    );
    assert.equal(f.inserts[0].rows[0].value_int, "9223372036854775807");
    const event = f.inserts[0].rows[0].event_id;
    assert.equal(event, hash("frozen-batch\0metrics\0" + "0"));
    assert.equal(
      (await f.request("/v1/metrics", "POST", raw, headers)).status,
      200,
    );
    assert.equal(f.inserts.length, 1);
    assert.equal(
      (
        await f.request("/v1/metrics", "POST", raw, {
          ...headers,
          "x-lightmoni-table": "another",
          "x-lightmoni-batch-id": "another-batch",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request("/v1/metrics", "POST", raw, {
          ...headers,
          "x-lightmoni-table": "lightmoni_center",
        })
      ).status,
      403,
    );
    const other = encodeOTLP("metrics", { resourceMetrics: [] });
    assert.equal(
      (await f.request("/v1/metrics", "POST", other, headers)).status,
      400,
    );
    assert.equal(
      (
        await f.request("/v1/metrics", "POST", gzipSync(raw), {
          ...headers,
          "x-lightmoni-batch-id": "gzip-batch",
          "content-encoding": "gzip",
        })
      ).status,
      200,
    );
    assert.equal(f.inserts.length, 3);
    const result = await f.executor.execute({
      range: { from: "2026-10-17T00:00:00Z", to: "2026-10-18T00:00:00Z" },
      interval_ms: 60000,
      queries: [{ refId: "A", sql: "SELECT * FROM metric_app_sum" }],
    });
    assert.equal(
      result.results[0].frames[0].rows[0][0],
      "18446744073709551615",
    );
  } finally {
    await f.close();
  }
});
test("retention compensates ClickHouse DDL failures without changing SQLite", async () => {
  const f = await fixture();
  try {
    await f.cat.ensure("app", "log");
    await f.cat.ensure("other", "log");
    f.setFail("_lm_log_other");
    await assert.rejects(() => f.cat.setRetention(null, 30));
    assert.equal(f.cat.defaultRetention(), 7);
    assert(
      f.ddls.some((sql) =>
        sql.includes("_lm_log_app MODIFY TTL event_time + INTERVAL 7 DAY"),
      ),
    );
    await f.cat.setRetention("log_app", 0);
    assert.equal(
      (await f.cat.list()).find((t) => t.id === "log_app")
        ?.effective_retention_days,
      0,
    );
  } finally {
    await f.close();
  }
});
test("remote reporting settings preserve scalar types and exact values, scope by key and enforce admin", async () => {
  const f = await fixture();
  try {
    await f.request("/api/v1/setup", "POST", {
      name: "admin",
      password: "password123",
    });
    await f.cat.ensure("app", "log");
    const p = {
      key: "event_id",
      rules: [
        {
          name: "VIP",
          rate: 1,
          conditions: [
            {
              field: "attr:uid",
              operator: "in",
              values: [true, "1", parseJSON("9223372036854775807")],
            },
          ],
        },
      ],
      exclude: [],
    };
    const resp = await f.request(
      "/api/v1/catalog/tables/log_app/log-sampling",
      "PUT",
      stringifyJSON(p),
    );
    assert.equal(resp.status, 200);
    assert(
      f.db
        .get<any>("SELECT policy_json FROM log_sampling")!
        .policy_json.includes("9223372036854775807"),
    );
    const key = (
      await f.request("/api/v1/keys", "POST", {
        name: "k",
      })
    ).data.key;
    const config = await f.request("/v1/sdk-config", "GET", undefined, {
      authorization: "Bearer " + key,
    });
    assert.equal(config.status, 200);
    assert.equal(config.headers.get("cache-control"), "no-store");
    assert.equal(config.data.log_sampling.app.rules[0].name, "VIP");
    assert.equal(
      (
        await f.request("/api/v1/settings/sdk-reporting", "PUT", {
          disable_rules: [{ name: "invalid", conditions: [] }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request("/api/v1/settings/reporting", "PUT", {
          endpoints: [
            { id: "x", name: "central", url: "https://example.com/path/" },
          ],
          default_endpoint_id: "x",
        })
      ).data.endpoint,
      "https://example.com/path",
    );
    assert.equal(
      (
        await f.request("/api/v1/settings/reporting", "PUT", {
          endpoint: "https://user:password@example.com",
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test('metric period HTTP API persists independent tables, scopes SDK configuration and requires admin', async () => {
 const f=await fixture();
 try {
  assert.equal((await fetch(f.base+'/api/v1/metric-windows/business')).status,401);
  await f.request('/api/v1/setup','POST',{name:'admin',password:'password123'});
  const initial=await f.request('/api/v1/metric-windows/business');
  assert.equal(initial.status,200);assert.equal(initial.data.default_seconds,30);
  for(const [table,seconds] of [['business',10],['private',300]] as const)assert.equal((await f.request('/api/v1/metric-windows/'+table,'PUT',{window_seconds:seconds})).status,200);
  for(const body of [{window_seconds:[10,30]},{window_seconds:120},{window_seconds:'30'},[],null])assert.equal((await f.request('/api/v1/metric-windows/business','PUT',body)).status,400);
  for(const name of ['lightmoni','metric_business','UPPER'])assert.equal((await f.request('/api/v1/metric-windows/'+name,'PUT',{window_seconds:30})).status,400);
  const reopened=new DB(join(f.dir,'legacy.db'));
  try {assert.equal(reopened.get<any>('SELECT window_seconds FROM metric_window_config WHERE logical_name=?','business')?.window_seconds,10);}finally{reopened.close();}
  const key=(await f.request('/api/v1/keys','POST',{name:'windows'})).data.key;
  const headers={Authorization:'Bearer '+key};
  const current=await f.request('/v1/sdk-config','GET',undefined,headers);
  assert.equal(current.status,200);assert.equal(current.data.metric_windows.business.at(-1).seconds,10);assert.equal(current.data.metric_windows.private.at(-1).seconds,300);
  await f.request('/api/v1/sdk-exempt-tables','POST',{name:'business'});
  const anonymous=await f.request('/v1/sdk-config');
  assert.deepEqual(Object.keys(anonymous.data.metric_windows),['business']);
  assert.equal((await f.request('/v1/sdk-config','GET',undefined,{Authorization:'Bearer invalid'})).status,401);
  await f.request('/api/v1/users','POST',{name:'member',password:'password123',role:'member'});
  await f.request('/api/v1/auth/login','POST',{name:'member',password:'password123'});
  assert.equal((await f.request('/api/v1/metric-windows/business','GET')).status,200);
  assert.equal((await f.request('/api/v1/metric-windows/business','PUT',{window_seconds:60})).status,403);
 } finally {await f.close();}
});

test("SDK exemptions require admin, exact names, typed fields and persist after SQLite reopening", async () => {
 const f=await fixture();try{
  assert.equal((await fetch(f.base+'/api/v1/sdk-exempt-tables')).status,401);
  await f.request('/api/v1/setup','POST',{name:'admin',password:'password123'});
  assert.deepEqual((await f.request('/api/v1/sdk-exempt-tables')).data,[]);
  for(const name of ['*','log_app','metric_app','trace_app','lightmoni','lightmoni','lightmoni','a'.repeat(49),'UPPER'])assert.equal((await f.request('/api/v1/sdk-exempt-tables','POST',{name})).status,400,name);
  for(const body of [{name:'app',active:'true'},{name:'app',description:1},{name:'app',unknown:true}])assert.equal((await f.request('/api/v1/sdk-exempt-tables','POST',body)).status,400);
  const created=await f.request('/api/v1/sdk-exempt-tables','POST',{name:'app_logs_18aca241',description:'应用日志'});assert.equal(created.status,201);assert.equal(created.data.active,true);
  assert.equal((await f.request('/api/v1/sdk-exempt-tables','POST',{name:'app_logs_18aca241'})).status,409);
  assert.equal((await f.request('/api/v1/sdk-exempt-tables/app_logs_18aca241','PUT',{name:'rename'})).status,400);
  const reopened=new DB(join(f.dir,'legacy.db'));try{const auth=new Auth(reopened,f.dir,f.base,new Router());assert.deepEqual(auth.validateKey({req:{headers:{}}} as any,undefined,true).allowed_tables,['app_logs_18aca241']);}finally{reopened.close();}
  await f.request('/api/v1/users','POST',{name:'member',password:'password123',role:'member'});await f.request('/api/v1/auth/login','POST',{name:'member',password:'password123'});
  assert.equal((await f.request('/api/v1/sdk-exempt-tables')).status,200);
  assert.equal((await f.request('/api/v1/sdk-exempt-tables','POST',{name:'other'})).status,403);
  assert.equal((await f.request('/api/v1/sdk-exempt-tables/app_logs_18aca241','PUT',{active:false})).status,403);
  assert.equal((await f.request('/api/v1/sdk-exempt-tables/app_logs_18aca241','DELETE')).status,403);
 }finally{await f.close();}
});
test("anonymous OTLP enforces exemptions for all signals, isolates retries and never downgrades wrong keys", async () => {
 const f=await fixture();try{
  await f.request('/api/v1/setup','POST',{name:'admin',password:'password123'});
  assert.equal((await f.request('/v1/logs','POST',{}, {'X-Lightmoni-Table':'public_logs_123'})).status,401);
  await f.request('/api/v1/sdk-exempt-tables','POST',{name:'public_logs_123'});
  const key=(await f.request('/api/v1/keys','POST',{name:'named'})).data;
  const at=nowNano().toString(),resource={attributes:[{key:'service.name',value:{stringValue:'anonymous-qa'}}]};
  const payloads:any={logs:{resourceLogs:[{resource,scopeLogs:[{logRecords:[{timeUnixNano:at,body:{stringValue:'anonymous'}}]}]}]},metrics:{resourceMetrics:[{resource,scopeMetrics:[{metrics:[{name:'requests',gauge:{dataPoints:[{timeUnixNano:at,asInt:'1'}]}}]}]}]},traces:{resourceSpans:[{resource,scopeSpans:[{spans:[{traceId:'a'.repeat(32),spanId:'b'.repeat(16),name:'anonymous',startTimeUnixNano:at,endTimeUnixNano:at}]}]}]}};
  for(const signal of ['logs','metrics','traces']){
   const headers={'X-Lightmoni-Table':'public_logs_123','X-Lightmoni-Batch-ID':'same-'+signal},payload=payloads[signal],before=f.inserts.length;
   assert.equal((await f.request('/v1/'+signal,'POST',payload,headers)).status,200,signal);assert.equal(f.inserts.at(-1).rows[0].key_id,'');
   assert.equal((await f.request('/v1/'+signal,'POST',payload,headers)).status,200);assert.equal(f.inserts.length,before+1);
   assert.equal((await f.request('/v1/'+signal,'POST',payload,{...headers,Authorization:'Bearer '+key.key})).status,200);assert.equal(f.inserts.length,before+2);assert.equal(f.inserts.at(-1).rows[0].key_id,key.id);
   for(const Authorization of ['Bearer bad-key','Bearer ','Basic invalid'])assert.equal((await f.request('/v1/'+signal,'POST',payload,{...headers,Authorization})).status,401);
   for(const table of ['private','lightmoni'])assert.equal((await f.request('/v1/'+signal,'POST',payload,{...headers,'X-Lightmoni-Table':table})).status,403);
  }
  const runtime={resourceLogs:[{resource,scopeLogs:[{logRecords:[{timeUnixNano:at,body:{stringValue:'started'},attributes:[{key:'lightmoni.component',value:{stringValue:'sdk'}},{key:'sdk.language',value:{stringValue:'typescript'}},{key:'event',value:{stringValue:'started'}}]}]}]}]};
  const beforeRuntime=f.inserts.length;
  assert.equal((await f.request('/v1/logs','POST',runtime,{'X-Lightmoni-Table':'public_logs_123'})).status,200);assert.equal(f.inserts.length,beforeRuntime+1);
  f.db.run("INSERT INTO log_sampling VALUES(?,?,?)",'public_logs_123',JSON.stringify({key:'event_id',rules:[],exclude:[]}),1);
  f.db.run("INSERT INTO log_sampling VALUES(?,?,?)",'private',JSON.stringify({key:'event_id',rules:[],exclude:[]}),1);
  const publicConfig=await f.request('/v1/sdk-config');assert.equal(publicConfig.status,200);assert.deepEqual(Object.keys(publicConfig.data.log_sampling),['public_logs_123']);assert.throws(()=>f.a.validateKey({req:{headers:{}}} as any));
  await f.request('/api/v1/keys/'+key.id,'PUT',{active:false});assert.equal((await f.request('/v1/logs','POST',payloads.logs,{'X-Lightmoni-Table':'public_logs_123',Authorization:'Bearer '+key.key})).status,401);
  await f.request('/api/v1/sdk-exempt-tables/public_logs_123','PUT',{active:false});const count=f.inserts.length;
  assert.equal((await f.request('/v1/logs','POST',payloads.logs,{'X-Lightmoni-Table':'public_logs_123','X-Lightmoni-Batch-ID':'same-logs'})).status,401);assert.equal(f.inserts.length,count);
  await f.request('/api/v1/sdk-exempt-tables/public_logs_123','PUT',{active:true});assert.equal((await f.request('/api/v1/sdk-exempt-tables/public_logs_123','DELETE')).status,200);
  assert.equal((await f.request('/v1/sdk-config')).status,401);assert.equal((await f.request('/v1/logs','POST',payloads.logs,{'X-Lightmoni-Table':'public_logs_123'})).status,401);
 }finally{await f.close();}
});

test("SDK keys cover every business table; shared self stream validates all records and disabled keys stay revoked",async()=>{
 const f=await fixture();try{
  await f.request('/api/v1/setup','POST',{name:'admin',password:'password123'});
  const key=(await f.request('/api/v1/keys','POST',{name:'all-business'})).data;
  assert.equal(Object.hasOwn(key,"allowed_tables"),false);assert.equal(Object.hasOwn(key,"allow_all_tables"),false);
  const at=nowNano().toString(),resource={attributes:[{key:'service.name',value:{stringValue:'sdk-model'}}]},row={timeUnixNano:at,body:{stringValue:'business'}};
  const payload=(records:any[])=>({resourceLogs:[{resource,scopeLogs:[{logRecords:records}]}]});
  const send=(table:string,records:any[])=>f.request('/v1/logs','POST',payload(records),{Authorization:'Bearer '+key.key,'X-Lightmoni-Table':table});
  for(const table of ['arbitrary_a','arbitrary_b'])assert.equal((await send(table,[row])).status,200);
  const self={...row,attributes:[{key:'lightmoni.component',value:{stringValue:'sdk'}},{key:'sdk.language',value:{stringValue:'python'}},{key:'event',value:{stringValue:'started'}}]};
  assert.equal((await send('lightmoni',[self])).status,200);assert.equal(f.inserts.at(-1).table,'_lm_lightmoni_log');
  const count=f.inserts.length;
  assert.equal((await send('lightmoni',[self,row])).status,403);assert.equal(f.inserts.length,count);
  for(const table of ['lightmoni_agent','lightmoni_center'])assert.equal((await send(table,[self])).status,403);
  await f.request('/api/v1/sdk-exempt-tables','POST',{name:'public_a'});await f.request('/api/v1/sdk-exempt-tables','POST',{name:'public_b'});
  for(const table of ['public_a','public_b']){assert.equal((await f.request('/v1/logs','POST',payload([self,row]),{'X-Lightmoni-Table':table})).status,200);assert.equal(f.inserts.at(-1).rows.length,2);}
  assert.equal((await send('another_business',[row])).status,200);
  await f.request('/api/v1/keys/'+key.id,'PUT',{active:false});new Auth(f.db,f.dir,f.base,new Router());assert.equal((await send('arbitrary_a',[row])).status,401);
 }finally{await f.close();}
});
