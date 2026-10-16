# FreeBASIC Language

FreeBASIC support for Visual Studio Code, aligned with FreeBASIC 1.20.5.

The extension handles `.bas` and `.bi` files and combines source-backed syntax data with fast, conservative editor analysis. It does not require a separate language-server process.

## Language support

- TextMate highlighting for declarations, control flow, types, operators, compiler defines, runtime functions, graphics APIs, TCP forms, and sfxlib command families
- declaration-name scopes for procedures, aggregates, namespaces, and constants
- FreeBASIC comments, block comments, number formats, string forms, word selection, auto-closing pairs, and block indentation
- document and selection formatting for recognized block indentation, with conservative handling of continued and same-line statements
- native matching and context-aware auto-closing for `()`, `[]`, and `{}`, with live warnings for unclosed or unexpected delimiters
- Expand Selection follows tokens, matched delimiters, statements, comment groups, enclosing blocks, and the document
- snippets for common language structures, types, properties, graphics, input, files, networking, threads, serial ports, and current audio APIs
- hierarchical Outline and breadcrumb symbols for namespaces, types, enums, procedures, fields, parameters, and local declarations, including compiler-created locals when sidecar facts are available
- Outline refreshes after compiler-context and active semantic-snapshot changes without requiring a text edit; active symbol lookups finish before the provider refresh so it does not cancel its own compiler work
- source symbols and include links refresh after closing, changing, and reopening a file, even when VS Code reuses the document version number
- workspace symbol search across `.bas` and `.bi` files
- compiler progress, selected build context, and availability guidance in VS Code's FreeBASIC language-status menu
- type hierarchy navigation from user-defined type declarations or typed values, including compiler-selected `VAR`/`TYPEOF` values and aliases in stock-sidecar mode, following their direct bases/derived types
- incoming and outgoing call hierarchy for procedures, properties, constructors, destructors, and operators, including compiler-selected indexer calls
- module Call Hierarchy includes compiler-selected shared UDT initialization inside namespaces; constructor callers and bodies remain expandable through incoming and outgoing trees
- native destructor callers remain expandable to compiler-selected delete, scope-exit, and temporary cleanup sites, including requests from their prototypes
- native outgoing Call Hierarchy includes compiler-selected construction and cleanup for procedures and modules; explicit temporary constructors also retain overload-specific hierarchy, references, and highlights when no implicit-call receipt is exported
- ordinary FBC uses counted temporary-construction selections and mapped opening contexts for constructor references, highlights, and Call Hierarchy, including defaulted calls and `TYPE<...>` construction
- typed temporary constructor calls also use the selected overload for Signature Help and parameter-name hints with ordinary FBC, without requiring the editor bridge
- qualified constructor references and hierarchy ranges select the terminal type or alias instead of its namespace; Signature Help retains the selected overload across namespace qualification
- Find References and highlights on destructor declarations load compiler-selected cleanup facts on first use with stock FBC or the bridge; stock FBC can resolve external destructors from header prototypes without an included body
- stock-FBC constructor references also use compiler-confirmed prototypes through include guards, even without a constructor body in the selected translation unit
- Call Hierarchy reloads and indexes closed caller files without showing their editors, preserving compiler-selected optional calls and overloads in stock-FBC and native modes
- compiler-identified reference CodeLens on procedures, overloaded operators, constructors, and destructors, linking to physical symbol and operation sites from a current native snapshot or cached binding-capable FBC sidecar
- constructor CodeLens also counts compiler-selected written temporaries, optional calls, aliases, and qualified types, using the same selected overloads and physical sites as Find References
- scope-aware completion plus `.` and `->` members for declared types, aliases, namespaces, arrays, and common return-value chains
- bridge-backed member completion retains the compiler-selected receiver while typing incomplete `value.` or `value.prefix` expressions, including pointer, array, and function-result receivers; invalid expressions and navigation bindings remain withheld
- bridge-backed name completion retains compiler-known locals, parameters, imports, and active macros in broken statements, preserving lexical scope and local-over-field shadowing
- empty-line bridge completion uses verified surrounding compiler tokens, retaining common visible declarations across whitespace/comment gaps while withholding unmapped or conflicting contexts
- compiler-origin string boundaries keep empty-line completion available after ordinary, escaped, and Unicode literals without exposing string contents as identifiers
- root-file EOF completion retains native globals, imports, and active macros after independently positioned errors when all compiler scopes are closed; unclosed scopes and unpositioned preprocessor failures remain withheld
- `Using` completion is restricted to namespaces, including child namespaces after a dot, instead of mixing in functions and API names
- bundled API completion can add its uniquely mapped header and namespace import when accepting a type or function
- context-sensitive `GOTO`/`GOSUB`/`RESTORE` label completion, including forward procedure labels, computed `ON` target lists across commas and explicit continuations, and compiler-selected QB numeric labels
- unique non-overloaded procedure, indexed-getter, and parameterized-macro completion inserts argument placeholders and omits defaulted trailing arguments; offline-reference functions do the same when signatures share required argument names, while ambiguous overloads/accessors stay name-only and list their visible signatures
- hover, go to definition/declaration/implementation/type definition, find references, document highlights, and guarded workspace rename
- offline built-in reference help and signatures generated from 616 current manual/header names, plus reference documentation on compiler-resolved bundled API hovers and signatures for user procedures and macros
- native Signature Help keeps visible ordinary procedure overloads while activating the overload selected by FBC
- Signature Help supports procedure calls without parentheses, including qualified and pointer methods, continued arguments, and single-line `If` branches; space and comma trigger assistance, and manual invocation remains available
- stock-FBC Signature Help and hover follow the compiler-selected macro definition and parameter names after redefinition
- stock-FBC semantic sidecar bindings can activate the selected ordinary overload when the source resolver finds multiple candidates, without requesting bindings for single-signature calls
- signature help for overloaded `Operator []` indexers using the receiver's declared type; native analysis activates FBC's selected overload while retaining the visible candidates
- Hover on an index expression shows its `Operator []` signature and compiler-resolved result type
- Go to Declaration, Definition, and Implementation on an index expression follow its `Operator []` family, with native analysis selecting the compiler-bound overload
- compiler-backed Go to Type Definition on an index expression follows the selected operator's result type
- native Find References and document highlights include compiler-selected `Operator []` expressions without mixing overloads
- compiler-backed signature help preserves written default values for optional parameters
- compiler-selected parameter-name inlay hints label positional arguments for resolved user procedures, explicit constructor calls, and selected function-like macro definitions, including nested macro calls and calls in preprocessor expressions; tooltips also show compiler-selected parameter passing modes when available
- parameter hints also cover calls without parentheses, continued arguments, and dot/pointer methods; native method hints distinguish the hidden receiver from written arguments
- procedure and constructor parameter hints link to their physical parameter declarations when unambiguous, following the compiler-selected overload and build context, including continued header declarations
- inlay hints refresh after compiler/model changes without a text edit, including when the first request had no compiler facts or hints
- compiler-selected type inlay hints show implicit primitive types for variables (including `INPUT`/`READ` targets), parameters, and function results, including with ordinary stock-FBC sidecars
- hover on compiler-created `INPUT`/`READ` targets shows FBC's selected variable type and storage class
- hover on an implicit scalar `FOR` counter shows its compiler-selected type and storage class
- a refactor action can declare an unresolved procedure-local `INPUT`/`READ` target with FBC's selected type
- semantic highlighting for resolved declarations and uses, with compiler-confirmed writes marked using the standard `modification` token modifier from bridge data or an already-cached stock-FBC binding model; document highlights distinguish reads and writes when compiler access roles are available
- compiler-confirmed value-level const qualifiers add the standard `readonly` token modifier when binding facts are available, distinguishing fixed pointers from mutable pointers to const data without starting extra analysis
- stock-FBC semantic tokens retain ordinary variables, parameters, procedures, types, and fields alongside `OPTION NOKEYWORD` identifiers, with compiler-confirmed parameter aliases and declaration/definition roles
- resolved namespace-owned procedures remain function tokens even with qualified definitions, while UDT-owned procedures retain method tokens
- completion and Call Hierarchy use the same resolved callable owners, distinguishing namespace procedures from UDT methods for both `Sub` and `Function`
- Outline and workspace search retain compiler-owned callable kinds; source declarations use known lexical owners without starting compiler analysis
- full native compiler hovers can show target-specific value-type and UDT layout widths/alignment, field offsets/bitfield ranges, exact array bounds/counts, and fixed-array element storage totals, distinguishing pointer width from pointee data and ByRef type width from the argument slot
- compiler-selected binary, unary, and compound-assignment hovers report operand/result types; `Cva_Arg` hovers show compiler-reported C vararg types
- `SELECT CASE` hovers show compiler-selected comparison counts or `AS CONST` jump-table details, and wide-string literal hovers show target unit width and emitted-unit prefixes
- full native procedure and parameter hovers can show FBC's selected calling convention, external linkage, and actual ByVal/ByRef/ByDesc mode
- hover on a scalar `FOR` header can report when FBC proves the initial test skips or enters the loop body
- compiler analysis adds a `body skipped` inline hint when FBC proves a scalar `FOR` loop will not enter its body, including stock-sidecar mode
- compiler analysis marks a physical statement as `unreachable` when FBC's control-flow graph proves no path reaches it, including stock-sidecar mode
- compiler analysis labels constant `IF` and `ELSEIF` predicates as `always true` or `always false`, using FBC's original integer predicate values before branch folding; runtime or conflicting observations remain unlabelled
- folding for language blocks, continued statements, consecutive `#include`/`USING` imports, comment blocks, and `' #region` or `REM #region` markers
- clickable `#include` paths, following compiler-selected active physical includes when a semantic snapshot is available
- include-link targets refresh after compiler/build-context or include-path changes without requiring a source edit, including snapshot changes in visible split editors

