# Provider management (API 源管理)

Codex Web 可以把多个 Codex provider（API 源）统一管理起来，并在任务级别切换：

- 每个 provider 有独立的 `base_url`、`wire_api`、API key / 官方 OAuth 标记和可选的模型目录文件。
- 每个模型有“是否可见”开关；聚合生成 `models_cache.json` 时**只写入已启用源中可见的模型**，隐藏模型不会进入任务模型菜单。
- 模型菜单直接展示“源 · 模型”，不需要单独的 provider 选择器。
- 运行时通过 Codex app-server 协议的 `modelProvider` 参数请求级切换，不修改 live 配置，也不隔离会话历史。

## 管理入口

侧栏左下角“个人设置 → API 源管理”。页面支持：

- 添加 / 编辑 / 删除源；
- 从 `config.toml` 导入现有 `[model_providers.*]` 段；
- 为每个源指定模型文件并从该文件导入模型；
- 按模型开关可见性、编辑模型 ID / 显示名 / 思考深度 / 输入模态 / 优先级；
- 整体启用或禁用源。

每次保存都会用 `smol-toml` 原子重写目标 Codex Home 的 `config.toml`，并全量重写 `models_cache.json`。未纳入管理的 provider 段会原样保留；纳入管理后，其配置段由数据库生成并合并 `name`、`base_url`、`wire_api`、`requires_openai_auth`、`experimental_bearer_token` 以及导入时保留的扩展字段。

## 模型文件

每个源可以指定一个 codex-home 内的 JSON 文件作为模型目录（如 `models.json`、`sssaicodeapi-models.json`）。该文件必须是 `{ "models": [...] }` 结构，条目字段与 Codex 目录一致。导入时：

- 只导入 `input_modalities` 含 `text` 的条目；
- 克隆模板条目的扩展字段（如 `context_window`）到聚合目录；
- 模型 slug 全局唯一：第一个使用上游模型名的保留原名，后续同名模型自动加源前缀别名（如 `proxy-gpt-5.6-sol`）。

别名条目在原生 Responses 源上会把别名原样发给上游，这类模型需要在页面上人工确认源是否接受别名，否则建议只保留一个同名模型。

## 初始化

页面导入即可完成大部分工作：在 API 源管理中点“从 config.toml 导入”，然后为每个源选择模型文件并点“从模型文件导入”。

如果运行服务的账号拥有数据库写权限，也可以一键初始化（以 root 运行，幂等）：

```bash
sudo node scripts/init-provider-sources.mjs \
  --models-file deepseek=models.json \
  --models-file sssaicodeapi=sssaicodeapi-models.json
```

脚本会读取每个映射用户的 `~/.codex/config.toml`，导入 provider 定义（含 `models_file` 键），按参数或 `<providerId>-models.json` 约定导入模型，最后生成聚合配置。

## 限制与边界

- 同一时间只允许一个启用中的官方 OAuth 源（`auth.json` 是全局单份）；其他官方账号可以改用 API key。
- `chat` / `anthropic` 协议已可录入，但尚未内置协议转换代理，任务会失败；当前只保证 `responses` 源端到端可用。
- 删除仍被会话或任务引用的源会被拒绝，请先禁用。
- 任务运行期间不会重写配置：运行中的进程使用启动时的快照，新任务读到最新聚合配置。
- 会话历史与 provider 无关：Codex 0.144+ 的线程按 `thread_id` 存储，切换 provider 后 resume 不会丢上下文。
