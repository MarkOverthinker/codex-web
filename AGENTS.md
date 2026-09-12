# Repository guidance

- Keep the public edition free of credentials, private hosts, personal account IDs, and production-only deployment details.
- Preserve server-side persistence for queued prompts, attachments, messages, events, and Codex threads.
- Maintain the separation between the web UID and the tenant worker UID.
- Run `npm test` before submitting changes.
- In host-mode deployments with `codex-web-reloader` installed, run `npm run reload` after finishing code changes so the root service rebuilds and restarts `codex-web.service`.
- Android version releases must also update the maintained download page using `scripts/publish-android.mjs`: verify the persistent signing certificate, publish immutable versioned APKs/checksums and release notes, verify the served page and downloaded APK, and retain historical versions. Follow `docs/ANDROID_RELEASES.md`; an APK attachment alone is not a completed release.

## Android iteration ownership

- Before each Android iteration, write its update plan, PRD and verifiable QA checklist. The coordinating agent owns scope, planning, code review and final acceptance.
- Delegate implementation and independent QA to subagents with explicit, non-overlapping write scopes. Return failed acceptance items to the responsible subagent; do not treat compilation or self-reported completion as acceptance.
- Record actual test evidence and remaining limitations per iteration, and distinguish internal milestones, signed candidates and publicly published releases. See `tasks/prd-android-05.md` for the initial workflow.