The workspace index follows transitive includes and unsaved edits. A shared semantic model distinguishes local variables, fields, parameters, and unrelated declarations with the same name. Rename follows declaration identity and rejects ambiguous overloads, duplicate declarations, collisions, and incomplete indexes. Built-in help works offline; the matching compiler checkout is only needed to regenerate or audit the data.

Concurrent source requests share workspace discovery. Cancelling one request
does not leave an active waiting provider with a partially initialized model;
the waiter gets one fresh initialization attempt.

Source-only procedure and namespace families follow co-visible declaration links through the
include graph. Matching names and signatures in disconnected headers do not
join definitions, declarations, implementations, references, or rename previews; sharing an unrelated utility
header is not sufficient. Compiler-backed project refactoring retains its own
linkage and build-context validation.
Namespace reopenings remain linked when an indexed module can see them
together; an independent same-named namespace does not contribute definitions
or references. Namespace rename still requires compiler analysis.

`ByRef` index navigation requires the current compiler exporter. Rebuild the
compiler and optional bridge after updating the FreeBASIC checkout, and select
that rebuilt executable in the compiler settings. The VSIX does not bundle FBC.

The default analyzer handles common lexical scopes, namespace imports, aliases, public inheritance, and declared types. Call hierarchy includes module-level callers; the source fallback covers unambiguous explicit-parenthesis calls, standalone zero-argument `Sub` calls, and zero-argument `Function` or getter `Property` uses that form a complete simple expression. Native compiler analysis follows compiler-selected direct calls and macro-expanded calls when the callee identifier maps to a physical macro argument. The source fallback does not expand macros, and callees present only in replacement text have no physical call site to show. The default analyzer does not evaluate target-specific preprocessor branches. The optional compiler bridge supplies real preprocessing, native symbol identities, selected calls, expression types, unsaved-buffer analysis, and validated project symbol rename. Some constructs remain unrepresented; this is not yet a complete compiler-grade language server. The formatter currently adjusts indentation only; token-spacing/style formatting, structural refactoring, and a debugger are not implemented.

