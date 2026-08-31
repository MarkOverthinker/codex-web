# Codex Web Chat Completions 协议适配设计

研究日期：2026-08-27  
适用基线：codex-web `main`，`@openai/codex-sdk` / Codex CLI `0.149.1`

## 结论

可以让只提供 OpenAI-compatible **Chat Completions**（`POST /v1/chat/completions`）的模型接入 Codex，但不能再把 `wire_api = "chat"` 直接交给当前 Codex。

推荐实现一个由 codex-web 管理的 **Responses Compatibility Adapter**：

```text
Codex app-server
  └─ POST /v1/responses
       └─ 任务级、租户 Worker 内的本地适配器
            └─ POST 上游 /v1/chat/completions
```

适配器对 Codex 始终表现为 Responses API，对上游则使用 Chat Completions，并双向转换请求、工具调用和 SSE 事件。

不建议恢复 Codex 已删除的 Chat Completions 客户端，也不建议通过降级 Codex 获得旧协议支持。外部 LiteLLM 一类网关可作为快速验证或高级部署选项，但不应作为默认硬依赖。

## 实现状态（2026-08-31）

当前已实现 provider 级 MVP，采用 `codex-relay 0.5.8` 作为 tenant worker 内的任务级 sidecar：

- `wire_api = "responses"` 的源继续按原路径直连，行为不变。
- `wire_api = "chat"` 的源保存在 codex-web 数据库和聚合模型目录中，但不再写入持久 `config.toml`。
- 任务开始时，worker 在 `127.0.0.1` 随机端口启动 relay，并通过 Codex app-server 的 `-c model_providers.<id>...` 参数注入临时 Responses provider。
- 上游 API key 只进入 relay 子进程环境；Codex 仅看到随机生成的本地 token。
- relay 历史保存在会话工作区的 `.runtime/codex-relay/<providerId>`，用于同一会话后续任务恢复 `previous_response_id`。
- Docker 镜像和 Linux x86_64 离线包均内置固定版本、固定 SHA256 的 relay 二进制；host mode 可通过 `CODEX_RELAY_PATH` 指向独立安装。

当前仍是 **provider 级协议选择**，尚未实现模型级覆盖、自动能力探测和 UI 中的 Agent-ready 探测状态。Chat 模型必须实际支持流式 Chat Completions 与结构化 `tool_calls`；不满足条件的模型可能在工具调用阶段失败。`anthropic` 仍明确拒绝执行，Legacy Completions `/v1/completions` 不在支持范围内。

## 先澄清“Completions”

需要区分两个完全不同的接口：

1. **Chat Completions**：`/v1/chat/completions`
   - 如果模型支持结构化 `tool_calls`，可以桥接为完整 Codex Agent。
   - 即使不支持原生 SSE，也可以先请求非流式结果，再合成为 Responses SSE；只是首字延迟和取消体验较差。
2. **Legacy Completions**：`/v1/completions`
   - 只有 prompt/text，没有标准的多轮消息、工具调用与工具结果回灌。
   - 不应标记为“Codex 可用”。通过提示词模拟工具调用会产生错误解析、误执行和安全边界不清等问题。
   - 如确有需求，应另做“纯文本助手模式”，不要接入现有 Codex Agent 执行链。

因此，本设计中的 `chat_completions` 专指 `/v1/chat/completions`。

## 当前实现与问题

### Codex 侧事实

- 当前项目依赖 Codex `0.149.1`。
- 该版本 `WireApi` 只剩 `Responses`；读取 `wire_api = "chat"` 会直接返回“不再支持”的配置错误。
- Codex 发出的请求不是简单文本请求，而是包含完整历史、工具定义、工具结果、推理参数、结构化输出参数和流式事件语义的 `/responses` 请求。
- Codex 在 `0.75.0` 仍有 Chat Completions 客户端，其请求映射和流解析代码可以作为行为参考，但当前版本已经新增 namespace/custom tools、消息 phase、更多输入类型和元数据，不能原样搬回。

### codex-web 侧事实

- `Provider.wireApi` 当前允许 `responses | chat | anthropic`。
- 原生 Responses provider 会写入用户 Codex Home 的 `config.toml`；Chat/Anthropic provider 只进入 codex-web 的模型目录，避免当前 Codex 拒绝旧 `wire_api` 值。
- Chat provider 由任务级 `codex-relay` 转换；Anthropic provider 仍只能录入，任务会明确失败。
- 当前协议配置是 provider 级；无法表达“同一 API 源中模型 A 支持 Responses、模型 B 只支持 Chat Completions”。

