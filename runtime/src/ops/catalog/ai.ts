import {
  compose,
  define,
  health,
  password,
  port,
  secret,
  volume,
} from "./types.js";
export const ai = [
  define(
    {
      id: "ollama",
      name: "Ollama",
      description: "本地模型运行服务，默认 CPU 模式。",
      description_en: "Local model server using CPU mode by default.",
      category: "ai",
      version: "0.40.13",
      homepage: "https://docs.ollama.com/docker",
      resources: { cpu: 2, memory_mb: 4096 },
      notes:
        "安装不下载模型；请在应用中拉取模型。API 默认仅本机访问，不包含认证；GPU 推理可使用 vLLM 模板。",
      notes_en:
        "Models are not downloaded during installation. Pull models after startup. The unauthenticated API binds to localhost by default. Use the vLLM recipe for GPU inference.",
      parameters: [],
    },
    () =>
      compose(
        {
          ollama: {
            image: "ollama/ollama:0.40.13",
            volumes: [volume("ollama-data", "/root/.ollama")],
            healthcheck: health(["CMD", "ollama", "list"]),
          },
        },
        [{ ...port("http", 11434, "ollama", "http"), host_ip: "127.0.0.1" }],
      ),
  ),
  define(
    {
      id: "openwebui",
      name: "Open WebUI",
      description: "多模型对话界面，可连接 Ollama 或兼容 API。",
      description_en:
        "Multi-model chat interface for Ollama and compatible APIs.",
      category: "ai",
      version: "v0.12.5",
      homepage: "https://docs.openwebui.com/getting-started/quick-start/",
      resources: { cpu: 1, memory_mb: 2048 },
      notes:
        "首次注册的用户成为管理员。请先配置访问入口并完成管理员注册，再开放访问；模型服务在应用内配置。",
      notes_en:
        "The first registered user becomes the administrator. Complete registration before opening public access, then configure model providers inside the application.",
      parameters: [],
    },
    (_p, c) =>
      compose(
        {
          openwebui: {
            image: "ghcr.io/open-webui/open-webui:v0.12.5",
            environment: {
              WEBUI_SECRET_KEY: secret(c),
              WEBUI_AUTH: "true",
              ENABLE_SIGNUP: "true",
            },
            volumes: [volume("openwebui-data", "/app/backend/data")],
          },
        },
        [port("http", 8080, "openwebui", "http")],
      ),
  ),
  define(
    {
      id: "maxkb",
      name: "MaxKB",
      description: "知识库问答与 AI 智能体平台。",
      description_en: "Knowledge-base chat and AI agent platform.",
      category: "ai",
      version: "v2.10.8-lts",
      homepage: "https://github.com/1Panel-dev/MaxKB",
      resources: { cpu: 2, memory_mb: 4096 },
      notes:
        "上游预置管理员为 admin；初始密码见官方文档，登录后立即修改；模型与知识库在应用内配置。持久数据包含数据库和本地文件。",
      notes_en:
        "The upstream administrator is admin. Find the initial password in the official documentation and change it after login. Configure models and knowledge bases in MaxKB. Persistent storage includes its database and local files.",
      parameters: [],
    },
    () =>
      compose(
        {
          maxkb: {
            image: "1panel/maxkb:v2.10.8-lts",
            volumes: [volume("maxkb-data", "/opt/maxkb")],
          },
        },
        [port("http", 8080, "maxkb", "http")],
      ),
  ),
  define(
    {
      id: "anythingllm",
      name: "AnythingLLM",
      description: "自托管知识库、文档检索和模型对话。",
      description_en:
        "Self-hosted document retrieval, knowledge bases and model chat.",
      category: "ai",
      version: "1.19.0",
      homepage: "https://docs.anythingllm.com/installation-docker/overview",
      resources: { cpu: 2, memory_mb: 2048 },
      notes:
        "首次打开完成工作区与账号设置。模型和嵌入服务在应用内配置；本地文档与向量数据保存在独立卷。",
      notes_en:
        "Complete account and workspace setup on first visit. Configure chat and embedding providers inside the app. Documents and vectors use isolated storage.",
      parameters: [],
    },
    (_p, c) =>
      compose(
        {
          anythingllm: {
            image: "mintplexlabs/anythingllm:1.19.0",
            environment: {
              STORAGE_DIR: "/app/server/storage",
              JWT_SECRET: secret(c),
              SIG_KEY: secret(c),
              SIG_SALT: secret(c, 16),
            },
            volumes: [volume("anythingllm-data", "/app/server/storage")],
          },
        },
        [port("http", 3001, "anythingllm", "http")],
      ),
  ),
  define(
    {
      id: "vllm",
      name: "vLLM",
      description: "GPU 模型推理服务，提供兼容 OpenAI 的 API。",
      description_en: "GPU model inference with an OpenAI-compatible API.",
      category: "ai",
      version: "v0.32.0",
      homepage: "https://docs.vllm.ai/en/latest/deployment/docker/",
      resources: { cpu: 4, memory_mb: 8192 },
      deployment_modes: ["manual"],
      notes:
        "需要 NVIDIA GPU、驱动和 NVIDIA Container Toolkit；显存必须容纳所选模型。首次启动需下载模型；受限模型需提供 Hugging Face Token。",
      notes_en:
        "Requires an NVIDIA GPU, drivers and NVIDIA Container Toolkit with enough VRAM for the model. First startup downloads the model; gated models require a Hugging Face token.",
      parameters: [
        password("API Key", "API key"),
        {
          key: "model",
          label: "模型标识",
          label_en: "Model ID",
          type: "string",
          default: "Qwen/Qwen2.5-0.5B-Instruct",
          required: true,
          pattern:
            "^[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)?$",
          max: 256,
        },
        {
          key: "hf_token",
          label: "Hugging Face Token（可选）",
          label_en: "Hugging Face token (optional)",
          type: "password",
          max: 512,
        },
        {
          key: "gpu_memory_utilization",
          label: "显存使用比例",
          label_en: "GPU memory utilization",
          type: "select",
          default: "0.9",
          options: [
            { value: "0.7", label: "70%" },
            { value: "0.8", label: "80%" },
            { value: "0.9", label: "90%" },
          ],
        },
      ],
    },
    (p) =>
      compose(
        {
          vllm: {
            image: "vllm/vllm-openai:v0.32.0",
            environment: { VLLM_API_KEY: p.password, HF_TOKEN: p.hf_token },
            command: [
              p.model,
              "--host",
              "0.0.0.0",
              "--port",
              "8000",
              "--gpu-memory-utilization",
              p.gpu_memory_utilization,
            ],
            shm_size: "1g",
            deploy: {
              resources: {
                reservations: {
                  devices: [
                    { driver: "nvidia", count: 1, capabilities: ["gpu"] },
                  ],
                },
              },
            },
            volumes: [volume("huggingface-cache", "/root/.cache/huggingface")],
            healthcheck: health(
              [
                "CMD-SHELL",
                "python3 -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')\"",
              ],
              "120s",
            ),
          },
        },
        [port("http", 8000, "vllm", "http")],
      ),
  ),
];
export const dbx = define(
  {
    id: "dbx",
    name: "DBX",
    description: "统一数据库工作台，支持关系型数据库、Redis、MongoDB 等。",
    description_en:
      "Unified database workbench for relational databases, Redis, MongoDB and more.",
    category: "tools",
    version: "0.6.62",
    homepage: "https://dbxio.com/en/docs/getting-started",
    resources: { cpu: 0.5, memory_mb: 512 },
    notes:
      "使用安装时设置的访问密码登录；数据库连接在 DBX 内自行配置。连接、驱动与工作区数据独立保存。",
    notes_en:
      "Sign in with the configured access password and add connections inside DBX. Connections, drivers and workspace data are persisted independently.",
    parameters: [password()],
  },
  (p) =>
    compose(
      {
        dbx: {
          image: "t8y2/dbx:0.6.62",
          environment: { DBX_PASSWORD: p.password, DBX_DATA_DIR: "/app/data" },
          volumes: [volume("dbx-data", "/app/data")],
        },
      },
      [port("http", 4224, "dbx", "http")],
    ),
);