Bracket diagnostics are a fast lexical check: strings and comments are
excluded. Their Quick Fixes insert missing closers in the correct nested order
at a detected mismatch or end of file, replace a wrong closer when only one
open bracket makes that repair unambiguous, or remove an unmatched closer. When
a current compiler model is available, compiler-confirmed inactive preprocessor
branches are faded and excluded from bracket checking.
Hovering over a physical `#if` or `#elseif` condition also shows its compiler-
evaluated result and whether that branch was selected for the current build.
Hovering over a physical name inside `DEFINED(...)` shows the compiler-probed
name, including qualifiers, and whether FBC resolved it as defined in the
current preprocessor context.
Without one, conditional branches are not evaluated. Treat bracket results as
editor warnings; compiler diagnostics remain authoritative for the active build
configuration.

## Compiler-backed semantic analysis

Compiler analysis is on demand by default. The first editor request for a
source snapshot runs a schema-27 compiler in a background worker and reuses its
results until the source, build context, or compiler executable changes.
FBC 1.20.4 or newer is required for schema-27 compiler analysis. The extension
runs one bounded `fbc -version` check for each resolved compiler executable and
skips semantic analysis for older releases. FreeBASIC 1.10.1 and 1.20.0 still
provide syntax highlighting, source-based editor features, and ordinary
compiler checks. Compiler freshness uses resolved paths and filesystem
metadata, including for commands found through `PATH`.
Workspace-symbol summaries use the same executable guard. With the ordinary
`freebasic.compiler.path`, the semantic sidecar provides exact expression
types for saved source files. FBC 1.20.5 exports its default `FBCSEMB1` binary
model directly to the extension. The reader bounds frames, dictionaries, and
structured values, checks required transport capabilities, and validates the
schema-27 graph and completion totals before publishing facts. Diagnostic text
sidecars remain supported for older compilers.
If a full bridge export reaches a compiler bound, a compact binding snapshot
can retain a separate expression-only supplement. The compiler version, source
revisions, and dependency inventory must match; only types and physical ranges
cross that boundary, not identities from the independent export graphs.
That sidecar-only path does not provide native
token origins, scopes, or project refactoring; those features require the editor
bridge. It keeps macro-expansion data compact except for explicit macro
navigation, Find References, Signature Help, or hover requests at a source-model macro, where the
extension asks FBC for the full graph and uses its compiler-selected physical
invocations and selected `#undef` sites in the active translation unit and its
included files. With explicit project contexts, stock sidecars also find
macro references across saved modules when every selected use is a physical
root invocation. Nested or generated selected uses withhold the project result
and leave the current-translation-unit results available. Validated macro
rename still requires the editor bridge.
Compiler-typed expressions use exact subtype and physical declaration bindings
for type navigation, including compiler-selected conditional declarations.
Go to Type Definition also follows FBC's selected type for factory-inferred
`VAR` values, `TYPEOF` declarations, and aliases derived from those expressions.
When those bindings are unavailable, navigation requires a unique visible
non-conditional source declaration; ambiguous type names are withheld.
The same compiler-selected
type can refine member completion after an overloaded call when its source type
is uniquely visible. When conditional declarations or members require exact
selection, a binding-capable sidecar supplies the physical type and base chain;
completion retains only compiler-confirmed member sites and visibility. This
also supports factory-inferred `VAR` values, `TYPEOF`, and aliases, including
conditional bases in headers. Binding analysis is requested only when the
existing source/type path cannot establish the member list.
For overloaded function calls, ordinary FBC can also
disambiguate Go to Definition when the selected result type matches one visible
overload, present that overload on hover, and highlight it in signature help
while retaining the other candidates. Document highlights also include
compiler-confirmed calls to the selected overload in the current source, and
Find References augments its normal results with those call sites across the
current translation unit and included headers, including when the request
starts at a uniquely identified overload declaration.
Ambiguous matches keep the existing source-resolver result.

