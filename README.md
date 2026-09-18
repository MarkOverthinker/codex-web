# Codex Web

**A self-hosted workspace for working with Codex in your browser.**

Turn a request into a task, follow the conversation, review code changes, and collect the results — on desktop or mobile.

[中文](README.zh-CN.md) · [Get started](docs/DEVELOPMENT.md#quick-start) · [Documentation](docs/README.md)

![Codex Web desktop: project tasks on the left, conversation and deliverables in the center, and task controls in the composer.](docs/screenshots/desktop.png)

*Real application UI with fictional demo data. Screenshots use the Chinese interface; no live account or conversation data is shown.*

## From request to result

1. **Choose a project.** Open a task in its working directory, describe what you need, and attach any relevant files.
2. **Work with Codex.** Follow progress, queue the next instruction, steer the current task, or explore a question in a separate side chat.
3. **Review and continue.** Inspect the diff, preview or download deliverables, and return to the same conversation later.

Conversations, drafts, attachments and queued work live on the server, not in a browser tab. Closing the page does not discard them.

## One workspace, fewer interruptions

| What you want to do | What the UI provides |
| --- | --- |
| Keep projects organized | Tasks grouped by working directory, search, history import and archives. |
| Keep work moving | Persistent task queues, live steering and daily automations with run history. |
| Explore without losing your place | Independent side chats with references back to the main conversation. |
| Check what changed | A file tree, highlighted diffs, Markdown/source previews and confirmation before requesting a commit or push. |
| Use the results | In-page file previews, downloadable outputs and a built-in terminal. |

## Review code beside the conversation

Open the repository workspace without leaving the task. Browse files and compare working-tree, staged or branch changes alongside Codex's explanation.

![Repository workspace: conversation beside a syntax-highlighted diff, change counts and a filterable file tree.](docs/screenshots/review.png)

## Continue on your phone

The mobile web layout keeps the conversation and composer in focus, with task navigation and tools available when needed. Light, dark and system themes are available.

<img src="docs/screenshots/mobile.png" alt="Mobile web conversation in dark mode, with task navigation, file access and a compact composer." width="320">

A separate native Android client is available as a **preview**, not a feature-equivalent replacement for the web UI. See [Android setup and limitations](docs/ANDROID.md).

## Run it yourself

- **Docker:** follow the [quick start](docs/DEVELOPMENT.md#quick-start) for configuration, persistent storage and Codex sign-in.
- **Host deployment:** see [deployment options](docs/DEPLOYMENT.md) and the [security model](docs/SECURITY.md) before exposing the service.

The web workspace requires a server-side Codex runtime and its authentication; it is not a hosted AI service.

## Documentation

The previous, detailed README is preserved in the development guides rather than removed.

- [Development guide — original README](docs/DEVELOPMENT.md) · [中文开发指南](docs/DEVELOPMENT.zh-CN.md)
- [All documentation](docs/README.md) — deployment, architecture and feature guides
- [Security](docs/SECURITY.md) · [Public repository privacy](docs/PUBLIC_PRIVACY.md) · [License](LICENSE)

---

Codex Web is an independent community project for the OpenAI Codex CLI. It is not affiliated with, endorsed by, or supported by OpenAI.