因此当前实现先保证 Chat provider 可用且不会污染持久 Codex 配置，模型级混合协议和 Anthropic 转换留待后续阶段。

## 目标与非目标

### 目标

- 原生 Responses provider 保持直连和现有行为。
- 支持 OpenAI-compatible Chat Completions 模型完成 Codex 的多轮工具调用闭环。
- 协议能力可按模型覆盖，而不是只能按 provider 设置。
- 保持 Web UID 与 tenant worker UID 分离，不能把任意上游 URL 的请求能力提升到 root/Web 进程。
- 支持取消、超时、错误分类、用量统计和安全脱敏。
- 用兼容性测试而不是“接口名看起来兼容”来决定模型能否启用。

### 非目标

- 不承诺把纯 `/v1/completions` 模型转换成完整 Agent。
- 第一阶段不模拟 Responses 的所有高级能力，例如服务端 Web Search、远程 compaction、加密 reasoning state。
- 第一阶段不承诺外部 Codex CLI 可直接使用 codex-web 的临时适配器；重点是 Web 任务链。
- 不修改或维护 Codex fork。

## 方案比较

| 方案 | 优点 | 主要问题 | 结论 |
| --- | --- | --- | --- |
| 要求所有上游原生支持 Responses | 语义最完整、维护最少 | 排除大量只提供 Chat Completions 的模型 | 保留为首选直连路径 |
| 降级或 fork Codex 恢复 `wire_api=chat` | 短期看似直接 | 已被上游移除；持续追赶 app-server、工具和事件协议；升级成本高 | 不采用 |
| 所有请求交给外部 LiteLLM 等网关 | 上线验证快、provider 覆盖广 | 增加 Python 服务和双重配置；Codex custom/namespace tools 仍需逐版本验证 | 作为可选外部网关模式 |
| codex-web 内置协议适配器 | 可精确控制 Codex 契约、UI、租户和错误呈现 | 需要维护转换器和兼容性测试 | 推荐 |

## 推荐架构

### 1. 任务级、Worker 内临时适配器

推荐把适配器启动在执行该任务的 tenant worker 中，而不是直接挂到 Web/Express 进程：

```text
Web process / DB
  │ 仅发送所选 provider + model 的运行时快照
  ▼
Tenant worker（目标用户 UID）
  ├─ 启动 127.0.0.1:随机端口 的 adapter
  ├─ 生成随机、单任务 bearer token
  └─ 启动 Codex app-server
       └─ model provider 运行时覆盖到 adapter /v1
            └─ adapter 请求真实上游 /chat/completions
```

选择这一位置的原因：

- host-mode 的主服务可以以 root 启动；如果由主进程代理用户填写的任意 `base_url`，会放大 SSRF 和网络权限风险。
- tenant worker 已经是任务级生命周期，取消或结束任务时可以同时终止上游请求和适配器。
- 每个适配器只持有一个任务所需的 provider/model 快照，不需要读取数据库，也不会跨租户路由。
- 适配器和 Codex 在同一 UID、同一网络边界内，符合现有隔离模型。

### 2. 通过 app-server 运行时配置注入 Provider

不要把 `chat` 写入 Codex 的持久 `config.toml`。对需要适配的任务，在 `thread/start` / `thread/resume` 的 `config` 覆盖中注入：

```toml
[model_providers.<selected-provider>]
name = "..."
base_url = "http://127.0.0.1:<ephemeral-port>/v1"
wire_api = "responses"
env_key = "CODEX_WEB_ADAPTER_TOKEN"
supports_websockets = false
```

同时只在 Codex 子进程环境中设置随机的 `CODEX_WEB_ADAPTER_TOKEN`。上游 API key 只存在于 worker/adapter 内存中，不放入命令行，不回传浏览器，不写日志。

实现前应增加一个小型集成测试，锁定 Codex `0.149.1` 对 `thread/start.config.model_providers` 嵌套覆盖的行为。如果嵌套覆盖不被接受，备用方案是使用 app-server 启动参数 `-c` 注入非敏感 provider 配置，并继续用环境变量传 token。

### 3. 原生 Responses 保持直连

运行时按所选模型计算：

```text
effectiveProtocol = model.protocolOverride ?? provider.upstreamProtocol
```

- `responses`：继续使用当前直连方式。
- `chat_completions`：启动内置 adapter。
- `anthropic_messages`：预留驱动接口，第二阶段实现。
- `legacy_completions`：拒绝作为 Codex Agent 启用。

这样同一 provider 下可以同时存在原生 Responses 模型和仅 Chat Completions 模型。

## 数据模型调整

不要继续把“上游协议”和“Codex wire protocol”混在 `wire_api` 字段中。Codex-facing wire protocol 已固定为 `responses`。

