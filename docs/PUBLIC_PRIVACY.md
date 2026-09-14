# Public repository privacy

Privacy cleanup targets private domains, machine addresses, actual storage paths, deployment/account relationships, copied operational incidents and credentials. Git author/committer names and emails are normal contributor attribution and are preserved. Do not remove useful generic examples or default application ports merely because they resemble deployment settings.

## Local setup

Keep your normal Git identity. Enable the tracked privacy hooks with:

```sh
git config --local core.hooksPath .githooks
```

Inspect existing hooks first; integrate them rather than silently replacing them. Hooks require Node.js and are not enabled automatically by cloning. This setup does not anonymize commit authors or committers.

Store exact operator-specific hostnames, deployment paths and sensitive operational phrases in the ignored `.privacy.local.json`. Prefer specific deployment identifiers over broad contributor names:

```json
{
  "forbiddenLiterals": ["private-host-placeholder", "/srv/private-deployment-placeholder"]
}
```

Keep this file private (`chmod 600 .privacy.local.json`). Do not copy real secrets into it or into test fixtures. The file is local only and is not available to public CI. Missing policy means only generic rules run; malformed policy fails closed.

## Before every publication

1. Review `git status --short` and stage only intended files. Do not use a blanket add in a checkout containing unrelated work.
2. The pre-commit hook scans the complete staged snapshot; the commit-msg hook scans the proposed message. Author and committer fields are not filtered. An unsafe staged version is rejected even if the working copy has already been cleaned.
3. Run `npm test`. After committing, run `npm run check:privacy` to check the committed tree and message. CI repeats this check for its checked-out commit.
4. The pre-push hook checks all outgoing commits, not just the final tree, so a later deletion cannot hide sensitive contents in an earlier outgoing commit. It rejects publishing internal agent or backup refs. Keep the local deployment-specific policy on every machine that can push.
5. Push only the intended branches or tags, never a mirror of `.git`. Do not publish the whole working directory, backups or private audit reports as an archive.

Generic checks detect common credential patterns, non-placeholder emails in file contents/messages, personal home paths, private/generated filenames and unreviewed binary files, symlinks or submodules. Known checked-in app icons and the Gradle wrapper are permitted binary assets; replacements still require manual review. Third-party attribution under `licenses/` is retained. The checker cannot identify every private domain, detect encoded secrets or inspect screenshots; local rules and manual review remain necessary. Hooks can be bypassed and CI runs after upload, so neither can retract already-published content.

## Historical cleanup

A deletion commit does not remove earlier contents. Rewriting history is exceptional maintenance that requires explicit approval, a protected backup, an isolated rewrite, identity/content verification and a narrowly scoped force-with-lease update. Preserve contributor identities and do not publish replacement rules or old-to-new commit maps. Reconcile other clones after a rewrite instead of merging old history back into the cleaned branch.

Local backups, reflogs and agent checkpoints may intentionally retain old history for recovery; they must remain private and must never be pushed. Rewriting a branch cannot retract other clones, fork-network objects, cached views or PR references. For an exposed credential, revoke or rotate it before relying on historical cleanup.