For full native scopes/origins, expansion-aware results, unsaved-buffer
analysis, Outline, workspace symbols, and validated project refactoring,
configure the optional editor bridge. It uses an instrumented copy of the real
FreeBASIC compiler to expand macros and select conditional branches, with
source-origin and dependency records. It does not reimplement the preprocessor
in JavaScript or modify the upstream checkout.
Macro signatures and completion follow the active compiler definition after
redefinition; conflicting observed expansion contexts remain unresolved.

Build the bridge from a clone of this extension repository on Linux:

```bash
FREEBASIC_ROOT=/home/jkfirth/fbc FBC_EXECUTABLE=/home/jkfirth/fbc/bin/fbc npm run build:compiler-bridge
```

Set `freebasic.analysis.compilerPath` to the printed `fbc-editor-current` path,
and `freebasic.includePaths` to the matching compiler's `inc` directory. Keep
the normal compiler in `freebasic.compiler.path`. Run **FreeBASIC: Analyze
Module With Compiler** from the Command Palette or the editor title action to
refresh a snapshot explicitly. With the bridge, the on-demand provider path also
analyzes unsaved module and header buffers as immutable overlays without saving
them.

If the configured compiler is unavailable or older than 1.20.4, compiler-backed
analysis stays disabled and the extension's lightweight source model remains
available. The language-status item reports this limited mode. Ordinary
compiler checks continue to use the selected compiler's textual diagnostics.
Set `freebasic.analysis.run` to `off` to disable on-demand
analysis, `onSave` to prepare models whenever saved sources change, or
`onChange` to continuously analyze edits (400 ms debounce; this requires the
bridge). Sidecar-only analysis refuses dirty roots or included headers rather
than using stale disk contents. The Linux builder updates
`dist/fbc-editor-current` only after a successful build; the analysis service
resolves that symlink in compiler context/cache keys, so a new build invalidates
old snapshots even when VS Code stays open.

Native compiler analysis has a separate `freebasic.analysis.timeoutMs` limit,
60 seconds by default. It does not change the timeout used for ordinary compiler
diagnostics. Large macro-heavy modules can need more time; the setting can be
raised up to five minutes or lowered for faster cancellation.

The **FreeBASIC Compiler** entry in VS Code's language-status menu shows the
selected backend, build context, and root module. It distinguishes running,
ready, and partial analysis, and explains unnamed sources, workspace trust,
stock-sidecar unsaved buffers, and missing or excluded header contexts. Its
actions open the relevant settings, select a context, retry analysis, or show
compiler output. The indicator starts one bounded version check for the
selected executable and reads the cached result; it does not start semantic
analysis or poll in the background.

Analysis uses a persistent background worker for overlay files, trace decoding,
native model construction, and native completion/navigation/type queries.
Only source snapshots and compact query results return to the editor. Manual
analysis has a Cancel button; edits and trust changes also cancel obsolete work.
Equivalent current requests share one immutable compiler preparation, so an
Outline refresh cannot supersede a manual analysis of the same source.
Each header request still requires compiler-confirmed inclusion in that root;
an excluded header reports a context error without discarding valid root facts.
Active manual callers receive shared failures even when an automatic provider
started preparation; superseded compiler cancellations do not produce warnings.
Repeated identical compiler traces use a bounded decode cache, but the compiler
still runs for each analysis so changed include lookup or time-dependent macros
cannot reuse a previous analysis. Up to eight small models are retained under
a separate memory budget. The FreeBASIC output channel reports worker and model
timings. Project rename validation also runs in the worker, with temporary
baselines and a final source-freshness check before returning an edit preview.
With a bridge configured, Outline for a configured source and workspace-symbol
search for configured closed modules use the worker's native declaration
inventory. The ordinary workspace cache still handles unconfigured sources and
does some frontend work on the editor thread; this is not yet an incremental
compiler.