建议增加：

### `providers`

- `upstream_protocol`: `responses | chat_completions | anthropic_messages | legacy_completions`
- `adapter_policy`: `auto | disabled`
- `upstream_auth_type`: 第一阶段可只支持 `bearer`，后续扩展 `api_key_header` / `custom_headers`
- 保留 `base_url`、API key、扩展配置和启用状态

### `provider_models`

- `protocol_override`: nullable；为空时继承 provider
- `capabilities_json`: 经 Zod 校验的结构化能力快照
- `probe_status`: `unverified | compatible | limited | incompatible`
- `probe_message`
- `probed_at`

建议能力结构：

```json
{
  "toolCalls": true,
  "parallelToolCalls": false,
  "streaming": true,
  "vision": false,
  "structuredOutput": false,
  "developerRole": false,
  "reasoningField": null
}
```

迁移策略：

- 旧 `wire_api=responses` → `upstream_protocol=responses`。
- 旧 `wire_api=chat` → `upstream_protocol=chat_completions`。
- 旧 `wire_api=anthropic` → `upstream_protocol=anthropic_messages`，在对应驱动完成前标记 `unverified/disabled`。
- 生成给 Codex 的配置时绝不再输出 `wire_api=chat` 或 `wire_api=anthropic`。
- 旧字段先保留一个版本用于回滚和迁移，后续再删除。

## Responses → Chat Completions 请求转换

### 消息历史

| Responses 输入 | Chat Completions 输出 |
| --- | --- |
| `instructions` | 首条 `system` 消息 |
| `message(role=user)` | `user` 消息 |
| `message(role=developer)` | 支持时用 `developer`，否则合并进 `system` |
| `message(role=assistant)` | `assistant` 消息 |
| `function_call` | `assistant.tool_calls[]` |
| `function_call_output` | `tool` 消息，关联 `tool_call_id` |
| `reasoning` | 默认丢弃；只对明确支持的上游映射专有字段 |
| `input_image` | 上游模型通过探测后映射为 `image_url`，否则在请求前拒绝 |

相邻的多个 `function_call` 应合并成同一条 assistant 消息的多个 `tool_calls`，避免破坏并行调用语义。

### 工具定义

Codex 当前可能发送 `function`、`custom`、`namespace`、`tool_search`、`web_search` 等 Responses 工具：

- `function`：转换为标准 Chat Completions `{type:"function", function:{...}}`。
- `custom`：包装成一个参数为 `{input:string}` 的函数；模型返回后再还原成 `custom_tool_call`。
- `namespace`：扁平化为带稳定编码名称的函数，例如 `namespace__tool`；输出时恢复 namespace/name。
- `tool_search`：第一阶段禁用，避免动态工具发现语义不一致。
- `web_search`：第一阶段禁用；这属于上游托管工具，不应伪装为 Chat Completions 能力。

工具名编码必须可逆、限制长度并检测碰撞。请求生命周期内保存映射表，不把用户可控名称直接用于内部路由。

### 参数映射

- `stream=true` → 上游优先使用流式 Chat Completions。
- `parallel_tool_calls` → 仅在探测确认支持时传递。
- `text.format` → 在上游支持时转换为 `response_format`；否则由 codex-web 禁用本轮结构化输出要求。
- `reasoning`、`text.verbosity`、`include`、`prompt_cache_key`、`store` → 默认不传；只有明确的 provider profile 才映射专有参数。
- 不把未知 Responses 字段盲目透传给 Chat endpoint，因为许多兼容服务会对未知参数返回 400。

## Chat Completions → Responses SSE 转换

Codex `0.149.1` 能工作的最小事件序列为：

1. `response.created`
2. 零个或多个 `response.output_text.delta`
3. 一个或多个 `response.output_item.done`
4. `response.completed`

转换规则：

- 文本 delta：立即转成 `response.output_text.delta`，同时在 adapter 内累积最终文本。
- 正常结束：发送一个 assistant message 的 `response.output_item.done`，再发送 `response.completed`。
- 工具调用：按 `choice + tool index + call id` 累积碎片化的 name/arguments；结束时发送 `function_call` 或还原后的 `custom_tool_call`。
- 多工具调用：逐个发送 `response.output_item.done`，保留各自 `call_id`。
- usage：把 `prompt_tokens/completion_tokens/total_tokens` 映射为 Responses usage；缺失时允许为空或置零，但必须完成事件。
- `finish_reason=length`：映射为 `response.failed`，错误码使用 Codex 可识别的 context-window 类别。
- 上游在首字节前失败：保留 HTTP 状态与可脱敏错误体。
- 已经开始下游 SSE 后失败：发送 `response.failed`，随后关闭流。
- 下游取消或断开：立即 abort 上游 fetch，不再重试。

