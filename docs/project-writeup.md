/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: docs/project-writeup.md

    Purpose:

        Explain how this extension was developed and what it means
        for FreeBASIC developers using Visual Studio Code.

    Responsibilities:

        * describe the design process behind the extension
        * document the source-backed approach used for grammar and snippets
        * explain the practical value of the extension for day-to-day editing
        * summarize the repository-side workflow used to maintain the project

    This file intentionally does NOT contain:

        * release notes
        * changelog history
        * implementation code
*/

# FreeBASIC VS Code Language Extension: Project Write-Up

This extension started as a language-support stub and was grown into a practical FreeBASIC editing layer for VS Code. The work was not about pretending to build a compiler inside the editor. It was about taking the actual FreeBASIC tree, learning from the real source of truth, and turning that into something that feels useful to people who write FreeBASIC every day.

## How the plugin was developed

The first step was to stop guessing. FreeBASIC is a real language with a large surface area, and a lot of its behavior lives in the compiler tree, runtime modules, parser quirks, and example programs. Instead of inventing syntax support by hand, the extension is aligned with the current FreeBASIC 1.20.4 compiler and headers. Generated reference data records the exact source revision and a reproducible content hash.

That source-backed approach shaped almost everything else:

- compiler keywords came from `src/compiler/symb-keyword.bas`
- runtime and library names came from the `src/compiler/rtl-*.bas` modules
- special parser forms came from the `parser-quirk-*.bas` files
- preprocessor directives and compiler defines came from `pp.bas`, `symb-define.bas`, and the compiler target definitions
- graphics behavior was checked against `src/gfxlib2`, `src/gfxlib3`, and the bundled graphics headers
- compiler builtins, portable COM, and optional sfxlib APIs were checked against their bundled public headers
- snippets were grounded in real programs under `examples`

That made the extension much more durable than a keyword list copied from memory. It also made the result easier to keep current, because the grammar source can be audited against the upstream tree instead of being edited as one giant hand-maintained JSON blob.

The implementation was then split into smaller parts so each concern could stay focused:

- `syntaxes/source/freebasic.grammar-source.json` holds the source data for the grammar
- `tools/build-freebasic-grammar.js` regenerates the shipped grammar from that source data on every supported development platform
- `tools/audit-freebasic-coverage.js` checks the source data against compiler, runtime, parser, and selected bundled-header registrations
- `extension.js` owns activation, provider registration, commands, and lifecycle events
- `lib/freebasic-parser.js` handles nested declaration tracing, comments and strings, includes, occurrences, calls, and folding ranges
- `lib/bracket-diagnostics.js` provides immediate lexical delimiter checks without requiring a compiler process
- `lib/workspace-index.js` maintains a reusable index across `.bas` and `.bi` files
- `lib/semantic-model.js` resolves scopes, declaration identities, types, aliases, members, and public inheritance
- `lib/semantic-features.js` adapts resolved symbols into navigation, references, rename, and semantic tokens
- `lib/editor-features.js` presents completions, hover, symbols, signatures, folding, and links
- `lib/include-paths.js` shares include discovery between links and indexing
- `tools/build-language-reference.js` generates offline reference data from the manual and headers
- `lib/language-reference.js` provides attributed built-in reference help
- `lib/compiler-diagnostics.js` runs `fbc` with bounded compile-only arguments and parses its output
- `lib/compiler-diagnostic-sidecar.js` validates FBC's structured diagnostic transport before narrowing editor ranges
- `lib/compiler-service.js` applies trust policy and publishes compiler diagnostics through VS Code
- `lib/grammar-data.js` loads and normalizes the grammar source data
- `tests/` contains smoke tests, parser tests, and fixtures

That split matters. It means the project is no longer just one large language file that gets harder to reason about with every feature. It now has a shape that supports maintenance.

## Why the snippets matter

The snippets were expanded from upstream examples instead of being written as generic placeholders. That sounds like a small detail, but for editor tooling it matters a lot.