For the analyzed module, completion, navigation, references, signatures, and
semantic tokens use the compiler-expanded translation unit. Unchanged tokens
map back to their source files; generated declarations navigate to a read-only
expanded view. **FreeBASIC: Show Compiler-Expanded Module** opens that view
from the Command Palette or the editor context menu.
The compiler's defines, language, target, and include options come from
`freebasic.compiler.arguments`, `freebasic.includePaths`, and the selected build.
With a current bridge model, compiler-selected types are shown inline for
variables, constants, parameters, and function results that omit an explicit
type; explicit, suffix-typed, and provisional recovery declarations are left
alone. With on-demand analysis enabled, ordinary FBC sidecars also supply
hints for implicit function results and parameters, compiler-created
assignment/`FOR`/`INPUT`/`READ` targets, untyped constants, and inferred `Dim`
initializers in dialects that allow them, including continued expressions,
when the compiler confirms the type.
Hover and completion show bounded source text for single-definition macros,
including continued `#define` lines. Hover on an exact physical `#define` or
`#macro` declaration shows its own source even when the name is redefined.

For native analysis while editing a `.bi` header, list your module/build pairs
in `freebasic.analysis.projectContexts`, then run **FreeBASIC: Select Compiler
Context** from the Command Palette or the editor title action. The selected
translation unit supplies the header's compiler context, including conditional
defines. It need not be open in an editor. The choice is
stored as `freebasic.analysis.activeContext` in the workspace folder settings.
Modules use their own source root in the same named build. Header analysis
requires the compiler to actually include that header; no module is guessed.
Changing contexts invalidates previous results. The selected context does not
reduce the builds checked by project rename.

This requires UTF-8 buffers, a named module, and workspace trust. Edits invalidate
the snapshot and return navigation/completion to the lightweight analyzer until
the next successful check. Headers without a selected context use the lightweight
index. With a bridge configured, rename requires explicit
`freebasic.analysis.projectContexts` and native validation.
With a schema-27 FBC semantic sidecar, ordinary Find References searches those
configured modules and build contexts for saved source, including compiler-
selected constant references in conditional directives. Go to Definition,
Declaration, and Implementation search configured declarations when the active
translation unit confirms the symbol but lacks the requested body or prototype.
Project rename and project navigation over unsaved buffers still require the
editor bridge.

Syntax errors no longer discard the whole native snapshot. Failed parser
regions are excluded; types whose native expression dependency reaches a
recovered region are labelled provisional, while independent types remain
authoritative. Native diagnostics describe the current unsaved buffers.
When FBC supports its FBCDIA transport, compiler analysis, **Check Syntax**,
and on-save diagnostics validate the artifact and underline the
compiler-reported UTF-16 source point, including points in included headers.
The extension uses a point only when the source token agrees with the
diagnostic text and captured buffer; otherwise it keeps the line-based
fallback. Compilers without this optional artifact are retried without it.
Refactoring still requires error-free source. Recovery dependency tracking is
not yet complete.

The bridge now exports compiler-owned procedure identities and selected call
targets. Definitions, references, signatures, and function-result member lookup
use the actual selected overload for supported direct calls, including nested
calls, methods, and property access. Virtual calls identify the compile-time
declaration, not a predicted runtime override.

Compiler expression types appear in hover. Compiler-confirmed integer,
floating-point, and string values for named constants appear in hover and
completion details when a semantic binding model confirms one unambiguous
value, including stock FBC sidecars. String values retain exact bytes or wide
units. Byte previews appear only for ASCII-safe payloads; wide-unit previews
use the compiler's exact Unicode values and escape controls, so the extension
does not guess a character encoding. Hover also shows compiler-folded
expression values when FBC provides an exact physical expression match.
Floating-point values retain their exact IEEE-754 bits alongside a readable
decimal. Bridge-backed native Outline details show named constant values.
Select an expression and run
**FreeBASIC: Show Compiler Expression Type** from the Command Palette or editor
context menu to inspect its resolved type and any compiler-confirmed constant
value.
Native receiver types support completion after casts and compound expressions.
Compound member/index/call prefixes retain their own types. The bridge also
records native operations, conversions, conditional branches, and call argument
dependencies without replacing written operand types. Source-derived runtime
helpers, explicit or implicit constructor calls, UDT allocation and assignment
operators, and iterator `FOR`/`STEP`/`NEXT` calls retain their selected procedures.
Repeated dereferences retain each intermediate type. The graph is not yet
complete for every parser and lowering path.