若上游完全不支持流式返回，可以在模型能力中显式设置 `streaming=false`：adapter 使用非流式请求，完成后一次性合成上述 SSE。不要自动猜测并反复重试两种模式，以免重复计费。

## Codex 模型目录兼容配置

不能把原生 GPT Responses 模型模板直接套给 Chat 模型，否则 Codex 可能发送上游无法表达的 freeform、namespace、reasoning 或 Web Search 能力。

为适配模型增加 compatibility overlay：

- `shell_type = "default"`，优先使用标准函数工具。
- `apply_patch_tool_type = null`；若 adapter 已验证 custom-tool wrapper，再允许 freeform。
- `supports_parallel_tool_calls` 按探测结果设置。
- `supports_reasoning_summary_parameter = false`，除非 provider profile 明确支持。
- `support_verbosity = false`。
- `supports_search_tool = false`。
- `use_responses_lite = false`。
- `input_modalities` 按探测结果限制，默认仅 `text`。
- 非 reasoning 模型只暴露 `none` effort；adapter 丢弃 Responses 的 reasoning 参数。

模型模板覆盖应发生在 `buildCatalogEntry` 阶段，而不是在 HTTP adapter 中临时猜测；这样 Codex 从源头就不会生成不支持的工具和参数。

## 能力探测与 UI

“接口返回 200”不足以证明可以运行 Codex。建议增加显式的“测试兼容性”操作，并保存到模型级：

1. 鉴权与模型存在性。
2. 普通文本请求。
3. 流式文本；若失败，测试非流式降级。
4. 单工具调用及参数 JSON。
5. 工具结果回灌后的最终回答。
6. 可选：并行工具、图片、结构化输出、reasoning 字段。

UI 状态：

- `原生 Responses`：完整直连。
- `Chat 适配 · Agent 可用`：工具闭环通过。
- `Chat 适配 · 有限`：只通过文本，禁止进入 Codex 模型菜单。
- `未验证`：默认不自动启用，允许用户手动测试。
- `不兼容`：显示失败阶段和脱敏错误。

源编辑器应把当前“协议”字段改名为“上游 API 协议”，并明确显示“Codex 侧固定使用 Responses”。

## 安全边界

- 适配器运行在 tenant worker，不运行在 host-mode 的 root Web 进程。
- 只监听 `127.0.0.1` 随机端口，使用每任务随机 bearer token。
- 上游 URL、模型名和认证信息来自服务端选择快照，不能由模型请求体覆盖。
- 禁止或逐跳校验 HTTP redirect，防止重定向到本机、云 metadata 或其他内部地址。
- 默认只允许 HTTPS；访问局域网或 HTTP endpoint 必须由管理员显式允许。
- 丢弃客户端传入的 `Authorization`、`Host`、转发头和不在白名单内的自定义头。
- 限制请求体、单个 SSE event、累计输出、工具参数和错误体大小。
- 日志只记录 provider ID、model ID、状态、耗时、token 数和错误类别；不记录 API key、Authorization 或完整 prompt。
- adapter 进程退出时清理 token 和内存状态；取消任务时同步 abort 上游连接。

## 建议模块边界

```text
server/provider-adapter/
  protocol.ts                 # Zod 请求/响应边界
  responses-to-chat.ts        # 历史、参数和工具定义转换
  chat-stream-to-responses.ts # SSE/非流式结果转换
  tool-name-map.ts            # custom/namespace 可逆映射
  upstream-client.ts          # URL、认证、超时、取消和错误处理
  server.ts                   # 127.0.0.1 临时 HTTP 服务
  capability-probe.ts         # 显式兼容性测试
```

需要修改的现有模块：

- `server/db.ts`：协议与模型能力字段、迁移。
- `server/provider-manager.ts`：配置生成、compatibility overlay、旧字段迁移。
- `server/model-options.ts`：过滤未达到 Agent-ready 的模型。
- `server/codex-runner.ts`：构造所选 provider/model 的运行时快照。
- `server/tenant-worker-protocol.ts`：传递最小必要的 adapter 配置。
- `server/tenant-worker-execution.ts`：管理 adapter 生命周期。
- `server/app-server-turn.ts`：注入任务级 provider 配置与 token 环境变量。
- `server/app.ts`、`src/api.ts`、`src/provider-manager-dialog.tsx`：新字段、探测接口和状态展示。

## 分阶段实施

### P0：先消除当前错误配置

