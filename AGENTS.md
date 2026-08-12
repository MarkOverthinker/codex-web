# Repository guidance

- Keep the public edition free of credentials, private hosts, personal account IDs, and production-only deployment details.
- Preserve server-side persistence for queued prompts, attachments, messages, events, and Codex threads.
- Maintain the separation between the web UID and the tenant worker UID.
- Run `npm test` before submitting changes.
- In host-mode deployments with `codex-web-reloader` installed, run `npm run reload` after finishing code changes so the root service rebuilds and restarts `codex-web.service`.