Project rename joins shared declarations across configured modules, validates
temporary edits in every listed build, and returns standard F2 edits. Use VS
Code's rename preview to review the changes before applying them.
It covers directly represented variables, parameters, fields, constants, enum
members, types/aliases, namespaces, named and numeric labels, and procedures. Numeric labels can
also convert to named labels when their declaration uses the ordinary colon-free form. Native parameter
identities join prototype and implementation names, even when their spellings
differ. Type links use compiler subtype identities, including forward types.
Namespace imports, procedure address-taking, and function-result assignments
retain native references. Virtual-method rename includes the configured override
family and verifies that dispatch slots do not change. Copied macro arguments and
replacement-list identifiers retain their physical references. Constructed tokens,
external ABI names, and missing configuration coverage are rejected. See the project-context example
and exact limits in the design document below. Rebuild an existing bridge for
protocol 14 before using this update.

Physical token ranges now preserve navigation, expression selections, and
validated rename through line continuations and `#line` remapping, including
unsaved buffers. Ordinary identifiers beside expanded macros or rewritten
literals remain mapped individually. Native macro maps retain definitions,
invocations, arguments, concatenations, stringification, and callback inputs.
Copied arguments, including duplicated and nested substitutions, support
navigation, expression typing, completion, and validated rename. Constructed
or transformed text remains in the expanded view. Rename also checks the
expanded text so an identifier edit cannot silently change a string value.

Macro names and parameters now have native identities for navigation, signatures,
semantic coloring, and project rename. Rename covers equivalent definitions,
include guards, empty expansions, and `#undef`/redefinition lifetimes. Parameter
names stay local to their definition instance. Native macro completion retains
the environment at the cursor, including failed expressions in unsaved buffers.
Hover explains deferred names in replacement text when the current compiler
snapshot has not observed a unique expansion target, distinguishing unexpanded
text from conflicting expansion targets. Such names remain unresolved for
navigation/refactoring, and some qualified preprocessor queries still need
coverage; unsupported edits remain rejected.

Compiler mode now builds its declaration inventory and lexical regions from
native records, including separate reopened namespace blocks and out-of-line
method ownership. Completion uses native type/base links and member visibility
attributes. Source parsing supplies display text, not the scope or declaration
inventory. Precise recovery dependencies and complete reference coverage are
still unfinished.

See [compiler bridge design and remaining work](docs/compiler-bridge.md) for the
protocol, limits, build requirements, and next implementation stages. The VSIX
does not bundle a compiler binary. The bridge builder is currently Linux-only.

## Compiler diagnostics

Saved `.bas` modules can be checked by the real FreeBASIC compiler. The extension runs `fbc` in compile-only mode, writes the temporary object into an isolated temporary directory, and maps errors and warnings back to `.bas` and included `.bi` files.

Diagnostics run on save by default. Saving an included header also rechecks open dependent modules using FBC's observed source list, including macro-expanded includes. They can also be run with **FreeBASIC: Check Current Module** from the Command Palette or the editor title menu. With the editor bridge configured, this manual command analyzes open dirty module and header buffers as immutable overlays. Manual and on-save checks honor the selected build context for saved modules, including when using ordinary FBC without the bridge. A saved header is checked through its selected translation unit, and the compiler must confirm it was an input; missing context reports how to select one. On-save compile-only diagnostics and bridge-less checks still use saved files on disk. Unnumbered preprocessor messages such as `#error` retain their reported location and text, but do not drive compiler-rule Quick Fixes. While typing an include path, completion offers `.bi` files from the source directory, configured include paths, compiler `-i` paths, and discovered compiler include folders. For a saved `.bas` module or included `.bi` header, an undeclared API or unresolved `AS` type with one unambiguous bundled-header mapping can offer a Quick Fix to add the include and namespace import. A missing include also offers a path correction when one workspace or configured-include `.bi` has the requested file name. For an undeclared variable, explicit procedure call, or type, a typo Quick Fix is offered only when one visible declaration is within one edit and the source index is complete or a current complete compiler snapshot is available. Compiler-confirmed EOF diagnostics can insert FBC's expected closing statement, while a compiler-confirmed single-counter `FOR`/`NEXT` mismatch can remove the non-semantic variable after `NEXT`; when the active `FOR` counter is unambiguous, a one-edit typo in the optional `NEXT` name can also be corrected. `-w next` warnings can remove the same redundant counter name. A single undeclared optional counter after `NEXT` can be removed. Multi-counter forms are left untouched. An explicitly typed inline `FOR` counter can be widened when FBC warns it may wrap before passing its limit; the compiler-selected limit token is underlined. For a simple single-variable integer declaration whose literal does not fit its written type, a Quick Fix can offer a wider type only when that type can hold the exact literal. A numeric parameter-default mismatch can be aligned to a unique same-file declaration when the matching implementation and declaration otherwise have the same signature. Procedure signature mismatches use FBC's physical procedure-name point even when the diagnostic text does not include that name, and unsupported `ON ERROR RESUME NEXT` syntax is underlined at the compiler-selected `ON` keyword. A warned nested `Else If` can be changed to an `ElseIf` branch, but the action is not preferred because nesting and chaining have different control flow. Suspicious BYREF-address and pointer-to-scalar warnings can offer removal of `@` or a matching pointer dereference when source types agree. A scalar-to-pointer warning can offer `@` only when the source variable and compiler-selected `ByVal` pointer formal have the same base type. A file-transfer pointer warning can offer dereferencing a simple primitive pointer in a `PUT`/`GET` value slot. When FBC warns that a bare call's `=` may be equality rather than assignment to a BYREF result, a Quick Fix wraps the call only if it is the unique whole left-hand expression. Unknown-capacity `LINE INPUT` diagnostics underline the compiler-selected destination. Compiler context also explains case-only variable collisions and suffix/`AS` conflicts; it offers to remove a case-only duplicate only when uninitialized same-scope declarations have the same explicit type, and to remove a type suffix in a legacy `DIM AS type` conflict or a simple `DIM name% AS Type` declaration that FBC warns will ignore the suffix. For a misspelled bundled API call or public bundled type, the offline reference must identify one name and one header/namespace mapping; the fix corrects the name and adds the include/import together. Ambiguous candidates are left for the user to resolve. Compiler execution is disabled in untrusted workspaces and for virtual files. Superseded checks are cancelled, and edits clear stale diagnostics.

