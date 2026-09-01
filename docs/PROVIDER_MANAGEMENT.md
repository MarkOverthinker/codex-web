# Provider management (API 源管理)

## 默认行为

API 源管理按 Web 用户独立保存，默认关闭。关闭时，codex-web 不读取数据库中的 provider 记录，也不会写入或生成 `~/.codex/config.toml`、`models_cache.json`；模型菜单直接读取该用户 Codex Home 中由用户自行维护的 `models_cache.json` 或 `models.json`，任务执行沿用用户自己的 `config.toml`。

在个人设置中打开“API 源管理”后，才会启用本文后续的数据库源、模型目录和配置生成流程。关闭管理不会删除数据库记录或改写现有文件；再次打开时，已有管理记录可能重新生成受管理的配置，请确认记录内容与本地文件一致。

升级兼容：在引入按用户管理开关之前已经存在 Provider 记录的用户，启动迁移会自动补写 `provider_management_enabled=true`，以保留旧版的受管理行为；已经明确保存为 `false` 的用户不会被重新打开。

Codex Web 可以把多个 Codex provider（API 源）统一管理起来，并在任务级别切换：

- 每个 Web 用户拥有独立的 provider 与模型集合；不同用户可以使用相同 provider ID，但 `base_url`、API key、启用状态和模型目录互不影响。
- 每个 provider 有独立的 `base_url`、`wire_api`、API key / 官方 OAuth 标记、自动审核模型覆盖（`auto_review_model_override`）和可选的模型目录文件。
- 每个模型有“是否可见”开关；聚合生成 `models_cache.json` 时**只写入已启用源中可见的模型**，隐藏模型不会进入任务模型菜单。
- 模型菜单直接展示“源 · 模型”，不需要单独的 provider 选择器。
- 运行时通过 Codex app-server 协议的 `modelProvider` 参数请求级切换，不修改 live 配置，也不隔离会话历史。

## 管理入口

侧栏左下角“个人设置 → API 源管理”。页面支持：

- 添加 / 编辑 / 删除源；
- 从 `config.toml` 导入现有 `[model_providers.*]` 段；
- 为每个源指定模型文件并从该文件导入模型；
- 为每个源设置自动审核模型覆盖（`auto_review_model_override`，留空表示不覆盖）；
- 按模型开关可见性、编辑模型 ID / 显示名 / 思考深度 / 输入模态 / 优先级；
- 整体启用或禁用源。

每次保存只读取当前登录用户的 provider 数据，用 `smol-toml` 原子重写该用户 Codex Home 的 `config.toml`，并全量重写该用户的 `models_cache.json`。未纳入管理的 provider 段会原样保留；纳入管理的原生 Responses 源由数据库生成并合并 `name`、`base_url`、`wire_api`、`requires_openai_auth`、`experimental_bearer_token`、`auto_review_model_override` 以及导入时保留的扩展字段。Chat/Anthropic 源不会写入持久 Codex 配置，避免当前 Codex 拒绝旧协议值；它们的可见模型仍会进入聚合目录，由任务运行时决定是否注入适配器。API 的查询、修改、删除和引用检查都带当前 Web 用户 ID，不能访问其他用户的源或模型。

从旧版全局 provider 表升级时，数据库会把已有记录复制到升级时已存在的每个 Web 用户名下，再转为用户级复合主键。旧数据无法可靠判断最初由哪个用户创建，因此迁移优先保持各用户升级前可用的配置；迁移完成后，每份记录独立演进，新建用户不会继承这些源。

生成 `models_cache.json` 时，codex-web 只使用仓库内置的完整模板库，不再把用户 `~/.codex/models_cache.json` 当作模板。模板库包含标准 fallback、当前 Codex 内置模型模板和 DeepSeek 模型模板；先按上游 `model_id` 精确匹配，再按最长前缀匹配，未知模型才使用标准 fallback。数据库字段只覆盖 slug、显示信息、优先级、输入模态和思考深度；每个 `supported_reasoning_levels` 子项也会补齐 `effort` 和 `description`。这样即使用户缓存来自旧版 Codex 或字段不全，生成目录也不会因 `shell_type` 等字段缺失而解析失败。host 模式下，写入宿主用户 `~/.codex` 的目录和两个文件会自动修复为宿主用户可访问的权限（目录 0700、`config.toml` 0600、`models_cache.json` 0644），任务降权运行后仍可读写；启动修复和初始化脚本都会执行同样的属主处理。

源级 `auto_review_model_override` 会写入该源下所有可见模型的目录条目，使该源上的自动审批审查使用指定模型；留空时保留每个模型模板自带的默认值（通常为 `null`，即 Codex 默认行为），因此不会因为某个源不支持默认审核模型而无法工作。

## 模型文件

每个源可以指定一个 codex-home 内的 JSON 文件作为模型目录（如 `models.json`、`sssaicodeapi-models.json`）。该文件必须是 `{ "models": [...] }` 结构，条目字段与 Codex 目录一致。导入时：

