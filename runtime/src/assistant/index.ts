import { randomBytes } from "node:crypto";
import type {
  Context,
  Dependencies,
  Handler,
  Module,
} from "../shared/types.js";
import {
  AssistantError,
  SYSTEM,
  bytes,
  control,
  object,
  publicSession,
  text,
  type Config,
  type Event,
  type Runtime,
  type Session,
  type Tool,
} from "./types.js";
import {
  canonicalBase,
  normalize,
  protocolBase,
  protocols,
  reasoning,
  validate,
} from "./provider.js";
import { discover } from "./discovery.js";
import {
  Recorder,
  Store,
  billingKey,
  identity,
  options as usageOptions,
  report,
  sameIdentity,
  validPrice,
  window as usageWindow,
  type Billing,
} from "./usage.js";
import {
  RuntimeError,
  checkpointCredential,
  credential,
  pendingTools,
  validateCheckpoint,
  validateMetadata,
  worker,
} from "./worker.js";
import { codeTaskReceipt, monitoringTools } from "./tools.js";
import { CodeTaskService, type CodeTaskInput } from "./code.js";
import { AlertCapabilities, AlertCapabilityError } from "../domains/alert-capabilities.js";
import { AlertProposalService } from "./alert-proposals.js";
import { alertTools } from "./alert-tools.js";
export interface AssistantOptions {
  runtime?: Runtime;
  tools?: Tool[];
  turnTimeout?: number;
  connectionTimeout?: number;
  maxConcurrentTurns?: number;
  system?: string;
  codeWorkspaceRoot?: string;
  codeAllowedCommands?: string[];
  alerts?: AlertCapabilities;
}
const id = () => randomBytes(16).toString("hex");
const key = (user: string, session: string) => `session/${user}/${session}`;
function ensureBoolean(value: any): void {
  if (value != null && typeof value !== "boolean")
    throw new AssistantError(400, "invalid input");
}
async function body(ctx: Context, keys: string[], limit: number): Promise<any> {
  try {
    const value = await ctx.body();
    if (bytes(JSON.stringify(value)) > limit) throw Error();
    return object(value, keys);
  } catch {
    throw new AssistantError(400, "invalid input");
  }
}
function validateCodeTaskInput(value: any): void {
  if (
    !value ||
    typeof value.task !== "string" ||
    value.task.trim().length < 2 ||
    value.task.length > 12000 ||
    typeof value.workspace !== "string" ||
    !value.workspace.trim() ||
    value.workspace.length > 512
  )
    throw new AssistantError(400, "invalid code task input", "invalid_input");
  for (const field of ["allowed_paths", "allowed_commands"])
    if (
      value[field] != null &&
      (!Array.isArray(value[field]) ||
        value[field].length > (field === "allowed_paths" ? 128 : 16) ||
        value[field].some((v: any) => typeof v !== "string" || v.length > 240))
    )
      throw new AssistantError(400, "invalid code task input", "invalid_input");
  if (
    (value.max_steps != null &&
      (value.max_steps < 1 || value.max_steps > 12)) ||
    (value.timeout_ms != null &&
      (value.timeout_ms < 1000 || value.timeout_ms > 120000))
  )
    throw new AssistantError(400, "invalid code task limits", "invalid_input");
  for (const field of ["max_steps", "timeout_ms"])
    if (value[field] != null && !Number.isSafeInteger(value[field]))
      throw new AssistantError(400, "invalid code task input", "invalid_input");
}