Real examples tell you the patterns users actually need:

- how FreeBASIC opens TCP connections
- how graphics code enters a screen loop
- how `ScreenLock` and `ScreenUnlock` are used together
- how file I/O and error handling are written in practice
- how the current `sfxlib` commands and opt-in effect and output-capture helpers are chained
- how touch, controller, gfxlib3, and portable serial APIs are initialized and cleaned up

That makes the snippets feel like helpers, not marketing copy. A new user can insert a snippet and start from a shape that already matches the language as FreeBASIC developers write it.

## What the extension means for FreeBASIC developers

For a FreeBASIC developer using VS Code, the extension changes the editor from "plain text with colors" into something closer to a serious working environment.

The practical effect is:

- syntax highlighting now covers core language forms, compiler defines, runtime APIs, graphics entry points, TCP forms, and sfxlib commands
- indentation and comment behavior are tuned for FreeBASIC block structures
- bracket pairs are highlighted by VS Code, and unmatched delimiters receive live warnings outside comments and strings; conditional branches are not evaluated
- snippets reduce the friction of common tasks like file I/O, graphics loops, thread setup, and network examples
- cached editor intelligence surfaces built-ins and declarations already present in the workspace
- navigation, references, guarded rename, signatures, folding, and include links reduce routine source navigation work
- optional compiler checks report real `fbc` errors and warnings on save without creating build products in the project
- the grammar and tests are structured so the extension can be kept current as FreeBASIC evolves

That matters for two reasons.

First, it lowers the barrier to using VS Code for FreeBASIC work. A language support extension only earns trust if it feels familiar and reliable when you open a real project. The goal here was to make the editor feel like it understands FreeBASIC instead of merely recognizing a few keywords.

Second, it helps FreeBASIC look and feel like a living language in a modern editor. When an extension stays current, covers the actual runtime and parser surface, and provides useful navigation features, it sends a signal that the language is still actively usable in contemporary tooling.

## What it is not

This project is not pretending to be a full compiler front-end.

The editor analyzer resolves common declarations, lexical scopes, declared types, aliases, namespace imports, and public inheritance. It does not perform full type checking, macro expansion, target-specific preprocessing, or compiler-accurate overload selection. Rename follows resolved declaration identity and rejects ambiguity, collisions, and incomplete indexes, but unsupported and macro-generated uses can remain unresolved. Preview edits before applying them. TextMate highlighting is supplemented by semantic tokens for resolved symbols. Real syntax and type diagnostics come from the configured FreeBASIC compiler.

That is not a flaw in the project. It is just the boundary between practical editor support and full language intelligence.

## Development workflow

The repository also carries the project-side tooling needed to keep the extension healthy as it grows.

That includes:

- cross-platform grammar regeneration from the source data under `syntaxes/source`
- audit checks against compiler and runtime registrations, parser command families, and selected bundled headers
- smoke tests for JSON validity and packaging rules
- unit tests for parsing, semantic resolution, indexing, compiler cancellation, and reference reproducibility
- actual VS Code provider tests, including optional real-compiler diagnostics and snippet checks
- actual TextMate tokenizer tests and a source-corpus coordinate/performance audit
- Linux and Windows CI using a pinned compiler source revision
- native Bash and PowerShell VSIX builders that verify the packaged `extension/package.json` stays valid and BOM-free

Those details are useful to contributors and maintainers, but they are not part of the installed extension experience. Keeping that split helps the packaged README stay focused on FreeBASIC users while the repository still documents how the project is maintained.

## Why this matters

The real win is that FreeBASIC developers now have a VS Code extension that is grounded in the language itself.

It reflects the compiler, the runtime, the graphics layer, the TCP and sfxlib forms, and the example code people actually learn from. That combination makes the plugin useful not just as a colorizer, but as a small practical bridge between FreeBASIC and a modern editor workflow.

That is the difference between "supported enough" and "worth using."

/* end of docs/project-writeup.md */
