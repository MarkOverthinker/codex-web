# Product screenshots

These are browser captures of the real Codex Web frontend, not UI mockups. Both product READMEs share these assets.

## Provenance

- UI source: committed revision `historical-reference-removed`, captured on 2026-09-18 from an isolated source snapshot, excluding unrelated work-in-progress changes.
- Renderer: Playwright Chromium with a fresh browser context, Chinese locale, device scale factor 1.5 and installed Chinese fonts. No application CSS or DOM was rewritten for the captures.
- Desktop viewport: 1600 × 960 CSS pixels, light theme. Mobile viewport: 390 × 844 CSS pixels, dark theme. The mobile image shows the responsive web UI, not the native Android client.
- Every API response is a local fixture. The account `Demo`, tasks, paths under `/workspace`, model label, messages, code changes and reported test results are fictional examples. They do not record a real coding run or prove backend behavior.
- API requests are intercepted before reaching a server; unexpected endpoints and external requests fail capture validation. No production login, provider, conversation, filesystem API or Codex session is used.

| Asset | Shows |
| --- | --- |
| [desktop.png](desktop.png) | Project task navigation, conversation, deliverable and composer. |
| [review.png](review.png) | Conversation beside the repository diff and file tree. |
| [mobile.png](mobile.png) | Mobile web conversation and composer in dark mode. |

## Updating the images

Use an isolated frontend and fresh Playwright context with synthetic API fixtures, following the patterns in `tests/browser/fixtures.ts` and `tests/browser/repository.spec.ts` (paths relative to the repository root). Do not capture a signed-in production browser or replace the UI with an illustration.

After capture, check each image visually for legibility, private data, unexpected loading/error states and misleading content. Confirm there are no browser errors, unmocked requests or horizontal page overflow, and inspect the image metadata. Record the new source revision and capture conditions here. Replacements still require manual review: the privacy checker permits only these three exact asset paths and cannot inspect their pixels.