- 停止向 Codex `config.toml` 写入 `wire_api=chat/anthropic`。
- 在 adapter 未完成前，相关模型不进入可选列表，并显示“协议适配尚未启用”。
- 对已有记录做启动迁移，避免一个旧 provider 使整个 Codex 配置无法解析。

### P1：Chat Completions MVP

- 任务级 worker-local adapter。
- 文本、标准 function tools、工具结果、流式/非流式、取消、usage、错误映射。
- compatibility-safe 模型模板。
- 手动能力测试和 `Agent 可用` 门槛。

### P2：完善兼容性

- custom/freeform tool wrapper。
- namespace tool flattening。
- 图片输入、并行工具、structured output 的能力化支持。
- provider profile，用于少量常见非标准字段映射。

### P3：扩展协议

- 按同一驱动接口实现 Anthropic Messages → Responses。
- 可选持久 adapter daemon，使宿主上的独立 Codex CLI 也能使用被管理的适配源。
- 可选支持外部 Responses gateway；codex-web 只负责健康检查和配置。

## 测试与验收

必须覆盖以下场景：

1. 原生 Responses provider 行为完全不变。
2. Chat 流式文本正确显示，且只产生一个最终 assistant item。
3. shell/function 调用 → 执行 → tool result → 最终回答的完整闭环。
4. 工具 name/arguments 被拆成多个 chunk 时仍正确重组。
5. 多工具调用顺序与 `call_id` 保持稳定。
6. custom/namespace 名称编码可逆且无碰撞。
7. 不支持图片、structured output、parallel tools 时在请求前给出明确错误或自动禁用。
8. `finish_reason=length`、401、429、5xx 和中途断流得到正确分类。
9. 浏览器取消、任务取消和 worker 退出都会终止上游请求。
10. 两个 Web 用户即使 provider ID 相同，也不能互用凭据或 adapter token。
11. provider 切换后恢复同一 Codex thread，历史中的 tool call/output 仍能转换。
12. 日志和错误响应中不存在 API key、Authorization 或完整 prompt。

测试 fixture 可参考 Codex `0.75.0` 已删除的 Chat 请求/SSE 测试，但应针对 `0.149.1` 的当前 Responses 请求与 `ResponseItem` 类型重新建立契约测试，不应直接依赖旧实现。

## 对外部网关的定位

LiteLLM 已提供 Responses API 与 Chat Completions 之间的桥接能力，适合快速 POC 或已有 LiteLLM 基础设施的部署。但不建议作为默认内置依赖：

- 会增加独立 Python 服务、配置和升级面。
- Codex 的 custom/namespace tools、Responses SSE 细节和模型目录能力仍需由本项目做端到端验证。
- 上游项目仍存在与 Responses bridge 参数、流式 tool calls 相关的兼容问题，不能只凭“支持 `/responses`”判断为 Codex-ready。

因此产品层应支持两种方式：

- **内置适配**：默认，面向 OpenAI-compatible Chat Completions。
- **外部 Responses 网关**：高级选项，用户提供已经兼容的 `/responses` 地址，codex-web 按原生 Responses provider 管理。

## 最终决策

1. Codex-facing 协议保持且只保持 Responses。
2. 新增“上游协议”，协议选择下沉到模型级覆盖。
3. Chat Completions 通过 tenant worker 内的任务级 adapter 转换。
4. 只有通过工具闭环探测的模型才进入 Codex 模型菜单。
5. Legacy Completions 不接入 Agent；避免用提示词模拟工具协议。
6. 先完成 P0 和 P1，再扩展 custom tools、Anthropic 和持久 daemon。

## 参考资料

- OpenAI Codex 配置参考：<https://developers.openai.com/codex/config-reference>
- Codex Chat Completions 弃用公告：<https://github.com/openai/codex/discussions/7782>
- Codex `0.149.1` 当前 `WireApi`：<https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/model-provider-info/src/lib.rs>
- Codex `0.149.1` Responses 请求结构：<https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/codex-api/src/common.rs>
- Codex `0.149.1` Responses SSE 解析：<https://github.com/openai/codex/blob/rust-v0.149.1/codex-rs/codex-api/src/sse/responses.rs>
- Codex `0.75.0` 历史 Chat 请求映射：<https://github.com/openai/codex/blob/rust-v0.75.0/codex-rs/codex-api/src/requests/chat.rs>
- Codex `0.75.0` 历史 Chat SSE 解析：<https://github.com/openai/codex/blob/rust-v0.75.0/codex-rs/codex-api/src/sse/chat.rs>
- LiteLLM Responses API 文档：<https://docs.litellm.ai/docs/response_api>
