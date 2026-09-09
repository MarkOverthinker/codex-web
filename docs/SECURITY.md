# Security

- Keep `.env` private and use a unique password plus a random session secret.
- Changing a password from the account settings requires the current password
  and immediately revokes the user's other sessions. Usernames can only be
  changed outside host mode, where they are not bound to a system account.
- Bind the application to loopback and expose it only through an HTTPS reverse proxy.
- Codex can execute code and modify files inside its selected workspace and tenant library. Only upload files you trust and review generated changes.
- Codex Web runs tasks with `workspace-write`, `approval_policy = "on-request"`, and automatic approval review. The reviewer only evaluates actions that already require approval; sandbox-contained actions run directly. Requests that still reach the web client for manual approval are denied rather than accepted or left pending.
- If the operator sets `ALLOW_DANGER_FULL_ACCESS=true`, every web user can
  select Codex's `danger-full-access` per conversation. That mode disables
  sandboxing and approval review entirely: the agent can execute arbitrary
  commands and read/write anything the tenant user can, including (in host
  mode) the user's home directory and `~/.codex`. Only enable it when every
  account and every task prompt is fully trusted.
- Custom host working directories are accepted only in host mode and never
  point at Codex Web's own data, tenant, or workspace roots; the worker
  revalidates the absolute path and the tenant system user's access before
  starting.
- Code preview reads are scoped to the signed-in user's conversation
  workspace, registered deliverables, tenant library, and (in host mode) the
  conversation's selected working directory; path traversal and arbitrary
  host paths are rejected.
- The right-side file explorer uses the same conversation ownership check
  and path confinement. It lazily lists only the conversation workspace,
  tenant library, and (in host mode) the selected working directory. Runtime
  directories and common credential names are hidden, text previews are
  bounded, and the explorer is read-only; it does not expose delete, rename,
  or move operations.
- Output preview share links are HMAC-signed, expire after 7 days, and work
  without login. They are minted only for previewable files with `kind=output`;
  uploads and other files can never be shared, and the public routes expose
  only the preview content, not arbitrary paths or download endpoints.
- The container is not a complete security boundary for hostile workloads. Its Codex sandbox requires relaxed seccomp/AppArmor settings for user namespaces.
- The container keeps `CHOWN`, `FOWNER`, and `DAC_OVERRIDE` in addition to
  `SETUID`/`SETGID`/`KILL` because startup must migrate tenant volume
  ownership/ACLs and may read the host Codex config mount. Treat every tenant
  account as trusted; with these capabilities a tenant process could in
  principle modify other tenants' files inside the container.
- The public edition intentionally contains no host-root bridge, Docker socket, or host filesystem mount.
- With `TRANSCRIPTION_PROVIDER=local`, recordings and an allowlisted model ID go only to a permission-restricted Unix socket. The independent unprivileged ASR process runs in a network namespace without external connectivity; it receives no draft/attachment/conversation context and never falls back to cloud recognition. Model files are prepared separately. Upload authentication, CSRF checks, ownership checks, rate/size limits, and temporary-upload cleanup remain on the web server. Protect the socket directory and do not make it world-writable. See [Local voice](LOCAL_VOICE.md).
- With `TRANSCRIPTION_PROVIDER=dashscope`, recordings and bounded spelling/topic context are sent to the operator-configured DashScope endpoint. Context can include drafts, attachment names, text attachment heads, recent messages, and small images. Use `TRANSCRIPTION_PROVIDER=disabled` to disable all voice input; removing `DASHSCOPE_API_KEY` only disables the cloud path.
- Archiving is not deletion: archived conversations retain messages, files, and Codex thread references until explicitly deleted.
- Interrupted jobs are never automatically retried because the previous turn may already have produced side effects.
- Back up state volumes and test restore procedures before upgrades.

Please report vulnerabilities privately through GitHub's security advisory feature instead of opening a public issue.
