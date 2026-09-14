# Public repository privacy

This repository is published in place. New cleanup commits do not remove information from earlier commits, forks, caches or existing clones. Do not rewrite history or change repository visibility as part of routine privacy cleanup.

## Local setup

Use an identity that does not disclose a personal email. A deliberately unlinked project identity is:

```sh
git config --local user.name "Codex Web contributors"
git config --local user.email "contributors@example.invalid"
git config --local core.hooksPath .githooks
```

A GitHub-provided noreply address is also accepted, but still identifies the public GitHub account. Inspect existing hooks before changing `core.hooksPath`; integrate them rather than silently replacing them. Hooks require Node.js and are not enabled automatically by cloning.

Store operator-specific names, hostnames, account identifiers and other forbidden literal strings in the ignored `.privacy.local.json`:

```json
{
  "forbiddenLiterals": ["private-operator-placeholder", "private-host-placeholder"]
}
```

Keep this file private (`chmod 600 .privacy.local.json`). Do not copy real secrets into it or into test fixtures. The file is local only and is not available to public CI. Missing policy means only generic rules run; malformed policy fails closed.

## Before every publication

1. Review `git status --short` and stage only the intended files. Do not use a blanket add in a checkout containing unrelated work.
2. The pre-commit hook scans the complete staged snapshot plus author/committer identity; the commit-msg hook scans the proposed message. This catches an unsafe staged version even if the working copy has already been cleaned.
3. Run `npm test`. After committing, run `npm run check:privacy` to check the committed tree, identities and message. CI repeats this check for its checked-out commit.
4. Review `git log origin/main..HEAD` before pushing: all outgoing commits, not just the final snapshot, must be safe. Do not introduce private strings in intermediate commits and rely on a later deletion.
5. Push only the intended branch, never local agent refs or a mirror of `.git`. Do not publish the whole working directory as an archive.

The checker blocks common credential patterns, non-placeholder email addresses, personal home paths, private/generated filenames, and unreviewed binary files, symlinks and submodules. Known checked-in app icons and the Gradle wrapper are permitted binary assets; replacements still require manual review. Third-party attribution under `licenses/` is retained rather than treating its author emails as operator data. Generic checks cannot identify every private domain, detect encoded secrets, or inspect screenshots; local rules and manual review remain necessary. Hooks can be bypassed and CI runs after upload, so neither can retract already-published content.

## If something has already leaked

For an exposed credential, revoke or rotate it before relying on repository cleanup. A new deletion commit does not invalidate a credential or remove historical copies. For names, emails and deployment details, assess the residual exposure separately; any history removal, access changes or repository deletion requires an explicit maintenance decision.
