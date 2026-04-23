# FreeBASIC Language

This extension provides practical FreeBASIC support for Visual Studio Code.

It is focused on making `.bas` and `.bi` files feel like first-class editor content instead of plain text with a few colored keywords.

## What it includes

- FreeBASIC language registration for `.bas` and `.bi`
- syntax highlighting for core language forms, runtime APIs, graphics routines, TCP forms, and sfxlib commands
- editor language configuration for comments, word selection, and indentation
- snippets based on real FreeBASIC example patterns
- lightweight IntelliSense for built-ins and traced declarations

## Source-backed coverage

The grammar and snippets were expanded against the FreeBASIC `fbc-fbxl` tree, with coverage taken from the parts of the source that define or parse the language:

- `src/compiler/symb-keyword.bas`
- `src/compiler/rtl-*.bas`
- `src/compiler/parser-quirk-file.bas`
- `src/compiler/parser-quirk-console.bas`
- `src/compiler/parser-quirk-gfx.bas`
- `src/compiler/parser-quirk-thread.bas`
- `src/compiler/parser-quirk-sfx.bas`
- `src/gfxlib2`
- `examples/network/opentcp`
- `examples/sfxlib`
- `examples/manual`

That means the extension covers:

- core declaration, control-flow, OOP, and type-system keywords
- built-in and runtime functions across console, file, math, string, system, thread, and graphics areas
- graphics statements and helpers such as `DRAW STRING`, `VIEW SCREEN`, `SCREEN`, `GET`, `PUT`, and palette forms
- TCP and device `OPEN` forms such as `OPEN TCP`, `OPEN TCP SERVER`, and `TCP ACCEPT`
- newer `MUSIC`, `SFX`, `AUDIO`, `STREAM`, `MIDI`, `DEVICE`, and `CAPTURE` command families

## IntelliSense scope

The current IntelliSense layer is intentionally lightweight.

It provides:

- completions for compiler keywords, built-ins, runtime names, graphics names, and selected symbolic constants
- completions for declarations traced from the current document
- hover information for traced declarations and built-in symbols
- document symbols and workspace symbols
- go-to-definition for traced declarations across `.bas` and `.bi` files in the workspace

This is not a full language server yet, so it does not attempt compiler-grade parsing, diagnostics, or type checking.

## Building and testing

The repository does not require `vsce`.

The main project commands are:

- `powershell -ExecutionPolicy Bypass -File .\tools\build-freebasic-grammar.ps1`
- `powershell -ExecutionPolicy Bypass -File .\tests\test-smoke.ps1`
- `powershell -ExecutionPolicy Bypass -File .\tests\test-unit.ps1`
- `powershell -ExecutionPolicy Bypass -File .\tools\build-vsix.ps1`

The smoke test rebuilds the generated grammar, validates the JSON assets, and runs the grammar coverage audit. The unit test covers the reusable parser helpers and the generated string-token rule used for common empty-string cases such as `Input ""` and `Inkey$ <> ""`.

## Installing the VSIX locally

If VS Code is already using an older copy of the extension, close all VS Code windows before reinstalling the generated `.vsix`.

If you want to isolate packaging from your normal profile while testing, this command installs into a temporary extension directory:

```powershell
code --transient --extensions-dir .\.tmp-code-extensions --install-extension .\dist\fb-vscode-language-1.20.1.vsix --force
```

## Current direction

The extension already aims to be more than a syntax highlighter, but there is still room to grow.

The main next steps are:

- more editor-side validation against the upstream example corpus
- continued refinement of edge cases where TextMate highlighting can only approximate parser context
- richer semantic tooling over time
