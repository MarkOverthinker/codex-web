# Security

- Keep `.env` private and use a unique password plus a random session secret.
- Bind the application to loopback and expose it only through an HTTPS reverse proxy.
- Codex can execute code and modify files inside its tenant workspace. Only upload files you trust and review generated changes.
- Custom host working directories are accepted only in host mode and never
  point at Codex Web's own data, tenant, or workspace roots; the worker
  revalidates the absolute path and the tenant system user's access before
  starting.
- The container is not a complete security boundary for hostile workloads. Its Codex sandbox requires relaxed seccomp/AppArmor settings for user namespaces.
- The container keeps `CHOWN`, `FOWNER`, and `DAC_OVERRIDE` in addition to
  `SETUID`/`SETGID`/`KILL` because startup must migrate tenant volume
  ownership/ACLs and may read the host Codex config mount. Treat every tenant
  account as trusted; with these capabilities a tenant process could in
  principle modify other tenants' files inside the container.
- The public edition intentionally contains no host-root bridge, Docker socket, or host filesystem mount.
- Voice recordings and their bounded spelling/topic context are sent to the DashScope endpoint configured by the operator. Context can include the draft, attachment names, text attachment heads, recent messages, and a small number of images. Disable voice by leaving `DASHSCOPE_API_KEY` empty.
- Archiving is not deletion: archived conversations retain messages, files, and Codex thread references until explicitly deleted.
- Interrupted jobs are never automatically retried because the previous turn may already have produced side effects.
- Back up state volumes and test restore procedures before upgrades.

Please report vulnerabilities privately through GitHub's security advisory feature instead of opening a public issue.
