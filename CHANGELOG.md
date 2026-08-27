# Changelog

## 1.20.3

- Aligned the grammar, completions, hovers, and snippets with the FreeBASIC 1.20.3 public language surface
- Added exact coverage for current preprocessor directives and 97 predefined or compiler-recognized symbols
- Added `GETTOUCH`, `GETTOUCHCOUNT`, `GETTOUCHHIT`, `GETXPAD`, `VOL`, `builtin.bi`, gfxlib3, `fbcom`, and opt-in sfxlib header APIs
- Added complete current `fbgfx.bi` constants and types, including screen controls, scan codes, events, and controller values
- Removed the obsolete `AUDIO`, `STREAM`, and `MUSIC CURRENT` command forms
- Replaced platform-specific grammar maintenance with cross-platform Node generation and source auditing
- Added release-tag compatibility checks, exact API-family checks, generated-file consistency tests, and refreshed snippets for current APIs
- Replaced flat document scanning with a cached workspace index and nested FreeBASIC declaration parser
- Added hierarchical document symbols, workspace symbols, completions, hover, definition, references, rename safeguards, document highlights, and user-declared signature help
- Added language-aware folding and clickable `#include` paths with configurable search directories
- Added trusted, compile-only `fbc` diagnostics on save and on demand, including diagnostics from included `.bi` files
- Added commands, settings, workspace trust limits, process time and output bounds, and compiler output reporting
- Added declaration-name syntax scopes plus parser, index, diagnostic, source-audit, and generated-asset regression coverage
- Improved escaped strings, nested block comments, `REM` comments, anonymous enums, numeric labels, type-suffixed names, and current numeric literal forms
- Added native Linux VSIX packaging alongside the PowerShell builder, with platform-aware npm dispatch, isolated staging, archive validation, and reproducible Linux output

## 1.20.1

- Expanded the grammar from a starter stub into a source-backed FreeBASIC language definition aligned with the FB 1.20.1 tree
- Added broader compiler, runtime, graphics, TCP, and sfxlib keyword coverage, including important multi-word forms and symbolic constants
- Improved FreeBASIC indentation and language configuration behavior for block constructs and preprocessor branches
- Expanded snippets using real upstream example patterns from graphics, networking, threading, file I/O, error handling, and sfxlib examples
- Added lightweight IntelliSense with built-in completions, hover text, document symbols, workspace symbols, and go-to-definition for traced declarations
- Split semantic logic into reusable modules and added smoke and unit test coverage
- Added reproducible grammar audit/build tooling and a standalone VSIX packaging script
- Fixed VSIX install failures by normalizing packaged JSON and manifest files to UTF-8 without BOM and validating the packaged `extension/package.json` during the build
- Trimmed the packaged README so repository workflow notes do not appear in the installed extension
- Fixed a bug in the coloring json to resolve problems with "" not inside a quotation mark.
- Hardened the generated string-token rule so empty-string forms such as `Input ""`, `Inkey$ <> ""`, and `Print """"` do not spill highlighting into later code
- Added a regression fixture and unit coverage for the empty-string highlighting cases
- Added README sections for local build, test, packaging, and isolated VSIX installation workflow

## 1.20.0

- Initial scaffold for a FreeBASIC language extension
- Added FreeBASIC file associations for `.bas` and `.bi`
- Added a starter TextMate grammar, language configuration, and snippet set