Changing compiler options or the selected build context retracts obsolete compiler diagnostics, even when automatic analysis is off. Checks and snapshots already using the new settings remain available.

Background binding and macro upgrades keep the current compiler snapshot available until the replacement is ready, instead of clearing unchanged diagnostics first. Cancelled or failed upgrades leave existing type information usable. Edits, context changes, source freshness checks, and the worker's normal cache limits still apply.

Up to eight small module snapshots can stay warm in the worker. The byte budget still takes priority, so large analyses evict other entries as needed rather than increasing the memory allowance.

Repeated compiler failures are throttled for unchanged inputs. Fixing and saving an open header releases that throttle even if its root module was not edited. Cancelled work, changed analysis timeouts, models discarded after preparation, and temporary worker-queue admission errors can be retried without the failure delay. Inputs that exceed the worker's individual safety limits remain ordinary errors.

Opening a new named header can also retire a partial snapshot that the compiler reported as missing that include, including macro-expanded include names. FBC confirms the new file and its types on the next analysis; on-change roots use their existing debounce. Newly available physical files also retire saved-file missing-include errors when they match the root's working-directory lookup, without hiding errors for unrelated paths.

Include-file completion closes an unfinished quoted filename and converts C-style `<...>` operands to FreeBASIC's supported double-quoted form. Directory completions keep the path open for continued typing.

Include completion and source-only navigation honor `-i` options from the selected build context. For a header with a selected translation unit, relative compiler paths and `-i` values use the root module's working directory. The header's own directory is searched first, followed by that working directory and the effective include options in compiler order. `includePaths` remains workspace-relative. Switching contexts refreshes source include caches automatically.

The duplicate-`DIM` Quick Fix also supports untyped declarations when their case-folded names imply the same default type.

When FBC reports an undeclared name after a single-counter `NEXT`, the Quick Fix can also remove that optional name; it does not apply to multi-counter `NEXT` statements.

Useful settings:

- `freebasic.compiler.path`: compiler path or command name, default `fbc`
- `freebasic.compiler.arguments`: additional arguments passed before the managed compile-only arguments
- `freebasic.diagnostics.run`: `onSave` or `off`
- `freebasic.diagnostics.maxErrors`: maximum compiler errors per check
- `freebasic.diagnostics.timeoutMs`: compiler process time limit
- `freebasic.includePaths`: extra directories for include navigation, indexing, and compiler `-i` arguments; `${workspaceFolder}` is supported
- `freebasic.index.exclude`: files excluded from workspace analysis
- `freebasic.index.maxFiles`: workspace analysis file limit
- `freebasic.index.maxFileSizeKB`: background file-size limit, default 4096 KiB; open documents are still analyzed
- `freebasic.index.maxCompletionResults`: workspace declarations added to one completion request
- `freebasic.index.maxSymbolResults`: workspace symbol result limit
- `freebasic.index.workspaceConcurrency`: workspace symbol compiler-worker limit; use `1` to reduce memory use

