# FreeBASIC Language

FreeBASIC support for Visual Studio Code, aligned with FreeBASIC 1.20.3.

The extension handles `.bas` and `.bi` files and combines source-backed syntax data with fast, conservative editor analysis. It does not require a separate language-server process.

## Language support

- TextMate highlighting for declarations, control flow, types, operators, compiler defines, runtime functions, graphics APIs, TCP forms, and sfxlib command families
- declaration-name scopes for procedures, aggregates, namespaces, and constants
- FreeBASIC comments, block comments, number formats, string forms, word selection, auto-closing pairs, and block indentation
- snippets for common language structures, types, properties, graphics, input, files, networking, threads, serial ports, and current audio APIs
- hierarchical Outline and breadcrumb symbols for namespaces, types, enums, procedures, fields, parameters, and local declarations
- workspace symbol search across `.bas` and `.bi` files
- completion for user declarations and the audited built-in language surface
- hover, go to definition, find references, document highlights, and conservative workspace rename
- signature help for procedures and macros declared in the workspace
- folding for language blocks, preprocessor blocks, and `' #region` or `REM #region` comment markers
- clickable local and configured `#include` paths

The workspace index is cached and updated as files change. Rename is offered only when the selected spelling has one unambiguous indexed declaration. The analyzer deliberately avoids claiming compiler-grade overload or type resolution.

## Compiler diagnostics

Saved `.bas` modules can be checked by the real FreeBASIC compiler. The extension runs `fbc` in compile-only mode, writes the temporary object into an isolated temporary directory, and maps errors and warnings back to `.bas` and included `.bi` files.

Diagnostics run on save by default. They can also be run with **FreeBASIC: Check Current Module** from the Command Palette or the editor title menu. Compiler execution is disabled in untrusted workspaces and for virtual files.

Useful settings:

- `freebasic.compiler.path`: compiler path or command name, default `fbc`
- `freebasic.compiler.arguments`: additional arguments passed before the managed compile-only arguments
- `freebasic.diagnostics.run`: `onSave` or `off`
- `freebasic.diagnostics.maxErrors`: maximum compiler errors per check
- `freebasic.diagnostics.timeoutMs`: compiler process time limit
- `freebasic.includePaths`: extra directories for clickable includes; `${workspaceFolder}` is supported
- `freebasic.index.exclude`: files excluded from workspace analysis
- `freebasic.index.maxFiles`: workspace analysis file limit
- `freebasic.index.maxCompletionResults`: workspace declarations added to one completion request
- `freebasic.index.maxSymbolResults`: workspace symbol result limit

Use **FreeBASIC: Show Compiler Output** to inspect the compiler's complete captured output. Use **FreeBASIC: Rebuild Workspace Index** after generated files or workspace configuration changes that VS Code did not report individually.

## FreeBASIC 1.20.3 coverage

The reviewable grammar source is checked against the compiler and bundled headers that define the public surface:

- `src/compiler/symb-keyword.bas`
- `src/compiler/symb-define.bas`
- `src/compiler/pp.bas`
- `src/compiler/rtl-*.bas`
- `src/compiler/parser-*.bas`
- `src/compiler/fb.bi`, `src/compiler/symb.bas`, and `src/compiler/fbc.bas`
- `inc/builtin.bi`
- `inc/fbgfx.bi` and `inc/fbgfx3.bi`
- `inc/fbcom.bi`
- `inc/sfxlib_effects.bi` and `inc/sfxlib_raw.bi`

The audit covers 253 compiler keywords, all 25 current preprocessor directives, 122 public RTL registrations, 97 compiler defines, the parser-defined sound command families, and selected bundled APIs and constants. The configured source checkout currently identifies itself as 1.20.4, so the audit also verifies that every inspected public-language path is unchanged from Git tag `v1.20.3`.

This includes current touch and controller APIs, gfxlib3 surfaces, `builtin.bi`, portable `fbcom`, the opt-in sfxlib effects and raw-output helpers, and the exact `MUSIC`, `SFX`, `MIDI`, `DEVICE`, and `CAPTURE` command families. Obsolete forms such as `AUDIO`, `STREAM`, and `MUSIC CURRENT` are not presented as current syntax.

## Building and testing

The grammar generator and audit use Node.js and work through npm:

```text
npm run build:grammar
npm run audit:grammar
npm test
```

The audit discovers `/home/jkfirth/fbc` from this repository layout. For another checkout, set `FREEBASIC_ROOT` or pass `--freebasic-root` to `tools/audit-freebasic-coverage.js`.

VSIX packaging does not require `vsce`. The default command selects the Bash
builder on Linux and the PowerShell builder on Windows:

```text
npm run package:vsix
```

The Linux builder requires Node.js plus the standard `zip` and `unzip`
commands. It validates every expected archive entry before publishing the
finished file.

The platform builders can also be invoked directly:

```bash
./tools/build-vsix.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build-vsix.ps1
```

Both builders produce `dist/fb-vscode-language-1.20.3.vsix`. To test the
package on Linux without changing the normal extension profile:

```bash
code --transient --extensions-dir ./.tmp-code-extensions --install-extension ./dist/fb-vscode-language-1.20.3.vsix --force
```

The equivalent PowerShell command is:

```powershell
code --transient --extensions-dir .\.tmp-code-extensions --install-extension .\dist\fb-vscode-language-1.20.3.vsix --force
```

The full test command rebuilds the checked-in grammar, audits the FreeBASIC source surface, validates package assets, and runs parser, index, diagnostic, and string-token regression tests.
