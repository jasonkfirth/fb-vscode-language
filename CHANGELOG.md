# Changelog

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