Include lookup also reads `-i` entries in compiler arguments and discovers standard `inc` and `include/freebasic` layouts beside the resolved compiler. This works with explicit paths, the default `fbc` command on PATH, and compiler symlinks, without running a compiler probe. An effective `-prefix` selects its own SDK layouts instead; selected builds can override the global prefix, and explicit include paths retain priority. Version-suffixed or other nonstandard header directories can still be configured with `includePaths`; compiler-reported include outcomes remain authoritative when available. Index limits disable rename until a complete rebuild succeeds. Excluded files are outside rename coverage. Changes to unopened headers outside the workspace require **FreeBASIC: Rebuild Workspace Index**.

Use **FreeBASIC: Show Compiler Output** to inspect captured output, bounded to 2 MiB per run. Use **FreeBASIC: Rebuild Workspace Index** after generated files or workspace configuration changes that VS Code did not report individually.

## FreeBASIC 1.20.5 coverage

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

The audit covers 257 compiler keywords, all 25 current preprocessor directives, 122 public RTL registrations, 114 compiler defines, 27 parser-recognized words, 105 bundled functions, 11 bundled types, and 252 selected header constants. The reference was generated from the 1.20.5 source at revision `8ebc975303fb30f1a4c4330547cde11c011e895e`. Its hash and source locations are retained in the shipped data. This audit measures vocabulary coverage, not full language semantics.

This includes current touch and controller APIs, gfxlib3 surfaces, `builtin.bi`, portable `fbcom`, the opt-in sfxlib effects and raw-output helpers, and the exact `MUSIC`, `SFX`, `MIDI`, `DEVICE`, and `CAPTURE` command families. Obsolete forms such as `AUDIO`, `STREAM`, and `MUSIC CURRENT` are not presented as current syntax.

The reference includes current PNG-related `BLoad`/`BSave` parameter documentation and gfxlib3 surface signatures. The `savepng` and `gfx3loadimage` snippets demonstrate these APIs. Select gfxlib3 with `-gfx3` for unchanged source, or include `fbgfx3.bi` to select it from source.

Manual excerpts retain their [FreeBASIC documentation attribution and license](docs/reference-attribution.md). Extension source code remains MIT-licensed.

## Building and testing

The grammar generator and audit use Node.js and work through npm:

```text
npm ci
npm run build:grammar
npm run build:reference
npm run audit:grammar
npm test
npm run test:corpus
npm run test:integration
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

Both builders produce `dist/fb-vscode-language-1.20.5.vsix`. To test the
package on Linux without changing the normal extension profile:

```bash
code --transient --extensions-dir ./.tmp-code-extensions --install-extension ./dist/fb-vscode-language-1.20.5.vsix --force
```

The equivalent PowerShell command is:

```powershell
code --transient --extensions-dir .\.tmp-code-extensions --install-extension .\dist\fb-vscode-language-1.20.5.vsix --force
```

`npm test` rebuilds the grammar, audits the source surface, validates package assets and reference reproducibility, and runs parser, semantic-model, index, diagnostic, and actual TextMate tokenizer tests. Development dependencies are not shipped in the VSIX.

On Linux, `npm run test:unit` discovers a nearby FreeBASIC source checkout and
bootstrap compiler, builds the editor bridge, and runs native-dependent unit
tests. Set `FBC_EDITOR_EXECUTABLE` to use a specific bridge. If no bridge can be
found or built, compiler-dependent tests retain their normal skip behavior.

Integration tests use the official VS Code extension-host test launcher in a temporary editor profile. They download VS Code unless `VSCODE_EXECUTABLE` points to an installed executable. Use `VSCODE_VERSION=1.85.0` to test the minimum supported editor or leave it unset for stable. Linux needs a display; headless CI uses `xvfb-run -a npm run test:integration`. Set `FBC_EXECUTABLE` to a compiler binary to include the real compiler diagnostic and snippet checks. `FREEBASIC_EXTENSION_PATH` can point to an extracted VSIX's `extension` directory to test packaged runtime files.

To verify the actual VSIX payload with the native Outline and workspace-symbol
providers enabled, build the compiler bridge and run the Linux package test:

```bash
npm run build:compiler-bridge
FBC_EDITOR_EXECUTABLE=/path/to/fbc-editor VSCODE_VERSION=1.85.0 npm run test:integration:vsix:linux
```

The command rebuilds the VSIX, installs it into an isolated VS Code profile,
checks the installed extension path and native provider modules, then runs the
extension-host suite against that installed package. Omit `VSCODE_VERSION` to
use stable VS Code.

The corpus audit checks declaration coordinates and exercises parsing and resolution across the compiler, manual examples, selected headers, and a large COM header. It reports timings, but is not an oracle for semantic correctness. The CI workflow runs on Linux and Windows, tests actual editor providers, and builds both native VSIX paths.

<!-- end of README.md -->
