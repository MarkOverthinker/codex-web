# Historical revision references

Identify release and QA records with version names, artifact filenames, checksums, test commands and outcomes. Avoid embedding superseded commit identifiers from privacy-maintained history: a stale identifier can lead readers to an older snapshot even when the current branch no longer contains the sensitive values.

The marker `historical-reference-removed` denotes an intentionally removed revision identifier. It does not replace artifact checksums, change release versions, or invalidate the recorded test results. Contributor names, emails and commit dates are retained.

## Authorized maintenance

- Keep a protected, private backup and perform the rewrite in an isolated copy. Do not publish backups, replacement rules or old-to-new commit maps.
- Check file contents and commit messages across the complete reachable history, including references that indirectly lead back to a pre-cleanup snapshot.
- Verify contributor identities, parent relationships, application source and binary assets before publishing. Use an explicit lease for the intended branch only, and reconcile the working checkout without discarding unrelated work.
- Recheck workflow runs and public event/activity metadata after publishing. Removing branch references or workflow records does not prove that old objects or platform-managed discovery records are no longer accessible.

See [public repository privacy](PUBLIC_PRIVACY.md) for the publication checks and local policy setup.
