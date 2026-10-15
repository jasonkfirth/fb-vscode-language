# Compiler-grade implementation and acceptance plan

The goal is a compiler-grade FreeBASIC language extension, not a rename-only
bridge or a larger syntax dictionary. This plan tracks unfinished requirements
against observable compiler and editor behavior. Passing existing tests alone
does not establish completion.

## Required compiler interfaces

1. Export committed identities for every source symbol kind, lexical scopes,
   type identities, declaration/reference roles, visibility, and overload and
   override relationships. Editor resolution must use these native decisions.
2. Export all source expression ranges and their compiler types, including
   intermediate member/index/call expressions and implicit conversion/call
   relationships. Verify against the compiler's expression grammar and tests,
   not a handpicked list of successful examples.
3. Preserve physical token origins through includes, continuations, source
   remapping, and macro invocation/argument expansion. Keep logical diagnostic
   coordinates distinct from editable physical locations.
4. Retain useful, current native results for incomplete and erroneous editor
   buffers. Mark recovery-created or invalid results explicitly. Publish native
   buffer diagnostics, bound work, and reject stale and truncated snapshots.
5. Give headers an explicit translation-unit/build context. Move repeated
   compiler work behind a cancellable worker boundary with bounded caches and
   measured interactive behavior.

## Required editor and refactoring behavior

Use native identities/types consistently for completion, hover, navigation,
references, signatures, symbols, and semantic tokens. Keep errors in one region
from erasing independently valid results elsewhere in the current buffer.

Extend project refactoring to variables, parameters, fields, constants, enum
members, types/aliases, namespaces, labels, macros, procedures, and override
families. Handle shared declarations, conditional builds, address-taking and
macro provenance. Validate edits against captured source and every declared
build context. Structural refactorings must preserve the same semantic contract.
External consumers and genuinely ambiguous edits remain explicit boundaries;
missing native support is unfinished work, not a completion condition.

## Evidence required before completion

- Source-hook compatibility and trace-disabled compiler parity.
- Native grammar/construct coverage, including negative and recovery cases.
- Cross-module/configuration identity and refactoring fixtures for every kind.
- Actual VS Code tests on the minimum supported and current installed versions.
- Unsaved roots/headers, edits during analysis, cancellation, trust changes,
  Unicode coordinates, source remapping, macro expansion, and bounded inputs.
- Compiler-source and upstream-test corpus runs with recorded coverage gaps.
- Packaged-runtime verification and reproducible source-backed language data.
- A requirement-by-requirement final audit of this plan and the bridge design.

## Current state

Protocol 14 has positioned parser errors alongside physical token/macro ranges, native lexical scopes and declaration inventory, selected
procedure calls, a growing native expression graph,
immutable named-buffer overlays, and validated native-symbol project rename.
Header editing now has an explicit translation-unit/build context shared with
project configuration validation. A persistent worker now handles overlay I/O
and trace decoding, with host-owned compiler process cleanup. Native recovery retains partial snapshots, retracts failed parser regions,
publishes current-buffer diagnostics, and distinguishes EOF from error-limit
stops. Expressions whose native dependency path reaches a recovered region are
provisional; independent expressions remain authoritative. Native IDs now cover represented
variables, parameters, fields, constants, enums, types/aliases, namespaces,
named and numeric labels, procedures, macro names, and macro parameter slots. Metadata includes lexical owners, namespaces,
scope depth, dtype/subtype links, prototype/body parameter aliases, and dispatch
slots/override edges. Namespace imports, procedure addresses, result assignments,
and forward-type replacement now have native references. Recovery provenance
follows retracted declarations through native type, owner, namespace, base-type,
and anonymous-layout links. Deferred preprocessor coverage and several reference
forms are still missing. The full requirements
above remain open; this is progress, not completion.

Recovery checkpoint, 2026-09-09: 93 automated tests passed with the native
bridge, plus 17 packaged-extension checks on VS Code 1.85.0 and 1.121.0.
`ast-node-call.bas` and `parser-proc.bas` parsed to EOF without errors and
exported 1,811 and 4,857 expression records respectively. These corpus checks
exercise scale; they do not prove expression completeness.

`compiler/editor-symbols.bi` and `tools/compiler-symbol-hooks.js` implement
the native identity path. Both pool allocation sites initialize IDs explicitly.
Project rename joins physical declarations and validates all exported binding
and type relationships. New tests cover 12 named-symbol cases and cross-module
type, field, and external-variable rename under two configurations.

Reference/dispatch checkpoint, 2026-09-09: all 107 automated tests passed with
protocol 6 enabled; the packaged extension passed all 19 checks on VS Code
1.85.0 and 1.121.0. Compiler-validated rename now joins named
virtual families across modules and conditional inheritance, preserving slots
and keeping unrelated overloads distinct. Before/after fixtures compiled and
ran identically with the unmodified compiler. A 1,412-file source corpus passed
66,462 declaration range checks and tokenized 920,586 tokens without parser or
resolver exceptions.
Native compiler-module checks exported 8,527 and 11,375 symbol uses, with 864
and 1,097 dispatch records. These remain coverage samples, not completeness proofs.

Expression provenance now survives destructive compiler folding and lowering.
Compound member/index/call prefixes, repeated pointer dereferences, native
unary/binary operations, conditional branches, conversions, and source call
argument chains have graph records. The argument chain retains source order,
arbitrary arity, conversions, and omitted defaults. Implicit operator calls
retain compiler-selected targets; indirect calls retain their callee expression
without inventing a runtime destination. Rename validation compares the
source-anchored DAG while allowing independent construction-order changes.

An overloaded `CAST` selected while lowering a written conversion is retained
as that conversion's compiler-selected call dependency. This keeps the source
operand, the resulting conversion type, and the selected operator connected
without presenting compiler-generated calls as additional source expressions.

Fixed-array address lowering now retains receiver/index edges. Source-derived
runtime helpers, `THREADCALL`'s nested subcall and generated runtime target,
and explicit or implicit constructor calls retain selected procedure edges
without exporting unrelated compiler-generated calls. Copy construction at a
declaration, return value, BYVAL UDT argument, implicit construction for a
nontrivial BYREF UDT argument, and both UDT `IIf()` branches,
`CONSTRUCTOR()`
chaining, `TYPE<UDT>(...)` and `NEW UDT(...)` initialization, and `BASE()`
initialization retain their selected constructor edges.
Written graphics functions such as `POINT()` retain their selected runtime
target after their quirk parser commits the complete argument list; graphics
statements remain generated work rather than source expressions.
The `CVA_ARG` intrinsic retains its `cva_list` operand through both the
backend-macro and pointer-based ABI lowerings. It remains an intrinsic edge
with no fabricated procedure target.
The regression matrix also executes pointer/casting, array-bound, string,
math, console, file, SFX, error, conditional, graphics, and vararg quirk
expression families against the native bridge. It checks both the
compiler-selected result type and selected runtime target where a
source-derived runtime call exists.
Remaining expression work
includes other special-member paths and a grammar-led coverage inventory against
upstream compiler tests. Exported expression edges propagate invalidity, so
independent expressions in a partial snapshot retain authoritative types. Native
symbol/type recovery dependencies are marked provisional through the
compiler-exported dependency graph; uncommon parser-repair paths still need
corpus-led audit.

Expression checkpoint, 2026-09-09: all 113 automated tests passed with protocol
7; the packaged extension passed 20 checks on VS Code 1.85.0 and 1.121.0.
The native upstream corpus audit decoded 259 expression/pointer/numeric/overload
files, retaining 139 complete and 120 recovery snapshots. All 259 matched the
original compiler's preprocessing and exit outcome with tracing disabled, and
traced source matched after removing metadata. The audit is repeatable with
`npm run test:corpus:native`. The compiler-source checks exported 2,000 and
5,238 written expression records, both reaching EOF without errors. These
measurements demonstrate regression coverage, not a closed grammar inventory.

Native inventory now separates physical scope instances from native ownership,
including reopened namespaces and out-of-line methods. The editor no longer
uses parsed declarations or block guesses as its compiler-mode inventory.
Anonymous-field promotion, private/protected inheritance, source parameter
modes, imports, sibling branches, and legacy implicit variable scope have
native-backed tests. Remaining inventory work includes a complete declaration
and visibility audit, implicit/builtin symbol presentation, and unusual recovery
scope paths. Existing parsing still supplies some display signatures.

Scope/inventory checkpoint, 2026-09-09: all 116 automated tests passed with
protocol 8, plus all 21 packaged checks on VS Code 1.85.0 and 1.121.0. The
259-file native corpus passed preprocessing parity and model construction,
retaining 16,386 declarations and 5,457 scope instances across complete and
partial snapshots. Compiler-source checks retained 5,690/6,537 declarations and
314/729 scopes, both reaching EOF without errors. This is broader native-backed
coverage, not proof that the full requirements above are complete.

Physical ranges now follow character lookahead, includes, continuation lines,
UTF-8 encoding markers, and repeated logical `#line` locations. Snapshot freshness
uses physical dependencies, including empty unsaved includes. Each token maps
independently, so rewritten literals or macro expansions do not hide neighboring
direct identifiers. Legacy suffixes remain outside rename edits. Project
validation compares physical token anchors as well as native semantic graphs.
Protocol 9 left macro replacement tokens explicitly unprojected; protocol 10
adds the text-operation provenance described below.
On-demand compiler analysis now consumes FBCDIA physical points for diagnostics
when the reported token agrees with the message. Ordinary Check Syntax output
and diagnostics without a safe token match remain line-based. Rewritten-literal
expression ranges remain unfinished.

Physical-origin checkpoint, 2026-09-09: all 121 automated tests passed with
protocol 9, plus all 22 packaged checks on VS Code 1.85.0 and 1.121.0. All
259 native corpus files passed preprocessing parity and model construction.
The two compiler-source checks projected 24,042 and 32,368 tokens, reaching
EOF without errors. No test saved editor changes or modified the compiler checkout.

Macro maps now preserve replacement-list text, invocation sites, parameter
substitution, concatenation, stringification, and builtin callback inputs. Copied
arguments and replacement-list identifiers project into physical source, including
duplicated and nested expansions. Native targets remain distinct when one
physical token has different meanings at its expansion sites. Expression typing
requires agreement, completion uses common native identities, and rename compares
both provenance geometry and retained expanded text. Constructed names and
transformed values remain read-only in the expanded view.

The bounded map arena uses interning, append builders, balanced concatenation,
and trimmed slices. File IDs reduce trace size without dropping source identity.
All 259 native corpus files passed after these storage changes. Focused tests
cover Unicode buffers, line endings, malformed graphs, callback argument lifetime,
and rename rejection when an argument is also stringified.

Macro-origin checkpoint, 2026-09-09: all 128 automated tests passed with protocol
10, plus all 23 packaged checks on VS Code 1.85.0 and 1.121.0. The native corpus
retained 545,095 reachable maps and projected 269,830 macro tokens. Both large
compiler-source checks reached EOF without errors, projecting 24,795 and 34,923
tokens. Project coverage checks now exclude unrelated open buffers outside the
configured dependency set. No test saved editor changes or modified the compiler
checkout. Native macro-name/parameter work follows in the next checkpoint.

Native preprocessor declarations now retain DEFINE identity, definition instance,
parameter ordinals, and source uses before pooled data is released. Equivalent
definitions keep separate parameter names. Lookups, empty calls, recursive error
references, and undefinitions retain native decisions. Macro-name rename joins
lifetimes and include-guard checks within each configured translation unit;
parameter rename checks capture even in unused replacement lists. Replacement
identifiers acquire a macro target only when every observed expansion of the
same physical token selected one DEFINE symbol; unexpanded and multi-target
replacement text remains unresolved. Active macro completion uses lexer epochs
and remains available at failed unsaved expressions without restoring invalid
bindings or types. Complete preprocessor-scope completion remains open.
Qualified source queries retain the final compiler-selected symbol.

Preprocessor-identity checkpoint, 2026-09-09: all 135 automated tests passed with
protocol 11, plus all 24 packaged checks on VS Code 1.85.0 and 1.121.0. All 259
native corpus files passed preprocessing parity and model construction, retaining
5,705 macro definition instances, 5,260 parameter declarations, and 64,394
preprocessor reference records. Both compiler-source models reached EOF without
errors. Tests cover macro/parameter rename, shared unsaved headers, include guards,
capture in unused replacement lists, malformed metadata, and recovery completion.
The full compiler-grade requirements above remain unfinished.

Header-context work now routes native analysis, expression inspection, ordinary
providers, and rename target selection through an explicitly chosen module/build
pair. Unsaved headers remain overlays even with the module editor closed. Cached
and in-flight results retain an exact compiler/context signature; the compiler
must actually consume the header. Project rename still validates every declared
context. The worker checkpoint below adds execution infrastructure; prepared
interactive context caches remain a separate unfinished requirement.

Header-context checkpoint, 2026-09-09: all 143 automated tests passed with the
protocol 11 bridge enabled, with no skipped tests. The packaged extension passed
25 checks on both VS Code 1.85.0 and 1.121.0, including different native types for
the same unsaved header under two selected builds and all-context rename previews.
The native compiler protocol did not change in this stage. The compiler checkout
remained unchanged.

Worker execution now has a bounded queue, deadlines, shared cancellation flags,
exact compiler-trace caching, and crash cleanup that reaps native children before
replacement work starts. Compiler invocation is never skipped on a cache hit.
Lifecycle tests include stalled decoding, invalid replies, byte/count limits,
spawn failure, native parity, and a missing include appearing without a request
text change. `npm run benchmark:analysis` measures host timer gaps separately
from elapsed compiler and model time. Large native-record transfer, model
construction, source freshness checks, and provider queries remain on the editor
thread. Their measured cost is unfinished work, not proof of interactive readiness.

Worker checkpoint, 2026-09-09: all 157 automated tests passed with the protocol
11 bridge enabled and no skips. The packaged extension passed all 25 checks on
VS Code 1.85.0 and 1.121.0, and all 259 native corpus files passed parity and
model construction. Shutdown now returns a promise that VS Code can await.
Trust loss during an analysis also cancels queued work and prevents a second
dependency verification invocation. The compiler checkout remains unchanged.
The repeatable benchmark retains 5,690/6,537 declarations in the two compiler
modules, both reaching EOF. Repeated worker analysis reduces their measured
analysis-related host timer gaps from 404/450 ms to 167/210 ms, but model
construction still takes 418/603 ms on the host. The larger trace exceeds the
cache budget and does not claim a cache hit or an overall speedup.

Native editor models now stay inside the worker, including completion, hover,
navigation, references, signatures, expression queries, semantic tokens, and
rename target selection. Captured dependency verification, source checks around
each query, bounded two-model retention, lean result messages, and host generation
checks protect asynchronous results. At that checkpoint, project rename still
constructed its large models on the host; the project-worker checkpoint below
removes that cost. Lightweight outline/workspace-symbol providers remain outside
the native query path and are unfinished.

Prepared-model checkpoint, 2026-09-09: the two large compiler modules retain
5,690/6,537 declarations and reach EOF without errors. Repeat-request analysis
host gaps measured 16/20 ms instead of 182/207 ms for raw graph transfer, and
424/590 ms of additional host model work moved into the worker. Total prepared
analysis remained 1,310/2,387 ms because preparation verifies frozen dependencies.
Semantic-token queries took 30/62 ms with host gaps of 5/6 ms. These local
measurements are not a portable latency guarantee. Two macro-heavy upstream
tests require the bounded exclusive model allowance; ordinary retention remains
two models under the smaller shared budget.

All 171 automated tests passed with protocol 11 enabled and no skips. All 259
upstream cases passed direct/prepared model construction and preprocessing parity,
including 139 complete and 120 partial snapshots. Their 21,529 worker semantic
tokens matched direct-model queries. The packaged runtime passed all 25 checks
on both VS Code 1.85.0 and 1.121.0. No compiler-source changes were made.

Project validation now runs in the worker. Large baseline graphs are spooled to
bounded private storage, and lightweight physical binding projections join the
configured contexts. Canonical semantic fingerprints are compared one family at
a time, avoiding simultaneously retained before/after graphs. One-use publication
tickets recheck source content and physical edit paths, followed by host buffer,
trust, generation, and context checks. No source files are written.

Project-worker checkpoint, 2026-09-09: all 183 automated tests passed with no
skips. The compiler-source benchmark validated identical two-location renames
under two builds in both direct and worker modes. Five compiler passes took
5,035 ms directly and 4,659 ms in the worker; the largest observed host pause
dropped from 1,465 ms to 18 ms. This is responsiveness evidence, not proof of
complete refactoring coverage or a portable performance guarantee.
All 259 upstream cases again passed preprocessing parity and direct/prepared
model checks, with 21,529 matching worker semantic tokens. The packaged runtime
passed all 25 checks on VS Code 1.85.0 and 1.121.0. The compiler checkout remained
unchanged at revision `7dc6fc394921fb347f0cbba345e2dbba961eca31`.

Native Outline and workspace-symbol providers now use the worker-owned native
inventory. Outline compiles a configured source on demand and preserves its
physical declaration nesting. Workspace search compiles configured closed
modules through a bounded worker cache, rejects stale overlays, and falls back
to the lightweight index only for roots without a configured compiler.

Current hardening checkpoint, 2026-09-10: all 197 local smoke, unit,
native-compiler, and TextMate checks passed with the protocol 11 bridge
enabled. The Linux VSIX passed all 29 packaged-editor checks on VS Code 1.85.0
and 1.121.0. The repeatable 259-case upstream corpus retained 139 complete and
120 partial snapshots with preprocessing parity and model construction in both
paths. It exported 164,855 syntax records, 44,696 conversions, 23,241 binary
operations, 2,105 unary operations, 3,575 conditionals, 84,306 arguments,
13,983 calls, and 69 fixed-array index records. Decimal and base-prefixed
numeric labels now retain direct `GOTO`/`GOSUB`/`RETURN <label>`, `ON ... GOTO/GOSUB`,
`ON ERROR GOTO`, single-line `IF` branch, and `RESTORE` references, semantic
tokens, and numeric-to-numeric validated rename. Named references and
numeric-to-named conversion now preserves an existing declaration colon or adds
one only when required, while validating physical token origins. A numeric
single-line `IF` branch is structurally rewritten with its required explicit
`GOTO`; the validator accounts for the anonymous compiler scope introduced by
an `ELSE GOTO` branch while retaining all declared semantic relationships.
This adds regression evidence;
it does not close the expression, recovery, or refactoring requirements.
Qualified `#if defined(Namespace.member)` queries now retain the final
compiler-selected member for definition, references, and validated rename.

Recovery presentation now preserves compiler-authoritative independent
expression and declaration results in a partial snapshot. Expressions whose
native graph reaches a failed region, and declarations contained by a
compiler-recovered lexical scope, are explicitly provisional in native hover,
completion, and Outline records. A retracted declaration now also taints every
native symbol that depends on its type, owner, namespace, base type, or
anonymous-layout relationship. The same provenance reaches expression graph
nodes through their subtype, selected call target, and operand edges. This
keeps a valid later variable usable while making its type provisional when that
type came from damaged recovery state.

Expression traces now retain optional compiler parser-family provenance for
generic expression entry points and every quirk-function dispatcher/parser.
The repeatable native corpus reports a per-category family histogram, while
fixtures require representative syntax records for array, conversion, console,
error, file, graphics, math, memory allocation, peek, SFX, string, vararg,
conditional, anonymous-type, thread, and central quirk-dispatch paths. This
turns the remaining grammar-led inventory into a finite, compiler-source-led
audit. `VA_FIRST` is separately compiled using its supported x86-64 gas backend;
the ordinary GCC/Clang context must continue to report its native unsupported
diagnostic. A separate operation fixture covers MOD, integer division, power,
shift, bitwise, short-circuit, and RTTI `IS` parser paths with compiler-selected
result types. It does not prove that each family has complete branch coverage.

Parser-provenance checkpoint, 2026-09-10: all 197 local smoke, unit,
native-compiler, and TextMate checks passed. The 259-case native corpus passed
trace-disabled preprocessing parity and direct/prepared model construction,
including the previously largest `IIf` case within the existing 32 MiB trace
limit. The corpus observed 30 parser families across generic expression and
special parser paths; focused native fixtures cover all 20 listed special
expression parsers. Family records are deliberately one sampled
completed syntax record per parser family per compiler invocation, rather than
metadata on every lowered AST node. This keeps coverage evidence bounded while
leaving graph typing and transform records unchanged.

Protocol 12 extends that provenance when a generic parser helper returns an
AST whose source range was committed by a deeper parser. Multiple bounded
family records can now identify the direct source form and the helper paths on
the same expression node without manufacturing duplicate ranges or changing
hover, completion, navigation, or rename behavior. The bridge has an explicit
compiler-source inventory for binary, unary, atom, constant, function, and
variable parser routes. Fixtures cover delegated array, function-pointer,
`WITH`, implicit-member, and ordinary-variable routes, alongside the direct
operator and quirk families. The shared type-layout predicate route now covers
expression-side `LEN`, `SIZEOF`, and `TYPEOF`, including malformed `SIZEOF`
recovery with an opening parenthesis and no operand. Type-layout predicates in
invalid declarations still require more
recovery-led cases because the compiler retracts their temporary ASTs.

Multi-path provenance checkpoint, 2026-09-10: all 197 local smoke, unit,
native-compiler, and TextMate checks passed with the protocol 12 bridge. The
259-case native corpus passed trace-disabled parity and direct/prepared model
construction with 139 complete and 120 recovery snapshots. It observed 45
parser families, including `cExpressionWithNIDXARRAY`,
`cFuncPtrOrMemberDeref`, `cWithVariable`, `cVariable`, and
`cImplicitDataMember`, without exceeding the existing 32 MiB trace limit.
No upstream compiler source was modified.

Trace-mode preprocessor recovery now retains source after an incomplete
`#include`. The normal compiler recovery consumed the next token when the
directive had no filename, which could hide a valid following statement from
the native snapshot. The bridge resynchronizes at that directive's EOL only
while tracing. A focused unsaved-buffer test verifies that the later expression
keeps its compiler-selected `Double` type and remains non-provisional. This is
one recovery path, not a claim that all preprocessor repairs retain later
native analysis.

Incomplete-include recovery checkpoint, 2026-09-10: all 198 local smoke,
unit, native-compiler, and TextMate checks passed with the protocol 12 bridge.
The post-recovery 259-case native corpus passed trace-disabled preprocessing
parity and direct/prepared model construction with no failures, retaining 139
complete and 120 recovery snapshots. The Linux VSIX passed all 27
packaged-editor checks on each of VS Code 1.85.0 and 1.121.0. This adds
evidence for a specific malformed-directive repair only; broader recovery,
implicit special-member, and macro structural-refactoring coverage remains
unfinished.

Type-layout provenance checkpoint, 2026-09-10: all 200 local smoke, unit,
native-compiler, and TextMate checks passed with the protocol 12 bridge. The
259-case native corpus again passed trace-disabled preprocessing parity and
direct/prepared model construction with no failures, retaining 139 complete
and 120 recovery snapshots. It observed 46 parser families, adding the shared
`cTypeOrExpression` path without exceeding the existing trace limit. Focused
native checks cover expression-side `LEN`, `SIZEOF`, and `TYPEOF`, and three
malformed `SIZEOF` forms whose later independent `Double` expressions remain
authoritative. This leaves invalid-declaration recovery, implicit special
members, and macro structural refactoring open.

Declaration-`TYPEOF` recovery checkpoint, 2026-09-10: all 200 local smoke,
unit, native-compiler, and TextMate checks passed with the protocol 12 bridge.
The 259-case native corpus again passed trace-disabled preprocessing parity and
direct/prepared model construction with no failures, retaining 139 complete
and 120 recovery snapshots. The packaged Linux VSIX passed all 28
packaged-editor checks on each of VS Code 1.85.0 and 1.121.0. A declaration
ending in `TYPEOF(` now emits the expected diagnostic while the following
unsaved `Double` expression remains authoritative for hover and expression
inspection. This is one parser repair path, not general invalid-declaration
recovery coverage.

Structural-label and implicit-BYREF-constructor checkpoint, 2026-09-10: all
200 local smoke, unit, native-compiler, and TextMate checks passed. The Linux
VSIX passed all 28 packaged-editor checks on each of VS Code 1.85.0 and
1.121.0. Numeric-to-named label conversion now structurally rewrites either
branch of a QB single-line `IF` with `GOTO`, while validation permits only the
compiler's expected anonymous `ELSE` scope and verifies the shifted native
identities. Native operation-graph coverage also retains the selected
constructor and pointer conversion for a nontrivial BYREF UDT argument built
from a written ordinary expression. Macro structural refactoring and broader
special-member paths remain open.

Expression-side `LEN`/`SIZEOF` recovery checkpoint, 2026-09-10: all 200 local
smoke, unit, native-compiler, and TextMate checks passed with the protocol 12
bridge. The 259-case native corpus passed trace-disabled preprocessing parity
and direct/prepared model construction with no failures, retaining 139 complete
and 120 recovery snapshots. The Linux VSIX passed all 29 packaged-editor
checks on each of VS Code 1.85.0 and 1.121.0. An opening `LEN(` or `SIZEOF(`
at a physical line ending now reports its missing operand while the following
unsaved `Double` expression remains authoritative for hover and inspection.
This extends a specific expression-parser repair class; broader malformed
expression and declaration recovery remains unfinished.

Expression-route audit checkpoint, 2026-09-10: the Linux bridge builder now
enumerates all 69 upstream `c*` parser routines that return an AST from the
expression, quirk, and type-layout parser sources. Each route must be owned by
a generic parser wrapper or a named graph/symbol hook; new, duplicate, and
stale ownership entries stop the build. This turns source-route drift into a
reviewable compatibility failure, but does not prove the semantics of every
branch inside an already-owned route.

Expression-side `PEEK` recovery checkpoint, 2026-09-10: `PEEK(` at physical
end of line now reports its missing address while preserving the following
unsaved independent expression. The fix is scoped to the trace-only
optional-type decision used by `PEEK`; trace-disabled compiler behavior and
explicit continuation remain unchanged. All 202 local checks passed with the
protocol 12 bridge; the 259-case native corpus retained trace-disabled parity,
with no failures. The Linux VSIX passed all 31 packaged-editor checks on each
of VS Code 1.85.0 and 1.121.0. Other malformed quirk-parser paths still need
systematic recovery coverage.

Expression-side `PROCPTR` recovery, 2026-09-10: an opening `PROCPTR(` at
physical end of line now reports its missing procedure identifier before the
procedure-name parser can consume the following unsaved statement. This is a
separate identifier-parser repair path. Trace-disabled behavior and explicit
continuation remain unchanged. All 203 local checks passed; the 259-case native
corpus retained trace-disabled parity and prepared-model results with no
failures. The Linux VSIX passed all 31 packaged-editor checks on each of VS
Code 1.85.0 and 1.121.0. Broader malformed-expression coverage remains open.

Generic expression-route execution checkpoint, 2026-09-10: source fixtures
now execute every generic parser route in the compiler-source inventory, in
addition to the build-time ownership audit. Fixed-length string size expressions
exercise the parenthesis-only equality route, while `CInt<16>` and `CUInt<32>`
exercise the angle-width route. Their physical source ranges retain native
`integer`, `short`, and `ulong` types respectively. This proves each generic
wrapper can emit provenance once; it does not prove every branch or every
implicit lowering inside those parser routines.

Property-expression checkpoint, 2026-09-10: the native graph fixture now
requires compiler-selected calls and exact types for a property getter, setter,
and indexed getter. This covers the property branch in the normal function-call
parser, including its optional argument path. Other implicit special-member
and runtime-lowering paths remain open.

Overloaded-index checkpoint, 2026-09-10: the operation graph fixture now
requires a user-defined `[]` expression to retain its `Double` result, both
written operands, and the compiler-selected operator identity. This prevents
ordinary array-index handling from being mistaken for an implicit operator
call. Other special-member and runtime-lowering paths remain open.

Overloaded-member-dereference checkpoint, 2026-09-10: the same operation
fixture now requires a user-defined `->` expression to retain its exact member
type and selected operator identity before member access is lowered. This covers
the non-pointer `->` branch of the member-dereference parser. Other
special-member and runtime-lowering paths remain open.

Overloaded-address checkpoint, 2026-09-10: the operation fixture now requires
a user-defined `@` expression to retain its exact pointer type and selected
operator identity before the normal pointer-member path is applied. This covers
the overloaded address-of branch of the unary expression parser. Other
special-member and runtime-lowering paths remain open.

Dynamic-index checkpoint, 2026-09-10: dynamic-array selection now has a
dedicated regression that requires its compiler-selected element type and
explicit receiver/index graph dependencies. The compiler's preprocessed form
contains descriptor lowering that is not itself written source; the assertion
therefore checks the preserved semantic edge rather than assuming a textual
array expansion. Other special-member and runtime-lowering paths remain open.

Macro-argument recovery and variadic-rename checkpoint, 2026-09-10: an opening
parenthesis at physical EOL in a parameterized macro no longer lets macro
argument collection consume the following unsaved editor statement. Trace mode
reports the missing expression and substitutes only a generated recovery value
for the invalid invocation. Both intrinsic `RGB(` and an ordinary source macro
retain the following independent `Double` expression as authoritative; an
explicit continuation still follows the normal macro path. Validated project
rename now has a native regression for multiline variadic macro names and both
ordinary and variadic parameter slots. All 208 local smoke, unit,
native-compiler, and TextMate checks passed with the protocol 12 bridge. The
trace-disabled bridge still matches the ordinary compiler's preprocessing
output. The Linux VSIX passed all 31 packaged-editor checks on VS Code 1.85.0
and 1.121.0. This closes one expansion-time recovery path, not general
malformed macro or preprocessor recovery.

Allocation and iterator-operator checkpoint, 2026-09-10: source graph records
now retain compiler-selected custom UDT `NEW`, `NEW[]`, `DELETE`, and `DELETE[]`
operators at their written allocation statements. The allocation fixture checks
the selected operator identities, scalar versus vector allocation, and the
written element-count or pointer relationships without exposing fallback runtime
allocator calls as source procedures. A second fixture retains selected UDT
`FOR`, `STEP`, and `NEXT` calls and their written counter, end, and step
operands before loop lowering replaces them with compiler temporaries. All 210
local smoke, unit, native-compiler, and TextMate checks passed with the protocol
12 bridge. The 259-case native corpus again passed trace-disabled preprocessing
parity and direct/prepared model construction with no failures. This adds
coverage for these special-member paths; other lowering and malformed-buffer
recovery paths remain unfinished.

Assignment-operator checkpoint, 2026-09-10: source graph records now retain
the compiler-selected UDT `LET` and direct combined-assignment calls at their
written assignments. The fixtures require the selected procedure identity and
the written left and right operands for each form. The direct fixture also
requires the non-overloaded fallback to preserve its typed binary relationship,
without inventing a procedure target. An ordinary assignment that selects an
implicit cast now retains that selected cast as a dependency of the written
right-hand expression. A conditional branch that selects a cast retains the
same source-preserving selected conversion edge. All 216 local smoke, unit,
native-compiler, and
TextMate checks passed with the protocol 12 bridge. The 259-case native corpus
again passed trace-disabled preprocessing parity and direct/prepared model
construction with no failures.

Delimiter-recovery checkpoint, 2026-09-10: native regression coverage now
requires later independent `Double` expressions to remain authoritative after
29 incomplete allocation, conversion, intrinsic, pointer, string, array,
error, graphics, console, and runtime-query parser forms. The suite includes
`NEW`, `DELETE`, `CPTR`, `IIF`, `MID`, `INSTR`, `LINE INPUT`, `OPEN`,
`CVA_ARG`, dereference, `CAST`, `ABS`, `STR`, `LBOUND`, `CINT`, `ERR`,
`POINT`, `SCREEN`, `COMMAND`, `ENVIRON`, `DIR`, and `TIMER`. These forms use
the compiler's existing line-bound recovery and do not require an additional
trace-only parser rewrite. The 259-case corpus passed all preprocessing-parity
and direct/prepared model checks with no failures. This expands recovery
regression coverage without claiming general malformed-source support.

Selected-call audit checkpoint, 2026-09-10: the Linux bridge builder now
inventories all 31 active upstream `astBuildCall()`, `astBuildCtorCall()`, and
`astBuildImplicitCtorCall()` sites in its compiler source set. Every site is
assigned to a parser boundary, transform wrapper, statement hook, or
intentionally generated construction path. The audit ignores disabled compiler
comments and rejects unowned, stale, or changed enclosing-routine call counts
before a bridge build. This turns implicit-call source drift into a reviewable
compatibility failure; it does not prove every branch within an already owned
routine or replace native graph fixtures. Native fixtures cover selected unary
operators and casts selected during procedure-argument binding, and verify that
the editor-visible operand retains its source type. All 219 local smoke, unit,
native-compiler, and TextMate checks passed with this build gate.

Conditional macro-query checkpoint, 2026-09-10: active `#ifdef` and
`#elseifdef` operands now have direct native identity and validated
project-rename regressions across an unsaved shared header and its selected
translation unit. Absent `#elseifndef` operands remain deliberately unresolved
rather than being joined to an earlier or later macro lifetime. All 218 local
smoke, unit, native-compiler, and TextMate checks passed with the protocol 12
bridge. Complete preprocessor-scope completion and structural macro
refactorings remain open.

Ordinary procedure-argument recovery checkpoint, 2026-09-10: an incomplete
ordinary source call now has a direct unsaved-buffer regression alongside
quirk, macro, `PROCPTR`, and type-layout recovery. Independent expressions on
both sides retain authoritative `Double` types through a one-error, EOF-complete
compiler result. This is coverage of the compiler's existing recovery behavior,
not a claim that every malformed call is repaired.

Extension-host integration checkpoint, 2026-09-10: all 219 local smoke, unit,
native-compiler, and TextMate checks passed. The actual extension host then
passed all 31 integration checks on VS Code 1.85.0 and 1.121.0. Those checks
include native on-demand Outline, closed-module workspace-symbol search,
unsaved-header analysis, malformed-source recovery, physical/macro origins,
and validated multi-configuration rename. The Linux VSIX archive was also
rebuilt and verified. This confirms the covered provider paths run in both
editor hosts; it does not establish complete language coverage.

Native corpus checkpoint, 2026-09-10: all 259 selected upstream expression,
pointer, numeric, and overload cases passed trace-disabled preprocessing parity
against the stock FBC 1.20.4 compiler. The bridge also completed direct and
worker-owned models for every case, retaining 16,386 declarations, 5,457
scopes, 14,700 selected call records, and 348,818 physically projected editor
tokens with no audit failures. This is a bounded compiler-source sample, not a
claim that the complete upstream suite has run.

Directive macro-completion checkpoint, 2026-09-10: protocol 13 records the
compiler's active macro epoch at each conditional directive. An incomplete
operand such as `#if defined(` now completes compiler-active macros while
filtering a name after `#undef`, including a definition supplied by an earlier
include or an enclosing skipped branch. The source-mapped record replaces
neighbor-token inference at that directive; it does not guess macro scope from spelling. All 223 local smoke,
unit, native-compiler, and TextMate checks passed; the actual extension host
passed all 34 integration checks on VS Code 1.85.0 and 1.121.0. The 259-case
native corpus also passed trace-disabled parity plus direct and worker-owned
model construction with no audit failures.

Structural-container recovery checkpoint, 2026-09-10: `TYPE` and `ENUM`
scope hooks now pass the compiler's missing or mismatched terminator recovery
state to the trace. A recovered container taints its native symbol and any
dependent facts, while invalid declarations remain unavailable to editor
presentation and refactoring. All 224 local smoke, unit, native-compiler, and
TextMate checks passed with the protocol 13 bridge. The 259-case native corpus
again passed trace-disabled parity and direct/worker model construction, and
the extension host passed all 34 checks on VS Code 1.85.0 and 1.121.0. This
corrects two structural scope paths; unusual parser repair and other unclosed
containers remain open.

Explicit destructor and call-route checkpoint, 2026-09-23: scalar and vector
`DELETE` now retain the compiler-selected UDT destructor as an implicit call
dependency on the written pointer expression, while any overloaded deallocator
remains a separate graph edge. Native regressions verify both destructor edges
and preserve the pointer's source type. The compiler-source audit now covers
all 43 active direct call, constructor, and destructor builder sites through 37
owned routine routes, with no unowned, stale, or drifted routes. With
`FBC_EDITOR_EXECUTABLE` pointing to the rebuilt bridge, all 224 local test
cases completed: 223 passed, one was explicitly skipped, and none failed. All
259 native corpus cases passed
preprocessing parity and direct/worker model construction with no failures,
recording 14,724 selected calls. The extension host passed all 34 checks on
VS Code 1.85.0 and 1.121.0. Automatic scope-exit and temporary destruction
remain outside the source graph because they have no editable expression span.

Expression-parser inventory checkpoint, 2026-09-23: the ownership audit now
scans all 58 upstream `parser-*.bas` files, not only the expression and quirk
subsets. It assigns all 71 distinct AST-returning `c*` parser routines,
including declaration initializers, procedure argument lists, and statement
calls. It also records routine definition counts and explicitly expects the two
`cVariableEx` overloads, where the identifier-chain form delegates to the
source-emitting resolved-symbol form. The generic parser fixture continues to
execute every wrapped grammar route. This closes inventory blind spots; it does
not prove complete branches, precise typing for every construct, or complete
malformed-source behavior. The rebuilt bridge passed all 259 upstream corpus
preprocessing-parity and model checks with no failures, retaining 14,724 call
records. The VS Code 1.139.0 extension host passed all 32 integration checks.

Expanded native-corpus checkpoint, 2026-09-23: the bounded source audit now
includes 400 upstream cases across expressions, pointers, numbers, overloads,
quirks, and strings. All 400 matched stock FreeBASIC 1.20.4 trace-disabled
preprocessing and produced both direct and worker-prepared models with no audit
failures. The run retained 24,528 declarations, 7,461 scopes, 506,806 mapped
tokens, and 21,917 graph call nodes. Adding quirk and string suites exposed an
early parser-recovery token whose physical path was not yet declared as a
dependency; the bridge now flushes its bounded source-dependency identities at
completion. The string cases also exposed BOM-marked UTF-16LE disk input, which
is now decoded for editor snapshots and normalized to UTF-8 for overlays.
Malformed encodings remain rejected. This wider sample improves regression
evidence, but it is still a selected corpus and not branch-complete expression
typing or a run of the full upstream suite.

Qualified QB and route-coverage checkpoint, 2026-09-23: the native corpus now
covers 776 upstream tests across 15 suites, including file, graphics, sound,
thread, console, procedure, QB, command-sweep, and typedef cases. All 776
matched the stock 1.20.4 compiler's trace-disabled output and passed direct and
worker-prepared model construction. The run retained 46,327 declarations,
14,520 scopes, 744,128 mapped tokens, 1,300,220 macro-map nodes, and 32,238
call nodes; 411 snapshots were complete and 365 retained marked recovery
state. The `#lang "qb"` compiler restart exposed process-global trace counters
surviving a discarded compiler pass; the bridge now resets trace identities at
each compiler pass. Qualified compiler bindings are range-checked as complete
namespace paths and attached to their terminal editor token, with native
symbol identities retained for procedure resolution and refactoring. Numeric
label bindings remain supported. Dedicated parser-family assertions cover
`cViewStmt`, `cScreenFunct`, and the gas-backend `cVAFunct` route, while the
upstream corpus gate covers the remaining quirk families. All 219 of 220 unit
tests passed (one explicit skip), along with six smoke checks and two grammar
checks. The packaged Linux VSIX passed all 32 VS Code integration checks on
both the minimum supported 1.85.0 and 1.139.0. Native Outline and workspace
symbols therefore have package-level integration coverage; their completeness
does not follow from those fixtures alone.

Expression-range/type agreement checkpoint, 2026-09-23: the native corpus gate
now compares deduplicated compiler type records with native syntax nodes by
exact range, dtype, subtype, and rendered type. The latest 781-case run
contained 414 complete and 367 partial snapshots; all complete snapshots
matched with no missing expression/type ranges or identity mismatches. A
separate recovery sweep found 1,211 syntax ranges without typed records in
partial snapshots, and every range was marked invalid and provisional. The
native corpus audit now rejects any such gap that lacks recovery provenance.
A focused unit test verifies duplicate-range handling and that each missing
range or type identity discrepancy is counted. This proves agreement between
two bridge records on the sampled corpus, not that every branch is exercised
or that the compiler's own result matches a separate language-spec oracle.

Compiler semantic-sidecar checkpoint, 2026-09-23: the authorized `fbc`
`-semantic-model` schema 4 expression records provide source ranges,
physical-origin status, AST class/operator, compiler dtype, resolved
symbol/subtype identities, and compiler-formatted type spelling at completed
`cExpression()` boundaries. Unmarked UTF-8 source columns are counted as
UTF-16 units for editor coordinates, while macro-tainted spans are explicitly
non-editable. The extension keeps schema 2 and 3 compatibility and validates
schema 4 record bounds and identities. A native cross-check covers all 73
upstream expression fixtures: 27 compile completely, and 1,861 physical
runtime-expression ranges map to editor expressions with identical compiler
types. The remaining 22 facts are compile-time `#if`/`#assert` expressions,
which the ordinary preprocessed expression graph cannot represent.

That differential found two source-coordinate edge cases and drove regressions
on both sides of the boundary. The compiler omits empty or reversed parser
spans, such as a macro default argument with no source text. The editor now
projects numeric tokens when the lexer removes a type suffix or redundant
decimal leading zeroes (for example, `0.9f` becomes `.9` in parser text). A
native test covers 12 integer/floating suffix forms, including selection of the
whole written expression and a cursor on the suffix. Physical `#if`,
`#elseif`, and `#assert` ranges now use the compiler sidecar as a narrow
production fallback for expression hover/type queries, including unsaved
included headers. The sidecar is requested only when those directives occur;
its reader retains only bounded, physical directive facts, and absent,
oversized, incomplete, or error-recovery sidecars do not replace the regular
editor graph. Runtime expression queries continue to use the richer editor
expression graph. The upstream differential now resolves all 22 previously
unmapped directive facts, and the VS Code host verifies both directive hovers
in a dirty included header. The sidecar still omits some special built-in
routes and is not a complete compiler expression tree.

Semantic-sidecar hardening checkpoint, 2026-09-24: the compiler option no
longer enables debug-info mode merely to collect parser line markers, so
requesting a sidecar leaves source-visible predefined values such as
`__FB_ERR__` unchanged. The compiler smoke test asserts this and also covers a
C-varargs procedure, whose absent parameter/local symbol pointers use the
compiler's `INVALID` sentinel. The exporter now rejects that sentinel before
symbol-table access. On the bridge, malformed or stale macro-map identities
are bounds-checked and degrade to unknown physical provenance rather than
crashing or inventing source coordinates.

The hardened bridge passed the full native corpus audit: 781/781 files matched
compiler parity with zero failures (414 complete and 367 partial analyses).
It reported 324,808 typed expressions out of 326,019 syntax expressions, with
the 1,211 remaining cases classified as invalid or provisional and no missing
syntax ranges or expression-type mismatches. The 32 packaged-editor integration
checks also passed on VS Code 1.139.0. These results validate this bridge slice
against the current corpus; they do not establish full expression coverage or
close the remaining project-refactoring and broken-code requirements.

Nested directive-expression checkpoint, 2026-09-24: a compiler sidecar can
contain overlapping `E` ranges when a nested parser call produces a more
specific expression than the enclosing directive. A native regression now
distinguishes a `Double` member expression inside `#assert typeof(...)` from the
enclosing `Integer` comparison, both in the sidecar smoke and in the actual
VS Code hover path for an unsaved included header. This validates narrowest
range selection for one nested type-layout route; other special parser and
constant-folding routes remain open.

Compiler expression supplement checkpoint, 2026-09-24: the supplied `fbc`
source now offers `-semantic-model-expressions`, an expression-only mode that
keeps schema 4 but emits only module and typed-expression records. The original
`-semantic-model` output remains unchanged. The extension requests compact
facts for complete editor analyses, validates their physical coordinates
against captured source buffers, and supplements missing bridge-trace answers
without mixing the two compiler identity spaces. Contradictory repeated-header
spans from distinct namespace or macro contexts remain untyped because a
source-only query cannot identify the active include instance.

The expression-sidecar audit passed all 781 native test modules (414 complete,
367 partial) with stock-compiler parity. Among 37,263 physical facts, 7,759
were compile-time directive expressions and 29,504 runtime ranges were
compared. The bridge trace missed 334 ranges; the sidecar safely supplied 300,
and 34 were withheld as context-ambiguous. There were no unresolved
unambiguous ranges or type disagreements. A worker-backed regression confirms
the initializer fallback through the actual compiler query path. All 239 unit
tests also pass with the native bridge.
The VS Code host also verifies type inspection and hover on a physical
initializer omitted by the bridge trace: all 35 integration checks pass on
both VS Code 1.85.0 and 1.139.0.

Compiler semantic reconciliation checkpoint, 2026-09-23: complete physical
sidecar facts now correct an editor-trace type only when both annotations
refer to the exact same source span and the compiler types disagree. This
covers inherited `New DerivedType` expressions, where the parser trace can
describe the UDT while the compiler semantic model correctly reports its
pointer result. The focused virtual corpus passed 92/92 parity checks; all 71
observed trace disagreements were corrected, with no unresolved or ambiguous
physical ranges. A regression exercises the correction through
`CompilerSemanticModel.expressionAt()`.

The source-buffer reader now accepts strictly validated UTF-16BE and UTF-32LE/
BE as well as UTF-8 and UTF-16LE, retaining the BOM and rejecting malformed
code units, invalid Unicode scalar values, and embedded NULs. The upstream
wide-string corpus passed 39/39 parity checks, including the additional
encodings, with 1,654 runtime expressions compared and 61 missing trace ranges
supplied by the sidecar.

Expanded native semantic audit checkpoint: 2,421 of 2,422 modules produced
models and matched trace-disabled compiler parity (1,107 complete and 1,314
partial), with no effective compiler-sidecar type mismatches. The remaining
module, `compound/select_const2.bas`, exceeds the intentional 32 MiB
analysis-output bound and is rejected before any partial model can be
published.

Repeated-location range checkpoint, 2026-09-23: `#line` may map distinct
physical lines to the same reported path and line. The semantic exporter's
physical-line bound cache now includes the lexer's physical file position, so
a longer earlier line cannot make a later out-of-line parser span appear
editable. A native regression reproduces this with consecutive macro
expansion and repeated `#line` mappings; the compiler smoke and all 245
runnable unit tests pass on the rebuilt bridge. The focused preprocessor audit
also passed 130/130 parity checks, with 889 runtime expression comparisons,
37 safe sidecar supplements, and no missing or mistyped ranges.

The macro-adjacent physical-range defect in
`pp/expansion-consecutive-3.bas` is fixed in the supplied FBC semantic
exporter. Its ASCII-compatible line-bound check follows the lexer's UTF-16
column counting, caches the current line bound, and downgrades parser-cursor
ranges that extend past the physical line. The full `pp` corpus now passes
130/130 parity checks; the compiler smoke asserts the bad range is retained
as non-physical, while an editor regression verifies the actual written
integer literal still has a usable type at its correct token span. The wide-
string subset and full test suite were also rerun on the rebuilt bridge.
Current local checks pass 246 unit tests, 6 smoke tests, and 2 TextMate tests;
one platform-conditional unit test is skipped.

Long-line range checkpoint, 2026-09-23: the lexer's diagnostic excerpt is only
1 KiB, so using it as the semantic line bound incorrectly marked valid late-
line expressions as non-physical. The exporter now reads the complete
ASCII-compatible physical line in bounded chunks, restores the compiler input
position, and fails closed at the lexer line-size limit. A long-line fixture
with a supplementary Unicode character verifies UTF-16 columns and physical
range status both from disk and through an unsaved source overlay; the overlay
test also verifies the original file remains unchanged. The FBC semantic-model
smoke passes. The unit suite passes 247 tests, with one platform-conditional
test skipped, and the focused `pp` semantic audit remains 130/130 with zero
missing or mistyped expression ranges.

Expression-only semantic range checkpoint, 2026-09-23: the compiler's compact
`-semantic-model-expressions` mode now emits completed binary-precedence
results as well as the outer `cExpression()` result. This exposes nested typed
ranges such as `3 * factor` inside `2 + 3 * factor` without changing the full
`-semantic-model` output or mixing sidecar IDs into the native trace graph.
Compiler smoke and editor fallback tests cover exact nested ranges, the `Double`
type, an unsaved overlay, and `TYPEOF()`/comparison types in an unsaved header.

The full upstream semantic audit constructed 2,421 models with compiler parity
across 2,421 of 2,422 modules; `compound/select_const2.bas` remains rejected at
the existing 32 MiB analysis bound. Across 1,107 complete snapshots, 951,457
physical sidecar facts were read, including 312,645 directive facts and 638,812
runtime comparisons. The richer sidecar supplied 5,616 ranges missed by the
trace, corrected 1,251 trace type disagreements, and withheld 442
context-ambiguous ranges, with no unresolved or mistyped physical facts. The
full unit suite passes 248 tests (one platform-conditional skip), the FBC
semantic-model smoke and two TextMate grammar tests pass, and all 32 packaged
editor-host checks pass on both VS Code 1.85.0 and 1.139.0. A seven-run local
comparison on the expression-surface fixture measured 27 ms median analysis
before and 26 ms after with semantic export disabled; this is a noise-level
local check, not a general performance guarantee.

Binary-operator recovery checkpoint, 2026-09-23: unsaved-buffer regressions now
leave each of the 24 arithmetic, concatenation, bitwise, logical, relational,
short-circuit, and RTTI `IS` forms unfinished before a later independent
`Double` expression. Every compile reports an error, reaches EOF, and retains
the later expression as authoritative. This broadens broken-code coverage
across the precedence parser without changing normal compiler behavior.

Numeric-origin revalidation checkpoint, 2026-09-23: after accounting for
numeric type suffixes and the compiler's leading-zero normalization, the full
781-case corpus again passed stock-compiler preprocessing parity and direct
and worker-prepared model construction. The bridge projected 748,198 tokens,
including 472,876 macro-origin tokens, without an audit failure. The separate
expression audit still reports zero type disagreements and marks every
untyped range in partial snapshots as invalid and provisional. The final
editor integration pass also retained all 34 checks on VS Code 1.85.0 and
1.139.0.

Unary and primary-expression checkpoint, 2026-09-23: expressions-only semantic
output now exports completed unary results and completed results from the
highest-precedence parser route. The unsaved-overlay sidecar-only regression
queries nested binary expressions, unary negation, direct and chained UDT
members, indexed members, a UDT method call, and a builtin call without relying
on bridge expression records. The FBC smoke verifies exact ranges and types
for binary, unary, member, and builtin-call expressions, while the existing
full-model smoke continues to validate its independent record totals. The
compiler bridge hook emits the pre-member AST at its original parser boundary
so native editor analysis retains prefixes such as a conversion before a
pointer-member chain. The native compound-expression regression and complete
unit suite pass on the rebuilt bridge; grammar and FBC semantic-model smoke
checks pass as well.

Special-expression checkpoint, 2026-09-24: sidecar-only unsaved-buffer queries
now verify complete `SIZEOF()` and `IIF()` result ranges together with their
typed nested arithmetic and condition/branch expressions. The FBC smoke checks
exact physical ranges for `SIZEOF()` and `IIF()` results and operands. This
confirms compiler-specific routes that re-enter the common expression parser;
routes with generated-only operands and any AST removed before an export point
still require explicit coverage. A six-category upstream audit (expressions,
functions, overload, quirk, pointers, and structs) passed parity on all 705
modules, including direct and worker-prepared models. Across 356 complete
snapshots it compared 207,725 physical sidecar ranges with no unresolved or
mistyped queries. The sidecar supplied 112 ranges absent from the editor trace,
corrected 266 trace type disagreements, and withheld 476 context-ambiguous
ranges.

Packaged provider checkpoint, 2026-09-24: a Linux package-integration command
now rebuilds the VSIX, rejects unsafe archive paths, installs it into an
isolated editor profile, checks that the native Outline/workspace-symbol
modules and entry point are present, and asserts the active extension path is
the installed VSIX. All 32 checks passed with the native compiler enabled on
both minimum VS Code 1.85.0 and stable 1.139.0, including on-demand native
Outline and closed-module workspace-symbol search. This verifies the installed
package and those exercised provider routes, not the completeness of every
declaration or workspace context.

Repeated-operator expression checkpoint, 2026-09-24: expressions-only
`-semantic-model` now exports each completed left-associated operator prefix
before the next operator can fold or replace the AST. This covers arithmetic,
logical, relational, concatenation, bitwise, shift, integer-division, MOD, and
exponentiation chains while leaving ordinary compilation and full-model output
unchanged. A compiler-backed editor test drops the normal expression trace and
still queries folded `Integer` and subsequent `Double` prefixes inside a longer
mixed-type chain, and exercises each of the twelve binary precedence routes
from an unsaved overlay. The native sidecar suite passed 21/21 tests. The
six-category upstream audit passed parity and direct/worker model preparation
for all 705 modules; it compared 207,767 physical runtime sidecar ranges
without a missing or mistyped editor query. The sidecar supplied 112 trace-missing ranges,
corrected 266 trace type disagreements, and withheld 476 include-context
ambiguities. This improves compiler-owned intermediate typing but does not
close complete expression grammar coverage or the other compiler-grade
requirements. The rebuilt bridge passes 248 unit tests (one platform-conditional
skip), and both TextMate grammar tests pass.

Implicit quirk-call checkpoint, 2026-09-24: the compiler-backed quirk fixture
now checks additional string-helper overloads and numeric conversion branches,
including `CVI` fixed-width forms and each `MK*` runtime helper selected by the
compiler. The test verifies both result types and the exact resolved runtime
procedure identities, preserving target-dependent behavior such as plain
`CVI` following the configured `Integer` width. The focused native test passes,
and the complete bridge-backed unit suite passes 248 tests with one
platform-conditional skip. This is branch-level coverage of representative
compiler rewrites, not exhaustive validation of every constant-folding or
error-recovery path.

Expressions-only upstream checkpoint, 2026-09-24: the successful
`tests/expressions` corpus cases now run through `-semantic-model-expressions`
as part of native analysis. The regression removes all bridge expression
records, then requires at least 1,700 physical source ranges to resolve from
the compact compiler sidecar alone and match the full semantic model's type.
A range may be withheld only when the model records it as ambiguous. The
corpus check passes together with the complete native-backed unit and grammar
suites. Failed compiler cases and recovery-created or generated-only
expressions remain separate coverage requirements; successful-corpus parity
does not establish complete grammar coverage.

Positioned recovery checkpoint, 2026-09-24: protocol 14 adds the compiler error
code and optional lookahead location to parser-error records. Recovery still
withholds declarations, bindings, and token resolution across the complete
failed statement. Only `FB_ERRMSG_EXPECTEDEXPRESSION` can retain a committed
expression whose full range ends before the missing-operand location, using a
separate direct-token projection that is available to expression queries but
not rename or symbol resolution. A native unsaved-buffer test now types
`(value * 2)` before a dangling `+`, withholds the malformed enclosing range,
and retains the later statement; a `Type mismatch` control keeps its left
operand withheld. The native-backed suite passes 250 tests with one
platform-conditional skip, and both grammar tests pass. Other parser and
semantic error classes remain conservatively statement-wide.

Post-recovery semantic corpus checkpoint, 2026-09-24: the full 2,422-module
semantic-sidecar audit rebuilt models and matched trace-disabled compiler
preprocessing for 2,421 modules; the remaining module,
`compound/select_const2.bas`, exceeded the explicit 32 MiB analysis-output
limit. The 1,107 complete and 1,314 partial snapshots retained 877,207 typed
ranges against 880,799 syntax ranges, with no missing ranges or type
mismatches; every untyped partial range had recovery provenance. Across
694,582 physical runtime expressions and 340,769 compile-time directive
expressions, the sidecar supplied 6,091 trace-missing answers and corrected
1,358 trace-type disagreements. Another 476 repeated include-context ranges
were conservatively withheld. There were zero unresolved unambiguous ranges
and zero sidecar/editor type disagreements. All 2,421 models also passed
worker preparation and semantic-token parity. The audit's only failure is the
documented oversized module; the successful corpus does not cover every
compiler-generated or recovery-only expression path.

Compiler semantic recovery checkpoint, 2026-09-24: the authorized FBC sidecar
now uses schema 5. Expression-only output can retain parser-produced `E` facts
from a failed module only with an `R` module record and an explicit `RECOVERY`
footer; the complete `END` contract and full `-semantic-model` records are
unchanged. The editor accepts that form only when it matches a partial native
snapshot, drops any fact overlapping a source token retracted by native
recovery, and marks retained facts provisional. Recovery facts can fill a
missing type query but cannot correct or replace an existing native expression
answer. Incomplete or interrupted sidecars remain rejected. Native regressions
cover a later valid expression, an expression on the failed line that must be
withheld, a conflicting native result that must win, and compiler-typed
expressions in an unsaved included header. The bridge-backed suite passes 252
tests with one platform-conditional skip; the FBC semantic-model smoke and two
TextMate grammar tests also pass. The Linux-packaged VSIX passes all 33
integration checks on both the minimum supported 1.85.0 and stable 1.139.0.

The schema-5 targeted upstream audit then passed 823/823 files across
expressions, functions, declarations, preprocessing, syntax, and overloads:
314 complete and 509 partial snapshots, each with direct and worker-prepared
models. Compiler preprocessing parity had no failures. Among the complete
snapshots, 140,864 runtime and 105,939 directive expressions were compared;
there were no unresolved or mistyped results, 601 sidecar supplements, 14
trace-type corrections, and 476 context-ambiguous ranges withheld. Across
complete and partial snapshots, no syntax range was missing and every
expression without a type carried invalid or provisional recovery provenance.
The recovery-query audit now also checks each partial fact against its
physical source range and editor query. Of 46,313 physical recovery facts,
20,114 overlap compiler error lines and 587 overlap retracted source tokens.
The editor retained 1,778 existing native answers and supplied 308 distinct
provisional recovery ranges. There were zero unsafe retained facts, unresolved
safe queries, type mismatches, or unmarked recovery answers. Exact source-range
queries use prebuilt native and sidecar indexes instead of scanning every
expression record; the 252-test unit suite passes after this change. This
closes the prior partial-sidecar audit gap, but the oversized module, ambiguous
include contexts, and paths outside upstream tests remain open boundaries.

Deferred-macro refactoring checkpoint, 2026-09-24: project rename now has a
compiler-validated two-context regression for an unexpanded replacement-list
identifier whose macro is undefined and conditionally redefined. The preview
updates the deferred physical token and every source declaration/lifetime in
both configurations. The token remains unresolved for navigation until an
observed expansion selects one target.

Ambiguous macro and implicit-member rename checkpoint, 2026-09-24: project
rename now has a two-build regression where one deferred macro replacement
token selects different native variables. The transaction refuses the rename
because the same physical token has conflicting targets, leaving disk sources
unchanged. A separate cross-module, cross-configuration regression renames a
field referenced through nested `WITH` scopes and verifies the declaration and
both implicit/explicit uses appear in the preview. These cover a refusal
boundary and one implicit-member route; other macro contexts and implicit
relationships remain open.

Local error-label checkpoint, 2026-09-24: a compiler-validated project-rename
regression now covers the named handler in `ON LOCAL ERROR GOTO` inside a
procedure. The declaration and handler reference produce one two-edit preview,
and the saved source remains unchanged. Other uncommon label and implicit
reference forms remain open.

Namespace-import rename checkpoint, 2026-09-24: a compiler-validated regression
selects a namespace through `USING` and renames its declaration plus imports in
two translation units under both configured build contexts. The preview
contains exactly those three physical edits, and validation leaves all source
files unchanged. This verifies namespace import references are native-bound;
other import, macro, and implicit relationship forms remain open. The full
native-backed suite passes 272 tests with one platform-conditional skip.

Macro conditional-value rename checkpoint, 2026-09-24: compiler-validated
project rename now includes a macro used directly as a `#if` expression, in
addition to `#ifdef` and `#elseifdef` queries. Across both configured build
contexts, the preview contains exactly the macro declaration and three
conditional references, including the direct-value operand; it does not write
the unsaved shared header. The focused regression and the full native-backed
unit suite pass, with 276 tests passing and one platform-conditional skip.

Semantic-sidecar benchmark checkpoint, 2026-09-24: the analysis benchmark now
opts into the expression-only `-semantic-model` mode used by interactive
analysis and reports retained compiler-expression counts. A Linux/Node 22 run
reported 15,094 facts for `ast-node-call.bas` and 33,195 for `parser-proc.bas`.
Prepared warm analysis took 1.64 s and 3.04 s respectively, with 14–15 ms
largest host timer gaps; worker-side semantic decode took 268 ms and 943 ms,
and worker model construction took 522 ms and 686 ms. Token queries took
17–60 ms with 6 ms host gaps. This is one local measurement, not a latency
target. It shows the new semantic export is included in production-like
measurements and that its large decode/model costs remain in the worker; it
does not yet justify a compiler-side speed optimization. More adversarial
unsaved-edit traces and recovery responsiveness remain open.

Semantic recovery-route checkpoint, 2026-09-24: the `RECOVERY` sidecar path is
now checked from compiler facts alone across nine malformed parser families:
binary precedence, type layout, PEEK, allocation, conditional quirk, type
conversion, intrinsic macro, procedure-pointer, and procedure-argument
parsing. Each compile must reach EOF, keep valid `Double` expressions on both
sides of the error, and withhold any expression query on the damaged line. The
complete native-backed unit suite passes 259 tests with one platform-
conditional skip. This exercises representative recovery routes, not every
parser repair or multi-error interaction.

Quirk-sidecar route checkpoint, 2026-09-24: the compiler's existing quirk
expression type matrix now runs with required semantic export and repeats each
query after removing bridge expression records. The compiler facts match the
expected types across the tested conversion, string, math, array, file, error,
console, graphics, sound, and vararg forms. A separate x86-64 gas-backend
check also verifies sidecar-only typing for `VA_FIRST()`. All 73 native
compiler-analysis tests pass. This proves the listed branches, not every
overload, target ABI, language mode, or error path in those parser families.

Expression-prefix sidecar checkpoint, 2026-09-24: the authorized FBC
`-semantic-model-expressions` exporter now captures completed receiver,
member, fixed-array-index, and UDT-returning call prefixes before later parser
steps extend or lower their AST. Native smoke and sidecar regressions verify
exact physical ranges and compiler types for variable, indexed, and call-result
chains. This improves the compiler-owned fallback without claiming complete
coverage of every generated expression or parser-repair path.

Implicit-expression sidecar checkpoint, 2026-09-24: a sidecar-only regression
now removes the editor expression graph before querying compiler types. It
covers overloaded binary operators, explicit UDT constructors and conversions,
user-defined indexing, arrow and address operators, function-pointer calls,
UDT-returning calls, conditional UDT construction, and unary operator results.
These routes retain their compiler result types without trace fallback. This is
a targeted lowering matrix, not branch-complete coverage of all intrinsic,
generated, or recovery expression paths.

THREADCALL sidecar checkpoint, 2026-09-24: the compiler's expression-only
semantic export now records the written `THREADCALL procedure(arguments)` range
and the `Any Ptr` type returned by its lowering helper. A sidecar-only test
removes all bridge expression records before querying that exact source span.
The malformed `THREADCALL procedure(` recovery case also verifies that the
damaged line stays untyped while independent `Double` expressions after it
remain available. The bridge hook was kept compatible with the updated
compiler parser, and the full native-backed unit suite passes 264 tests with
one platform-conditional skip. This closes one special quirk-parser omission;
other generated and implicit expression paths remain open. The focused
upstream `threads` audit passes trace-disabled parity on all 16 modules and
compares 5,944 runtime expression facts, including eight `cThreadCallFunc`
routes, with no unresolved or mistyped answers. The recovery audit checked 504
safe facts with no unresolved, mistyped, unprovisional, or unsafe answers.

Incomplete-container recovery checkpoint, 2026-09-24: native recovery tests
now exercise missing TYPE, ENUM, UNION, and NAMESPACE terminators. They verify
that the compiler scope is provisional and that a declaration nested in an
unterminated namespace is not presented as authoritative. This extends
structural recovery coverage without changing the existing fail-closed scope
policy; other parser-repaired block forms remain open.

Upstream semantic-sidecar sweep, 2026-09-24: the expression-only compiler
export was required across 2,421 of 2,422 upstream compiler cases. It emitted
1,041,582 physical expression facts, of which 700,696 were independently
compared with editor queries. There were no unresolved or mistyped editor
answers; 6,111 compiler facts supplemented absent trace ranges, 1,465 corrected
trace types, and 500 contradictory include-instance ranges were withheld. In
recovery snapshots, 25,785 safe facts were checked and no unsafe, missing,
mistyped, or unprovisional result was found. The remaining `compound/select_const2.bas`
case intentionally generates over 1.3 million trace records: its instrumented
snapshot is 89.6 MB, above the extension's 32 MiB safety bound, while ordinary
preprocessed output is 1.75 MB and the semantic sidecar is 74 KB. The native
corpus audit now classifies that exact bound separately and still checks plain
compiler parity. This is broad grammar evidence under the configured resource
limit, not a proof over arbitrary macro-generated source. The focused compound
audit verifies the classification and reports all 51 files compiler-parity
clean; the complete native-backed unit suite passes 260 tests with one
platform-conditional skip.

Unsaved included-header recovery checkpoint, 2026-09-24: the native analysis
regression now overlays both a root module and an unsaved header, places a
syntax error in the header, and follows it with a valid `Double` expression.
After removing bridge expression records, the compiler recovery sidecar still
answers the later header expression provisionally while withholding the
damaged line. A prepared-worker regression also confirms the unsaved header
overlay survives serialization, the damaged expression remains unavailable,
and the later `Double` query leaves the disk header unchanged. Diagnostics
retain the header's physical path, and no file is created or saved by analysis.
This closes one malformed unsaved-header route; other parser errors and
edit-during-recovery interleavings remain open. The native-backed unit suite
passes 261 tests with one platform-conditional skip after these regressions.

Stale worker-model reclamation checkpoint, 2026-09-24: the service now releases
worker-owned native graphs and their expanded-source views when a source
snapshot is replaced, an open source changes, or a prepared result becomes
stale before publication. A worker protocol command removes only the selected
prepared model, preserving other translation-unit snapshots. A native race
regression completes a broken unsaved-buffer analysis, edits the buffer before
the service accepts the reply, and verifies that the partial result is not
published and its worker model is released. The full native-backed suite passes
264 tests with one platform-conditional skip. This reduces stale graph
retention; responsiveness under sustained edits and large recovery traces still
needs measurement.

Malformed-overlay responsiveness checkpoint, 2026-09-24: the analysis
benchmark now inserts an unsaved syntax error before 2,000 valid expressions,
requires parser recovery to reach EOF, checks that a later `Double` expression
is authoritatively typed, and verifies that the fixture on disk is unchanged.
The 54 KB overlay produced one parser error and 32,719 semantic expression
records. In one local run, direct analysis took 693 ms with a 324 ms largest
host-thread timer gap; direct semantic-model construction added a 302 ms gap.
Prepared-worker analysis took 1,243 ms cold and 847 ms warm, with largest host
gaps of 11 ms and 6 ms; the later expression query took 1.5 ms cold and 1.0 ms
warm and returned non-provisional `Double`. The prepared snapshot's estimated
model weight was about 68 MB. These timings are machine-specific, but confirm
that editor responsiveness depends on keeping preparation off the extension
host thread. This single stress shape does not characterize sustained edits,
large-file cancellation, or peak resident memory; those remain open.

Packaged Outline/workspace-symbol checkpoint, 2026-09-24: the Linux builder
created and installed the current 1.20.4 VSIX into isolated VS Code profiles,
then ran the extension-host suite with the native compiler bridge enabled.
All 32 checks passed on the minimum supported VS Code 1.85.0 and on the stable
channel's 1.139.0 build. The symbol checks cover native document Outline
hierarchy and a closed configured module; the workspace lookup now uses a
case-insensitive qualified query, checks its container, and rejects an
unmatched qualified query. This verifies those providers across the supported
editor range; repeated-workspace performance and other host platforms remain
open.

Semantic-sidecar duplicate suppression checkpoint, 2026-09-24: the compiler
now omits only adjacent `E` records whose payload fields match after their
unique IDs, returned repeatedly while parser tiers unwind. Distinct ranges,
types, identities, and facts separated by another record are retained, and
footer totals count records actually written.
On `src/compiler/parser-proc.bas`, this reduced 36,682 records / 3.28 MB to
3,147 records / 278 KB, with no adjacent duplicates remaining. The upstream
`expressions` audit stayed parity-clean across 73/73 cases; 2,745 ordinary and
70 recovery-safe facts had no missing or mistyped answers. This reduces sidecar
decode and model-construction input, but has not yet been measured across the
full editor responsiveness benchmark or the full upstream corpus. The full
native-backed unit suite passes 264 tests with one platform-conditional skip.
The malformed 2,000-expression overlay benchmark now retains 6,066 facts,
down from 32,719 before suppression, and its estimated prepared-model weight
fell from about 68 MB to 41 MB. Prepared cold/warm host timer gaps were about
11/15 ms and later-expression queries took about 1.4/0.8 ms in this run. These
single-run timings are machine-specific and do not measure sustained editing.

Oversized-trace semantic fallback checkpoint, 2026-09-24: interactive analysis
now retries a module when its traced preprocessed snapshot crosses the 32 MiB
limit and compiler expression facts were requested. The retry disables trace
instrumentation, retains immutable unsaved-buffer redirection, and accepts only
a complete bounded expression sidecar with a preprocessed snapshot under the
same output limit. A 64 MiB live sidecar guard remains in place. Such a result
is explicitly marked sidecar-only: physical expression types remain available
when the compiler emitted facts for the selected pass, while native symbols,
calls, and refactoring data are not claimed. A dependency-discovery pass may
have no selected physical facts yet; its complete root/include inventory is
retained so the worker can retry after resolving includes. Project refactoring
does not use this reduced model. Both direct analysis and the prepared-worker
query path now type an appended unsaved `Double` expression in
`compound/select_const2.bas`, whose trace exceeds the resource limit, and both
confirm that the disk source remains unchanged. The focused upstream `compound`
parity audit now passes 51/51 cases, including that oversized module, with 1,875
expressions compared and no type mismatch or missing semantic facts. The
compiler's schema-6 smoke test also verifies exact root/header dependency
inventory in complete and expression-only output. This closes the known corpus
hole for expression queries; it does not remove the resource bound or restore
the richer native trace features for this module.

Full semantic-corpus checkpoint, 2026-09-24: the current schema-6 bridge passed
stock-compiler parity and direct/prepared model construction for all 2,422
portable upstream `.bas` cases. All 1,108 complete analyses had matching types
for every native syntax range, with no missing syntax, missing types, or type
mismatches. The 1,314 partial analyses had no untyped
range lacking invalid/provisional recovery provenance. Across 89,379 compiler
sidecar facts, the audit compared 60,807 physical non-directive expressions to
the editor model and found zero missing or mistyped answers; 28,572 directive
facts were checked through the sidecar path. Recovery coverage checked 3,890
facts, including 2,102 safe post-error ranges, with no unsafe retained range,
missing answer, unprovisional answer, or mismatch. Trace disagreement was
handled conservatively by 504 sidecar supplements and 107 compiler-selected
overrides. This substantially strengthens current corpus evidence, but it is
not a proof over arbitrary user projects, untested compiler configurations, or
every generated/lowered expression path.

Fallback cancellation checkpoint, 2026-09-24: a process-controlled regression
forces the trace output limit, waits until the trace-free semantic retry starts,
then cancels it and verifies the second compiler pass aborts and no reduced
model is returned. The full native-backed unit suite passes 270 tests with one
platform-conditional skip after this regression. This closes the cancellation
interleaving between the bounded trace pass and its semantic fallback; stale
publication during repeated edits and sustained large-file responsiveness
remain open.

Rapid recovery-edit checkpoint, 2026-09-24: a native-worker regression now
holds publication after each completed preparation while the unsaved buffer
changes from one broken version to a second broken version and then a valid
third version. Only the final snapshot is published; the two stale partial
worker models are released, the newest `String` expression query succeeds, and
the saved source is unchanged. This covers three successive content generations
through the publication race, but it does not measure compiler cancellation
latency during edits or sustained keystroke throughput.

Active native-cancellation checkpoint, 2026-09-24: a worker regression waits
until the real FBC child has spawned for a 20,000-expression unsaved overlay,
then cancels it and checks that the child is reaped, its scratch directory is
removed, the saved source remains unchanged, and the same worker can analyze a
valid request afterward. The analysis-service regression also edits that active
buffer, queues a small current version, and verifies that only the latest model
is retained and queryable. In the latest full-suite Linux run, process cleanup
took 5.8 ms and edit-to-current-model publication took 74 ms. The native-backed
unit suite passes 276 tests with one platform-conditional skip. This checks
prompt cancellation and a single edit/requeue interleaving; it does not measure
sustained edit throughput or peak resource use across platforms.

Sustained recovery-edit checkpoint, 2026-09-24: a new native-worker stress
regression repeatedly edits a 20,000-expression malformed unsaved buffer while
each previous FBC process is active. Five obsolete runs are cancelled while
their replacements queue; every old process and scratch directory is reclaimed,
only the final valid `String` model remains queryable, and the disk fixture is
unchanged. Four local repetitions recorded maximum obsolete-result discard
latencies of 1–6 ms, cleanup-to-next-process times of 10–29 ms, final
edit-to-model publication of 45–60 ms, and sampled process RSS of 105–111 MiB.
These measurements are machine-specific and the sequence is a bounded edit
burst, not a long-duration keystroke or multi-platform memory profile. The
full native-backed `npm test` pipeline passes with 310 unit tests, one
platform-conditional skip, all six smoke tests, and both TextMate tests.

Interleaved-error recovery checkpoint, 2026-09-24: an unsaved module now puts a
dangling binary expression and malformed `PEEK` on separate lines with valid
expressions between and after them. The compiler reports exactly two errors
and reaches EOF. With bridge expression records removed, the semantic recovery
sidecar still answers all four unaffected `Double` ranges provisionally and
withholds both damaged lines. The saved fixture stays unchanged. This covers
one two-error interaction, not arbitrary recovery sequences.

Language-mode expression checkpoint, 2026-09-24: a single source fixture now
checks 24 expression shapes and 12 completed same-precedence prefixes under
default/explicit FreeBASIC, FB-Lite, QB, deprecated, and extended-syntax
options. Coverage includes unary and binary operators, comparison, string
concatenation, member access, array indexing, explicit conversion, user and
intrinsic calls. It checks exact compiler sidecar types and editor queries,
and requires the sidecar to provide each prefix whenever bridge trace is
missing or disagrees. QB's 16-bit `Short` results for `Not`, bitwise `And` and
`Xor`, array access, `CInt`, and integer arithmetic are distinguished from its
32-bit comparison, `Len`, and short-circuit logical results; `Shl` is excluded
in QB because that mode rejects its syntax. The same fixture checks
`SizeOf(Any Ptr)` under 32-bit and 64-bit x86 targets. This remains a focused
configuration matrix, not exhaustive mode-specific grammar or architecture-
dependent type coverage. The full native-backed unit suite passes 285 tests
with one platform-conditional skip.

Graphics implicit-cast checkpoint, 2026-09-24: a native `Line` statement now
exercises the compiler's graphics image-coercion path, which accepts a UDT and
invokes its user-defined `Cast() As Any Ptr`. The operation graph retains the
selected cast symbol, pointer result, and written UDT operand; the expression
sidecar and cursor query continue to report the source expression as its UDT
type. This closes one implicit graphics-call branch, not all statement-level
runtime lowering. The full native-backed unit suite passes 277 tests with one
platform-conditional skip.

Recovered-symbol expression checkpoint, 2026-09-24: compiler recovery can
retain a typed arithmetic expression whose flattened trace node no longer
contains the local-variable child that established its type. Native reference
identities and physical token projections now propagate provisional status
into only the enclosing typed range that contains a recovered symbol reference.
A new incomplete-procedure regression confirms that `localValue + 2.0` is
provisional while the independent `2.0` literal remains authoritative. The
compiler expression sidecar independently supplies the recovery fact for this
case; its IDs remain separate from the native trace graph. The native-backed
unit suite passes 278 tests with one platform-conditional skip. Other recovery
paths and reference dependencies still need systematic coverage. Structural
recovery checks now also cover missing procedure, `IF`, `SELECT`, `FOR`, `DO`,
`WHILE`, and `WITH` terminators alongside incomplete `TYPE`, `ENUM`, `UNION`,
and `NAMESPACE` containers.

Token-paste rename checkpoint, 2026-09-24: native macro provenance already
reported both the formal parameter and its replacement-list use in
`prefix##suffix`, but editor tokenization treated `prefix#` as one identifier.
The tokenizer now recognizes `##` as a single punctuation token while retaining
`#` as a valid numeric or identifier type suffix. A native project-rename
regression validates the parameter rename across two build contexts, checks
both physical edits, and confirms the saved source is unchanged. The full
native-backed unit suite passes 281 tests with one platform-conditional skip.

Generated-label rename checkpoint, 2026-09-24: macro provenance can now split a
token-pasted label into its compiler-mapped invocation argument and fixed
replacement text. Project rename supports the unambiguous case with exactly one
argument component, using a compiler-bound physical label reference as the
family anchor and recompiling every configured context before returning the
preview. It still refuses multi-argument pastes and rejects an argument edit
that would change stringified output. Positive and refusal tests leave saved
source unchanged. The full native-backed unit suite passes 285 tests with one
platform-conditional skip.

UTF-8 semantic-column checkpoint, 2026-09-24: an expressions-only compiler
sidecar now has a focused end-to-end regression for an expression following
both a multibyte BMP character and a supplementary-plane character in a
CRLF-terminated unsaved overlay. The compiler range is checked against VS
Code's UTF-16 columns, then queried with the bridge expression graph removed;
the result remains authoritative `Double` and the saved file is unchanged.
This verifies one non-ASCII source-position boundary across FBC, sidecar
decoding, and editor lookup. Other encodings and malformed UTF-8 remain open.

Operator-prefix mode checkpoint, 2026-09-24: the language-mode fixture now
checks 24 expression shapes and 12 completed same-precedence prefixes across
default/explicit FreeBASIC, FB-Lite, QB, deprecated, extended syntax, and x86
32/64-bit targets. Sidecar facts and editor queries agree on every checked
range. This surfaced and now locks down the QB distinction between 16-bit
bitwise/integer-arithmetic results and 32-bit comparisons, short-circuit
logical operators, and `Len`; `Shl` is deliberately omitted under QB because
that mode rejects it. A fresh upstream `expressions` semantic audit passed
73/73 files, comparing 2,745 runtime expressions and 70 safe recovery facts
with no missing or mistyped answers. Together these tests better cover
precedence-folded compiler exports, but the mode matrix is still curated rather
than exhaustive. The native-backed unit suite passes 285 tests with one skip.

Compiler dependency-inventory checkpoint, 2026-09-24: schema 6's complete `D`
records now supplement the bridge dependency list during normal editor analysis,
not only in the trace-size fallback. Paths are normalized and deduplicated,
the requested module and 5,000-file bound are checked, and captured disk
contents are revalidated against unsaved-buffer aliases. Older semantic schemas
remain readable without claiming a complete inventory. A native regression
deliberately removes an included header from the bridge-reported list and
confirms the compiler sidecar restores it for source snapshot capture; the
existing fixture differential and unsaved-header checks also pass. This closes
one dependency-discovery gap, but does not replace bridge bindings, macro
provenance, or the project model. Rebuilding the bridge from the live FBC source
passed the complete semantic-sidecar suite (33/33, including the 73-module
upstream expression differential) and the full native-backed unit suite (289
passed, one platform-conditional skip). FBC's semantic-model smoke target also
passes when run with this rebuilt compiler.

Compiler binding-occurrence checkpoint, 2026-09-24: schema 7 adds counted `B`
records for compiler-resolved variable declarations, direct variable/member
references, named procedure declarations and calls, named type/union/enum
declarations and references, typedef declarations and references, and
constant/enum-element declarations and references. Call records are emitted
after overload resolution and preserve the exact selected procedure identity;
calls through procedure pointers and implicit/generated calls are not claimed
as direct procedure references. Source-context tracking distinguishes physical
include paths from `#line` remapping, so remapped and macro-expanded occurrences
are not advertised as editable ranges. Project refactoring requests the full
semantic sidecar only for its bounded compiler transaction, validates its
footer and dependencies, and joins an occurrence to the existing bridge
identity only at an exact physical declaration span. A sidecar/compiler
identity mismatch or ambiguous source range is withheld; workspace, macro, and
generated edits continue to depend on their existing provenance paths. The
transaction compares the compiler-resolved occurrence graph before and after
the proposed rename by matched bridge identity, role, physical file/line,
token order, and spelling. Regression coverage includes schema validation,
missing-symbol rejection, `#line` handling, compiler-backed variable and
type/constant supplementation, and overload/type/constant identity tests. The
semantic-sidecar suite passes 38/38, the complete native-backed unit suite
passes 294 tests with one platform-conditional skip, and FBC's semantic-model
smoke target passes against a fresh compiler built from the supplied source.
The VS Code extension-host integration suite also exits successfully.

Expression configuration-corpus checkpoint, 2026-09-24: the native-corpus
audit now accepts `--architecture=x86-32|x86-64` and passes those target flags
to both the stock compiler and the editor bridge. The upstream 73-file
`expressions` category was re-audited in explicit `fb`, `fblite`, `qb`, and
`deprecated` modes, then in FreeBASIC mode for both x86-32 and x86-64. All six
configurations passed 73/73 compiler/preprocessor parity checks, constructed
73 editor models, and reported zero missing or mistyped compiler-backed
answers and zero unsafe recovery answers. The sidecar compared 2,745 physical
non-directive expressions in `fb` and x86-64, 2,722 in x86-32, 1,553 in
deprecated mode, 1,089 in FB-Lite, and 184 in QB; each had zero type
mismatches. Syntax ranges not typed after parser failures remained explicitly
invalid or provisional (915 in FB-Lite, 4,664 in QB, 796 in deprecated, and
170 in explicit FreeBASIC), with no unmarked omissions. This closes the
language-mode and x86-width gap for this upstream category, but not generated
or lowered expressions, non-x86 target ABIs, or the other upstream categories
under every mode/target combination.

Semantic-token repeat-query checkpoint, 2026-09-24: immutable prepared models
now retain a per-document LRU of encoded semantic-token vectors, capped at
8 MiB and eight documents per model. Returned arrays are copies, and the
`WeakMap` ownership lets released model snapshots reclaim their cache. The
compiler-source responsiveness benchmark now repeats each semantic-token query
on the same prepared snapshot and checks byte-for-byte equality. On
`src/compiler/parser-proc.bas` (about a 90 MB prepared model), the first query
took 58–74 ms and the repeated query 0.7–0.8 ms, with about a 5–6 ms host timer
gap; `ast-node-call.bas` improved from 27–45 ms to 0.8–4.9 ms. On the broken
54 KB overlay with 2,000 valid expressions after its error, prepared analysis
took 12.7 ms cold and 17.0 ms warm maximum host timer gaps, and the later
expression remained authoritative `Double`. This removes repeated full-token
resolution work, but not first-query cost, the roughly 3-second preparation of
the large procedure source, or its model memory footprint. The native-backed
unit suite passes 295 tests with one platform-conditional skip. The Linux VSIX
was rebuilt from this tree, installed into an isolated profile, and passed all
33 packaged extension-host checks on VS Code 1.121.0.

Compiler label and namespace binding checkpoint, 2026-09-24: schema 7's
existing `B` records now cover numeric and named label declarations and
compiler-selected references, including direct `GOTO`/`GOSUB`/`RETURN`, both
`ON` branch lists, single-line numeric `IF` branches, `ON ERROR GOTO`, and
`RESTORE`. Namespace declarations (including reopened and nested namespaces)
and resolved namespace prefixes in qualified type/value references are also
exported. The extension joins these facts to native identities only at exact
declaration ranges, and admits numeric source tokens only when the joined
symbol is a compiler label. Native regressions check four label declarations,
eleven label references, and qualified namespace identities, then remove
bridge references and confirm the sidecar restores the same identities. The
namespace regression places namespace allocations after a procedure parameter
and verifies the exporter assigns a fresh identity when FBC reuses the symbol
node. The full FBC semantic-model smoke target, compiler-bridge rebuild, and
focused plugin integration pass. The same schema now exports field declarations,
so implicit `.field` references inside `WITH` can be joined to their declaration;
the compiler smoke fixture checks both use sites against that identity. The wire
layout did not change; these are additional compiler-resolved `B` occurrences.
AST class/operator fields remain opaque in the extension. Schema version 9
provides stable conceptual operator codes and kinds for cross-tool
consumers; raw compiler numeric values remain optional diagnostic detail and
are interpreted only for an inspected compiler family.

Compiler field-binding checkpoint, 2026-09-24: schema 7 now exports aggregate
field declarations with physical identifier ranges. Compiler-resolved `.field`
uses inside `WITH` blocks retain the same symbol identity, allowing the
extension to supplement a missing bridge reference only after joining the exact
field declaration. The bridge integration test checks both use sites, and the
FBC semantic-model smoke fixture independently verifies their IDs. Rebuilt
bridge validation passed the complete extension suite: 298 unit tests passed,
one platform-conditional test was skipped, and all smoke and grammar checks
passed. The FBC semantic-model smoke target passed as well.

Non-x86 expression ABI checkpoint, 2026-09-24: the native corpus audit now
accepts every canonical CPU architecture name in FBC's `cputypeinfo` table and
tests each advertised name against the rebuilt compiler. The full upstream
`expressions` category passed in 14 non-x86 configurations: ARMv4, ARMv7,
AArch64, PowerPC32, PowerPC64 big- and little-endian, RISC-V32/64, s390x,
LoongArch64, and MIPS32/64 in both endian variants. Each configuration passed
73/73 trace-disabled preprocessing parity checks and compared 2,355 source
expressions against the semantic sidecar and editor model, with no missing,
ambiguous, or mistyped answer; recovery facts remained safely withheld or
provisional. This closes the non-x86 ABI gap for this upstream category, not
for every upstream category, language-mode/target combination, or generated
expression path.

Stable sidecar operator checkpoint, 2026-09-24: schema 8 adds conceptual
operator codes and `builtin`/`overloaded`/`none` kinds to typed AST and
expression records. Built-in codes are derived from AST operations; overloaded
codes come from the compiler-selected operator procedure, never source-text
guessing. The raw AST class/opcode columns remain opaque diagnostic detail.
Unknown or unmapped operations are emitted as `none`, and both sidecar readers
validate the new vocabulary while continuing to accept schemas 2–7. Tests
verify raw numeric IDs remain untouched, built-in addition, overloaded addition,
schema/footer layout, and schema-8 FBC output. FBC's semantic-model smoke and
the native sidecar suite pass against a rebuilt compiler bridge.
The concepts describe the exported AST node, so constant-folded expressions
correctly report no operator when optimization has replaced that node.

Cross-dialect operator checkpoint, 2026-09-24: a native sidecar-only test now
queries stable built-in operator concepts for addition, multiplication, a
comparison, unary negation, and the lowered `Not (comparison)` form under FB,
FBLite, QB, and deprecated mode, each on the host, x86-32, and AArch64 targets.
All 12 complete compiler passes returned the same five conceptual codes and
`builtin` kind. Compiler-selected result types remain mode-specific: QB's
arithmetic and unary integer results are `short`, while its comparison results
are `integer`; the other tested modes return `integer` for these cases. This
verifies representative built-in codes across the dialect/target matrix, not
every operator family or user-defined operators in each mode.

Lowered operator checkpoint, 2026-09-24: schema 9 preserves the compiler-known
`identity-test` operation for `Is` expressions even when the compiler has
lowered the AST root to a helper call before exporting the completed source
range. The raw AST class and operator fields still describe that lowered node;
the conceptual code comes from the parser's selected operation, not token-text
inference. Schema-8 output remains readable with its original semantics. The
native sidecar regression checks this distinction under host, x86-32, and
AArch64 targets.

Generated declaration-construction checkpoint, 2026-09-24: the bridge
expression graph now retains the compiler-selected default constructor for
scalar and fixed-array declarations that invoke default initialization. The
synthetic call is anchored to the declared identifier, with no fabricated
callee or operand nodes; fixed arrays produce one declaration relationship,
and unallocated dynamic arrays produce none. A focused native regression checks
those cases and the constructor identity. The rebuilt bridge passes the full
extension suite (301 unit tests passed, one platform-conditional test skipped,
plus all smoke and grammar checks). This adds selected-call provenance to the
expression graph; schema 10 now also carries the bounded default-constructor
relationship into project validation, without treating it as an editable
source occurrence.

Compiler binding checkpoint, 2026-09-24: the semantic sidecar now exports
compiler-selected procedure-address references for `@` and `ProcPtr`, including
overloaded addresses resolved from an expected or explicit signature. Native
regressions verify both selected symbol IDs and project-binding supplementation
when bridge reference traces are absent. Calls through an already-formed
procedure pointer remain indirect and have no statically selected target.

Compiler member-reference checkpoint, 2026-09-24: native semantic regressions
now cover bare member reads and writes inside instance methods, explicit
`This.member`, and unqualified calls to another instance method. They verify the
compiler-selected field or procedure identity and prove project-binding
supplementation when bridge reference records are removed. The FBC smoke fixture
checks the same physical ranges and symbol IDs. These forms use the existing
schema-8 `B` records; other generated or source-ambiguous relationships remain
open.

Compiler NEW-result typing checkpoint, 2026-09-24: the bridge now records the
result of both built-in and overloaded `NEW` expressions as the allocated
pointer type, even when constructor parsing has already emitted an intermediate
same-span type. Overloaded allocation still retains the compiler-selected
operator call. The focused regression covers scalar, vector, ordinary, and
user-defined allocation. Re-auditing the upstream `structs` category passed
254/254 compiler-parity cases and compared 7,496 physical expressions. Trace
type disagreements fell from 23 to 18; all five `NEW`/constructor pointer
disagreements are gone. The semantic sidecar still safely supplements 7 absent
trace ranges and overrides 18 mismatched trace types, with zero unresolved or
mistyped editor answers. The remaining trace differences are chiefly bit-field
member types and a small number of ranges not emitted by the bridge. The
rebuilt bridge passes the native-backed unit suite (303 passed, one
platform-conditional skip), all 6 smoke tests, both TextMate grammar tests, and
the FreeBASIC 1.20.4 coverage audit.

Bit-field expression checkpoint, 2026-09-24: native member-expression traces
now use the compiler's remapped result type instead of the bit-field's declared
storage type. Re-auditing all 254 upstream `structs` files passes compiler
parity and compares 7,496 physical expressions with zero trace/sidecar type
disagreements, zero missing editor answers, and zero mistyped answers. Seven
sidecar facts still have no exact trace node: one temporary UDT address
expression and six string literals inside static aggregate initializers. The
sidecar maps and types those exact physical ranges, so the editor does not need
to guess at a generated or macro-expanded trace span.

Cross-category expression audit checkpoint, 2026-09-24: default-mode semantic
sidecar audits now pass 15 upstream categories and 1,665 compiler-parity files:
`boolean` (16), `compound` (51), `const` (318), `dim` (346), `functions` (154),
`numbers` (20), `overload` (92), `pointers` (76), `pp` (130), `qb` (81),
`quirk` (56), `scopes` (28), `structs` (254), `syntax` (28), and `typedef`
(15). Across these audits, 24,611 physical expressions were compared; there
were no trace/sidecar type disagreements, unresolved editor results, or editor
type mismatches. Some facts in function parameter initializers, preprocessor
constructs, and aggregate/data initializers have no exact trace node, but the
sidecar-backed model still returns typed results. This broadens default-mode
evidence without proving every category in every language mode or target
architecture.

Remaining default-mode category checkpoint, 2026-09-24: the other 13 curated
portable categories also pass: `command-sweep` (4), `file` (22), `gfx` (53),
`namespace` (85), `sfx` (29), `string` (88), `threads` (16), `udt-wstring`
(19), `udt-zstring` (19), `virtual` (92), `visibility` (216), `wstring` (39),
and `console` (2). Together with the earlier 15 categories this covers all 28
categories and 2,349 compiler-parity files in this corpus. The additional 684
files compared 33,451 complete physical expressions; 430 ranges missing from
the bridge trace were supplied by the semantic sidecar, with zero type
disagreements, unresolved queries, or mistyped results. Across all 28 default-
mode categories, 58,062 complete expressions have been compared with no
semantic type mismatch or unresolved editor result. This is curated corpus
coverage, not a proof for arbitrary programs or every language mode and target.

AArch64 aggregate checkpoint, 2026-09-24: all 254 `structs` modules pass
trace-disabled compiler parity under `-arch aarch64`. The audit compares 7,496
complete physical expressions with zero trace/sidecar type differences,
unresolved queries, or mistyped results. Seven absent bridge ranges (one
temporary UDT address and six static-initializer strings) are supplemented by
the semantic sidecar. The 114 partial modules also have no unsafe, unresolved,
mistyped, or unprovisional recovery answer. This closes one ABI-sensitive
category on AArch64, not the architecture matrix for aggregate syntax.

32-bit x86 aggregate checkpoint, 2026-09-24: the same 254 `structs` modules
also pass under `-arch 386`, comparing 7,490 complete physical expressions.
The same seven sidecar supplements cover the absent bridge ranges; trace and
sidecar agree on every compared type, and all partial recovery facts remain
safe. Both targets independently match the sidecar for their complete source
ranges, but other target-specific declaration and layout paths remain to be
audited.

Pointer ABI checkpoint, 2026-09-24: all 76 `pointers` modules pass under both
`-arch aarch64` and `-arch 386`. Each target compares the same 1,410 complete
physical expressions against the semantic sidecar with no trace differences,
unresolved queries, or mistyped results. The 32 partial modules yield 74
recovery facts and no unsafe, unresolved, mistyped, or unprovisional answer.
This checks pointer expressions on two contrasting widths; it does not close
the target matrix for all expression and declaration categories.

Overload ABI checkpoint, 2026-09-24: all 92 `overload` modules also pass on
both targets, comparing 1,056 complete expressions per target with no semantic
type disagreement, unresolved answer, or mistyped result. The native sidecar
regression now verifies built-in and overloaded operator concepts, lowered
call results, and sidecar-only expression types under the host, 32-bit x86,
and AArch64 targets. This directly checks that tooling-facing operator codes
do not vary with target ABI; remaining operator families and modes still need
coverage.

FBLite mode checkpoint, 2026-09-24: the `expressions`, `dim`, and `functions`
categories now pass all 573 compiler-parity checks. Across their complete
files, 3,480 physical expressions were compared with no trace/sidecar type
disagreement, unresolved result, or mistyped editor answer. The 434 partial
files contributed 7,678 recovery facts and produced no unsafe retained,
unmarked, unresolved, or mistyped recovery answer. The `functions` pass had
previously stopped on
`functions/return-byref.bas`: trace export dereferenced a stale `anonparent`
pointer in a recycled compiler symbol node after expected FBLite diagnostics.
Bridge instrumentation clears the optional parent link in `symbStructBegin()`
for top-level types. The focused regression fails with the old bridge and passes
with the rebuilt bridge, which reaches EOF and preserves the 33 diagnostics.
This closes that crash path, not the remaining FBLite categories or complete
language-mode matrix.

QB mode checkpoint, 2026-09-24: the same `expressions`, `dim`, and `functions`
categories pass 573/573 compiler-parity checks. Across 55 complete files, 442
physical expressions were compared with no trace/sidecar disagreement, missing
answer, or type mismatch. The 518 partial files contributed 8,929 recovery
facts with no unsafe retained, unmarked, unresolved, or mistyped answer. This
extends coverage to QB parsing, not the full QB corpus or every option/target
combination.

Deprecated-mode checkpoint, 2026-09-24: these three categories also pass
573/573 compiler-parity checks. Across 149 complete files, 4,713 physical
expressions match the sidecar; 7,455 facts from 424 partial files produced no
unsafe, unmarked, unresolved, or mistyped answer. Eight context-ambiguous
recovery ranges were correctly withheld. This adds deprecated-mode evidence
without establishing the rest of that mode's corpus or its target matrix.

Overload recovery checkpoint, 2026-09-24: the 92-file `overload` category
passes compiler parity in FBLite, QB, and deprecated mode. FBLite compares 246
complete expressions and checks 2,160 recovery facts; deprecated mode compares
435 complete expressions and checks 1,797 recovery facts. QB rejects all 92
overload-oriented sources in that dialect, but retains 2,811 recovery facts
without an unsafe or mistyped answer. All three runs report zero unresolved
results; QB's all-partial result is compatibility/recovery evidence, not a
claim of complete overload typing in that dialect.

Reference sync checkpoint, 2026-09-24: regenerated the bundled offline API
reference from the supplied FreeBASIC 1.20.4 checkout so its source revision
matches the current compiler source. The reproducibility test passes against
that checkout.

Full FBLite expression checkpoint, 2026-09-24: the complete portable upstream
corpus now passes under `-lang fblite`: 2,422/2,422 compiler-parity checks,
direct semantic models, and prepared worker models, including 669 complete and
1,753 partial modules. The sidecar audit compared 27,433 physical expressions
and 12,926 compile-time directive expressions with no missing or mistyped
editor answer. Recovery analysis checked 42,076 facts, including 39,115 safe
post-error facts, 2,753 facts on
error lines, and 208 retracted facts. No unsafe, unresolved, or unprovisional
recovery answer was retained. The initial pass exposed three generated
`__FB_QUERY_SYMBOL__` spans whose compiler-selected symbols had no standalone
expanded token or physical/macro origin. The model now excludes only such
exactly matched, unmapped generated spans from editor bindings while retaining
the raw compiler symbol graph; malformed or source-mapped spans still fail
closed. All 28 FBLite `syntax` cases pass after that change, and the full rerun
has no failures. This closes the FBLite portable corpus matrix, not other
options, targets, project configurations, or generated relationships that
could map to editable source.

Full FBLite 32-bit target checkpoint, 2026-09-24: all 29 portable upstream
categories also pass under `-lang fblite -arch 386`, with 2,422/2,422
trace-disabled parity checks, direct semantic models, and prepared worker
models. The audit retained 667 complete and 1,755 partial modules, with no
bounded or incomplete analyses. Complete modules supplied 303,399 typed
ranges across 316,542 syntax ranges; the 13,143 untyped ranges were all marked
as recovery-dependent, with zero missing syntax or type mismatch. The sidecar
exported 40,313 expression facts, including 27,470 physical comparisons and
12,843 directive expressions. It safely supplemented 417 trace omissions;
there were no ambiguous, missing, or mistyped editor answers or audit
failures. This adds full-corpus FBLite evidence for 32-bit x86, not the QB or
deprecated target matrix or all compiler options.

Full FBLite AArch64 target checkpoint, 2026-09-24: all 29 portable upstream
categories pass under `-lang fblite -arch aarch64`, with 2,422/2,422
trace-disabled parity checks and both direct and prepared worker models for
every file. The run retained 669 complete and 1,753 partial modules, with no
bounded or incomplete analyses. Complete modules supplied 300,519 typed
ranges across 313,649 syntax ranges; all 13,130 untyped ranges were marked as
recovery-dependent, with zero missing syntax or type mismatch. The sidecar
exported 40,049 expression facts: 27,125 physical comparisons and 12,924
directive expressions. It supplemented 401 trace omissions, with zero
ambiguous, missing, or mistyped answers and no audit failures. Together with
the FBLite x86-32 run, this verifies two contrasting pointer widths for the
full portable corpus in this dialect; other modes and compiler options remain
open.

Full QB expression checkpoint, 2026-09-24: the complete 2,422-file portable
corpus passes under `-lang qb`: 2,422/2,422 compiler-parity checks, 2,420
direct semantic models, and 2,420 prepared worker models. Two QB macro-eval
inputs stop after a compile-time evaluation error and before writing a terminal
analysis record; they are explicitly counted as incomplete, excluded from
model coverage, and their ordinary output and status match an uninstrumented
compiler built from the same supplied source checkout. Of the modelled files,
177 are complete and 2,243 partial. Across those files, all 117,410 compiler-
typed ranges match syntax nodes; the 83,529 untyped syntax ranges are all
marked as recovery-dependent. The sidecar supplies 2,865
physical/directive expression facts: 1,435 physical comparisons and 1,430
directive facts, with no missing or mistyped answer. Nineteen physical facts
were safely supplemented beyond the parser trace. Recovery checked 60,771
facts: 53,328 safe post-error facts, 7,224 on error lines, and 219 retracted;
none was retained unsafely, left unmarked, unresolved, or mistyped. The pass
also exposed QB `REM`-suffixed variable sites that the parser resolves but
`-pp` omits; those identities stay analyzable but are withheld from editor
navigation/refactoring when no matching output token exists. This closes the
QB portable corpus matrix, not its target/option matrix or all project-wide
binding forms.

Full deprecated-mode expression checkpoint, 2026-09-24: all 2,422 portable
corpus files pass under `-lang deprecated`, with 2,422/2,422 compiler-parity
checks, direct models, and prepared worker models. The models include 804
complete and 1,618 partial modules. Of 832,884 syntax ranges, all 816,339
compiler-typed ranges match exactly; all 16,545 untyped syntax ranges are
marked as recovery-dependent. The semantic sidecar supplied 57,675 physical
and directive expression facts: 40,389 physical comparisons and 17,286
directive facts, with 434 trace omissions safely supplemented and no missing
or mistyped editor result. Recovery checked 32,540 facts (29,917 safe,
2,398 on error lines, and 225 retracted); none was retained unsafely,
unmarked, unresolved, or mistyped. This closes host-target deprecated-mode
corpus coverage, not its target/option matrix or every generated expression
and refactoring path.

Cross-dialect expression ABI checkpoint, 2026-09-24: the 73-file upstream
`expressions` category also passes under FBLite, QB, and deprecated mode on
both 32-bit x86 and AArch64. All six runs passed 73/73 compiler-parity checks
and built both direct and prepared-worker models for every file. Across the
matrix, 5,076 physical expressions and 2,072 directive expressions matched the
semantic sidecar with no missing or mistyped result; 10,614 recovery facts had
no unsafe, unresolved, mistyped, or unmarked answer. Partial-mode syntax gaps
remained explicitly recovery-marked. This extends ABI evidence across dialects
for the expression suite, not across the full corpus or every target/option
combination.

Encoded source-range checkpoint, 2026-09-24: the semantic sidecar now verifies
single-line physical ranges for unmarked input and BOM-marked UTF-8, UTF-16LE,
UTF-16BE, UTF-32LE, and UTF-32BE. It scans bounded, code-unit-aligned source
chunks, excludes the BOM from first-line columns, and counts supplementary
characters as two editor UTF-16 columns. Malformed explicit UTF-8/16/32 lines
fail closed. The lexer retains a separate physical line counter so repeated
logical `#line` locations cannot reuse another physical line's bound; the
sidecar's forward source cursor keeps validation linear across increasing
source lines. Native fixtures cover Unicode, CRLF, repeated logical line
numbers, malformed UTF-8/16/32 code units, and an out-of-line macro-adjacent
parser range in all five BOM encodings. The FBC semantic-model smoke passed, all 45
compiler-sidecar tests passed against a bridge rebuilt from the updated FBC
source, and the full unit suite passed 312 tests with one platform-conditional
skip. This closes encoded single-line range validation; it does not prove
complete encoded-source refactoring, malformed-code recovery, or full compiler
coverage.

Compiler-resolved inline-assembly reference checkpoint, 2026-09-24: the
FreeBASIC semantic sidecar now exports direct bindings for procedure, label,
variable, and constant identifiers resolved by inline `ASM`. Assembly keywords
and unresolved assembler-local names remain unbound. Project binding joins
these records only to an exact compiler declaration and physical token; rename
validation now accounts for those sidecar-backed token origins as well as the
ordinary bridge-use trace. End-to-end previews cover all four symbol kinds and
leave source files unchanged. The regenerated offline API reference now matches
the current 1.20.4 checkout revision and reproduces all 602 bundled names.
`make compiler-semantic-model-smoke` passed, all 46 sidecar tests passed, and
the full unit suite passed 314 tests with one platform-conditional skip. This
adds a specialized compiler-resolved reference route, not full inline-assembly
analysis or complete project-reference coverage.

Full AArch64 corpus checkpoint, 2026-09-24: all 29 portable upstream
categories passed under `-lang fb -arch aarch64`, with 2,422/2,422 stock
compiler parity checks, direct models, and prepared worker models. The exact
source-matched uninstrumented FBC 1.20.4 build was used as the parity oracle.
There were 1,108 complete and 1,314 partial modules, with no bounded or
incomplete analyses. Complete modules supplied 849,418 typed ranges across
853,010 syntax ranges; the 3,592 untyped ranges were all marked as
recovery-dependent, with no missing syntax or type mismatch. The sidecar
contained 88,787 expression facts (60,219 physical comparisons and 28,568
directive facts); 488 trace omissions were safely supplemented and 34
ambiguous ranges withheld. There were no missing or mistyped editor answers
and no audit failures. This is full portable-corpus evidence for one
non-host-width target in default dialect, not the remaining target/mode/options
matrix.

Full 32-bit x86 corpus checkpoint, 2026-09-24: all 29 portable upstream
categories also passed under `-lang fb -arch 386`, using the same
source-matched uninstrumented FBC 1.20.4 parity oracle. All 2,422 cases passed
compiler parity and produced direct and prepared worker models; 1,108 were
complete and 1,314 partial, with no bounded or incomplete analyses. Complete
modules supplied 878,519 typed ranges across 882,109 syntax ranges. The 3,590
untyped ranges were all recovery-marked; missing syntax and type mismatches
were zero. The sidecar contained 89,622 expression facts (61,048 physical
comparisons and 28,574 directive facts); 504 trace omissions were safely
supplemented and 34 ambiguous ranges withheld. No editor answer was missing or
mistyped, and the audit reported no failures. Together with the AArch64 run,
this closes the full portable-corpus check on two contrasting pointer widths
in default dialect, not the remaining dialect, option, and target matrix.

QB/x86-32 corpus audit, 2026-09-24 (not a clean checkpoint): 2,420 of 2,422
files passed stock-compiler parity and produced direct and prepared worker
models. The two exceptions, `pp/macro-eval-str.bas` and its UTF-16LE variant,
emit the same compile-time diagnostic and warnings in both compilers, but then
both compiler processes abort differently: the stock compiler reports stack
smashing (exit 14), while the instrumented bridge reports a segmentation
violation (exit 12). The semantic sidecar had no unresolved, ambiguous, or
mistyped answers in the 2,420 analyzed files; 19 trace omissions were safely
supplemented. This remains an upstream/compiler-instrumentation crash-parity
issue, so the QB/x86-32 matrix is not counted as passed. A current GDB run on
the bridge locates the fault in `hAddMissingMacroArgs()` called from
`hLoadMacro()`; it reproduces with editor tracing disabled as well. The
corrupted return chain does not identify which compiler-side operation first
overwrites memory, so no cause or safe fix is established yet.
This is a pre-lexer-fix checkpoint; the complete current-source QB/x86-32
re-audit is recorded at the end of this plan.

QB/AArch64 portable corpus audit, 2026-09-24 (preprocessor category excluded):
the other 28 portable categories passed stock-compiler parity on all 2,292
files, and direct plus prepared-worker models were produced for every file.
There were 144 complete and 2,148 partial modules, with no bounded or
incomplete analyses. Complete modules supplied 107,125 typed ranges across
188,223 syntax ranges; the 81,098 untyped ranges were all recovery-marked,
with no missing syntax or type mismatch. The sidecar contained 2,100 facts
(1,293 physical comparisons and 807 directive expressions); 10 trace
omissions were safely supplemented, with no missing or mistyped answer and
no audit failures. The `pp` category remains unverified for this target/mode
combination because the two `macro-eval-str` variants abort differently in
the stock compiler and instrumented bridge. This is broad QB/AArch64 evidence,
not a full-corpus pass. A fresh `pp`-only rerun against the rebuilt compiler
again passed 128/130 files; the same two string-evaluation fixtures differ in
process exit status (stock 14, bridge 12). GDB still stops in
`hAddMissingMacroArgs()` with its `nextparam` argument overwritten by `0x22`
bytes, but that observation does not identify the first invalid write or a
safe fix. This was a pre-lexer-fix checkpoint; the current-source `pp`
category now passes on AArch64 with and without extended syntax.

Full deprecated/AArch64 corpus checkpoint, 2026-09-24: all 29 portable
categories passed under `-lang deprecated -arch aarch64`, with 2,422/2,422
stock-compiler parity checks and direct plus prepared-worker models. There
were 804 complete and 1,618 partial modules, with no bounded or incomplete
analyses. Complete modules supplied 788,550 typed ranges across 805,095
syntax ranges; all 16,545 untyped ranges were recovery-marked, with no missing
syntax or type mismatch. The sidecar contained 57,083 facts (39,801 physical
comparisons and 17,282 directive expressions); 418 trace omissions were
safely supplemented, with no missing, ambiguous, or mistyped editor answer.
The audit reported no failures. This provides full-corpus evidence for one
legacy language mode on AArch64; other mode/target combinations remained open
at that checkpoint. The QB preprocessor crash mismatch was later closed by
the current-source lexer fix and follow-up audits.

Full deprecated/x86-32 corpus checkpoint, 2026-09-24: all 29 portable
categories also passed under `-lang deprecated -arch 386`, with 2,422/2,422
stock-compiler parity checks and direct plus prepared-worker models. There
were 802 complete and 1,620 partial modules, with no bounded or incomplete
analyses. Complete modules supplied 817,711 typed ranges across 834,269
syntax ranges; all 16,558 untyped ranges were recovery-marked, with no missing
syntax or type mismatch. The sidecar contained 57,663 facts (40,461 physical
comparisons and 17,202 directive expressions); 434 trace omissions were
safely supplemented, with no missing, ambiguous, or mistyped editor answer.
The audit reported no failures. Together, the deprecated-mode runs verify the
full portable corpus across both 32-bit x86 and AArch64, while QB and FBLite
still need broader full-corpus target coverage.

Qualified preprocessor-query rename checkpoint, 2026-09-24: project rename now
has a native regression for a namespace constant referenced both by
`#if defined(Namespace.member)` and by a source expression. The compiler-bound
preview includes the declaration and both references, and leaves the saved
module unchanged. This adds evidence for that qualified `defined()` route;
other uncommon macro references, implicit relationships, and label forms
remain open.

Property-accessor rename checkpoint, 2026-09-24: a cross-module native
regression now validates renaming a property getter and setter independently.
Each preview joins the declaration in a shared header, implementation, and
compiler-selected property read or write in a caller. The preview does not
modify any source file. This closes identifier-backed property accessor
references for read/write access plus a parameterized getter.

Conditional property-accessor checkpoint, 2026-09-24: project rename now joins
getter or setter symbols selected by different named build contexts when the
same physical property use binds to the same qualified property and accessor
role. The native regression covers mutually exclusive getter and setter
declarations and implementations with different result/value types, selects
both normal and alternate contexts, and verifies that previews include the
matching branch declarations plus shared uses without changing saved files.
Getter and setter identities remain separate; mismatched accessor roles at one
physical use are still rejected. This adds conditional property coverage, not
complete coverage of other implicit member relationships.

Rapid unsaved-edit checkpoint, 2026-09-24: the analysis-service tests now drive
three consecutive buffer revisions through delayed compiler replies. Both
older requests are cancelled, their out-of-order replies publish no snapshot,
and the final revision alone becomes queryable. This verifies service-level
freshness under rapid edits; it is not a measurement of live compiler
throughput or responsiveness during sustained typing.

Aggregate-initializer trace-gap checkpoint, 2026-09-24: rerunning the complete
default-mode `structs` category against the current checkout passed 254/254
compiler-parity checks and compared 7,496 physical expressions. The seven
sidecar supplements are now classified: one address-of `TYPE<test_pair>(...)`
initializer expression and six string literals in static aggregate
initializers (three fixed-length UDT fields and three array elements). They are
exact physical compiler facts and remain queryable with the compiler-selected
pointer or `zstring` type; they are not missing editor answers or ambiguous
generated spans. A native regression checks both expression shapes and the
large aggregate-array case. The parser trace is still less granular for these
initializers, so retaining exact sidecar coverage is the appropriate current
path. This classification applies to the audited default-mode category, not
every target or language mode.

Native sustained-edit measurement, 2026-09-24: the worker integration suite
also runs five successive 20,000-line broken-buffer revisions through the real
compiler process, then publishes and queries a valid final revision. In this
run, all five obsolete analyses were reaped; maximum discard latency was 2 ms,
maximum process cleanup was 14 ms, final publication took 77 ms, and sampled
peak RSS was 108.4 MiB. These are one Linux run's measurements, not a portable
latency or memory guarantee.

Selected-call source-occurrence checkpoint, 2026-09-24: every inventoried
compiler call-builder route now has a builder-specific classification as
operator syntax, an implicit source construct, mixed source forms, or
compiler-generated behavior. Builder-specific keys distinguish helpers that
create both source-related and generated calls, such as UDT assignment and
member-array construction/destruction. The only mixed route is member/index
resolution: property getters can be selected from an identifier, while
overloaded indexing is selected from punctuation. Project rename tests verify
the property identifier path across modules. The route audit and optional
bridge build both fail on unclassified or stale entries. This describes call
provenance, not a claim that generated constructor or destructor procedure
names are editable references.

Semantic operator ABI checkpoint, 2026-09-25: FreeBASIC semantic-model
schema 9 exposes stable conceptual operator codes and `builtin`, `overloaded`,
or `none` kinds in AST and expression records. The parser also preserves a
compiler-known built-in concept when AST construction normalizes its opcode or
lowers the operation to a helper call. This information is now carried through
both full-model and expressions-only exports; the upstream compiler smoke test
checks subtraction, exponentiation, concatenation, unary plus, and `Is` in both
both modes. The extension validates and exposes this vocabulary;
compiler-private AST class and raw operator numbers remain diagnostic fields
and are not consumed by language rules. The schema 8/9 decoder regression
accepts deliberately different raw IDs while preserving the same conceptual
result, including a later producer version, and rejects an unknown conceptual
code. A native sidecar-only matrix verifies nine operator concepts under FB,
FBLite, QB, and deprecated modes on host, x86-32, and AArch64 (108 expression
cases). The semantic-sidecar suite passes 51/51, the
compiler-analysis suite 93/93, and the direct FBC semantic-model smoke passes.
This closes the specific schema interoperability gap for tested operators, not
every source operation or lowered compiler path.

Fresh FBLite `-exx` revalidation against the schema-9 sidecar, 2026-09-25:
the bridge rebuilt from the current supplied FBC checkout passed all 2,422
portable upstream files on x86-32, x86-64, and AArch64, with direct and
prepared models for every file and no bounded or incomplete analyses. All
complete native syntax ranges had types; the remaining ranges were marked as
recovery-dependent, with no missing syntax or type mismatches. x86-32 had 667
complete and 1,755 partial modules, with 303,399 typed ranges across 316,542
syntax ranges and 40,475 semantic facts (27,632 physical comparisons, 12,843
directive expressions); 421 trace gaps were supplemented. x86-64 had 669/1,753
modules, 301,660/314,790 typed/syntax ranges, and 40,521 semantic facts
(27,595 physical, 12,926 directive); 421 gaps were supplemented. AArch64 had
669/1,753 modules, 300,519/313,649 ranges, and 40,211 facts (27,287 physical,
12,924 directive); 405 gaps were supplemented. Each target reported zero
ambiguous, missing, or mistyped answers and no audit failures. Each current
run reports 162 more facts than the preceding checkpoint at that target; the
source-family delta has not yet been isolated.

Deprecated-mode `-exx` portable-corpus checkpoint, 2026-09-25: the same 2,422
files passed for all three targets without bounded or incomplete analyses,
missing or ambiguous editor answers, mistyped ranges, or type gaps on complete
native syntax. x86-64 produced 57,675 facts (40,389 runtime, 17,286
directive), with 804 complete and 1,618 partial modules; 434 trace omissions
were safely supplemented. x86-32 produced 57,663 facts (40,461 runtime,
17,202 directive), with 802 complete and 1,620 partial modules; 434 were
supplemented. AArch64 produced 57,083 facts (39,801 runtime, 17,282
directive), with 804 complete and 1,618 partial modules; 418 were
supplemented. This closes the full deprecated `-exx` profile for the audited
portable corpus, not all option combinations or implicit expression paths.

Source editor integration checkpoint, 2026-09-25: the VS Code integration
suite passed 33/33 on versions 1.139.0 and 1.85.0, covering outline, workspace
symbols, unsaved analyses and recovery, and refactoring. After restoring this
plan and adding the QB matrix results, a fresh Linux VSIX built in a disposable
source copy passed 33/33 packaged integration checks on VS Code 1.139.0. The
root `dist/` artifact was left unchanged.

QB test-matrix checkpoint, 2026-09-25: all 81 files under `tests/qb` passed
compiler parity on x86-32, x86-64, and AArch64 with and without `-exx`.
Each profile compared direct and prepared-worker models (58 complete, 23
partial, no bounded or incomplete analyses). Sidecar checks covered 673
expressions on x86-32 and 690 on x86-64/AArch64; ten trace omissions per run
were safely supplemented, with no missing, ambiguous, mistyped, or unsafe
recovery answers.

Full QB corpus investigation, 2026-09-25: the x86-64 `-exx` run reached 2,420
models and clean expression coverage, but the 2,422-file profile has two
compiler-status discrepancies. The default-FB `pp/macro-eval-str.bas` and
UTF-16LE counterpart abort under forced `-lang qb`: stock fbc exits 14
(stack-smash termination), the bridge exits 12 (segmentation violation), but
their preprocessed output is byte-identical. `analyzeSavedModule` rejects both
as incomplete; a native regression protects that fail-closed behavior. The
full cross-mode profile was still open at this investigation checkpoint.
That status is historical; the current-source x86-32 profile is re-audited
below.

QB full-corpus mode/target/option checkpoint, 2026-09-25: all six combinations
of `-lang qb`, x86-32/x86-64/AArch64, and default/`-exx` syntax profiles were
audited against all 2,422 portable upstream files. In every profile, 2,420
applicable files passed compiler parity and produced direct plus prepared
worker models; none was bounded or incomplete. The other two files are the
default-FB `pp/macro-eval-str.bas` tests described above. They are explicitly
reported as mode-inapplicable only when both compilers fail and their
trace-disabled preprocessed output matches; they are not counted as parity
passes. Per target, both syntax profiles produced the same aggregate: x86-32
had 172 complete and 2,248 partial models with 2,521 semantic facts (1,349
runtime, 1,172 directive); x86-64 had 177 complete and 2,243 partial models
with 2,865 facts (1,435 runtime, 1,430 directive); AArch64 had 180 complete
and 2,240 partial models with 2,974 facts (1,438 runtime, 1,536 directive).
All six profiles had 19 safe trace supplements and zero missing or mistyped
answers, sidecar-only missing answers, recovery-missing answers, or
unsafe-retained recovery facts.
This closes the audited portable-corpus QB target and syntax-option matrix,
not every QB source or every implicit/lowered expression family.
The two `macro-eval-str` exceptions in this historical matrix were resolved by
the lexer fix; see the current-source full-corpus re-audit at the end of this
plan.

FBLite default-option corpus checkpoint, 2026-09-25: all 2,422 portable
upstream files passed compiler parity for x86-32, x86-64, and AArch64 without
`-exx`, with direct and prepared-worker models agreeing. No analysis was
bounded or incomplete. x86-32 had 667 complete and 1,755 partial modules,
40,313 semantic facts (27,470 runtime expressions; 12,843 directive
expressions), and 417 safe trace supplements. x86-64 had 669 complete and
1,753 partial modules, 40,359 facts (27,433 runtime; 12,926 directive), and
417 supplements. AArch64 had 669 complete and 1,753 partial modules, 40,049
facts (27,125 runtime; 12,924 directive), and 401 supplements. All three
profiles had zero missing, ambiguous, mistyped, or status-mismatched answers.
This closes the portable corpus default-option target matrix only; syntax
profiles and implicit/lowered expression coverage remain open.

Multi-error unsaved recovery checkpoint, 2026-09-25: a native overlay with two
different malformed expression parsers (`CAST(` and `NEW (`) produces exactly
two diagnostics and reaches EOF. Both damaged lines are withheld from editor
typing. Valid `Double` expressions before, between, and after the errors remain
authoritative through the native trace; with bridge expression records
removed, the same compiler-sidecar answers are correctly marked provisional.
The full native-backed semantic-sidecar suite passes 51/51, including the
upstream expression-corpus comparison. This verifies one multi-error
interaction and both query paths, not every pair of parser repairs or
multi-error structural-scope recovery.

Mixed parser/scope recovery checkpoint, 2026-09-25: three native overlay cases
combine a malformed initializer with an unterminated procedure, `IF`, or
namespace. Each compiler pass reaches EOF; later valid `Double` expressions
remain available from the trace and sidecar-only paths, but are marked
provisional because the module is recovered. The malformed initializer stays
untyped. The full compiler-analysis suite passes 93/93, and the native-backed
semantic-sidecar suite passes 51/51. These cases cover three representative
interactions, not every combination of parser repairs and structural scopes.

Shared generated-label rename checkpoint, 2026-09-25: compiler-local label
IDs are now joined across translation units only when the generated label
spelling and its complete ordered macro-origin mapping identify the same
physical source tokens. A regression with one shared-header invocation
referenced from two modules now previews the macro-argument edit and both
references; transaction validation succeeds without writing any source. A
companion regression proves that same-spelled labels from distinct physical
macro invocations remain separate. The complete compiler project and worker
suite passes 57 tests with one platform-conditional skip. This covers one
generated-label family and its separation boundary; other macro-origin and
implicit reference families remain open.

Prepared-worker responsiveness checkpoint, 2026-09-25: the native worker suite
now includes a 2,000-expression unsaved overlay with a broken expression
before the valid statements. The prepared-model path reaches EOF with exactly
one diagnostic, answers the final `Double` expression non-provisionally, keeps
the host event loop running, and leaves the disk source unchanged. All 16
worker tests pass with the native bridge. A fresh Linux benchmark measured
prepared analysis of `ast-node-call.bas` at 2.58 s cold / 2.01 s warm with
14/19 ms largest host-thread gaps and about 60 MB estimated model weight;
`parser-proc.bas` took 4.61 s / 4.32 s with 18/23 ms gaps and about 90 MB
weight. Prepared model construction stays on the worker, and the largest
measured initial query was 160 ms while its host-thread gap stayed below 8 ms.
The same malformed-overlay stress took 1.46 s cold / 1.03 s warm with 20/15 ms
host gaps. These machine-specific results support the current prepared editor
path, not an absolute latency promise. The direct analysis/model APIs still
showed 542 ms and 329 ms host-thread gaps respectively in that stress case;
they must remain outside interactive extension-host callbacks. Larger
multi-module sustained-edit and peak-RSS behavior remain unmeasured. The full
native-backed unit suite passes 334 tests with one platform-conditional skip.

Implicit quirk expression matrix checkpoint, 2026-09-25: a native sidecar-only
test now checks 17 representative conversion, math, array, file, console,
graphics, and string expressions in FB, FBLite, and deprecated modes; 14
QB-supported forms are checked in QB mode. Each supported form is verified on
host, x86-32, and AArch64 targets for authoritative editor types, with selected
compiler helper targets checked where the expression graph records a call.
`ImageCreate`, `IIf`, and `CVSHORT` are excluded from QB because that mode does
not accept those source forms. The fixture includes the compiler's `fbgfx.bi`
declarations and snapshots its physical include tokens, so it also exercises
the sidecar model across a real compiler dependency. The focused native-backed
sidecar suite passes 52/52 and the complete unit suite passes 335 tests with
one platform-conditional skip. This is a representative matrix, not all
implicit or lowered expression families.

Semantic operator fact consolidation checkpoint, 2026-09-25: schema 9 already
provides stable conceptual operator codes and kinds for external consumers;
the VS Code codebase decodes those fields and does not interpret raw AST class
or opcode numbers. The compiler exporter now replaces an adjacent raw-AST-only
expression fact when the parser supplies the source operator for the same
typed AST shape, preserving the fact ID and avoiding contradictory concepts.
A nine-operator matrix passes in four language modes and three target
architectures, and checks for conflicting concepts per unchanged AST shape.
The compiler semantic-model smoke test passes for both full and
expressions-only output. A fresh FBLite `-exx` x86-64 audit passed compiler
parity and direct models for all 2,427 current portable corpus files; none was
bounded, incomplete, or missing a model. The current `fbc` checkout includes
five additional QB lexer-boundary fixtures since the 2,422-file checkpoint.
The audit reports 40,474 semantic facts (27,458 runtime comparisons and
13,016 directive expressions), 425 trace supplements, and no missing,
ambiguous, or mistyped sidecar answers. In the 29-file SFX category, the fact
count returned from 9,786 to 9,691, with all 9,691 physical comparisons and
sidecar-only answers matching. A focused SFX/QB audit passed all 115 modules,
including the new fixtures, with no parity or semantic failures. The complete
sidecar suite passes 52/52. This validates the current x86-64 profile and
tested operator routes, not every compiler AST shape or future operator code.

Compiler-backend corpus checkpoint, 2026-09-25: the native audit now accepts
validated `--backend=gcc|clang|llvm|gas|gas64` profiles and applies the same
backend and target arguments to the stock compiler and editor bridge. It also
accepts a bounded `--timeout-ms` value (default 10 seconds, maximum 5 minutes)
for expensive compiler profiles. Explicit GAS/x86-64 and GAS64/x86-32 pairs
are rejected because FBC does not support those combinations. The
functions/threads/quirk subset passed all 226 files under Clang and LLVM on
x86-64, GAS64 on x86-64, and GAS on x86-32. Each run produced 226 models and
matching preprocessing output; the sidecar reported zero missing or mistyped
answers, including recovered expressions. The x86-64 backends compared 5,013
physical expressions per run; GAS/x86-32 compared 5,283. LLVM needed the
45-second per-file audit allowance for the large parameter-initializer test;
the complete subset then passed in 124 seconds. This verifies backend-specific
variadic/type paths in these categories, not the complete upstream corpus under
every backend or target.

QB lexer-recovery checkpoint, 2026-09-25: against the current FreeBASIC
checkout, the former `macro-eval-str` and UTF-16LE QB abort cases now finish
analysis with terminal semantic sidecars. The native audit no longer has a
mode-inapplicable exception for either file. A complete `-lang qb -arch
x86_64 -exx` pass covered all 2,427 current portable-corpus files, including
the five newer QB fixtures: all files matched compiler preprocessing and
produced direct plus prepared-worker models (180 complete, 2,247 recovered).
There were no bounded or incomplete analyses. The sidecar supplied 2,868
expression facts, including 1,438 physical comparisons, with zero missing or
mistyped answers; 60,967 recovery facts had no missing, mistyped,
unprovisional, or unsafe-retained result. The focused regression now requires
both former abort cases to reach EOF and emit a terminal model. This replaces
the earlier x86-64/extended-syntax QB exception evidence; the other target and
syntax-option combinations were checked separately against the current
lexer-fixed compiler: the 130-file `pp` category passed on x86-32, x86-64, and
AArch64, both with and without `-exx`. All six runs produced direct and
prepared-worker models for every file, with zero incomplete analyses,
preprocessing mismatches, or missing/mistyped semantic and recovery answers.
The full QB corpus remains re-audited on the current source only for the
x86-64/`-exx` profile; this checkpoint closes the lexer-sensitive category
matrix, not the full-corpus matrix for every target and option combination.

Implicit constructor relationship checkpoint, 2026-09-25: semantic-model
schema 10 now exports selected default constructors for scalar and fixed-array
declarations as explicit owner-to-target relationships. Each record also names
the owner's UDT identity and anchors to the declared variable; it does not
invent a callee token. Both full and bounded sidecar readers validate record
shape, ranges, footer totals, and symbol links. Project validation maps the
owner and UDT only through exact compiler declaration bindings and includes the
selected relationship in its before/after signature; the record never enters
the edit list. Schema-10 recovery remains expression-only. Decoder,
identity-mapping, and native compiler regressions pass, and the instrumented
bridge rebuilds successfully. The current unit suite passes 339/340 tests
(one platform-conditional skip), and the FBC `compiler-semantic-model-smoke`
target validates both complete schema-10 output and its unchanged expression-
only recovery footer. This covers default constructors only; implicit
copy/conversion constructors and other lowered constructor/destructor paths
still need separate source-context hooks and tests.

Explicit initializer-constructor checkpoint, 2026-09-25: schema-10 implicit
relationships now also cover compiler-selected copy and conversion
constructors in scalar UDT variable initializers. The declaration token is
passed into the initializer parser as relationship context, while the selected
constructor remains separate from editable identifier bindings. Native
sidecar checks prove default, copy, and conversion selections retain their
distinct constructor IDs and kinds; the FBC smoke test checks both record
families. A cross-module project rename of the UDT passed with all nine
compiler-bound edits previewed and no source files changed, proving these
initializer relationships survive project validation. Constructor overload
IDs are still invocation-local and have no distinct editable name occurrence,
so the project signature records owner, UDT, and constructor family rather
than a stable overload signature. Field and parameter initializers, argument
conversions, and other lowered construction/destruction routes remain open.
The instrumented compiler rebuild and FBC semantic-model smoke target pass;
the current extension unit suite passes 341/342 tests with one conditional
platform skip.

`NEW` constructor relationship checkpoint, 2026-09-25: scalar `NEW Type(...)`
and vector `NEW Type[count]` now export `new-constructor` records carrying the
resolved UDT, selected constructor, and exact type-token anchor. Project
validation maps this owner through the UDT declaration identity and requires
the anchor to match the compiler-bound type reference at the same physical
range; unanchored or ambiguous references are withheld. Native sidecar checks
cover overloaded scalar construction and vector default construction. The
cross-module UDT rename regression now includes both allocation forms and
validates thirteen source edits without changing saved files. Exact overload
identity remains invocation-local in the sidecar and is not yet part of the
cross-pass project signature; qualified/aliased type anchors that do not
resolve to the exact UDT reference remain fail-closed.

Constructor-path corpus checkpoint, 2026-09-25: the current schema-10 bridge
passed the upstream `pointers` and `structs` categories (330 files total) with
compiler preprocessing parity and both direct and prepared models for every
file. The sidecar audit compared 8,906 physical expressions and queried
15,762 semantic facts, with no missing or mistyped answers. Across 239
recovery facts, the audit found no missing, mistyped, unprovisional, or
unsafe-retained answers. This confirms the updated sidecar format
across real allocation, UDT-initializer, pointer, and recovery cases in those
categories; it does not close other compiler call routes or profiles.

Stable constructor-overload checkpoint, 2026-09-25: semantic-model schema 11
adds a bounded target signature to each implicit-constructor relationship.
The signature is derived from explicit parameter modes, optionality,
BYDESC dimensions, and canonical type spellings; compiler-generated instance
parameters are omitted and owner-UDT parameter names normalize to `$self`.
This preserves overload distinction without invocation-local procedure IDs,
including when a project rename changes the owning UDT name. Both sidecar
readers validate the new field and continue to decode schema 10; project
validation withholds legacy relationships that lack a stable signature. The
project transaction now compares that signature before and after the edit.
Native sidecar, schema decoder, and UDT project-rename regressions pass, as
does the FBC `compiler-semantic-model-smoke` target. Worker requests now carry
the binding-export and required-sidecar flags through the worker boundary;
without that handoff, project validation could not receive these facts. The
full extension unit suite passes 343 tests with one platform-conditional skip.

Schema-11 corpus re-audit checkpoint, 2026-09-25: the upstream `pointers` and
`structs` categories passed all 330 compiler-parity cases on the updated
sidecar (184 complete, 146 partial). The sidecar supplied 15,762 facts and
8,906 physical expression comparisons with zero missing or mistyped answers.
All 239 recovery facts were classified safely, with no missing, mistyped,
unprovisional, or unsafe-retained results. The audit reported no failures.
The stable-operator feedback is also reflected in the existing sidecar ABI:
conceptual operator fields have been exported since schema 8, and extension
semantic logic does not branch on the raw compiler AST IDs retained for
diagnostics and compatibility.

Additional implicit-constructor and label checkpoint, 2026-09-25: the schema-11
sidecar now records constructor selections for default-initialized UDT fields,
explicit field initializers, and optional UDT parameter initializers. Each fact
is anchored to the exact physical field or parameter declaration; parameter
declarations are also exported as native sidecar bindings so project validation
can cross into bridge identities without matching names. These records retain
the selected overload signature and remain separate from editable call
spellings. Native sidecar checks cover nine variable, field, parameter, and
allocation relationships. A cross-module UDT rename validates field and
optional-parameter relationships across a shared header and caller; its
mutation test confirms that changing a selected constructor signature is
rejected. Project rename now also has an end-to-end named-label case covering
GOTO, GOSUB, RETURN, ON, IF, error-handler, and RESTORE references. The FBC
semantic-model smoke target passes against the bridge built from the current
FBC source, the focused sidecar/project suites pass 108/108, and the full
native-backed unit suite passes 345/345. A fresh function/struct corpus audit
passed all 408 compiler-parity cases with direct and prepared models and no
bounded, incomplete, or failed analyses. It compared 10,964 physical
expressions; the function category retained 34 ambiguous sidecar matches but
no missing or mistyped answers, while structs had no ambiguous, missing, or
mistyped answers. Recovery facts across both categories had no missing,
mistyped, unprovisional, or unsafe-retained results.

Declaration-anchored destructor checkpoint, 2026-09-25: schema 12 adds
`destructor-call` relationships for UDT fields and variables when the compiler
selects their cleanup routine. Each record is anchored to the exact physical
declaration and carries the same bounded target signature used for constructor
selection. The sidecar decoders reject this new relationship in older schema
versions, and project validation maps it only through an exact declaration
identity; it remains metadata, never an edit occurrence. Native tests prove
field/local anchors, stable signatures, cross-module UDT rename validation,
and rejection when the selected destructor signature changes. Formal
parameters are intentionally excluded because FreeBASIC does not generate
parameter cleanup calls. The FBC smoke target and all 347 native-backed
extension unit tests pass with the schema-12 bridge. A fresh function/struct
corpus audit also passed all 408 compiler-parity cases (209 complete, 199
partial), with no bounded or incomplete analyses. It compared 10,964 physical
expressions with no missing or mistyped answers. The function category had 34
ambiguous sidecar matches but no missing or mistyped answers; structs had no
ambiguous, missing, or mistyped answers. The audit reported no failures, and
recovery answers had no missing, mistyped, unprovisional, or unsafe-retained
facts. Separately, the complete-file syntax inventory still found 247
expression ranges without a type record (zero type mismatches); that remaining
coverage gap is not hidden by the successful sidecar comparisons.

FBLite coverage checkpoint, 2026-09-25: the native corpus auditor now exposes
the dedicated upstream `fblite` directory, which had previously been omitted
from its selectable categories. An explicit FBLite-mode audit of that suite
plus expression, function, overload, pointer, scope, struct, syntax, and thread
categories passed all 724 preprocessing-parity cases (161 complete and 563
partial), with no bounded or incomplete analyses. It compared 4,496
non-directive physical expressions; four absent trace answers were safely
supplemented by the semantic sidecar, with no missing or mistyped results.
All 8,755 sidecar expressions were answerable, and all 14,863 safe recovery
facts were available without ambiguity, mismatch, unprovisional retention, or
unsafe retention. The syntax inventory contained 8,632 untyped ranges, all
marked invalid or provisional in recovered files; no complete file had an
untyped or mistyped syntax range. This is a targeted FBLite profile, not yet a
full mode/target/backend matrix. The complete native-backed unit suite passes
348/348 after the auditor and category test changes.

FBLite/AArch64 checkpoint, 2026-09-25: the same 724 cases also passed under
the compiler's AArch64 target profile, with 724/724 preprocessing parity and
no bounded or incomplete analyses. The sidecar supplied all 8,556 emitted
expression facts and all 14,863 safe recovery facts; among 4,297
non-directive physical comparisons, four missing trace answers were
sidecar-supplemented and none were missing or mistyped in the editor model.
All 8,632 ranges without ordinary type records remained explicitly marked as
invalid or provisional recovery syntax. This confirms the selected FBLite
surface across host and AArch64 type/ABI rules; other categories, targets, and
backends remain to be audited.

Generated-symbol project-refactoring checkpoint, 2026-09-25: project rename
now handles compiler-bound declarations whose names are generated by token
pasting, not only labels. A generated symbol can join a rename family only
when its ordered compiler source map resolves to editable source tokens and
the generated spelling is exactly reconstructed from those parts. The inverse
edit remains limited to one unique macro argument plus unchanged replacement
text; multiple arguments, stringification, and transformed origins remain
fail-closed. A generated variable now has compiler-backed coverage across
configured builds, including its physical references. Separate compiler-backed
cases also rename a generated procedure and a user type from their physical
calls/type references. A shared-header user type rename spans two project
modules and previews its macro argument and both physical references; a
two-argument generated variable is rejected.
The bridge was rebuilt from the current
1.20.4 compiler checkout, including its lexer fix and schema-12 semantic
operator vocabulary. The project-refactoring suite passes 55/55, the complete
native-backed unit suite now passes 353/353, smoke tests pass 6/6, and grammar
tests pass 2/2. The rebuilt Linux VSIX passes all 36 extension-host checks on
both VS Code 1.85.0 and 1.139.0. A fresh FBLite source-category audit also
passed all three current files, typing all 225 syntax ranges with no
semantic-sidecar mismatch.
The fresh QB audit passed preprocessing parity for all 86 files; its 783
sidecar expression comparisons had no missing or mistyped model answers, and
all 129 safe recovery facts matched. This includes both long-string and
UTF-16LE scanner-overflow fixtures. The offline API reference was regenerated
from the same source revision.

Default-FB corpus checkpoint, 2026-09-25: the current compiler bridge was
audited against all 2,430 `.bas` files in the native auditor's selected source
categories, including direct and prepared-worker models. The initial 10-second
deadline run timed out during worker preparation on three large inputs; replay
of their complete compound, expression, and struct categories at a 60-second
deadline passed all 378/378 compiler-parity checks, with no bounded or
incomplete analyses. Across the full profile, 1,114 analyses were complete and
1,316 recovered. The 878,176 typed expression ranges matched compiler syntax
ranges; the remaining 3,601 untyped ranges were all invalid or provisional
recovery nodes. There were no missing syntax nodes, unmarked recovery ranges,
or type mismatches. Semantic-sidecar validation reported no missing or
mistyped editor answers across the profile's 89,504 physical facts; the 12,116
facts in the replayed categories also had no missing answers, ambiguities, or
type mismatches, including 199 safe recovery facts. This provides broad
default-FB evidence for the host target; cross-target results follow.

Default-FB x86-32 checkpoint, 2026-09-25: the current bridge also passed all
2,430 selected files on the 32-bit target, with compiler preprocessing parity,
direct and prepared-worker models for every file, and no bounded, incomplete,
or failed analyses. Complete/recovered counts were 1,114/1,316. Of 883,087
compiler syntax ranges, 879,488 had ordinary typed ranges; all 3,599 remaining
ranges were marked recovery, with no missing syntax or type mismatches. The
semantic sidecar exposed 89,747 facts (61,083 physical comparisons and 28,664
directive expressions). All 512 supplemented trace omissions had no competing
type; 34 repeated-include ranges were conservatively withheld as ambiguous.
There were no missing or mistyped answers. All 2,167 safe recovery facts
matched, with no unsafe or unprovisional results. This establishes full
default-FB parity on x86-64 and x86-32.

Default-FB AArch64 checkpoint, 2026-09-25: all 2,430 selected files passed
compiler-preprocessing parity and produced both direct and prepared-worker
models, with no bounded, incomplete, or failed analyses. Complete/recovered
counts were 1,114/1,316. Of 853,988 compiler syntax ranges, 850,387 had
ordinary typed ranges; all 3,601 remaining ranges were marked recovery, with
no missing syntax or type mismatches. The sidecar exposed 88,912 facts
(60,254 physical comparisons and 28,658 directive expressions). There were
530 trace omissions, of which 496 were supplemented and 34 repeated-include
ranges were conservatively withheld as ambiguous. No editor answer was
missing or mistyped. All 2,165 safe recovery facts matched, with no unsafe or
unprovisional result. This completes the default-FB full-corpus matrix for
x86-64, x86-32, and AArch64; non-default language modes and backend-specific
matrices remain separate coverage requirements.

Schema-12 FBLite corpus checkpoint, 2026-09-25: the current bridge was
re-audited in `-lang fblite` across all 2,430 selected native corpus files on
x86-64, x86-32, and AArch64. Every profile matched compiler preprocessing and
produced both direct and prepared-worker models, with zero bounded, incomplete,
or failed analyses. Complete/recovered counts were 677/1,753 on x86-64,
675/1,755 on x86-32, and 677/1,753 on AArch64. The semantic-sidecar gate
reported no missing or mistyped editor answers and no unsafe recovery answers
on any target; the x86-64 report also showed zero ambiguities. On x86-64,
40,550 sidecar facts (27,508
physical and 13,042 directive expressions) included 425 correctly supplemented
trace answers. On x86-32, 40,504 facts (27,545 physical and 12,959 directive)
also included 425 supplemented trace answers. There were no type mismatches.
The x86-64 expression inventory had 315,784 syntax ranges, with all 13,130
ranges lacking ordinary type records marked as invalid or provisional
recovery; x86-32 had 317,536 syntax ranges and 13,143 such recovery ranges,
again with no unmarked recovery types. Of 1,257 x86-64 recovery facts and
1,257 x86-32 recovery facts, all 1,246 safe facts on each target matched with
no missing, mistyped, unprovisional, or unsafe-retained answers. The earlier
130-file `pp` slices are now subsumed by the full target runs. This closes the
current-schema default-option FBLite corpus across the three principal target
architectures, not the extended-syntax or backend matrix.

Schema-12 extended-syntax FBLite checkpoint, 2026-09-25: the current
lexer-fixed 1.20.4 bridge was audited with `-lang fblite -exx` over all 2,430
selected corpus files on x86-64, x86-32, and AArch64. Every target matched
compiler preprocessing and produced direct and prepared-worker models for all
files, with no bounded, incomplete, or failed analyses. Complete/recovered
counts were 677/1,753 on x86-64, 675/1,755 on x86-32, and 677/1,753 on
AArch64. The expression inventory had 315,784 syntax ranges and 302,654 typed
ranges on x86-64, 317,536 and 304,393 on x86-32, and 314,643 and 301,513 on
AArch64; every remaining range lacked an ordinary type only as marked recovery,
with no missing syntax ranges, unmarked recovery types, or type mismatches.
Sidecar coverage was 40,550 facts on x86-64 (27,508 physical comparisons and
13,042 directive expressions), 40,504 on x86-32 (27,545 and 12,959), and
40,240 on AArch64 (27,200 and 13,040). All 425, 425, and 409 absent trace
answers respectively were supplemented by the semantic sidecar. There were no
ambiguous, missing, or mistyped editor answers, no status disagreements, and
no unsafe or unprovisional recovery answers. This closes the extended-syntax
FBLite corpus matrix for the three principal target architectures, not the
backend matrix or other language modes.

LLVM full-corpus checkpoint, 2026-09-25: the current x86-64 LLVM profile ran
all 2,430 selected files with a 60-second per-file limit. It passed parity for
2,427 files and prepared 2,425 models; three known large inputs timed out:
`compound/select_const2.bas`, `expressions/iif.bas`, and
`structs/temp-var-dtors.bas`. The remaining 2,427 files had no bounded
analyses. Across the profile, 829,077 of 832,678 expression ranges had
ordinary types; all 3,601 untyped ranges were marked recovery, with no missing
syntax nodes or type mismatches. The sidecar exposed 88,769 facts, including
60,206 physical comparisons and 28,563 directive expressions. There were no
missing or mistyped sidecar answers; 503 of 537 trace omissions were
supplemented, while 34 physical ranges were conservatively withheld because
repeated include contexts made their type ambiguous. No safe recovery fact was
missing, mistyped, unprovisional, or unsafely retained.

The select-constant timeout was isolated from the editor exporter: stock FBC
with `-gen llvm -pp` still had not finished after 90 seconds, and the
instrumented bridge with tracing disabled did not finish its plain `-pp` pass
after 30 seconds. The bridge's expression-sidecar pass also exceeded 90
seconds. Both compilers continued expanding this intentionally macro-heavy
test, and the stock preprocessed output had reached about 922 KiB at timeout.
This attributes the extreme latency to the upstream LLVM/compiler workload,
not solely to editor tracing or sidecar serialization; the extension still
needs bounded handling for such compiler-pathological input. That editor-side
behavior is now covered by a native worker regression: `select_const2.bas`
under LLVM is canceled at a one-second request budget, no partial model is
published, and the same worker successfully analyzes a normal GCC module
afterward. This proves the editor remains responsive and reusable; it does not
complete semantic typing for the pathological compiler input.

The three affected categories were replayed with the maximum five-minute
per-file limit. All 378 files produced prepared models except
`compound/select_const2.bas`, which still timed out. Both
`expressions/iif.bas` and `structs/temp-var-dtors.bas` then passed. The replay's
377 passing files had no expression or recovery type mismatches, and all 199
safe recovery facts matched. This gives broad x86-64 LLVM evidence, but the
full LLVM profile remains incomplete because of the upstream select-constant
stress case; the other backends remain subset-tested.

Large-input timeout investigation, 2026-09-25: the three default-FB files
that exceeded the audit's 10-second request deadline were replayed individually
with 60 seconds available. `compound/select_const2.bas`, `expressions/iif.bas`,
and `structs/temp-var-dtors.bas` each produced complete, non-sidecar-only
prepared models, in 10.3, 11.3, and 11.1 seconds respectively. Worker model
construction took 1.0, 1.9, and 2.1 seconds; trace decoding took 0, 4.5, and
4.1 seconds. These are expensive but completed analyses, not hangs or missing
semantic results. The timeout covers the full queued request, so the audit's
10-second limit was insufficient; it remains important not to mask the
multi-second native analysis and decoding cost as mere test configuration.

Unsaved recovery checkpoint, 2026-09-25: a new native worker regression
combines a dirty module and dirty included header with a syntax error followed
by a valid expression. Prepared recovery reaches EOF, types the later member
expression from the unsaved header as `Double`, keeps the host event loop
runnable, and leaves both disk files unchanged. The complete native-backed
unit suite reports 355 tests: 354 passed and one platform-conditional test
skipped.

Prepared dependency-hint checkpoint, 2026-09-25: the worker now keeps a bounded
cache of dependency paths keyed by compiler, module, arguments, and environment.
It is limited to 32 contexts and 4 MiB, retains no source text, and rereads and
stamps every hinted path for each request. Changed build or environment
contexts do not share hints, and newly discovered dependencies still trigger a
frozen-source compiler pass. A native prepared
analysis of `expressions/iif.bas` dropped from two compiler passes and 11.3
seconds cold to one pass and 6.8 seconds after an unsaved edit, while producing
a complete model both times. Trace decoding fell from 4.5 to 2.2 seconds;
editor-model construction remained about 1.9 seconds. Unit coverage also proves
that a newly discovered include forces a retry and a changed compiler argument
set misses the hint cache. Worker diagnostics now report the pass count and
whether dependency hints were reused. The cache reduces repeat latency but does
not yet improve the first analysis of a large module.

Packaged runtime checkpoint, 2026-09-25: the Linux VSIX was rebuilt with the
dependency-hint implementation. All 33 packaged extension-host checks passed
on VS Code 1.85.0 and 1.139.0, including native Outline, workspace symbols,
unsaved-header typing, recovery, and project rename.

Argument-constructor checkpoint, 2026-09-25: semantic-model schema 13 adds
`argument-constructor` facts when the compiler selects a UDT constructor to
convert an actual procedure argument. The bridge carries the direct parser
range through `cExpression()` into the argument checker, then emits the
compiler-selected formal parameter, constructor, and UDT type. Macro-expanded
arguments are omitted because their source tokens do not form one physical
expression range. Project validation maps the owner through its exact
parameter declaration, checks that it is a parameter symbol, and retains
single- or multi-line physical callsites without treating them as edit tokens.
Regression coverage checks two constructor overloads, a continued expression,
macro exclusion, schema rejection before version 13, and a real project type
rename that must abort if the selected constructor signature changes. The
fresh Linux bridge builds from the current FBC source, and the full native-backed
unit suite passes 358/359 tests with one platform-conditional skip. This adds
one implicit-construction route, not complete coverage of all
compiler-generated conversions or lowering.
The packaged Linux VSIX also passes 35 editor-host checks on VS Code 1.85.0
and 1.139.1. Its argument-constructor rename case resolves a shared header
parameter across separate implementation and caller modules, checks overloaded
constructor targets, and confirms the returned preview does not write files.

Temporary-destructor checkpoint, 2026-09-25: semantic-model schema 14 now
exports a `temporary-destructor` relationship when the compiler actually builds
a UDT cleanup call while flushing its temporary list. Each live temporary is
associated with a verified physical parser range where one can be retained:
ordinary expression temporaries use their completed `cExpression()` range, and
compiler-generated `IIf()` temporaries use the physical `IIf()` range before
branch cleanup is flushed. The AST list stores only a bounded dependency index
and source coordinates, not a path copy. The record is type-owned (`owner ==
type`) and carries the selected destructor signature. Project validation
accepts it only when both identities map to the exact same declared UDT. Its
source range is comparison context, never an edit or rename token.
Macro-expanded, remapped, and other expression-internal temporaries without a
verified parser range, as well as non-UDT runtime cleanup, remain withheld. The
declaration-anchored destructor relationship remains separate; the compiler
still does not export each control-flow scope-exit cleanup site. Native
regressions cover function-result and nested `IIf()` temporaries, schema
rejection by older readers, exact project identity, and rejection of
nonphysical or mismatched facts. This closes one implicit-destruction route,
not all temporary, conditional, or scope-exit cleanup paths.

IIf provenance follow-up, 2026-09-25: the compiler bridge now passes the full
364-test unit suite (363 passed, one platform-conditional skip), six smoke
checks, and two grammar checks. The expression and implicit-call source-route
audits report no unowned hooks or drift, and both compiler and extension
`git diff --check` are clean. The native regression places a UDT-returning
`IIf()` inside arithmetic and verifies the cleanup fact uses the `IIf()` span,
not the larger enclosing expression. This range remains comparison-only.

Full native corpus follow-up, 2026-09-25: after the lexer fix, the complete
2,430-file upstream audit finished with preprocessing parity and a compiler
model for every file, with no bounded or incomplete analyses. The semantic
sidecar exposed 89,504 physical expression facts (60,842 checked against the
trace and 28,662 compile-time directive expressions); there were zero missing
answers or type mismatches. Of 546 expression ranges omitted by the trace, 512
were safely supplemented by the sidecar and 34 were conservatively ambiguous.
This establishes broad parser/type agreement for this corpus and target, not
complete coverage of every source grammar or backend.

Full GCC-backend follow-up, 2026-09-25: the same complete 2,430-file audit was
rerun with `-gen gcc` after the lexer fix. All files again preserved compiler
preprocessing parity and produced a model without bounded or incomplete
analysis. The sidecar exposed the same 89,504 physical expression facts and
the same 60,842 direct trace comparisons plus 28,662 compile-time directive
expressions. There were no missing answers, sidecar/trace type mismatches, or
backend-dependent differences in the aggregate results. As above, 512 of 546
trace omissions were safely supplemented and 34 remained conservatively
ambiguous. Partial/error-recovery syntax is still provisional or withheld where
the compiler cannot prove a type; this is full-corpus GCC evidence, not a
claim that every malformed expression has a definite type.

Macro-procedure reference checkpoint, 2026-09-25: project rename now joins an
unresolved preprocessor candidate to a compiler-bound procedure only when every
physical replacement-list token of that spelling in the translation unit maps
to one exact native family. The ordinary before/after compiler validation still
rejects new-name macro capture or changed overload selection. Unexpanded and
mixed-target replacement-list tokens remain fail-closed rather than being
assumed to name the selected procedure. Regressions cover a continued
replacement list, an unexpanded reference, and the existing cross-build
ambiguous-reference case. The native-backed unit suite passes 359/360 tests
with one platform-conditional skip. The packaged Linux VSIX passes 35 editor
checks on both supported VS Code versions.

Expression backend checkpoint, 2026-09-25: all 73 upstream
`tests/expressions` cases were audited with semantic-sidecar comparison across
GCC, Clang, LLVM, GAS/x86-32, and GAS64/x86-64. Every profile passed
preprocessing parity. Four profiles produced 3,705 physical expression facts
(2,745 direct trace comparisons and 960 directive expressions); GAS/x86-32
produced 3,682 (2,722 direct comparisons and the same 960 directive
expressions). Each profile had zero missing or mismatched sidecar answers.
The 46 intentionally partial/error-recovery cases retain 170 syntax ranges
without a stable type; 70 recovery facts were safely available and none
disagreed. This is backend coverage evidence, not proof that every incomplete
expression can be typed. GCC, Clang, GAS, and GAS64 each completed in about 50
seconds; LLVM took about 12.2 minutes, concentrated in `expressions/iif.bas`
(about 33 MiB of preprocessed source). This isolates a concrete LLVM
large-input responsiveness target while confirming that the same source corpus
and sidecar contract complete quickly with the other backends.

Dialect-profile checkpoint, 2026-09-25: the same 73 expression cases also
passed under FBLite and QB with the GCC backend. FBLite exposed 1,490 sidecar
facts, including 1,293 safe recovery facts; QB exposed 232 sidecar facts and
1,605 safe recovery facts. Both profiles had zero missing or mismatched
sidecar answers, and all 73 files in each profile preserved preprocessing
parity. These are mostly intentional parser-recovery inputs in the legacy
dialects (56 partial FBLite files and 71 partial QB files), so the result
validates fail-closed/provisional handling more strongly than complete legacy
expression coverage.

The stable operator concepts noted in schema 9 were also checked against the
current decoder and compiler-backed operator tests: editor semantic consumers
do not branch on the raw AST class or numeric operator fields. Those values
remain diagnostic-only; unsupported concepts fail closed as `none` in the
producer and unknown concept strings are rejected by the decoder.

Overload-corpus checkpoint, 2026-09-25: all 92 upstream `tests/overload` cases
passed with the GCC backend and semantic-sidecar comparison. There were 2,988
physical expression facts, 1,056 direct trace comparisons, and 1,932 directive
expressions; all emitted facts matched, including 23 safe recovery facts from
the 42 partial cases. No expression syntax was missing and no type mismatch,
unsafe recovery answer, or non-provisional recovery answer was reported. This
adds overload-resolution and conversion coverage beyond the expression
category, not a complete cross-backend overload matrix.

Compound-expression checkpoint, 2026-09-25: all 51 upstream `tests/compound`
cases passed preprocessing parity under GCC. The sidecar exposed 2,673
physical expression facts with no missing or mistyped sidecar answers; 64 safe
recovery facts from the 31 partial cases all agreed. This includes
`select_const2.bas`, which produces a usable model under GCC but still exceeds
the five-minute LLVM limit. That confirms the pathological timeout is
backend-specific rather than an unconditional limitation of the editor
exporter.

LLVM stress-watchdog checkpoint, 2026-09-25: `select_const2.bas` now has an
end-to-end worker regression using `-gen llvm` and a one-second request budget.
The worker rejects the pathological request in about 1.1 seconds, publishes no
partial model, and immediately completes a normal GCC analysis on the same
worker. The native-backed unit suite passes 360/361 tests with one
platform-conditional skip. This proves timeout cleanup and editor-side
responsiveness; a complete LLVM semantic model for this upstream test remains
unavailable within the five-minute corpus budget.

Declaration and dispatch semantic-sidecar checkpoint, 2026-09-25: the current
schema-14 bridge passed three additional GCC corpus sweeps: 318 `const` files,
346 `dim` files, and 253 combined `pointers`, `namespace`, and `virtual` files.
All 917 files passed preprocessing parity and direct plus prepared-worker
model construction; none was bounded or incomplete. The sidecar exposed 12,424
physical expression facts (6,913 direct trace comparisons and 5,511 directive
expressions), all available with no type/status mismatches, ambiguous ranges,
or unresolved answers. The two missing trace ranges were in `dim/byref.bas`
and were safely supplemented by the sidecar. Of 716 safe sidecar-only recovery
facts, all were available and provisional where required; no unsafe,
unprovisional, missing, or mistyped recovery answer was retained. This expands
compiler-backed evidence for constant initializers, declarations, pointer
forms, namespaces, and virtual calls; it remains GCC/host-target evidence and
does not prove complete coverage of the full upstream suite or every target.
The same 253-file `pointers`/`namespace`/`virtual` profile also passed with
`-arch aarch64`: preprocessing parity and prepared-model checks passed for all
files, and the same 5,761 sidecar facts had no missing, ambiguous, mistyped,
or unsafe recovery answers. These two targets provide cross-ABI evidence for
that subset only; they do not prove every source category or target.

The 318-file `const` and 346-file `dim` profiles also passed under
`-arch aarch64`: all 664 files preserved preprocessing and prepared-model parity,
with no bounded or incomplete analyses. The sidecar's 6,663 physical
expressions (4,186 direct comparisons and 2,477 directive expressions) all
matched or were available without ambiguity; no type/status mismatches or
unsafe recovery answers occurred. The same two `dim/byref.bas` trace omissions
were safely supplemented as on the host profile. This provides a second
target for the declaration/initializer surface, not a full cross-target audit.

Combined parser/scope recovery checkpoint, 2026-09-25: a native unsaved-overlay
regression combines two malformed expression parsers (`CAST(` and `NEW (`)
inside nested namespace/procedure scopes. It checks both properly closed scopes
and scopes left open at EOF. Both cases reach EOF, quarantine each malformed
line from trace and sidecar queries, preserve a later `Double` expression, and
leave the on-disk fixture untouched. A balanced scope retains the later trace
type as authoritative; an unterminated namespace/procedure makes it
provisional. The focused native recovery suite passes 2/2 with the bridge.
This covers one two-repair pairing across balanced and unterminated scopes;
other parser repair pairings and declaration/member recovery combinations
remain open.

LLVM emitter performance checkpoint, 2026-09-25: sampling the remaining
`select_const2.bas` stress case located the cost in the LLVM emitter's repeated
whole-section string concatenation, not in lexer macro expansion. The LLVM
backend now grows its declaration, body, and debug output buffers geometrically,
using the established section-buffer pattern from the C backend. The same
compile/preprocess command that did not finish within 150 seconds now completes
in about 2 seconds and emits the full 1.7 MiB output. A small `-gen llvm -r`
comparison against the bootstrap compiler produced byte-identical IR after
normalizing the compiler-output-name symbol.

The complete 2,430-file x86-64 LLVM semantic audit then finished in 873 seconds.
Using the patched bridge in both trace-disabled baseline and editor-trace
passes, every file preserved preprocessing parity; 2,428 produced semantic
models and two stopped before a terminal record. The sidecar exposed
89,498 physical expression facts (60,836 direct trace comparisons and 28,662
directive expressions). There were no missing or mistyped answers: 512 of 546
trace omissions were supplemented, and 34 repeated-include ranges remained
conservatively ambiguous. All 89,498 sidecar-only comparisons were available
except for those same 34 ambiguous ranges. Of 2,165 safe recovery facts, all
were available and correctly provisional. Complete expression ranges had no
missing syntax nodes or type mismatches; the 3,601 ranges without a stable type
were all marked as recovery. The two incomplete files are
`pointers/deref-cast-const-1.bas` and `pointers/deref-field-cast-const.bas`;
both the checkout bootstrap compiler and the rebuilt bridge reproduce an LLVM
backend segmentation fault (exit 12) on these compile-only tests. This is an
upstream compiler failure, not an editor/sidecar disagreement.

At the time of this checkpoint, the LLVM full-corpus run was incomplete because
of the pointer crashes and the then-unoptimized select-constant stress case.
The follow-up at the end of this plan supersedes those LLVM status findings;
the recorded measurements above remain as historical evidence.

Remaining: extend the cross-backend and cross-target matrices from these
sampled expression, overload, compound, declaration, pointer, namespace, and
dispatch categories toward full upstream coverage; broaden implicit/lowered
expression coverage; and expand refactoring coverage for other macro-origin
references and implicit or lowered relationships not yet represented at
declaration or physical expression sites, including additional
expression-internal temporary cleanup sites. LLVM assembler compatibility
and end-to-end code generation are also not established by semantic audits.
Numeric and named label references across the currently represented branch
forms now have project-rename coverage. Recovery-led coverage for other
parser-repair pairings and declaration/member combinations with structural
scopes also remains open.

The extension's editor-trace instrumentation is still applied to isolated
compiler copies during bridge builds. The user-authorized `-semantic-model`
interface, UTF-8 location fix, and encoded physical-range validation are
maintained in the supplied `fbc` checkout. Test objects, bridge builds,
fixtures, and generated artifacts stay in this extension's tree or owned
temporary directories.

Scope-exit destructor checkpoint, 2026-09-30: FreeBASIC semantic-model schema
15 now exports compiler-selected UDT destructors inserted while lowering
`GOTO`, `RETURN`, `EXIT`, and `CONTINUE`. Each relationship is anchored only to
the verified physical branch keyword and carries the exact local-variable,
destructor, and UDT identities; it is metadata, never an edit occurrence. The
extension decoder and project rename validator accept this new relationship,
and a rename regression confirms that changing its compiler-selected
signature invalidates a type rename preview. Native coverage verifies all four
branch forms and exact source slices. The semantic-sidecar and project suites
pass 125 tests with one platform skip (126 total) against the rebuilt bridge.
The native fixture also confirms a macro-expanded branch is withheld rather
than assigned a guessed physical source range.
The full native-backed unit suite then passed 367 tests with one platform skip
(368 total); expression-route and call-route audits reported no unowned routes,
duplicate ownership, stale hooks, or definition drift.
The rebuilt Linux VSIX installed and passed all 35 extension-host checks on
VS Code 1.121.0 with the rebuilt native bridge enabled, including the native
Outline/workspace-symbol providers and compiler-backed rename paths.
Other implicit and lowered relationships, macro-origin references, backend
crashes, and wider target/backend matrices remain open.

DELETE destructor checkpoint, 2026-09-30: FreeBASIC semantic-model schema 16
now records the compiler-selected UDT destructor for scalar `DELETE` and
vector `DELETE[]`, anchored to the verified physical keyword and exact pointee
UDT identity. These relationships are not editable occurrences. The sidecar
test covers both forms, while project rename validation rejects a UDT rename
when either compiler-selected delete-destructor signature changes. The
isolated compiler-bridge instrumentation was updated to match the new parser
declaration without changing the shipped compiler source. The full
native-backed unit suite passed 371 tests with one platform skip (372 total);
both route audits are clean. The rebuilt Linux VSIX again passed all 35
extension-host checks on VS Code 1.121.0 with native analysis enabled.

Scalar default-`NEW` constructor checkpoint, 2026-09-30: `NEW Type` without
parentheses now exports the exact default constructor selected by `cCtorCall`,
matching the existing explicit scalar and vector paths. The native constructor
matrix verifies all three `NEW` forms, exact type-token anchors, target
signatures, and project identity mapping; the project rename fixture also
includes scalar default `NEW`.

RETURN-expression constructor checkpoint, 2026-09-30: semantic-model schema 17
now exports the constructor selected when a `RETURN` expression is converted
into a UDT function result. Its source range covers the physical return
expression, including continued expressions, while the relationship remains
metadata-only and can be projected for rename validation only through the
exact result UDT identity. Native sidecar and project-rename tests verify the
compiler-selected target, multiline range, and invalidation when its signature
changes. The lightweight scanner regression now distinguishes a trailing
identifier underscore from a standalone continuation marker while preserving
real continued statements. Its parser/TextMate tests pass 22/22, and the source
corpus audit validated declaration ranges and symbol resolution across 1,414
FreeBASIC files (67,621 declarations and 947,753 tokens). The full
native-backed unit suite passes 376 tests with one platform skip (377 total);
expression and call-route audits are clean. The rebuilt Linux VSIX passes all
35 extension-host checks on VS Code 1.121.0. These checks verify the reported
extension-scanner fix but do not replace broader compiler lexer/parser corpus
coverage.

Clang expression/overload/compound/pointer/UDT checkpoint, 2026-09-30: the
schema-17 bridge passed all 546 selected upstream cases across
`expressions` (73), `overload` (92), `compound` (51), `pointers` (76), and
`structs` (254), with preprocessing parity and direct plus prepared-worker
models for every file. The audit compared 14,582 physical expression traces
and checked 10,546 compile-time directive expressions against 25,128 semantic
facts. Sixteen missing trace answers were safely supplemented; there were no
ambiguous, missing, mistyped, or status-mismatched answers. Of 230 safe
recovery facts, all were available and correctly provisional. The complete
file expression inventory had no missing syntax ranges, unmarked recovery
types, or type mismatches. This materially broadens Clang evidence for
expression typing and overload resolution, but is not a full-corpus Clang run
or proof of all target/backend combinations.

Full Clang/x86-64 semantic checkpoint, 2026-09-30: the current schema-17
bridge completed all 2,430 selected portable upstream files with `-gen clang`.
Every file matched stock-compiler preprocessing and produced direct and
prepared-worker models; no request was bounded or incomplete. Of 881,777
complete-file syntax ranges, 878,176 had ordinary type records, and all 3,601
remaining ranges were explicitly recovery-marked; no syntax range was missing
and no type mismatch or unmarked recovery type occurred. The sidecar exposed
89,504 semantic facts (60,842 physical expression comparisons and 28,662
directive expressions). Of 546 expressions absent from the direct trace, 512
were safely supplied by the sidecar and 34 repeated-include ranges were
conservatively withheld as ambiguous. There were no missing or mistyped editor
answers, and the audit reported no failures. This closes the selected
portable-corpus Clang/x86-64 profile; other backends and target combinations
remain separate requirements.

Full GAS64/x86-64 semantic checkpoint, 2026-09-30: the same 2,430-file
profile passed with `-gen gas64`; every file preserved preprocessing parity
and produced direct plus prepared-worker models, with no bounded or
incomplete analyses. The complete-file expression inventory again had no
missing syntax ranges or type mismatches: all 3,601 ranges without ordinary
types were marked recovery. Its 89,504 semantic facts had no missing or
mistyped editor answers; 512 of 546 trace omissions were supplemented and
the same 34 repeated-include ranges were conservatively withheld. This closes
the selected portable-corpus GAS64/x86-64 profile, not the other backend and
target combinations.

Full GAS/x86-32 semantic checkpoint, 2026-09-30: the same profile passed with
`-gen gas -arch 386`; all 2,430 files matched preprocessing and produced
direct plus prepared-worker models, with no bounded or incomplete analyses.
The complete-file inventory contained 883,087 syntax ranges, of which
879,488 had ordinary type records and 3,599 were explicitly recovery-marked;
there were no missing syntax ranges, unmarked recovery types, or type
mismatches. The sidecar exposed 89,747 facts (61,083 physical comparisons and
28,664 directive expressions); 512 of 546 trace omissions were supplemented,
with the other 34 conservatively ambiguous. There were no missing or mistyped
editor answers or audit failures. This closes the selected portable-corpus
GAS/x86-32 profile, not every architecture/backend pairing.

LLVM pointer target follow-up, 2026-09-30: the schema-17 bridge passed all 76
upstream pointer files for compiler preprocessing under `-gen llvm` on
x86-64, x86-32, and AArch64 (228 parity checks total). Each target produced 74
direct and prepared models; the same two compiler-side failures remained
incomplete with exit 12 on all three targets:
`pointers/deref-cast-const-1.bas` and
`pointers/deref-field-cast-const.bas`. The other 74 files per target had no
bounded or incomplete analyses. Complete-file syntax coverage had no missing
ranges, unmarked recovery types, or type mismatches, and all 2,754 sidecar
facts per target were available without ambiguity or mismatch. The identical
two failures across targets point to a source/LLVM lowering defect, not a
target-specific ABI path or semantic-sidecar disagreement.

Full Clang/x86-32 semantic checkpoint, 2026-09-30: all 2,430 selected files
passed with `-gen clang -arch 386`, preserving preprocessing parity and
producing direct plus prepared-worker models. No analysis was bounded or
incomplete. Of 881,910 complete-file syntax ranges, 878,311 had ordinary type
records and all 3,599 remaining ranges were recovery-marked; there were no
missing syntax ranges, unmarked recovery types, or type mismatches. The
sidecar exposed 89,484 facts (60,821 physical comparisons and 28,663 directive
expressions); 512 of 546 trace omissions were safely supplied, while 34
repeated-include ranges remained conservatively ambiguous. There were no
missing or mistyped editor answers or audit failures. This extends the full
Clang profile to x86-32, not all Clang targets.

Full Clang/AArch64 semantic checkpoint, 2026-09-30: all 2,430 selected files
also passed with `-gen clang -arch aarch64`, with preprocessing parity and
direct plus prepared-worker models throughout; no request was bounded or
incomplete. Of 853,988 complete-file syntax ranges, 850,387 had ordinary type
records and all 3,601 remaining ranges were marked recovery. There were no
missing syntax ranges, unmarked recovery types, or type mismatches. The
sidecar exposed 88,912 facts (60,254 physical comparisons and 28,658 directive
expressions). Of 530 trace omissions, 496 were safely supplemented and 34
repeated-include ranges remained conservatively ambiguous. No editor answer
was missing or mistyped and the audit reported no failures. Together with the
x86-32 and x86-64 runs, this closes the selected portable-corpus Clang matrix
across the three principal targets.

Temporary-destructor branch-lowering follow-up, 2026-09-30: the existing
schema-14 temporary-destructor fact now also covers destructor-bearing UDT
temporaries created by `astTypeIniUpdate()` while `astBuildBranch()` lowers
ordinary `IF`/`ELSEIF`, `WHILE`, and `DO` conditions. The parser passes a
bounded copy of the condition's physical source range across that lowering
step, and newly appended destructor-list entries are associated before either
branch cleanup path flushes them. `WITH`-extended temporaries also retain a
temporary-destructor fact at their physical creating expression before their
scope-owned locals leave the ordinary temporary list. A native regression
verifies precise initializer and call ranges in `IF`, `WITH`, and assignment
contexts, physical provenance, exact UDT identities, and project-level
relationships for destructor-only type initializers. The lexer continuation
regression is included. The source checkout's offline API reference bundle
was regenerated to the current FBC revision, restoring source-reproducibility
coverage. These additions close late temporary-provenance gaps, not all
compiler-generated cleanup relationships.

Generic TYPEINI lowering follow-up, 2026-09-30: `cExpression()` now retains
validated source coordinates on TYPEINI AST nodes while their syntax tree is
still available. `astTypeIniUpdate()` transfers that bounded provenance to
each compiler temporary created later by `astUpdate()`, allowing the existing
schema-14 destructor record to identify the actual initializer rather than
silently omit the cleanup. AST nodes store only a dependency index and line /
column coordinates; traversal uses a bounded explicit stack and fails the
semantic module closed if its resource limit is reached. The native regression
covers an assignment `target = Type<UDT>(...)` whose destructor is generated
only during late lowering, alongside the branch, call, and WITH cases. The
rebuilt bridge passes all 74 semantic-sidecar tests and the full native-backed
unit suite passes 376 tests with one platform-conditional skip (377 total).

Full native corpus follow-up, 2026-09-30: rerunning all 2,430 selected FBC
sources against the rebuilt bridge with a 30-second per-model audit timeout
produced compiler parity, direct models, and prepared worker models for every
file. No analyses were bounded or incomplete, and there were no corpus
failures. Across 89,504 physical expression facts, all 60,842 comparable
compiler-trace answers and 28,662 directive expressions agreed with the
sidecar/editor answers: zero missing, mistyped, or status-mismatched results.
The trace omitted 546 ranges; 512 were safely supplemented from the sidecar,
while 34 remained explicitly ambiguous. Recovery checks over the 1,316
partial files compared 2,165 safe facts with no missing, ambiguous,
unprovisional, or mistyped answers. This verifies the updated cleanup facts on
the audited default target/backend; it does not close other target/backend
coverage or prove complete compiler-generated cleanup coverage.

Full default-backend target follow-up, 2026-09-30: the same 2,430-file audit
also passed under `-arch 386` and `-arch aarch64`, with `-gen` left at the
compiler default. Both targets preserved preprocessing parity and produced
direct plus prepared-worker models for all files; neither had bounded or
incomplete analyses or audit failures. On x86-32, the sidecar exposed 89,747
facts (61,083 trace comparisons and 28,664 directive expressions); on
AArch64, it exposed 88,912 (60,254 trace comparisons and 28,658 directive
expressions). Neither target had missing, mistyped, or status-mismatched
answers. The complete-file syntax inventories had no missing ranges or type
mismatches; the 3,599 x86-32 and 3,601 AArch64 ranges without ordinary type
records were all marked as recovery. Trace omissions were handled
conservatively: 512/546 were supplemented on x86-32 and 496/530 on AArch64,
with 34 repeated-include ranges remaining ambiguous on each. Together with
the x86-64 default-backend profile above, this closes the selected full
portable-corpus default-backend matrix across the three principal targets.
Other code generators, language modes, source families, and compiler-generated
cleanup relationships remain separate coverage requirements.

Full GCC target follow-up, 2026-09-30: the 2,430-file `-gen gcc` profile also
passed on x86-32 and AArch64, completing the selected GCC matrix with the
previous x86-64 run. Both new runs preserved preprocessing parity and produced
direct plus prepared-worker models for every file, with no bounded or
incomplete analyses or audit failures. x86-32 exposed 89,487 semantic facts
(60,822 trace comparisons and 28,665 directive expressions); AArch64 exposed
88,912 (60,254 comparisons and 28,658 directive expressions). Both had zero
missing, mistyped, or status-mismatched answers. Complete-file syntax had no
missing ranges or type mismatches; the 3,599 x86-32 and 3,601 AArch64 ranges
without ordinary types were all recovery-marked. The sidecar supplemented
512/546 omitted trace ranges on x86-32 and 496/530 on AArch64; 34 repeated-
include ranges remained ambiguous on each target. This closes the selected
portable-corpus GCC matrix across the three principal targets, not all
code-generator, language-mode, or source-family combinations.

Reference and packaged integration follow-up, 2026-09-30: the offline
FreeBASIC 1.20.4 reference bundle was regenerated from the configured source
checkout at revision `87703cbfde7893a62189770afd1c518e2077cb5f`. Its API
source hash and all 602 entries were unchanged; the regeneration updated the
source-revision provenance that had made the reproducibility test fail. The
native-backed unit suite now passes 376 tests with one platform skip, smoke
checks pass 6/6, and TextMate grammar tests pass 2/2. A freshly rebuilt Linux
VSIX installed in an isolated profile and passed all 35 extension-host checks
on VS Code 1.121.0, including native Outline, workspace symbols, unsaved
headers, parser recovery, and compiler-validated project rename. Expression-
and call-route audits report no unowned routes, duplicate ownership, stale
hooks, or definition drift. That checkpoint preceded the LLVM pointer fix
below; its package/test evidence is superseded by the post-fix verification.

LLVM constant-pointer and full semantic-profile follow-up, 2026-09-30: the
earlier LLVM pointer failures were an LLVM backend bug in `hPrepareAddress()`.
For a pointer virtual register with no backing register, the absolute address
is carried in `ofs`; LLVM lowering had instead dereferenced the absent `vidx`.
The compiler now materializes that address as a pointer value before applying
the load. A native regression compiles both
`pointers/deref-cast-const-1.bas` and
`pointers/deref-field-cast-const.bas` to LLVM IR with result-only mode, checking
the `inttoptr` and subsequent load. The emitted IR is not an end-to-end
assembler check: the installed LLVM 21 `llc` rejects the compiler's legacy
typed-pointer IR syntax, so no claim is made that this toolchain can assemble
or link that output.

After rebuilding the bridge from the patched FBC source, the focused LLVM
pointer category passed on x86-64, x86-32, and AArch64: 76/76 files per target
preserved compiler preprocessing and produced direct plus prepared models,
with no bounded or incomplete analyses, missing types, or mismatches. The
full selected x86-64 LLVM semantic corpus then passed all 2,430 files in about
15.3 minutes with a 60-second per-model timeout. Every file preserved
preprocessing parity and produced direct plus prepared-worker models; none was
bounded, incomplete, or failed. Expression coverage had 878,176 ordinary
typed ranges of 881,777 syntax ranges; all 3,601 remaining ranges were
explicitly recovery-marked, with no missing syntax, unmarked recovery, or
type mismatches. The sidecar exposed 89,504 facts (60,842 trace comparisons
and 28,662 directive expressions). Of 546 absent trace ranges, 512 were
supplemented and 34 repeated-include ranges remained conservatively
ambiguous. There were no missing, mistyped, or status-mismatched answers.

The patched bridge was used as both the trace-disabled compiler baseline and
the editor-instrumented compiler for this run: the checkout's bootstrap
`bin/fbc` predates the fix and still crashes on the two pointer tests. This
keeps the comparison at one compiler revision while measuring tracing
parity. The earlier x86-64 LLVM full-corpus checkpoint and three-target
pointer checkpoint above are historical and are superseded by this result.
This closes the selected LLVM semantic/preprocessing profile on x86-64 and
the pointer-category profile on all three principal targets. It does not
establish LLVM assembly/link compatibility, all LLVM source families or
language modes, or the full backend/target matrix.

Post-LLVM-fix verification, 2026-09-30: the new constant-pointer regression
passed against the rebuilt bridge, and the native-backed unit suite passed
377 tests with one platform-conditional skip (378 total). Smoke checks passed
6/6 and TextMate grammar tests passed 2/2. The expression- and call-route
audits reported no unowned routes, duplicate ownership, stale hooks, or
definition drift. A freshly rebuilt Linux VSIX passed all 35 packaged
extension-host checks on VS Code 1.121.0. `git diff --check` passed for both
the extension and FBC worktrees. The package version remains 1.20.4.

Current-source QB/x86-32 corpus checkpoint, 2026-09-30: after the upstream
lexer fix, the formerly failing QB macro string-evaluation inputs now pass in
the complete selected corpus. The FBC checkout's stock compiler was rebuilt
from current source with `make -B -j2 compiler`, and
`make compiler-semantic-model-smoke` passed. With `-lang qb -arch 386`, the
rebuilt stock compiler and instrumented bridge passed preprocessing parity
for all 2,430 files and produced direct plus prepared-worker models for all
2,430; there were no bounded or incomplete analyses or corpus failures. Of
203,212 complete-file syntax ranges, 118,969 had ordinary type records and
the remaining 84,243 were all explicitly recovery-marked; there were no
missing syntax ranges or type mismatches. The sidecar exposed 2,534 facts
(1,362 physical trace comparisons and 1,172 directive expressions). All 22
trace omissions were supplemented, with no ambiguous, missing, mistyped, or
status-mismatched answers. This replaces the pre-fix QB/x86-32 crash reports
and closes the selected full-corpus QB/x86-32 profile; other QB targets and
syntax-option combinations remain separate coverage requirements.

The corpus runner now retries an `EACCES` compiler-start failure up to three
times with bounded backoff (25, 100, and 250 ms). Persistent permission errors
and other spawn failures still fail the audit. The focused audit tests pass
6/6, and the full extension unit suite passes 379 tests with one
platform-conditional skip (380 total); smoke checks pass 6/6 and TextMate
grammar tests pass 2/2.

Current-source QB/x86-64 corpus checkpoint, 2026-09-30: the full default
syntax audit built and prepared worker models for all 2,430 files with no
bounded or incomplete analyses. Its stock-compiler comparison completed for
2,429 files; one baseline launch for
`const/const-decl-illegal-type-fwdref.bas` failed with process-start `EACCES`,
not a compiler-output disagreement. Re-running the complete 318-file `const`
category with the bounded three-retry policy passed 318/318, including that
file, so the combined corpus evidence covers all 2,430 files. Expression
coverage had 118,686 ordinary type records over 202,588 syntax ranges; all
83,902 remaining ranges were recovery-marked, with no missing syntax or type
mismatches. The sidecar exposed 2,878 facts (1,448 physical comparisons and
1,430 directive expressions); all 22 trace omissions were supplemented, with
zero ambiguous, missing, mistyped, or status-mismatched answers. The direct
and prepared worker models covered all files. This closes the selected
default-syntax QB/x86-64 profile; AArch64 and the wider syntax-option matrix
remain open.

Current-source QB/AArch64 corpus checkpoint, 2026-09-30: with the rebuilt
current-source compiler and instrumented bridge under `-lang qb -arch aarch64`,
all 2,430 selected files passed preprocessing parity and produced direct and
prepared worker models. There were 184 complete and 2,246 partial analyses,
with no bounded or incomplete analyses and no corpus failures. Of 202,010
syntax ranges, 118,351 had ordinary type records; the other 83,659 were
explicitly recovery-marked. There were no missing syntax ranges, unmarked
recovery ranges, or type mismatches. The sidecar exposed 2,987 facts (1,451
physical trace comparisons and 1,536 directive expressions). All 22 absent
trace expressions were supplemented; there were no ambiguous, missing,
mistyped, or status-mismatched answers. This closes the selected default-syntax
QB/AArch64 profile and, together with the x86-32 and x86-64 checkpoints above,
confirms the upstream lexer fix across all three audited targets. Other QB
syntax-option combinations remain open.

Current-source QB/x86-32 extended-syntax corpus checkpoint, 2026-09-30: the
complete selected corpus passed with `-lang qb -arch 386 -exx`: 2,430/2,430
files matched preprocessing and produced direct plus prepared worker models,
with 176 complete and 2,254 partial analyses, no bounded or incomplete
analyses, and no failures. Of 203,117 syntax ranges, 118,738 had ordinary type
records; the remaining 84,379 were recovery-marked. There were no missing
syntax ranges, unmarked recovery ranges, or type mismatches. The sidecar
exposed 2,534 facts (1,362 physical trace comparisons and 1,172 directive
expressions); all 22 missing trace answers were supplemented, with zero
ambiguous, missing, mistyped, or status-mismatched answers. This closes the
current-source x86-32 `-exx` full-corpus profile; x86-64 and AArch64 extended
syntax profiles still need current-source full-corpus confirmation.

Current-source QB/AArch64 extended-syntax corpus checkpoint, 2026-09-30: the
full selected corpus passed under `-lang qb -arch aarch64 -exx`, with 2,430
preprocessing parity checks and 2,430 direct and prepared worker models. There
were 184 complete and 2,246 partial analyses, with no bounded, incomplete, or
failed files. Of 201,915 syntax ranges, 118,120 had ordinary type records and
the other 83,795 were recovery-marked; no syntax ranges were missing and there
were no unmarked recovery ranges or type mismatches. The sidecar exposed 2,987
facts (1,451 physical trace comparisons and 1,536 directive expressions).
All 22 absent trace expressions were supplemented, with zero ambiguous,
missing, mistyped, or status-mismatched answers. This closes the current-source
AArch64 `-exx` full-corpus profile. Only x86-64 `-exx` remains to complete the
current-source six-profile QB target/option matrix.

Current-source QB/x86-64 extended-syntax corpus checkpoint, 2026-09-30: the
final profile also passed across all 2,430 selected files under `-lang qb
-arch x86_64 -exx`, with matching preprocessing and direct plus prepared
worker models. There were 181 complete and 2,249 partial analyses, no bounded
or incomplete analyses, and no corpus failures. Of 202,493 syntax ranges,
118,455 had ordinary type records; the remaining 84,038 were recovery-marked.
There were no missing syntax ranges, unmarked recovery ranges, or type
mismatches. The sidecar exposed 2,878 facts (1,448 physical trace comparisons
and 1,430 directive expressions); all 22 missing trace answers were
supplemented, with zero ambiguous, missing, mistyped, or status-mismatched
answers. Together with the current-source default-syntax profiles above, this
closes the selected six-profile QB matrix across x86-32, x86-64, and AArch64,
both with and without `-exx`. This is broad selected-corpus coverage, not proof
of every QB construct or every language-mode/backend combination.

Latest QB status: the lexer-fix-era selected corpus is now green in all six
target/option profiles. Earlier entries record intermediate failures and
partial reruns; the three default-syntax checkpoints and three extended-syntax
checkpoints above supersede those intermediate statuses.

Current-source FBLite/x86-64 corpus checkpoint, 2026-09-30: all 2,430 selected
files passed preprocessing parity and produced direct plus prepared worker
models under `-lang fblite -arch x86_64`; 677 analyses were complete and 1,753
partial, with no bounded, incomplete, or failed analyses. Of 315,784 syntax
ranges, 302,654 had ordinary type records and all 13,130 remaining ranges
were recovery-marked. There were no missing syntax ranges, unmarked recovery
types, or type mismatches. The sidecar exposed 40,554 facts (27,508 physical
trace comparisons and 13,046 directive expressions). All 425 missing trace
answers were supplemented, with zero ambiguous, missing, mistyped, or
status-mismatched answers. This refreshes the selected FBLite/x86-64 profile
against the current 2,430-file source corpus; x86-32 and AArch64 still need
the same current-source full-corpus confirmation.

Current-source FBLite/x86-32 corpus checkpoint, 2026-09-30: all 2,430 selected
files matched preprocessing and produced direct plus prepared worker models
under `-lang fblite -arch 386`; 675 analyses were complete and 1,755 partial,
with no bounded, incomplete, or failed analyses. Of 317,536 syntax ranges,
304,393 had ordinary type records and the remaining 13,143 were recovery-
marked. No syntax ranges were missing, and no unmarked recovery types or type
mismatches occurred. The sidecar exposed 40,508 facts (27,545 physical trace
comparisons and 12,963 directive expressions). All 425 absent trace answers
were supplemented, with zero ambiguous, missing, mistyped, or
status-mismatched answers. AArch64 remains to complete the current-source
FBLite target matrix.

Current-source FBLite/AArch64 corpus checkpoint, 2026-09-30: all 2,430 selected
files passed preprocessing parity and produced direct plus prepared worker
models under `-lang fblite -arch aarch64`; 677 analyses were complete and
1,753 partial, with no bounded, incomplete, or failed analyses. Of 314,643
syntax ranges, 301,513 had ordinary type records and all 13,130 remaining
ranges were recovery-marked. There were no missing syntax ranges, unmarked
recovery types, or type mismatches. The sidecar exposed 40,244 facts (27,200
physical trace comparisons and 13,044 directive expressions). All 409 absent
trace answers were supplemented; no answer was ambiguous, missing, mistyped,
or status-mismatched. Together with the refreshed x86-32 and x86-64 runs above,
this closes the selected current-source FBLite full-corpus matrix on all three
principal targets. It does not cover `-exx`, other language modes, or all
backend/target combinations.

Latest FBLite status: the three current-source default-option runs cover all
2,430 selected files on x86-32, x86-64, and AArch64. Earlier 2,422-file
checkpoints remain useful history; these 2,430-file audits supersede them for
the default-option semantic profile.

Single-component multi-argument token-paste rename checkpoint, 2026-09-30:
validated project rename now supports a generated symbol when its new spelling
can be formed by editing exactly one physical macro-argument token while
keeping every other generated component unchanged. Repeated output components
from that same physical token are handled as one edit; independently changed
arguments, stringification, transformed origins, and ambiguous decompositions
remain fail-closed. The compiler-bound rename transaction still recompiles all
configured build contexts before previewing edits. Native regressions cover
prefix and suffix component changes, repeated source arguments, a generated
variable, and a generated QB label; a two-component rename and stringified
argument remain refusal cases. The focused cases pass 4/4, the full
native-backed unit suite passes 381 tests with one platform skip (382 total),
and the VS Code 1.121.0 extension host passes all 37 integration checks,
including a standard-provider test for this macro rename and its refusal case.

Current-header language-data follow-up, 2026-09-30: the configured FBC header
`inc/sfxlib_raw.bi` adds `sfxlib.MidiPlaying`. The source-backed grammar audit
found it missing from the bundled API-name surface. `MIDIPLAYING` is now part
of generated function highlighting, and the offline reference includes its
zero-argument signature, source header, and namespace. The reference bundle
now contains 603 names. The source coverage audit passes, smoke tests pass
6/6, TextMate tests pass 2/2 (including actual `MidiPlaying()` tokenization),
and the offline reference tests pass 3/3.

Token-pasted physical-reference rename follow-up, 2026-09-30: project
transactions now retain validated macro-part provenance for generated native
references as well as generated declarations. When a token-pasted expansion
binds to an ordinary physical symbol, rename may update one physical macro
argument if that single component uniquely produces the requested spelling;
all configured contexts are still recompiled before edits are returned. A
rename needing multiple argument changes, a stringified occurrence, or
incomplete provenance remains fail-closed. Native project and macro tests pass
77/78 with one platform skip, the full unit suite passes 382/383 with one
platform skip, and the VS Code 1.121.0 extension host passes all 37 checks.

Current-source FBLite/x86-64 extended-syntax follow-up, 2026-09-30: the
2,430-file semantic audit under `-lang fblite -arch x86_64 -exx` matched
preprocessing for 2,429 files and built 2,430 direct models. Its sole initial
audit failure was a 10-second timeout while preparing
`compound/select_const2.bas`; the other profiles had no bounded or incomplete
analyses. The full run found no missing syntax ranges or type mismatches, and
all 13,130 ranges without ordinary types were marked recovery. Its 40,554
semantic facts had no missing, ambiguous, mistyped, or status-mismatched
answers; all 425 trace omissions were supplemented. Re-running the entire
`compound` category with a 120-second per-file bound passed all 51/51 parity
checks, produced all 51 prepared models, and found zero semantic-sidecar
issues, including for `select_const2.bas`. Together these runs cover direct
and prepared models for every selected file in this profile; the single-run
timeout is retained here as responsiveness evidence rather than hidden as a
semantic failure.

Current-source FBLite/x86-32 extended-syntax checkpoint, 2026-09-30: all 2,430
selected files passed preprocessing parity and produced direct plus prepared
worker models under `-lang fblite -arch 386 -exx`, with no bounded, incomplete,
or failed analyses. Of 317,536 complete-file syntax ranges, 304,393 had
ordinary type records and the remaining 13,143 were recovery-marked; there
were no missing syntax ranges, unmarked recovery types, or type mismatches.
The sidecar exposed 40,508 facts (27,545 physical trace comparisons and
12,963 directive expressions). All 425 missing trace answers were
supplemented, with zero ambiguous, missing, mistyped, or status-mismatched
answers. This closes the current-source FBLite/x86-32 extended-syntax profile.

Current-source FBLite/AArch64 extended-syntax checkpoint, 2026-09-30: all
2,430 selected files passed preprocessing parity and produced direct plus
prepared worker models under `-lang fblite -arch aarch64 -exx`, with no
bounded, incomplete, or failed analyses. Of 314,643 complete-file syntax
ranges, 301,513 had ordinary type records and the remaining 13,130 were
recovery-marked. There were no missing syntax ranges, unmarked recovery types,
or type mismatches. The sidecar exposed 40,244 facts (27,200 physical trace
comparisons and 13,044 directive expressions); all 409 missing trace answers
were supplemented, with zero ambiguous, missing, mistyped, or
status-mismatched answers. Together with the x86-32 and x86-64 extended-syntax
results above and the three default-option checkpoints, this closes the
current-source selected FBLite matrix for the three principal targets, both
with and without `-exx`.

Lexer coordinate and responsiveness checkpoint, 2026-09-30: retained the
UTF-16 code-unit scanner representation so columns after supplementary Unicode
characters continue to match VS Code positions. Added regressions for those
columns and for `REM` identifier boundaries. The `REM` probe now inspects only
the bounded candidate token instead of allocating a suffix for every scanned
character; lines without string literals also reuse one character buffer for
visible and masked text. The compiler-backed unit suite passes 384 tests with
one skipped check. Prepared analysis benchmarks on the current tree
remain around 2.2/1.3 seconds for cold/warm `ast-node-call.bas`, 3.4/2.1
seconds for `parser-proc.bas`, and 1.1/0.9 seconds for the 54 KB broken-buffer
overlay; observed extension-host pauses stayed at or below 22 ms. These runs
show no material end-to-end latency change from the lexer micro-optimization;
compiler execution, trace decoding, and worker model construction remain the
larger first-analysis costs. The freshly rebuilt Linux VSIX installs
successfully and passes all 37 packaged-editor checks on both VS Code 1.85.0
(the declared minimum) and 1.140.0 (current in this environment), including
native Outline, workspace symbols, expression selection, unsaved roots and
headers, recovery, and project rename. Refreshed compiler expression-route
and selected-call-route audits also report no unowned routes, duplicate
ownership, stale hooks, or definition drift.

Multi-argument pasted-symbol rename checkpoint, 2026-09-30: validated project
rename now derives edits across several physical macro arguments when the
compiler-projected output has one unique minimum-edit decomposition. Repeated
uses of one physical argument remain one consistent source edit; fixed
replacement-list components can anchor a multi-argument change. Multiple
distinct minimum-edit plans, transformed text, incomplete origins, oversized
names, and search-limit exhaustion remain fail-closed. The native fixture renames
`myNodeValue` to `otherNodeItem`, edits both invocation arguments around the
fixed `Node` component, and validates both configured builds without writing
the saved buffer. The full compiler-backed unit suite passes 385 tests with
one skip; all 37 packaged-editor checks pass on VS Code 1.85.0 and 1.140.0.

Current-schema deprecated/x86-64 corpus checkpoint, 2026-09-30: the selected
2,430-file corpus passed preprocessing parity and produced both direct and
prepared worker models for every file, with no bounded, incomplete, or failed
analyses. The run covered 812 complete and 1,618 recovery snapshots. Across
those snapshots the audit saw 833,878 syntax ranges, of which 817,333 had
ordinary type records. All 16,545 ranges without ordinary type records were
explicitly invalid; complete files had no uncovered syntax ranges. There were
no provisional-but-valid untyped ranges, unmarked recovery ranges, or type
mismatches. The semantic sidecar exported
57,870 facts, including 40,464 trace comparisons and 17,406 directive
expressions. All 442 missing trace answers were safely supplemented. Complete
facts had zero ambiguous, unresolved, mistyped, or status-mismatched answers.
Among 32,546 recovery facts, 29,923 were safe; 29,725 resolved without
ambiguity, while eight conflicting ranges were correctly withheld. Recovery
had no missing or mistyped answers, unprovisional facts, or unsafe retained
ranges. This updates the selected deprecated-mode x86-64 profile; it does not
close recovery behavior across all dialects.

The corpus audit now reports invalid and provisional untyped ranges separately
so parser recovery cannot make intentional rejection look like a missing type
implementation. The expression-focused subset confirmed the distinction, and
the full compiler-backed unit suite passes 386 tests with no skips.

Stable operator ABI checkpoint, 2026-09-30: semantic sidecar schemas 8 and
later expose conceptual `operatorCode` and `operatorKind` values on node and
expression facts. Numeric AST classes and opcodes remain diagnostic fields,
not an extension rule input. The stable built-in concept fixture passed across
FreeBASIC, FBLite, QB, and deprecated modes on host, x86-32, and AArch64. The
reader validates the concept vocabulary and rejects unmapped codes instead of
depending on compiler-private opcode numbers.

Lowered operator coverage follow-up, 2026-10-01: expanded the sidecar fixture
from nine examples to cover arithmetic, bitwise and short-circuit logic,
comparisons, conversions, indexing, address-of, dereference, and shifts across
their supported dialect/target matrices. This exposed two omissions: logical
`AndAlso`/`OrElse` lost their source concept when the compiler lowered them to
`IIF`, and explicit pointer-dereference AST nodes were not classified. The
parser now retains the last successfully constructed short-circuit operation
on both completed prefix and outer expression ranges; the semantic exporter
maps the dedicated dereference node to the already-versioned `dereference`
concept. Mixed `AndAlso`/`OrElse` ranges verify distinct inner and outer
concepts. The rebuilt bridge passes all 75 semantic-sidecar tests and the
full native-backed unit suite passes 387 tests with no skips.

Cloned temporary cleanup follow-up, 2026-10-01: a native regression found that
temporary destructor entries created inside a field initializer lost their
physical expression when FreeBASIC cloned that TYPEINI into a generated
constructor. Each compiler temporary now retains its validated destructor
provenance on the symbol itself; TYPEINI scope cloning copies it into the new
symbol and dtor-list entry. Late TYPEINI lowering carries the same metadata.
The field-initializer regression now resolves to the exact `makeTemporary()`
range and survives project relationship construction. The rebuilt bridge
passes the full native-backed suite: 386 passed, one platform-conditional
check skipped (387 total). This closes that clone route only; other lowered
cleanup relationships and backend/target coverage remain open.

Current-source post-cleanup default-FB corpus replay, 2026-10-01: the rebuilt
bridge audited all 2,430 selected files with semantic-sidecar comparisons.
The 10-second prepared-request bound completed 2,427 files; its three timeouts
were the known large `compound/select_const2.bas`, `expressions/iif.bas`, and
`structs/temp-var-dtors.bas` cases. The other 2,427 files produced prepared
models. Across complete snapshots, 878,176 of 881,777 syntax ranges had
ordinary types; all 3,601 remaining ranges were explicitly invalid recovery,
with no missing syntax ranges, provisional untyped ranges, or type mismatches.
The sidecar exposed 89,514 facts (60,842 physical trace comparisons and
28,672 directive expressions). Of 546 trace omissions, 512 were supplemented
and 34 repeated-include ranges remained ambiguous; there were no missing,
mistyped, or status-mismatched editor answers. Replaying each timeout with a
60-second bound produced complete direct and prepared-worker models; worker
semantic-token results matched the direct models. Trace-disabled preprocessing
from stock FBC and the rebuilt bridge matched byte-for-byte for all three.
Their direct expression/sidecar replays had no type or resolution mismatches.
This closes the selected default-FB corpus cumulatively across the bounded run
and stress-file replays, not as one uninterrupted 10-second-bound audit or as
coverage of every target, dialect, or backend.

Copied macro-argument constructor checkpoint, 2026-10-01: argument-selected
constructor facts can now map a compiler-expanded expression back to its
physical source argument when emitted-token tracing and the provenance map
prove one exact, ordered source span. The bounded trace index retains physical
token positions without allocating a map node for every direct token. Mapping
fails closed for replacement-list text, token-pasted gaps, stringification,
callback/unknown origins, and incomplete or ambiguous ranges. A forwarded
argument regression anchors the relationship to the invocation's actual
argument; object-like replacement and token-paste negative controls remain
excluded. The rebuilt bridge passes all 75 semantic-sidecar tests and all 64
project tests (63 passed, one platform-conditional skip). This covers the
validated copied-argument route, not macro-origin projection in general.

Upstream temporary-destructor corpus follow-up, 2026-10-01: the current bridge
analyzes `tests/structs/temp-var-dtors.bas` to EOF and exports 204 temporary
destructor relationships over 193 unique physical expression ranges. Every
fact has a nonempty in-bounds source span, exact UDT ownership, and a selected
destructor signature; project semantic joining retained all 204 without
turning them into token edits. This upstream-source regression passes within
the full 76-test semantic-sidecar suite. It expands evidence for one large
cleanup stress program, not coverage of every compiler-generated lifetime.

Packaged VS Code integration follow-up, 2026-10-01: the Linux VSIX rebuilt
from the current worktree installs and passes all 36 packaged-editor checks
on both the declared minimum VS Code 1.85.0 and VS Code 1.140.0. The run
includes native Outline, closed-module workspace symbols, macro-origin
navigation and rename, unsaved roots and headers, parser recovery, and
multi-configuration project rename. These are packaged integration checks,
not proof of every VS Code API interaction or complete FreeBASIC coverage.

Rename-stable selected-call signature checkpoint, 2026-10-01: the authorized
FBC sidecar schema 18 now encodes implicit-call parameter modes, optionality,
array dimensions, full datatype flags, and exact named-subtype model identities
instead of formatted type spellings. The reader validates signature shape and
requires each referenced subtype record. This prevents a legal rename of a
constructor parameter type from looking like an overload-selection change.
A project regression forwards the converted argument through a macro, renames
its source UDT under both FB/x86-64 and FB/x86-32 contexts, rejects an
intentionally altered selected signature, and then accepts the unchanged
compiler selection with exactly the expected preview edits and no disk writes.
The full unit suite passes 389 tests with one platform-conditional skip; the
sidecar suite passes 77/77, the project suite 64/65, and the rebuilt Linux
VSIX passes all 36 integration checks on VS Code 1.85.0 and 1.140.0. The
embedded symbol IDs are scoped to the semantic-model snapshot; this signature
is a project-validation fingerprint, not a persistent cross-build identity.

FBLite/x86-32 expression-corpus checkpoint, 2026-10-01: the native audit
covered the upstream `expressions`, `compound`, `overload`, `pointers`, and
`structs` categories (546 source files) with preprocessing-parity checks,
direct editor models, prepared worker models, expression coverage, and semantic
sidecar comparisons. At the default 10-second per-file bound, 545 files
completed and `compound/select_const2.bas` exceeded the bound. No completed
model had a missing or mistyped expression answer. Replaying the entire
compound category with a 60-second bound completed all 51/51 files, including
the stress file, with 392 semantic expressions compared and no missing or
mistyped editor answers. The combined profile therefore covers all 546 files
for this dialect/target pair. This closes one useful FBLite/x86-32 slice, not
the remaining FBLite, QB, target, or backend matrix.

QB native-corpus target checkpoint, 2026-10-01: the compiler's dedicated
`tests/qb` category passed in QB mode on x86-32, x86-64, and AArch64. Each
profile analyzed all 87 files and matched stock preprocessing output for all
87; 62 files completed and 25 were parser-recovery cases. Complete expression
syntax had no missing ranges or type mismatches, and the untyped complete-file
ranges were all explicitly invalid. Across the three profiles, all 773, 790,
and 790 exported semantic-expression facts were available to the editor model
without missing or mistyped answers; all 129 safe recovery facts per profile
were retained provisionally and without ambiguity. Prepared worker models and
semantic-token queries also matched the direct models for every file. This
validates the dedicated QB corpus on three ABI profiles; it does not establish
full-corpus QB behavior or other backends.

FBLite expression-target matrix checkpoint, 2026-10-01: the repeatable
`fblite-expressions` profile now runs the five expression-heavy upstream
categories on x86-32, x86-64, and AArch64 with a 60-second per-file bound for
the known select-constant stress case. All 1,638 target/file analyses passed
compiler preprocessing parity and produced direct plus prepared-worker models;
there were no bounded or incomplete analyses. Each target had 100 complete and
446 recovery modules, no missing syntax ranges or type mismatches, and every
untyped range in complete modules was explicitly invalid. The sidecar exported
6,023, 6,052, and 5,942 expression facts respectively, with zero missing,
mistyped, ambiguous, or status-mismatched editor answers. Across each target,
all 13,434 safe recovery facts remained available provisionally with no
missing, mistyped, unprovisional, or unsafe retained answers. This broadens the
FBLite evidence across three targets; other language modes and backends remain
open.

Repeatable native-target matrix checkpoint, 2026-10-01: strict QB and
expression-heavy FB, FBLite, and deprecated-mode profiles are available through
`npm run test:corpus:matrix -- --profile=qb`, `--profile=fb-expressions`,
`--profile=fb-full`, `--profile=fblite-expressions`, `--profile=fblite-full`,
`--profile=deprecated-expressions`, and `--profile=deprecated-full`. Their
target lists and categories are declared in `tools/audit-native-matrix.js`; the
runner requires stock-compiler parity, complete direct and prepared-worker
inventories, no bounded or incomplete analyses, no unexplained syntax ranges,
and no missing, mistyped, or unsafe-recovery sidecar answers on every target.
The strict QB runner passed all 261 target/file analyses; each three-target
expression matrix passed all 1,638, and each all-category FB, FBLite, and
deprecated matrix passed all 7,293 target/file analyses. These profiles make
the recorded evidence repeatable and fail-closed, but do not establish every
backend or compiler option combination.

Stable source-operation checkpoint, 2026-10-01: the schema-18 sidecar now
exposes conceptual codes for member access, explicit scalar conversions, and
FreeBASIC math intrinsics. Parser-owned expression facts preserve `INT`, `FIX`,
and `FRAC` when the compiler lowers integer forms to ordinary `ADD`/`AND` nodes,
and preserve helper-lowered `SGN`, `FIX`, `FRAC`, and `ATAN2` calls. Conversion
nodes no longer read conversion flags through the unrelated AST operator union;
node classes without operator payloads emit `-1`. The integration matrix checks
these facts under FB, FBLite, and deprecated modes on x86-32, x86-64, and
AArch64, including sidecar-only type answers. The strict corpus profiles also
pass after this change: all 261 QB target/file audits and all 1,638 FBLite
expression target/file audits retain preprocessing parity, direct/prepared
model parity, and zero missing, mistyped, or unsafe recovery sidecar answers.
An unsaved-root overlay regression verifies exact operation ranges and complete
sidecar-only types. The full unit suite passes 393 tests with one
platform-conditional skip. This improves operation identity and avoids one
compiler-internal layout dependency; remaining operator routes and
all-language/backend semantic coverage are still open.

Deprecated-mode source corpus checkpoint, 2026-10-01: a full x86-64 replay
audited all 2,431 selected upstream files with preprocessing parity, direct
models, and prepared-worker models for every file. It reported no bounded or
incomplete analyses and no audit failures. The repeatable
`deprecated-expressions` profile now covers the five expression-heavy
categories on x86-32, x86-64, and AArch64. All 546 files per target passed
preprocessing parity and produced both model forms; each target had 126
complete and 420 recovery files, with no bounded/incomplete results. Complete
expression snapshots had no missing syntax ranges or type mismatches, and all
untyped ranges were explicitly classified as invalid. The sidecar comparisons
reported no missing, mistyped, ambiguous, or status-mismatched editor answers;
all 13,814 safe recovery facts per target remained available provisionally.
This adds a broad deprecated-mode corpus replay and a three-target high-risk
slice; it does not yet establish every deprecated source category or backend.

Default-FB expression-target matrix checkpoint, 2026-10-01: the new
`fb-expressions` profile passed the upstream `expressions`, `compound`,
`overload`, `pointers`, and `structs` categories across x86-32, x86-64, and
AArch64. All 1,638 target/file analyses matched stock compiler preprocessing
and produced direct plus prepared-worker models, with no bounded or incomplete
results. Each target had 281 complete and 265 recovery files. Complete
expression snapshots had no missing syntax ranges or type mismatches; the 476
untyped ranges on each target were all explicitly invalid. The semantic
sidecar exported 25,103, 25,132, and 24,740 expression facts respectively,
with no missing, mistyped, ambiguous, or status-mismatched editor answers. All
230 safe recovery facts per target remained available provisionally. This
closes the selected expression-heavy default-FB slice across three targets,
not the complete corpus or all backend combinations. The compiler
expression-parser and selected-call route auditors also pass with no unowned,
stale, or drifted routes.

Full default-FB native-target corpus checkpoint, 2026-10-01: the strict
`fb-full` profile covered all configured upstream source categories and all
2,431 files on x86-32, x86-64, and AArch64. All 7,293 target/file analyses
matched stock-compiler preprocessing and produced direct plus prepared-worker
models; none were bounded or incomplete, and the matrix reported `passed: true`
with no failures. Complete expression snapshots had no missing syntax ranges
or type mismatches, and all untyped complete-snapshot ranges were explicitly
invalid. Semantic-sidecar checks reported no missing, mistyped, or
status-mismatched answers. Thirty-four repeated-include ranges per target
remained conservatively ambiguous rather than receiving a guessed type; safe
recovery facts remained provisional without missing, mistyped, or unsafe
answers. This closes the configured default-FB corpus across these target
ABIs, not every backend or compiler option combination.

Full FBLite native-target corpus checkpoint, 2026-10-01: the strict
`fblite-full` profile covered all configured upstream source categories and
all 2,431 files on x86-32, x86-64, and AArch64. All 7,293 target/file analyses
matched stock-compiler preprocessing and produced direct plus prepared-worker
models; none were bounded or incomplete, and the matrix reported `passed: true`
with no failures. Each target's complete expression snapshot had no missing
syntax ranges or type mismatches, and every range without an ordinary type was
explicitly invalid. Semantic-sidecar checks reported no missing, mistyped,
ambiguous, or status-mismatched editor answers; safe recovery facts remained
available provisionally with no unsafe retention. This closes the configured
FBLite source corpus across these three target ABIs, not every backend or
compiler option combination.

Full deprecated-mode native-target corpus checkpoint, 2026-10-01: the strict
`deprecated-full` profile covered all configured upstream source categories
and all 2,431 files on x86-32, x86-64, and AArch64. All 7,293 target/file
analyses matched stock-compiler preprocessing and produced direct plus
prepared-worker models; none were bounded or incomplete, and the matrix
reported `passed: true` with no failures. Complete expression snapshots had no
missing syntax ranges or type mismatches, and all untyped complete-snapshot
ranges were explicitly invalid. Semantic-sidecar checks had no missing or
mistyped answers; eight ambiguous recovery facts per target were conservatively
withheld instead of being guessed. No unsafe recovery answer was retained.
This closes the configured deprecated-mode corpus on these three
target ABIs, not every backend or compiler option combination.

Unsaved-edit responsiveness retest, 2026-10-01: the full local suite passed
396 unit tests with one platform-conditional skip. In the sustained broken-
buffer edit test, the newest model published 75 ms after the final edit, but
one obsolete-process cleanup interval reached 1,012 ms during the suite run.
Running that same test alone immediately afterward reclaimed all five stale
runs with a maximum 21 ms cleanup and published the newest model in 80 ms. This
does not reproduce a persistent delay, but the spread shows that cancellation
latency under aggregate host load still needs controlled repeated measurement;
the isolated result is not a worst-case guarantee.

Implicit-call route audit checkpoint, 2026-10-01: the compiler route audit now
covers semantic-model export hooks in addition to AST call builders. It checks
the exact owning parser or cleanup routine, call counts, emitted kind literals,
and the semantic model's supported-kind set. The bridge's argument-constructor
injection is checked separately because its physical-expression range is
retained only in instrumented AST nodes. All nine supported kinds currently
have an owned emission route, with no missing, stale, unowned, or drifted hooks.
The route audit and bridge-hook test pass. This proves that existing export
paths stay inventoried; it does not prove that every compiler-selected call
class has an export hook or that all project refactoring relationships are
complete.

Resolved-binding and implicit-call corpus checkpoint, 2026-10-01: the new
`test:corpus:implicit-calls` audit passed all 1,702 upstream files in its
fourteen selected categories on x86-64. Every file matched preprocessing
parity and produced direct and prepared models; 690 were complete and 1,012
remained partial/recovery snapshots, with no bounded or incomplete analyses
and no audit failures. Full sidecars contained 62,086 binding records and
1,637 implicit-call records across all nine supported kinds. All records were
physically projectable, had an available source and an in-bounds range, and
all calls had valid selected-target signatures; there were no count, range, or
signature issues. The signature reader preserves FreeBASIC's `BYDESC`
dimension value `-1` as its any-rank sentinel and rejects it for other
parameter modes.

The expanded `scopes` category exposed a sidecar-only crash in three upstream
`EXIT SUB` fixtures. FreeBASIC's `AND` evaluates both operands, so a null
subtype guard followed by `symbIsStruct()` dereferenced null. The compiler
hook now uses `ANDALSO`, and pooled symbols initialize cleanup provenance at
allocation. All three language-mode fixtures reach the terminal analysis
record after the fix. This is broad evidence for the selected categories, not
all compiler configurations or every possible generated relationship. The
default package suite passes 405 unit tests with 218 platform/compiler skips,
plus six smoke and two grammar tests. The compiler-backed sidecar suite passes
82/82, and the project-refactoring suite passes 64/65 with one
platform-conditional skip.

Schema-22 bridge checkpoint, 2026-10-02: the extension sidecar readers now
accept schema 22 and validate compiler-owned macro definitions,
replacement tokens, invocations, argument units, callback outputs, lifecycle
events, and expansion-origin links. Byte payloads preserve non-UTF-8 compiler
bytes; wide payloads retain exact code units. High-expansion expression
fallbacks and project-binding requests use FBC's new `-semantic-model-compact`
flag, which omits only the verbose per-expansion graph. On
`tests/compound/select_const2.bas`, this reduced a bindings sidecar from
93,739,395 bytes to 3,491,237 bytes, keeping the editor's 64 MiB cap without
dropping binding or implicit-call facts. The independent compiler-sidecar tests
for macro provenance and compact mode pass.

The compiler-corpus audit exposed zero-width macro-result locations marked as
physical spans when a replacement emitted only a newline. FBC now marks those
points nonphysical instead of advertising an empty editable range. The
repackaged VSIX passes 39 installed-extension checks in VS Code 1.140.0 against
the rebuilt bridge. The current bridge path is `dist/fbc-editor-current` and is
updated only after a successful build.

Current-source verification: the compiler-backed sidecar and macro suites pass
102/102; the high-risk expression-sidecar audit passes all 417 files across
`compound`, `expressions`, `structs`, and `wstring`. There were 417 preprocessing
parity matches, zero bounded or incomplete models, zero audit failures, zero
semantic-sidecar missing/type mismatches, and 87 trace-missing expression
ranges supplemented by compiler facts. Complete snapshots had zero type
mismatches; all 339 untyped complete-snapshot ranges were explicitly invalid.
The compact binding audit passes all 1,705 files in fourteen selected
categories: 83,020 physical bindings and 1,768 physical implicit calls across
all nine supported kinds, with no missing sources, out-of-bounds ranges,
invalid signatures, or audit issues. Expression-route and selected-call-route
audits also report no unowned or drifted routes.

With the schema-22 bridge configured, `npm run test:unit` passed all 411 tests
with no skips. The sustained broken-buffer test reclaimed five obsolete runs;
the largest observed discard was 6 ms, native cleanup 37 ms, and publication of
the latest model 203 ms, with sampled peak RSS of 111.3 MiB. This is one
aggregate run, not a worst-case responsiveness guarantee. The package was
rebuilt after the compiler and decoder fixes, then the installed VSIX passed
the same 39 checks against the bridge.

Schema-23/current-FBC checkpoint, 2026-10-02: the sidecar now adds `LOC`
records for captured-source byte offsets and UTF-16 ranges, and `MAP` remaps
have stable identities. The extension validates schema, record shape, source
context, subject links, range ordering, byte bounds, and mapped/unverified
status. Macro-result zero-width locations and reversed macro-argument extents
are normalized by FBC to nonphysical points, preserving a known anchor without
advertising an editable span. A preprocessor-corpus defect in
`macro_no_parentheses.bas` is covered by an independent compiler-sidecar
regression test. FBC's independent physical-location suite passes 4/4 tests for
UTF-8/16/32 BOMs, line endings, repeated includes, remaps, forged offsets, and
generated or malformed locations.

The extension additionally revalidates mapped `LOC` byte offsets against the
exact compiler input bytes: it reconstructs the effective overlay bytes,
verifies `FILE` length and SHA-256, and checks each mapped UTF-16 position in a
single ordered scan per source file. This fails closed for changed source,
interior encoded-byte offsets, malformed encodings, and coordinates that do
not match the sidecar's byte map. The 412-test unit suite passes with this
verification enabled; the 417 expression files, 132 preprocessor files, and
1,705 binding files also passed their byte-verified corpus audits.

The Linux bridge's stable symlink is resolved to its build-specific executable
path in translation-unit context signatures, workspace-symbol jobs, and project
rename requests. Rebuilding the bridge therefore produces a new compiler cache
identity and stale snapshots are not reused in an already running VS Code
session.

Against the schema-23 bridge, the sidecar/macro suite passes 103/103, the full
unit suite passes 412/412 with no skips, and the repackaged VSIX passes 39/39
installed-editor checks in VS Code 1.140.0. The focused preprocessor audit
passes 132/132 files and the four-category high-risk expression audit passes
417/417 files; both have zero semantic-sidecar misses or type mismatches. The
resolved-binding/implicit-call audit passes 1,705/1,705 files, validating
83,020 bindings and 1,768 calls across all nine kinds with no missing sources,
bad ranges, or signatures.

The schema-23 full default-FB replay at the 10-second per-file limit had three
compiler-analysis timeouts in
`compound/select_const2.bas`, `expressions/iif.bas`, and
`structs/temp-var-dtors.bas`; its type comparisons still had no mismatches.
With a 60-second per-file limit and byte verification enabled, the full replay
now passes all 2,453 files: 2,453 preprocessing parity matches, 1,131 complete
and 1,322 recovery models, and no bounded/incomplete analyses or audit failures.
The sidecar compared 65,237 expressions from 94,414 facts: zero missing or
mistyped answers, with 873 trace-missing facts supplemented and 34 conservative
ambiguities. Complete expression snapshots had zero type mismatches; all 3,612
untyped complete-snapshot ranges were classified invalid. Other language modes,
target architectures/backends on the current schema, and remaining refactoring
relationships are still open.

These are strong selected-slice results, not complete compiler-grade coverage.
The extension still leaves `analysis.compilerPath` empty and
`analysis.run` off by default, so ordinary providers use the lightweight source
model until the user configures `dist/fbc-editor-current` (or another bridge)
and obtains a current compiler snapshot. Compiler and heuristic fallback
behavior both remain part of the product; responsiveness, broader target and
backend combinations, and remaining refactoring relationships are open.

Schema-25 latest-source checkpoint, 2026-10-02: rebuilt the stable Linux bridge
from the current `/home/jkfirth/fbc` worktree. The executable reports FreeBASIC
1.20.4 and its semantic sidecar reports schema 25. The extension validates the
new statement/construct graph, ownership, capability, binding-access, and
statement-operation records. FBC now omits reversed physical locations produced
by empty colon-separated statements instead of invalidating the entire source
model; a compiler-sidecar regression and two formerly failing upstream categories
verify this behavior.

Against that producer, the high-risk expression sidecar audit passed 417/417
files (`compound`, `expressions`, `structs`, and `wstring`), comparing 22,855
compiler expression facts with zero missing or mistyped answers and no bounded or
incomplete analyses. The full selected x86-64 binding/call audit passed 1,705/1,705
files with exact preprocessing parity, 1,768 selected implicit calls across all
nine supported kinds, no incomplete/bounded models, and no missing sources,
invalid physical ranges, signatures, or audit failures. The unit suite passes
417/417 with no skips, and the Linux VSIX passes 39 installed-editor checks in
VS Code 1.140.0.

The macro-heavy `iif.bas` prepared model takes about 31 seconds on this host, so
native analysis now has its own configurable `freebasic.analysis.timeoutMs`
setting, defaulting to 60 seconds; ordinary diagnostic checks retain their
30-second default. The two-module macro-heavy worker test now passes within that
bound. This is a measured threshold adjustment, not a responsiveness guarantee
for slower systems. The earlier 2,453-file full replay is still only verified
against schema 23; it has not been repeated against schema 25. Other language
modes, architectures/backends, and the remaining refactoring relationships also
remain open. Native compiler analysis is still opt-in, so the ordinary default
providers continue to use the lightweight source model without a configured
bridge and current compiler snapshot.

Schema-27 latest-source checkpoint, 2026-10-07: rebuilt the Linux compiler
bridge from FreeBASIC commit `c7d57f4cb` (version 1.20.4). The extension now
validates schema-27 normalized types, procedure phases/evaluation and control
flow, structured diagnostics, and source operator/operand links. Current parser
routes through `astNewBOPWithOperands` and `hSourceBinaryOperation` are traced,
including completed operator prefixes. FBC now keeps converted pointer/array
index types separate from the physical written operand and retains complete
pointer-intrinsic ranges; regression tests cover array lvalues, pointer indexing,
and `VarPtr`/`SAdd`/`StrPtr` closing-parenthesis boundaries.

Validation against that source: the extension unit suite passes 418 tests with
one skipped case; the FBC semantic-sidecar suite passes 145 tests with
one LLVM-only skip; the packaged Linux VSIX passes 37 checks in VS Code 1.141.0.
The selected x86-64 binding/call audit passes 1,705/1,705 files with exact
preprocessing parity, 1,768 selected implicit calls across all nine supported
kinds, no bounded or incomplete analyses, and no missing sources, invalid
physical ranges, signatures, or audit issues. The expression-sidecar agreement
fixtures and upstream expression corpus also pass. Other dialects, target
architectures/backends, and remaining refactoring relationships remain open;
native compiler analysis is still opt-in.

Current-schema cross-target expression checkpoint, 2026-10-07: the
`fblite-expressions` matrix passed all 548 source files on each of x86-32,
x86-64, and AArch64 (1,644 target/file analyses). Every case matched stock
preprocessing and produced direct and prepared models; none were bounded or
incomplete. Complete snapshots had zero type mismatches, and all untyped
complete-snapshot ranges were recovery-invalid. The sidecar had zero missing,
mistyped, ambiguous, or status-mismatched answers; it supplemented the same 21
trace omissions on each target and preserved all 13,246 safe recovery facts
provisionally. This is a current schema-27 FBLite expression slice, not the
remaining QB, deprecated-mode, backend, or full option matrix.

Current-schema QB target checkpoint, 2026-10-07: the dedicated upstream QB
profile passed all 87 files on each of x86-32, x86-64, and AArch64 (261
target/file analyses). Each matched stock preprocessing, produced direct and
prepared models, and had zero bounded/incomplete analyses or type mismatches.
The sidecar supplemented 13 trace omissions per target without ambiguity or
status errors, and all 137 safe recovery facts per target remained provisional.
This verifies the dedicated QB corpus with schema 27, not every QB source
option or backend.

Current-schema default-FB expression checkpoint, 2026-10-07: the
`fb-expressions` profile passed all 548 source files on each of x86-32, x86-64,
and AArch64 (1,644 target/file analyses). Each target matched preprocessing and
produced direct and prepared models without bounded or incomplete analyses.
There were no type mismatches; all untyped complete-snapshot ranges were
recovery-invalid. Sidecars supplemented 93 trace omissions per target with no
missing, mistyped, ambiguous, or status-mismatched answers, and all 229 safe
recovery facts per target remained provisional. This checks the current
schema-27 expression-heavy default-FB slice. The full source-category matrix
was subsequently repeated against `ba996343a`; its results are recorded in the
latest FBC checkpoint below.

Current-schema deprecated-mode expression checkpoint, 2026-10-07: the
`deprecated-expressions` matrix passed all 548 files on x86-32, x86-64, and
AArch64 (1,644 target/file analyses). Every target matched preprocessing and
produced direct/prepared models with no bounded or incomplete analyses and no
type mismatches. Semantic sidecars supplemented 21 trace omissions per target
with zero missing, mistyped, ambiguous, or status-mismatched answers; all 13,675
safe recovery facts per target remained provisional. Together with the current
FBLite expression and QB checks, this extends schema-27 expression evidence
across all three dialects on these ABIs. Full option combinations and backend
coverage remain open.

Latest FBC semantic-model checkpoint, 2026-10-07: rebuilt the Linux bridge from
FreeBASIC commit `ba996343a` (1.20.4). The wire schema remains 27; the producer
adds compiler-selected declaration and procedure type forms, written procedure
visibility, aggregate access sections, selected SELECT CASE lowering receipts,
and GCC/GAS/GAS64 target-wide literal prefixes. The bridge builder was adjusted
for the new `cVarDecl` initializer result parameter and now builds against this
source tree.

Compiler-backed binding analysis now requests the compact full model so those
facts are available to editor queries. The sidecar reader exposes capability
and `K` property records, and native symbol facts are joined only through exact
physical declaration bindings; generated, ambiguous, and nonphysical sites are
not guessed. Completion details use compiler-selected type spellings. A
logical `#line` path on an operation is checked against the physical source
file reached through its compiler source context. If a full-model export hits
FBC's bounded work or size limit, analysis retries with the bindings-only
model while preserving the native trace when possible, and records that
fallback. A trace-free binding pass remains the final output-size fallback.

Verification against this producer: the complete FBC semantic-sidecar suite
passes 154 tests. Seven focused tests for declaration typing, procedure headers,
aggregate access, SELECT CASE lowering, and target-wide literal prefixes pass
on GCC, GAS, and GAS64. The compiler-backed extension unit suite passes, the
Linux VSIX passes 37 checks in VS Code 1.141.0, and the source-generated offline
reference contains 604 names.

Update, 2026-10-07: the `fb-full` matrix has now passed against `ba996343a` on
x86-32, x86-64, and AArch64: 2,454 files per target, exact compiler parity,
and successful direct/prepared models. Each target had 1,132 complete and
1,322 recovery snapshots, with no bounded/incomplete analyses or audit
failures. Complete snapshots had zero type mismatches; every untyped range was
classified recovery-invalid. Across the targets, the expression sidecar
compared 197,027 facts, supplemented 3,014 trace omissions, and reported no
missing, mistyped, or status-mismatched results. The 102 ambiguous ranges
(34 per target) were withheld conservatively; all 6,336 safe recovery facts
remained provisional.

The FBC tree has one local test update in
`tests/semantic-sidecar/test_sidecar.py`: its procedure-visibility ownership
test now checks the current symbol-owned property key and rejects cross-module
statement associations. The linter still reports warnings on these changed
compiler files when run without semantic analysis: 3,628 warnings and no
errors across 19 files, dominated by unresolved-name and line-layout rules.
That run does not establish compiler-backed lint results because the installed
linter predates the current sidecar contract.

FBC sidecar follow-up, 2026-10-07: rebuilt the bridge from commit `c70cda089`
without a schema bump. The new `scalar-string-declarations` capability records
compiler-selected scalar dynamic String declaration kind, initializer identity,
statement, and source context. FBC also indexes source-line starts up to its
documented cache bound to avoid rescanning the same include for later semantic
ranges. The extension now preserves legacy non-UTF-8 sidecar bytes with
surrogate escapes, accepts FBC's iterator and length operator concepts, and
validates the full four-bit normalized pointer-depth range. Compiler facts for
scalar String declarations are joined to native symbols through exact physical
declaration sites and exposed to editor queries.

Against `c70cda089`, the FBC semantic-sidecar suite passes 155 tests, including
the new scalar String fixture on GCC, GAS, and GAS64. The selected x86-64
binding/call audit passes all 1,705 files with exact preprocessing parity; it
builds 1,696 models (nine remain the known incomplete-trace cases), validates
81,384 bindings and 1,762 implicit calls, and reports no missing sources, bad
ranges/signatures, or audit issues. The extension's compiler-backed unit suite
also passes. The complete 2,454-file three-ABI expression/type matrix above is
still attributed to `ba996343a`; these latest coordinate and String-sidecar
changes have focused and binding/call validation but have not yet been through
another full three-ABI matrix.

Revalidation after the latest sidecar sync, 2026-10-07: rebuilt the bridge from
the current `c70cda089` source tree. The complete FBC sidecar suite passes
155/155, and the compiler-sidecar extension tests pass 97/97. Three focused
checks against the final rebuilt bridge also pass for scalar String facts,
Unicode/long-line coordinates, and BOM/line-ending mappings. On the two
changed semantic source files, the local style-profile lint count fell from
780 to 775 warnings with no errors after expanding five inline branches. This
lint run disables semantic analysis; unresolved compiler-private names and
target-width checks remain, and the installed linter does not yet consume the
current schema-27 model.

Full matrix update, 2026-10-07: the `fb-full` profile now passes against
`c70cda089` on x86-32, x86-64, and AArch64. Each ABI covered all 2,454 files
with exact compiler parity and 2,454 direct plus 2,454 prepared models; there
were no bounded/incomplete analyses or audit failures. Each target had 1,132
complete and 1,322 recovery snapshots, with zero type mismatches; every
untyped complete-snapshot range was classified recovery-invalid. The semantic
sidecar compared 197,027 facts across the three targets and supplemented 3,014
trace omissions. It reported zero missing, mistyped, status-mismatched, or
unprovisional recovery facts. The 34 ambiguous ranges per target were withheld,
and all 6,336 safe recovery facts remained provisional.

FBLite full-matrix update, 2026-10-07: the `fblite-full` profile also passes
against `c70cda089` on x86-32, x86-64, and AArch64. Each ABI covered all 2,454
files with exact compiler parity and complete direct/prepared models; there
were no bounded/incomplete analyses or audit failures. Complete/recovery
snapshot counts were 688/1,766 on x86-32 and 690/1,764 on x86-64 and AArch64.
All untyped complete-snapshot ranges were recovery-invalid, with zero missing
syntax or type mismatches. The semantic sidecar compared 93,120 facts and
supplemented all 2,108 trace omissions without ambiguity, missing facts, type
mismatches, or status mismatches. All 120,391 safe recovery facts remained
provisional.

Deprecated-mode full-matrix update, 2026-10-07: `deprecated-full` passes
against `c70cda089` on x86-32, x86-64, and AArch64. Each ABI covered all 2,454
files with exact compiler parity and complete direct/prepared models; there
were no bounded/incomplete analyses or audit failures. Complete/recovery
snapshot counts were 827/1,627 on x86-32 and 829/1,625 on x86-64 and AArch64.
All untyped complete-snapshot ranges were recovery-invalid, with zero missing
syntax or type mismatches. The semantic sidecar compared 134,821 facts and
supplemented all 2,501 trace omissions without missing facts, type mismatches,
or status mismatches. Recovery retained no unprovisional facts; eight
ambiguous recovery comparisons per target were withheld conservatively.

Integration hardening update, 2026-10-07: with the rebuilt `c70cda089` bridge,
the full native-backed extension unit suite passes 424/424 tests with no skips.
The smoke suite passes 7/7, the TextMate grammar suite 2/2, and the
source-backed grammar audit confirms FreeBASIC 1.20.4 coverage. The newly built
Linux VSIX passes all 37 installed-editor checks on both VS Code 1.141.0
(current stable in this environment) and the declared minimum 1.85.0. These
checks include native Outline and workspace search, unsaved roots/headers,
recovery, semantic expression queries, and validated project rename.

FBLite binding/refactoring coverage update, 2026-10-07: the full
`--semantic-bindings --language-mode=fblite --architecture=x86-64` corpus now
passes all 2,454 files with exact preprocessing parity and 2,454 direct plus
2,454 prepared models. The compiler produced 90,392 declarations, 19,652
scopes, 65,864 source bindings, and 45 implicit calls across destructor and
default-constructor kinds. There were no bounded or incomplete analyses,
nonphysical or invalid ranges, missing sources, invalid signatures, or audit
failures. This followed a compiler-sidecar fix: `fbSemanticModelAddressIsTemporary()`
now returns conservatively when a recovered dereference has no value child,
instead of passing NULL to `astSkipNoConvCAST()` and crashing the compiler.

Deprecated-mode binding/refactoring coverage update, 2026-10-07: the full
`--semantic-bindings --language-mode=deprecated --architecture=x86-64` corpus
passes all 2,454 files with exact preprocessing parity and complete direct and
prepared models. It exports 113,026 declarations and 53,813 scopes, with no
bounded/incomplete analyses, missing sources, invalid or nonphysical ranges,
invalid signatures, or audit failures. The corpus exercises 61 implicit calls
across compiler-selected kinds. Together with the FBLite full binding audit
above, every selected upstream category now has full schema-27 binding checks
in both additional dialect modes.

Default-FB binding/refactoring coverage update, 2026-10-07: the full
`--semantic-bindings --language-mode=fb --architecture=x86-64` corpus passes
all 2,454 files with exact preprocessing parity and complete direct/prepared
models. It exports 125,696 declarations and 57,408 scopes; 1,869 compiler-
selected implicit calls were exercised across the corpus. The sidecar contains
146,002 source binding records and covers all nine selected-call kinds:
initializer/default/argument/return/new constructors, destructor calls,
scope-exit and temporary destructors, and DELETE destructors. There were no
bounded or incomplete analyses, missing sources, nonphysical or invalid
ranges, invalid signatures, or audit failures. Together with the FBLite and
deprecated-mode binding runs, this closes full-category binding coverage for
the three language modes on x86-64; broader binding ABI matrices remain open.

Default-FB x86-32 binding update, 2026-10-07: the same full semantic-binding
profile passed all 2,454 files on x86-32 with exact compiler parity and
2,454 direct/prepared models. It exported 126,363 declarations, 57,497 scopes,
146,285 source binding records, and 1,875 implicit calls across all nine kinds.
There were no bounded or incomplete analyses, missing sources, nonphysical or
invalid ranges, invalid signatures, or audit failures.

Default-FB AArch64 binding update, 2026-10-07: the full semantic-binding
profile also passed all 2,454 files on AArch64 with exact compiler parity and
2,454 direct/prepared models. It exported 124,559 declarations, 56,389 scopes,
145,432 source binding records, and 1,867 implicit calls across all nine kinds.
There were no bounded or incomplete analyses, missing sources, nonphysical or
invalid ranges, invalid signatures, or audit failures. Default-FB binding
coverage is now verified across all three principal ABIs; FBLite and
deprecated-mode ABI expansion remains open.

FBLite x86-32 binding update, 2026-10-08: the same full semantic-binding
profile passed all 2,454 files on x86-32 with exact parity and direct/prepared
models for every file. It exported 91,063 declarations, 19,756 scopes, 65,719
source binding records, and 45 implicit calls. There were no bounded or
incomplete analyses, missing sources, nonphysical or invalid ranges, invalid
signatures, or audit failures.

Normal-compiler rebuild, 2026-10-07: the FBC Makefile rebuilt the uninstrumented
1.20.4-3 compiler from the fixed source into an isolated output binary. The
plain compiler now passes the complete 155-test semantic-sidecar suite and
`make compiler-semantic-model-smoke`; the FBLite `boolean_field.bas` regression
produces a complete schema-27 model. After verifying the output hash and
compiler behavior, that binary became `/home/jkfirth/fbc/bin/fbc`; the prior
executable is retained as `bin/fbc.before-semantic-null-guard-20261007`.

FBLite AArch64 binding update, 2026-10-08: the full semantic-binding profile
passed all 2,454 files on AArch64 with exact parity and direct/prepared models
for every file. It exported 90,263 declarations, 19,603 scopes, 65,525 source
binding records, and 43 implicit calls. There were no bounded/incomplete
analyses, missing sources, nonphysical or invalid ranges, invalid signatures,
or audit failures. FBLite full-category binding coverage is now verified on
all three principal ABIs.

FBLite extended-syntax binding update, 2026-10-08: with `-exx` enabled, the
full corpus passes all 2,454 files on x86-32, x86-64, and AArch64 with exact
preprocessing parity and complete direct/prepared models. Binding records and
implicit-call totals match their corresponding default-option audits: 65,723
bindings/45 calls on x86-32, 65,864/45 on x86-64, and 65,525/43 on AArch64.
All three targets had zero bounded or incomplete analyses, invalid/nonphysical
ranges, missing sources, or invalid signatures. No target-specific `-exx`
binding discrepancy was found.

Default-FB extended-syntax binding update, 2026-10-08: the full x86-64
`--semantic-bindings --extended-syntax` audit passes all 2,454 files with
complete direct/prepared models, 146,002 binding records, and 1,869 implicit
calls across all nine kinds. Expression coverage has zero missing syntax or
type mismatches; all 3,608 untyped complete-snapshot ranges are invalid
recovery. There are no bounded/incomplete analyses, invalid or nonphysical
ranges, missing sources, invalid signatures, or audit failures.

Default-FB extended-syntax x86-32 binding update, 2026-10-08: the full
`-exx` x86-32 profile passes all 2,454 files with direct/prepared models,
146,289 source binding records, and 1,875 implicit calls across all nine kinds.
Expression coverage has zero missing syntax or type mismatches; all 3,604
untyped complete-snapshot ranges are recovery-invalid. There are no
bounded/incomplete analyses, invalid or nonphysical ranges, missing sources,
invalid signatures, or audit failures.

Default-FB extended-syntax AArch64 binding update, 2026-10-08: the full
`-exx` AArch64 profile passes all 2,454 files with direct/prepared models,
145,432 source binding records, and 1,867 implicit calls across all nine kinds.
Expression coverage has zero missing syntax or type mismatches; all 3,608
untyped complete-snapshot ranges are recovery-invalid. There are no
bounded/incomplete analyses, invalid or nonphysical ranges, missing sources,
invalid signatures, or audit failures. Default-FB `-exx` binding coverage now
passes on x86-32, x86-64, and AArch64.

Deprecated-mode extended-syntax binding update, 2026-10-08: the full x86-64
`--semantic-bindings --language-mode=deprecated --extended-syntax` audit passes
all 2,454 files with direct/prepared models, 89,397 source binding records, and
61 implicit calls. Expression coverage has zero missing syntax or type
mismatches, and there are no bounded/incomplete analyses, missing sources,
nonphysical or invalid ranges, invalid signatures, or audit failures.

Deprecated-mode extended-syntax x86-32 binding update, 2026-10-08: the full
`-exx` x86-32 profile passes all 2,454 files with direct/prepared models,
89,317 source binding records, and 61 implicit calls. Expression coverage has
zero missing syntax or type mismatches, and there are no bounded/incomplete
analyses, missing sources, nonphysical or invalid ranges, invalid signatures,
or audit failures.

Deprecated-mode extended-syntax AArch64 binding update, 2026-10-08: the full
`-exx` AArch64 profile passes all 2,454 files with direct/prepared models,
88,839 source binding records, and 59 implicit calls. Expression coverage has
zero missing syntax or type mismatches, and there are no bounded/incomplete
analyses, missing sources, nonphysical or invalid ranges, invalid signatures,
or audit failures.

Deprecated-mode x86-32 binding update, 2026-10-08: the full semantic-binding
profile passed all 2,454 files on x86-32 with exact parity and direct/prepared
models for every file. It exported 113,677 declarations, 53,907 scopes, 89,313
source binding records, and 61 implicit calls. There were no bounded or
incomplete analyses, missing sources, nonphysical or invalid ranges, invalid
signatures, or audit failures.

Deprecated-mode AArch64 binding update, 2026-10-08: the full semantic-binding
profile passed all 2,454 files with exact parity and direct/prepared models for
every file. It exported 111,889 declarations, 52,794 scopes, 88,839 source
binding records, and 59 implicit calls. There were no bounded/incomplete
analyses, missing sources, nonphysical or invalid ranges, invalid signatures,
or audit failures. This completes the full-category binding ABI matrix for
default FB, FBLite, and deprecated modes across x86-32, x86-64, and AArch64.

Deprecated-mode extended-syntax AArch64 binding update, 2026-10-08: the full
`-exx` AArch64 profile passes all 2,454 files with direct/prepared models,
88,839 source binding records, and 59 implicit calls. Expression coverage has
zero missing syntax or type mismatches; there are no bounded/incomplete
analyses, missing sources, nonphysical or invalid ranges, invalid signatures,
or audit failures.

Full extended-syntax binding matrix update, 2026-10-08: FBC schema 27 now has
full-category `-exx` binding evidence for default FB, FBLite, and deprecated
modes on x86-32, x86-64, and AArch64. All nine mode/ABI runs produced models
for all 2,454 files with exact preprocessing parity and no incomplete/bounded
analyses, source/range/signature issues, or audit failures. Complete snapshots
had zero type mismatches and all untyped ranges were invalid recovery.

Normal-compiler expression integration update, 2026-10-08: with
`analysis.compilerPath` unset, analysis now uses the configured
`freebasic.compiler.path` in sidecar-only mode when it provides schema 27.
This supplies exact expression types for saved inputs; it never claims bridge
origins, native symbol inventory, macro projection, or project refactoring.
If a root or consumed header has unsaved text, the sidecar-only path refuses
the result instead of applying types from stale disk content. Manual/onSave
expression analysis can therefore use ordinary current FBC, while `onChange`,
unsaved analysis, native workspace symbols, and project rename still require
the editor bridge. The full unit suite passes 427/427, and the repackaged VSIX
passes 40/40 installed-editor checks on both VS Code 1.141.0 and 1.85.0,
including normal-compiler sidecar typing through the worker-backed provider.

Current written-visibility sidecar integration, 2026-10-08: the schema-27
producer now attaches `procedure-written-visibility:<statement>` to the
selected procedure symbol. The extension accepts that ownership shape and
joins the fact to the declaration only through its exact compiler binding. A
new current-FBC regression checks the exported key, value, and editor-model
fact; the producer's updated semantic-sidecar suite passes 155/155 and the
compiler-backed extension unit suite passes 427/427 with no skips.

Responsiveness baseline, 2026-10-08: the analysis benchmarks now include
`src/compiler` on the include path, matching FBC's grouped source layout. On
the current Linux x86-64 bridge, prepared analysis of the large `ast-node-call`
and `parser-proc` modules sampled maximum host pauses of 16 ms and 21 ms;
their warm prepared queries took 22 ms and 59 ms respectively, with repeated
queries below 2 ms. A 54 KiB broken overlay containing 2,000 later expressions
reached EOF and retained an authoritative `double` type; prepared warm analysis
took 1.18 s with a 22 ms maximum host pause and a 0.6 ms query. Direct analysis
of the large units blocked the host for 614-848 ms. Worker analysis followed by
synchronous host model construction still showed 447-689 ms model-construction
pauses, so providers must continue to prefer prepared worker snapshots for
large files.

The project-rename benchmark validated two edits across two build contexts and
five compiler passes on `ast-node-call.bas`. Direct and worker end-to-end times
were 15.5 s and 15.3 s; the largest sampled host pause fell from 3.14 s to
64 ms. The full workspace-symbol benchmark indexed all 177 compiler modules
(748,408 declarations, 262 verified source files) in 415.3 s cold, with a
34 ms maximum host pause. All 177 records were retained (maximum cache size
194,479,158 bytes); a repeated no-match query hit every cached module and
completed in 0.37 s with a 6.9 ms maximum host pause. These are diagnostic
baselines from one machine, not latency guarantees. Further work remains to
reduce cold workspace cost, avoid synchronous model construction on the host,
and measure responsiveness across normal interactive provider traffic.

Current-schema Clang corpus checkpoint, 2026-10-08: the complete current
2,454-file portable corpus passed with `-gen clang -arch x86_64`, using the
schema-27 bridge built from FBC commit `c70cda089`. All 2,454 cases matched
stock preprocessing and produced direct and prepared models; there were no
bounded or incomplete analyses or audit failures. Of 890,828 syntax ranges in
complete snapshots, 887,220 had ordinary type records and all 3,608 remaining
ranges were invalid recovery; no syntax ranges or types were missing. The
semantic sidecar compared 95,095 facts, including 65,816 physical expressions
and 29,279 directive expressions. It supplemented 1,011 of 1,045 trace
omissions, conservatively withheld 34 repeated-context ambiguities, and found
no missing, mistyped, or status-mismatched answers. This audits Clang-selected
compiler semantics and preprocessing; it does not compile or link generated
Clang output. The run took 983 seconds on this host. The other code generators
remain open.

Current-schema Clang x86-32 follow-up, 2026-10-08: the same complete corpus
passed with `-gen clang -arch 386`. All files matched stock preprocessing and
produced direct and prepared models, with no bounded or incomplete analyses
or audit failures. Complete snapshots contained 887,328 typed ranges out of
890,934 syntax ranges; the 3,606 untyped ranges were all invalid recovery.
The sidecar compared 95,074 facts (65,794 physical expressions and 29,280
directive expressions), supplemented 1,011 of 1,045 trace omissions, and
withheld 34 ambiguous repeated contexts. Missing and mistyped answers were
zero. This run took 988 seconds; AArch64 remains the last principal target in
the current-schema Clang matrix.

Current-schema Clang AArch64 follow-up, 2026-10-08: the complete corpus passed
with `-gen clang -arch aarch64`; all 2,454 inputs matched preprocessing and
produced direct and prepared models, with no bounded/incomplete analyses or
failures. Complete snapshots had 859,362 typed ranges of 862,970 syntax
ranges; the 3,608 untyped ranges were all invalid recovery. The sidecar
compared 94,430 facts (65,155 physical expressions and 29,275 directive
expressions), supplemented 992 of 1,026 trace omissions, and withheld 34
ambiguous contexts. Missing, mistyped, and status-mismatched answers were zero.
This completes the current-schema Clang matrix on x86-32, x86-64, and AArch64;
GCC, LLVM, GAS, GAS64, and cross-backend combinations remain open.

Current-schema GCC x86-64 follow-up, 2026-10-08: the complete corpus also
passed with `-gen gcc -arch x86_64`, against the bridge rebuilt from current
FBC commit `4b764a582`. All 2,454 files matched preprocessing and produced
direct and prepared models, with zero bounded/incomplete analyses or failures.
Of 890,828 complete-snapshot syntax ranges, 887,220 had ordinary types and all
3,608 remaining ranges were invalid recovery. The sidecar compared 95,095 facts
(65,816 physical expressions and 29,279 directive expressions), supplemented
1,011 of 1,045 trace omissions, and withheld 34 ambiguous contexts. It found
no missing, mistyped, or status-mismatched answers. Current-schema GCC on
x86-32/AArch64 and LLVM/GAS/GAS64 profiles remain open.

Current-schema GCC x86-32 follow-up, 2026-10-08: `-gen gcc -arch 386` passed
all 2,454 inputs with matching preprocessing and direct/prepared models. There
were no bounded/incomplete analyses or audit failures. Complete snapshots had
887,376 typed syntax ranges of 890,982; the 3,606 remaining ranges were all
invalid recovery. The semantic sidecar compared 95,077 facts (65,795 physical
expressions and 29,282 directive expressions), supplemented 1,011 of 1,045
trace omissions, and withheld 34 ambiguous contexts. Missing, mistyped, and
status-mismatched answers were zero. The run took 1,098 seconds; current-schema
GCC AArch64 and the remaining backend profiles were then open.

Current-schema GCC AArch64 follow-up, 2026-10-08: `-gen gcc -arch aarch64`
passed the complete corpus with 2,454 preprocessing matches, direct models,
and prepared models. There were no bounded or incomplete analyses or audit
failures. Complete snapshots had 859,362 typed ranges of 862,970; all 3,608
untyped ranges were invalid recovery. The sidecar compared 94,430 facts
(65,155 physical expressions and 29,275 directive expressions), supplemented
992 of 1,026 trace omissions, and withheld 34 ambiguous contexts. Missing,
mistyped, and status-mismatched answers were zero. This completes current-
schema GCC coverage on x86-32, x86-64, and AArch64; LLVM, GAS, and GAS64 remain
open.

Current-schema LLVM x86-64 checkpoint, 2026-10-08: the complete corpus passed
with `-gen llvm -arch x86_64`, using a 120-second per-file bound for the
known expensive LLVM paths. Every input matched preprocessing and produced
direct/prepared models; none were bounded or incomplete and there were no
audit failures. Complete snapshots had 887,220 typed ranges of 890,828, with
all 3,608 untyped ranges invalid recovery. The sidecar compared 95,095 facts
(65,816 physical expressions and 29,279 directive expressions), supplemented
1,011 of 1,045 trace omissions, and withheld 34 ambiguous contexts. Missing,
mistyped, and status-mismatched answers were zero. This checks LLVM-selected
semantic and preprocessing behavior, not compiled or linked LLVM output. The
run took 1,133 seconds; GAS, GAS64, and other LLVM targets remain open.

Current-schema LLVM x86-32 follow-up, 2026-10-08: `-gen llvm -arch 386`
passed all 2,454 inputs with preprocessing parity and direct/prepared models.
No analyses were bounded or incomplete, including the pointer cases that had
failed on LLVM in older checkpoints. Complete snapshots had 887,328 typed
ranges of 890,934; the 3,606 remaining ranges were all invalid recovery. The
sidecar compared 95,074 facts (65,794 physical expressions and 29,280
directive expressions), supplemented 1,011 of 1,045 trace omissions, and
withheld 34 ambiguous contexts. Missing, mistyped, and status-mismatched
answers were zero. The run took 1,139 seconds; LLVM AArch64 remains open.

Current-schema LLVM AArch64 follow-up, 2026-10-08: `-gen llvm -arch aarch64`
also passed all 2,454 inputs with preprocessing parity and direct/prepared
models. There were no bounded or incomplete analyses or audit failures.
Complete snapshots had 859,362 typed ranges of 862,970; all 3,608 untyped
ranges were invalid recovery. The sidecar compared 94,430 facts (65,155
physical expressions and 29,275 directive expressions), supplemented 992 of
1,026 trace omissions, and withheld 34 ambiguous contexts. Missing, mistyped,
and status-mismatched answers were zero. The run took 1,186 seconds. This
completes the LLVM current-schema matrix on x86-32, x86-64, and AArch64.

Current-schema GAS x86-32 checkpoint, 2026-10-08: the complete corpus passed
with `-gen gas -arch 386`. All 2,454 files matched preprocessing and produced
direct/prepared models, with no bounded or incomplete analyses or audit
failures. Complete snapshots had 888,505 typed ranges of 892,111; the 3,606
remaining ranges were all invalid recovery. The sidecar compared 95,337 facts
(66,056 physical expressions and 29,281 directive expressions), supplemented
1,011 of 1,045 trace omissions, and withheld 34 ambiguous contexts. Missing,
mistyped, and status-mismatched answers were zero. The run took 1,129 seconds.
As with other `-pp` profiles, this verifies GAS-selected compiler semantics
and preprocessing, not assembly emission or linking.

Current-schema GAS64 x86-64 checkpoint, 2026-10-08: the complete corpus passed
with `-gen gas64 -arch x86_64`. All 2,454 inputs matched preprocessing and
produced direct and prepared models; there were no bounded or incomplete
analyses or audit failures. Complete snapshots had 887,220 typed ranges of
890,828; all 3,608 untyped ranges were invalid recovery. The sidecar compared
95,095 facts (65,816 physical expressions and 29,279 directive expressions),
supplemented 1,011 of 1,045 trace omissions, and withheld 34 ambiguous
contexts. Missing, mistyped, and status-mismatched answers were zero. The run
took 1,132 seconds and, like GAS, did not assemble or link output.

Current-schema code-generator corpus coverage now includes GCC, Clang, and
LLVM on x86-32, x86-64, and AArch64, plus GAS on x86-32 and GAS64 on x86-64.
Other target architectures remain open. These are independent selected-backend
audits; actual generated-code builds and execution remain separate
verification requirements.

Current-schema FBLite/Clang x86-64 checkpoint, 2026-10-08: the five
expression-heavy upstream categories passed all 548 files with direct and
prepared models, exact preprocessing parity, and no bounded/incomplete
analyses. Complete snapshots had 107,721 typed ranges of 114,824; all 7,103
untyped ranges were invalid recovery. The sidecar compared 6,139 facts, supplied
all 21 missing trace expressions, and found no ambiguous, missing, or mistyped
answers.

Current-schema deprecated/Clang x86-64 checkpoint, 2026-10-08: the same
548-file profile passed with no bounded or incomplete analyses and exact
preprocessing parity. Complete snapshots had 264,201 typed ranges of 273,026;
all 8,825 untyped ranges were invalid recovery. The sidecar compared 9,882
facts, supplemented all 21 missing trace expressions, and found no ambiguous,
missing, or mistyped answers. These two profiles extend backend evidence
beyond default FB; target/dialect/backend combinations beyond these profiles
remain open.

Current-schema QB/Clang x86-64 checkpoint, 2026-10-08: the dedicated 87-file
QB corpus passed with preprocessing parity and direct/prepared models. No
analyses were bounded or incomplete. Complete snapshots had 4,429 typed ranges
of 4,637; all 208 remaining ranges were invalid recovery. The sidecar compared
803 facts, supplied all 13 omitted trace expressions, and reported no
ambiguous, missing, or mistyped answers. This adds QB coverage under Clang to
the current-schema dialect/backend matrix.

QB/Clang target follow-up, 2026-10-08: the same dedicated 87-file QB corpus
passed with `-arch 386` and `-arch aarch64`. Both produced direct/prepared
models with exact preprocessing parity and no bounded or incomplete analyses.
Each sidecar supplemented all 13 missing trace ranges and reported no
ambiguous, missing, or mistyped answers. Together with the x86-64 checkpoint,
this covers the selected QB corpus under Clang on all three principal targets.

Deprecated/Clang target follow-up, 2026-10-08: the selected 548-file
compound/expressions/overload/pointers/structs corpus passed on both x86-32
and AArch64 with exact preprocessing parity and direct/prepared models. No
analysis was bounded or incomplete. All complete-snapshot untyped ranges were
explicitly invalid recovery; 21 omitted trace expressions per target were
supplemented, with zero missing, ambiguous, mistyped, or status-mismatched
answers. Together with the earlier x86-64 profile, this closes the selected
deprecated/Clang expression slice across the three principal targets, not the
full deprecated corpus or every backend combination.

Current-schema FBLite/Clang cross-target expression follow-up, 2026-10-08: the
same six selected categories (compound, expressions, functions, overload,
pointers, and structs) were audited on x86-32 and AArch64 against the
uninstrumented FBC `0220dfbab` baseline. The x86-32 profile passed all 702
files; the AArch64 profile covered the first five categories in 448 files and
the structs category in a separate 254-file run. Together both targets
produced 702 matching direct/prepared models, exact preprocessing parity, and
no bounded or incomplete analyses. Across the two complete snapshots, 124,912
of 133,141 syntax ranges had ordinary types; the other 8,229 were explicitly
invalid recovery. The sidecars compared 8,695 expression facts, supplied all
23 trace-missing answers, and reported no ambiguous, missing, mistyped, or
status-mismatched results. All 9,701 safe recovery facts were available only
with the expected provisional status.

FBLite/Clang x86-64 function-expression follow-up, 2026-10-08: the 154-file
`functions` category also passed with exact preprocessing parity, direct and
prepared models, and no bounded or incomplete analyses. Its sidecar compared
2,667 facts, supplied both missing trace ranges, and had no missing, ambiguous,
mistyped, or recovery-status mismatches. This adds the `functions` category
to the previously recorded five-category x86-64 profile. Broader
dialect/backend coverage remains open.

Additional target-architecture expression checkpoint, 2026-10-08: the
expression-heavy `expressions`, `compound`, `overload`, `pointers`, and
`structs` categories passed for `-arch mips64` on the default compiler backend.
All 548 files matched preprocessing and produced direct/prepared models, with
no bounded or incomplete analyses or failures. Complete snapshots had 274,872
typed ranges out of 275,345; the 473 remaining ranges were all invalid
recovery. The sidecar compared 24,957 facts, supplemented all 93 trace
omissions, and found no ambiguous, missing, or mistyped answers. This adds
expression evidence for a non-principal target; full corpus and dialect/backend
coverage for MIPS64 and the other target architectures remain open.

Additional MIPS32 little-endian expression checkpoint, 2026-10-08: the same
548-file expression-heavy profile passed with `-arch mips32el`, producing
548 direct/prepared models and exact preprocessing parity. No analyses were
bounded or incomplete. Complete snapshots had 274,854 typed ranges out of
275,327; all 473 other ranges were invalid recovery. The sidecar compared
24,951 facts, supplemented all 93 trace omissions, and reported zero
ambiguous, missing, or mistyped answers.

Additional RISC-V64 expression checkpoint, 2026-10-08: the same five
expression-heavy categories passed all 548 compiler files under `-arch
riscv64`, with direct/prepared models, 548 parity matches, and no bounded or
incomplete analyses. Complete snapshots had 274,813 typed ranges of 275,286;
all 473 remaining ranges were invalid recovery. The sidecar compared 24,957
facts, supplied all 93 missing trace ranges, and reported no ambiguous,
missing, or mistyped answers.

Additional PowerPC64 expression checkpoint, 2026-10-08: the same 548-file
profile passed under `-arch powerpc64`, again with direct/prepared models and
exact preprocessing parity. Of 275,345 complete-snapshot syntax ranges,
274,872 had types and all 473 remaining ranges were invalid recovery. All
24,957 sidecar facts agreed; the 93 missing trace ranges were supplemented,
with no ambiguity, missing, or mistyped answers. These curated slices broaden
target ABI evidence but do not close the remaining target, dialect, or backend
matrix.

Context-aware ambiguous-expression hover checkpoint, 2026-10-08: schema-27
expression origins now retain their source-context identities through editor
analysis. When one physical range has conflicting compiler types or nominal
type identities, exact expression lookup remains fail-closed, while hover
returns the distinct compiler-selected types and bounded include paths that
explain the ambiguity. A real fixture includes one header twice under
different macro states; its same physical `Print context_value` expression
resolves to `Integer` and `String` in separate namespaces. The packaged VSIX
shows both types and both include-site lines without changing either file.
The focused full `functions` corpus still classifies all 34 historical
repeated-include conflicts as ambiguous, with zero missing or mistyped answers.
The complete unit suite passes 428/428 with no skips, smoke passes 7/7,
TextMate grammar tests pass 2/2, and the installed VSIX passes 38/38 checks in
VS Code 1.141.0. A singular type remains intentionally unavailable for these
context-dependent spans; the editor now exposes the compiler evidence instead
of silently leaving the hover empty.

Numeric RESTORE refactoring checkpoint, 2026-10-08: the QB numeric-label rename
regression now also covers a numeric label on a `DATA` statement and its
`RESTORE &H40` reference. Renaming the line label to an identifier produces
the required declaration colon and updates the restore operand, with compiler
validation and no source write. This closes a missing project-refactoring
case for an existing compiler binding path; it does not establish every legacy
or recovery label form. The full unit suite passes 428/428 with no skips.

`NEW` constructor refactoring checkpoint, 2026-10-08: the project UDT-rename
regression now mutates only the compiler-selected `new-constructor` signature
during the validation pass and requires the preview to be rejected. This
explicitly protects scalar, vector, and default `NEW` constructor relationships
from silently changing while a type is renamed. The valid rename preview still
leaves source files untouched; the focused test passes.

Implicit-call rename validation checkpoint, 2026-10-08: project type-rename
tests now independently mutate the selected-call signature for every current
sidecar implicit-call kind: default and initializer constructors, argument and
return constructors, `NEW` constructors, ordinary destructors, temporary and
scope-exit destructors, and DELETE destructors. Each mutation must invalidate
the preview; the valid rename remains non-mutating. This closes the signature-
comparison test gap across the nine exported relationships, not every possible
compiler-generated source anchor. The complete unit suite passes 429/429 with
no skips.

Legacy implicit-variable rename checkpoint, 2026-10-08: a deprecated-mode
project test now renames both a compiler-created module variable and a
procedure-local implicit variable. It verifies every same-scope occurrence
and keeps the two same-spelled but separately scoped identities apart; the
preview leaves source unchanged. The targeted compiler-backed test passes.

Compiler-created loop-variable refactoring checkpoint, 2026-10-08: project
rename now has a targeted `For counter As Long` case that updates the counter
declaration, body use, and `Next` reference as one compiler-validated preview.
The saved source remains unchanged, and the focused test passes.

Project reference regression refresh, 2026-10-08: the numeric `RESTORE`,
deprecated implicit-scope, `For As` counter, temporary-destructor, and
per-kind implicit-call signature cases all pass with the full compiler-backed
unit suite at 433/433 and no skips. FBC and project previews leave the tested
source snapshots unchanged.

Macro-callback reference rename checkpoint, 2026-10-08: project rename now has
regressions for both an ordinary variable reference emitted by a `#macro` body
and a compiler-bound variable passed through a callback formal under two build
contexts. The previews update the declaration plus the physical callback-body
or both invocation-argument tokens as appropriate, leaving saved source
untouched. This adds callback-source reference coverage beyond `#define`
replacement text and generated declarations; other callback-generated and
ambiguous macro origins remain fail-closed. The full
compiler-backed unit suite passes 435/435 with no skips.

Current FBC sidecar integration checkpoint, 2026-10-08: the extension bridge
was rebuilt from FBC `4b764a582` (schema 27) after the latest sidecar changes.
A producer edge case for macro-expanded `#include` operands now exports
unanchored `SRC` and `INC` directive locations instead of invalid physical
ranges, while `#line` provenance retains its written directive extent even
when the physical flag is false. The FBC sidecar suite passes 156/156, the
compiler semantic-model smoke target passes, the extension unit suite passes
436/436 with no skips, smoke and grammar checks pass 7/7 and 2/2, and the
Linux-packaged VSIX passes 41 VS Code integration checks. This verifies the
latest producer/consumer contract and selected editor workflows, not all
possible sidecar source contexts or the full backend matrix.

FBC semantic-source follow-up, 2026-10-08: rebuilt the editor bridge from FBC
`0220dfbab540c31a5b37a943310fb5b1f41af250` (schema 27). The updated
`SRC`/`INC` records now omit directive coordinates unless their origin is
physical, while `MAP` continues to retain the written `#line` extent when its
physical flag is false. The new macro-expanded-include producer test and the
existing remap/source-revision checks pass against this bridge. An extension
regression decodes both full and expressions-only sidecars, confirming that the
include dependency survives while its nonphysical directive remains unanchored.
The compiler-backed extension suite passes 451/451 with no skips; smoke,
grammar, reference-reproducibility, and focused sidecar checks pass 7/7, 2/2,
3/3, and 4/4 respectively. The offline language reference now pins the current
FBC source revision. The generic FBC producer suite must use an uninstrumented
compiler build: the editor bridge intentionally omits the redundant `LOC`
ledger in expressions-only mode and accepts unmarked single-byte source, so its
output is not identical on those producer-specific assertions. To verify the
producer directly, an uninstrumented compiler was built out of tree from the
same FBC revision; its complete semantic-sidecar suite passes 156/156.

Latest schema-27 semantic observations, 2026-10-08: the current FBC revision
also carries declaration/procedure typing inputs, written aggregate access
sections, scalar String initializer origins, SELECT CASE lowering receipts,
and target-wide literal prefixes. The extension's current bridge and decoder
are in sync with these records. A focused end-to-end test against the 1.20.4
bridge passes 1/1: all six capabilities reach analysis, symbol-owned facts are
attached to their compiler-bound declarations, and SELECT CASE/literal
properties remain available in the generic semantic-property collection. This
is ABI uptake, not yet a user-facing feature built on every new fact; in
particular, SELECT CASE lowering and target-literal properties are not yet
consumed by editor queries.

Aggregate recovery follow-up, 2026-10-08: a broken field initializer inside a
UDT now has an end-to-end recovery regression. Compiler identities for the
aggregate and affected fields are marked invalid, a later variable using that
type retains its compiler-selected `Double` result as provisional, and an
unrelated later `Double` expression remains authoritative. The unsaved source
is verified unchanged. The focused native test passes 1/1, and the complete
compiler-analysis test file passes 99/99 with no skips. This adds one
aggregate-member recovery pairing, not complete coverage of malformed member
declarations or structural recovery combinations.

Full suite confirmation after the aggregate-recovery regression, 2026-10-08:
the compiler-backed extension unit suite passes 452/452 with no failures or
skips against the bridge built from FBC `0220dfbab`.

Current VSIX runtime checkpoint, 2026-10-08: rebuilt the Linux 1.20.4 package
with the FBC `0220dfbab` reference metadata and current bridge-facing code. The
installed package passes all 37 extension-host checks on both VS Code 1.85.0
and 1.141.0. These checks exercise native Outline, closed-file workspace
symbols, unsaved analysis, macro-origin navigation, recovery, and validated
project rename in the packaged runtime.

Current-schema MIPS64 full-corpus checkpoint, 2026-10-08: all 2,454 portable
upstream files matched trace-disabled preprocessing and produced direct and
prepared models under `-arch mips64`. No analyses were bounded or incomplete,
and there were no audit failures. Complete snapshots contained 860,359 typed
syntax ranges of 863,967; all 3,608 remaining ranges were explicitly invalid
recovery. The sidecar compared 65,227 facts plus 29,275 directive expressions,
supplemented 995 of 1,029 missing trace expressions, withheld 34 repeated-
context ambiguities, and reported no missing or mistyped answers. The run took
1,108 seconds. This is preprocessing and compiler-semantic evidence, not MIPS64
assembly, linking, or runtime evidence.

Current-schema RISC-V64 full-corpus checkpoint, 2026-10-08: the same 2,454
files matched preprocessing and produced direct and prepared models under
`-arch riscv64`, with no bounded or incomplete analyses or audit failures.
Complete snapshots contained 859,944 typed syntax ranges of 863,552; all 3,608
remaining ranges were invalid recovery. The sidecar compared 65,231 facts plus
29,275 directive expressions, supplemented 995 of 1,029 missing trace
expressions, withheld 34 repeated-context ambiguities, and reported no missing
or mistyped answers. The run took 1,126 seconds. Object generation, linking,
and execution remain separate requirements.

Current-schema PowerPC64 endianness checkpoints, 2026-10-08: the complete
2,454-file corpus passed under both `-arch powerpc64` and `-arch powerpc64le`.
Each target matched trace-disabled preprocessing and produced 2,454 direct and
prepared models, with no bounded or incomplete analyses or audit failures.
The audit reported no missing or mistyped expression or sidecar answers. The
big-endian and little-endian runs took 1,129 and 1,163 seconds respectively.
They verify target-selected semantics and preprocessing, not assembled or
executed PowerPC output.

Current-schema RISC-V64 semantic-binding checkpoint, 2026-10-08: the full
2,454-file default-FB corpus passed with `--semantic-bindings` and
`--architecture=riscv64`. Every file produced a direct model and a matching
prepared model, with exact trace-disabled preprocessing parity and no bounded
or incomplete analyses. The audit reported no invalid binding records,
nonphysical or out-of-bounds ranges, missing sources or signatures, or other
failures. This extends compiler-selected refactoring evidence beyond the
previous full-category x86-32, x86-64, and AArch64 binding matrix; other target
architectures and cross-build rename behavior remain open. A focused project
type-rename regression validates selected constructor relationships across
12 target profiles spanning x86, ARMv7, RISC-V32/64, MIPS32/64 endianness
variants, and PowerPC32/64 endianness variants. It confirms the edit preview
and checks that the original file is untouched.

Current-schema RISC-V32 semantic-binding checkpoint, 2026-10-08: the full
2,454-file default-FB corpus passed with `--semantic-bindings` and
`--architecture=riscv32`. Every file matched preprocessing and produced direct
and prepared models, with no bounded or incomplete analyses. Binding records
had no invalid/nonphysical/out-of-bounds ranges, missing sources, or invalid
signatures, and the audit had no failures. This adds a 32-bit RISC-V target to
the full-corpus refactoring-fact matrix; further target ABIs remain open.

Current-schema MIPS32LE semantic-binding checkpoint, 2026-10-08: the full
2,454-file default-FB corpus passed with `--semantic-bindings` and
`--architecture=mips32el`. Every file matched preprocessing and produced
direct and prepared models, with no bounded or incomplete analyses. Binding
records had no invalid/nonphysical/out-of-bounds ranges, missing sources, or
invalid signatures, and the audit had no failures. Both tested MIPS64 byte
orders and MIPS32LE now have full binding evidence; other MIPS targets and
broader target coverage remain open.

Current-schema MIPS32 semantic-binding checkpoint, 2026-10-08: the full
2,454-file default-FB corpus passed with `--semantic-bindings` and
`--architecture=mips32`. Every file matched preprocessing and produced direct
and prepared models, with no bounded or incomplete analyses. Binding records
had no invalid/nonphysical/out-of-bounds ranges, missing sources, or invalid
signatures, and the audit had no failures. Both MIPS32 endianness variants now
have full-corpus binding and constructor-aware project-rename evidence; other
target ABIs remain open.

Current-schema PowerPC64LE semantic-binding checkpoint, 2026-10-08: the full
2,454-file default-FB corpus passed with `--semantic-bindings` and
`--architecture=powerpc64le`. Every file matched preprocessing and produced a
direct model and matching prepared model. No analyses were bounded or
incomplete, and no binding had invalid, nonphysical, or out-of-bounds ranges,
missing source context, or invalid signatures. The audit had no failures. This
extends full-corpus refactoring-fact coverage to a little-endian PowerPC64 ABI;
other target ABIs and multi-target rename fixtures remain open.

Current-schema PowerPC64 semantic-binding checkpoint, 2026-10-08: the full
2,454-file default-FB corpus passed with `--semantic-bindings` and
`--architecture=powerpc64`. Every input matched preprocessing and produced
direct and prepared models, with no bounded or incomplete analyses. The audit
reported no invalid binding records, nonphysical/out-of-bounds ranges, missing
sources or signatures, or failures. Together with the PowerPC64LE run, both
endianness variants now have full-corpus binding evidence; other target ABIs
and cross-build rename fixtures remain open.

Current-schema PowerPC32 semantic-binding checkpoint, 2026-10-08: the full
2,454-file default-FB corpus passed with `--semantic-bindings` and
`--architecture=powerpc`. All files matched preprocessing and produced direct
and prepared models, with no bounded or incomplete analyses. Binding records
had no invalid/nonphysical/out-of-bounds ranges, missing sources, or invalid
signatures, and the audit had no failures. This adds a 32-bit big-endian
PowerPC target to the full refactoring-fact matrix; other target ABIs remain
open.

Current-schema MIPS64 semantic-binding checkpoint, 2026-10-08: the same full
2,454-file default-FB corpus passed with `--semantic-bindings` and
`--architecture=mips64`. All files matched trace-disabled preprocessing and produced direct
and prepared models; no analysis was bounded or incomplete. There were no
invalid binding records, nonphysical/out-of-bounds ranges, missing sources or
signatures, or audit failures. This extends the target-ABI refactoring-fact
matrix to big-endian MIPS64; other target ABIs and cross-build rename fixtures
remain open.

Current-schema MIPS64EL semantic-binding checkpoint, 2026-10-08: the same full
2,454-file default-FB corpus passed with `--semantic-bindings` and
`--architecture=mips64el`. All files matched preprocessing and produced direct
and prepared models, with no bounded or incomplete analyses. No binding had an
invalid or nonphysical range, a missing source, or an invalid signature, and
the audit had no failures. Both MIPS64 endianness variants now have full-corpus
binding evidence; other target ABIs remain open.

Current compiler-route inventory, 2026-10-08: the grammar-led expression
route audit found no unowned or stale AST-producing parser routes, duplicate
ownership, or definition drift in current FBC. The compiler call-route audit
also found no unowned or stale call builders, call-site or kind drift, and
matched all nine emitted implicit-call kinds to the producer's supported
vocabulary. These inventories catch new route omissions but do not replace
runtime corpus and editor behavior tests.

Workspace-symbol cold-index improvement, 2026-10-08: compiler module indexing
now uses two dedicated worker lanes, separate from the worker reserved for
interactive analysis. It indexes bounded two-module waves, merges results in
configured order, preserves deterministic cache sharding, and limits extra work
after the result cap to the current wave. At each wave boundary, indexing waits
for the foreground analysis worker to drain before starting more module jobs.
`freebasic.index.workspaceConcurrency` defaults to 2 and can be set to 1 to
reduce memory use. Matched 177-module runs took 439.95 seconds cold with one
worker and 285.35 seconds with two, about 35% faster; warm passes took 316 ms
and 251 ms. Both retained all 748,408 declarations and all 177 cache entries.
The two-worker process reached about 1.1 GB resident memory, so the setting
keeps that performance/memory trade-off user-adjustable.

Foreground responsiveness checkpoint, 2026-10-08: while the two-worker pool
indexed all 177 FBC modules, a prepared `parser-proc.bas` model received 56
hover and 56 semantic-token queries at five-second intervals. There were no
failures. End-to-end p95 was 1.86 ms for hover and 1.64 ms for semantic tokens;
the worker's measured freshness and model-query phases remained below 0.5 ms
p95. The foreground-idle gate is therefore doing useful work: the earlier
two-worker run without it had hover tails near 100 ms. Maximum sampled host
pause was still 110 ms, which remains an independent responsiveness issue to
investigate. The active extension provider keeps model construction and
compiler work off the editor host through `CompilerRemoteModel`; prior
synchronous host-construction timings apply to the direct-analysis benchmark,
not the default provider path. The current unit suite passes 450/450 with no
skips, smoke passes 7/7, grammar passes 2/2, and the packaged VSIX passes 41
checks on VS Code 1.141.0, including a real workspace-symbol query after
changing the worker count from 2 to 1 in the same session. The installed-editor
fixture also runs a foreground hover concurrently with the workspace-symbol
provider and verifies the compiler-selected result.

Expanded-source cache responsiveness follow-up, 2026-10-08: normal analysis
and workspace indexing no longer recompute UTF-8 byte lengths for every
retained expanded snapshot on each insertion. `BoundedTextMap` tracks bytes per
key and evicts oldest entries incrementally under the existing eight-entry and
32 MiB bounds. Its regression covers Unicode accounting, overwrite, entry and
byte eviction, deletion, and oversized values. The full compiler-backed unit
suite passes 453/453 with no skips; smoke and grammar checks pass 7/7 and 2/2.
The updated Linux VSIX passes all 37 packaged checks on both VS Code 1.85.0 and
1.141.0. The package smoke test and installed-archive verifier now require the
new runtime module in both Linux and PowerShell builder manifests. This removes
repeated cache scans but does not yet prove that the earlier 110 ms host pause
is resolved; a matching-query profile is now available in addition to the
no-match indexing query.

Workspace result-query responsiveness profile, 2026-10-08: the expanded
workspace benchmark now accepts `FBC_WORKSPACE_BENCHMARK_QUERY`, uses the
configured 1,000-result default (or an explicit bounded result limit), samples
foreground queries immediately, and retains expanded views through the same
bounded text cache as the provider. Under query `a` with a 10,000-result limit,
the current 177-module run indexed all modules and returned 7,578 results; the
warm pass hit all 177 module caches. One 97,319-byte expanded view was retained.
Across 65 foreground samples there were no failures; semantic-token p95 was
1.96 ms and hover p95 was 1.75 ms. The maximum host timer gaps were 131 ms cold
and 74 ms warm. A user-owned PCem process was consuming roughly one CPU core
during the run, and this measurement does not attribute the pause to JavaScript,
GC, or scheduler delay. The responsiveness issue therefore remains open; an
idle-host repeat is still needed. A separate cap-reaching run with the default
1,000-result limit returned exactly 1,000 symbols after two modules. Its
immediate foreground sample measured 3.32 ms for semantic tokens and 1.41 ms
for hover; the compact reply batch was 247,258 bytes, maximum merge time was
8.6 ms, and worker-message delay was 1.6 ms. Maximum host pause was 32.5 ms.
During the same PCem activity, a standalone idle Node event-loop timer sampled
for 30 seconds had a 28.7 ms maximum gap, p95 5.3 ms, and no gaps over 50 ms.
The competing process alone therefore did not reproduce the full-index pause.

Workspace symbol reply compaction, 2026-10-08: the worker now sends the
existing interned symbol representation and the host materializes full symbol
objects only after deduplication. A 177-module `a` query returned the same
7,578 unique symbols while measured worker reply bytes fell from 180,599,860
to 66,249,191 (about 63% less); the largest batch fell from 2,497,632 to
948,300 bytes, and maximum worker-message delay fell from 43.8 ms to 10.7 ms.
Compact round-trip/dedupe tests pass, and the full extension unit suite passes
454/454 with no skips. The refreshed VSIX again passes 37 checks on both VS
Code 1.85.0 and 1.141.0. This reduces transfer and host object allocation but
does not by itself eliminate the 100+ ms long-tail host pause; synchronous
batch merge still peaked at 41 ms in the full profile. Further worker-side
deduplication/context aggregation and an idle-host repeat remain open.

No-match pause attribution follow-up, 2026-10-08: a complete 177-module
no-match scan on an idle host still showed a 127.7 ms maximum timer gap in the
benchmark's main thread. The same report measured batch merge at 0.16 ms,
worker-message delay at 3.1 ms, worker message handling at 0.79 ms, workspace
finish at 1.56 ms, and main-thread GC at 2.9 ms maximum. A standalone 30-second
idle Node timer peaked at 7.1 ms. The measured pause is workload-induced but
outside these recorded phases. Progress logging was moved out of the measured
interval with no change. An eight-module compiler-output probe captured only
200 bytes and measured sub-millisecond chunk handling/finalization, but that
does not cover every large module. Child-stream `Buffer` chunks are now kept
without an unnecessary per-chunk copy, and the benchmark can opt into profiling
chunk handling, output assembly, and reply posting. The remaining timer gap is
not yet attributed to a specific extension-host or OS phase.

SELECT CASE expression coverage follow-up, 2026-10-08: upstream lowering and
coercion fixtures now run on x86-32, x86-64, and AArch64 in both traced and
sidecar-only modes. Each target/mode run compares at least 40 exact compiler
`E` ranges on selector and CASE lines, with matching dtypes, type spellings,
and authoritative status. A second fixture runs 12 source expression queries
for each combination of four dialects, three targets, and traced/sidecar-only
analysis (288 comparisons total). It confirms QB's compiler-selected `SHORT`
for `INTEGER` while other tested modes select `INTEGER`. Hover continues to
use each source expression's type; lowering receipts describe post-coercion
comparison operands and must not replace that source type. The complete
compiler-semantic-sidecar test file passes 106/106 with no skips. The full
compiler-backed extension suite passes 456/456 with no skips, including both
SELECT CASE matrices.

Malformed SELECT CASE recovery checkpoint, 2026-10-08: an unsaved CASE
alternative ending in `selector +` is withheld, while a later `Case 3`, its
body expression, and a following `Double` assignment remain authoritative in
the traced model. A separately saved copy runs through the actual trace-free
semantic-sidecar path; it withholds the malformed alternative and marks the
later recovery facts provisional. A parallel unsaved-header fixture maps the
error to the included file, retains later header/root expressions, and confirms
that sidecar-only analysis refuses the changed header. All saved files remain
unchanged. The complete compiler-analysis test file passes 101/101 with no
skips, and the full compiler-backed extension suite passes 458/458 with no
skips, including both recovery regressions.

Sidecar declaration-property ordering checkpoint, 2026-10-08: compiler
declaration typing inputs now join to their group by owner and group identity
after all `K` properties have been collected. Declaration groups and inputs,
procedure typing/visibility observations, and aggregate access sections are
ordered by their explicit statement, group, input, or section identities, not
wire arrival order. Current-FBC regressions reverse the complete property list
and preserve the same structured facts. The full compiler-backed extension
suite passes 460/460 with no skips. The rebuilt Linux VSIX passes all 37
installed-editor checks on VS Code 1.85.0 and 1.141.0, including native
Outline, closed-module workspace symbols, and validated rename.

Physical include-origin follow-up, 2026-10-09: current FBC emits include and
source-context directive ranges only when their lexer locations are physical.
The extension reader now honors that flag and drops coordinates marked
nonphysical, including older schema-27 records that retained logical
coordinates. Regression coverage checks full and expressions-mode output plus
legacy-shaped records. The complete compiler-backed extension suite passes
465/465 with no skips against the current 1.20.4 bridge. The rebuilt Linux VSIX
passes all 37 installed-editor checks on VS Code 1.85.0 and 1.141.0.

Nonphysical remap provenance regression, 2026-10-09: the current FBC source
still emits schema 27; the recent `SRC`/`INC`/`MAP` changes tighten source
ranges and physical trust flags without introducing new record shapes. The
extension regression now confirms that a nonphysical `MAP` keeps the written
`#line` span as provenance without treating it as physical. The FBC
semantic-model target passes 157/157, and the focused include/remap consumer
regressions pass 2/2 against the current compiler.

FBLite expression-sidecar matrix, 2026-10-09: the full upstream corpus was
audited in `-lang fblite -arch x86_64` against the bridge built from current
FBC source. All 2,454 files matched the stock compiler's exit status and
trace-disabled preprocessing, with 2,454 direct and prepared models and no
bounded or incomplete analyses. Of these, 690 modules compiled completely and
1,764 produced partial/recovery results. Across 324,883 traced syntax ranges,
311,736 had ordinary types; all 13,147 untyped ranges were explicitly marked
invalid, with no provisional, unmarked-recovery, or mistyped ranges. The
sidecar audit compared 31,155 expression facts, supplemented all 709 missing
trace facts, and reported no ambiguous, missing, or mistyped answers. This
establishes broad FBLite/x86-64 coverage, not the remaining dialect, backend,
or target matrix.

QB macro-lifecycle and expression audit, 2026-10-09: current FBC now marks a
`#define` attempt as `definition-rejected` when a dialect-reserved name yields
no selected macro identity, even when the compiler emits no diagnostic. This
keeps schema-22 `ML` records consistent with their identity contract instead
of publishing `define` with identity zero. Full, bindings-only, and
expressions-only producer tests cover QB's rejected SFX names and accepted
names; the semantic-sidecar suite passes 157/157. The extension now exposes
macro lifecycle events from the semantic sidecar, and its QB regression passes
against the rebuilt current-source bridge.

The full QB/x86-64 upstream corpus then passed: 2,454/2,454 compiler parity
checks and prepared models, with no bounded/incomplete analyses or failures.
Across 3,028 sidecar expressions, 1,540 were directly compared and 32 missing
trace facts were supplemented; there were no ambiguous, unresolved, or
mistyped answers. All 54,947 recovery sidecar-only queries also resolved
without missing or mistyped results. Of 204,579 trace syntax ranges, 119,868
had ordinary types; the 84,711 remaining ranges were explicitly invalid, with
no provisional or unmarked recovery ranges. This closes the observed QB macro
lifecycle failure and adds QB/x86-64 corpus evidence, but not the other
dialect, backend, or target combinations.

Post-fix extension verification: the complete compiler-backed suite passes
466/466 with no skips; smoke and grammar checks pass 7/7 and 2/2. The rebuilt
Linux VSIX passes all 37 installed-editor checks on VS Code 1.85.0 and
1.141.0.

Deprecated-mode expression-sidecar matrix, 2026-10-09: the full upstream
corpus was audited in `-lang deprecated -arch x86_64` against the bridge built
from the current working FBC source. All 2,454 files matched compiler exit
status and trace-disabled preprocessing, with direct and prepared models for
every file and no bounded or incomplete analyses. There were 829 complete and
1,625 partial/recovery models. Across 842,996 syntax ranges, 826,444 had
ordinary types; all 16,552 untyped ranges were explicitly invalid, with no
provisional, unmarked-recovery, or mistyped ranges. The sidecar audit compared
45,137 expression facts, supplemented all 840 trace omissions, and reported
zero ambiguous, missing, or mistyped results. All 63,079 sidecar-only query
facts and 30,145 recovery queries were answered. This adds deprecated/x86-64
expression coverage; other backend and target combinations remain open.

Clang/RISC-V64 expression-sidecar matrix, 2026-10-09: the full upstream
corpus passed with `-gen clang -arch riscv64`, using the bridge built from the
current working FBC source. All 2,454 inputs matched preprocessing and
produced direct and prepared models, with no bounded or incomplete analyses
or failures. Of 863,552 traced syntax ranges, 859,944 had ordinary types; all
3,608 remaining ranges were explicitly invalid, with no provisional,
unmarked-recovery, or mistyped ranges. The sidecar compared 65,231 expression
facts plus 29,275 directive facts, supplemented 995 of 1,029 trace omissions,
and withheld 34 repeated-include ambiguities. There were no missing or
mistyped answers, including 2,215 recovery sidecar-only queries. This adds a
non-x86 Clang semantic profile; `-pp` parity does not verify RISC-V code
assembly or linking.

Workspace no-match concurrency and CPU profile, 2026-10-09: a fresh two-worker
177-module run indexed cold in 284.5 seconds with a 101.8 ms maximum host timer
gap; repeated indexing took 236 ms with a 7.9 ms gap. Foreground query p95 was
1.71 ms for semantic tokens and 1.42 ms for hover. Output chunk handling,
finalization, execution-reply posting, batch merge, and GC all stayed below
4 ms maximum. A V8 profile covered 289.5 seconds, of which 269.5 seconds were
idle, with about 5.5 seconds in JS program frames; no large synchronous JS
hotspot accounted for the timer gap. A one-worker repeat reduced the maximum
gap to 53.1 ms but took 441.2 seconds cold and had one 29.1 ms hover outlier;
p95 remained 1.78 ms for tokens and 1.46 ms for hover. The data supports the
current configurable two-worker default as a speed/memory trade-off, but the
remaining timer gap appears outside the measured JavaScript phases and still
needs idle-host/scheduler-level attribution. The user-owned PCem process was
present but observed at 0% CPU during both runs.

Host compiler-launch fairness follow-up, 2026-10-09: the profile showed
`child_process.spawn()` taking 12.7 seconds cumulatively over 354 launches.
The host now queues launches one per event-loop turn and prioritizes
non-workspace-index requests ahead of background index jobs, while preserving
host-owned child cleanup and cancellation. The worker/model-worker suites pass
52/52; the full extension suite passes 468/468 with no skips, and smoke/grammar
pass 7/7 and 2/2. The packaged VSIX passes 37 checks on VS Code 1.85.0 and
1.141.0.

In the same 177-module two-worker no-match benchmark, cold indexing remained
284.4 seconds, the maximum host timer gap fell from 101.8 ms to 53.4 ms, and
the maximum spawn call was 49.3 ms. The warm pass took 215 ms. Foreground p95
was 3.94 ms for semantic tokens and 1.90 ms for hover, but rare maxima reached
40.2/44.5 ms; therefore this reduces consecutive spawn stalls without
establishing consistently low foreground tails. A separate process runner may
be needed to remove the remaining synchronous spawn block.

UDT constructor reference and rename-validation follow-up, 2026-10-09: the
schema-27 producer now emits a physical `B` reference for the written UDT or
typedef name in ordinary `Return TypeName()` construction, before the parser
consumes that token. Full and bindings-only sidecar regressions verify the exact
selected symbol. Project validation now maps sidecar-supplemented rename spans
through physical token origins when normalizing expression-graph coordinates;
this prevents a valid rename from appearing to change expression relationships
when the editor trace has no symbol-use entry for that constructor route. The
project rename regression exercises multiple temporary-destructor sites across
direct calls, IIF, conditions, WITH, and assignments, rejects mutations to all
selected cleanup signatures, and confirms the valid preview leaves source
unchanged. The FBC semantic-model suite passes 158/158, the full extension unit
suite passes 468/468, smoke and grammar pass 7/7 and 2/2, and the rebuilt VSIX
passes 38 installed-editor checks on both VS Code 1.85.0 and 1.141.0. This
closes one previously unbound type-construction route, not the full set of
compiler expression or project-refactoring paths.

A shared-header/two-module project regression added after that full suite also
passes 1/1: both translation units validate the constructor expression from the
same header, while the preview contains exactly one edit for each physical
spelling and leaves the header and modules unchanged.

Current-source binding corpus follow-up, 2026-10-09: the rebuilt bridge passed
the x86-64 `expressions`, `functions`, `structs`, `typedef`, and `dim` categories
(844/844 source files), with exact preprocessing parity and direct/prepared
models for every input. None was bounded or incomplete. The 328 complete
snapshots had 298,905 typed syntax ranges of 299,950; every one of the 1,045
untyped ranges was invalid recovery, with zero missing syntax or type
mismatches. The binding sidecar exposed 50,119 physical bindings and 1,347
compiler-selected implicit calls across eight kinds. There were no nonphysical
or invalid records, missing sources, out-of-bounds ranges, invalid signatures,
or audit failures. This adds current-source evidence for the new type-name
binding route across expression, function, aggregate, typedef, and declaration
corpus slices, not the complete binding corpus or all target/backend profiles.

Current-source full selected binding/call audit, 2026-10-09: the configured
14-category x86-64 audit passed all 1,705 upstream files against the rebuilt
bridge. Every file matched preprocessing and produced a direct and prepared
model; none was bounded or incomplete. The 693 complete snapshots had 406,811
typed syntax ranges out of 408,431, with all 1,620 remaining ranges classified
as invalid recovery and zero missing syntax or type mismatches. The sidecar
retained 83,230 bindings and 1,768 compiler-selected implicit calls covering
all nine supported kinds. There were no nonphysical/invalid facts, missing
sources, out-of-bounds spans, bad signatures, or audit failures. This verifies
the current FBC binding exporter and extension joins over the selected
high-risk corpus; unselected categories, dialect/target/backend matrices, and
every refactoring transformation remain open.

Current-source full expression-sidecar audit, 2026-10-09: the complete
2,454-file portable corpus passed with the current bridge on x86-64, with exact
preprocessing parity and direct plus prepared models for every file. No request
was bounded or incomplete. Of 890,828 complete-snapshot syntax ranges, 887,220
had compiler types and all 3,608 remaining ranges were explicitly invalid
recovery; there were no missing syntax ranges or type mismatches. The sidecar
reported 95,095 expression facts, compared 65,816 direct expressions plus
29,279 directive expressions, and supplemented 1,011 of 1,045 missing trace
facts. The other 34 repeated-include conflicts stayed conservatively
ambiguous; there were no missing or mistyped answers. This is full portable
corpus evidence for the default language mode on x86-64, not proof across all
dialects, targets, backends, options, or user projects.

Current-source GAS expression-sidecar profiles, 2026-10-09: the same complete
2,454-file portable corpus passed with `-gen gas64 -arch x86_64` and
`-gen gas -arch 386`. Both runs had exact preprocessing parity and direct plus
prepared models for every input, with no bounded or incomplete analyses. GAS64
typed 887,220 of 890,828 complete-snapshot syntax ranges; GAS typed 888,505 of
892,111. All remaining ranges were explicitly invalid recovery, with no
missing syntax or type mismatches. GAS64 compared 65,816 direct expressions
and 29,279 directive facts; GAS compared 66,056 and 29,281. Each supplemented
1,011 of 1,045 trace omissions, retained the same 34 repeated-include
ambiguities, and reported no missing or mistyped sidecar answers. These `-pp`
semantic checks do not exercise GAS/GAS64 assembly emission, assemblers,
objects, or linking.

Initial per-worker supervisor benchmark, 2026-10-09: analysis, workspace, and
syntax-diagnostic compiler launches were moved to helper processes that own
child streams, cancellation, timeouts, process groups, and reaping. In the first
177-module no-match profile, each worker had its own helper: cold indexing took
275.5 seconds with a 20.0 ms maximum host timer gap; warm indexing took 243 ms
with a 7.0 ms gap. The full extension unit suite passes 475/475, smoke/grammar
pass 7/7 and 2/2, and the VSIX passes 38 installed-editor checks on VS Code
1.141.0 and 1.85.0.

Combined aggregate and structural recovery follow-up, 2026-10-09: a new
unsaved-buffer regression combines a malformed UDT field initializer with an
unterminated namespace containing a procedure. The compiler reaches EOF and
marks the namespace, aggregate, and affected members as recovered/invalid. A
later expression using that aggregate retains its selected `Double` type as
provisional, while an earlier unrelated module expression remains
authoritative; the saved source is unchanged. The focused native recovery test
passes 1/1. This adds one declaration/member plus structural-scope pairing;
other parser-repair combinations remain open.

Shared supervisor benchmark refresh, 2026-10-09: the workspace benchmark now
uses the production topology: one helper shared by the foreground probe and
both workspace workers. The 177-module, two-worker no-match cold pass took
278.6 seconds with a 13.7 ms maximum host timer gap; the warm pass took 241.9
ms with a 7.1 ms gap. The single supervisor `fork()` call took 4.9 ms. The
helper handled 354 compiler launches; its spawn calls peaked at 7.1 ms and
totaled 795 ms without blocking the editor host. Foreground p95 was 1.97 ms for
semantic tokens and 1.44 ms for hover, with maxima of 4.30 ms and 1.70 ms.
There were no foreground failures. These measurements show that repeated
compiler-spawn stalls are removed from the host; cold indexing still takes over
four minutes, and a one-time startup plus benchmark-specific latency profile is
not a general responsiveness guarantee.

Latest FBC semantic-sidecar refresh, 2026-10-09: rebuilt the optional editor
bridge from the current `/home/jkfirth/fbc` working tree (HEAD `0220dfb` plus
its local semantic-model changes) and moved `dist/fbc-editor-current` to that
build. The schema remains 27. The producer now binds the written UDT or typedef
in `Return TypeName()` to its exact compiler symbol, while retaining the
selected constructor as a separate implicit relationship; rejected QB intrinsic
`#define` attempts retain `definition-rejected` with no fabricated macro ID.
New extension coverage verifies the type/typedef identity crosswalk through
project-edit bindings. The two focused upstream producer tests pass 2/2, the
native extension sidecar suite passes 110/110, and `npm run test:unit` passes
480/480 with no skips while rebuilding from the same source. No schema migration
or fallback name-resolution change was needed.

Workspace dependency-hint benchmark, 2026-10-09: the benchmark now pre-scans
literal include directives with explicit per-file, total-byte, per-module path,
and total-hint caps. If a module's graph cannot be completely scanned, it gets
no hints; compiler-reported dependencies remain authoritative and still force
a retry when a hint is missing. A 177-module, two-worker no-match run scanned
405 files / 8.7 MiB in 124 ms, retained 3,524 paths / 175 KiB, skipped no
modules, and used 177 compiler executions instead of the prior 354. Cold
indexing fell from 278.6 to 196.6 seconds; the warm pass took 232 ms. Foreground
token and hover p95 were 1.46 ms and 1.49 ms with no failures. The maximum host
timer gap was 36.7 ms, above the earlier 13.7 ms observation, and the host
process was observed near 1.4 GiB RSS during the cold pass; neither run sets a
general latency or memory guarantee. The focused hint-scanner test passes 1/1,
and the audit-options, model-worker, and workspace-index suites pass 59/59.

Shared-header constructor typedef rename, 2026-10-09: expanded the project
transaction fixture so one shared header declares a UDT and typedef, and both
modules return both names through constructor syntax. The UDT rename and alias
rename each produce complete previews across both modules, retain the selected
constructor relationships, and leave all source files unchanged. The complete
project-refactor test file passes 72/72 when its optional runtime check is
excluded; that check passes separately with the available 1.20.4 compiler, for
73/73 total.

Latest-source selected binding/call corpus replay, 2026-10-09: the full 14-
category x86-64 audit passed all 1,705 upstream files against the bridge built
from the current FBC working tree. All files matched baseline preprocessing
and produced direct plus prepared models; none was bounded or incomplete. Of
408,431 complete-snapshot syntax ranges, 406,811 had ordinary types and all
1,620 remaining ranges were explicitly invalid recovery. The binding sidecar
retained 83,230 physical bindings and 1,768 compiler-selected calls across all
nine supported kinds. There were no invalid/nonphysical records, missing
sources, out-of-bounds spans, invalid signatures, or audit failures. This
reconfirms the selected x86-64 binding/call corpus after the new constructor
type-token bindings; unselected categories and broader language/target/backend
matrices remain open.

Current-source RISC-V32 full expression-sidecar replay, 2026-10-09: the full
2,454-file default-FB corpus passed under `-arch riscv32` against the rebuilt
bridge, with exact baseline preprocessing parity and direct plus prepared
models for every file. There were no bounded/incomplete analyses or audit
failures; the full-default-FB quirk-family coverage gate also passed. Of
863,638 complete-snapshot syntax ranges, 860,032 had ordinary types and all
3,606 remaining ranges were explicitly invalid recovery. The sidecar compared
94,495 facts (65,221 physical expressions and 29,274 directive expressions),
supplemented 995 of 1,029 trace omissions, and conservatively withheld 34
repeated-context ambiguities. Missing, mistyped, and status-mismatched answers
were zero. The run took 1,053 seconds. This extends full-corpus target-width
expression evidence to 32-bit RISC-V; assembly generation, linking, execution,
and other target/dialect/backend combinations remain separate requirements.

Current-source MIPS32 full expression-sidecar replay, 2026-10-09: the complete
2,454-file default-FB corpus passed under `-arch mips32` with baseline
preprocessing parity and direct/prepared models for every file. No analyses
were bounded or incomplete, no audit failed, and the full-default-FB
quirk-family gate passed. Of 864,055 complete-snapshot syntax ranges, 860,449
had ordinary types and all 3,606 remaining ranges were invalid recovery. The
sidecar compared 94,491 facts (65,217 physical expressions and 29,274 directive
expressions), supplemented 995 of 1,029 trace omissions, and withheld 34
repeated-context ambiguities. Missing, mistyped, and status-mismatched answers
were zero. The run took 1,069 seconds. This adds full-corpus 32-bit MIPS
expression evidence alongside the RISC-V32 replay; backend code generation,
linking, execution, and other language/target combinations remain open.

Current-source MIPS32LE full expression-sidecar replay, 2026-10-09: the full
2,454-file default-FB corpus passed under `-arch mips32el` with preprocessing
parity and direct/prepared models for every file. No analysis was bounded or
incomplete, the audit had no failures, and the default-FB quirk-family gate
passed. Of 863,640 complete-snapshot syntax ranges, 860,034 had ordinary types;
all 3,606 others were explicitly invalid recovery. The sidecar compared 94,495
facts (65,221 physical expressions and 29,274 directive expressions),
supplemented 995 of 1,029 trace omissions, and withheld 34 repeated-context
ambiguities. Missing, mistyped, and status-mismatched answers were zero. The
run took 1,078 seconds. This completes full-corpus expression-sidecar checks
for both MIPS32 byte orders; generated assembly, linking, and runtime remain
unverified.

Current-source ARMv7 full expression-sidecar replay, 2026-10-09: all 2,454
default-FB upstream files passed under `-arch armv7-a` with baseline
preprocessing parity and direct/prepared models. There were no bounded or
incomplete analyses, no audit failures, and the full-default-FB quirk-family
gate passed. Of 862,930 complete-snapshot syntax ranges, 859,324 had ordinary
types and all 3,606 remaining ranges were explicitly invalid recovery. The
sidecar compared 94,384 facts (65,109 physical expressions and 29,275 directive
expressions), supplemented 992 of 1,026 trace omissions, and withheld 34
repeated-context ambiguities. Missing, mistyped, and status-mismatched answers
were zero. The run took 1,069 seconds. This adds a full 32-bit ARM expression
profile; object generation, linking, execution, and other open target profiles
remain unverified.

Current-source MIPS64LE full expression-sidecar replay, 2026-10-09: the complete
2,454-file default-FB corpus passed under `-arch mips64el` with baseline
preprocessing parity and direct/prepared models. There were no bounded or
incomplete analyses, no audit failures, and the full-default-FB quirk-family
gate passed. Of 863,552 complete-snapshot syntax ranges, 859,944 had ordinary
types and all 3,608 remaining ranges were explicitly invalid recovery. The
sidecar compared 94,506 facts (65,231 physical expressions and 29,275 directive
expressions), supplemented 995 of 1,029 trace omissions, and withheld 34
repeated-context ambiguities. Missing, mistyped, and status-mismatched answers
were zero. The run took 1,091 seconds. This adds full-corpus little-endian
MIPS64 expression evidence; generated-code execution and remaining targets and
dialects are still open.

Current-source PowerPC32 full expression-sidecar replay, 2026-10-09: all
2,454 default-FB corpus files passed under `-arch powerpc` with baseline
preprocessing parity and direct/prepared models. There were no bounded or
incomplete analyses, no audit failures, and the full-default-FB quirk-family
gate passed. Of 863,964 complete-snapshot syntax ranges, 860,358 had ordinary
types and all 3,606 remaining ranges were explicitly invalid recovery. The
sidecar compared 94,474 facts (65,199 physical expressions and 29,275 directive
expressions), supplemented 995 of 1,029 trace omissions, and withheld 34
repeated-context ambiguities. Missing, mistyped, and status-mismatched answers
were zero. The run took 1,050 seconds. This adds a full 32-bit PowerPC
expression profile; object generation, linking, execution, and remaining
dialects and architectures are still open.

Current-source ARMv7-FP full expression-sidecar replay, 2026-10-09: the full
2,454-file default-FB corpus passed under `-arch armv7-a+fp`, with exact
baseline preprocessing parity and direct/prepared models. No analyses were
bounded or incomplete, no audit failed, and the default-FB quirk-family gate
passed. Of 862,930 complete-snapshot syntax ranges, 859,324 had ordinary types
and all 3,606 remaining ranges were explicitly invalid recovery. The sidecar
compared 94,384 facts (65,109 physical expressions and 29,275 directive
expressions), supplemented 992 of 1,026 trace omissions, and withheld 34
repeated-context ambiguities. Missing, mistyped, and status-mismatched answers
were zero. The run took 1,046 seconds. This verifies the hard-float ARMv7
semantic profile; object generation, linking, execution, other language modes,
and untested option combinations remain open.

Workspace symbol cache compaction, 2026-10-09: replaced one 12-element
JavaScript array per cached symbol with a flat `Int32Array` while retaining the
same interned strings, order, keys, and public symbol objects. The full unit
suite passes 481/481, smoke and grammar pass 7/7 and 2/2, and the packaged
VSIX passes 41 checks on VS Code 1.141.0 and 1.85.0. The 177-module, two-worker
no-match benchmark retained all 748,409 declarations and all 177 summaries;
the repeated pass hit all caches. Cold indexing took 198.6 seconds and the
warm pass 230 ms. Foreground p95 was 1.47 ms for tokens and 1.29 ms for hover,
with no failures; the maximum host timer gap was 45.9 ms, worse than the prior
36.7 ms measurement. One sampled host RSS value was about 1.28 GiB versus the
prior run's roughly 1.4 GiB observation, but the serialized cache charge rose
from 193 MB to 206 MB and RSS peak sampling was not instrumented. The memory
benefit is therefore provisional, and the long-tail responsiveness issue
remains open. The packaged unsaved-buffer integration now waits for both
edited-document change events before explicit analysis, preventing the test
from racing VS Code's document-change notifications.

Workspace symbol projection allocation follow-up, 2026-10-09: workspace
indexing now asks the compiler-document-symbol projection for workspace-visible
records only, skipping document Outline hierarchy maps and physical range
projection that the workspace cache does not consume. A native parity test
compares its symbol fields and locations against filtered document symbols.
The affected worker and analysis-service suites pass 61/61; packaged VS Code
integration passes 41/41 on both 1.141.0 and 1.85.0. In the same 177-module
two-worker no-match benchmark, the index again retained all 748,409 declarations
and warmed all 177 cache entries, but cold indexing took 215.6 seconds, the
maximum host timer gap reached 78.4 ms, and foreground p95 rose to 3.00 ms for
tokens and 3.81 ms for hover. No foreground request failed. Sampled RSS reached
about 1.46 GiB near process shutdown. This run does not demonstrate a memory or
latency improvement; the new projection is semantically equivalent, but more
heap/GC and idle-host attribution is needed before treating it as a successful
responsiveness optimization.

Workspace symbol streaming packer follow-up, 2026-10-09: workspace-visible
records now flow directly from the document-symbol projector into 8,192-record
typed-array chunks, avoiding a complete intermediate JavaScript record array.
The 177-module benchmark retained all 748,409 declarations; the repeated pass
hit all 177 cached module records. Cold indexing took 190.7 seconds and the
warm pass 223 ms. Foreground p95 was 3.42 ms for semantic tokens and 3.38 ms
for hover, with no failed requests. The largest host timer gap was 85.1 ms.
The serialized cache charge was 206.5 MB cold and 207.6 MB after the repeated
pass. One process RSS sample during the cold pass was about 1.39 GB; peak RSS
is not instrumented. Cold time improved versus the preceding 215.6-second run,
but the timer gap remained high and the sample does not establish a consistent
memory or responsiveness improvement.

Workspace timer-pause attribution instrumentation, 2026-10-09: the workspace
benchmark now reports Node process user/system CPU time, event-loop active/idle
time, voluntary/involuntary context-switch deltas, and process peak RSS beside
the existing host timer gap and GC data. The benchmark-options suite passes
18/18, including a measurement-shape check. A lightweight 2-second idle-loop
probe while a separate CPU-heavy editor workload was active observed a 6.5 ms
maximum timer gap and 1.8% event-loop utilization; that probe does not reproduce
workspace indexing.

Full 177-module no-match comparison with the new counters, 2026-10-09: the
two-worker cold pass took 204.1 seconds, retained 773,853 declarations, and
returned no matches. Foreground p95 was 1.49 ms for semantic tokens and 1.59 ms
for hover; the maximum host timer gap was 25.4 ms. Peak process RSS was
1,508,160 KiB. At symbol projection, the largest per-worker heap sample was
366.6 MB, with 40.0 MB external and 20.4 MB ArrayBuffer memory. Main-thread
event-loop utilization was 1.50%, while measured merge, message handling,
process output, and GC pauses were all far below the host timer maximum.

The one-worker repeat took 324.6 seconds cold and 379 ms warm. Peak RSS fell to
1,155,108 KiB and the largest host timer gap to 15.6 ms; foreground p95 stayed
similar at 1.45 ms for tokens and 1.33 ms for hover. The single workspace
worker's projection heap reached 381.3 MB, with 75.1 MB external and 57.1 MB
ArrayBuffer memory. Main-thread event-loop utilization remained low at 1.35%.
These two runs quantify the configured tradeoff: one worker reduced process
peak RSS by about 23% and the maximum timer gap by about 39%, but increased
cold indexing time by about 59%. The main-thread JS phases still do not account
for the full timer gap; no responsiveness improvement is claimed. The
benchmark-only `profileWorkspaceMemory` flag now samples per-worker heap,
external, and ArrayBuffer use at symbol projection and after search; aggregation
is covered by focused tests, and normal editor requests do not take these
samples. The `index.workspaceConcurrency` setting description now summarizes
the measured speed/memory tradeoff; its two-worker default remains unchanged.

Current FBC semantic-source sync, 2026-10-09: upstream `fbc` is now at
`6fa523532557a5a0f94784a588d7e4e06eba28dc`. The compiler bridge was rebuilt
from that checkout. Its latest semantic changes bind the written UDT or
typedef token in RETURN constructor syntax and avoid assigning accepted macro
identity to rejected QB intrinsic definitions. The two corresponding upstream
sidecar tests pass against the rebuilt bridge. Regenerating the offline
language reference advanced its source revision metadata to the new FBC HEAD;
the complete unit suite then passed 481/481, smoke 7/7, grammar 2/2, and the
packaged VSIX passed 41/41 checks on both VS Code 1.141.0 and 1.85.0. The
bridge build still reports an implicit-conversion warning in
`compiler/ast/nodes/ast-node-assign.bas:286`.

Latest semantic contract integration, 2026-10-09: the current FBC checkout is
`87d3d7a2cce3cfdd47da926ad7cf067845f3e761`, with schema 27 unchanged. The
bridge now builds from the refactored parser signatures. Expression-only
models retain typed array-field prefixes without advertising full array-storage
metadata; the full model's `array-storage-root` AST trees are accepted only
when their capability, selection/input relations, statement ownership and
unphased module tree agree. The reader also accepts the current control-flow
`SOP` vocabulary and physical statement/construct locations that precede their
closing records, then verifies closure after reading the complete stream.

The model now preserves generic H relationships for editor consumers and joins
the latest full-model ABI-policy K/H receipts onto the selected procedure's
compiler facts. The regression checks written calling conventions and managed
STRING aliases/pointers, and confirms native source-call bindings survive that
same full-model path. Expression-only output now includes the typed field-name
prefix required to answer the corresponding compiler expression range.

Against this FBC checkout, the upstream GCC semantic-sidecar suite passes
224/224 tests (four platform/toolchain-specific skips). The extension unit
suite passes 483/483, smoke 7/7, grammar 2/2, and the packaged VSIX passes
41/41 checks on VS Code 1.141.0 and 1.85.0. The generated 604-entry offline
reference is pinned to this exact FBC HEAD. At this checkpoint, the FBLite
extended-syntax full-corpus audit still needed a fresh run; its later
completion is recorded below.

FBC semantic-source and corpus refresh, 2026-10-09: upstream `fbc` is now at
`4495fa48aba2fdc2cb1ccde0400404ec5733bd88`, and the checked-out source tree is
clean. The semantic-sidecar change landed in `efbcfc43`: full models can retain
the invoking macro name for a macro-expanded include as noneditable provenance
on `INC`, while keeping it distinct from a written filename range or the
included file's `SRC` range. Expression-only models omit this anchor because
they do not retain the macro invocation graph. The schema remains 27. The
extension decoder keeps this `origin` separate from the editable `directive`;
the focused upstream and extension regressions both pass against the current
bridge, including the expected physical-false range on line 2, columns 9-20.
The offline language reference records the exact current FBC revision.

The FBLite extended-syntax semantic corpus replay completed at `efbcfc43`:
2,456 files, 2,456 baseline-parity results and 2,456 models, with no bounded or
incomplete analyses and no failures. It compared 31,787 ordinary/physical
expression facts and 13,486 directive expressions. There were no missing,
ambiguous, overridden, mistyped, or status-mismatched answers; all 845 trace
omissions were supplemented. Of 326,717 syntax ranges, 313,570 had ordinary
types and the remaining 13,147 were all explicitly invalid recovery ranges.
Recovery checking covered 1,257 facts: all 1,246 safe facts were available and
correct, with 11 error-line facts and no retractions. The run prepared 89,476
tokens and took about 879 seconds. This resolves the preceding note that the
FBLite extended-syntax replay still needed to be run.

At this checkpoint, the only FBC source delta after `efbcfc43` was the
driver-side Clang/MinGW x86 runtime selection change in
`src/compiler/driver/fbc-tools.bas`. Later semantic-model changes and their
extension integration are recorded below.

Current-source FBLite `-exx` x86-32 full-corpus replay, 2026-10-09: all 2,456
upstream files matched baseline preprocessing and produced direct and prepared
models under `-lang fblite -exx -arch 386`. No analysis was bounded or
incomplete, and the audit reported no failures. Of 328,442 complete-snapshot
syntax ranges, 315,284 had ordinary types; the other 13,158 were all
explicitly invalid recovery, with no missing syntax, provisional gaps, or type
mismatches. The sidecar compared 31,824 ordinary/physical facts and 13,403
directive expressions. All 845 trace omissions were supplemented; missing,
ambiguous, overridden, mistyped, and status-mismatched answers were zero.
Recovery checking covered 1,257 facts: all 1,246 safe facts were available and
correct, 11 were error-line facts, and none were retracted. The run prepared
89,793 semantic-token results and took about 901 seconds. This replay used the
bridge and FBC `4495fa48`; the FBLite `-exx` x86-64 result above was run at
`efbcfc43`.

FBC header-policy and namespace-input integration, 2026-10-09: upstream `fbc`
advanced through `87991542b2678f8f83b54d62e7cf31ffe6bb6255` to `53ea48b4bba9`
with schema 27 unchanged. The full model now reports accepted per-source `#pragma once`,
`#inclib`, and `#libpath` inputs; each accepted USING operation's actual
namespace recipient; and parser-confirmed named versus anonymous namespace
declarations. These distinguish accepted directives and grammar branches from
source-text guesses, including macro-generated names and imports inside
procedures. The compact expression model marks the related capabilities
unavailable and omits those full-model facts.

The extension reader now validates the new property groups against their
capabilities, source occurrence/module ownership, accepted statement operations,
conditional branches, and namespace construct graph. It requires complete
coverage when the producer advertises a complete capability, and exposes the
validated facts on `analysis` and `CompilerSemanticModel`. Project rename now
includes header policy, import recipient, and namespace declaration facts in
its before/after compiler signature, so an edit is withheld if those compiler
observations change. A compiler-backed regression verifies nested string
escaping, anonymous namespace status, compact-mode behavior, corrupt policy
counts, invalid namespace flags, unknown import recipients, and missing policy
coverage. A project regression confirms both that a valid type rename still
produces a preview and that a changed compiler-selected USING recipient
invalidates it.

The extension bridge's copied compiler sources match the current FBC compiler
tree; it was built before the latest test-harness-only change. The offline
reference is pinned to the exact current FBC HEAD. The upstream sidecar suite
passed 226 tests with three platform/toolchain-specific skips at `87991542`; at
the latest HEAD, the affected MSYS/Cygwin path test and the two new semantic
input tests pass 3/3. The extension semantic-sidecar suite passes 114/114 and
the project-refactoring suite passes 74/74.
While integrating the richer full-model reader, a valid `-1` compiler symbol
length on forward typedef/pointer records surfaced; both readers now preserve
the signed compiler value, with a schema regression. Current-source FBLite
`-exx` AArch64, x86-32, and x86-64 replays are recorded below. Broader
dialect, backend, target, and user-project coverage remains open.

Current-source FBLite `-exx` AArch64 full-corpus replay, 2026-10-09: all 2,456
upstream files matched baseline preprocessing and produced direct and prepared
models under `-lang fblite -exx -arch aarch64`. There were no bounded or
incomplete analyses and no audit failures. Of 325,507 complete-snapshot syntax
ranges, 312,360 had ordinary types; all 13,147 remaining ranges were explicitly
invalid recovery, with no missing syntax or type mismatches. The sidecar
compared 31,406 ordinary/physical expressions and 13,484 directive expressions;
all 826 trace omissions were supplemented and missing/mistyped answers were
zero. The replay prepared 89,046 semantic-token results and took about 902
seconds. This is current-FBC coverage of the new full-model policy validation
on AArch64; the refreshed x86-32 result follows.

Current-source FBLite `-exx` x86-32 full-corpus replay, 2026-10-09: all 2,456
upstream files matched baseline preprocessing and produced direct and prepared
models under `-lang fblite -exx -arch 386`. No analysis was bounded or
incomplete, and the audit reported no failures. Of 328,442 complete-snapshot
syntax ranges, 315,284 had ordinary types; all 13,158 remaining ranges were
explicitly invalid recovery, with no missing syntax or type mismatches. The
sidecar compared 31,824 ordinary/physical expressions and 13,403 directive
expressions. All 845 trace omissions were supplemented; missing, ambiguous,
overridden, mistyped, and status-mismatched answers were zero. Recovery covered
1,257 facts: all 1,246 safe facts were available and correct, with 11 error-line
facts and no retractions. The run prepared 89,793 semantic-token results and
took about 883 seconds. This current-source replay exercises the new full-model
policy validation on 32-bit x86; the current-source x86-64 result follows.

Current-source FBLite `-exx` x86-64 full-corpus replay, 2026-10-09: all 2,456
upstream files matched baseline preprocessing and produced direct and prepared
models under `-lang fblite -exx -arch x86_64`. There were no bounded or
incomplete analyses and no audit failures. Of 326,717 complete-snapshot syntax
ranges, 313,570 had ordinary types; all 13,147 remaining ranges were explicitly
invalid recovery, with no missing syntax or type mismatches. The sidecar
compared 31,787 ordinary/physical expressions and 13,486 directive expressions;
all 845 trace omissions were supplemented, with no missing, ambiguous,
overridden, mistyped, or status-mismatched answers. The run prepared 89,476
semantic-token results and took about 877 seconds. Together with the current
x86-32 and AArch64 replays above, this completes the current-FBC FBLite `-exx`
full-corpus target matrix for these three principal ABIs.

Current-source deprecated-mode `-exx` x86-32 full-corpus replay, 2026-10-09:
all 2,456 upstream files matched baseline preprocessing and produced direct
and prepared models under `-lang deprecated -exx -arch 386`. No analyses were
bounded or incomplete, and the audit had no failures. Of 846,160
complete-snapshot syntax ranges, 829,597 had ordinary types; the remaining
16,563 were all invalid recovery, with no missing syntax or type mismatches.
The sidecar compared 46,169 ordinary/physical expressions and 17,858
directive expressions; all 998 trace omissions were supplemented and missing,
ambiguous, overridden, mistyped, and status-mismatched answers were zero. The
run took about 1,059 seconds. Current-source AArch64 follows.

Current-source deprecated-mode `-exx` AArch64 full-corpus replay, 2026-10-09:
all 2,456 files matched preprocessing and produced direct/prepared models with
no bounded or incomplete analyses and no failures. Of 816,944 syntax ranges,
800,392 had ordinary types; all 16,552 remaining ranges were invalid recovery,
with no missing syntax or type mismatches. The sidecar compared 45,436
ordinary/physical facts plus 17,938 directive expressions, supplemented all
979 trace omissions, and reported zero missing or mistyped answers. At this
checkpoint the current x86-64 replay had not yet run; its result follows.

Current-source deprecated-mode `-exx` x86-64 full-corpus replay, 2026-10-09:
the 2,456-file sweep produced 2,452 prepared models before four files exceeded
the default 10-second per-file analysis timeout while other compiler workloads
were active. All 2,452 processed files matched preprocessing; there were no
bounded or incomplete models, missing syntax/type coverage, or type mismatches.
Of 844,802 syntax ranges, 828,250 had ordinary types and all 16,552 remaining
ranges were explicitly invalid recovery. The sidecar compared 46,097
ordinary/physical expressions plus 17,942 directive expressions; it
supplemented all 998 trace omissions and reported zero missing, ambiguous,
overridden, mistyped, or status-mismatched answers. The only four sweep
failures were timeouts in `compound/select_const2.bas`,
`expressions/compare-float-nan.bas`, `expressions/iif.bas`, and
`structs/temp-var-dtors.bas`.

Retry of the three affected categories with a 60-second per-file timeout,
2026-10-09: all 378 files in `compound`, `expressions`, and `structs` matched
preprocessing and produced prepared models, with no bounded/incomplete
analyses or audit failures. Of 244,653 syntax ranges, 238,993 had ordinary
types and the remaining 5,660 were explicitly invalid recovery. The sidecar
compared 4,796 ordinary/physical expressions plus 2,390 directive expressions;
all 115 trace omissions were supplemented with zero missing or mistyped
answers. The four timed-out inputs therefore pass when given the longer limit.
This covers all 2,456 corpus files across the full sweep and targeted retry; a
single clean all-at-once x86-64 replay at the longer timeout has not yet been
recorded.

Current-source parser-route inventory refresh, 2026-10-09: the expression and
call route audits both pass against the current FBC checkout with no unowned,
duplicate, stale, or drifting routes. All nine emitted implicit-call kinds
remain covered by the bridge vocabulary. The source-backed language coverage
audit also passes for FreeBASIC 1.20.4.

Current-source hardening checks, 2026-10-09: the upstream FBC semantic-sidecar
suite ran 226 tests with three Windows/toolchain-specific skips and no
failures. The extension semantic-sidecar and project-refactoring suites pass
114/114 and 76/76; smoke and grammar pass 7/7 and 2/2. The rebuilt Linux VSIX
passes all 41 installed-editor checks on both VS Code 1.141.0 and 1.85.0,
including native Outline, workspace symbols, unsaved headers, and project
rename. The generated 604-entry offline reference is pinned to FBC
`53ea48b4bba9`.

Scope-exit destructor refactoring follow-up, 2026-10-09: the native sidecar
fixture now verifies exact physical cleanup anchors for GOTO, EXIT SUB, RETURN,
CONTINUE FOR, EXIT FOR, CONTINUE DO, EXIT DO, CONTINUE WHILE, and EXIT WHILE.
The project rename fixture mutates all compiler-selected cleanup signatures
during the validation pass and requires the type rename to be refused; the
unmodified pass still produces a preview without writing source. Both focused
compiler-backed tests pass. This closes the currently represented loop and
procedure scope-exit keyword forms, not all possible compiler-generated
cleanup sites.

Macro-generated namespace refactoring follow-up, 2026-10-09: project rename now
has a shared-header case where `#macro` token-pastes a namespace name used by
two configured modules. The compiler's namespace-declaration input confirms
that the generated opening was named, and the validated preview edits the one
physical macro argument plus both modules' USING and qualified references.
Transaction signatures preserve the selected import recipient; all five edits
are preview-only. The focused compiler-backed test passes 1/1. Other generated
namespace shapes and ambiguous callback-origin references remain open/fail-
closed.

Shared physical label refactoring follow-up, 2026-10-09: project rename now
joins one named label from a header included inside procedures in two modules.
The preview edits the header declaration and compiler-bound GOTO, GOSUB,
RETURN, `ON GOTO`, `ON GOSUB`, and single-line IF branch references exactly
once, then recompiles both modules; saved source remains unchanged. The focused
compiler-backed regression passes 1/1. This covers shared physical label
identity across translation units, not every legacy or macro-generated label
form.

Repeated physical label-header follow-up, 2026-10-09: the same physical label
header included in two different procedure scopes of one module now has a
compiler-backed rename regression. Renaming from the first scope produces one
header edit plus the GOTO, GOSUB, and RETURN references from both expansions;
the transaction validates the renamed compiler model and leaves both files
unchanged. The focused test passes 1/1. The full-suite rerun was pending when
this case was added; the current full-suite result is recorded below.

Unsaved namespace-header recovery follow-up, 2026-10-09: an overlay header now
combines an accepted namespace import with a malformed declaration and a
closed namespace. FBC reaches EOF with a parser error but does not publish a
complete full semantic model, so the extension withholds namespace-recipient
receipts instead of exposing partial policy facts. Independent `Double`
expressions before and after the included header remain authoritative, and both
saved files remain unchanged. The focused compiler-backed recovery regression
passes 1/1; other namespace/parser-repair combinations remain open.

Shared DATA/RESTORE label refactoring follow-up, 2026-10-09: a native
project-rename case now joins one DATA label in a shared header to named
RESTORE references from two modules. The preview contains exactly one header
edit and both reference edits, and leaves source files unchanged. The focused
compiler-backed test passes 1/1.

Namespace external-alias refactoring follow-up, 2026-10-09: a compiler-backed
rename now edits the source namespace name, USING import, and qualified member
reference while preserving the written external `Alias` string. The preview
leaves the saved source untouched; the focused test passes 1/1.

Conditional macro namespace refactoring follow-up, 2026-10-09: two build
contexts now select different `#macro` definitions that token-paste the same
namespace name. Project rename changes the shared physical argument and the
USING/member references once; compiler namespace-declaration receipts confirm
the name is accepted in both contexts, and the preview leaves the source
unchanged. The focused compiler-backed test passes 1/1.

Conditional generated-name refusal follow-up, 2026-10-09: a companion rename
case uses the same physical macro argument to form different namespace suffixes
in alternate build contexts. Because one requested replacement cannot preserve
both selected names, the project transaction refuses the rename and leaves the
source unchanged. The focused compiler-backed test passes 1/1.

Project-suite checkpoint delta, 2026-10-09: after the 76-case full project
suite passed, five cases were added: repeated physical header-label expansions,
shared DATA/RESTORE references, a namespace external alias, conditional macro
namespace renaming, and refusal when alternate contexts generate incompatible
names. Their focused compiler-backed tests each pass 1/1. The current project
test file has 81 top-level cases; the full rerun was pending at that checkpoint.

Current-source project-suite refresh, 2026-10-09: all 81 project-refactoring
tests now pass with `FBC_EDITOR_EXECUTABLE` set to the bridge built from FBC
`53ea48b4bba9` and `FBC_EXECUTABLE` set to the current `1.20.4-3` compiler.
There were no skips or failures. This reruns the five new cases together with
the full existing rename suite, including compiler-executed address and virtual
dispatch validation.

Latest-FBC sidecar-suite refresh, 2026-10-09: the documented upstream command
`python3 build_scripts/test-compiler-semantic-model.py --fbc ./bin/fbc` passes
all 226 semantic-sidecar tests at FBC HEAD `53ea48b4bba9`. The three skips are
the Windows-native C/Clang and linker matrix cases; there are no failures. This
reruns the suite after the MSYS/Cygwin native-path reader changes in that HEAD.

Unsaved-buffer recovery-suite refresh, 2026-10-09: all three native recovery
tests pass with the current `53ea48b4bba9` bridge and no skips, including the
malformed unsaved-header case that withholds incomplete namespace inputs while
preserving independent expression types.

Current bridge expression-query spot checks, 2026-10-09: prepared-model
initializer typing and expression queries when the compiler trace exceeds its
normal analysis bound both pass against FBC `53ea48b4bba9`. These are focused
worker-path regressions and supplement, but do not replace, the full dialect
and target corpus matrix.

Current bridge unsaved-worker spot checks, 2026-10-09: three native worker
regressions pass with no skips: broken-buffer recovery keeps later expressions
typed and the host responsive; a dirty included header remains unsaved while
its types are used after a parser error; and a previously missing include is
reanalyzed when it appears without changing the root request text.

ELSEIF recovery follow-up, 2026-10-09: a malformed `ElseIf value +` inside a
function now has a regression with accepted branch bodies, `Else`, `End If`, a
procedure return, and a following module expression. The damaged condition is
withheld; independent `Double` expressions on both sides and in later accepted
branches remain authoritative in the trace model. The trace-free recovery
sidecar withholds the same damaged condition and marks its retained later facts
provisional. This test and the existing SELECT CASE recovery test pass 2/2
against FBC `53ea48b4bba9`; additional parser-repair combinations remain open.

SELECT CASE refactoring validation follow-up, 2026-10-09: project transaction
signatures now retain the compiler's SELECT CASE capabilities and full
`select-case-*` property receipts. A native regression changes a compiler-
selected branch disposition only during post-rename validation and confirms
that the transaction refuses the edit. The unmodified type rename still
returns the expected preview when post-rename property records arrive in a
different order, without writing source. At this checkpoint the project suite
passed 82/82 with no skips against FBC `53ea48b4bba9` and the matching 1.20.4-3
compiler. This validates represented CASE lowering facts during refactoring;
other semantic-property families and unrepresented transformations remain open.

Procedure ABI refactoring validation follow-up, 2026-10-09: project
transactions now compare compiler ABI-policy receipts through their accepted
statement/source-context anchors, not invocation-local detail IDs. A fault
injection that changes the managed-STRING ABI bit is rejected, while ordinary
property getter/setter and virtual-family renames remain accepted. The
procedure ABI receipt integration test passes, and the full native project
suite passes 83/83 with no skips against the current bridge/compiler pair.
Other semantic-property families and unrepresented transformations remain
open.

Procedure declaration typing validation follow-up, 2026-10-09: compiler
procedure-kind, prototype/definition, result-form, export, and written
visibility observations now join the project transaction through accepted
statement/source-context anchors. Generated statements do not use unstable
expanded columns as identity. A fault-injected header-role change is refused;
the macro-generated procedure, property accessor, conditional virtual-family,
and other full-suite renames remain accepted. The FBC ABI-receipt integration
check passes 1/1 and the full project suite passes 83/83 with no skips. Formal
parameter spelling facts were still open at this checkpoint; see the follow-up
below. Other semantic-property families remain open.

Procedure-policy decoder refresh, 2026-10-09: full semantic-model analysis now
exposes source-anchored procedure typing and written-visibility inputs beside
the normalized ABI policy receipts. Project rename signatures compare these
facts without relying on sidecar-local IDs or unstable generated columns. The
fault-injection case flips both an ABI policy bit and a prototype/definition
role in separate validation passes; each mutation is refused, while the intact
rename remains a preview. The generated token-pasted procedure rename remains
accepted. The complete native project suite passes 83/83, and the focused FBC
ABI receipt integration test passes 1/1. Formal parameter type spelling was
still open at this checkpoint; the follow-up below covers the represented
forms. Other semantic-property families remain open.

Formal parameter type-form validation follow-up, 2026-10-09: full semantic
analysis now carries `formal-written-type` receipts into project transaction
signatures, joined to compiler declaration bindings with their physical status
and source locations. A fault-injected change from `As` to suffix form is
refused; unchanged refactors remain preview-only. The FBC ABI receipt test
passes 1/1, and the complete project suite passes 83/83 with no skips,
including parameter, property, and macro-generated procedure renames. More
complex unanchored formal/macro relationships and other semantic-property
families remain open.

Current-source QB/x86-64 `-exx` expression replay, 2026-10-09: all 2,456
upstream files at FBC HEAD `53ea48b4bba9` matched trace-disabled preprocessing
and produced direct plus prepared models under a 60-second per-file bound,
with no bounded/incomplete analyses or audit failures. Of
206,316 syntax ranges, 121,465 had ordinary compiler types; all 84,851
remaining ranges were explicitly invalid recovery, with no missing syntax or
type mismatches. The sidecar compared 3,111 semantic expression facts and
supplemented all 33 trace omissions; missing, ambiguous, overridden, mistyped,
and status-mismatched answers were zero. The replay took about 969 seconds.
This refreshes the QB x86-64 extended-syntax profile against the current
schema-27 bridge; current-source QB x86-32 and AArch64 `-exx` replays remain
open. FBC's branch label changed during the audit, but its HEAD and compiler
source remained unchanged; only build-log artifacts were dirty.

Current-source QB/x86-32 `-exx` expression replay, 2026-10-09: all 2,456
upstream files at FBC HEAD `53ea48b4bba9` matched trace-disabled preprocessing
and produced direct/prepared models under the 60-second per-file bound. There
were no bounded/incomplete analyses or audit failures. Of 206,940 syntax
ranges, 121,750 had ordinary compiler types and all 85,190 remaining ranges
were explicitly invalid recovery, with no missing syntax or type mismatches.
The sidecar compared 2,766 semantic expression facts and supplemented all 33
trace omissions; missing, ambiguous, overridden, mistyped, and status-mismatched
answers were zero. The run took about 934 seconds. This refreshes QB's 32-bit
x86 extended-syntax profile against the current bridge; the current-source
AArch64 `-exx` replay remains open.

Current-source QB/AArch64 `-exx` expression replay, 2026-10-09: all 2,456
upstream files at FBC HEAD `53ea48b4bba9` matched trace-disabled preprocessing
and produced direct/prepared models under the 60-second per-file bound. There
were no bounded/incomplete analyses or audit failures. Of 205,662 syntax
ranges, 121,070 had ordinary compiler types and all 84,592 remaining ranges
were explicitly invalid recovery, with no missing syntax or type mismatches.
The sidecar compared 3,219 semantic expression facts and supplemented all 33
trace omissions; missing, ambiguous, overridden, mistyped, and status-mismatched
answers were zero. The run took about 857 seconds. This refreshes QB's AArch64
extended-syntax profile against the current schema-27 bridge and completes the
current-source QB `-exx` matrix across x86-32, x86-64, and AArch64.

Aggregate-access refactoring validation follow-up, 2026-10-09: full-model
aggregate body, access-count, and section receipts now enter the project
transaction signature through their accepted statement/source-context anchors.
A type-rename fault injection changes a compiler-selected access section and
is refused; an unchanged rename remains a preview without writing source. The
full native project-refactoring suite passes 84/84 with no skips. Other
semantic-property families and unrepresented transformations remain open.

Current-source FBLite/Clang x86-64 `-exx` expression replay, 2026-10-09: all
2,456 upstream files at FBC HEAD `53ea48b4bba9` matched preprocessing and
produced direct plus prepared models under a 60-second per-file bound. There
were no bounded or incomplete analyses or audit failures. Of 326,717 syntax
ranges, 313,570 had ordinary compiler types and the remaining 13,147 were
explicitly invalid recovery; no syntax or type mismatches were found. The
sidecar compared 31,787 ordinary/physical expressions plus 13,486 directive
expressions, supplemented all 845 trace omissions, and reported zero missing,
ambiguous, overridden, mistyped, or status-mismatched answers. Recovery
checking retained all 1,246 safe facts as provisional, with no missing,
mistyped, or unsafe answers. The run took about 1,200 seconds. This closes the
current-source FBLite/Clang x86-64 extended-syntax profile. At this checkpoint
the x86-32 and AArch64 replays remained open; follow-up results are below.

Current-source FBLite/Clang x86-32 `-exx` expression replay, 2026-10-09: all
2,456 upstream files at FBC HEAD `53ea48b4bba9` matched preprocessing and
produced direct/prepared models under the 60-second per-file bound. There were
no bounded/incomplete analyses or audit failures. Of 327,265 syntax ranges,
314,111 had ordinary compiler types; the remaining 13,154 were explicitly
invalid recovery, with no missing syntax or type mismatches. The sidecar
compared 31,719 ordinary/physical expressions and 13,488 directive expressions;
all 845 trace omissions were supplemented with zero missing, mistyped,
ambiguous, overridden, or status-mismatched answers. The run took about 1,085
seconds. At this checkpoint the AArch64 replay remained open; its result
follows.

Current-source FBLite/Clang AArch64 `-exx` expression replay, 2026-10-09: all
2,456 upstream files at FBC HEAD `53ea48b4bba9` matched preprocessing and
produced direct plus prepared models under a 60-second per-file bound. There
were no bounded or incomplete analyses or audit failures. Of 325,507 syntax
ranges, 312,360 had ordinary compiler types; all 13,147 remaining ranges were
explicitly invalid recovery, with no missing syntax or type mismatches. The
sidecar compared 31,406 ordinary/physical expressions and 13,484 directive
expressions, supplemented all 826 trace omissions, and reported zero missing,
ambiguous, overridden, mistyped, or status-mismatched answers. Recovery
checking retained all 1,246 safe facts as provisional, with no missing,
mistyped, or unsafe answers. The run took about 957 seconds. Together, the
current-source FBLite/Clang `-exx` runs now cover x86-32, x86-64, and AArch64;
assembly/link/runtime behavior and other mode/backend combinations remain
open.

Current-source FBLite/Clang x86-64 default-syntax expression replay,
2026-10-09: all 2,456 upstream files at FBC HEAD `53ea48b4bba9` matched
preprocessing and produced direct plus prepared models under a 60-second
per-file bound. There were no bounded or incomplete analyses or audit failures.
Of 326,717 syntax ranges, 313,570 had ordinary compiler types and all 13,147
remaining ranges were explicitly invalid recovery, with no missing syntax or
type mismatches. The sidecar compared 31,787 ordinary/physical expressions
plus 13,486 directive expressions, supplemented all 845 trace omissions, and
reported zero missing, ambiguous, overridden, mistyped, or status-mismatched
answers. Recovery retained all 1,246 safe facts provisionally; none were
missing, mistyped, or unsafe. The run took about 953 seconds. This adds the
current FBLite/Clang x86-64 default-syntax profile alongside its `-exx` run;
default-syntax Clang profiles for x86-32 and AArch64 were still open at this
checkpoint; the target refresh follows.

Current-source FBLite/Clang default-syntax target refresh, 2026-10-09: the full
2,456-file corpus passed on x86-32 and AArch64 with exact preprocessing parity
and direct plus prepared models for every file. Neither run had bounded or
incomplete analyses, type mismatches, missing syntax, or audit failures; the
sidecars reported no missing or mistyped answers. Along with the x86-64
default-syntax run above and the three `-exx` runs, this completes selected
FBLite/Clang expression-corpus coverage across x86-32, x86-64, and AArch64 with
and without extended syntax. Other compiler backends and actual assembly/link
or runtime behavior remain outside this profile.

Current-source FBLite/Clang AArch64 default-syntax replay, 2026-10-09: all
2,456 files matched preprocessing and produced direct/prepared models under
the 60-second per-file bound, with no bounded/incomplete analyses or audit
failures. Of 325,507 syntax ranges, 312,360 had ordinary types; all 13,147
remaining ranges were invalid recovery, with no missing syntax or type
mismatches. The sidecar compared 31,787 ordinary/physical expressions and
13,486 directive expressions, supplemented all 845 trace omissions, and found
no missing, ambiguous, overridden, mistyped, or status-mismatched answers.
The replay took about 659 seconds. This completes the current-source FBLite/
Clang default-syntax profile on x86-32, x86-64, and AArch64.

Current-source default-FB/Clang x86-64 expression replay, 2026-10-09: all
2,456 upstream files at FBC HEAD `53ea48b4bba9` matched preprocessing and
produced direct and prepared models under the 60-second per-file bound. There
were no bounded/incomplete analyses or audit failures. Of 892,662 syntax
ranges, 889,054 had ordinary compiler types and all 3,608 remaining ranges
were explicitly invalid recovery, with no missing syntax or type mismatches.
The sidecar compared 67,508 ordinary/physical expressions plus 29,279
directive expressions, supplemented 1,246 of 1,280 trace omissions, and
withheld 34 repeated-include ambiguities. There were no missing, mistyped, or
status-mismatched answers; all 3,475 sidecar-only queries were available. The
run took about 1,125 seconds. This refreshes the primary default-FB Clang
x86-64 profile against the current semantic bridge. At this checkpoint the
current x86-32 and AArch64 profiles were still open; follow-up results are
below.

Current-source default-FB/Clang x86-32 expression replay, 2026-10-09: all
2,456 upstream files at FBC HEAD `53ea48b4bba9` matched preprocessing and
produced direct plus prepared models under the 60-second per-file bound. There
were no bounded or incomplete analyses or audit failures. Of 892,768 syntax
ranges, 889,162 had ordinary compiler types; all 3,606 remaining ranges were
explicitly invalid recovery, with no missing syntax or type mismatches. The
sidecar compared 67,486 ordinary/physical expressions plus 29,280 directive
expressions. It supplemented 1,246 of 1,280 trace omissions, withheld 34
repeated-include ambiguities, and reported zero missing, mistyped, or
status-mismatched answers. The run took about 1,148 seconds. This refreshes the
primary default-FB Clang x86-32 profile against the current semantic bridge.

Current-source default-FB/Clang AArch64 expression replay, 2026-10-09: all
2,456 upstream files at FBC HEAD `53ea48b4bba9` matched preprocessing and
produced direct plus prepared models under the 60-second per-file bound. There
were no bounded/incomplete analyses or audit failures. Of 864,804 syntax
ranges, 861,196 had ordinary compiler types; all 3,608 remaining ranges were
explicitly invalid recovery, with no missing syntax or type mismatches. The
sidecar compared 66,847 ordinary/physical expressions plus 29,275 directive
expressions, supplemented 1,227 of 1,261 trace omissions, and withheld 34
repeated-include ambiguities. There were no missing, mistyped, or
status-mismatched answers; all 3,421 sidecar-only queries were available. The
run took about 1,128 seconds. This completes the current default-FB/Clang
expression-sidecar target matrix on x86-32, x86-64, and AArch64; actual Clang
code generation, assembly, and linking remain unverified.

Current-source deprecated-mode/Clang x86-64 `-exx` expression replay,
2026-10-09: all 2,456 upstream files at FBC HEAD `53ea48b4bba9` matched
preprocessing and produced direct plus prepared models under the 60-second
per-file bound. There were no bounded or incomplete analyses or audit failures.
Of 844,802 syntax ranges, 828,250 had ordinary compiler types and all 16,552
remaining ranges were explicitly invalid recovery, with no missing syntax or
type mismatches. The sidecar compared 46,097 ordinary/physical expressions
plus 17,942 directive expressions, supplemented all 998 trace omissions, and
reported zero missing, ambiguous, overridden, mistyped, or status-mismatched
answers. The run took about 1,090 seconds. This supersedes the earlier
deprecated/Clang x86-64 selected-slice checkpoint; other target and backend
combinations remain open.

Current-source default-FB/Clang x86-64 `-exx` expression replay,
2026-10-09: all 2,456 upstream files at FBC HEAD `53ea48b4bba9` matched
preprocessing and produced direct/prepared models under a 60-second per-file
bound. There were no bounded/incomplete analyses or audit failures. Of 892,634
syntax ranges, 889,026 had ordinary types; all 3,608 remaining ranges were
explicitly invalid recovery, with no missing syntax or type mismatches. The
sidecar compared 67,508 ordinary/physical expressions and 29,279 directive
expressions, supplemented 1,246 of 1,280 trace omissions, and withheld 34
repeated-include ambiguities. Missing, mistyped, and status-mismatched answers
were zero. The run took about 1,113 seconds. This adds extended-syntax Clang
coverage for default FB on x86-64; current-source x86-32 and AArch64 `-exx`
profiles remain open.

Current-source default-FB/Clang x86-32 `-exx` expression replay,
2026-10-09: all 2,456 upstream files at FBC HEAD `53ea48b4bba9` matched
preprocessing and produced direct plus prepared models under the 60-second
per-file bound. There were no bounded or incomplete analyses and no audit
failures. Of 892,740 syntax ranges, 889,136 had ordinary compiler types and
all 3,604 remaining ranges were explicitly invalid recovery; no syntax ranges
or types were missing or mistyped. The sidecar compared 67,487
ordinary/physical expressions plus 29,280 directive expressions, supplemented
1,246 of 1,280 trace omissions, and withheld 34 repeated-include ambiguities.
There were no missing, mistyped, or status-mismatched answers; all 3,475
sidecar-only queries were available. The run prepared 128,869 semantic-token
results and took about 1,109 seconds. This closes the current default-FB/Clang
x86-32 extended-syntax expression profile; the current AArch64 result follows.

Current-source default-FB/Clang AArch64 `-exx` expression replay,
2026-10-09: all 2,456 upstream files at FBC HEAD `53ea48b4bba9` matched
preprocessing and produced direct plus prepared models under the 60-second
per-file bound. There were no bounded or incomplete analyses and no audit
failures. Of 864,776 syntax ranges, 861,168 had ordinary compiler types and
all 3,608 remaining ranges were explicitly invalid recovery; there were no
missing syntax ranges or type mismatches. The sidecar compared 66,847
ordinary/physical expressions plus 29,275 directive expressions, supplemented
1,227 of 1,261 trace omissions, and withheld 34 repeated-include ambiguities.
Missing, mistyped, and status-mismatched answers were zero; all 3,421
sidecar-only queries were available. The run prepared 127,609 semantic-token
results and took about 1,073 seconds. Together with the current x86-32 and
x86-64 `-exx` results above, this completes default-FB/Clang extended-syntax
expression corpus coverage across x86-32, x86-64, and AArch64. Actual Clang
code generation, assembly, and linking remain unverified.

Procedure linkage and callback validation follow-up, 2026-10-09: the
schema-27 reader now joins compiler procedure-linkage receipts and callback
calling-convention observations to their accepted source statements. It checks
that procedure ABI callback counts match the emitted callback facts and that
the `procedure-linkage` capability covers every compiler-reported procedure
typing statement. Project rename signatures compare the normalized linkage,
library/alias, and callback choices instead of silently ignoring these newer
FBC observations. Fault injection confirms a changed alias or callback
convention refuses the rename preview; the unchanged rename remains preview-
only. The full project-refactoring suite passes 85/85 with no skips against
FBC HEAD `53ea48b4bba9`; the enum follow-up below raises that to 86/86.
Other compiler property families, macro relationships, and structural
refactorings remain open.

Enum refactoring validation follow-up, 2026-10-09: the extension now joins
schema-27 enum declaration and member receipts to accepted source statements.
It validates enum-header/member grouping, ordinal coverage, and the original
explicit-initializer choice, then includes those normalized facts in project
rename signatures without comparing invocation-local expression IDs. A
fault-injected change to a member's initializer choice refuses the rename;
the unmodified enum-type rename remains preview-only. An unsaved source with
an incomplete enum member still reports its compiler error while preserving
the type of an independent later expression. The complete project suite passes
86/86 and the semantic-sidecar suite passes 114/114, both with no skips against
FBC HEAD `53ea48b4bba9`. A freshly built Linux VSIX passes all 41
installed-editor checks on both VS Code 1.85.0 and 1.141.0. Broader enum
macro/recovery cases and other compiler property families remain open.

Declaration typing refactoring validation follow-up, 2026-10-10: the extension
now normalizes FBC `declaration-type-group`, `declaration-type-input`, and
`declaration-type-end` receipts into source-anchored groups. Project rename
signatures compare the accepted declaration grammar, member symbols, written
type forms, initializer categories, and complete ordinal coverage without
depending on detail-stream group IDs. A fault-injected change from `As` form
to suffix form refuses a type rename; the unchanged rename remains
preview-only. The complete project-refactoring suite passes 87/87 and the
semantic-sidecar suite passes 114/114, both with no skips against FBC HEAD
`53ea48b4bba9`. The freshly built Linux VSIX passes all 41 installed-editor
checks on both VS Code 1.85.0 and 1.141.0. Other declaration/property families
and unrepresented refactorings remain open.

Declaration repetition refactoring validation follow-up, 2026-10-10: the
extension now consumes FBC `redeclaration-input` receipts for accepted EXTERN,
TYPEDEF, and procedure prototype occurrences. Project rename signatures compare
the source-statement anchor, symbol, grammar kind, and compiler-selected
repeated/not-repeated decision without using the sidecar's invocation-local
detail identity. A fault-injected change to a repeated EXTERN decision refuses
the type rename; the unchanged preview remains read-only. The complete project
suite passes 88/88 and the semantic-sidecar suite 114/114, both with no skips
against FBC HEAD `53ea48b4bba9`. The freshly built Linux VSIX passes all 41
installed-editor checks on both VS Code 1.85.0 and 1.141.0. Scalar String
storage receipts follow below; broader macro repetitions and other property
families remain open.

Scalar String declaration refactoring validation follow-up, 2026-10-10: the
extension now normalizes FBC's scalar String declaration receipt to its source
statement, declared symbol, DIM/STATIC/field storage form, and initializer
presence. A fault-injected loss of the initializer observation refuses the
type rename; the intact preview remains read-only. The complete project suite
passes 89/89 and the semantic-sidecar suite 114/114, both with no skips against
FBC HEAD `53ea48b4bba9`. The freshly built Linux VSIX passes all 41
installed-editor checks on both VS Code 1.85.0 and 1.141.0. Broader macro,
recovery, and other compiler-property families remain open.

Array-storage binding-sidecar compatibility follow-up, 2026-10-10: FBC's
bindings-mode model can include complete `array-storage-*` properties and
receiver-node relationships while omitting detailed `S` records for a
referenced field symbol. The extension decoder now accepts that documented
projection while preserving same-module receiver/root checks and enforcing the
field class/module check whenever the symbol detail is present. The upstream
`array-subscript-inputs.bas` binding-sidecar fixture now verifies the storage
capability plus root, selection, and input relationships. The semantic-sidecar
suite passes 114/114, the project suite 89/89, and the Linux VSIX passes 41
checks on both VS Code 1.85.0 and 1.141.0. Project-transaction comparison for
array-storage selections and broader array recovery cases are addressed below.

Array-storage refactoring validation follow-up, 2026-10-10: the sidecar reader
now joins each array-storage property group to its physical expression range,
owning source statement, and (for fields) the receiver field's declaration
statement. Project rename signatures compare source-ordered array selections,
the compiler-selected storage symbol/kind, and the receiver declaration without
using sidecar expression or AST node IDs. Fault injection that changes a field
selection to variable storage refuses the type rename; the unmodified preview
remains read-only. The project suite passes 90/90 and the semantic-sidecar
suite 114/114 with no skips against FBC HEAD `53ea48b4bba9`. The freshly built
Linux VSIX passes all 41 installed-editor checks on both VS Code 1.85.0 and
1.141.0.

Current-source default-FB/Clang RISC-V32 `-exx` expression replay,
2026-10-10: all 2,456 upstream files at FBC HEAD `53ea48b4bba9` matched
preprocessing and produced direct plus prepared models under the 60-second
per-file bound. No analyses were bounded or incomplete and there were no audit
failures. Of 865,444 complete-snapshot syntax ranges, 861,838 had ordinary
compiler types; all 3,606 remaining ranges were explicitly invalid recovery,
with no missing syntax or type mismatches. The sidecar compared 66,913
ordinary/physical expressions plus 29,274 directive expressions, supplemented
1,230 of 1,264 trace omissions, and withheld 34 repeated-include ambiguities.
Missing, mistyped, and status-mismatched answers were zero. The run prepared
127,791 semantic-token results and took about 1,064 seconds. This extends the
default-FB/Clang extended-syntax target matrix to RISC-V32; MIPS32 remains open.
Assembly generation, linking, and runtime behavior are not covered.

Current-source default-FB/Clang MIPS32 `-exx` expression replay,
2026-10-10: all 2,456 upstream files at FBC HEAD `53ea48b4bba9` passed
baseline preprocessing parity and produced direct plus prepared models under
the 60-second per-file bound. There were no bounded or incomplete analyses or
audit failures. Of 865,861 complete-snapshot syntax ranges, 862,255 had
ordinary compiler types; all 3,606 remaining ranges were explicitly invalid
recovery, with no missing syntax. The semantic-sidecar audit completed without
missing or mistyped answers. The run prepared 127,792 semantic-token results
and took about 1,107 seconds. This completes default-FB/Clang `-exx` expression
corpus coverage across x86-32, x86-64, AArch64, RISC-V32, and MIPS32. Assembly,
linking, runtime behavior, and other language-mode/backend combinations remain
separate requirements.

Current-source QB/Clang x86-64 `-exx` full-corpus replay, 2026-10-10: all
2,456 upstream files at FBC HEAD `53ea48b4bba9` matched preprocessing and
produced prepared models under the 60-second per-file bound. The run reported
185 complete and 2,271 partial source snapshots, with no bounded or incomplete
analyses and no audit failures. It prepared 40,046 semantic-token results and
took about 633 seconds. This extends QB/Clang beyond its earlier dedicated
87-file slice to the full x86-64 extended-syntax corpus; x86-32 and AArch64
follow below.

Current-source QB/Clang x86-32 `-exx` full-corpus replay, 2026-10-10: all
2,456 upstream files at FBC HEAD `53ea48b4bba9` matched preprocessing and
produced prepared models under the 60-second per-file bound. The run reported
186 complete and 2,270 partial source snapshots, no bounded or incomplete
analyses, and no audit failures. It prepared 40,030 semantic-token results and
took about 657 seconds. This adds the 32-bit QB/Clang extended-syntax full
profile; AArch64 follows.

Current-source QB/Clang AArch64 `-exx` full-corpus replay, 2026-10-10: all
2,456 upstream files at FBC HEAD `53ea48b4bba9` matched preprocessing and
produced prepared models under the 60-second per-file bound. There were 189
complete and 2,267 partial source snapshots, with no bounded or incomplete
analyses or audit failures. Of 205,662 complete-snapshot syntax ranges,
121,070 had ordinary compiler types; all 84,592 remaining ranges were
explicitly invalid recovery, with no missing syntax or type mismatches. The
sidecar compared 1,625 ordinary/physical and 1,594 directive expressions,
supplemented all 33 trace omissions, and reported no trace type mismatch or
ambiguity. The run prepared 39,962 semantic-token results and took about 671
seconds. Together with the x86-32 and x86-64 results above, this completes the
QB/Clang `-exx` full-corpus profile across the three principal targets. Code
generation, linking, and runtime behavior remain unverified.

Current-source QB/Clang default-syntax full-corpus target matrix,
2026-10-10: all 2,456 upstream files at FBC HEAD `53ea48b4bba9` matched
preprocessing and produced prepared models on x86-64, x86-32, and AArch64 under
the 60-second per-file bound. The runs reported respectively 185/2,271,
186/2,270, and 189/2,267 complete/partial snapshots; none had bounded or
incomplete analyses or audit failures. They prepared 40,046, 40,040, and
39,972 semantic-token results in about 633, 637, and 632 seconds. On AArch64,
121,301 of 205,757 complete-snapshot syntax ranges had ordinary types; all
84,456 remaining ranges were explicitly invalid recovery, with no missing
syntax or type mismatches. Its sidecar supplemented all 33 trace omissions
with no mismatches or ambiguities. Alongside the `-exx` matrix above, this
completes full-corpus QB/Clang expression-sidecar coverage for both syntax
profiles across the three principal targets. Code generation, linking, and
runtime behavior remain unverified.

Grammar-led expression route coverage follow-up, 2026-10-10: the native corpus
audit now reports executions for each configured generic expression-parser
wrapper separately from the static route-ownership inventory. In the full
default-FB/Clang x86-64 `-exx` corpus replay, all 34 configured routes executed
at least once; `unexercised` was empty. The quirk-family coverage gate also
passed, and the static parser/call route audits returned no unowned, duplicate,
stale, or drifting routes. The route-execution count is specific to these 34
generic wrappers; exceptional `ROUTE_OWNERS` paths, negative/recovery
combinations, and mode/target-specific reachability still require their
dedicated fixtures and audits.

Cross-dialect expression-route coverage follow-up, 2026-10-10: per-target
native-matrix summaries now retain the expression-parser execution report,
including its exact unexercised route list, instead of dropping it after the
corpus audit. The summary propagation test passes with the focused audit suite
(19/19). Against FBC HEAD `53ea48b4bba9`, the x86-64 Clang `-exx` deprecated
profile exercised all 34 generic routes across 727 expression, compound,
overload, pointer, struct, number, string, and quirk files, with 727/727
preprocessing parity checks, direct models, and prepared worker models; there
were no bounded analyses, incomplete snapshots, or audit failures. For
FBLite, the 548-file expression/compound/overload/pointer/struct slice reached
33/34 routes, missing only `cGtInParensOnlyExpr`; the separate 122-file
number/string slice executed that route. Their category union therefore
exercises all 34 routes. Both profiles used the same x86-64 Clang `-exx` mode;
the sidecar-enabled expression slice reported no missing, mistyped, or
status-mismatched answers. The broader 727-file QB profile exercised 33/34
routes, leaving only `cImplicitDataMember` unobserved; it had 727/727 parity,
direct models, and prepared worker models, with no bounded or incomplete
analyses or audit failures. A narrower 87-file QB-only slice had missed five
routes, so those absences were corpus selection rather than general QB-mode
unreachability. A focused native regression verifies the remaining
`cImplicitDataMember` boundary: the method's unqualified field is parsed under `-lang fb`,
while `-lang qb` rejects the method declaration with FBC's “Only valid in
-lang fb” diagnostic and emits no such route. The regression passes against the
current editor bridge; the full compiler-analysis test file passes 105/105
against that bridge and FBC HEAD. These results are x86-64, Clang, and
extended-syntax route evidence; target variation, default syntax, exceptional
owners, and dedicated negative/recovery route combinations remain open.

Current malformed-overlay responsiveness measurement, 2026-10-10: with the
bridge built from FBC HEAD `53ea48b4bba9`, the 54,386-byte unsaved
`compiler-types.bas` overlay containing one broken expression followed by 2,000
valid expressions reached EOF, retained the single parser error, and returned
an authoritative `Double` for the last expression. Direct analysis took 1.03 s
and sampled a 414.8 ms main-thread pause; synchronous model construction added
148 ms elapsed with a 149.3 ms pause. The prepared worker path took 1.23 s
cold and 1.06 s warm, while its main-thread pauses were 15.4 ms and 6.0 ms;
the final expression query took 1.61 ms cold and 0.73 ms warm. Worker decode
fell from 268 ms cold to 79 ms warm. This confirms that the production
background-analysis path avoids the direct path's large host stall while
preserving recovery typing. These are one-run measurements on this host, not
latency guarantees; sustained typing and concurrent foreground traffic remain
unmeasured.

Named unsaved-root recovery follow-up, 2026-10-10: a real worker-backed service
test exposed that `CompilerModelStore.prepare()` still called `stat()` on the
root even when the editor supplied its complete overlay. This rejected a dirty
named `.bas` buffer whose path did not yet exist. Preparation now treats that
captured root overlay as authoritative and continues to stamp every consumed
disk dependency; the direct on-demand path likewise avoids requiring a disk
stamp for a captured root. The regression proves both paths accept the absent
root without creating it, and that the production worker path retains the
diagnostic for a broken expression while returning a non-provisional `Double`
type for a later independent expression. Against FBC HEAD `53ea48b4bba9`, the
service suite passes 27/27 and the worker suite 36/36 with no skips. A rebuilt
Linux VSIX passes all 37 installed-editor checks on VS Code 1.85.0 and 1.141.0.
Unsaved roots and headers that do exist on disk, stale-result rejection, and
broken-code recovery remain covered separately; broader parser-recovery
combinations and sustained typing performance remain open.

Implicit-call-kind corpus coverage follow-up, 2026-10-10: the native bindings
audit now compares observed physical sidecar call kinds against the current
FBC-supported kind vocabulary. Aggregate and per-category reports list
supported, exercised, missing, and unexpected kinds; unsupported emissions
always fail the audit, and a full default-FB audit fails if any supported kind
is absent. Tests verify kind classification and both failure policies. The
current-source x86-64 14-category implicit-call profile passed all 1,706 files
with preprocessing parity, direct models, and prepared worker models; there
were no bounded/incomplete analyses or audit failures. It counted 83,242
bindings and 1,768 implicit calls: all nine supported kinds were exercised,
with zero missing or unexpected kinds. The compiler-analysis test file passes
107/107 and the audit-options suite 19/19. This adds corpus reachability
evidence for selected implicit-call kinds, not per-call-site dynamic ownership
coverage or the full dialect/target/backend matrix.

Dialect-specific implicit-call reachability follow-up, 2026-10-10: FBC's
`langTb` enables `FB_LANG_OPT_CLASS` for `fb` but not for `fblite` or `qb`; a
native regression confirms both legacy modes reject a method declaration with
“Only valid in -lang fb”. The 1,706-file x86-64 Clang `-exx` FBLite binding
profile passed parity and model preparation for every file, with 29,868
bindings and 27 implicit calls: 15 `default-constructor` and 12
`destructor-call`. A focused FBLite `NEW`/`DELETE` case for a plain UDT emits no
fabricated constructor/destructor fact. In QB mode, the 757-file
`dim`/`functions`/`structs` binding profile passed parity and preparation for
every file, with 1,231 bindings and one `destructor-call`. These selected
profiles have no audit failures or unsupported call kinds. Their unexercised
global vocabulary entries are reported rather than failed; the lack of
`CLASS` makes several class-owned routes unavailable, but does not yet prove
that every absent kind is impossible in each dialect. The compiler-analysis
test file passes 108/108. Other QB categories,
deprecated mode, additional targets/backends, and per-call-site ownership
remain to be audited.

Deprecated-mode implicit-call reachability follow-up, 2026-10-10: the same
current-source x86-64 Clang `-exx` 14-category bindings audit passed all 1,706
files with parity and prepared models, no bounded or incomplete analyses, and
no audit failures. It retained 39,765 bindings and 29 implicit calls, covering
16 `default-constructor` and 13 `destructor-call` facts. The other seven global
call kinds were not exercised, and no unsupported kind was emitted. The FBC
language table also omits `FB_LANG_OPT_CLASS` for deprecated mode; native tests
confirm method declarations are rejected and plain UDT `NEW`/`DELETE` does not
invent constructor facts in both deprecated and FBLite modes. The compiler-
analysis suite passes 108/108. This supports, but does not prove for every
route, that these call-kind omissions follow the dialect boundary; broader
per-site, target, and backend evidence remains open.

Full default-FB implicit-call and parser-route gate, 2026-10-10: the
no-category x86-64 Clang `-exx` semantic-binding audit now passes the complete
2,456-file portable corpus at FBC HEAD `53ea48b4bba9`. Every file matched
trace-free preprocessing and produced a direct and prepared model; there were
no bounded analyses, incomplete snapshots, or failures. Across all snapshots,
the expression audit counted 892,634 syntax ranges and 889,026 typed ranges,
with no missing syntax or type mismatches; recovery states were retained
explicitly.
The binding sidecar reported 146,232 bindings and 1,869 implicit calls. All
nine FBC-supported call kinds were exercised, with no missing or unexpected
kinds, satisfying the new full-mode gate. The same run exercised all 34 generic
expression-parser routes. Per-call-site call-builder execution, other
dialects/targets/backends, and object generation/linking remain open.

Exceptional expression-family coverage follow-up, 2026-10-10: the native
corpus report now exposes the 22 quirk parser-family hooks separately from
the 34 generic wrappers, identifies the 19 corpus-required hooks, and lists
the three fixture-only families (`cScreenFunct`, `cViewStmt`, `cVAFunct`). It
also reports the `cTypeOrExpression` type-layout route, and per-target matrix
summaries retain both reports. The 841-file x86-64 Clang `-exx` expression and
quirk-heavy corpus union passed preprocessing parity and direct/prepared model
construction for every input, with no bounded/incomplete analyses or audit
failures. It exercised 34/34 generic routes, all 19 corpus-required quirk
families, and the type-layout route 78 times; the three fixture-only families
were correctly identified as absent from this upstream category union. The
audit-options suite passes 21/21 and compiler-analysis 108/108, including
focused fixtures for fixture-only routes. Compiler call-site owners outside
these family hooks and additional target/mode reachability remain open.

Rebuilt-bridge exceptional-route full-corpus confirmation, 2026-10-10: the
instrumented bridge now adds `cFunctionCall` and `cCtorCall` as secondary route
tags after the complete syntax node is committed. This preserves enclosing
families such as `cAnonType`; the existing anonymous-constructor regression
failed on the first tag placement, then passed after the tag was moved to the
committed syntax node. The current bridge rebuilt from FBC HEAD
`53ea48b4bba9` plus its then-current working-tree changes passes the full
2,456-file default-FB x86-64 Clang `-exx`
corpus: exact preprocessing parity, direct and prepared models for every file,
and no bounded/incomplete analyses or audit failures. Across the corpus, 34/34
generic routes, 19/19 corpus-required quirk families, both exceptional call
routes, and the type-layout route were exercised. The three fixture-only quirk
routes remain separate and are checked by native fixtures. The run also
reconfirmed 889,026 typed of 892,634 syntax ranges, with all 3,608 remaining
ranges explicitly invalid recovery and no missing syntax, provisional type,
unmarked recovery, or type mismatch. All nine implicit-call kinds were
exercised (1,869 facts), with none missing or unexpected. The compiler-analysis
suite passes 108/108 and audit-options 22/22. Individual lowering/call-builder
owner reachability, non-FB route matrices, and generated-code execution remain
open.

Current-source 2,458-file default-FB binding and expression-route audit,
2026-10-10: the bridge rebuilt from the current FBC checkout passes every
portable corpus file in the x86-64 Clang `-exx` profile. All 2,458 inputs
matched trace-free preprocessing and produced both direct and prepared worker
models; none were bounded or incomplete, and there were no audit failures.
The audit counted 892,772 syntax ranges: 889,164 had compiler types, while the
remaining 3,608 were all explicitly invalid recovery ranges. Missing syntax,
provisional gaps, unmarked recovery, and type mismatches were zero. It
exercised all 34 generic expression-parser routes, all 19 corpus-required
quirk families, all three exceptional routes (`cFunctionCall`, `cCtorCall`,
and `cProcCall`), and the type-layout route. The three fixture-only quirk
routes remain separately exercised by native fixtures. Across 146,502 symbol
bindings, all nine supported implicit-call kinds were observed in 1,869 facts,
with no unsupported emissions or missing kinds. This refresh supersedes the
earlier 2,456-file report for this profile and closes the dynamic default-FB
route gate. Other dialect/target/backend combinations, remaining per-site
lowering ownership, and compiler code-generation/runtime regression remain
open.

Broken-buffer edit-burst responsiveness follow-up, 2026-10-10: the native
worker regression exercises five successive ~20,000-line malformed overlays,
cancelling each compiler run before publishing a final valid buffer. The
current run passed with a maximum 3 ms stale-request discard, 30 ms maximum
native cleanup, and 121 ms from the final edit to current-model publication;
sampled host RSS peaked at 122.3 MiB. Each obsolete process, scratch directory,
and worker model was reclaimed, while the final expression retained its
authoritative `String` type and the disk source remained unchanged. This adds
an edit-burst measurement to the prior malformed-file benchmark; it is still
one host/run and does not establish sustained typing latency under
representative editor load or a memory ceiling.

Current native unit and installed-package verification, 2026-10-10: with the
bridge rebuilt from the current FBC checkout, `npm run test:unit` passed all
516 tests with zero skips or failures. This includes the upstream
expression-corpus comparison, broken-overlay recovery, project rename across
macro/build-context cases, and native Outline/workspace worker tests. A fresh
Linux VSIX for extension version 1.20.4 installed into an isolated VS Code
1.121.0 profile and passed all 37 extension-host integration checks. The
package checks exercise on-demand native Outline, closed configured-module
workspace search, unsaved roots and headers, recovery, and validated rename
through actual VS Code providers. This adds a current-package integration
checkpoint; the broader installed-version matrix and full external compiler
regression remain separate gates.

Current FBC-side semantic contract suite, 2026-10-10: the upstream
`build_scripts/test-compiler-semantic-model.py --fbc ./bin/fbc` run passed all
226 tests with only the three documented Windows-toolchain cases skipped. The
tested compiler binary was built after the current checkout's modified GAS64
backend source timestamp; the semantic-model source itself has no uncommitted
changes. This verifies the current compiler's semantic exporter contracts,
source-origin and recovery rules, and emission-preservation cases. It does not
substitute for the full FBC compiler/runtime suite or the explicitly selected
GAS64 sidecar backend profile, which remain separate checks.

Current GAS64 semantic contract profile, 2026-10-10: the same FBC-side
semantic suite passed all 226 tests with `--backend gas64`; four cases were
skipped because three require Windows-native link tools and one is LLVM-only.
This adds backend-selected sidecar and emission-contract coverage, but it is
not the full compiler test harness or the complete cross-target/backend
matrix. A later GAS64 source/binary refresh occurred during the same work
period, so this sidecar run is not treated as the final verification of that
newer source state; the focused backend check below was repeated after it.

Current compiler backend regression check, 2026-10-10: the targeted
`test-compiler-backends.py --backend gcc --backend clang` run passed. It emitted
the GAS64 backend source for win32, Linux MIPS32, and RISC OS; emitted CRT
headers for 31 target profiles and Unicode headers for eight; and passed the
GCC/Clang ABI, builtin, inline-assembly, QB-header, and C-ABI runtime fixtures.
The unfiltered runner also passed those GAS64/CRT/Unicode checks and LLVM
AArch64 assembly emission, but failed at its LLVM/Win32-686 object step: the
Linux Clang assembler rejected the emitted `.type`/`.size` ELF directives for
that Windows object check. The Windows/LLVM object path is therefore not
verified on this host; this failure is separate from the passing GAS64 and
GCC/Clang native profiles.

Latest-FBC bridge refresh, 2026-10-10: after the FBC checkout's GAS64 source
and `bin/fbc` timestamps advanced, the editor bridge was rebuilt from the
current checkout. `compiler-analysis.test.js` plus `compiler-audit-options`
passed 130/130 with no skips against that bridge. The focused GCC/Clang
backend runner was also repeated with the current `bin/fbc`; the GAS64 source
emission for win32, Linux MIPS32, and RISC OS, all platform/Unicode emission
checks, and all GCC/Clang runtime fixtures passed, with source and binary
timestamps unchanged during that run. The separate LLVM/Win32 object issue
above remains open.

Current source-backed language-data and grammar checks, 2026-10-10: the
FreeBASIC 1.20.4 coverage audit passed against the current `/home/jkfirth/fbc`
tree, including 255 compiler keywords, 25 preprocessor directives, 114
compiler defines, bundled declarations, and selected header constants. The
extension smoke suite passed 7/7 and actual TextMate tokenization passed 2/2.
These checks confirm generated/editor grammar alignment with the current
compiler source, in addition to the native semantic corpus gates above.

Current default-syntax FB expression-sidecar target matrix, 2026-10-10: the
`fb-expressions` matrix passed for x86-32, x86-64, and AArch64 over all five
compiler-heavy categories (`expressions`, `compound`, `overload`, `pointers`,
and `structs`), 549 files per target. Every file passed preprocessing
parity and produced direct plus prepared-worker models; the matrix reported no
bounded or incomplete analyses and no failures. The per-category progress
counters account for 44,048 compared compiler semantic facts across the three
targets, with no reported type mismatches. Expression coverage accepted only
explicit invalid recovery ranges as untyped; sidecar missing/mistyped and
recovery-safety counters were zero. This extends the default-FB checks beyond
the earlier x86-64 `-exx` full corpus to ordinary syntax across three ABIs; it
does not close non-FB dialects, backend/runtime combinations, or the broader
full-corpus matrix.

Route-complete default-syntax FB target matrix follow-up, 2026-10-10: the
expression matrix now includes the `numbers` and `string` categories and fails
if any configured generic parser route is unexercised. The expanded profile
passed on x86-32, x86-64, and AArch64: 671/671 files per target, with parity,
direct models, and prepared worker models for every input; no bounded or
incomplete analyses or failures. Each target exercised all 34/34 generic
expression routes. Typed-range totals were 386,500/387,107 (x86-32),
386,521/387,128 (x86-64), and 359,383/359,990 (AArch64); each target's 607
untyped ranges were all explicitly invalid recovery. Compiler-sidecar
comparison covered 36,973, 37,065, and 36,568 expressions respectively, with
zero missing or mistyped answers, sidecar-only gaps, or unsafe recovery facts.
This supersedes the earlier 549-file expression slice and closes the generic
route reachability gap for default-FB ordinary syntax across these three
targets. FBLite/deprecated route-complete matrices and broader dialect/backend
combinations remain open.

Route-complete legacy-dialect expression slices, 2026-10-10: the same
seven-category route union passed in FBLite and deprecated mode on x86-64.
Each mode processed 671/671 files with preprocessing parity, direct models,
and prepared worker models; neither had bounded/incomplete analyses or
failures. Both executed all 34 generic expression routes. FBLite typed
159,540/166,820 ranges, with all 7,280 untyped ranges explicitly invalid
recovery; deprecated typed 344,469/353,929, with all 9,460 untyped ranges
explicitly invalid recovery. Compiler-sidecar comparisons covered 14,452
FBLite expressions and 21,012 deprecated expressions, with zero missing,
mistyped, sidecar-only, or recovery-safety mismatches. These are x86-64
route-complete slices; x86-32/AArch64 legacy matrices and full-corpus dialect
profiles remain open. The matrix-option suite passes 23/23, including tests
that the expression-profile gate rejects any unexercised generic route.

Route-complete FBLite expression-sidecar target matrix, 2026-10-10: the
expanded seven-category profile passed for x86-32, x86-64, and AArch64, with
671/671 files per target, exact preprocessing parity, direct and prepared
models for every file, and no bounded/incomplete analyses or audit failures.
All 34/34 generic parser routes executed on every target. Typed-range totals
were 159,979/167,270 (x86-32), 159,540/166,820 (x86-64), and
159,050/166,330 (AArch64); the 7,280-7,291 untyped ranges per target were
explicit invalid recovery. Sidecar comparisons covered 14,360, 14,452, and
14,237 expressions respectively. They supplemented 640, 640, and 632 trace
omissions, with zero missing, mistyped, sidecar-only, or recovery-safety
answers. Each target also compared all 16,159 safe recovery facts in sidecar-
only mode. This closes route-complete FBLite expression-sidecar coverage for
the three principal ABIs; deprecated mode and full-corpus dialect/backend
profiles remain open.

Route-complete deprecated expression-sidecar target matrix, 2026-10-10: the
expanded seven-category profile passed for x86-32, x86-64, and AArch64, with
671/671 files per target, parity, direct models, and prepared worker models for
every file; no bounded/incomplete analyses or failures. Each target exercised
all 34 generic parser routes. Typed-range totals were 344,512/353,983
(x86-32), 344,469/353,929 (x86-64), and 317,331/326,791 (AArch64); all
9,460-9,471 remaining ranges were explicitly invalid recovery. Sidecar
comparisons covered 20,920, 21,012, and 20,515 expressions, supplementing
745, 745, and 737 trace omissions with no type mismatches. All 14,506 safe
recovery facts per target were available and correctly provisional in the
recovery sidecar check. This closes route-complete deprecated expression
coverage across the three principal ABIs; full-corpus dialect/backend/runtime
coverage remains open.

Unanchored implicit-call refactoring validation, 2026-10-10: project rename
previously compared only compiler-selected implicit calls with physical source
ranges. The transaction now keeps a separate counted fingerprint for
nonphysical calls, keyed by source file, mapped compiler identities (falling
back to producer identities only when no unique bridge mapping exists), call
kind, and selected signature. Virtual coordinates are deliberately excluded,
and these relationships remain metadata rather than edit sites. A compiler-
backed fault-injection regression changes an unanchored constructor signature
during type-rename validation and confirms the preview is rejected; unchanged
relationships still permit a read-only preview. The sidecar-level test checks
duplicate-count normalization, signature changes, and ambiguous identity
fallback. The full project and project-worker suites pass 100/100 with no
skips; the focused sidecar test passes 1/1. Follow-up found that the bounded
binding-capable sidecar reader counted nonphysical `I` records in its footer
but dropped them from `analysis.semanticImplicitCalls`. It now retains those
facts while checking dependency membership only for physical call locations;
the corpus audit counts them as nonphysical rather than invalid source ranges.
The upstream `implicit-call-coordinates.bas` regression verifies that the
virtual `#LINE` constructor call is retained, remains non-editable, and reaches
the unanchored project signature. The refreshed full unit suite passes 519/519
with no skips, and a fresh Linux VSIX passes 37/37 extension-host checks on
VS Code 1.121.0. FBC's semantic exporter now also recovers a macro invocation
as a logical, nonphysical anchor and emits the selected constructor `I` record
alongside its `MR` construction origin when the parser has no valid range. The
FBC-side regression passes against the rebuilt bridge under both GCC and
GAS64; the complete FBC semantic-sidecar contract suite passes 227 tests with
four expected platform/backend skips. The compiler-backed project test renames
the type referenced in a `#define`, rejects a fault-injected change to that
unanchored call signature, then returns the unchanged 20-edit preview without
writing sources. The preview validates both x86-64 and x86-32 project contexts
and edits the physical type spelling in the macro definition once. The full
project and project-worker suites pass 100/100 with no skips; the extension's
full native unit suite passes 519/519 and the packaged VSIX passes 37/37
checks. The remaining boundary is expansion attempts for which no invocation
location can be recovered, plus other unanchored generated relationship
families.

Current-source default-FB binding replay after retaining nonphysical implicit
calls, 2026-10-10: the full 2,458-file x86-64 Clang `-exx` corpus passed
preprocessing parity and direct/prepared worker construction for every file,
with no bounded analyses, incomplete snapshots, or failures. It covered
892,772 syntax ranges: 889,164 were typed and the other 3,608 were all
explicitly invalid recovery, with no missing syntax, provisional gaps, or
type mismatches. All 34 generic routes, 19 corpus-required quirk families,
three exceptional routes, and the type-layout route executed. The binding
sidecar retained 146,502 bindings and 1,996 selected implicit calls, including
127 nonphysical relationships; all nine supported call kinds were exercised.
There were no malformed record totals, invalid physical ranges, missing
physical dependencies, or missing signatures. This is the first full-corpus
binding run after the reader began retaining physical-flag-zero `I` records
and the compiler began anchoring recoverable macro constructions; other
mode/target/backend binding matrices remain open.

Default-FB implicit-call target matrix after retaining nonphysical calls,
2026-10-10: the new `fb-implicit-calls` profile passed across x86-32, x86-64,
and AArch64 for its 14 binding-heavy upstream categories. Each target processed
1,708/1,708 files with preprocessing parity, direct models, and prepared worker
models; none were bounded or incomplete, and all target reports passed. Every
target exercised all nine supported implicit-call kinds with no unexpected
kinds, invalid record totals, missing physical dependencies, invalid physical
ranges, or missing signatures. The audit separately reports nonphysical calls
instead of rejecting them as editable ranges. Expression typing mismatches
were zero; the untyped syntax ranges were all explicitly recovery-marked. This
adds default-syntax implicit-call ABI coverage across all three principal
targets; non-FB binding profiles and broader full-corpus/backend combinations
remain open.

FBLite implicit-call target matrix, 2026-10-10: the binding-aware
`fblite-implicit-calls` profile passed on x86-32, x86-64, and AArch64 across
the same 14 upstream categories, with 1,708/1,708 parity checks, direct
models, and prepared worker models per target. Each target retained 27
implicit-call facts: 15 default constructors and 12 destructor calls. Those
were the required dialect-supported kinds; the other seven global call kinds
were absent on all targets. There were no unexpected kinds, malformed binding
or call totals, missing physical sources, invalid ranges/signatures, bounded
analyses, incomplete models, or audit failures. All untyped expressions were
explicitly invalid recovery. This upgrades the prior x86-64 FBLite call sample
to target-matrix evidence; deprecated and QB call matrices remain open.

Current FBC source follow-up, 2026-10-10: the source checkout is at
`24610bca329d2742e9d548ad20280984bdfbf93b` (FreeBASIC 1.20.4), with the
semantic exporter and contract tests carrying local changes. Expressions-only
output now retains the compiler-typed `E` range for accepted, non-placeholder
array upper-bound expressions such as `0 To 1`; it still reports
`array-dimension-inputs` as unavailable and does not emit full-model input
receipts. The complete FBC semantic-sidecar suite passes 235 tests with three
expected Windows-toolchain skips, and the new range regression passes under
GAS64. Rebuilding the Linux editor bridge compiled 182 compiler modules. The
extension's full native unit suite passes 523/523 with no skips. The fresh
2,459-file x86-64 Clang default-FB binding/expression corpus audit passes with
2,459 parity and prepared-model checks, no bounded or incomplete analyses,
zero type mismatches, and all 3,608 untyped ranges explicitly marked invalid
recovery. Linux VSIX extension-host checks pass 41/41 on VS Code 1.121.0 and
1.85.0. This is strong current-source evidence for the tested default-FB
profile, not completion: broader dialect, target, backend, and unusual
refactoring coverage remain open.

Current-source full QB corpus matrix and semantic ambiguity handling,
2026-10-10: added a qb-full matrix profile over all 30 portable source
categories and all three principal ABIs. The first run found contradictory
compiler E facts for three physical REDIM literal ranges: each range had both
Short and converted Integer facts. The semantic model already marks these
ranges ambiguous, withholds a sidecar-only answer, and retains the direct
compiler trace type. The corpus auditor incorrectly compared every
alternative to that one retained answer. It now counts each ambiguous range
once and fails if an ambiguous sidecar answer is selected; a regression covers
both safe trace retention and unsafe sidecar selection. QB-only route tests
also verify that unsupported WITH and sized-CVI syntax does not fabricate
expression routes. compiler-analysis.test.js and
compiler-audit-options.test.js pass 137/137 with no skips.

The corrected QB full-corpus matrix passes all 2,459 files on x86-32, x86-64,
and AArch64. Each target has 2,459 preprocessing-parity checks, direct models,
and prepared worker models; none were bounded or incomplete and all target
reports have no failures. Expression syntax/type coverage is 207,220/122,164
on x86-32, 206,647/121,927 on x86-64, and 205,942/121,486 on AArch64. Every
untyped range is explicitly invalid recovery, with no missing syntax or type
mismatches. Semantic sidecar checks report three explicit ambiguous ranges
per target, zero selected-sidecar type mismatches, zero missing or mistyped
sidecar-only answers, and zero unsafe recovery facts retained. The remaining
trace-vs-sidecar differences are confined to those documented ambiguous
ranges. This closes current-source QB full-corpus semantic-sidecar coverage
across the three principal ABIs; QB code-generation/runtime behavior and
other dialect/backend combinations remain open.

Deprecated-mode implicit-call target matrix, 2026-10-10: the
deprecated-implicit-calls profile passed on x86-32, x86-64, and AArch64 across
all 14 binding-heavy corpus categories. Each target processed 1,708/1,708 files
with preprocessing parity, direct models, and prepared worker models; there
were no bounded or incomplete analyses, audit failures, malformed records,
missing sources, invalid physical ranges, or invalid signatures. Each target
retained 29 physical implicit-call facts: 16 default constructors and 13
destructor calls, with no unexpected call kinds. Expression coverage had zero
type mismatches or missing syntax; all 13,340-13,353 untyped ranges per target
were explicitly invalid recovery. This closes the deprecated implicit-call
ABI matrix; compiler code generation/runtime behavior and remaining
per-call-site refactoring boundaries remain open.

Current-source full FBLite corpus matrix, 2026-10-10: all 2,459 upstream
files passed on x86-32, x86-64, and AArch64 with exact preprocessing parity,
direct and prepared worker models for every file, no bounded or incomplete
analyses, and no audit failures. Complete/partial snapshot counts were
693/1,766, 695/1,764, and 695/1,764 respectively. Expression syntax/type
coverage was 328,627/315,467 (x86-32), 327,040/313,893 (x86-64), and
325,692/312,545 (AArch64); every untyped range was explicitly invalid
recovery, with zero missing syntax and zero type mismatches. Compiler
semantic-sidecar comparisons covered 32,290, 32,309, and 31,860 expressions;
all three targets reported zero trace or selected-sidecar type mismatches,
zero ambiguous, missing, or mistyped answers, and zero unsafe recovery facts
retained. This closes current-source full-corpus FBLite expression-sidecar
coverage across the three principal ABIs; code generation and runtime
behavior remain separate gates.

Current-source full deprecated corpus matrix, 2026-10-10: all 2,459 upstream
files passed on x86-32, x86-64, and AArch64 with exact preprocessing parity,
direct and prepared worker models for every file, no bounded or incomplete
analyses, and no audit failures. Complete/partial snapshot counts were
832/1,627, 834/1,625, and 834/1,625 respectively. Expression syntax/type
coverage was 846,373/829,808 (x86-32), 845,153/828,601 (x86-64), and
817,157/800,605 (AArch64); all remaining ranges were explicitly invalid
recovery, with zero missing syntax and zero type mismatches. Semantic-sidecar
comparisons covered 46,836, 46,760, and 46,031 expressions; all targets had
zero trace or selected-sidecar type mismatches, zero ambiguous, missing, or
mistyped results, and zero unsafe recovery facts retained. This closes
current-source full-corpus deprecated expression-sidecar coverage across the
three principal ABIs; code generation and runtime behavior remain separate
gates.

Current-source full default-FB corpus matrix, 2026-10-10: all 2,459 upstream
files passed on x86-32, x86-64, and AArch64 with exact preprocessing parity,
direct and prepared worker models for every file, no bounded or incomplete
analyses, and no audit failures. Each target had 1,137 complete and 1,322
partial snapshots. Expression syntax/type coverage was 894,130/890,524
(x86-32), 892,985/889,377 (x86-64), and 864,989/861,381 (AArch64). All
remaining untyped ranges were explicitly invalid recovery; missing syntax and
type mismatches were zero. Semantic-sidecar comparisons covered 68,982,
68,724, and 67,995 expressions, with zero trace or selected-sidecar type
mismatches. Each target recorded 17 explicit ambiguous ranges; there were no
missing or mistyped sidecar-only answers and no unsafe recovery facts
retained. This completes current-source default-FB full-corpus
expression-sidecar coverage across the three principal ABIs. Code generation
and runtime behavior remain separate acceptance gates.

Current-source analysis responsiveness refresh, 2026-10-10: on Node 22.22.1
Linux, the compiler-source benchmark's direct path had main-thread pauses up
to 914 ms during analysis and 692 ms during model construction. The production
prepared-worker path kept sampled host pauses at or below 10.5 ms across the
same large modules; a prepared semantic-token query took 70-79 ms while
blocking the host for 5-6 ms. For an unsaved 54 KiB broken overlay followed by
2,000 valid expressions, direct analysis/model construction paused the host
for up to 426/163 ms, while prepared-worker analysis stayed below 6 ms host
pause and the final independent expression remained an authoritative Double.
The prepared recovery query took 0.6-3.4 ms. These are single local runs, not
latency guarantees; sustained typing, concurrent foreground traffic, and
resource behavior under aggregate load remain open.

Full extension unit-suite refresh, 2026-10-10: the native runner rebuilt the
Linux bridge from the current FBC checkout and passed 526/526 tests with no
skips or failures. This includes the full unsaved-buffer, recovery, worker,
semantic-sidecar, and project-rename suites, along with the new QB ambiguity
and dialect-boundary regressions. The bridge build still reports one existing
implicit-conversion warning in ast-node-assign.bas; it does not fail the build
or test suite.

FBCDIA diagnostic-location integration, 2026-10-11: native compiler analysis
and ordinary compile checks now request FBC's optional structured-diagnostics
transport. The bounded reader validates framing, source ownership, footer
counts, physical-point flags, and compiler exit agreement. A structured point
is attached only to one matching textual diagnostic, and the editor narrows it
to the reported UTF-16 token start only when the token is present in compiler
message/detail text and the captured source line is unchanged; otherwise it
preserves the existing line-based diagnostic. Compilers that reject
`-semantic-diagnostics` are retried without that optional artifact. Unit
coverage passes for framing, ambiguity, malformed points, out-of-range columns,
Unicode positions, compatibility retry, and stale-buffer rejection. Native
bridge and VS Code 1.85 host regressions verify the precise squiggle in an
included `.bi` file.
The compiler's current parser point for some generic diagnostics can identify
a nearby consumed token rather than the token named by the message; such cases
deliberately keep the line-wide fallback.

Compiler diagnostic include freshness, 2026-10-11: FBCDIA source observations
are now retained per checked root. Editing an included `.bi` clears diagnostics
from roots that actually opened it, including macro-expanded includes that the
lightweight index cannot resolve. Saving the header rechecks those open roots.
If the compiler cannot provide a complete source inventory, the extension uses
a bounded conservative fallback over open modules rather than trusting an
incomplete dependency graph. A VS Code 1.85 test starts with a clean macro-
included header, introduces an error, then changes its name and saves; the root
diagnostic is published, cleared on edit, and refreshed on save.

Compiler-selected include links, 2026-10-11: the schema-27 `INC` outcomes were
retained in semantic snapshots but not consumed by the link provider. Current
snapshots now supply links for successfully opened includes using the
compiler-resolved path and validated source range. Direct includes link their
physical directive; inactive branches and macro-expanded includes without a
physical directive do not receive guessed links. When no current semantic
snapshot exists, the existing lightweight local include resolver remains
unchanged. VS Code 1.85 native-host checks pass for bridge and ordinary
sidecar analysis, verifying an active direct link while omitting an inactive
and macro-expanded include. Link tooltips show the compiler-resolved target and
explain `include-once` and `pragma-once` outcomes.

Compiler-aware inactive source feedback, 2026-10-11: schema-21 `PPS` ranges
were already decoded but not consumed by editor features. Current compiler
snapshots now mark validated physical whole-line inactive regions with VS
Code's `Unnecessary` diagnostic tag, fading unselected code, and exclude those
ranges from delimiter matching. The immediate lexical pass remains unchanged
before analysis and when no current snapshot exists; non-whole-line ranges are
ignored rather than byte-column converted by guesswork. A focused VS Code
integration check verifies the inactive source is faded and its false
unmatched-opener warning disappears after FBC selects the active branch; the
scanner test confirms active unmatched openers are still reported.

Conditional-result hover, 2026-10-11: schema-21 `PPD` decisions include a
physical source range for a directly written `#if`/`#elseif` condition. Native
hover now explains the compiler's Boolean result and whether that branch was
selected in the current context. Nonphysical or conflicting repeated-include
decisions are withheld. The focused host regression hovers the `0` in `#if 0`
and verifies both the false result and unselected-branch state. Physical
`DEFINED(name)` probes now also show whether the compiler found the name in
that context; conflicting repeated-include observations are withheld.

Compiler macro definition previews, 2026-10-11: hover on an exact physical
macro declaration includes its source for directly mapped `#define` directives
and `#macro` blocks. A macro use or completion shows that source only when the
compiler identity has one definition in the analyzed translation unit;
redefined names do not advertise a guessed active replacement. Continued
`#define` lines and `#macro` bodies are retained within fixed line and
byte-length bounds. A bounded preview avoids large editor payloads. The macro
integration check verifies exact redefinition-site hover, unique macro-use
hover, continued replacement text, complete macro-block hover, and no
replacement preview on an ambiguous macro use.

Compiler-selected macro redefinition, 2026-10-11: preprocessor epochs already
distinguished multiple `#define` instances sharing one compiler symbol, but
editor resolution used the first source declaration for all of them. The model
now retains each declaration instance and selects the active one for macro
signatures and completion using the compiler-recorded invocation epoch. If one
physical token was observed under conflicting active definitions, its resolved
macro target is withheld. The VS Code host regression verifies that a use after
redefining `SCALE_VALUE` shows the active `item` formal; the compiler-macro unit
suite passes 16/16.

Compiler signature defaults, 2026-10-11: native inventory already supplies the
compiler-selected parameter mode, type, and optionality, while the paired
source declaration retains the exact default expression. Signature help now
uses that source spelling only when it matches an optional compiler parameter;
unknown, missing, or overly long defaults keep the prior `= ...` fallback.
The focused host test checks the default `1.5` for an optional `Double` declared
on a prototype even though the implementation uses a different parameter name;
compiler-selected signature resolution remains unchanged.

Compiler-selected declaration type hints, 2026-10-11: a native inlay-hint
query reports FBC's resolved type for physical variables, constants, parameters,
and function results that omit an explicit `AS` clause and type suffix.
Recovery-provisional declarations and explicit/suffix-typed declarations are
omitted. Type resolution remains compiler-owned; the conservative syntax check
only decides whether the source already writes a type. The focused VS Code
host test verifies implicit variable, inferred constant, implicit parameter,
and implicit function result hints, with explicit and suffix-typed declarations
omitted.

Offline API reference refresh, 2026-10-11: regenerated `data/language-reference.json`
from the current FreeBASIC 1.20.4 checkout at `888500399460ed4fd71d5ef99388297987a631b2`.
The reference contains 614 names, including compiler-header provenance for
public bundled types that also have manual entries. Its
reproducibility/header-attribution tests pass 3/3.

Bundled-header Quick Fix, 2026-10-11: FBC's exact undeclared-name diagnostic
and the offline API reference can offer an include fix for an undeclared API
routine or a missing type in an `AS` clause when every matching reference
points to one bundled `.bi` header/namespace pair. The edit adds `#include once`
and the needed `Using` directive after `#lang` when present; ambiguous names
and already-mentioned headers are withheld. Focused VS Code host cases resolve
`Gfx3SurfaceLoad` through `fbgfx3.bi` and `Event` through `fbgfx.bi`, then rerun
FBC to verify both diagnostics clear.
The focused host check also reports a missing `Event` type in an included
header, applies the header-local fix, and confirms the diagnostic clears when
the root module is checked again.

Bracket balancing Quick Fixes, 2026-10-11: unclosed-delimiter warnings now
offer insertion of the expected closer at the source mismatch or end of file;
unexpected closers offer removal. Fix positions come from the same lexical
scan that produces the warnings, and compiler-confirmed inactive ranges are
used again when code actions are requested. VS Code host checks apply both
forms of fix and confirm the corresponding bracket diagnostics clear.

Sidecar type-definition navigation, 2026-10-11: ordinary `fbc` analysis
already provided compiler-selected expression types but withheld type-definition
navigation without the editor bridge. The provider now maps a compiler type
spelling to a physical workspace declaration only when exactly one visible,
non-conditional source declaration matches. A focused VS Code host check uses
the normal compiler, not the bridge, and confirms an inferred UDT call result
navigates to its declaration; ambiguous and conditional candidates remain
withheld by construction.

Sidecar-selected member completion, 2026-10-11: ordinary `fbc` expression
sidecars now refine member completion after calls when the compiler-selected
result type maps to one visible, non-conditional source declaration. This
prevents unioning members from unselected overload return types. A focused host
check uses two overloads returning different UDTs and confirms that the
`Double` overload offers only its own member without the editor bridge.

Sidecar constant type hints, 2026-10-11: when an ordinary FBC sidecar snapshot
is already current, exact physical initializer-expression types now provide
inlay hints for untyped constants and for implicit `Dim` initializers in the
legacy dialects that permit them. Explicitly typed, suffix-typed, ambiguous,
recovery-provisional, inactive, and unmatched initializer spans are omitted.
The provider does not start compiler analysis solely to populate these hints.
The no-bridge VS Code host check compiles a constant in normal mode and an
implicit `Dim` in deprecated mode, receives the compiler-selected `Integer`
hints, and retains the existing expression type and navigation checks.

Sidecar overload definition selection, 2026-10-11: when the source resolver
returns multiple visible function/property candidates, ordinary FBC expression
types can select Go to Definition if exactly one candidate's declared or
resolved return type matches the compiler-selected call result. A current
sidecar is reused or compiler analysis is requested for the explicit navigation
action; ambiguous matches preserve the existing result. Signature help uses
the same unique match as its active signature while retaining all candidates,
and hover presents only the selected declaration. The focused no-bridge host
test confirms `chooseResult(CDbl(1))` opens, highlights, and hovers the
`DoubleResult` overload, matching the member-completion result.

Sidecar overload document highlights, 2026-10-11: the normal workspace
resolver's reference scan omitted overloaded call sites it could not uniquely
bind. A bounded worker query now returns physical direct-call expression spans
with compiler result types for the current file. Highlights add only calls
whose visible declaration family and overload signature match the selected
sidecar type; conditional, ambiguous, incomplete, or oversized results are
withheld. The focused no-bridge VS Code test highlights the `Double` call and
its declaration, while excluding the `Integer` overload call.

Sidecar overload references, 2026-10-11: ordinary FBC Find References now
augments workspace resolver results with physical call sites from the current
translation unit, including included headers, when the sidecar result type
uniquely matches the selected overload signature. Existing workspace results
remain, while ambiguous or incomplete sidecar call records add nothing. The
focused host check confirms selected `Double` calls in both the module and an
included header are returned, while the `Integer` call is excluded.
When the cursor is on a declaration from a visible overloaded family, the
declaration itself supplies the target signature and the same sidecar call
index finds its calls without needing an expression type at the declaration.

Go to Implementation, 2026-10-11: the editor now registers VS Code's
implementation provider. Native snapshots follow the compiler-selected
declaration target; the source index pairs visible `DECLARE` procedures with
non-DECLARE bodies by qualified name and parameter signature. The focused host
test follows `Geometry.Point.SetX` from its included-header declaration to its
out-of-line body.

Go to Declaration, 2026-10-11: the editor now follows procedure calls or
bodies back to matching `DECLARE` prototypes. Native compiler families supply
prototype identities directly; the source index matches qualified callable
signatures. The focused host check follows `origin.SetX` to its declaration in
`types.bi`. The ordinary-FBC sidecar fixture also verifies that
`chooseResult(CDbl(1))` navigates to the matching body and that the body returns
to its matching `DECLARE` prototype, not the other overload. The native bridge
fixture verifies that a selected `Double` overload reaches only its matching
prototype and implementation, not the `Long` sibling.

Missing include-path Quick Fix, 2026-10-11: an FBC `File not found` error on an
include directive can now offer a corrected relative path when exactly one
workspace or configured-include `.bi` has the requested basename. The fix is
withheld for incomplete indexes or duplicate basenames. The focused host check
replaces a bad nested path with a unique external header in `includePaths` and
confirms the source compiles.

Compiler typo Quick Fixes, 2026-10-11: an undeclared variable, explicit
procedure call, or missing type can now offer a spelling correction when
exactly one visible declaration is within one insertion, deletion, substitution,
or adjacent transposition. Short names, type-suffix mismatches, qualified names,
and ambiguous candidates are withheld. The focused host check applies a unique
variable correction and procedure-call correction, fixes an adjacent-
transposition local type name, and corrects bundled API and public bundled-type
typos while adding their unique header/import. FBC clears each diagnostic after
the fix, and two equally close visible names do not produce a guessed edit. A
current, complete compiler snapshot may supply visibility when the workspace
index is incomplete; partial compiler snapshots never do. Bundled reference
suggestions require one name and one header/namespace mapping.

Include operand completion, 2026-10-11: completing inside quoted or angle-bracket
`#include` paths now lists matching `.bi` files and folders from the source
directory, configured include paths, compiler `-i` paths, and discovered
compiler include folders. Selecting a folder retriggers completion for that
nested path. Directory scans, roots, path lengths, and result counts are
bounded; comment text, absolute paths, stale documents, and cancelled requests
do not produce items. The focused VS Code check selects a nested configured
folder, completes the header, applies both range/text edits, and verifies the
resulting include with FBC.

Call completion snippets, 2026-10-11: a unique visible `Function` or `Sub` with
parameters now inserts a snippet containing named parameter placeholders.
Indexed getter properties and unique parameterized macros do likewise;
properties that share a name with a setter stay name-only. Defaulted trailing
arguments are omitted; prototype/body parameter metadata is merged so an
implementation without repeated defaults preserves prototype optionality.
Overloaded or duplicate names remain name-only, avoiding a guessed signature.
Focused host checks verify `SetX(newValue)`, `IndexedValue(index)`, and
`SELECT_GENERATED(value)`, omit defaulted `scale`, and confirm overloaded
`SelectValue` completion does not insert parameters from one arbitrary overload.
Manual-reference function completions also use snippets only when overloads
agree on required argument names; `Sin(angle)` and `Screenres(width, height)`
are checked, with `Screenres`'s defaulted trailing arguments omitted.

UDT type hierarchy, 2026-10-11: VS Code's Type Hierarchy now follows direct
base and derived-type links. Native snapshots use compiler-owned base-symbol
identities; the lightweight source model resolves an unambiguous visible
`Extends` type. Incomplete source indexes and provisional recovery declarations
do not publish partial hierarchy results. Focused host checks follow
`ColoredPoint` to `Point` without the bridge and `DerivedSelector` to
`BaseSelector` with native analysis.

Procedure call hierarchy, 2026-10-11: VS Code's Call Hierarchy now follows
incoming and outgoing procedure calls. Native snapshots use FBC's selected
procedure bindings and physical call origins. The source fallback indexes only
explicit-parenthesis calls that resolve to one callable plus standalone calls
to zero-argument `Sub`s and bare zero-argument `Function`s used as a complete
simple expression, plus unambiguous bare getter `Property` accesses in simple
expressions, and excludes procedure declaration tokens. Top-level calls
are grouped under a synthetic module item
that also exposes that module's outgoing calls. Macro-generated call sites
whose callee identifier maps to a physical macro argument are retained by the
native path; replacement-list-only callees remain omitted because they have no
physical call token. Focused host checks verify `LeafValue` callers, including
the macro argument call, `RootValue` callees, and the module-level `RootValue`
call in both native and source modes.

Expand Selection, 2026-10-11: VS Code's selection-range provider now nests the
token at the cursor, matched `()`, `[]`, or `{}` group, containing logical
statement, comment/region folds containing the cursor, enclosing parser scopes,
and the full document. It uses the current
buffer's local parser model and does not start compiler analysis or workspace
indexing. The focused host check expands a value through its argument group,
`Return` statement, containing function, and document.

Block-comment folding, 2026-10-11: the source parser now returns VS Code comment
folding ranges for multiline `/' ... '/` comments, including nested comments.
The focused parser and host checks cover nesting and ensure comment-like text
inside strings does not start a fold.

Bracket auto-closing, 2026-10-11: native `()`, `[]`, and `{}` matching remains
available in code, but automatically inserted closers are now suppressed in
string and comment scopes. The focused host check verifies suppression in both
contexts and confirms that a code-context opener still receives its closer.

Import folding, 2026-10-11: consecutive physical `#include` and `USING`
directives now form VS Code import-kind folding ranges. The focused parser and
host checks verify grouped directives use the Imports folding category.

Line-comment folding, 2026-10-11: contiguous comment-only apostrophe and `REM`
lines now use VS Code's comment folding category. Inline comments are ignored,
and `#region` markers remain region folds rather than overlapping comment folds.

Continuation folding, 2026-10-11: multi-line statements joined by FreeBASIC's
underscore continuation syntax now receive folding ranges. The focused parser
check confirms continuation markers inside strings and comments do not create
folds.

Test-bridge hook refresh, 2026-10-11: current FBC passes a `numeric_head` output
to `ppReadLiteral`; the instrumented bridge now preserves that output and adds
its editor source-map output separately. Macro-definition hooks now retain
FBC's existing committed-symbol local when attaching the map. The full unit
runner rebuilt the bridge and ran 547 checks; 546 passed before one stale
hard-coded Outline line assertion was updated to use the macro/parameter
identity relation. That focused native Outline test passed after the update.

Label completion, 2026-10-11: label symbols remain available before their
forward declaration inside the same source procedure, and completion offers
them only after `GOTO`, `GOSUB`, or `RESTORE`. Compiler-backed QB contexts also
retain physical numeric labels. Focused source and native VS Code checks cover
forward-name filtering and QB `&H` label completion.

Indexer signature help, 2026-10-11: signature context scanning now handles
square-bracket nesting and argument commas. Source mode resolves `Operator []`
from the receiver's declared UDT type; native mode uses the same type-member
lookup and returns the compiler declaration family. Focused host checks verify
the operator parameter label and active parameter in both modes.

Indexer overload selection, 2026-10-11: the semantic sidecar's overloaded
`index` fact identifies the physical expression, and its matching native trace
graph retains the selected operator call target. Compiler-backed navigation now
matches that target to the native symbol family for declaration, definition,
and implementation; signature help keeps all visible overloads but activates
the selected one. Native Find References and document highlights also include
the physical index expressions for the selected overload, whether navigation
starts at the use or its declaration. Focused Long/Double overload fixtures
verify that literal arguments select the compiler-chosen family and keep
references separate. Hover and Type Definition on an index expression use the
result type of that full compiler expression, rather than the index argument's
type. Source Hover remains a conservative overload-family presentation.
Native Call Hierarchy now prepares indexer operators directly from an indexed
expression and maps incoming and outgoing edges to their physical ranges,
including module-level calls. Source mode remains a conservative
candidate-family fallback.

UDT constructor Signature Help, 2026-10-11: calls such as `WrappedValue(5)`
now resolve constructor prototypes from the type's semantic members in source
mode. Native expression traces activate the selected constructor when they
record a target call node. For `NEW Type(...)`, the first Signature Help request
upgrades only that snapshot to the full binding sidecar if it does not already
contain implicit-constructor facts. The selected target signature then
activates the exact overload; ordinary analysis remains expression-only. The
editor bridge joins through native identities. Stock sidecar-only FBC records
now retain procedure source ranges, allowing an exact target procedure to map
back to its physical constructor definition in the source index. A native
bridge host check and a stock-FBC host check both confirm a `Double` argument
selects the `Double` constructor from an overloaded `Long`/`Double` pair.

Unique `NEW` constructor completion, 2026-10-11: after `NEW` and a type-name
prefix, completion inserts a named-parameter snippet when exactly one visible
aggregate type and one declared constructor match. Overloaded, conditional,
provisional, truncated, or otherwise ambiguous sets keep the type name only.
The source and native host checks verify `WrappedValue(${1:source})` and source
overload suppression.

UDT constructor Hover, 2026-10-11: hovering over a type-call callee now shows
its constructor declaration alongside the compiler expression result type.
Native Hover activates the selected constructor where the expression graph
records a call target; source mode shows the declared constructor family.
Focused source and native host checks cover the constructor signature.

Compiler-selected `NEW` constructor references, 2026-10-11: explicit Find
References on a constructor declaration, or on a `NEW` type-call, requests the
full binding sidecar on demand. The editor bridge joins through native
identities; stock FBC maps the semantic procedure record's physical definition
back to its source constructor family, including its matching prototype when
Find References requests declarations. Physical allocation sites are matched
to the selected constructor, while conflicting repeated-include selections
are withheld. Document highlights reuse the same exact occurrences. Focused
worker and VS Code checks verify that the `Double` constructor sees only its
matching `NEW` call, not its `Long` sibling, in both bridge and stock-sidecar
modes.

Stock-sidecar exact overload bindings, 2026-10-11: FBC already links selected
written-callee bindings to AST call nodes, but the extension had only used
compiler-selected result types for ordinary overloads. The sidecar query now
joins those call links to physical declaration sites and selects the matching
source signature when result-type matching is ambiguous. This covers same-
result overloads in Signature Help, hover, definition/declaration/implementation
navigation, and call-site references/highlights. A full binding sidecar is
requested only for explicit overloaded-call interactions; its physical
expression facts are retained so the stronger snapshot does not degrade type
hovers or inlay hints. The stock-FBC host regression passes with two overloads
both returning `Long`, and verifies the selected `Double` parameter across those
editor operations.

Stock-sidecar indexer overloads, 2026-10-11: the full FBC expression sidecar
records the selected semantic symbol on overloaded `index` expressions, but the
extension had discarded that identity to avoid mixing compiler and native ID
spaces. It now retains the ID separately, joins it to the compiler procedure's
physical source location, and matches the source overload family. Full sidecar
requests retain overloaded index-expression records from included files as
well as the active module. Stock-FBC Signature Help, hover, definition,
declaration, implementation, references, and document highlights now select
the exact `Operator []` overload even when both overloads return `Long`. The
focused host regression confirms a `Double` index excludes its `Long` sibling,
references work from both use and declaration, and an unopened nested include's
selected use is retained without its `Long` sibling.

Stock-sidecar overloaded operators, 2026-10-11: the `O` receipts already
contained FBC's conceptual operator code, exact physical token range, selected
symbol, and overload kind, but the decoder did not expose them to the editor.
These records now flow into sidecar snapshots. When an expressions-only fact
identifies an overloaded operator at the cursor, the extension upgrades that
request to the full sidecar and uses the physical `O` receipt plus its procedure
record for definition, implementation, hover, references, and document
highlights. Built-in operators do not trigger the full binding upgrade. A
focused stock-FBC host test verifies that same-result `Operator +` overloads
select the `Double` target at the operator token, including references started
from the definition.

Stock-sidecar call hierarchy overloads, 2026-10-11: ordinary source-call
bindings now supply exact overload targets to the source Call Hierarchy path.
Incoming calls omit same-result sibling overloads, outgoing module calls retain
both distinct targets, and preparing Call Hierarchy directly at a call selects
the compiler-bound declaration. Full bindings are requested only when a user
invokes Call Hierarchy. The stock-FBC integration fixture verifies a `Double`
call is kept separate from its `Integer` sibling across these paths.

Stock-sidecar operator Call Hierarchy, 2026-10-11: physical overloaded
operator receipts now connect operator definitions to their source-level use
sites in incoming/outgoing Call Hierarchy. Preparing at an operator token uses
the compiler-selected target; module edges retain both overloads while incoming
edges exclude the sibling with the same result type. Operator declaration
spans take precedence over ordinary token lookup, which keeps names such as
`Delete[]` distinct from the scalar `Delete` prefix. A stock-FBC integration
fixture checks a `Double` `Operator +` use against a same-result `Long` sibling
and the incoming edge from a `Delete[]` declaration.

Stock-sidecar cast-operator navigation, 2026-10-11: FBC's physical `cast`
receipt is now usable at conversion callees such as `CLng(value)`. When the
expressions-only fact identifies a selected overloaded cast, definition,
implementation, hover, references/highlights, and Call Hierarchy map to the
physical `Operator Cast` declaration. Built-in conversions do not trigger the
full binding upgrade when their expression fact already says `builtin`. The
stock-FBC regression verifies the call, declaration-origin reference, and
module Call Hierarchy edge.

Stock-sidecar math-operator navigation, 2026-10-11: physical operator receipts
for math intrinsics now use the same route at callees such as `Abs(value)`. The
stock-FBC integration verifies definition, hover, references, and Call Hierarchy
for an overloaded `Operator Abs`; built-in math facts do not request full
bindings when the expression sidecar identifies them as builtin.

Stock-sidecar assignment-operator navigation, 2026-10-11: assignments whose
left-hand UDT exposes `Operator Let` now use FBC's physical `assign` receipt to
map the written `=` to its selected procedure. The source type/member check is
only a candidate gate; the sidecar supplies the exact target. Built-in
assignments do not trigger the full binding upgrade. The stock-FBC integration
fixture checks definition, hover, references, and incoming/outgoing Call
Hierarchy for an overloaded UDT assignment.

Stock-sidecar indexer Call Hierarchy, 2026-10-11: selected index-expression
facts now connect `Operator []` definitions to full physical `receiver[index]`
source ranges. Preparing at an index expression selects FBC's overload;
incoming edges omit same-result sibling indexers, while module outgoing edges
retain both available overloads. The stock-FBC integration check covers a
`Double` index against a same-result `Long` overload.

Stock-sidecar constructor Call Hierarchy, 2026-10-11: physical `NEW`, local
default/initializer, and return-construction facts now retain exact targets and
source ranges for Call Hierarchy. Preparing at `NEW Type(...)` or bare `NEW Type`
selects the compiler-bound constructor; ordinary `Type(...)` expressions also
prepare on their selected constructor. Incoming and outgoing edges show local
default initialization, explicit local conversion, and return construction.
The stock-FBC integration fixture verifies `Double` and `Long` `NEW` overloads
do not cross their respective edges and covers bare `NEW`, local default and
initializer construction, and return construction.

Stock-sidecar argument-constructor Call Hierarchy, 2026-10-11: an explicit
Call Hierarchy request on an actual argument now consults FBC's physical
`argument-constructor` fact when no written callee exists. Facts at the same
argument range are grouped by implicit-call kind, so the selected conversion
constructor is preferred over temporary cleanup for the source-level call.
Find References and document highlights from a constructor declaration also
include these physical argument-conversion sites. The full binding snapshot is
requested only for explicit Call Hierarchy, reference, or highlight actions. A
stock-FBC integration fixture verifies that `Long` and `Double` arguments
select their corresponding constructor, incoming call site, references, and
highlights without crossing overload edges.

Stock-sidecar local destructor Call Hierarchy, 2026-10-11: physical
`destructor-call` records now connect local UDT instances to their selected
destructor. Procedure outgoing calls and destructor incoming calls both retain
the declaration range. The stock-FBC fixture verifies a local default instance
and an initialized instance.

Stock-sidecar temporary destructor Call Hierarchy, 2026-10-11: physical
`temporary-destructor` facts connect compiler-created UDT temporaries to their
selected destructor. The edge uses FBC's completed expression range, including
member access, rather than guessing a lifetime from syntax. The stock-FBC
fixture verifies incoming and outgoing edges at a temporary-return expression.

Stock-sidecar DELETE destructor Call Hierarchy, 2026-10-11: physical
`delete-destructor` records map explicit `DELETE` sites to the selected UDT
destructor. Preparing on the `DELETE` keyword returns that destructor, incoming
calls point to the module/procedure site, and module outgoing edges include it.
The stock-FBC integration fixture covers scalar `DELETE` and `DELETE[]` and
confirms both physical keyword ranges.

Stock-sidecar allocation-operator navigation, 2026-10-11: FBC now emits
physical operation receipts for the custom allocator/deallocator selected by
`NEW`, `NEW[]`, `DELETE`, and `DELETE[]`. The AST builders return a borrowed
reference to the exact lowered CALL while the parser still owns the keyword's
physical location; code generation and AST ownership are unchanged. The
extension uses the conceptual `allocate`, `allocate-array`, `deallocate`, and
`deallocate-array` facts to provide definition, hover, references, highlights,
and Call Hierarchy at those keywords. Stock-sidecar VS Code checks cover all
four forms. The optional editor bridge now consumes the same selected AST call
on compilers with native operation receipts instead of re-running allocation
selection. Placement `NEW` operands remain separate: even an overloaded
expression used to choose a placement address does not become a false allocator
receipt. When `DELETE` invokes both a destructor and a custom deallocator, the
provider retains both selected targets, with the existing destructor first.

Stock-sidecar UDT iterator operators, 2026-10-11: FBC now emits physical
operation receipts for the selected `Operator For`, explicit `Operator Step`,
and `Operator Next` calls. The loop parser retains the actual `FOR`, `STEP`, and
`NEXT` token locations until it has selected each operator, so the facts do not
guess from source text or confuse an implicit default step with a written
`STEP`. The extension uses those receipts for definition, hover, references,
highlights, and Call Hierarchy. Focused compiler-side tests verify exact token
ranges and unchanged generated output; the VS Code fixture exercises all three
keyword paths. The full-binding request is gated on a matching visible
iterator-operator declaration, so ordinary scalar loops keep the expression-
only analysis path.

Stock-sidecar scope-exit destructor Call Hierarchy, 2026-10-11: physical
`scope-exit-destructor` facts now connect GOTO/RETURN/EXIT/CONTINUE sites to the
exact departing local's destructor. The query keeps distinct destructor targets
separate when one control transfer exits multiple objects. The stock-FBC
integration fixture verifies `EXIT SUB` produces incoming and outgoing edges for
the local UDT destructor.

Compiler-selected constructor Go To Definition, 2026-10-11: F12 on explicit
`NEW Type(...)`, bare `NEW Type`, and ordinary `Type(...)` constructor calls now
uses the selected physical constructor receipt instead of landing on the UDT
declaration. The editor requests the full binding model only for constructor
callee navigation, and the bridge query maps the receipt back to its source
implementation. Stock-sidecar and bridge integration checks cover selected
`Long`/`Double` overloads, bare default construction, and return construction.

Compiler-bridge implicit argument-constructor Go To Definition, 2026-10-11: F12
on an actual argument now follows the physical `argument-constructor` receipt to
the selected constructor. The full binding model is requested only for explicit
navigation inside call arguments, and an existing source definition takes
priority when the cursor is on a declared symbol. Worker and VS Code checks
verify that `Long` and `Double` conversions remain on their selected overloads.

Compiler-bridge implicit-constructor references/highlights, 2026-10-11:
constructor declaration queries now use physical procedure records to select
the constructor family in bridge snapshots as well as stock-sidecar snapshots.
Physical implicit-call receipts are joined through semantic-to-native symbol
identity for bridge queries, keeping sibling constructor overloads out of
References and document highlights. The native bridge integration verifies
both argument conversions from each overload declaration.

Implicit argument-constructor navigation from the use site, 2026-10-11: F12,
Go to Declaration, Go to Implementation, Find References, and document
highlights now use the compiler-selected `argument-constructor` receipt when
the cursor is on a converted call argument. Source definitions win when the
cursor is on a declared symbol. Stock-sidecar and bridge checks verify that
`Long` and `Double` sites do not cross-reference each other.

Compiler-bridge argument-constructor Call Hierarchy, 2026-10-11: preparing
Call Hierarchy on a converted argument now uses the physical constructor
receipt to select its overload. The selected item retains a source-index
identity so incoming physical argument edges and outgoing constructor-body calls
can use the same implicit-call records as the stock-sidecar path. The
binding-capable model is requested only for this explicit hierarchy action. The
bridge-host regression checks both `Long`/`Double` selections, excludes the
sibling edge, and verifies an outgoing constructor-body call.

Compiler-bridge constructor-call Call Hierarchy, 2026-10-11: explicit `NEW`
overloads, bare default `NEW`, and ordinary return construction now prepare the
selected constructor and expose the physical incoming source edge. The bridge
host regression checks the overloaded `Long`/`Double` calls and both default
construction forms alongside the stock-sidecar coverage.

Constructor-declaration Call Hierarchy in the bridge, 2026-10-11: preparing on
an out-of-line constructor prototype or body now resolves through its physical
procedure record to the matching implementation and incoming call sites. The
host regression verifies a `Long` prototype does not pull in the `Double`
overload.

Bridge scope-exit destructor Call Hierarchy, 2026-10-11: explicit GOTO/RETURN/
EXIT/CONTINUE sites now use physical `scope-exit-destructor` receipts to prepare
the departing destructor and recover its incoming source edge. The bridge-host
regression verifies `EXIT SUB` maps to the UDT destructor.

Compiler-bridge allocation/deallocation operator navigation, 2026-10-11:
remote compiler snapshots now use the same physical operator receipts as the
stock-sidecar path for Go to Definition, Declaration, Implementation, References,
document highlights, hover, and Call Hierarchy. This also covers ordinary
overloaded operator expressions and UDT `FOR`/`STEP`/`NEXT` sites. The bridge-host
regression checks custom scalar and array allocator targets and their incoming
physical edges, scalar/array deallocator targets, the full `DELETE[]` provider
surface, two-overload binary selection with sibling-excluding References and
Call Hierarchy, word `AND`, overloaded CAST and ABS receipts, compiler-selected
`Operator Let` assignment navigation and hierarchy, and definition/incoming
edges for simple and indexed lvalues, overloaded `Operator =` without confusing
it with plain assignment, and definition/incoming edges for each iterator
operator. Preparing Call Hierarchy from the `Operator Let` prototype also
recovers both assignment sites; Find References and document highlights started
at that declaration include both simple and indexed uses. The delete fixture
omits a destructor so the VS Code test command can round-trip the single
prepared item; destructor Call Hierarchy is covered separately. When both a
destructor and custom deallocator are selected, the provider retains both
targets with the destructor first. The VS Code test command collapses that
multi-target result and drops its opaque item data, so combined incoming edges
are not asserted through that command.
Full operator bindings are requested only when the source model exposes a
matching overload candidate; ordinary assignments stay on the lighter path.
Remote symbol hovers defer building the source operator index unless the cursor
is on an operator-shaped token.

The same gate now covers remote Find References and document highlights, so an
ordinary symbol query does not force source-index construction. Partial semantic
models without source-index methods fail closed for operator candidates instead
of throwing. Definition, Declaration, and Implementation now use the same lazy
source-index path; ordinary remote symbol navigation stays on the compiler
snapshot, while operator tokens, constructor calls, and call arguments retain
the specialized source-backed checks. Focused provider tests cover the ordinary
symbol fast path and partial-model handling. Call Hierarchy preparation also
uses the remote compiler query first for ordinary calls; only a missing item at
constructor-call syntax triggers the source-backed constructor check.

Signature Help now returns before requesting a compiler model when the
triggering position is not inside a call or index expression. This prevents
stray punctuation triggers, such as a comma in a declaration, from starting
on-demand analysis. The focused provider test verifies the skipped request,
and the VS Code operator-signature check still passes.

Definition, Declaration, Implementation, Find References, and document
highlights no longer request full compiler bindings merely because the cursor
is inside a call argument. The source model checks for an ordinary symbol before
the model is selected; that path stays light, while symbol-free argument
expressions request compiler-selected implicit-constructor facts. Focused
provider coverage and stock-sidecar plus bridge integration checks verify both
paths.

Inlay Hints now avoid starting bridge analysis for visible ranges that contain
no source declaration capable of receiving an implicit type hint. The prefilter
is deliberately disabled for files with includes or macro definitions, where
expanded declarations may not appear in the source parse. The focused test
checks both the skipped request for explicit-only declarations and the retained
compiler query for a potentially hintable declaration; the VS Code host check
still verifies emitted native type hints.

Hover now filters line comments, indentation, and trailing whitespace before
requesting a model, avoiding cold compiler work when there is no hoverable token.
The check is limited to the current line; a focused test confirms that
apostrophes inside string literals still use the normal hover path, and the VS
Code comment-hover check passes.

Compound assignments now enter the compiler-selected operator path. The FBC
semantic model already reports stable `add-assign`, `subtract-assign`, and
related concepts, but the editor did not recognize their physical spellings as
operator tokens. Symbolic forms and word forms such as `Mod=` now qualify for
receipt lookup. Focused tests cover the candidate gate; stock-sidecar and bridge
host checks verify symbolic `+=`, word-form `Mod=`, and their documented
`+=>`, `Mod=>`, and `=>` aliases through compiler-selected Definition and Call
Hierarchy. The bridge References assertion also excludes the built-in `+=` in
the overload body. The simple `=>` alias is gated by a visible `Operator Let`
on the left-hand type, so it is not mistaken for overloaded equality.

Intrinsic `Len(udt)` overloads retain their selected target in physical typed
expression facts rather than operator-operation records. The extension now
uses those facts as a conservative fallback for operator selection, References,
and Call Hierarchy when no exact `O` receipt exists. The expression query is
accepted for full bridge snapshots as well as stock sidecar snapshots. Focused
stock-sidecar and bridge host checks verify `Operator Len` Definition,
References, Call Hierarchy, and its physical incoming edge.

Field assignment `Operator Let` gate, 2026-10-11: the source candidate check
now tests the final top-level lvalue name before its containing object, so
assignments to UDT-valued fields reach FBC's exact physical assignment receipt.
Identifiers inside index/call arguments are skipped to keep ordinary indexed
writes on the expression-only path. Focused unit coverage checks both behaviors;
the native bridge integration verifies field assignment Definition. The parser
also keeps the `()` operator suffix separate from constructor argument lists,
so `Constructor%()` retains the correct symbol range.

Multiline Signature Help context, 2026-10-11: call-context discovery now keeps
open call frames across line breaks and counts commas only at the active call's
top delimiter level. Nested parentheses, square brackets, and brace initializers
no longer shift the active parameter; incomplete brace expressions retain their
enclosing call while the user is typing. The focused parser suite passes 30/30.

Implicit variable type hints, 2026-10-12: the native inventory records undeclared
FBLite loop counters, first-use assignment targets, and `INPUT`/`READ` target
lists, including prompt forms and file-channel `INPUT #`, as physical variables
with compiler-selected types. Their generated display signatures must not be
mistaken for source-written `AS` syntax. Inlay
hints now use the original source statement and native declaration binding for
these cases, so an unrelated `AS` in a colon-separated statement does not hide
an implicit type.
The source prefilter requests bridge analysis only when a loop counter,
assignment, `INPUT`, or `READ` target does not already resolve to a declared
symbol, preserving the fast path for declared variables. Repeated physical
source sites are withheld if expansion contexts select conflicting types. A
compiler-backed model test checks the implicit types and explicit-counter
omission, focused provider tests check the prefilter, and the existing VS Code
host check covers inlay rendering.

Compiler-backed Expand Selection, 2026-10-12: the selection-range provider now
includes FBC's physical typed expression ranges alongside its existing token,
bracket, statement, and scope ranges. Ambiguous and recovery-provisional
expressions remain excluded; parser-based selections remain available when no
compiler model exists. A native model test verifies nested `b * c` and
`a + b * c` spans, and a provider test verifies they are returned in the
selection hierarchy.

Native procedure/operator reference CodeLens, 2026-10-12: a prepared bridge
snapshot now supplies overload-aware procedure reference counts and consumes
FBC's physical overloaded-operation and implicit-call receipts for operator,
constructor, and destructor declarations. Each produces clickable physical
source locations. The provider does not start compiler analysis just to
display lenses; it refreshes when the workspace model changes. Macro expansion
sites with conflicting compiler identities are excluded, and large results
fail closed at bounded limits. Provider and worker/direct parity tests cover
named procedure and implicit-constructor references. A native fixture also
verifies that FBC's physical `NEW`, `DELETE`, `FOR`, `STEP`, and `NEXT` operator
receipts reach the corresponding declaration lenses.

Compiler-selected parameter inlay hints, 2026-10-12: explicit positional calls
to source procedures and constructors now show the selected signature's
parameter names inline. FBC's committed call target and argument chain
determine the overload and ordinal; source ranges are accepted only when the
call and arguments map directly to one physical buffer. Named-argument forms,
conflicting expansions, and unrepresented/builtin targets remain unhinted. A
native overload fixture covers different parameter names and numeric/string
arguments, while the worker parity test verifies ordinary and constructor calls.

Compiler-contextual `NEXT` Quick Fixes, 2026-10-12: FBCDIA identifies the exact
`FOR/NEXT variable name mismatch` context and physical counter token. Diagnostics
now underline that identifier and offer removal only when the line contains one
counter; the compiler treats a written `NEXT` variable as a consistency check,
not an expression. The same edit is offered for FBC's `-w next` warning that a
matching name is meaningless, and for an undeclared optional `NEXT` counter
when the compiler diagnostic names the exact single identifier. Multi-counter
or structurally ambiguous forms remain untouched. Current local FBC tests cover
the mismatch, warning, and unresolved-name paths, and focused provider tests
verify the edit bounds.

Compiler-contextual EOF terminators, 2026-10-12: FBCDIA's
`unclosed-procedure` context now permits a Quick Fix only when the compiler
message names one exact expected terminator. The edit inserts that statement
at EOF while preserving the file's newline style. This also handles an inner
unclosed `IF` before its containing procedure; ambiguous combined expectations
are withheld. The current FBC bridge confirms both `END SUB` and `END IF`
diagnostics, and focused editor tests cover insertion and CRLF preservation.

Procedure-signature diagnostic ranges, 2026-10-12: when FBC reports a
`procedure-signature-mismatch`, the diagnostic's physical point can name the
procedure even if the message only describes a type mismatch. The editor now
uses that point only when the source line parses as a supported procedure
declaration and the captured line still matches. Other signatures and points
retain their existing textual fallback. Focused range tests and the current FBC
bridge's return-type mismatch cover the path.

Unsupported `ON ERROR RESUME NEXT` diagnostic ranges, 2026-10-12: FBC marks
this unsupported Visual Basic form with the `error-resume-next-syntax` context
and a physical point at `ON`, while its text error only says `Syntax error`.
The extension now labels the context and underlines the complete rejected form
only when the point and captured source agree. Other syntax diagnostics retain
their existing fallback. The current bridge and focused range tests cover both
ordinary and module-level `ON LOCAL` forms.

Unsupported `ON ERROR RESUME NEXT` Quick Fix, 2026-10-12: when that compiler-
confirmed form is the only code statement on its line, the editor offers to
remove just the rejected statement while preserving trailing comments. Mixed
statement lines are left untouched. Focused provider tests cover both cases.

Compiler diagnostic context explanations, 2026-10-12: the UI now translates
FBC's `variable-case-collision` and `declaration-suffix-as-conflict` contexts
into concise diagnostic explanations instead of showing only a generic
duplicate/syntax error. For a case-only collision, a Quick Fix removes the new
`DIM` line only when there is exactly one prior declaration in the same parsed
lexical scope, the type matches exactly (or both names are untyped and equal
ignoring case with no intervening `DEF`, include, or language directive), and
neither line has modifiers or an initializer. For the deprecated `DIM AS type` multi-declaration form, a
separate Quick Fix removes only the rejected suffix, preserving the compiler's
recovered common `AS` type. The current bridge confirms both contexts, including
the deprecated dialect's `DIM AS` form; focused provider tests reject
initializer, type-mismatch, and separate-scope cases; untyped declarations with
the same default type remain eligible.

LINE INPUT buffer-capacity diagnostic ranges, 2026-10-12: when FBC reports an
unknown-capacity character buffer without a required comma/maximum, its
`line-input-unknown-buffer-capacity` context and physical point now underline
the destination token instead of the whole statement. The range is withheld if
the source text or token no longer matches. The current bridge confirms the
pointer-target diagnostic and focused range tests verify the location.

Ignored declaration suffix Quick Fix, 2026-10-12: FBC's `Suffix ignored`
warning now offers removal of the suffix on a simple single-variable
`DIM name% AS Type` declaration. The action requires the exact warning text,
one declaration on the line, and the compiler-reported token spelling; it
removes only the ignored suffix, retaining the explicit `AS` type. The current
bridge verifies the warning and the corrected source compiles.

Deferred macro hover explanation, 2026-10-12: an exact physical identifier in
unused macro replacement text now receives a hover explaining that FreeBASIC
resolves it at expansion time. When observed invocations select different
macro definitions, the hover says the target is ambiguous; no spelling-based
target is invented. The native model verifies unexpanded, uniquely expanded,
and conflicting expansion cases, and the provider test checks both messages.

Resolved bundled API hover documentation, 2026-10-12: when FBC resolves a
symbol to a physical bundled-header declaration, hover adds the matching
offline reference entry using the compiler's qualified name and declaration
header. Project declarations with the same spelling do not inherit the API
documentation. Focused provider tests check both the matching-header and
project-source cases; a current-compiler model query verifies the qualified
name and physical header used for the documentation match.

Offline reference suffix lookup, 2026-10-12: reference lookup now strips all
FreeBASIC scalar type suffixes, including `#` for `Double`. This restores the
existing manual hover and signature data for suffixed builtin names such as
`Sin#`; the reference test checks entries, signatures, and hover text.

Overload completion details, 2026-10-12: when visible declarations share a
completion name but have distinct signatures, the item now lists up to eight
signatures in its documentation and reports the signature count. It continues
to insert only the name when the compiler/source candidates do not prove one
safe call shape. The focused provider test checks both overloads and the
name-only insertion.

Compiler-confirmed undeclared `NEXT` counters, 2026-10-12: the current FBC
semantic diagnostics identify failed optional counter bindings with
`for-next-counter-binding`. The editor explains that context and now offers
counter removal only when the physical `NEXT name` range, undeclared-name
message, and exact compiler context agree. Focused Quick Fix coverage rejects
the same text without the FBC context, and the current compiler test verifies
the emitted context.

Nested bracket Quick Fixes, 2026-10-12: an unclosed outer delimiter now carries
the bounded closing sequence needed to close nested inner delimiters first,
including when a mismatch forces insertion before a later closer. Sequences
deeper than 32 closers do not receive an oversized speculative edit. Focused
analyzer and provider tests verify sequence order, insertion location, and the
depth bound.

Offline reference parameter details, 2026-10-12: hovers and completion
documentation now include unique parameter descriptions already present in
the local manual data, deduplicated across overloads and capped at twelve
entries per reference page. Focused data and hover tests verify the descriptions
appear without requiring network access.

`NEXT` counter typo correction, 2026-10-12: when FBC confirms a single-counter
mismatch or undeclared optional counter, the editor can additionally offer a
one-edit spelling correction to the active `FOR` counter if it is visible in
the semantic model. The source-only loop check supports nested simple loops
and declines preprocessor-conditional or structurally ambiguous cases. Tests
verify correction to the innermost active counter and removal-only behavior
when a conditional branch makes the expected name uncertain.

Bundled API completion imports, 2026-10-12: accepting a bundled function or
type completion now inserts its unique required header and namespace import
when absent. Imports already present are not repeated; ambiguous reference
mappings and edits that would overlap the completion are left unchanged. A
focused provider test covers function/type imports, the `#lang` insertion point,
already-imported cases, directives that occur later than the completion, and
namespaces imported only in another scope or conditional branch. Import checks
reuse one per-request source snapshot instead of rereading the document for
each API candidate.

gfxlib3 selection help, 2026-10-12: offline documentation for entries from
`fbgfx3.bi` now explains that including the header selects gfxlib3, while
`-gfx3` selects it for unchanged source. Reference and completion tests cover
the compiler-confirmed behavior.

Graphics header linkage help, 2026-10-12: reference entries from `fbgfx.bi`
now note that the header links the selected graphics runtime, and `fbgfx3.bi`
notes its gfxlib3 selection/link behavior. Focused reference and completion
tests cover the source-confirmed notes.

Namespace import completion, 2026-10-12: completion inside a `Using` directive
now presents namespace declarations only and suppresses unrelated keywords,
functions, and bundled API names. A trailing dot offers child namespaces only.
Focused provider tests verify both forms.

sfxlib header linkage help, 2026-10-12: offline documentation for the advanced
effects and raw-output headers now notes that `#inclib "sfx"` links the sfxlib
runtime automatically. Reference tests cover both headers.

Compiler-confirmed constant hover, 2026-10-12: integer, unsigned, floating-
point, and string values from schema-27 `C` records now survive decoding. Symbol values
join declarations through the exact semantic/native identity map. Hover
displays a value only when the retained facts agree, preserves 64-bit unsigned
values as decimal strings, and shows floating-point values with their exact
IEEE-754 bits. String constants retain exact bytes or wide units; a readable
preview is limited to ASCII-safe units rather than assuming a source or target
encoding. Expression values join `C` records to physical `E` identities; the
hover path uses the exact compiler range and withholds recovery or conflicting
values.

Compiler-confirmed constant completion details, 2026-10-12: the same unique
integer, floating-point, or string value is now shown alongside a named
constant's type in completion results. Floating-point details retain their
exact IEEE-754 bits; string details retain exact payloads and safe ASCII
previews. Conflicting facts and recovery declarations do not display a value.
Provider tests cover exact 64-bit unsigned text, string bytes, and conflicts.

Compiler-confirmed constant Outline details, 2026-10-12: native document
symbols now show the same unique numeric or string value beside named
constants. Floating-point details retain their exact IEEE-754 bits; strings
retain their exact bytes or wide units. Conflicting values and recovery
declarations remain unannotated. The current FBC-backed model test verifies
both float bits and string bytes survive into the Outline record.

Stock-sidecar constant hover, 2026-10-12: ordinary FBC sidecar bindings now
provide exact numeric or string values when the hovered source token resolves
to one constant symbol. The editor asks for full bindings only at a
constant declaration/reference; unrelated or unresolved hovers do not request
that pass.
Focused provider and worker tests verify declaration/reference lookup and exact
constant text.

Stock-sidecar constant completion details, 2026-10-12: completion now requests
the compiler values for a bounded set of physical declaration sites only when
the typed prefix matches visible named constants. Batch lookup joins those sites
through compiler declaration bindings, preserving exact unsigned values,
floating-point bits, and string payloads while withholding conflicting
identities. Provider and worker tests cover the prefix gate, the site batch,
and exact value text.

Compiler-folded constant expression hover, 2026-10-12: `C` records now
join physical expression facts by their compiler-owned identity. Hover shows
the result only on the exact source span, aggregates duplicate observations,
and withholds conflicting or recovery values. Non-physical expressions remain
unshown. The stock-sidecar worker regression verifies that
FBC supplies `5` for `2 + 3`; the hover-provider regression verifies the value
is displayed. The expression query also carries the same bounded facts into
**Show Compiler Expression Type**, whose message adds a constant value without
changing the command's existing type-name return value.

Compiler string constant display, 2026-10-12: bounded `bytes` and `wide-units`
records now display as exact hex payloads in constant hovers, completion
details, and native Outline. Byte previews are ASCII-only; wide-unit previews
use valid Unicode scalar values and escape controls. The FBC-backed model test
verifies a string constant retains its bytes and the Outline preview; provider
and worker tests cover stock FBC.

Stock-sidecar Outline fallback, 2026-10-12: configuring ordinary FBC no longer
causes the document-symbol provider to compile only to receive no native symbol
inventory. It keeps the parser-based document Outline available; native
compiler Outline remains a bridge feature. If a binding-capable stock-sidecar
snapshot is already cached, exact constant values and normalized primitive
types for untyped variables, constants, and implicit parameters, plus exact
compiler-assigned enum values and their explicit/implicit origin are added to
matching parsed symbols through bounded declaration-site queries. Exact array
bounds are added for physical array declarations; field offsets, bit positions,
widths, and access levels are added for physical UDT fields; aggregate size and
alignment are added for physical UDT declarations. Parameter types and passing
modes use FBC's formal type and mode receipts, including the distinction
between a written mode and the compiler-selected default. Procedure details
include compiler-selected foreign ABI, unmarked scope-default visibility, and
override relationships. When FBC supplies only the selected base symbol ID, the
Outline identifies the override without inventing a target name. Scalar dynamic
String declarations show compiler-confirmed default initialization or an exact
constant initializer. The opportunistic query is capped at 256 source sites per
document and does not trigger a compiler pass for Outline. Compiler-created
implicit assignment variables and scalar `FOR` counters absent from the parser
inventory are added at their exact physical binding and nested under a
containing parsed procedure only when that scope is unambiguous. Completion
reuses the same bounded cached records and offers only prior compiler-created
locals from the cursor's containing procedure.
Parser-based Outline entries also receive the VS Code deprecated tag when an
immediately adjacent apostrophe documentation block contains `@deprecated`,
and include a bounded first-line summary for other adjacent documentation. No
compiler analysis is launched for these source-documentation details.

Compiler access-role highlighting, 2026-10-12: semantic tokens now mark
physical variable occurrences as modifications only when FBC reports a unique
`write` or `read-write` role. Bridge snapshots consume roles directly; the
stock-sidecar path uses bounded site queries only when a binding model is
already cached and does not start another compiler pass for semantic tokens.
Reads, address-taking, BYREF uses, conflicting contexts, and unclassified
occurrences do not receive the modifier. Document highlights also distinguish
confirmed reads from writes when roles are available. Focused FBC and provider
tests cover assignments, compound assignments, reads, BYREF uses, and the
cached sidecar path without triggering analysis.

Scalar `FOR` entry hover, 2026-10-12: the full semantic model's
`scalar-for-entry-results` capability now maps a parsed statement's exact
physical `FOR` token to the compiler's initial-test result. Hover reports a
proven skip or entry only when the statement, counter, capability, and mapped
source location agree; unknown, recovered, and conflicting results are
withheld. A current-FBC worker test checks both a descending skipped loop and
an ascending entered loop.

Scalar `FOR` skip inlay, 2026-10-12: the same compiler fact now adds a small
`body skipped` hint after a physical scalar `FOR` keyword when FBC proves the
initial test fails. It is limited to complete, non-recovery snapshots and the
visible source range; loops that enter normally, unsupported loop forms, and
ambiguous or stale locations receive no hint. Provider and query tests verify
the presentation and physical-source checks. Saved stock-FBC modules can use
the same result through binding-capable sidecar analysis requested only for a
visible `FOR` header; worker and provider tests cover that path.

Compiler-selected ordinary Signature Help, 2026-10-12: when source resolution
leaves multiple callable candidates, the query now uses FBC's selected call
target to activate the matching overload while keeping the alternatives
available. A compiler-backed two-overload regression verifies Integer and
Double selections, and the provider test verifies the active signature.

Stock-sidecar Signature Help, 2026-10-12: when a configured stock FBC can export
schema-27 physical call bindings, an ambiguous source-level overload set now
requests the full binding sidecar on demand and maps the selected overload back
to its exact source declaration. The visible source candidates remain intact,
and single-candidate calls do not request the extra binding pass. A worker test
checks both overload selections from physical sidecar facts; a provider test
checks candidate retention and the one-candidate fast path.

Stock-sidecar parameter inlays, 2026-10-12: the same binding-capable sidecar
now supplies formal parameter names for direct positional calls. It requires a
unique physical call target and agreement across parsed declarations of that
symbol; conflicting or unsupported signatures are withheld. The worker test
checks two selected parameter names and their source argument positions, while
the provider test verifies the binding pass is requested only for visible
ranges containing calls.

Stock-sidecar type inlays, 2026-10-12: when a visible range contains a
potentially untyped declaration, the inlay provider now requests expression
sidecar facts from ordinary FBC instead of silently falling back because no
prior hover prepared a model. The request does not ask for binding records;
the worker test confirms an inferred `Const` still receives FBC's exact type.

Manual check overlay routing, 2026-10-12: **Check Current Module** now uses the
configured editor bridge when the active source or an open included header has
unsaved changes. The normal on-save compile-only diagnostic path is unchanged;
it continues to compile saved files.

Case-only duplicate Quick Fix fallback, 2026-10-12: the editor now permits an
FBC-sourced exact duplicate-definition error to enter the existing narrow
source proof when its optional `variable-case-collision` context is absent.
The proof still requires one uninitialized same-scope declaration differing
only by case and having the same type. Other errors, non-FBC diagnostics,
initializer cases, and ambiguous declarations remain ineligible. The native
implicit-typing collision fixture now uses `-lang deprecated`, because current
FBC rejects untyped `DIM` declarations in its default mode before duplicate
detection.

Compiler-confirmed unreachable statements, 2026-10-12: the extension now
computes procedure reachability from the validated schema-27 control-flow
blocks and transfer edges. It adds an `unreachable` inlay only for a parsed,
physical executable statement whose root block is unreachable in every
observation of that source range. Opaque indirect/assembly transfers, recovery,
unmapped statements, and conflicting repeated-source observations suppress the
hint. A current-FBC worker test verifies a skipped statement after `GOTO` and
the reachable label target; the provider test verifies inline rendering. Saved
stock-FBC modules can use the same hint through a binding-capable sidecar pass
only when the parsed source contains possible control-flow transfers; a focused
provider test verifies that this remains an on-demand request.

Compiler-selected storage-width hovers, 2026-10-12: schema-27 normalized type
facts now follow uniquely matched physical source symbols into full-model hover
records. Hovers report the compiler-selected target width for one value of the
type, not an array's total size, and a UDT declaration can show its aggregate
layout size and natural/packing alignment when exact compiler facts are
available. Pointer widths are
distinguished from pointee storage, ByRef hovers describe the referenced type
rather than the caller's argument slot, and dynamic string descriptors are
distinguished from allocated character data. Conflicting or recovery type
observations are withheld. A current-FBC worker test verifies a source
variable's normalized type and UDT size reach hover, and provider tests verify
the display and storage caveats.

Compiler-confirmed array bounds in hover, 2026-10-12: fixed multidimensional
bounds, unknown upper bounds, and runtime rank/bound states from FBC's `A`
symbol details now follow exact physical source-symbol identities into hover.
The editor does not re-evaluate `OPTION BASE` or infer bounds from source text.
Conflicting dimensions, malformed groups, and recovery observations are
withheld. Fixed-array element counts are shown only when FBC's `array-elements`
property agrees with the element count from the compiler bounds. The current-FBC
worker test verifies signed lower bounds, two dimensions, and count agreement;
a provider test verifies their display and conflict suppression.

Compiler-selected field offsets in hover, 2026-10-12: physical UDT field
symbols now retain FBC's byte offset within the containing aggregate. For
bitfields, the hover also uses FBC's bit-position and bit-width properties. It
does not guess container allocation or alignment. Conflicting and recovery
observations are withheld. A current-FBC worker test verifies field and
bitfield facts reach their exact hovers, and the provider test verifies the
display.

Compiler-selected procedure ABI in hover, 2026-10-12: schema-27 procedure
signature facts now join by the exact source procedure identity. Full-model
hovers show non-default calling conventions and C/Windows/C++ symbol linkage;
conflicting convention or linkage observations are withheld. The current-FBC
worker test verifies a CDECL declaration inside `EXTERN "C"`, and a provider
test verifies the concise ABI display.

Compiler-selected parameter modes in hover, 2026-10-12: schema-27 `G` records
now join formal parameters and parameter variables to the exact source
identities. Parameter hovers show the compiler-selected ByVal, ByRef, ByDesc,
or vararg mode, including defaults not written at the declaration. Conflicting
mode observations and recovery models are withheld. A current-FBC worker test
verifies the default mode; a provider test verifies the display.

Procedure ABI policy hover details, 2026-10-12: full-model hovers now report
when a foreign-linkage procedure has no written calling-convention clause and
when a FreeBASIC STRING-based type appears in the signature. The editor
summarizes these per-header facts only when all accepted observations agree.
Current-FBC worker and provider tests verify the policies and conflict
suppression. Single-signature callable completion documentation and
Signature Help expose the same facts. Overloaded completion entries suppress
the detail rather than attributing one overload's policy to every candidate.
Parameter completion documentation also shows compiler-confirmed passing mode,
optionality, and array rank when those facts are available.
Scalar dynamic String declaration notes distinguish default initialization
from compiler-folded initializer constants, retaining exact byte or wide-unit
values.

Compiler-confirmed enum value refactor, 2026-10-12: full-model enum member
facts now preserve the physical initializer status and compiler-selected
ordinal value. A refactor writes that exact value for an implicit member only
when every matching physical observation confirms it is implicit and the
integer value is unambiguous. Current-FBC worker and provider tests cover the
mapping, edit, explicit-member exclusion, and re-analysis without new
diagnostics.

Compiler facts in completion documentation, 2026-10-12: available ABI,
parameter-passing, implicit parameter/return types, storage-width, array-bound,
visibility, field-layout, abstract-member, and scalar String initialization
facts now travel with their matching declaration completion.
Single-signature callable entries also show the compiler-selected override
target. Overloaded callable entries suppress single-declaration details.
Completion does not start an additional semantic pass to obtain these facts.

Compiler-confirmed public member visibility, 2026-10-12: full-model declaration
hovers and completion docs now show public access for contained symbols, while
module-level symbols remain uncluttered. The current-FBC worker verifies that
default-public aggregate fields retain their visibility fact.

Compiler-confirmed aggregate access summary, 2026-10-12: full-model type hovers
and type completions summarize the ordered explicit Public, Protected and
Private sections only when FBC reports a complete, non-recovery section list.

Compiler-confirmed Signature Help parameter modes, 2026-10-12: native formal
parameter mode facts now follow their exact parameter into Signature Help.
ByDesc/VarArg and optional parameters show per-parameter documentation, while
ordinary ByVal/ByRef labels remain concise. The FBC worker verifies an any-rank
ByDesc mode on the nested parameter; the provider verifies its display.

Compiler-confirmed default procedure visibility refactor, 2026-10-12: an
unqualified standalone Sub/Function definition can write its compiler-selected
Public or Private visibility when FBC confirms that the original definition
used the scope default and no prototype family is involved. The provider test
checks both insertion forms; the current-FBC worker reanalyzes the explicit
form and verifies that it preserves effective visibility without adding
diagnostics. Procedure hovers also distinguish compiler-selected scope
defaults from written access modifiers for the same exact standalone case.

Compiler-confirmed calling-convention refactor, 2026-10-12: a single foreign-
linked procedure header with no written convention and no managed STRING type
can write a supported compiler-selected Cdecl, Stdcall, Pascal, Thiscall or
Fastcall modifier at its exact source name. The worker verifies both an
implicit CDECL declaration in `Extern "C"` and an implicit Windows convention,
then reanalyzes the explicit forms without new diagnostics and confirms that
the selected conventions are unchanged. Provider tests check the Cdecl and
Stdcall edits and suppress managed-STRING or already-explicit conventions.

Earlier FBC source refresh, 2026-10-12: rebuilt the local editor bridge from
HEAD `e1dd0a04a18ca27d651180deadad421040cd150b`. The new source includes more
precise compiler receipts for overloaded `NEW`/`DELETE` and UDT iterator
operators, plus physical diagnostic points. Focused native regressions for
allocation operators, iterator operators and diagnostic columns pass 3/3. The
offline reference was regenerated from the same HEAD; it remains at 614 names
with an unchanged source-content hash.

Compiler-confirmed header linker hovers, 2026-10-12: full semantic models now
show the exact accepted `#inclib` or `#libpath` value when hovering its mapped
physical directive and on compiler-resolved declarations from the supplying
header. Compiler completions and Signature Help also show these inputs for
unambiguous declaration candidates. Header names identify the dependency
source without exposing absolute paths. Partial snapshots, unmapped locations,
and oversized policy inventories fail closed. Focused provider formatting and
native sidecar tests pass; the latter verifies directive, included-declaration
hover, completion, and Signature Help records against FBC's accepted input
receipt.

Compiler-confirmed source documentation comments, 2026-10-12: FBC's accepted
physical apostrophe-comment markers anchor adjacent `''` documentation blocks
to exact native declarations and compiler-preprocessor macro definitions from
the same file. Hovers, single-symbol completion details, and Signature Help
show the source text; Outline details use a bounded first-line summary. For
inline parameter notes on continuation lines, the compiler-selected parameter must be
the only formal on that physical line and the `''` must follow an unquoted `_`;
ambiguous lines are omitted. A unique matching `@param` or `\param` entry
(through its following untagged lines) is also attached to that formal's hover,
completion, and Signature Help slot; duplicate names and oversized text are
withheld. Ordinary comments, provisional snapshots, unmapped marker locations,
distant comments, and oversized blocks are omitted. The current-FBC sidecar
test covers an included declaration and macro and verifies the continued-
parameter note and parent `@param` text reach editor records; focused hover,
completion, and Signature Help rendering tests pass.

Compiler-documented deprecation styling, 2026-10-12: a unique compiler-backed
completion is marked with VS Code's Deprecated tag when its source documentation
contains `@deprecated` or `\deprecated`. Overload groups are tagged only when
every candidate documents deprecation; mixed groups and provisional declarations
remain unmarked. The same predicate marks declaration and reference semantic
tokens with VS Code's `deprecated` modifier and tags compiler-backed Outline
symbols. Workspace Symbol search preserves the tag only when every indexed
build context agrees. Hovers, unambiguous completion docs, Signature Help, and
Call Hierarchy items also show deprecation. Focused completion, hover, Signature
Help, workspace-symbol, and Call Hierarchy tests cover these labels; current-FBC
worker tests verify the token modifier on a declaration and call site and the
Outline metadata.

Compiler-selected Outline types, 2026-10-12: native document symbols now show
the compiler's resolved type for variables, constants, enum members, fields,
parameters, functions, and properties without rewriting the source signature.
The current-FBC sidecar test verifies an inferred constant's type in Outline
alongside its compiler value and source documentation.

Compiler-selected Outline array bounds, 2026-10-12: native array declaration
details now show fixed lower/upper bounds or runtime-array rank when the
validated sidecar provides a complete unambiguous shape. Fixed-array element
counts are included only when FBC's count matches the bounds product. The
current-FBC worker test verifies a two-dimensional array with a nonzero negative
lower bound and matching element count.

Compiler-selected Outline field layout, 2026-10-12: physical UDT field details
now include the compiler's byte offset and, for bitfields with unambiguous
facts, the bit position and width. The current-FBC worker test checks both an
ordinary field offset and a three-bit field.

Compiler-selected Outline aggregate layout, 2026-10-12: UDT, Class, and Union
details now include known aggregate size, natural alignment, and non-default
packing alignment from the compiler's current target. The current-FBC worker
test verifies aggregate size and alignment in the same FlowLayout outline record.

Compiler-selected Outline member access, 2026-10-12: contained compiler symbols
now identify their unambiguous Public, Protected, or Private access level in
Outline details. Module-level symbols remain uncluttered. The current-FBC worker
test verifies protected and private fields.

Compiler-selected Outline override targets, 2026-10-12: methods whose compiler
override relationship is unambiguous now show the selected base method in their
Outline detail. Provisional or conflicting targets are withheld. The current-FBC
worker test verifies the DerivedSelector.Choose to BaseSelector.Choose link.

Compiler-selected Outline abstract members, 2026-10-12: types with a known
positive unimplemented abstract-member count now show that count in Outline
details, clarifying why construction is currently unavailable. The current-FBC
worker test verifies the AbstractWidget count.

Compiler-selected Outline base types, 2026-10-12: inherited Type/Class symbols
now show their compiler-resolved base type in Outline details, while type aliases
are excluded. The current-FBC worker test verifies DerivedSelector's BaseSelector
relationship.

Compiler-selected Outline procedure ABI, 2026-10-12: procedures now show
unambiguous foreign linkage/calling convention and ByRef returns in Outline
details. Ordinary Basic procedures do not repeat the default convention. The
current-FBC worker test verifies a C-linked Cdecl declaration and a ByRef return.

Compiler-selected Outline parameter modes, 2026-10-12: parameter detail now
shows ByVal, ByRef, VarArg, or ByDesc with its array rank/any-rank status, plus
optionality when reported. The current-FBC worker test checks a scalar ByVal
parameter and an any-rank ByDesc parameter.

Compiler-selected Outline storage scope, 2026-10-12: assignment-created
implicit locals now show their compiler-selected external/local/global/static/
shared storage category beside the resolved type. Explicit declarations keep
their source modifiers as the display. The current-FBC sidecar test verifies
an implicit local is labeled `storage: local`.

Compiler-selected Outline type origin, 2026-10-12: declarations whose compiler
facts confirm an implicit function result, implicit parameter/variable type, or
inferred Const type now carry a concise origin note beside the resolved type.
Written `As` and suffix forms remain unmarked. The current-FBC worker test covers
implicit return, Dim, and inferred Const cases.

Compiler-selected Outline scope visibility, 2026-10-12: standalone Sub/Function
definitions whose visibility is confirmed as the module default now identify
that Public/Private default in Outline. Written visibility, prototypes, and
contained procedures remain governed by their explicit/member details. The
current-FBC worker test verifies the selected default on a standalone definition.

Compiler-selected base type help, 2026-10-12: native hover and type completion
records now preserve the resolved base type and present it alongside abstract
member/access details. The current-FBC worker test verifies the base type on a
derived declaration; the provider test verifies the displayed completion note.

Current FBC semantic refresh, 2026-10-12: rebuilt the optional editor bridge
from HEAD `3d17dc284b54a32319a8ae61dac6c8bf5ab51a04`. Its source copy matches
the current AST and semantic-expression files. The bridge route audit now
tracks FBC's new `cSerializationFunct` parser and the focused native fixture
confirms the macro-expanded intrinsic retains its compiler-selected String
result. A focused compound-assignment test also passes against the current AST
implementation. The bridge builder uses FBC's native source-range-aware
argument-constructor receipt when available, avoiding a duplicate older hook.
Compiler-hook and expression-route checks pass.

Opt-in serialization reference entries, 2026-10-12: the generated offline
reference now includes the manual forms and parameter descriptions for
`Serialize` and `Deserialize`, even though they are opt-in header macros rather
than grammar names. Completion and Signature Help can use those forms, and
completion can offer the required `fbserialize.bi` include. No parameter types
are inferred. The reference is generated from the same FBC HEAD and now covers
616 names; all four focused language-reference tests pass. The grammar also
tracks the public macros, their compiler intrinsic spellings, and the two
serialization error constants. The FBC coverage audit passes, and focused
completion, Signature Help, parser-data, and TextMate checks pass.

Bounded manual documentation cards, 2026-10-12: offline entries now retain
sanitized return and description sections from the FreeBASIC manual, skipping
embedded examples and limiting return text to 600 characters and description
text to 1800. Hovers, completions, and Signature Help show these details. The
serializer docs now explain accepted ownership, unsupported types, failure
results, unchanged destinations on decode failure, and the lack of file or
network I/O. Focused reference and Signature Help tests verify this content.

Compound-assignment operand hovers, 2026-10-12: a full semantic model now joins
FBC's `assignment-input` properties and occurrence markers to the statement's
physical operator location, closed statement outcome, selected operation
record, and retained operand expression types. A bounded summary of FBC's
nonphysical operation result supplies its result type and compiler-reported
assignment target type when both agree. Hover on the operator reports the
selected built-in/overloaded operation, compiler-confirmed operands, and the
result-to-storage types. If a destination expression's type is not retained,
that operand is omitted rather than reconstructed from source text. In
stock-sidecar mode, a full model is requested only when the cursor is on a
compound-assignment token. Recovery, incomplete,
unmapped, conflicting, and oversized groups are withheld. Focused native tests
verify built-in and overloaded assignments; provider tests cover direct and
on-demand hover paths.

Compiler expression-operation hovers, 2026-10-12: binary, unary, and supported
intrinsic operations now show FBC's source operation concept and linked operand
types when hovering the exact physical operator token. The expression result
type and built-in/overloaded classification are shown only when the compiler
reports them. Repeated include or configuration contexts that disagree retain
the ordinary type hover but withhold the operation detail. The current-FBC
sidecar test verifies typed operands and result through the hover query; the
provider test verifies the token-range gate and rendered detail.

Implicit parameter-mode Signature Help, 2026-10-12: compiler-selected ByVal or
ByRef is now documented on the active parameter when FBC confirms the mode
keyword was omitted. The mode-written property is joined to the exact parameter
and carried into Signature Help; explicit modes and ambiguous contexts do not
receive the extra note. A current-FBC worker test verifies the implicit flag,
and a provider test verifies the call-site documentation.

Target-wide literal hovers, 2026-10-12: the full semantic model now joins
FBC's target-wide prefix properties to physical WString expression symbols in
their source-context module. Hover and the expression-type command report target
unit width, termination, and up to eight emitted units; malformed, unavailable,
conflicting, provisional, and oversized property groups are withheld. With
stock FBC, the full binding sidecar is requested only on hover over the literal
or when the expression-type command selects a WString literal expression. A
current-FBC fixture test compares the hover payload to
the compiler's own wide-prefix properties, and provider tests cover rendering
and the on-demand stock-sidecar path.

SELECT CASE lowering hovers, 2026-10-12: the full semantic model joins FBC's
input, comparison, table, and closed-construct properties to the physical
selector expression. Hover reports the selected jump-table slot/entry counts
for `AS CONST`, or the count of compiler-emitted comparison tests for ordinary
`SELECT CASE`, without interpreting private comparison opcodes. Conflicting,
incomplete, recovery, and unavailable facts are withheld. Stock FBC requests the
full sidecar only over a selector, not the `SELECT` keyword. Current-FBC
sidecar and provider tests verify both lowering forms and the on-demand gate.

Fixed-array element storage details, 2026-10-12: Outline, hover, and completion
now combine a compiler-confirmed fixed element count with the target width for
one element and report their exact product. The count must agree with both the
physical bounds and FBC's `array-elements` receipt; unknown/runtime bounds and
reference-backed storage are not estimated. Pointer targets and allocated
string data remain explicitly separate. A current-FBC worker test checks the
multidimensional count and target width against Outline; a provider test checks
hover rendering and withholds totals when count facts conflict.

C vararg operation hovers, 2026-10-12: `Cva_Arg` now shows its compiler-reported
operand and result types, while `Cva_Start`, `Cva_Copy`, and `Cva_End` show
their retained operand types at the physical macro token. The hover uses the
schema's stable runtime-macro operation codes; untyped statement operations do
not gain a guessed result type. A current-FBC sidecar query verifies all four
operations, and provider tests cover typed extraction and untyped initialization.

Outline default parameter modes, 2026-10-12: parameter details now mark a
compiler-selected ByVal/ByRef mode as `(keyword omitted)` only when FBC's
`formal-written-mode` fact is uniquely zero. Written modes and ambiguous or
unavailable properties keep the existing summary. The current-FBC worker check
verifies an omitted ByVal and an explicit ByRef parameter.

Argument inlay passing-mode tooltips, 2026-10-12: positional parameter hints
now include FBC's ByVal, ByRef, ByDesc, or VarArg mode in the tooltip when the
selected call and parameter identity provide one unambiguous mode. The hint
label remains concise; missing or conflicting mode facts leave its prior
tooltip unchanged. Provider tests check rendering, and native-bridge plus
stock-sidecar worker tests check the selected ByRef mode.

Compiler-selected array storage hovers, 2026-10-12: full sidecar array-storage
inputs are now joined to their physical expression identities. Hovering the
array declaration or its use in a bound query, indexed access, or ByDesc actual
shows compiler-confirmed bounds and target element storage. Bound/index/ByDesc
uses also identify the selected field or variable using its exact physical
declaration binding. Recovery, missing names, oversized inputs, and conflicting
repeated-context facts are withheld. Stock FBC upgrades to a full binding
sidecar only over array declarations, `LBound`/`UBound` calls, or call-shaped
uses of declarations whose source confirms array dimensions; ordinary call
arguments do not trigger that upgrade. Current-FBC worker and provider tests
cover the hover details and request gate.

Stock-sidecar field layout hovers, 2026-10-12: exact physical field declaration
bindings now connect FBC's field offset, target value width, and access facts to
the hover provider without requiring the native editor bridge. The full sidecar
is requested only on a field declaration hover; ordinary references keep the
existing lighter path. Current-FBC worker tests check public/private offsets,
and provider tests verify rendering and the on-demand gate.

Stock-sidecar aggregate layout hovers, 2026-10-12: physical aggregate type
declarations now surface FBC's target size, natural/packing alignment, and
ordered member-access sections and unimplemented abstract-member count. The full
sidecar is requested only on a type/class/union declaration hover. Current-FBC
worker and provider tests verify compiler facts, rendering, and the targeted
request.

Stock-sidecar parameter hovers, 2026-10-12: physical parameter declaration
bindings now surface FBC's selected ByVal/ByRef/ByDesc/VarArg mode, array rank,
and optionality. The `formal-written-mode` receipt distinguishes an omitted
default from an explicitly written keyword. The full sidecar is requested only
on parameter declaration hovers; call-site hints retain their existing path.
Current-FBC worker and provider tests verify the mode facts and rendered help.

Stock-sidecar procedure ABI hovers, 2026-10-12: exact procedure declaration
bindings now surface FBC's selected linkage, calling convention, written/default
convention policy, ByRef return status, and scope-selected visibility when its
source marker is omitted. The full sidecar is requested only on procedure
declaration hovers. Current-FBC worker and provider tests cover C linkage/Cdecl,
ByRef returns, default visibility, and the on-demand request.

Stock-sidecar procedure visibility refactor, 2026-10-12: the existing action to
make default visibility explicit now works without the native bridge for a
standalone `Sub` or `Function` definition. It requires FBC's exact declaration
name range, selected visibility, default-visibility receipt, and definition
typing input, then confirms the parsed declaration and physical header before
inserting `Public` or `Private`. Current-FBC worker and provider tests cover the
range mapping and bounded insertion.

Stock-sidecar procedure ABI refactor, 2026-10-12: the existing action to make a
foreign procedure's compiler-selected calling convention explicit now also
works without the native bridge. It joins FBC's ABI policy and linkage facts to
the exact compiler name range and parsed declaration, then requires a single
non-managed-String prototype policy with no written convention before inserting
the selected keyword. Focused provider coverage verifies the bounded edit;
current-FBC worker coverage verifies the underlying calling-convention facts.

Stock-sidecar parameter-mode refactor, 2026-10-12: the existing action to make
default ByVal/ByRef passing explicit now works without the native bridge. It
requires FBC's exact physical parameter range, a unique compiler-selected mode,
and the `formal-written-mode` receipt showing that the keyword was omitted.
The mode itself is never inferred from parser defaults. Parameter-type edits
use separate compiler-normalized type and written-form receipts. Current-FBC
worker and provider tests cover the range mapping, default mode, and bounded
insertions.

Stock-sidecar parameter-type refactor, 2026-10-12: the existing action to make
an implicit parameter type explicit, including `ByRef` and array parameters,
now works without the native bridge. It also replaces an explicit type suffix
with `As` syntax. Both edits require FBC's normalized parameter type, a unique
`formal-written-type` receipt, the exact physical parameter range, and an
unchanged parsed procedure header. Array types are inserted after rank
parentheses while preserving compiler-selected `ByDesc`. The current-FBC worker
confirms normalized type, type-origin facts, and suffix range; focused provider
coverage verifies scalar, array, and `ByRef` insertions plus replacement.

Stock-sidecar function return-type refactor, 2026-10-12: the existing actions to
make an implicit return type explicit and replace a written return suffix with
`As` syntax now work without the native bridge. They join FBC's normalized
result type to the exact procedure name range and require the corresponding
compiler result-form receipt plus the unchanged parsed header. Current-FBC
worker coverage confirms implicit and suffix forms, type, and physical range;
focused provider coverage verifies insertion and replacement edits.

Stock-sidecar Override refactor, 2026-10-12: the existing action to add the
optional `Override` marker now works without the native bridge. It uses FBC's
unique `overrides` semantic relationship and `written-override=0` receipt,
then confirms the exact procedure name range and parsed header before inserting
the marker. Current-FBC worker and provider tests verify the compiler-selected
base relationship and bounded insertion.

Stock-sidecar storage-scope hovers, 2026-10-12: compiler-reported variable
storage classes are now joined to their physical symbol binding. Hovering a
simple assignment target can show FBC's selected local/global/static/shared or
external scope, including an implicitly declared local. The full sidecar is
requested only over assignment targets. Current-FBC tests verify the implicit
local fact in `-lang deprecated` mode and that the stock hover displays it.

Stock-sidecar implicit-variable type inlays, 2026-10-12: a bare unresolved
assignment target or implicit scalar `FOR` counter can now receive an inline
compiler-selected type when FBC reports a unique physical declaration binding,
storage class, and normalized type for that site. The request is limited to
visible assignment/`FOR` candidates, uses a binding-capable sidecar pass, and
skips source-resolved targets and unsaved roots. Current-FBC worker and provider
tests verify the physical hint location, type text, request gate, and
declared-variable fast path.

Stock-sidecar implicit-declaration type inlays, 2026-10-12: uninitialized
`Dim`, `Static`, `Common`, or `Extern` declarations with no written type now
show FBC's normalized default type. The request requires a unique physical
declaration binding and complete `writtenType=implicit` input; ordinary
initializer inlays continue to use expression-sidecar facts. Current-FBC worker
and provider tests verify the bound type and the on-demand binding request.

Stock-sidecar variable storage-width hovers, 2026-10-12: exact physical scalar
variable declarations now surface FBC's target value width, including pointer
and reference caveats from the normalized type fact. The full sidecar is
requested only at variable declarations; ordinary variable references keep the
expression-only path. When the source omits `As` and a type suffix, the same
fact also shows FBC's selected primitive type. Current-FBC worker and provider
tests verify explicit width, implicit default type, and the request gate.

Stock-sidecar scalar String initialization hovers, 2026-10-12: the same exact
variable declaration binding now carries FBC's default-versus-explicit scalar
String initialization fact and bounded constant initializer value. The existing
hover formatter reports default initialization or exact source-independent
constant bytes without deriving string contents from source text. Current-FBC
worker and provider tests cover default initialization and the compiler's exact
constant byte payload.

Stock-sidecar linker directive hovers, 2026-10-12: hovering an `#inclib` or
`#libpath` value now requests the full sidecar and reports only the compiler's
accepted physical input. Other hovers keep the lighter analysis path. Current-FBC
worker and provider tests verify both compiler mapping and the targeted request.

Stock-sidecar enum value origin hovers, 2026-10-12: enum member declarations
now identify whether FBC assigned the value implicitly or the source wrote it
explicitly, alongside the compiler-selected constant value. The result is joined
through the exact member binding and withheld for recovery or conflicting
contexts. Current-FBC worker and provider tests cover both explicit and implicit
members.

Stock-sidecar enum value refactor, 2026-10-12: the existing "make enum value
explicit" action now also works without the native bridge. It requires FBC's
implicit-value receipt, exact physical member range, and a compiler-reported
integer constant before inserting anything. Explicit members, conflicting
sites, non-integer values, or missing bindings produce no action. The focused
provider regression covers both bridge-style facts and stock-sidecar facts.

Stock-sidecar implicit-DIM type refactor, 2026-10-12: the existing explicit-type
action now uses normalized FBC type facts and complete declaration-type groups
when the native bridge is unavailable. It supports compiler-complete untyped
inputs for `Dim`, `Static`, `Common`, and `Extern`, including one selected name
within a multi-name `Dim`. It inserts `As` after compiler-visible array bounds.
Provisional, incomplete, or conflicting declaration facts remain no-action
cases. Focused provider coverage verifies scalar, array, and multi-name
insertions plus the incomplete-group guard; current-FBC worker coverage
confirms that adding a type to one name leaves its sibling inferred.

Stock-sidecar variable suffix refactor, 2026-10-12: variable declarations with
a compiler-confirmed type suffix can now replace only that suffix with an `As`
type when the physical declaration input is unambiguous. The edit uses FBC's
normalized selected type, preserves sibling declarators, and places `As` after
existing array bounds. Current-FBC worker coverage confirms scalar and array
suffix-origin facts; focused provider coverage verifies both replacement
locations.

Stock-sidecar constant type refactor, 2026-10-12: inferred constants can now
write FBC's selected `As` type, and suffixed constants can replace only the
written suffix. The inferred-type action can target one constant within a
multi-declarator statement using its exact compiler input, without changing its
siblings. Both actions require a complete compiler declaration input, normalized
selected type, and exact parsed `Const` declaration. Current-FBC worker coverage
confirms inferred and suffix origins; focused provider coverage verifies the
insertion and replacement edits.

Stock-sidecar inferred-Var refactor, 2026-10-12: a single `Var` declaration
with a compiler-confirmed inferred type can now be rewritten as a typed
`Dim name As Type` declaration. It requires FBC's complete one-declarator `var`
input and normalized selected type. Multi-declarator and unsupported
`Shared`/`ByRef` forms remain no-action cases. Current-FBC worker and provider
tests verify the inference receipt and both edits.

Stock-sidecar implicit-local refactor, 2026-10-12: an assignment target with a
unique compiler-selected `local` storage class and normalized primitive type
can now be replaced with a typed `Dim` declaration without the native bridge.
Optional `LET` is included in the edit span so the result remains valid FreeBASIC
instead of leaving a `LET Dim` prefix. The action keeps the existing
physical-target/signature checks and is withheld for non-local, reference-backed,
unknown, or conflicting types. Focused provider coverage checks both assignment
forms; a current-FBC worker test confirms the target facts and compiles the
resulting explicit declaration in `-lang deprecated` mode.

Shared-header macro completion follow-up, 2026-10-12: when the same physical
conditional directive is reached through several include environments, an
unfinished `#if defined(` completion now intersects the compiler-active macro
sets from every matching context. A macro present in only one expansion is not
suggested. The lookup is bounded to the eight cached epoch views and fails
closed above that limit; a current-FBC regression covers two divergent include
environments.

Stock-FBC physical navigation and constructor-observation follow-up,
2026-10-12: stock-sidecar Go to Definition, Find References, Go to Declaration,
and Go to Implementation now use exact physical `B` bindings for ordinary
symbols, including compiler-created locals and declarations in included
headers. Declaration/body classification uses a bounded cached parse only at
compiler-bound sites. Binding export is requested only for explicit navigation
actions; the worker fails closed for ambiguous or oversized binding sets.
Current-FBC worker and provider tests cover overload-specific prototype/body
separation and both cross-file and implicit-local cases.

Cached stock-sidecar document highlights, 2026-10-12: after an explicit
binding-capable sidecar request has populated the current snapshot, document
highlights reuse its exact `B` occurrences and `ACC` read/write roles rather
than resolving the token again through the source parser. Cursor movement does
not start another compiler pass; absent a current cached binding snapshot, the
existing lightweight highlight path remains in use. The focused provider test
verifies both exact highlight kinds and no additional model request.

Current FBC separates editable physical argument-constructor `I` records from
counted `construction-observation` K properties. Project rename validation
compares the K observations so constructor-choice changes are rejected even
when macro/lowered sites have no safe editable token range. Tests now use a
nontrivial BYVAL UDT to exercise that compiler-selected path. Source-documentation
attachment also skips generated entries without filesystem URIs instead of
aborting model construction. Focused editor, worker, sidecar, and project-rename
tests pass. The initial full unit run was 702/719 before these follow-up fixes;
it has not been repeated.

Configured-project Find References, 2026-10-12: when an editor-bridge project
has explicit module/build contexts, ordinary symbol references now collect
physical compiler bindings across those contexts and shared dependencies.
Shared declaration anchors join module-local IDs; contradictory bindings at a
physical token or selected generated references without complete provenance
fall back to the current compiler snapshot. The read-only transaction freezes
and re-verifies sources without patching or recompiling a modified project.
Focused provider and native shared-header tests cover routing and cross-module
locations.

Stock-FBC configured-project Find References, 2026-10-12: the same read-only
path now consumes schema-27 physical `B` bindings without requiring the editor
bridge. It maps the sidecar's UTF-16 columns to checked source tokens, joins
module-local symbol IDs through physical declaration anchors, and refuses dirty
project roots or dependencies because stock sidecars cannot analyze them.
Unrelated dirty buffers do not block the lookup. References with incomplete
physical provenance continue to fall back to the current snapshot.
The current stock-FBC regression verifies the shared header, both modules, and
a reference after non-ASCII text on the same line.

Configured-project navigation follow-up, 2026-10-12: ordinary Go to Definition,
Go to Declaration, and Go to Implementation now use the same explicit project
contexts when the active translation unit confirms the symbol but lacks the
requested body or prototype. The read-only scan returns physical declaration
bindings only for this path; source parsing classifies `DECLARE` versus
implementation at those compiler-confirmed sites. Unresolved names do not
launch a project scan. Focused stock-sidecar tests verify prototype, definition,
and implementation results across a shared header and two modules; the
editor-bridge path also verifies cross-module implementation lookup.

Stock-sidecar numeric-label navigation and highlights, 2026-10-12:
compiler-bound numeric label tokens now use the same physical `B` binding path
as identifier labels. Because the source parser does not model numeric labels,
the sidecar query synthesizes only label declaration metadata at the exact
compiler-confirmed numeric token. The current-FBC worker regression verifies
definition, references, and highlights for a numeric label in QB mode. The
provider requests bindings for numeric declarations/control-transfer targets,
but not an ordinary numeric expression on the same source line.

Schema-27 source-coordinate integration, 2026-10-12: host-side semantic
sidecar range lookup now uses FBC's documented UTF-16 columns instead of
converting them as UTF-8 byte offsets. A stock-sidecar navigation regression
places `é` before an included-header reference; a linker-directive hover checks
the final character after `é`. Both now resolve to the exact physical range.

Stock-sidecar macro navigation, 2026-10-12: ordinary on-demand binding snapshots
remain compact. When the source model recognizes a macro at an explicit
definition/reference request, the service requests a noncompact sidecar and
projects only FBC-selected physical root invocations and `#undef` lifecycle
sites from the active translation unit and its includes into the binding set.
Worker and provider regressions verify the selected definition, direct use,
undef, redefinition separation, and that the larger macro graph is requested
only for macro sites. Configured-project macro references are described in the
later project-reference checkpoint.

Stock-sidecar conditional macro references, 2026-10-12: compiler-selected
physical `DEFINED()` and conditional defined-name probes now supplement exact
Go to Definition and Find References bindings in compact snapshots. The
projection requires an active selected symbol and a physical declaration
binding. Unqualified probes must span one identifier; qualified probes project
only the trailing identifier derived from the selected declaration name and
compiler-reported endpoint, then revalidate its source token during navigation.
Generated spans and absent `#ifndef` names remain unresolved. Current-FBC worker
coverage verifies `#if defined(...)`, `#ifdef`, selected `#elseifdef`, and a
qualified constant without enabling the macro-expansion graph. A continued
qualified probe stays navigable across both physical lines, and conditional
hover displays its full source spelling rather than only the first qualifier.
Compiler-evaluated condition hover also spans continued directive lines, using
the branch start and compiler-recorded final operand endpoint.

Stock-sidecar macro Signature Help, 2026-10-12: when a source-model macro call
is active, the extension requests FBC's full sidecar and uses the selected root
invocation's macro definition and formal parameter tokens. Signature Help now
follows `#undef` and redefinition epochs rather than listing every same-named
source definition. Parameter casing comes from the exact physical definition
site when the parser's formal slots agree with FBC's selected slots. The full
graph is not requested for ordinary calls. Hover on function-like and
object-like macro uses displays the compiler-selected signature and a bounded
source-body preview when its physical definition site is unambiguous. Focused
worker and provider regressions cover compiler selection, variadic parameters,
casing, body previews, and the request gate.

Stock-sidecar project references in conditional expressions, 2026-10-12: the
existing configured-module reference transaction now has a current-FBC
regression for a namespaced constant declared in a shared header and selected
by `DEFINED(Namespace.Member)` in two modules. The result includes the physical
member declaration and both compiler-selected final-member uses, without
modifying the saved sources.

Stock-sidecar configured-project macro references, 2026-10-12: explicit project
Find References requests opt into the full macro graph only when the cursor is
on a source-model macro. The worker joins shared-header macro declarations
through physical anchors and includes compiler-selected root invocations,
conditional probes, and `#undef` sites across configured saved modules. It
rejects the project result when a selected nested/generated use has no physical
source token. Current-FBC regressions cover cross-module root uses, that refusal
path, and provider routing.

Cached stock-sidecar procedure reference CodeLens, 2026-10-12: when the current
snapshot already contains physical semantic bindings, CodeLens now counts
compiler-selected procedure references in its translation unit and included
sources. Overload-specific source-call records and compiler-selected overloaded
operator expression ranges are joined with physical declarations. Operator
declaration ranges come from the bounded source parse at FBC's exact procedure
line, not name matching. Ambiguous physical sites and oversized snapshots
withhold the result. The provider does not request a compiler pass just to
display lenses; focused worker checks cover overloads and `Operator Len`.

Stock-sidecar inherited type hover and Outline, 2026-10-12: the semantic model's
`U` layout record already carries the compiler-selected base symbol. The host
now retains that identity and uses it to confirm the source spelling before
showing the base type in stock-FBC hover and Outline details. Ambiguous or
missing identities remain unannotated. A current-FBC worker regression checks
both targeted hover facts and cached Outline facts for a derived type.

Stock-sidecar Type Hierarchy, 2026-10-12: explicit Type Hierarchy preparation
now requests a binding-capable snapshot for stock FBC. The provider follows the
sidecar's physical declaration bindings and `U` base-symbol relationships for
direct supertypes and subtypes, retaining source locations. A selected variable,
field, or procedure with a semantic subtype can prepare the hierarchy from the
compiler-reported type identity. Ambiguous or oversized candidate sets are
withheld; other modes keep their existing paths. Current-FBC worker checks
verify both hierarchy directions with a base type in an included header and
preparation from a typed variable; the provider check verifies the one-time
binding request. Literal, comment, punctuation, and complete source-resolved
symbols with no user-defined type return before requesting the binding-capable
snapshot.

Stock-sidecar Type Definition, 2026-10-12: type-definition requests now ask for
physical bindings and follow the selected symbol's compiler subtype identity
to its source type declaration. Expression subtype identities are also used
when no physical symbol token is selected; the previous visible-name lookup
remains as a fallback for unrepresented or built-in types. Current-FBC worker
and provider checks verify the declaration location and on-demand binding path.
Comments, literals, and complete source-resolved non-UDT symbols return before
the binding-capable sidecar request.

Stock-sidecar type completion follow-up, 2026-10-12: matching user-defined
type candidates now request their exact aggregate facts from the binding-capable
sidecar snapshot and can show FBC's selected base type instead of only the
source-declared spelling. Candidate lookup is bounded to 64 entries and is
skipped for short or nonmatching prefixes. Site queries now accept an explicit
absolute source path so facts can be resolved in included headers without
confusing their line numbers with the active file. The aggregate Outline query
also retains a base-type-only result. Provider and current-FBC worker tests
cover the request gate, selected completion documentation, and an included
header site. The full editor-feature suite passes 117/117; the focused worker
regression passes.

Two small hardening fixes from the same regression run: scalar variable hover
no longer reads an undefined aggregate-facts guard, and macro-aware Signature
Help safely falls back when an index does not expose a source semantic model.

Stock-sidecar implicit signature type inlays, 2026-10-12: ordinary FBC now
shows compiler-selected primitive types for implicit function results and
formal parameters, using physical declaration bindings and the sidecar's
normalized type facts. Explicit `AS` and suffix types remain unannotated;
ambiguous, provisional, nonphysical, and unsupported aggregate types are
withheld. Property getters require a written `As` type; current FBC rejects an
untyped zero-argument property as a setter without its required value
parameter, so no implicit property result type exists to annotate. The
binding-capable request is limited to visible ranges containing potential
implicit signature declarations.
Current-FBC worker coverage checks the procedure and parameter facts, the inlay
query, and suppression of suffix types; focused provider regressions cover
rendering and existing variable-type inlays.

Stock-sidecar implicit `INPUT`/`READ` type inlays, 2026-10-12: when a visible
saved-buffer range contains an unresolved target in an `INPUT` or `READ`
statement, ordinary FBC now supplies its normalized type and storage facts for
an inlay and cached Outline can include the compiler-created local. File
handles and `INPUT` prompts are excluded from target ranges;
source-resolved targets and suffix-typed names are left alone. Multiple plain
targets on a statement are handled independently. A current-FBC worker test
checks assignment, prompted multi-target `INPUT`, multi-target `READ`, and a
declared `INPUT` target. The stock-sidecar Outline prefilter also recognizes
`INPUT`/`READ`, so input-only files reach the cached local query. Hovers at
compiler-created `INPUT`/`READ` targets reuse the same exact sidecar storage
facts without requesting analysis for source-resolved variables. Focused
provider and worker tests check the hover facts, request gate, rendered hints,
and multi-target ranges. The worker also verifies Go to Definition and Find
References on compiler-created input/read targets. Completion reuses the same
bounded cached records while preserving prior-declaration and procedure scope;
the provider regression covers assignment, input, and read locals together. A
refactor action can add a typed `Dim` before an unresolved procedure-local
target, but is withheld for macro bodies, suffix-typed, source-resolved,
non-local, or unsaved-buffer cases.

Stock-sidecar compound assignment inputs, 2026-10-12: a current-FBC worker
regression exercises sidecar hover facts after lowering for integer division,
modulo, addition, multiplication with a floating operand, and an indexed lvalue
whose index is a function call. It checks compiler-selected operator codes,
operand types, operation result types, and assignment target types separately.
This closes a direct sidecar coverage gap for the existing compound-assignment
hover path; it does not claim support for every operator or recovery form.

Stock-sidecar implicit `FOR` counter hover, 2026-10-12: the hover provider now
requests a binding-capable sidecar when the cursor is on an unresolved scalar
`FOR` counter, and displays its compiler-selected primitive type and storage
class. Explicitly typed counters and dirty buffers do not trigger this request.
The provider regression checks the request gate and rendered facts; the
current-FBC worker regression verifies the sidecar counter type and scope.

Unambiguous bracket repair, 2026-10-12: when an unexpected closer occurs with
one opener on the stack, the scanner records a replacement candidate. It is
offered only if that opener remains the sole unclosed opener at EOF and only
one stray closer maps to it, so later matching closers, nested delimiters, and
multiple stray closers do not receive a guessed replacement. The Quick Fix is
preferred while retaining the remove-closer option. Focused scanner and provider
tests cover the allowed and withheld cases.

Stock-sidecar continued initializer type inlays, 2026-10-12: untyped `Dim` and
`Const` initializer inlays now map the parser's logical continued statement
back to a physical expression span before looking up FBC's exact expression
fact. This restores hints for valid multi-line initializers while failing
closed when the source mapping is ambiguous. A current-FBC worker regression
verifies both continued declaration types; existing worker and provider tests
retain the single-line constant and initializer paths.

Stock-sidecar implicit `FOR` counter refactor, 2026-10-12: an unresolved scalar
counter in a procedure can now be given the primitive type selected by FBC by
adding an `AS` clause to the loop header. The action is withheld for explicitly
typed counters, source-resolved variables, dirty buffers, macros, non-local
symbols, partial sidecar results, and non-primitive types. The provider test
checks the offered edit and these request gates; the worker regression already
checks that the current sidecar reports the counter's selected type and local
storage class.

Stock-sidecar implicit `REDIM` type inlays, 2026-10-12: an untyped array newly
declared by `REDIM` now receives the compiler-selected element type at its
physical name. The hint requires FBC's exact storage-type declaration binding;
an existing array resize does not qualify. Explicit `AS` and suffix-typed
arrays remain unannotated. A current-FBC worker regression checks the new
declaration, an existing-array resize, and both explicit type forms; a provider
test verifies the displayed hint and binding-capable request.

Cached stock-sidecar Outline now uses the same exact REDIM declaration fact to
show its compiler-selected element type and storage scope. Existing-array
resizes have no declaration-site storage binding and remain unannotated. A
current-FBC worker test checks Outline fact selection against a resize, and a
provider test verifies the rendered detail without launching analysis.

The same exact local `REDIM` declaration fact now supports a refactor that adds
`Dim name() As Type` before the `REDIM` statement. It is offered only for a
simple unresolved local array target, and not for existing-array resizes,
explicit or suffix types, `PRESERVE`, macros, or dirty buffers. The provider
regression checks the insertion and withheld cases; the current-FBC worker
regression compiles the explicit dynamic-array form without diagnostics.

Stock-sidecar completion now adds FBC-selected primitive types to matching
untyped variable, constant, parameter, property, and function candidates. It
uses the same exact declaration-site facts as Outline, including implicit
`REDIM` arrays, and requests them only for prefixes of at least two characters
with a 64-site bound. Explicit/suffix types and unsupported aggregates remain
unchanged. Variable and extern completion details also show the compiler-
selected storage class when available. The provider regression covers an
untyped `DIM`, a new `REDIM`, and an implicit local; current-FBC worker
regressions validate the corresponding declaration facts.

Stock-sidecar compound-assignment targets now join the implicit-variable path
when FBC creates a local at `+=`, `MOD=`, `AND=`, or another supported compound
operator. The exact compiler declaration binding drives the type inlay and
cached Outline/completion record. A refactor inserts `Dim name As Type` before
the first compound update, preserving the update itself; it is withheld for
existing variables, suffix-typed names, dirty buffers, macros and non-local
symbols. Current-FBC worker coverage confirms the local's type and scope and
compiles the explicit declaration; focused provider tests check the inlay,
Outline and refactor behavior.

The same implicit-local path now recognizes a `SWAP` statement containing two
plain variable names. It offers type inlays and cached Outline/completion
records only for targets with compiler declaration bindings, leaving existing
variables and suffix-typed operands untouched. A refactor can declare either
new local before the `SWAP`; the current-FBC worker test compiles the resulting
two declarations and verifies that an existing declared pair does not receive
implicit type facts.

The implicit-write path now also recognizes simple `LSET name =` and
`RSET name =` destinations when FBC creates a new local. Its selected String
type is shown in inlays, Outline and completion, and the refactor inserts a
typed `Dim` before the string operation. Existing declarations and suffix-typed
names are withheld. Current-FBC worker coverage uses `DEFSTR` to verify the
selected type, storage scope, and clean compilation after the refactor. An
implicit `MID` destination was rejected by FBC in the same dialect, so it is not
treated as an implicit declaration.

Simple `GET` destination variables now use the same compiler-confirmed path.
The final comma-separated identifier is treated as the destination, not the
file handle or record-number input. New locals receive compiler-selected type
and storage hovers, an element-type inlay, Outline/completion records, and a
refactor that inserts a typed `Dim`; existing or suffix-typed variables remain
unchanged. A current-FBC worker regression checks its local type/scope facts
and clean compilation after refactoring, with provider tests for the hover,
inlay, Outline and code action.

FBC declaration-occurrence coverage for legacy implicit variables,
2026-10-13: the sidecar reader now retains validated `DCL` declaration
occurrences. In stock FBC's `FBLite`, `QB`, and deprecated dialects, any
compiler-created implicit variable with a physical first-use token can receive
its exact selected type in an inlay and hover, and appear in cached Outline and
completion facts. A local first-read variable also offers a typed `Dim`
refactor before its first use. The request is limited to unresolved identifiers
in implicit-variable dialects; dirty buffers, generated locations, suffix-typed
names, non-local storage, ambiguous sites, pointer or array storage, and
incomplete models remain withheld. Current-FBC worker coverage verifies an
FBLite first read, exact source range and local type, then compiles the explicit
declaration. Focused provider tests cover analysis gating, hover, inlay, cached
completion and refactor behavior; a bridge-backed project-rename regression
checks the first-read occurrence and subsequent reference. The stock-sidecar
worker also verifies Go to Definition and Find References from a later use back
to the exact first-read declaration. The native bridge inlay gate now also
recognizes unresolved first-read identifiers in dirty legacy-dialect buffers,
so its existing overlay analysis can supply the compiler-selected type without
waiting for a save. The bridge also offers the typed `Dim` refactor on that
dirty buffer only when the exact bound declaration identifies local scalar
storage; pointer and array shapes are withheld. The focused provider checks
cover both request/edit paths, and the native FBLite regression confirms the
compiler supplies the first-read type, local storage, and a clean explicit
declaration.

`OPTION NOKEYWORD REM` lexical follow-up, 2026-10-13: the shared source scanner
now preserves the `REM` option operand, then stops masking later `REM` tokens
as comments for the rest of the source file. Folding no longer interprets
identifier lines such as `REM #region` as comment regions, and bracket
diagnostics can see delimiters in later `REM` expressions. Static VS Code
region markers now cover apostrophe comments only; the extension folding
provider recognizes `REM` regions dynamically when `REM` remains a comment
keyword. The scanner does not apply option changes found inside conditional
preprocessing branches or macro bodies from source text alone. With a
bridge-backed snapshot, bracket diagnostics additionally use active,
non-generated `OPTION NOKEYWORD REM` lines from the compiler's preprocessed
output, mapped back to physical source origins. This lets a broken buffer
retain bracket feedback after an option in an active conditional branch
without treating an inactive option as accepted. The source-only bracket
scanner and stock-sidecar path still fail closed when no complete compiler
binding snapshot exists.
A current-FBC worker regression confirms the valid deprecated-mode program,
and focused parser/bracket tests cover the new boundaries. Stock-sidecar hover
and navigation accept exact FBC physical bindings when the lightweight token
index has masked a token. Complete source models, including trace-free
sidecars, now also apply source-tokenizer overrides only at physical `REM`
offsets confirmed by `B` bindings. The bridge's expanded parser uses native
symbol-use records; partial buffers never receive whole-file guesses. Declaration
presentation comes from parsed source where available and from matching DCL
and storage facts for implicit variables. Outline and completion now add only
physical compiler-bound variable declarations that the token index missed,
requiring the declaration scope to contain the cursor scope and preserving
procedure boundaries unless compiler storage facts prove module visibility. The
conditional `OPTION NOKEYWORD REM` worker cases verify Outline, completion,
hover, semantic-token coloring, document highlights, implicit-local inlays,
typed-local refactoring, Go to Definition, and Find References for
procedure-local declarations, assignments, and reads; the bridge also verifies
the declaration, references, completion, and semantic tokens in native mode.
The project-rename regression validates the same symbol in two configured
build contexts without writing source files. The worker checks that a local
does not leak into another procedure. A separate native-bridge worker case
verifies the compiler-selected Integer inlay and hover facts for an implicit
local first written as `REM`; a provider check uses those native facts to
offer the typed-`Dim` refactor only for local scalar storage. An unsaved-root
bridge regression verifies declaration and reference projection without
writing the overlay to disk.

`OPTION NOKEYWORD` stock-sidecar hover follow-up, 2026-10-13: keyword spellings
with exact physical FBC bindings now receive the same hover entry as bridge
models, even when the source resolver still treats the spelling as a keyword.
The trigger is limited to a source-position `OPTION NOKEYWORD` directive and
uses compiler bindings to authorize the result. A cached per-document directive
scan avoids rescanning the buffer on each hover. Stock-FBC worker and provider
regressions cover `PRINT`; conditional `REM` coverage remains intact. A small
project-navigation guard also handles host document adapters without VS Code's
`lineAt`/`offsetAt` methods. Verification: 151 editor-feature tests, 99
project tests, and the two focused stock-FBC worker cases passed.

`OPTION NOKEYWORD` sidecar token and implicit-local follow-up, 2026-10-13:
stock-sidecar semantic tokens now supplement a keyword spelling only when the
source resolver cannot resolve that physical token and FBC supplies one
unambiguous binding. This preserves declaration, write, and read modifiers for
disabled keyword names without duplicating already-resolved source tokens. The
semantic-token provider requests a binding-capable sidecar model when a source
`OPTION NOKEYWORD` directive is present, with the directive check cached for the
document version. Semantic navigation and document highlights request bindings
for a keyword spelling following the directive; the query still requires an
exact physical compiler binding. The legacy implicit-variable inlay gate and
typed-declaration target lookup also recognize keyword names released by the
option, not just `REM`. Focused stock-FBC worker coverage verifies `PRINT` hover
and semantic tokens, an `INPUT` first-write type fact, and `ABS` after FBC
releases the runtime name; provider coverage verifies the on-demand `INPUT`
inlay and `ABS` hover request. The existing conditional-`REM` worker and
provider cases still pass. The full
editor-feature suite passes 154/154 after the provider-routing follow-up.
The source gate now accepts any spelling named by `OPTION NOKEYWORD`, including
runtime names such as `ABS`, which FBC allows this option to release; it no
longer depends on the extension keyword table.

`OPTION NOKEYWORD` runtime-name follow-up, 2026-10-13: FBC also accepts
removing a runtime symbol such as `ABS`, then using it for a local variable.
The editor's hover and implicit-inlay gates now recognize those names as well
as grammar keywords. Worker coverage checks the implicit local's semantic token,
selected type, and hover entry; provider coverage checks its hover and inlay
requests. The editor-feature suite passes 154/154 after this gate change; the
full unit suite has not been rerun.

`OPTION NOKEYWORD` implicit-local completion follow-up, 2026-10-13: when the
typed prefix matches a prior disabled spelling, completion now requests exact
sidecar bindings. The worker adds a compiler-created local only when its source
token is unresolved by the lightweight model and its declaration scope is
visible at the cursor. The `ABS` first-write regression verifies that the
implicit variable completes as a variable rather than the removed runtime
function. Provider and worker checks pass; the editor-feature suite passes
156/156. The full unit suite remains unrerun.

Stock-sidecar Call Hierarchy bare optional-call follow-up, 2026-10-13: FBC
accepts Functions and Subs with defaulted parameters when called without
parentheses. The source hierarchy fallback deliberately does not guess that a
parameterized name is a call; compiler sidecar call bindings provide the exact
physical calls and targets instead. A worker regression verifies both
bindings, and a provider regression verifies caller/callee hierarchy in both
directions. The full editor-feature suite passes 155/155 with this provider
regression.

Conditional `OPTION NOKEYWORD REM` bracket follow-up, 2026-10-13: the compiler's
active preprocessed stream and physical source-origin map now confirm option
lines for bracket masking even when a later syntax error prevents a complete
semantic sidecar. The worker query returns only bounded source-line offsets;
the bracket scanner uses them to preserve `REM` identifiers and delimiters.
An inactive `#if 0` option does not change the scanner state. Thirteen bracket
tests, 33 parser tests, and the focused current-FBC malformed-buffer test pass.

Stock-sidecar `REM` token-index follow-up, 2026-10-13: complete trace-free
binding snapshots now use FBC's exact physical `REM` bindings to keep those
identifier tokens visible in the source index. Outline's masked-variable query
still returns the compiler declaration when the expanded model cannot resolve
it, and the worker verifies all three exact token offsets in a conditional
`OPTION NOKEYWORD REM` fixture. Partial sidecars remain excluded.

Continued stock-sidecar file-I/O targets, 2026-10-13: the request gate, hover,
and implicit-declaration refactor now use the parsed logical statement to find
`INPUT` and `GET` targets on continued physical lines. Type hints remain
anchored to the target line, while a typed `Dim` is inserted before the
statement's first line. Scans are bounded to 128 lines. Focused provider tests
verify the inlay request and declaration placement; the current-FBC worker
verifies compiler-selected String and Integer types at the continued targets.

Continued stock-sidecar `SWAP` targets, 2026-10-13: the second operand can now
receive its compiler-selected inlay and typed-`Dim` refactor when it is on a
continuation line. The source-range check stays on the exact physical operand,
while the declaration is inserted before the `SWAP` statement. Provider and
current-FBC worker regressions verify the continued operand and clean edit.

Continued stock-sidecar `LSET`/`RSET` targets, 2026-10-13: destination names
on a continuation line now use the compiler-selected string type for the
refactor, with the declaration inserted before the logical string operation.
The current-FBC sidecar regression confirms both physical declaration ranges;
the provider regression checks both edit locations.

Continued stock-sidecar `REDIM` declarations, 2026-10-13: implicit array
targets on continuation lines now retain their compiler-selected element type
in inlays and use the exact physical target for a typed-array refactor. The
refactor inserts `Dim name() As Type` before the first `REDIM` line. Complete
sidecar coverage at this checkpoint required an untyped, non-`PRESERVE` target;
the first-`PRESERVE` follow-up below closes that case. Focused provider and
current-FBC worker tests verify type display and a clean edit.

Continued stock-sidecar `FOR` counters, 2026-10-13: the physical counter on a
continued `FOR` header now receives its compiler-selected type inlay and can
have an explicit `As Type` inserted at the counter token. A focused provider
test checks the edit range, and the current-FBC worker checks the bound counter
and sidecar type.

Continued stock-sidecar assignment targets, 2026-10-13: a target on the line
after `LET _`, or a target and assignment operator split across physical lines,
is no longer mistaken for a standalone assignment and replaced with an invalid
mid-statement `Dim`. Physical lines inside continued `FOR` and `LSET`/`RSET`
headers are also routed to their statement-specific refactors instead of being
mistaken for standalone assignments. The same physical-target mapping covers
continued compound assignments. Typed-local refactors insert before the
logical statement when FBC confirms the physical declaration site. Provider
and stock-FBC worker regressions cover the edits and selected types.

Stock-sidecar first `REDIM PRESERVE` declarations, 2026-10-13: the current
FBC sidecar identifies a first-time `PRESERVE` as a compiler-created local
array and provides its exact storage type, while an already-declared array's
`PRESERVE` resize has no declaration-site storage facts. The extension now
uses that distinction for type inlays, Outline, completion details, and the
typed-array refactor. Continued `REDIM PRESERVE` targets retain their physical
hint range and receive the declaration before the first statement line. The
current-FBC worker verifies the first-write facts, rejects facts for a resize
of an existing array, and compiles the generated declaration; focused provider
tests cover inlays, Outline, completion, and edit placement.

Module-scope `REDIM SHARED` refactoring in stock-sidecar and native modes,
2026-10-13: FBC reports the implicit shared array's storage class as `static`
and supplies its physical declaration. The refactor uses that evidence to add
`As Type` after the array bounds, rather than inserting a local `Dim` that
would change scope. The module declaration may continue onto a physical target
line, and the bounds themselves may span physical lines; the type insertion
follows the matching closing parenthesis. Existing `PRESERVE` resizes fail the
declaration-range check. A current-FBC worker compiles the typed form in both
modes, and provider regressions verify the physical edit and resize refusal.

Unsaved native-bridge continued `LET` refactoring, 2026-10-13: the typed-local
refactor now uses logical-statement boundaries for dirty documents when the
configured compiler supports buffer overlays. It inserts before the first
physical line of a continued `LET` and avoids the legacy fallback that could
insert inside the statement. The native-overlay target classifier also covers
`FOR` counters, `INPUT`/`GET`, `REDIM`, compound assignments, `SWAP`, and
`LSET`/`RSET` without enabling disk-only stock-sidecar queries on dirty
buffers. Provider regressions check `LET`, `FOR`, `INPUT`, `SWAP`, and `REDIM`
edit placement; a native worker verifies those five compiler-bound targets in
one unsaved overlay, compiles the typed refactors, and confirms neither
analysis saved the source.

Module-scope FBLite first-read refactoring, 2026-10-13: FBC reports an exact
local declaration and normalized type even when a variable is first read in
the program-level body. Stock-sidecar and native-overlay providers now offer
the typed `Dim` before that read; native analysis remains available for dirty
buffers. The module-local symbol also appears in Outline and completion after
its first occurrence without leaking into procedures; compiler bindings also
support its inlay, definition, and reference locations. Current-FBC worker
tests verify those sidecar and native editor records, compile both explicit
forms including the unsaved overlay, and confirm it is not written to disk.

Module-scope FBLite implicit-local rename, 2026-10-13: project Rename resolves
the compiler-created first-read variable from its physical binding and
validates both reads in two configured FBLite build contexts. The regression
confirms the preview contains only the two identifier edits and leaves the
saved source unchanged. A companion worker-backed case performs the same
rename from an unsaved root overlay across both contexts and verifies the disk
file remains byte-for-byte unchanged.

Continued procedure-header parameter typing, 2026-10-13: parameter declarations
on physical continuation lines now remain eligible for the compiler-selected
`As Type` refactor. The provider requires the parsed parameter to belong to a
continued procedure header and validates FBC's exact physical parameter range
before editing that line. A current-FBC worker verifies the sidecar facts and
compiles the explicitly typed continued header; provider coverage checks the
insertion point.

Continued procedure-header ABI refactoring, 2026-10-13: a default external
calling convention can now be made explicit when the declaration's parameter
list continues onto later physical lines. The action is offered only when the
parsed header and compiler declaration binding identify the same procedure
name, and the sidecar confirms the linkage, selected convention, and absence
of a written convention or managed-string exception; partial compiler results
are rejected. The insertion is after the name, before the opening parenthesis.
A current-FBC sidecar test verifies that adding `Cdecl` compiles, and provider
coverage checks the exact edit and partial-result rejection; the editor-feature
suite passes 163/163.

Continued implicit function return types, 2026-10-13: compiler-confirmed
implicit return types are now refactorable when a function header spans
physical lines. The provider scans a bounded header, balances the parameter
list while ignoring strings and comments, and inserts `As Type` immediately
after the closing parenthesis only when it closes on the final header line and
the remaining syntax is empty or `Override`. This avoids editing after a
continuation marker or inside the body. Provider coverage checks the edit
position; the current-FBC sidecar regression confirms the implicit `Integer`
fact and compiles the generated continued declaration.

Continued function suffix return refactoring, 2026-10-13: a compiler-confirmed
`%`/other type suffix on a continued function can now be replaced with the
selected `As Type` form. The edit removes only the bound suffix character and
inserts the type at the same validated parameter-list boundary as the implicit
return-type action; continued headers require an explicit compiler `suffix`
typing fact. Provider coverage checks both edit locations, and a current-FBC
worker case compiles the converted suffix and implicit return forms. The
editor-feature suite passes 165/165.

Continued method override refactoring, 2026-10-13: when FBC exports an exact
override target and confirms no `Override` marker was written, the refactor can
now add it to a continued method declaration. The insertion uses the parser's
final header line and places the marker after the last code token but before a
trailing comment; ambiguous colon bodies and unfinished continuation tails
are rejected. A current-FBC sidecar test verifies the stable base-method ID and
accepts the edited source; provider coverage checks the final-line edit. The
editor-feature suite passes 166/166.

Continued array-parameter typing, 2026-10-13: implicit array parameters whose
rank parentheses span physical lines can now receive the compiler-selected
`As Type` refactor. The provider follows the exact parameter binding, bounds
the scan to the owning continued procedure header, balances the rank
parentheses, and inserts after their matching close rather than abandoning the
action when the close is on another line. A current-FBC worker confirms the
implicit array type and compiles the generated declaration; the provider test
checks the insertion point alongside a continued scalar parameter.

Array-parameter suffix conversion, 2026-10-13: compiler-confirmed type suffixes
on array parameters can now be replaced with `As Type` without moving the type
before the rank parentheses. The provider deletes only the exact suffix bound
and inserts after the balanced rank; it requires FBC's explicit `suffix`
formal-type fact for this array form. A provider regression checks both edit
locations for a continued rank, and the current-FBC worker verifies the
selected type and compiles the converted declaration.

Ignored parameter type-suffix Quick Fix, 2026-10-13: FBC's `Suffix ignored`
warning now offers the same exact suffix removal for a single-line formal
parameter with an explicit `As` type as for a simple `Dim`. The source parser
must identify exactly one matching parameter on that physical line; repeated
same-line names and parameters without an `As` type are withheld. Provider and
sidecar helper tests cover the edit and ambiguity guard, and the current-FBC
bridge confirms the warning disappears after removing the parameter suffix.

Ignored suffix targets in arrays, constants, and function returns, 2026-10-13:
the same Quick Fix now recognizes an array `Dim`, an explicitly typed `Const`,
or a `Function` return suffix. It parses only a bounded single physical line,
requires exactly one matching declaration and a real `As` type; a
multi-declarator `Dim` is allowed only when the compiler's reported spelling
occurs exactly once on the line. Duplicate same-line targets remain withheld.
The current-FBC bridge regression confirms warnings for a scalar `Dim`, array
`Dim`, parameter, `Const`, and function return and verifies all disappear
after suffix removal; provider and diagnostic-range tests cover the new forms.

Ignored suffix on keyword tokens, 2026-10-13: the `Suffix ignored` Quick Fix
also removes a compiler-reported suffix on a keyword token such as FBLite
`LET%`, where there is no `As` type. The source line must contain exactly one
occurrence of the warning's suffixed spelling; repeated tokens remain
ambiguous and are withheld. The current-FBC bridge confirms the warning's
source text and line, while helper and provider tests check the suffix-only
edit and repeated-token guard.

Implicit parameter-mode warning locations, 2026-10-13: FBC's pedantic `No
explicit BYREF or BYVAL` warning carries a physical point and parameter name
but no source-text excerpt. Both compile diagnostics and on-demand snapshot
diagnostics now validate that point against the named token and narrow the
range to that formal parameter. This puts the existing compiler-backed
passing-mode refactor at the actual warning instead of the whole declaration
line. When FBC's warning name, exact diagnostic range, and semantic passing
mode agree, that refactor is promoted to a preferred, diagnostic-linked Quick
Fix for both same-line and continued formal parameters; otherwise it remains an
ordinary refactor. Current-FBC, range-helper, diagnostic-publication, and
provider tests cover exact matches and mismatched-parameter rejection.

Implicit variable allocation Quick Fix, 2026-10-13: FBC's warning for an
implicit first-read variable now narrows to a uniquely reported token even
when the compiler's physical point is at the statement start. If the token is
repeated on the line, the provider tries each occurrence and promotes the
existing `Dim` refactor only for the occurrence whose compiler declaration
binding matches. The current-FBC regression verifies the repeated first read
and that declaring its compiler-selected `Integer` type clears the warning;
range-publication and provider tests cover unique, repeated, and mismatched
targets.

Multi-counter `NEXT` warning fixes, 2026-10-13: when FBC reports that a counter
name is meaningless in `Next inner, outer` but supplies only a source line, the
diagnostic mapper narrows it to the unique counter whose spelling matches the
compiler warning. The preferred Quick Fix expands the compact statement into
one bare `Next` per loop and retains a trailing comment, preserving the number
and order of loop closures. It is withheld when a same-line FBC error exists,
or when a repeated counter name cannot be mapped uniquely. Provider, snapshot
range, and current-FBC regressions confirm the exact edit, warning removal,
and compiler acceptance of the expanded nested-loop form.

Comma-separated `NEXT` mismatch correction, 2026-10-13: FBC reports an exact
physical point for a mismatched identifier in a counter list. When the earlier
and later entries match the active nested loops and exactly one list entry is a
one-edit typo of its expected active counter, the Quick Fix replaces only that
token.
Removal fixes remain unavailable for counter lists, and lines with multiple
mismatches receive no speculative correction. A current-FBC diagnostic test
and focused provider tests cover exact location, correction, and ambiguity
rejection.

Continued parameter suffix Quick Fix labeling, 2026-10-13: the generic
`Suffix ignored` action already removed the exact suffix on a continued
parameter line, but its title did not say the explicit `As` type remained in
force. The action now detects an immediately following `As` clause on such
lines and gives the same accurate guidance as single-line declarations. A
current-FBC warning and range regression plus a focused provider test cover the
compiler's warning point on the parameter mode and the suffix-only edit.

LINE INPUT unknown-capacity diagnostic guidance, 2026-10-13: FBC already
identifies the exact destination when a pointer-sized character buffer has no
known capacity, but its parser error is only `Expected ','`. The compiler
context now tells the user to add a comma and maximum character count after the
target. Focused publication coverage checks both the destination range and the
visible message.

Redundant vector-`NEW` `ANY` initializer Quick Fix, 2026-10-13: FBC warns only
when a vector `NEW` has a default constructor, and its warning point identifies
the opening brace of `{ Any }`. The compiler-backed Quick Fix removes that
entire same-line clause, preserving the `NEW` expression and trailing source.
It is withheld unless the warning, brace location, and vector-`NEW` syntax all
match. Focused current-FBC, diagnostic-range, and provider tests confirm the
warning disappears and the edited source still compiles.

Missing string-quote Quick Fix, 2026-10-13: FBC's unterminated-literal warning
now highlights the exact unclosed string and offers a closing quote at the end
of that physical line. The source scanner respects comments, doubled quotes,
and escaped-string backslashes; it withholds the fix when normal and
`OPTION ESCAPE` scanning disagree about the open literal, or when a trailing
backslash could escape the inserted quote. Current-FBC, diagnostic-publication,
and provider tests verify warning removal and insertion placement.

`ELSE IF` warning guidance, 2026-10-13: FBC confirms that an `IF` immediately
following a multi-line `ELSE` starts a nested conditional. The warning now
explains that behavior and suggests `ELSEIF` only when the user intended to
continue the same chain. This leaves valid nested code unchanged. A current-FBC
warning test and focused diagnostic-publication tests cover the message.

BYREF-result equality warning guidance, 2026-10-13: FBC warns when `f(arg) = x`
is parsed as equality inside the function argument rather than assignment to a
BYREF result. The diagnostic now shows the compiler's corrective form,
`(function(arguments)) = value`, conditionally on an assignment being intended.
A current-FBC test confirms the warning and that the parenthesized form removes
it; focused publication coverage verifies the user-facing guidance.

Possible escape-sequence warning guidance, 2026-10-13: when FBC warns about a
recognized backslash sequence in a plain string, the diagnostic now explains
that this string is not escape-processed and that `!` opts into C-style escapes.
It does not rewrite the literal, since whether the backslash is intended as an
escape or as path text is user intent. A current-FBC warning test and focused
guidance checks cover the explanation.

BYREF temporary warning guidance, 2026-10-13: FBC warns when a non-addressable
expression is copied into a temporary for a BYREF parameter. The diagnostic
now explains that behavior and advises passing the original variable only when
that is what the procedure should access. No source edit is offered because
changing the argument can change behavior; focused guidance coverage checks
both the warning and severity guard.

`DELETE ANY PTR` warning guidance, 2026-10-13: the warning now explains that
FBC cannot know the allocation type or required destructor through `ANY PTR`.
It advises preserving the actual pointer type and matching cleanup to the
allocation, without offering a potentially unsafe cast or rewrite. Unit and
current-FBC checks cover the exact warning and severity gate.

Pointer argument warning guidance, 2026-10-13: `Passing scalar as pointer` and
`Passing pointer to scalar` now explain the distinction between a value and its
address. Guidance suggests taking or dereferencing an address only when that
matches the intended parameter contract; no automatic edit is offered.

File pointer warning guidance, 2026-10-13: FBC's `Passing Pointer` warning for
file transfers now explains that the pointer value itself is written or read,
not the memory it addresses. It warns that raw addresses are not portable and
suggests passing the pointed-to data when that is the intent.

Raw UDT file transfer guidance, 2026-10-13: the warning for UDTs with pointer,
variable-length string, or variable-length array fields now explains that raw
I/O preserves the in-memory representation, not referenced data. It advises
explicit field serialization instead of a speculative Quick Fix.

Pointer type mismatch guidance, 2026-10-13: `Passing different pointer types`
now advises checking pointee representations and limits an explicit cast to
genuinely compatible types. The extension does not suggest a specific cast
because the compiler warning alone cannot prove representation safety.

Suspicious pointer assignment guidance, 2026-10-13: when FBC accepts an
assignment between incompatible pointer types, the diagnostic now explains
that only the address is preserved, not a conversion of the pointed-to object.
It advises checking the actual pointee type and does not add a speculative cast.

Mixed Boolean/numeric operation guidance, 2026-10-13: FBC's warning now explains
that the Boolean operand is converted to an integer when it is mixed with a
non-Boolean operand. The guidance distinguishes logical-condition intent from
numeric bitwise intent and does not rewrite either operand.

Mixed signedness warning guidance, 2026-10-13: the warning now explains that a
signed operand may be converted to unsigned, where a negative value can behave
like a large positive value. It advises an explicit common signedness only when
that matches the intended comparison or operation.

Out-of-range shift warning guidance, 2026-10-13: the warning now explains that
FBC masks an invalid constant count to the operand width's low bits. It asks
users to confirm that wraparound is intended or keep the count within the
valid range; no rewrite is offered because the correct bound is type-dependent.

`FOR` limit warning guidance, 2026-10-13: FBC's fixed-width counter check now
explains that a counter at its boundary may wrap instead of exceeding the
limit, preventing natural loop termination. It suggests a wider counter or a
smaller limit but does not rewrite either.

Branch-crossing local warning guidance, 2026-10-13: the diagnostic now explains
that a branch can skip a local variable's initialization and advises
restructuring control flow or ensuring initialization on every path. It offers
no automatic edit because the correct control-flow change is program-specific.

Constant conversion overflow guidance, 2026-10-13: FBC's warning now explains
that the constant value or result is outside the target type's representable
range, and suggests checking the value, destination type, and literal suffix.
It does not choose a wider type automatically.

Optional parameter initializer guidance, 2026-10-13: the warning now explains
that the declaration and implementation supply different defaults for the
same optional parameter. It recommends keeping them consistent without
choosing which value the author intended.

Discarded `CONST` warning guidance, 2026-10-13: the diagnostic now explains
that removing the qualifier permits mutation through the converted alias. It
advises preserving `CONST` for potentially read-only storage and avoids a
speculative edit.

Reserved global warning guidance, 2026-10-13: the warning now tells users that
the global name conflicts with a compiler or backend-reserved symbol and
recommends a project-specific name. No automatic rename is offered.

Command-line override warning guidance, 2026-10-13: when compiler arguments
override a source directive, the diagnostic now states which configuration
source takes precedence and points users to the build arguments or directive
for resolution.

Mixed object build guidance, 2026-10-13: FBC's linker warnings for inconsistent
`-mt` and `-lang` settings now recommend rebuilding all linked objects and
dependencies with consistent project options. No build settings are modified
automatically.

Return method mismatch guidance, 2026-10-13: the warning now explains that
procedure declarations/definitions and function-pointer types must agree on
value versus `BYREF` returns, because callers rely on that contract. It remains
guidance only; the compiler warning does not identify which signature the user
intended to change.

Function-pointer return type warning guidance, 2026-10-13: FBC's distinct
`Return type mismatch in function pointer` warning now explains that the target
function's result type must match the declared pointer signature before the
pointer is called. It does not offer a cast or rewrite.

Function-pointer ABI warning guidance, 2026-10-13: calling-convention and
argument-count mismatch warnings now explain which part of the pointer's call
contract differs. The guidance emphasizes matching signatures and conventions
before invocation; it offers no automatic rewrite.

`CPTR` non-pointer warning guidance, 2026-10-13: the diagnostic now explains
that `CPTR` normally targets a pointer type, and cautions that converting an
address to a number requires an integer wide enough for the target. It does not
choose a conversion type automatically.

Compiler-confirmed `OPTION ESCAPE` bracket masking, 2026-10-13: semantic
configuration snapshots now identify physical statements whose default string
mode enables backslash escapes. Live bracket diagnostics use those bounded
source ranges, so an escaped quote cannot expose bracket characters or fake
identifiers inside a string as source code. Compiler-backed source tokenization,
parser occurrences, folding, and stock-FBC inlay-hint declaration scans use the
same ranges. Completion, Signature Help, Call Hierarchy, and Type Hierarchy
perform a cursor-sized worker query only when source scanning sees a possible
escaped quote, preventing suggestions, call signatures, and navigation items
inside a compiler-confirmed string without adding a worker round trip to
ordinary requests. The source-only scan remains conservative until compiler
facts arrive. Current-FBC and provider regressions check option decoding,
physical range projection, tokenization, bracket masking, completion
suppression, and call-like string rejection in an FBLite module.

Undeclared comma-separated `NEXT` counter typo correction, 2026-10-13: the
same exact correction used for a compiler-diagnosed counter mismatch now also
handles an undeclared list entry. It requires FBC's counter-binding context,
the exact offending token, a one-edit match to the active loop counter, and
all other entries matching their nested loops. Removal and multiple-mismatch
cases remain withheld. A current-FBC fixture confirms the point and fixed
nested loop; the focused provider test verifies the replacement.

Unassigned function-result warning guidance, 2026-10-13: the warning now tells
the user how to set a FreeBASIC function result, using either `Return
expression` or `Function = expression`. It remains guidance rather than an
automatic edit because a safe value cannot be inferred. The current-FBC test
confirms the warning clears after a real `Return`, and diagnostic publication
coverage checks the displayed guidance.

Preprocessor `defined` completion, 2026-10-13: conditional `#if` and `#elseif`
expressions now offer the `defined` operator without suppressing other
compiler-supported expression completions such as `TYPEOF`. Operand contexts
for `#ifdef`, `#ifndef`, `#elseifdef`, `#elseifndef`, `#undef`, and
`#if defined(` remain restricted to compiler-visible macros. Focused provider
coverage checks macro scope and the expression operator.

Preprocessor macro-name insertions, 2026-10-13: function-like macros now insert
only their identifier in `#ifdef`/`#undef` and `defined()` operands, instead of
the call snippet used in ordinary source expressions. A focused completion test
checks both compiler-visible scope and function-like macro insertion text.

Preprocessor `defined()` operand snippet, 2026-10-13: completing `defined` in
`#if`/`#elseif` now inserts `defined(MACRO)` with the operand selected for
editing, while leaving compiler-supported conditional expression completions
such as `TYPEOF` available. The focused provider test checks the snippet and
the surrounding completion set.

`defined()` source-symbol completion, 2026-10-13: `#if defined(` now supplements
compiler-active macros with earlier, nonconditional source declarations that
the source model can see, including constants and procedures. After a namespace
qualifier, it uses the source model's member completion rather than returning no
candidates. Macro-only directives remain compiler-scoped. Provider coverage
checks prior versus future/conditional declarations and qualified namespace
members; a current-FBC worker regression confirms qualified `DEFINED` probes.

Parsed expression coverage and IIf hover follow-up, 2026-10-13: the extension
now validates FBC's per-statement expression and IIf counts against owned
sidecar records, and withholds an operator hover when its parsed input receipt
is unavailable. Complete `IIf` operand identities also supply condition and
branch types on hover when branch conversions change the result type. Current
FBC tests cover count tampering, ordered-operand tampering, unavailable-input
hover suppression, and the displayed original branch types.

Numeric destination-context hover, 2026-10-13: when a complete full-model
receipt reports a primitive numeric assignment, initializer or function result
whose target differs from the original expression type, hover now shows both
compiler types. `Return` and `Function = value` use the compiler's separate
result-input records so they are not mislabeled as ordinary assignments.
When the sidecar also supplies a named source destination, hover preserves its
physical declaration spelling. Nonnumeric source assignments can show their
selected named destination without inventing a type conversion. Matching types
stay quiet; no source value or type is rewritten. Current-FBC coverage checks
the destination receipt and expression fact, and focused provider checks verify
both typed conversions and name-only destinations.

Array subscript conversion hover, 2026-10-13: FBC's original and selected
subscript identities now explain when a source expression is converted to
`Integer` for indexing. Only complete rank-sized groups with one matching
compiler marker and accepted statement ownership are projected; no-op indices
stay quiet. Current-FBC coverage uses the compiler's floating-index fixture,
and the provider check verifies the concise hover text.

Selected numeric operand hover, 2026-10-13: on a binary operator, the full
sidecar's selected operand types are now compared with the original source
operand types. Hover reports the compiler-selected pair only when coercion
changed at least one operand, keeping the Boolean comparison result separate.
The current-FBC mixed signedness fixture and a focused hover check verify the
distinction and operator-only placement.

Optional macro default in Signature Help, 2026-10-13: when FBC retains a
constant value for a source formal's original default expression, the
parameter documentation now adds that compiler-resolved expression value
without replacing the written default in the signature label. Nonconstant,
ambiguous, compact or incomplete defaults add no claim. A current-FBC macro
default fixture and a focused Signature Help test cover the value and display.

`SIZEOF` input hover, 2026-10-13: complete FBC size-query receipts now show the
selected expression type and confirm that expression inputs are unevaluated.
Array inputs explicitly identify total array storage, distinguishing them from
pointer-sized scalar queries. The hover is limited to accepted expression or
array inputs with captured compiler types; type-only and incomplete queries
add no claim. Current-FBC coverage checks both forms, and a focused provider
test checks the messages.

Explicit cast hover, 2026-10-13: FBC's physical `EX cast` receipt now supplies
the original operand type and selected result type on the cast token. The hover
formatter recognizes the cast family and remains restricted to its compiler-
reported range. Current-FBC coverage checks `CInt`'s source/result types, and a
provider test confirms the conversion explanation appears only on the cast.

Array-bound dimension hover, 2026-10-13: complete `LBound`/`UBound` receipts
now report when an explicit dimension is converted from a non-Integer source
type and, when constant, the compiler-selected dimension value. Omitted and
already-Integer dimensions remain quiet. Current-FBC coverage exercises
`UBound(matrixValues, 1.6)` and the provider test checks the conversion text.

Selected call-argument inlays, 2026-10-13: full sidecars now carry the
compiler-selected formal symbol, ordinal, and passing mode through to parameter
inlay hints. The query joins those receipts to the validated source call and
argument ordinal, then uses the source parser's exact argument start for editor
coordinates; it does not place hints directly from an AST expression range,
which can include an adjacent delimiter. Ambiguous formals or conflicting
source signatures remain suppressed. Current-FBC tests verify both ByVal and
ByRef labels, including when the inlay query has no separate parameter-mode
inventory.

Stock-sidecar constructor call guidance, 2026-10-13: physical
`new-constructor` selections and explicitly written constructor calls in a
`Return`, a direct variable initializer, or a procedure argument now supplement
direct call bindings. `New TypeName(argument)`, `Return TypeName(argument)`,
`Dim value As TypeName = TypeName(argument)`, and
`Take(TypeName(argument))` can use the compiler-selected constructor's formal
names and passing modes even when the source binding names only the type.
Sidecar-confirmed type aliases are joined to their nominal type identity before
matching the physical call, including aliases of aliases. Signature Help uses
the same selected procedure at those constructor calls. These features require
the exact physical binding to the owning type and a direct written constructor
expression, preventing implicit conversions or copy construction of an
ordinary function result from being mislabeled.
Qualified `New Namespace.TypeName(...)` calls recover the full callee span from
the compiler-bound final type component, preserving both constructor hints and
Signature Help.
Declaration signatures must agree across prototype and definition; omitted,
ambiguous, or nonphysical constructor sites remain quiet. A current-FBC worker
regression checks overloads and aliased calls across explicit constructor
forms, parenthesized and unparenthesized procedure arguments, and rejects
relabeling implicit scalar conversions and function-result copies.

Constructor completion through type aliases, 2026-10-13: constructor-argument
snippets now work for `New Alias...`, `Return Alias...`, direct variable
initializers, and type-constructor expressions in procedure arguments when the
source semantic model resolves one aggregate type with one usable constructor.
Stock-sidecar requests are limited to those constructor expression prefixes and
require physical FBC bindings. Overloaded or ambiguous aliases keep ordinary
name completion rather than guessing which parameter list to insert. Current-
FBC worker and focused provider tests cover the placeholder and overload
fallback. Qualified `Return Namespace.Type...` and qualified initializer
expressions use the namespace's type members as well.

Stock-sidecar `NEW` type completion, 2026-10-13: the configured FBC sidecar
does not provide the source-to-expanded token map used by ordinary scope
completion. For this completion path, the provider requests a binding-capable
snapshot for a `NEW` type prefix in a clean saved buffer. When projected scope
results are absent, aggregate candidates come from the source scope model only
if FBC reports a unique physical declaration binding at the same range. The
fallback follows FBC's reachable include-context tree, so declarations from
headers included before the cursor can participate without exposing unrelated
or later includes.
Constructor snippets reuse that scoped source model and are withheld for
overloaded constructors. Qualified `New Namespace.Type...` prefixes use the
namespace's type members and remain constructor completion rather than ordinary
member completion. Current-FBC worker coverage checks a type, an alias, and a
qualified namespace alias from an included header, including its `New`, `Return`,
and initializer snippets; the provider test checks on-demand binding requests
and rendered snippets for simple and qualified prefixes.

Qualified constructor Signature Help, 2026-10-13: the provider resolves the
final type component in a qualified call such as
`Return Namespace.TypeName(argument)` before requesting sidecar bindings. This
prevents the namespace token from suppressing constructor overload selection.
A focused provider test checks the binding request and selected signature.

Stock-sidecar pointer member completion, 2026-10-13: the remote completion path
now uses the existing typed-member provider for compiler-only analyses. If the
sidecar point lands on a scalar result of a larger member expression, or a
recovery snapshot has no usable receiver expression, or the type spelling is
ambiguous outside its lexical scope, completion uses the source model's resolved
receiver rather than returning an empty member list. The fallback requires one
nonconditional receiver, one nonconditional aggregate type, and unambiguous
members; otherwise it remains empty. Compiler-confirmed aggregate types still
take precedence. A focused provider regression covers compiler-selected
function results, an ambiguous unqualified type in a using-namespace scope,
the scalar enclosing result, missing-expression recovery, ambiguous fallback,
and an implicit `WITH` receiver after a comment line.

Stock-sidecar macro parameter inlays, 2026-10-13: visible calls that resolve to
source macros now request the full selected macro-signature facts rather than
the compact form used by ordinary parameter hints. The inlay query uses the
compiler-selected definition at that physical invocation, preserves redefinition
selection, emits fixed positional formal names, and omits variadic and named
arguments. Ordinary procedure calls keep the cheaper compact-macro request.
Provider tests verify the selective request and on-demand model upgrade; the
current-FBC macro redefinition fixture verifies selected names and variadic
suppression, nested physical macro calls in actual arguments, and fixed
parameters on `#macro` block invocations. Physical calls in `#if`, `#elseif`,
and `#assert` evaluation expressions also retain their formal-name hints. Hover
now prefers a directly hovered nested call over its enclosing macro call, so the
inner call keeps its own selected signature.

BYREF-result assignment Quick Fix, 2026-10-13: the compiler's warning about
`functionCall(arguments) = value` already includes an exact physical source
point and recommends wrapping the call. The diagnostic now underlines the
ambiguous `=` token and offers that edit only when one bare function call is
the whole left-hand expression. Comparison-shaped conditions and lines with
multiple assignments are left untouched. The existing current-FBC regression
confirms that the parenthesized form removes the warning; focused range,
publication, and Quick Fix tests cover the editor path.

Nested-conditional Quick Fix, 2026-10-13: FBC's exact warning for `Else If`
after a multiline `Else` now offers an opt-in replacement with `ElseIf`.
The action is intentionally not preferred because changing nesting to chaining
can change control flow; it requires the exact warning and matching source
spelling, including when the compiler underlines only `If`.

BYREF address Quick Fixes, 2026-10-13: for suspicious BYREF-temporary and
pointer-to-scalar warnings, the provider offers removal of `@` only when the
warning identifies one same-line call and argument ordinal, the argument is
exactly `@variable`, and source resolution finds one nonconditional variable,
field, parameter, or external variable. A pointer-to-scalar warning can also
offer a leading dereference for a simple pointer variable only when its pointee
type matches the formal scalar type. For scalar-to-pointer warnings it offers
inserting `@` only for a bare resolved variable when the unique procedure
formal is `ByVal` and its pointer base type matches the source variable type.
Function-result addresses, other expressions, repeated warnings, ambiguous
declarations, and mismatched pointer base types remain untouched. Installed FBC
checks confirm the four exact edits (`ClearAny(@localValue)` to
`ClearAny(localValue)`, `UseScalar(@localValue)` to `UseScalar(localValue)`,
`UseScalar(pointerValue)` to `UseScalar(*pointerValue)`, and
`UsePointer(localValue)` to `UsePointer(@localValue)`) clear their warnings.
Focused provider tests verify identity, mode/type guards, and edit ranges.

Inline FOR counter widening, 2026-10-13: FBC warns when a narrow counter cannot
advance past its limit without wrapping. For an explicit inline integer type,
the compiler-selected limit token is underlined and the Quick Fix offers the
next wider fixed type (or `LongInt`/`ULongInt` for the widest 32-bit forms).
It is not preferred because changing the counter type affects the loop
variable's range. Separate declarations, aliases, and already wide types are
left untouched. Current FBC checks confirm each offered widening clears the
warning on the tested target.

File-transfer pointer Quick Fix, 2026-10-13: an exact `Passing Pointer`
warning in a simple `PUT`/`GET` value slot can offer `*pointerVariable`
when source resolution confirms one primitive pointer variable. UDT pointers,
arrays, nested expressions, and non-file-transfer syntax remain untouched. A
current-FBC check confirmed both `PUT` and `GET` warnings clear after
dereferencing the same pointer variable.

Constant-overflow Quick Fix, 2026-10-13: for one simple `DIM`, `STATIC`, or
`CONST name AS integer-type = decimal-literal` declaration, the FBC overflow
warning now underlines its physical literal. The opt-in action chooses the
smallest supported wider signed/unsigned type that contains that exact integer;
computed expressions, suffixes, multi-declarator lines, and values beyond
`LongInt`/`ULongInt` are withheld. Current FBC verifies Byte-to-Short and
Byte-to-Long corrections clear the warning, while focused tests cover the
literal range, publication, edit, and fail-closed cases.

Parameter-default mismatch Quick Fix, 2026-10-13: for the exact FBC warning,
the editor can align an implementation's simple integer literal (including
radix/suffix forms), floating-point literal, Boolean, plain quoted-string, or
simple named top-level `CONST` default when procedure kinds and all parameters
otherwise match. Named constants are offered only when source-semantic
resolution proves both declarations see the same nonconditional `CONST`;
mutable variables and macro spellings remain manual.
Without a current compiler analysis snapshot it uses a unique same-file `DECLARE`; with a snapshot it
checks the complete compiler source set, allowing an included-header prototype
while detecting same-file/header conflicts. Snapshot candidates must be unique
and nonconditional; the provider never searches unrelated workspace files.
Continued signatures are supported when the implementation's simple default is
isolated on its own physical parameter line. The opt-in action edits only the
implementation; complex defaults and ambiguous declarations remain manual
choices. Current FBC clears the warning after the edit; focused tests cover
same-file and named-constant defaults, reject mutable and macro names, and cover
Boolean/string/suffixed-integer/
floating-point literals, included-header and continued signatures, and
ambiguous/conditional fail-closed cases.

Suspicious pointer assignment diagnostic range, 2026-10-13: FBC's structured
warning carries a physical point on the pointer expression, even though its
generic message does not repeat the token. Compile-only and on-demand
diagnostics now use that point for this exact warning, narrowing the squiggle
to the compiler-selected operand rather than the whole line. Identifier
operands now underline the full token; other compiler-selected non-whitespace
characters retain the one-character range. The current FBC probe confirms the
point lands on the right-hand pointer expression; service tests cover both
diagnostic publication paths.

Declared local FOR counter widening, 2026-10-13: the non-preferred wraparound
Quick Fix also handles a separately declared local counter when FBC's warning
range identifies the loop limit and the source semantic model resolves the
counter to one simple `DIM` inside a procedure. It edits only an explicit
primitive integer type; parameters, module-level variables, aliases, arrays,
and compound declarations remain manual choices. A current-FBC check confirms
that widening a declared `UByte` counter to `UShort` removes the warning, and
provider tests cover the declaration edit and fail-closed cases.

Function-pointer mismatch ranges, 2026-10-13: for the exact return-type,
return-method, calling-convention, and argument-count mismatch warnings, the
editor expands FBC's physical point to the selected identifier token. This
improves ordinary source assignments while leaving macro-expanded warnings on
the existing line fallback when FBC supplies no physical point. The warning
still does not identify which side of the signature should change; this is a
range improvement only. Current-FBC probes confirmed exact points for all four
warning families, and compile-only plus on-demand publication tests cover the
range and missing-point fallback.

Constant-conversion warning ranges outside declarations, 2026-10-13: computed
expressions now underline the compiler-selected token when FBC points directly
to token text; simple integer declarations retain the fuller literal range used
by their guarded widening Quick Fix. A current-FBC probe found that parameter
conversion warnings point at the call's closing delimiter, not the argument,
so those remain broad rather than suggesting a false argument location. Focused
compile-only and on-demand tests cover both the token range and this fallback.

Mixed-operation and oversized-shift warning ranges, 2026-10-13: FBC physical
points for mixed Boolean/numeric operations and out-of-range constant shifts
now underline the selected operand token in both diagnostic paths. The compiler
warning corpus contains 18 mixed-operation and 14 shift cases on the current
target; direct probes confirm the physical point is in the operand, and focused
tests cover compile-only and on-demand publication.

CONST-discard warning ranges, 2026-10-13: when FBC points at the identifier
whose CONST qualifier is discarded, the editor now underlines that full token
in both diagnostic paths. Call warnings whose physical point lands on a closing
delimiter remain broad. The upstream warning corpus contains 72 CONST-discard
cases on the current target; a current-FBC cast probe confirmed the selected
identifier range, with compile-only and on-demand coverage.

Oversized stack storage warning ranges, 2026-10-13: FBC's physical points for
fixed-length strings, UDT locals, and arrays now underline the selected size or
type token for both large-variable and large-array warnings. The current target
warning corpus has four large-variable and two large-array cases; a compiler
probe confirmed the points land inside those declarations, and focused tests
cover both diagnostic paths.

Overflow diagnostic guidance, 2026-10-13: parameter-context constant overflow
warnings now identify the affected parameter and explain that either its
constant value or declared type may need attention. The separate literal-
truncation warning now clarifies that widening only the destination cannot
recover bits already discarded while parsing. These were the largest remaining
warning families without guidance in the upstream target corpus (368 parameter
overflow and 132 oversized-literal cases); focused guidance tests cover both.

Ignored-suffix warning guidance, 2026-10-13: FBC warnings now explain that an
ignored type suffix does not control the token's type and suggest removing it
or using an `AS` clause for an explicit declaration type. The message is
severity-gated and applies equally to keyword suffixes and suffix/AS conflicts;
targeted Quick Fixes remain available where their source shape is supported.

Malformed numeric literal guidance, 2026-10-13: the `Expected digit` warning
now explains that a base prefix or exponent marker needs a valid digit. FBC's
current physical point lands at the assignment operator in the corpus example,
not the malformed literal, so this remains guidance only with the existing
broad range.

Ambiguous intrinsic name guidance, 2026-10-13: `LEN`, `SIZEOF`, and `TYPEOF`
warnings now say which same-named type/value FBC selected and recommend making
the intended value expression unambiguous or renaming one declaration. This
covers the 10 ambiguity cases in the current upstream target corpus; focused
tests include type, constant, variable, and forward-reference collisions.

Implicit-conversion warning range and guidance, 2026-10-13: the current
compiler's generic conversion warning supplies a physical point on the source
literal but no source/target type details. The editor now underlines that token
and advises users to review signedness and width without guessing the actual
conversion. Focused compile-only and on-demand tests cover the range and
severity-gated guidance.

Large stack warning guidance, 2026-10-13: variable/array stack-size warnings
now explain that `SHARED` changes storage lifetime and visibility, and that a
variable-length array is an alternative when fixed bounds are unnecessary.
Focused tests cover both warning forms and their severity gate.

Parameter-default mismatch range, 2026-10-13: FBC displays this warning at
`End Sub`/`End Function` but its structured physical point identifies the
implementation name. Compile-only and on-demand diagnostics now underline that
compiler-selected name, allowing the same-file Quick Fix to work with a real
compiler range. A current-FBC probe confirmed the display-line/physical-point
split; focused coverage checks both diagnostic paths and the continued-header
edit.

Compiler-confirmed enum parameter defaults, 2026-10-13: the parameter-default
Quick Fix now handles simple enum-member names when the stock semantic sidecar
binds both exact references to members of the same enum. It withholds the edit
for missing, ambiguous, provisional, or different-owner bindings. Worker and
provider tests cover same-enum acceptance and cross-enum rejection.

Qualified Explicit-enum parameter defaults, 2026-10-13: the same Quick Fix
accepts simple `Enum.Member` defaults. It queries only the compiler-bound member
token but edits the complete qualified expression, and still refuses different
enum owners or incomplete semantic snapshots. Current stock-FBC sidecar and
provider tests cover the binding owner, query range, and replacement range.

Qualified `CONST` parameter defaults, 2026-10-13: the source semantic resolver
now checks the terminal symbol of a simple qualified name, then confirms that
the complete declared name resolves to that same `CONST` at the implementation.
The Quick Fix edits the whole qualification; macro name collisions and complex
expressions remain manual. Provider coverage includes `Settings.DefaultColor`.

Compiler-confirmed enum member completion, 2026-10-13: stock-sidecar completion
now offers members of earlier, non-conditional, non-Explicit enums declared in
the active source file or in headers the selected module has included before
the cursor. Accepted `USING` receipts in included sources also expose their
compiler-bound namespace members without requiring an existing use at the
completion site. The compiler must bind the member and its owning enum to the
exact physical declarations; Explicit members are withheld from unqualified
suggestions, while qualified Explicit-enum completion follows the compiler's
bound member reference. Current-FBC worker tests cover procedure completion,
namespace-imported members, include order, and both qualified and unqualified
Explicit-member behavior.

<!-- end of compiler-grade-plan.md -->