- 只导入 `input_modalities` 含 `text` 的条目；
- 克隆模板条目的扩展字段（如 `context_window`）到聚合目录；
- 模型 slug 在当前用户的聚合目录内唯一：第一个使用上游模型名的保留原名，后续同名模型自动加源前缀别名（如 `proxy-gpt-5.6-sol`）。

前端和数据库保存当前用户目录内唯一的别名；真正启动任务时，服务端会按所选源把别名反解为原始 `model_id` 再传给上游。例如选择 `sssaicodeapi-gpt-5.4-mini` 时，上游收到的是 `gpt-5.4-mini`。

## 用量与计费统计

电脑版顶栏的“API 计费统计”会在每个 Codex turn 完成后持久化 SDK/app-server 上报的输入、缓存输入、缓存写入、输出与推理输出 token。面板按用户隔离，支持按 API 源和模型汇总；缓存命中率按 `cached_input_tokens / input_tokens` 计算。

费率规则以每 1,000,000 tokens 为单位，分别设置 input、cached input、cache write 和 output 的单价与三位货币代码。费用为估算值；没有规则的调用不会计入费用。内置 Codex 源使用 `Codex 内置源` 单独归类，外部源使用实际 provider 与上游模型 ID，避免别名影响定价。

打开计费面板时会自动为所有已启用源尝试同步计费标准；手工点击“同步”时也可填写 JSON URL。未输入时依次尝试源域名下的 `/api/pricing`、`/api/prices` 和该源 base URL 下的 `/pricing`。接口必须返回可识别的 JSON 模型条目，至少包含 model、input 和 output 的每百万 token 单价；无法识别时不会覆盖现有规则。不同 New API 部署的接口并不统一，因此必要时应填写其实际计费 JSON 地址。

## 刷新内置模板库

升级 Codex CLI 后，如其模型 schema 或内置模型发生变化，应使用 `scripts/update-model-catalog-templates.mjs` 重新生成 `server/model-catalog-templates.json`。脚本读取一个 TOML 配置文件，配置 `codex_version`、Codex 源码中的 `models.json` / `prompt.md`、一个或多个 DeepSeek 模型目录以及输出路径；生成后必须运行 `npm test`，确认新模板可被当前 CLI 解析。

## 初始化

页面导入即可完成大部分工作：在 API 源管理中点“从 config.toml 导入”，然后为每个源选择模型文件并点“从模型文件导入”。

显式运行 `scripts/init-provider-sources.mjs` 也表示用户选择启用 API 源管理；脚本会为导入到 provider 的用户打开该开关。仅启动 codex-web 不会因为数据库中残留旧 provider 记录而自动接管配置。

如果运行服务的账号拥有数据库写权限，也可以一键初始化（以 root 运行，幂等）：

```bash
sudo node scripts/init-provider-sources.mjs \
  --models-file deepseek=models.json \
  --models-file sssaicodeapi=sssaicodeapi-models.json
```

脚本会逐个读取映射用户的 `~/.codex/config.toml`，把 provider 定义（含 `models_file` 键）导入该 Web 用户自己的数据库范围，按参数或 `<providerId>-models.json` 约定导入模型，最后生成各自的聚合配置，并把生成文件的属主归还给对应宿主用户。脚本必须在构建后的 `dist-server` 上运行；代码更新后先运行 `npm run build`，再运行脚本和 `npm run reload`。

如果之前曾用 root 或 `chmod 777` 处理过权限，可直接以仓库属主的普通用户运行一键修复脚本。脚本会按需调用 `sudo` 修复精确的 Codex 文件、修复旧构建产物、构建服务端、导入两个默认模型文件并 reload 服务：

```bash
./scripts/repair-host-provider-sources.sh
```

脚本不递归修改整个主目录，也不应使用 `sudo` 直接启动；如模型文件名不同，可把 `--models-file providerId=fileName` 参数传给脚本。

## 限制与边界

- 每个用户同一时间只允许一个启用中的官方 OAuth 源（该用户 Codex Home 内的 `auth.json` 只有一份）；其他官方账号可以改用 API key。
- 当前 Codex 只接受 Responses。选择 `chat` 时，tenant worker 会按任务启动内置 `codex-relay`，把 Codex 的 `/responses` 请求转换到上游 `/chat/completions`；该源不能使用官方 OAuth，可配置上游 API key，也可连接明确允许无鉴权的本地端点。
- Chat 模型必须正确支持流式响应和结构化 `tool_calls`。当前没有自动能力探测，也没有模型级协议覆盖；同一 provider 内不要混合 Responses-only 与 Chat-only 模型。
- `anthropic` 适配尚未实现，选中后任务会明确拒绝执行。Legacy `/v1/completions` 不具备完整 Agent 工具协议，不支持接入。
- 删除仍被会话或任务引用的源会被拒绝，请先禁用。
- 任务运行期间不会重写配置：运行中的进程使用启动时的快照，新任务读到最新聚合配置。
- 会话历史与 provider 无关：Codex 0.144+ 的线程按 `thread_id` 存储，切换 provider 后 resume 不会丢上下文。
