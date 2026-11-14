import type { Context, Dependencies } from "../shared/types.js";
import { fail } from "../shared/http.js";
import type { AccessAuthority, Principal, SessionAuthority } from "./types.js";
import type { CapabilityDefinition } from "./descriptor.js";
import type { CapabilityDispatcher } from "./index.js";

export function capabilityPrincipal(ctx: Context, authority: SessionAuthority, external?: AccessAuthority): Principal {
  if (ctx.req.headers.authorization !== undefined) {
    if (!external) fail(503, "外部授权校验不可用");
    return external.authenticate(ctx.req);
  }
  return authority.sessionPrincipal(ctx.user, "web");
}

const errorSchema = {
  type: "object", properties: { error: { type: "string" }, code: { type: "string" }, detail_code: { type: "string" } },
  required: ["error", "code", "detail_code"], additionalProperties: false,
};
const successSchema = (d: CapabilityDefinition) => ({
  type: "object", properties: {
    schema_version: { type: "integer", enum: [1] }, invocation_id: { type: "string" },
    kind: { type: "string", enum: ["read", "proposal"] }, status: { type: "string", enum: ["completed", "awaiting_approval"] }, data: d.outputSchema,
  }, required: ["schema_version", "invocation_id", "kind", "status", "data"], additionalProperties: false,
});
const responses = (d: CapabilityDefinition) => ({
  "200": { description: "Capability completed or proposal accepted", content: { "application/json": { schema: successSchema(d) } } },
  default: { description: "Authorization, validation, conflict or service failure", content: { "application/json": { schema: errorSchema } } },
});

export function capabilityOpenAPI(deps: Dependencies, dispatcher: CapabilityDispatcher, principal: Principal): Record<string, any> {
  const visible = new Set(dispatcher.list(principal).map(d => d.name));
  const definitions = dispatcher.definitions.filter(d => visible.has(d.name) && d.exposure.http);
  const paths: Record<string, any> = {};
  paths["/api/v1/capabilities"] = {
    get: {
      operationId: "listCapabilities",
      summary: "List capabilities visible to the current principal",
      security: [{ bearerAuth: [] }, { cookieAuth: [] }],
      responses: {
        "200": {
          description: "Visible capability summaries",
          content: { "application/json": { schema: { type: "array", items: { type: "object", additionalProperties: true } } } },
        },
      },
    },
  };
  for (const d of definitions) paths[`/api/v1/capabilities/${d.name}/invoke`] = { post: {
    operationId: `invoke_${d.id.replace(/[^A-Za-z0-9_]/g, "_")}`, summary: d.description,
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    requestBody: { required: true, content: { "application/json": { schema: d.inputSchema } } },
    responses: responses(d),
    "x-lightmoni-capability": { id: d.id, version: d.version, required_scopes: [d.scope, ...(d.additionalScopes ?? [])],
      allHosts: d.allHosts === true, effect: d.effect, risk: d.risk, operationKind: d.operationKind, idempotencyPolicy: d.idempotencyPolicy },
  } };
  return {
    openapi: "3.1.0", info: { title: "LightMoni Capability API", version: "1" },
    servers: [{ url: deps.externalURL }],
    components: { securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "PAT or OAuth access token" },
      cookieAuth: { type: "apiKey", in: "cookie", name: "lm_session" },
    }, schemas: { CapabilityError: errorSchema } },
    paths, "x-lightmoni-capability-count": definitions.length,
  };
}
