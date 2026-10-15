# FreeBASIC 1.20.4 extension upgrade

The verification below records the initial upgrade. The subsequent opt-in
compiler-preprocessing implementation and its remaining stages are documented
in [compiler-bridge.md](compiler-bridge.md).

The release uses `/home/jkfirth/fbc` as the development reference. Shipped
language features must work without that checkout. The compiler remains the
authority for syntax and type diagnostics.

The upgrade is complete when these items have implementation and verification
evidence:

- Package version, grammar, snippets, documentation, and both VSIX builders
  agree on 1.20.4. The audit passes against the current compiler and headers.
- Built-in hover, completion documentation, and signature help use a generated,
  attributed reference extracted from the matching manual and public headers.
- A shared semantic model resolves lexical scopes, namespaces, declared types,
  aliases, aggregate members, and inheritance for editor navigation and member
  completion. Ambiguous or unsupported expressions remain unresolved.
- References, highlights, and rename use resolved declaration identity. Rename
  rejects collisions and preserves unrelated names, comments, and strings.
- Semantic tokens and type-definition navigation use that same model.
- Include dependencies and edits invalidate affected analysis; indexing and
  compiler checks have cancellation and resource limits.
- Actual VS Code provider tests cover completion, hover, navigation, references,
  rename, signatures, semantic tokens, and diagnostics. Corpus checks measure
  parser behavior and performance on bundled FreeBASIC sources.
- Linux packaging produces a validated, installable VSIX; a cross-platform CI
  workflow exercises unit/provider tests and the native packaging paths.

This release develops editor semantics within the existing provider architecture.
Moving those services behind LSP can reuse the model later. Full macro expansion,
compiler AST export, and compiler-accurate overload resolution require a separate
compiler integration project and are not represented as implemented features.

## Verification, 2026-09-09

- Reference compiler: 1.20.4-1, source revision
  `88047b975e7f7d1c5b5255b4a3a6ac7b06fe3e3a`. The source tree was not modified.
- Source audit: 253 keywords, 25 directives, 122 RTL registrations, 27 parser
  words, 97 compiler defines, 99 bundled functions, 11 bundled types, and
  250 selected header constants. No missing or stale audited vocabulary.
- Offline reference: 586 names regenerated from matching manual/header text;
  unit tests compare the complete generated object, including provenance.
- `npm test`: 59 passing checks across smoke, unit, and actual TextMate tests.
- Actual VS Code 1.121.0 host: 12 passing checks against the extracted Linux
  VSIX, including member completion, navigation, references, rename, hover,
  signatures, semantic tokens, include links, and unsaved header invalidation.
  The real compiler compiled the navigation fixture and both new snippets,
  and published the deliberately invalid include's diagnostic.
- Minimum supported VS Code 1.85.0 host: all 10 compiler-independent checks
  passed. Both host runs used isolated profiles.
- Corpus audit: 1,412 source files, 66,443 declaration ranges, and 920,372
  tokens exercised. One local run took about 4.7 seconds; its slowest file,
  the roughly 1 MiB EXCEL header, took about 1.0 second. This checks ranges,
  exceptions, and measured throughput, not compiler-equivalent resolution.
- Linux VSIX: native builder passed archive validation and VS Code CLI
  installation into a temporary extension directory; installed identity was
  `sjzero.fb-vscode-language@1.20.4`. The user's normal profile was unchanged.
- Linux/Windows CI is checked in with pinned action and compiler revisions.
  Windows/PowerShell execution and remote CI were not run from this Linux
  session. Both builders' runtime file lists pass local smoke checks.

Known boundaries remain explicit in the README: macro expansion, active
preprocessor branches, exact overload selection, arbitrary type inference,
formatting, and debugging are not implemented. External unopened headers need
a rebuild after disk changes; compiler checks use saved source. Rename previews
must be reviewed because unsupported and macro-generated references can remain
unresolved. No Marketplace release or Git push was performed.

<!-- end of upgrade-1.20.4.md -->
