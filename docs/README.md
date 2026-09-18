# Documentation / 文档导航

[Product overview](../README.md) · [中文产品首页](../README.zh-CN.md)

The repository homepage introduces the product through its UI. This directory holds setup instructions, detailed behavior and implementation notes. The original READMEs are retained in the development guides.

仓库首页用于展示界面与产品流程；部署、完整功能说明和实现细节在这里按需查阅。原中英文 README 均保留在开发指南中。

## Start here / 从这里开始

| Document | 内容 / Scope |
| --- | --- |
| [Development guide](DEVELOPMENT.md) / [中文开发指南](DEVELOPMENT.zh-CN.md) | Original READMEs: quick start, detailed usage, architecture and development. |
| [Deployment](DEPLOYMENT.md) | Docker, host mode, authentication, storage and reverse proxy setup. |
| [Architecture](ARCHITECTURE.md) | Service layout, persistence and task execution. |
| [Security](SECURITY.md) | Account isolation, permissions and deployment boundaries. |
| [Offline upgrades](OFFLINE_UPGRADE.md) | Portable packages and upgrade procedures. |

## Feature guides / 功能说明

| Document | 内容 / Scope |
| --- | --- |
| [Repository workspace](GIT_REVIEW.md) | File browsing, diffs, previews and Git task confirmation. |
| [Side chats](SIDE_CHAT_DESIGN.md) | Independent threads, source references and task promotion. |
| [Automations](AUTOMATIONS.md) | Daily schedules, run history, catch-up and overlap rules. |
| [Web terminal](TERMINAL.md) | Interactive shell behavior and its separate security boundary. |
| [Provider management](PROVIDER_MANAGEMENT.md) | API sources, model selection and per-user configuration. |
| [Local voice input](LOCAL_VOICE.md) | Speech services, model setup and privacy limits. |
| [Android client](ANDROID.md) | Native preview setup, feature coverage and remaining gaps. |
| [Android releases](ANDROID_RELEASES.md) | Signing, publishing and release verification. |

## Maintenance / 维护资料

- [Public repository privacy](PUBLIC_PRIVACY.md) — publication checks and private deployment data.
- [Screenshot provenance](screenshots/README.md) — demo data, capture conditions and manual privacy review.
- [Chat Completions adapter design](CHAT_COMPLETIONS_ADAPTER_DESIGN.md) — compatibility design notes.
- [Android release records](../releases/android/) and [iteration plans](../tasks/) — version-specific changes and acceptance evidence.