export function registerAssistant(
  deps: Dependencies,
  options: AssistantOptions = {},
): Module {
  const store = new Store(deps.db, deps.now),
    run = options.runtime ?? worker();
  const concurrency = options.maxConcurrentTurns ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw Error("assistant concurrency limit must be between 1 and 32");
  const active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  let stopping = false;
  const now = () => deps.now().toISOString();
  const safe =
    (handler: Handler, fallback: string): Handler =>
    async (ctx) => {
      try {
        if (!ctx.user?.id) throw new AssistantError(401, "login required");
        await handler(ctx);
      } catch (error) {
        if (ctx.res.headersSent) {
          if (!ctx.res.writableEnded) ctx.res.end();
          return;
        }
        if (error instanceof AssistantError || error instanceof AlertCapabilityError)
          ctx.json(
            {
              error: error.message,
              ...(error.code ? { code: error.code } : {}),
            },
            error.status,
          );
        else ctx.json({ error: fallback }, 500);
      }
    };
  const admin = (ctx: Context) => {
    if (ctx.user.role !== "admin")
      throw new AssistantError(403, "administrator required", "forbidden");
  };
  const load = (): Config => {
    try {
      const cfg = store.get<Config>("config") ?? ({} as Config);
      return { ...cfg, api_key: cfg.api_key ? deps.decrypt(cfg.api_key) : "" };
    } catch {
      throw new AssistantError(
        500,
        "cannot read assistant configuration",
        "configuration_unavailable",
      );
    }
  };
  const codeWorkspace =
    options.codeWorkspaceRoot ?? process.env.LIGHTMONI_CODE_WORKSPACE;
  const codeTasks = codeWorkspace?.trim()
    ? new CodeTaskService({
        workspaceRoot: codeWorkspace,
        now: deps.now,
        config: load,
        allowedCommands:
          options.codeAllowedCommands ??
          (() => {
            try {
              const value = JSON.parse(
                process.env.LIGHTMONI_CODE_CHECK_COMMANDS || "[]",
              );
              if (
                !Array.isArray(value) ||
                value.some((v: any) => typeof v !== "string")
              )
                throw Error();
              return value;
            } catch {
              throw Error(
                "LIGHTMONI_CODE_CHECK_COMMANDS must be a JSON string array",
              );
            }
          })(),
        // Code previews contain source text. Protect persisted artifacts with the master key.
        store: {
          get: <T>(key: string) => {
            const saved = store.get<string>(key);
            return saved ? (JSON.parse(deps.decrypt(saved)) as T) : undefined;
          },
          put: (key, value) =>
            store.put(key, deps.encrypt(JSON.stringify(value))),
        },
        usage: (task, owner, cfg) => {
          const recorder = new Recorder(
            store,
            "code-task",
            owner,
            "",
            task,
            store.billing(cfg),
          );
          let sequence = 0;
          return {
            record: (type, data) =>
              recorder.record({
                sequence: sequence++,
                session_id: "",
                turn_id: task,
                timestamp: now(),
                type,
                data,
              }),
            finish: (status) => recorder.finish(status),
          };
        },
      })
    : undefined;
  const requireCodeTasks = (ctx: Context) => {
    admin(ctx);
    if (!codeTasks)
      throw new AssistantError(
        503,
        "code workspace is not configured",
        "code_tasks_disabled",
      );
    return codeTasks;
  };
  const alertProposals = options.alerts
    ? new AlertProposalService(deps.db, options.alerts, deps.now, deps.encrypt, deps.decrypt)
    : undefined;
  const tools =
    options.tools ??
    [...monitoringTools(
      deps,
      codeTasks
        ? {
            codeTask: {
              run: (input, owner, signal) =>
                codeTasks.run(input, owner, signal),
            },
          }
        : {},
    ), ...(options.alerts && alertProposals ? alertTools(options.alerts, alertProposals) : [])];
  if (
    tools.some(
      (tool, index) =>
        !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) ||
        tools.slice(0, index).some((t) => t.name === tool.name) ||
        !["read", "draft", "code"].includes(tool.effect) ||
        typeof tool.execute !== "function" ||
        !tool.schema,
    )
  )
    throw Error("invalid assistant tool");
  const connectionKey = (
    base: string,
    explicit: string,
    saved: boolean,
  ): string => {
    if (explicit || !saved) return explicit;
    const cfg = load();
    let savedBase = "";
    try {
      savedBase = canonicalBase(cfg.base_url, false);
    } catch {}
    if (!cfg.api_key || savedBase !== base)
      throw new AssistantError(
        400,
        "saved credential is unavailable for this address; enter a new API key or clear the saved key",
        "saved_key_mismatch",
      );
    return cfg.api_key;
  };
  const session = (ctx: Context): Session => {
    try {
      const value = store.get<Session>(key(ctx.user.id, ctx.params.id));
      if (value && value.user_id === ctx.user.id)
        return {
          ...value,
          messages: value.messages ?? [],
          events: value.events ?? [],
        };
    } catch {}
    throw new AssistantError(404, "assistant session not found");
  };
  const save = (session: Session): void => {
    session.updated_at = now();
    if (bytes(JSON.stringify(session)) > 2 << 20)
      throw Error("conversation storage limit reached; start a new session");
    store.put(key(session.user_id, session.id), session);
  };
  const route = "/api/v1/assistant";
  const requireAlertProposals = () => {
    if (!alertProposals)
      throw new AssistantError(503, "告警业务能力尚未接入", "alert_controls_disabled");
    return alertProposals;
  };
  deps.router.get(
    route + "/alert-proposals/:id",
    safe((ctx) => ctx.json(requireAlertProposals().get(ctx.user, ctx.params.id)), "无法读取告警变更提案"),
  );
  deps.router.post(
    route + "/alert-proposals/:id/apply",
    safe(async (ctx) => {
      await body(ctx, [], 1024);
      ctx.json(await requireAlertProposals().apply(ctx.user, ctx.params.id, ctx.signal));
    }, "无法应用告警变更，请刷新后重试"),
  );
  deps.router.get(
    route + "/config",
    safe((ctx) => {
      const cfg = normalize(load());
      let base = cfg.base_url;
      try {
        base = canonicalBase(base, false);
      } catch {}
      const { api_key, ...view } = cfg;
      ctx.json({
        ...view,
        base_url: base,
        runtime: "mastra",
        has_key: !!api_key,
        code_tasks_enabled: !!codeTasks && ctx.user.role === "admin",
        ...(codeTasks && ctx.user.role === "admin"
          ? { code_workspace: "." }
          : {}),
      });
    }, "cannot read assistant configuration"),
  );
  deps.router.put(
    route + "/config",
    safe(async (ctx) => {
      admin(ctx);
      const old = load(),
        input = await body(
          ctx,
          [
            "base_url",
            "protocol",
            "model",
            "api_key",
            "enabled",
            "max_input_tokens",
            "max_output_tokens",
            "max_steps",
            "reasoning_effort",
            "clear_key",
          ],
          16 << 10,
        );
      for (const field of ["enabled", "clear_key"]) ensureBoolean(input[field]);
      for (const field of [
        "base_url",
        "protocol",
        "model",
        "api_key",
        "reasoning_effort",
      ])
        if (input[field] != null) text(input[field]);
      const cfg = normalize(input);
      cfg.base_url = protocolBase(cfg.base_url, cfg.protocol);
      if (!cfg.api_key && !input.clear_key) {
        if (old.api_key) {
          let oldBase = "";
          try {
            oldBase = canonicalBase(old.base_url, false);
          } catch {}
          if (oldBase !== cfg.base_url)
            throw new AssistantError(
              400,
              "a new API key or clear_key is required when changing the API base URL",
            );
        }
        cfg.api_key = old.api_key;
      }
      validate(cfg);
      const stored = { ...cfg };
      delete (stored as any).clear_key;
      try {
        if (stored.api_key) stored.api_key = deps.encrypt(stored.api_key);
      } catch {
        throw new AssistantError(500, "cannot protect assistant credential");
      }
      store.put("config", stored);
      const { api_key, ...view } = cfg;
      delete (view as any).clear_key;
      ctx.json({ ...view, runtime: "mastra", has_key: !!api_key });
    }, "cannot save assistant configuration"),
  );
  deps.router.post(
    route + "/models",
    safe(async (ctx) => {
      admin(ctx);
      ctx.json(
        await discover(
          await body(
            ctx,
            ["base_url", "api_key", "use_saved_key", "protocol"],
            16 << 10,
          ),
          ctx.signal,
          connectionKey,
        ),
      );
    }, "cannot request model directory"),
  );
  deps.router.get(
    route + "/billing",
    safe((ctx) => {
      admin(ctx);
      ctx.json(store.billing(load()));
    }, "cannot read model pricing"),
  );
  deps.router.put(
    route + "/billing",
    safe(async (ctx) => {
      admin(ctx);
      const cfg = load(),
        input = (await body(
          ctx,
          [
            "base_url",
            "protocol",
            "model",
            "currency",
            "input_price_per_million",
            "output_price_per_million",
          ],
          4096,
        )) as Billing;
      for (const field of [
        "base_url",
        "protocol",
        "model",
        "currency",
      ] as const)
        text(input[field]);
      if (!sameIdentity(input, identity(cfg)))
        throw new AssistantError(
          409,
          "model connection changed; reload pricing before saving",
        );
      if (!cfg.model?.trim() || !cfg.base_url)
        throw new AssistantError(
          400,
          "configure a model before setting prices",
        );
      if (
        !["CNY", "USD"].includes(input.currency) ||
        !validPrice(input.input_price_per_million) ||
        !validPrice(input.output_price_per_million)
      )
        throw new AssistantError(
          400,
          "prices must be between 0 and 1000000000; currency must be CNY or USD",
        );
      input.input_price_per_million ??= null;
      input.output_price_per_million ??= null;
      store.put(billingKey(input), input);
      ctx.json(input);
    }, "cannot save model pricing"),
  );
  deps.router.get(
    route + "/usage",
    safe((ctx) => {
      admin(ctx);
      const opts = usageOptions(ctx.url),
        at = deps.now(),
        bounds = usageWindow(at, opts.days, opts.timezone);
      ctx.json(
        report(
          store.list(bounds.from, bounds.to),
          at,
          opts.days,
          opts.timezone,
        ),
      );
    }, "cannot read assistant usage"),
  );
  deps.router.get(
    route + "/usage/details",
    safe((ctx) => {
      admin(ctx);
      const opts = usageOptions(ctx.url),
        bounds = usageWindow(deps.now(), opts.days, opts.timezone),
        records = store.list(bounds.from, bounds.to, opts.limit + 1);
      ctx.json({
        records: records.slice(0, opts.limit).map((r) => ({
          ...r,
          cost_status:
            r.cost_status || (r.estimated_cost != null ? "legacy" : "unpriced"),
        })),
        limit: opts.limit,
        has_more: records.length > opts.limit,
        from: bounds.from,
        to: bounds.to,
        timezone: opts.timezone,
      });
    }, "cannot read assistant usage details"),
  );
  deps.router.get(
    route + "/sessions",
    safe((ctx) => {
      const items = store
        .sessions(`session/${ctx.user.id}/`)
        .map((s) => ({ ...s, messages: null, events: null }));
      ctx.json({ items });
    }, "cannot list assistant sessions"),
  );
  deps.router.post(
    route + "/sessions",
    safe(async (ctx) => {
      const input = await body(ctx, ["title"], 4096),
        title = text(input.title).trim();
      if (bytes(title) > 240)
        throw new AssistantError(400, "session title is too long");
      const value: Session = {
        id: id(),
        user_id: ctx.user.id,
        title: title || "新对话",
        created_at: now(),
        updated_at: now(),
        messages: [],
        events: [],
      };
      save(value);
      ctx.json(value, 201);
    }, "cannot save assistant session"),
  );
  deps.router.get(
    route + "/sessions/:id",
    safe(
      (ctx) => ctx.json(publicSession(session(ctx))),
      "cannot read assistant session",
    ),
  );
  deps.router.post(
    route + "/sessions/:id/cancel",
    safe((ctx) => {
      const running = active.get(key(ctx.user.id, ctx.params.id));
      running?.controller.abort();
      ctx.json({ cancelled: !!running });
    }, "cannot cancel assistant turn"),
  );
  deps.router.post(
    route + "/test-connection",
    safe(async (ctx) => {
      admin(ctx);
      let input: any;
      try {
        input = await body(
          ctx,
          [
            "base_url",
            "api_key",
            "use_saved_key",
            "protocol",
            "model",
            "reasoning_effort",
          ],
          16 << 10,
        );
        for (const field of [
          "base_url",
          "api_key",
          "protocol",
          "model",
          "reasoning_effort",
        ])
          if (input[field] != null) text(input[field]);
        ensureBoolean(input.use_saved_key);
      } catch {
        throw new AssistantError(
          400,
          "invalid model connection input",
          "invalid_input",
        );
      }
      let base: string;
      try {
        base = protocolBase(input.base_url, input.protocol);
      } catch {
        throw new AssistantError(
          400,
          "enter a valid API base URL and a concrete model protocol",
          "invalid_input",
        );
      }
      const model = text(input.model).trim(),
        explicit = text(input.api_key),
        effort = text(input.reasoning_effort) || "provider-default";
      if (
        !model ||
        bytes(model) > 200 ||
        control(model) ||
        bytes(explicit) > 4096 ||
        control(explicit)
      )
        throw new AssistantError(
          400,
          "enter a valid model and API key",
          "invalid_input",
        );
      if (!reasoning.includes(effort))
        throw new AssistantError(
          400,
          "select a supported reasoning effort",
          "invalid_input",
        );
      const cfg = normalize({
          base_url: base,
          protocol: input.protocol,
          model,
          api_key: connectionKey(base, explicit, input.use_saved_key),
          enabled: true,
          max_input_tokens: 4096,
          max_output_tokens: 256,
          max_steps: 1,
          reasoning_effort: effort,
        }),
        turn = id(),
        billing = store.billing(cfg),
        recorder = new Recorder(
          store,
          "connection-test",
          ctx.user.id,
          "",
          turn,
          billing,
        ),
        timeout = AbortSignal.timeout(options.connectionTimeout ?? 15000),
        signal = AbortSignal.any([ctx.signal, timeout]),
        started = performance.now();
      let sequence = 0,
        error: unknown;
      try {
        await run(
          {
            connection_test: true,
            system: "Connection test. Reply with OK only.",
            config: cfg,
            messages: [{ role: "user", content: "Reply with OK only." }],
            tools: [],
          },
          signal,
          undefined,
          (frame) => {
            if (
              frame.type === "event" &&
              ["turn.usage", "model.request.started"].includes(frame.name || "")
            )
              recorder.record({
                sequence: sequence++,
                session_id: "",
                turn_id: turn,
                type: frame.name!,
                timestamp: now(),
                data: frame.data || {},
              });
          },
        );
      } catch (e) {
        error = e;
      }
      try {
        recorder.finish(signal.aborted ? "cancelled" : "failed");
      } catch {
        throw new AssistantError(
          500,
          "cannot persist model usage",
          "accounting_unavailable",
        );
      }
      if (error) {
        if (
          error instanceof RuntimeError &&
          error.code === "test_budget_exceeded"
        )
          throw new AssistantError(
            422,
            "selected reasoning cannot fit the connection test output budget; no generation request was sent",
            "test_budget_exceeded",
          );
        if (error instanceof RuntimeError && error.code === "output_limit")
          throw new AssistantError(
            502,
            "model responded but exhausted the connection test output budget",
            "output_limit",
          );
        if (timeout.aborted)
          throw new AssistantError(
            504,
            "model connection test timed out",
            "timeout",
          );
        throw new AssistantError(
          502,
          "model connection failed; check the endpoint, model and credentials",
          "provider_unavailable",
        );
      }
      ctx.json({
        ok: true,
        base_url: base,
        protocol: cfg.protocol,
        model,
        latency_ms: Math.trunc(performance.now() - started),
      });
    }, "model connection failed; check the endpoint, model and credentials"),
  );
  deps.router.post(
    route + "/code-tasks",
    safe(async (ctx) => {
      const service = requireCodeTasks(ctx);
      if (stopping) throw new AssistantError(503, "assistant is stopping");
      const input = await body(
        ctx,
        [
          "task",
          "workspace",
          "allowed_paths",
          "allowed_commands",
          "max_steps",
          "timeout_ms",
        ],
        32 << 10,
      );
      validateCodeTaskInput(input);
      const result = await service.run(
        input as CodeTaskInput,
        ctx.user,
        ctx.signal,
      );
      ctx.json(result, 201);
    }, "cannot run code task"),
  );
  deps.router.get(
    route + "/code-tasks/:id",
    safe((ctx) => {
      const result = requireCodeTasks(ctx).get(ctx.params.id, ctx.user);
      if (!result) throw new AssistantError(404, "code task not found");
      ctx.json(result);
    }, "cannot read code task"),
  );
  deps.router.post(
    route + "/code-tasks/:id/apply",
    safe(async (ctx) => {
      const service = requireCodeTasks(ctx);
      try {
        ctx.json(await service.apply(ctx.params.id, ctx.user));
      } catch {
        throw new AssistantError(
          409,
          "code task cannot be applied; it may have expired or the workspace has changed",
          "code_task_conflict",
        );
      }
    }, "cannot apply code task"),
  );
  deps.router.post(
    route + "/code-tasks/:id/cancel",
    safe((ctx) => {
      ctx.json({
        cancelled: requireCodeTasks(ctx).cancel(ctx.params.id, ctx.user),
      });
    }, "cannot cancel code task"),
  );
  deps.router.post(
    route + "/sessions/:id/turns",
    safe(async (ctx) => {
      const input = await body(ctx, ["text", "context"], 48 << 10),
        message = text(input.text).trim();
      if (
        !message ||
        bytes(message) > 16000 ||
        bytes(JSON.stringify(input.context ?? null)) > 32000
      )
        throw new AssistantError(
          400,
          "message is empty or exceeds the size limit",
        );
      let value = session(ctx);
      const codeWorkspace = input.context?.code_workspace;
      if (
        codeWorkspace != null &&
        (typeof codeWorkspace !== "string" ||
          !codeWorkspace.trim() ||
          codeWorkspace.length > 512)
      )
        throw new AssistantError(400, "invalid code workspace");
      const cfg = normalize(load());
      if (!cfg.enabled || !cfg.base_url || !cfg.model)
        throw new AssistantError(
          503,
          "AI provider is not configured or is disabled",
        );
      const billing = store.billing(cfg),
        sessionKey = key(ctx.user.id, value.id);
      if (active.has(sessionKey))
        throw new AssistantError(
          409,
          "this conversation already has an active turn",
        );
      if (stopping || active.size >= concurrency)
        throw new AssistantError(
          429,
          "assistant is busy; retry after another turn completes",
        );
      const controller = new AbortController(),
        timeout = AbortSignal.timeout(options.turnTimeout ?? 120000),
        signal = AbortSignal.any([ctx.signal, controller.signal, timeout]),
        turn = id();
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      active.set(sessionKey, { controller, done });
      try {
        value = session(ctx);
        ctx.res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        });
        ctx.res.write(": connected\n\n");
        ctx.res.flushHeaders();
        let sequence = value.events.length
            ? value.events.at(-1)!.sequence + 1
            : 0,
          lastPersist = performance.now();
        const recorder = new Recorder(
          store,
          "assistant",
          ctx.user.id,
          value.id,
          turn,
          billing,
        );
        const emit = (type: string, data: Record<string, any>): void => {
          const event: Event = {
            sequence: sequence++,
            session_id: value.id,
            turn_id: turn,
            type,
            timestamp: now(),
            data,
          };
          if (type === "turn.usage" || type === "model.request.started")
            recorder.record(event);
          let stored = event;
          const previous = value.events.at(-1);
          if (
            type === "assistant.delta" &&
            previous?.type === type &&
            previous.turn_id === turn &&
            previous.data.step === data.step
          ) {
            stored = {
              ...event,
              data: {
                step: data.step,
                text: String(previous.data.text) + String(data.text),
              },
            };
            value.events.pop();
          }
          value.events.push(stored);
          if (value.events.length > 4096)
            value.events = value.events.slice(-4096);
          if (
            type !== "assistant.delta" ||
            performance.now() - lastPersist >= 250
          ) {
            save(value);
            lastPersist = performance.now();
          }
          if (!ctx.res.destroyed && !ctx.res.writableEnded)
            ctx.res.write(
              `id: ${event.sequence}\nevent: session-event\ndata: ${JSON.stringify(event)}\n\n`,
            );
        };
        value.messages.push({ role: "user", content: message });
        let error: unknown;
        try {
          emit("user.message", { text: message });
          emit("turn.started", {});
          const base = structuredClone(value.messages);
          if (alertProposals) {
            const calls = new Set(base.flatMap(message => message.tool_calls?.filter(call => call.function.name === "propose_alert_change").map(call => call.id) ?? []));
            for (const message of base) {
              if (message.role !== "tool" || !message.tool_call_id || !calls.has(message.tool_call_id)) continue;
              try {
                const previous = JSON.parse(message.content);
                if (typeof previous.proposal?.id !== "string") continue;
                message.content = JSON.stringify({ proposal: alertProposals.get(ctx.user, previous.proposal.id) });
              } catch {
                message.content = JSON.stringify({ error: "告警提案已不可用，请查询当前配置并重新预览；不得声称已应用。" });
              }
            }
          }
          if (codeTasks && ctx.user.role === "admin") {
            const codeCalls = new Set(
              base.flatMap(
                (message) =>
                  message.tool_calls
                    ?.filter((call) => call.function.name === "code_task")
                    .map((call) => call.id) ?? [],
              ),
            );
            for (const message of base)
              if (
                message.role === "tool" &&
                message.tool_call_id &&
                codeCalls.has(message.tool_call_id)
              ) {
                try {
                  const previous = JSON.parse(message.content);
                  if (typeof previous.id !== "string") continue;
                  const current = codeTasks.get(previous.id, ctx.user);
                  message.content = JSON.stringify(
                    current
                      ? codeTaskReceipt(current)
                      : {
                          id: previous.id,
                          status: "failed",
                          summary:
                            "Code preview is expired or unavailable; create a new preview before applying.",
                        },
                  );
                } catch {
                  /* Keep unrelated or failed tool receipts intact. */
                }
              }
          }
          validateMetadata(base);
          let checkpointLength = 0;
          await run(
            {
              system: (options.system ?? SYSTEM) + (alertProposals ? `\nCurrent server time (UTC): ${now()}. Use this time for relative silence durations; clarify the timezone for ambiguous local times.\nHost-verified alert proposal states for the current session (latest 20; facts only). These statuses take precedence over old conversation summaries or UI claims; a completed status means the change was applied at applied_at, not that the resource has remained unchanged. Use get_alert_proposal to verify older IDs and get_alert_rule/get_alert_silence for current configuration:\n${JSON.stringify(alertProposals.recent(ctx.user, value.id))}` : ""),
              config: cfg,
              messages: base,
              summary: value.summary,
              summary_through: value.summary_through,
              context: input.context,
              tools: tools
                .filter(
                  (tool) => tool.effect !== "code" || ctx.user.role === "admin",
                )
                .map(({ name, description, schema }) => ({
                  name,
                  description,
                  schema,
                })),
            },
            signal,
            async (name, args) => {
              const tool = tools.find((t) => t.name === name);
              if (!tool) throw Error("this tool is not registered");
              if (tool.effect === "code") {
                admin(ctx);
                // A model may narrow allowed paths/checks, but cannot switch the user's workspace.
                const scoped = { ...args, workspace: codeWorkspace ?? "." };
                validateCodeTaskInput(scoped);
                return tool.execute(scoped, signal, ctx.user, { session_id: value.id });
              }
              return tool.execute(args, signal, ctx.user, { session_id: value.id });
            },
            async (frame) => {
              if (frame.type === "compacted") {
                if (credential(frame.summary, cfg.api_key || ""))
                  throw Error("model response contained protected credentials");
                const through = frame.through ?? 0;
                if (
                  through <= (value.summary_through ?? 0) ||
                  through >= base.length ||
                  base[through].role !== "user" ||
                  !frame.summary?.trim() ||
                  bytes(frame.summary) > 8192
                )
                  throw Error("invalid assistant summary checkpoint");
                value.summary = frame.summary;
                value.summary_through = through;
              } else if (frame.type === "checkpoint") {
                const messages = frame.messages!;
                if (checkpointCredential(messages, cfg.api_key || ""))
                  throw Error("model response contained protected credentials");
                validateCheckpoint(messages, checkpointLength);
                const combined = [...base, ...messages];
                validateMetadata(combined);
                value.messages = structuredClone(combined);
                checkpointLength = messages.length;
                save(value);
              } else if (frame.type === "event") {
                if (credential(frame.data, cfg.api_key || ""))
                  throw Error("model response contained protected credentials");
                emit(frame.name!, frame.data || {});
              } else throw Error("unexpected assistant runtime event");
            },
          );
        } catch (e) {
          error = e;
        }
        try {
          recorder.finish(signal.aborted ? "cancelled" : "failed");
        } catch {
          error ??= Error("cannot persist assistant usage");
        }
        if (error) {
          const cancelled = signal.aborted,
            description = cancelled
              ? timeout.aborted
                ? "assistant turn reached its time limit"
                : "request cancelled"
              : error instanceof Error
                ? error.message
                : "assistant turn failed";
          for (const call of pendingTools(value.messages)) {
            value.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ error: description }),
            });
            try {
              emit("tool.result", {
                call_id: call.id,
                tool: call.function.name,
                status: "error",
                value: { error: description },
              });
            } catch {}
          }
          try {
            emit(cancelled ? "turn.cancelled" : "turn.failed", {
              error: description,
            });
          } catch {}
        } else emit("turn.completed", {});
        if (!ctx.res.writableEnded) ctx.res.end();
      } finally {
        active.delete(sessionKey);
        controller.abort();
        release();
      }
    }, "cannot run assistant turn"),
  );
  return {
    start() {
      store.recover();
    },
    async close() {
      stopping = true;
      for (const running of active.values()) running.controller.abort();
      await Promise.all(
        [...active.values()]
          .map((r) => r.done)
          .concat(codeTasks ? [codeTasks.close()] : []),
      );
    },
  };
}

export * from "./types.js";
