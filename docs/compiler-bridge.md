# Compiler-backed language support

Primitive keyword hovers consume the optional `accepted-primitive-type-layouts`
family. Each counted input has a same-owner/detail layout companion containing
canonical spelling, public storage kind, decimal byte width and pointer depth.
Both readers require complete pairing and reject orphan or inconsistent layouts.
Byte widths remain decimal strings, avoiding host-number rounding. No dtype
bitfield interpretation is needed. Older producers retain reference hovers.

Hovers describe the complete accepted type component, not array totals or ABI
argument slots. Pointer values and string descriptors are labelled explicitly;
fixed string lengths retain their full width. Native primitive facts take
precedence over enclosing expression results and source-index guesses. Conflicting
physical contexts withhold the layout. Cold type hovers request the existing
binding snapshot directly and reuse it on subsequent requests. Rebuild the
editor bridge, or the normal compiler separately, to expose the new capability.
The binary schema remains 27 and the bridge trace protocol remains 15.

Primitive semantic highlighting consumes FBC's counted
`accepted-primitive-type-inputs` observations. Both binary readers validate
module/statement/source ownership, count/ordinal closure and physical-origin
roles. Only verified keyword extents become `type.defaultLibrary` tokens;
existing symbol or alias classification at a shared physical site wins. Neither
internal keyword IDs nor dtype bit layouts are interpreted to infer a type use.

The current-source bridge keeps this family available in compact full models.
Macro provenance remains separately gated, and an absent or unverified macro
location cannot create an editable keyword span. Stock FBC's full-macro semantic
token snapshots already expose the family. No extra editor compiler pass is
added. The appended standard modifier preserves the indices of existing
modifiers, with a fallback to `storage.type.freebasic` for existing type colors.
Rebuild an older bridge for compact-mode primitive receipts; protocol 15 is
unchanged by this semantic-family availability extension.

The bridge uses the real FreeBASIC compiler for preprocessing, committed call
resolution, expression types, editor-buffer overlays, and validated project
symbol rename. The extension remains version 1.20.5 to match its source
target. These are working compiler-backed features, not a claim that every
language-server operation has compiler-grade coverage.

The current-source bridge also needs the compiler's canonical 128-bit type
formatter correction in `src/compiler/symbols/symb.bas`: public type spellings
must use `Integer<128>`/`UInteger<128>`, including nested callback types, while
normalized NT primitive codes remain `integer128`/`uinteger128`. The current
local source and `dist/fbc-editor-current` include this correction. Rebuild the
normal compiler separately when its diagnostic/sidecar type spellings need the
same update; building the private bridge does not replace the normal compiler.

## Implemented foundation

`tools/build-compiler-bridge.js` copies the compiler's BASIC source into a fresh
directory under `dist/`, inserts checked lexer/parser hooks, and builds `fbc-editor`
with an existing FreeBASIC compiler. It does not modify `/home/jkfirth/fbc`,
replace the system compiler, install packages, or publish anything. Linux,
the bootstrap compiler, its runtime/development files, and its normal native
assembler/linker toolchain are required. A failed build retains its private
source directory for inspection. The compiler remains subject to its upstream
license; it is not part of the MIT-licensed VSIX.

The instrumentation is inactive unless the extension supplies
`FB_VSCODE_TRACE=1`. It adds comments to `-pp` output, not executable BASIC:

```text
''@fb-editor-protocol 15
''@fb-editor-file-v10 <file ID> <hex-encoded UTF-8 filename>
''@fb-editor-token-v11 <serial> <start byte> <end byte> <source|generated> <physical start byte> <physical end byte> <file ID> <macro map ID or 0> <macro epoch>
''@fb-editor-map <ID> <kind> <native length> <first input> <second input> <offset> <physical start byte> <physical end byte> <macro symbol ID or 0> <parameter ordinal> <file ID or 0>
''@fb-editor-macro-declaration <instance ID> <symbol ID> <name map ID> <epoch> <parameter count> <native flags> <argless: 0 or 1>
''@fb-editor-macro-parameter <instance ID> <parameter ordinal> <declaration|reference> <map ID> <hex spelling>
''@fb-editor-macro-reference <symbol ID or 0> <map ID> <epoch> <invoke|query|undef|deferred> <hex spelling>
''@fb-editor-macro-context <conditional-directive map ID> <epoch>
''@fb-editor-v2 <output serial> <one-based source line> <generated: 0 or 1> <hex filename>
<one preprocessed output line>
''@fb-editor-bind <declaration|call> <output serial> <byte column> <procedure ID> <hex spelling>
''@fb-editor-type <start serial> <start byte> <end serial> <end byte> <hex type> <dtype> <subtype ID>
''@fb-editor-expression <ID> <kind> <start serial> <start byte> <end serial> <end byte> <dtype> <subtype ID> <first input> <second input> <third input> <target procedure ID or 0> <options> <hex type>
''@fb-editor-expression-family <expression ID> <hex compiler parser entry point>
''@fb-editor-receiver <output serial> <byte column> <hex receiver type> <dtype> <subtype ID>
''@fb-editor-norename <procedure ID>
''@fb-editor-symbol <ID> <class> <dtype> <subtype ID> <owner ID> <namespace ID> <attributes> <procedure attributes> <scope depth> <procedure ID> <hex name or -> <hex type or ->
''@fb-editor-use <declaration|reference> <output serial> <byte column> <symbol ID> <hex spelling>
''@fb-editor-alias <symbol ID> <canonical symbol ID>
''@fb-editor-symbol-norename <symbol ID>
''@fb-editor-dispatch <procedure symbol ID> <overridden symbol ID or 0> <vtable slot or 0>
''@fb-editor-scope begin <scope ID> <parent scope ID or 0> <owner symbol ID> <start serial> <start byte> <kind>
''@fb-editor-scope end <scope ID> <end serial> <end byte> <recovery unwind: 0 or 1>
''@fb-editor-declaration <symbol ID> <scope ID or 0> <start serial> <start byte> <end serial> <end byte> <prototype: 0 or 1> <hex spelling>
''@fb-editor-shape <symbol ID> <base type ID or 0> <anonymous parent ID or 0> <native type options> <parameter mode> <optional: 0 or 1> <array dimensions>
''@fb-editor-import <source namespace ID> <destination namespace ID or 0> <serial> <byte>
''@fb-editor-invalid <first output serial> <last output serial>
''@fb-editor-unevaluated <start serial> <start byte> <end serial> <end byte>
''@fb-editor-error <one-based source line> <hex filename> <error code> [output serial] [error byte column]
''@fb-editor-end <error count> <root parser reached EOF: 0 or 1>
```

File records name physical inputs, including empty files and includes containing
only preprocessor directives. Logical `#line` filenames are not dependencies.
Token origin fields live in the compiler's token structure, so lexer lookahead
retains the corresponding origin instead of substituting the most recent
scanner position. A line is marked generated when it contains expansion tokens
or combines origins. Record lines become blank lines before building the editor
model, so expanded coordinates do not shift when metadata is removed. Older
bridges below protocol 14 must be rebuilt even for modules with no procedure
calls. Protocol 14 remains accepted; rebuild to protocol 15 for unevaluated-query
classification in the local bridge Call Hierarchy.

Protocol 15 records the expanded operand intervals of native `TYPEOF` and
`SIZEOF` parser scopes. Call Hierarchy excludes runtime edges within these
intervals, including implicit construction and index operations. The bindings,
expression types and reference locations are retained. Expanded coordinates
keep separate uses of one physical macro argument distinct; source spelling
alone cannot establish whether a call is evaluated. `LEN` is not excluded,
since a dynamic-string operand can execute at runtime.

Full binary sidecars already expose `unevaluated-query-inputs` coverage and
expression-ID interval receipts. Both readers validate the complete intervals,
their module/global-namespace ownership and every marked input, even when the
editor retains only a filtered expression set. Project hierarchy uses those
roles for implicit construction/operator sites. The innermost native expression
classifies a physical site; conflicting evaluated and unevaluated roles at one
range retain the edge. Ordinary Find References does not apply this filter.

Explicit project Call Hierarchy reads request full macro provenance instead of
the normal compact macro export. Current FBC's `source-call-macro-references`
capability supplies counted CALL-to-MR attachments. Both binary readers validate
the per-module global-namespace count receipt, selected direct/virtual interface,
native macro origin and invocation module. Dropped attachments cannot masquerade
as a complete caller list. Indirect runtime targets are not inferred.

These calls have no written B callee binding. The project projection follows
native expansion parents to a physical invocation and reports its source range,
including the argument list when the native closing receipt maps physically.
The range is a reporting anchor, never a rename edit. One expansion can retain
several distinct native callees. Incoming trees keep that complete invocation
site instead of adding a narrower bridge argument location as another call.
Ordinary reference ambiguity checks and non-hierarchy macro request sizes are
unchanged. This consumes existing compiler records; no bridge rebuild is needed
beyond the protocol-15 build described above.

The bridge also retains native definition/argument origin roles during physical
projection. Replacement-body names remain references, but are not reported as
runtime sites on a `#define`/`#macro` body. Outgoing trees containing such calls
or unmapped committed callees, including pasted names, use the full project
projection, including the ordinary current-module context. Unevaluated query
operands do not trigger this runtime-call upgrade.

The invalid serial interval remains authoritative for declarations, bindings,
and token resolution. The error record also carries the compiler error code and,
when the lexer has a stable lookahead, its expanded serial and byte column.
Only `FB_ERRMSG_EXPECTEDEXPRESSION` uses that position to retain completed
expression nodes ending strictly before the missing-operand location. Their
direct source tokens are projected only for expression queries; they are not
added to native name resolution or rename. Semantic type errors and error
classes without positioned recovery continue to invalidate the whole statement.

The real compiler handles conditional expressions, predefined symbols, `-d`,
includes, `#define`, and `#macro`. The existing semantic model then analyzes the
resulting single translation unit. This removes inactive declarations and
makes macro-generated declarations available. Native procedure bindings then
override the lightweight model's declaration families and call resolution.

## Semantic sidecar operator ABI

Semantic-model schema 8 introduced conceptual operator fields on AST node
(`N`) and source expression (`E`) records. Schema 9 retains them and lets parser
records preserve a compiler-known operation when lowering replaces the source
operator node before export. Consumers should use `operatorCode` and
`operatorKind` for operator semantics. The compiler's numeric AST class and
operator fields are still present for diagnostics and schema compatibility,
but they are compiler-private implementation details and are not a tooling ABI.
The extension's analysis rules do not branch on those numeric values.

`operatorKind` is `builtin`, `overloaded`, or `none`. A `none` kind has an empty
operator code. The schema 9 vocabulary is:

```text
assign, add, subtract, multiply, divide, integer-divide, modulo,
add-assign, subtract-assign, multiply-assign, divide-assign,
integer-divide-assign, modulo-assign, and-assign, or-assign,
logical-and-assign, logical-or-assign, xor-assign, equivalence-assign,
implication-assign, shift-left-assign, shift-right-assign, power-assign,
concatenate-assign, and, or, logical-and, logical-or, xor, equivalence,
implication, shift-left, shift-right, power, concatenate, equal,
greater-than, less-than, not-equal, greater-or-equal, less-or-equal,
identity-test, not, logical-not, unary-plus, negate, address-of,
dereference, index, cast, convert-to-integer, convert-to-float, allocate,
allocate-array, deallocate, deallocate-array
```

The current schema-27 reader also accepts `member-access`, boolean and
signedness conversions, the normalized math operations, `length`, the three
UDT iterator operations (`iterator-initialize`, `iterator-step`, and
`iterator-next`), and the `va-start`/`va-arg`/`va-copy`/`va-end` operations.
These conceptual strings remain the tooling ABI; numeric AST fields remain
compiler-private.

Built-in codes describe the compiler-resolved operation; overloaded codes come
from the compiler-selected operator procedure. Both may use the same code,
with `operatorKind` preserving which path resolved. If a recognized built-in
operation is lowered to a helper call before an expression record is emitted,
the parser may retain that operation's conceptual code while the raw AST fields
continue to describe the lowered node. Codes are never guessed from written
spelling. Constant-folded source expressions may have `none` when the compiler
has replaced the operator node with a constant.

Schema 9 record fields, including their order, are (schema 8 has the same
layout):

| Record | Fields after the tag |
| --- | --- |
| `N` | identity, parent, edge, private AST class, private AST operator, conceptual operator code, operator kind, data type, symbol, subtype, source line, source path |
| `E` | identity, physical-range flag, source path, start line, start column, end line, end column, private AST class, private AST operator, conceptual operator code, operator kind, data type, symbol, subtype, type spelling |

The conceptual-code vocabulary is versioned with this sidecar schema. Adding a
new code or changing its meaning requires a schema-version increment and
matching reader/documentation updates; unmapped compiler operations use `none`
rather than leaking a private opcode. Readers continue to accept schemas 2
through 14; schemas 2 through 8 predate the lowered-operation provenance rule.

## Implicit construction and destruction relationships

Schema 10 adds an `I` record for compiler-selected constructor calls discovered
while initializing declarations. Schema 12 adds `destructor-call` relationships
for UDT fields and variables whose cleanup routine is compiler-selected at
their declaration. Fields and variables use their exact declared-name source
range as the owner anchor. An `I` record contains owner symbol ID, selected
procedure symbol ID, owner UDT symbol ID, stable kind (`default-constructor`,
`initializer-constructor`, `new-constructor`, `destructor-call`, or
`argument-constructor`),
physical-range flag, source path, and an anchor range. Default and initializer
constructors use the declared object name; `new-constructor` uses the exact
UDT type reference in a `NEW` expression. Anchors are relationship context
only and must never be converted into an edit or rename occurrence. Project
mapping requires an exact compiler binding at the anchor: declaration binding
for declaration-owned calls, reference binding for `NEW`. Selected procedure
symbols remain available in the sidecar for semantic provenance even when
compiler special procedures are not representable as editable bridge symbols.
Argument-constructor anchors instead span the physical actual expression; the
owner maps through the exact declaration of its formal parameter and is
accepted only when the compiler symbol is a parameter. A copied macro argument
is accepted only when emitted-token tracing and the provenance map prove one
complete, ordered physical span. Replacement-list text, token-paste gaps,
stringification, callback/unknown origins, and ambiguous mappings remain
withheld.

Current FBC builds also emit `construction-observation:<ordinal>` K properties
for selected constructors whose choice must survive lowering even when no
editable I range is available. The payload retains the selected procedure,
owning type, call kind, statement, source context, and any recorded macro
identity; a module closure count and the `implicit-construction-inputs`
capability make the set verifiable. Project rename compares these observations
before and after the edit so a type rename cannot silently change a constructor
choice. K facts do not identify an editable token and must not be used as
definition, reference, or rename locations. Physical I ranges remain the only
source for those operations.

Current hooks cover scalar and fixed-array default construction,
copy/conversion constructors in scalar UDT initializers, default and explicit
construction of UDT fields, default construction of optional UDT parameters,
explicit scalar and default scalar/vector `NEW` construction, and
field/local-variable destruction. Formal
parameters have initializer relationships when applicable but are excluded
from destructor relationships because the compiler does not generate their
cleanup calls.

Schema 14 adds `temporary-destructor` for a compiler-selected UDT destructor
that is actually built while flushing a temporary cleanup list. Its owner and
owner type are the same UDT symbol, and its physical anchor is the narrowest
verified source expression that created the temporary. The anchor is semantic
context only; temporary cleanup has no written callee token and is never an
edit or rename occurrence. Macro-expanded and otherwise unanchored temporaries
remain withheld. Temporary symbols retain their validated physical provenance
when TYPEINI scopes clone them into generated constructors, preserving the
expression range for each cloned cleanup entry. Schema 15 adds
`scope-exit-destructor` for declared locals
cleaned while lowering `GOTO`, `RETURN`, `EXIT`, or `CONTINUE`; it anchors the
relationship to the physical branch keyword and exact local/type identities.
Schema 16 adds `delete-destructor` for scalar `DELETE` and vector `DELETE[]`,
anchored to the physical keyword with the exact pointee UDT identity. These
records are semantic relationships, not editable callee occurrences.
Schema 17 adds `return-constructor` when the compiler converts a `RETURN`
expression to the function's UDT result using a selected constructor. Its
anchor is the physical return expression and its owner/type are the exact
result UDT identity; it has no editable callee occurrence.

The schema 10 `END` footer appends the implicit-call record count after the
binding count. Schema 11 appends a `target signature` to each `I` record.
Through schema 17, the signature starts with `sig1`; each explicit procedure
parameter is represented by its passing mode, optional-parameter flag,
BYDESC-dimension count, and length-prefixed canonical type spelling. The
compiler's implicit instance parameter is omitted. A parameter whose type is
the owning UDT uses `$self`. Schema 18 replaces that encoding with `sig2`:
mode, optionality, dimensions, full datatype flags, and the exact named-subtype
symbol ID from the same semantic-model snapshot. This remains unchanged when
a referenced UDT is legally renamed, while preserving overload distinctions.
Its subtype IDs are snapshot-local; treat the whole field as an opaque
project-validation equality key, not a display value or persistent
cross-build identity. Schema-10 records remain decodable, but project
validation withholds implicit-call facts that lack a signature. Schema 12 is
the first schema that accepts `destructor-call`; older schemas reject that
kind. The expression-only `RECOVERY` footer retains its prior layout and
cannot contain implicit-call facts; failed modules do not publish those
facts. Schema 13 is the first schema that accepts `argument-constructor`;
older schemas reject it.

## Committed procedure bindings

Each canonical compiler procedure owns an integer ID, assigned in declaration
order. A matching prototype and body reuse the same compiler symbol and ID;
distinct overloads do not share an ID. These IDs are deterministic for an
unchanged translation unit, not persistent cross-edit or workspace-global IDs.
The bridge does not export process addresses or use linker aliases as identity.
A declaration ID is positive; a call ID of zero means no declaration was exported.

The lexer records the last consumed token's position in the pending output
line. Call parsers copy that position before parsing arguments, so a nested
call cannot overwrite its parent's location. The argument parser reports the
selected procedure before virtual-call lowering substitutes an anonymous
function-pointer prototype. Procedure headers export the canonical symbol
after prototype/body reconciliation. Recovery snapshots exclude failed regions
and cannot supply refactoring targets.

Output serials count nonempty emitted source lines, independent of interleaved
metadata. Byte columns address the compiler's actual output spelling. The
decoder validates bounds, UTF-8 boundaries, spelling, duplicate coordinates,
and line references. For unmarked legacy bytes, it accounts for the extra UTF-8
byte introduced when a single source byte is decoded as U+00xx. It then converts
columns to VS Code's UTF-16 units. The model also requires a complete identifier
token at each binding position.

Supported bindings cover named direct functions/subs, numeric overload
selection, optional arguments, nested/qualified calls, methods, properties,
BYREF-returning calls, and compile-time virtual targets. Continued calls retain
physical locations. Copied macro arguments and replacement-list identifiers also
retain physical locations; constructed callees remain in expanded text. The shared
resolver uses these bindings for definitions, overload-specific references,
signature help, semantic tokens, and function-result member lookup. An exported
call whose declaration cannot be represented resolves to no target, not a
same-spelling guess.

This is not a complete AST or symbol-table export. Runtime virtual destinations
and indirect call targets are not statically known. The expression graph now
records conversions and calls lowered through `astBuildCall`, including
overloaded operators. A written conversion that selects an overloaded `CAST`
operator retains the lowered call as its conversion dependency, including when
the compiler selects that conversion while binding a procedure argument. A
selected unary overload remains a call dependency of its written operand rather
than becoming an unbound temporary. Explicit scalar and vector `DELETE` also
retain the compiler-selected UDT destructor on the written pointer expression,
separately from any overloaded deallocation operator. Other implicit
constructor, destructor, and runtime-helper paths still need coverage.
Non-procedure identities are described in the next section; their coverage is
not yet complete.
The regression surface also checks address forms (`SADD`, `STRPTR`, `VARPTR`,
and `PROCPTR`), exact `CAST` and `CPTR` conversions, scalar/vector `NEW`, and
math/file runtime forms. Each selected source span must retain a native type
record; this complements the quirk-parser target checks without claiming the
remaining expression grammar is complete.
Unsupported constructs still rely on the lightweight model or remain unresolved.
References are limited to the selected translation unit and supported binding
forms; they are not a complete project-wide reference set.

## Native symbol relationships

The bridge exports committed declarations and uses for variables, parameters,
fields, constants, enum members, types/aliases, namespaces, named and numeric labels, and
named procedures. The compiler symbol owns a separate stable-within-run ID.
Both pooled allocation sites explicitly initialize it. Metadata carries native
class, full dtype, subtype, lexical owner, namespace, attributes, and scope depth.
Recursive owner/type graphs are emitted without recursively revisiting cycles.

Parameter prototypes, implementation parameters, and body variables can be
different compiler objects. Explicit alias records join them at the compiler's
prototype checks and parameter-variable construction, including different
prototype/body spellings. The decoder validates graph edges, alias cycles,
symbol classes, byte coordinates, and complete token spelling. At most 200,000
symbol metadata/use/alias/restriction/dispatch records are accepted per translation unit.

Namespace imports include the final operand, not just dotted qualifiers.
Procedure addresses use the overload selected by the compiler's expected or
explicit signature; they are references, not calls. Function-result assignments
bind to the active procedure body. Forward-type replacement emits an alias
before the compiler frees the temporary symbol and refreshes affected type
metadata. The typedef name remains distinct from the type it references.

Every exported procedure has dispatch metadata. Virtual methods carry their
native vtable slot and overridden procedure identity. The decoder rejects
missing records, non-procedure edges, cycles, and slot mismatches. Slots zero
and one are reserved in actual FreeBASIC vtables; a record with slot zero means
a nonvirtual procedure. An overriding method can reuse a slot without itself
being declared VIRTUAL, so its slot and edge are retained independently of that
attribute. Overrides are joined for rename, not for static navigation.

Mapped declarations receive these identities; native uses seed both positive
and negative resolution. References use native use records for these symbols.
Expression/receiver and declaration type links use subtype IDs. Protocol 8
supplies the declaration inventory and lexical scope ranges described below.
Implicit calls and some language-specific reference forms still need native
hooks. Preprocessor identities are described next.

## Native preprocessor identities

Protocol 11 exports DEFINE symbols at committed source declarations, including
unused definitions. Empty expansions still retain their invocation identity.
`#ifdef`, `#ifndef`, `#elseifdef`, `#elseifndef`, `defined()`, and `#undef` operands retain the actual
native lookup result. Qualified queries retain the final member selected by the
compiler, after it has consumed namespace prefixes. A zero target is an
absent-name query, not a guessed reference to a later declaration. Queries can
name ordinary symbols as well as macros. Recursive expansion errors retain the
selected macro reference.

Each source definition has an instance ID. The compiler stores macro parameters
as numbered slots, not FBSYMBOL objects, so their editor identities combine the
instance and native ordinal. Equivalent redefinitions may reuse the DEFINE
symbol while spelling their parameters differently. Their local parameter names
must not be merged. Parameter declarations and replacement-list uses are exported
before pooled storage is released, including unused bodies and stringification.
Native flags preserve optional-parenthesis and variadic forms.

Macro environment epochs advance at declarations and macro undefinitions. Lexer
tokens retain the epoch observed before later lookahead processes directives.
Completion uses the active native definitions at that epoch; repeated arguments
use common identities across all observed contexts. Invalid parser regions lose
their bindings and expression types but retain this separate lexer context, so
macro completion remains useful in a failed unsaved expression. Eight recent
environment views are cached rather than copying a full name table per directive.
An unfinished conditional operand such as `#if defined(` has no projected
identifier at its cursor. Protocol 13 emits the directive's source map and the
compiler's current epoch before it evaluates the operand. Completion uses that
record directly, so definitions supplied by an earlier include use the exact
environment rather than a neighboring-token approximation. The compiler's
conditional skip scan records nested `#if*` and `#elseif*` operands too, where
no normal parser call occurs but the unchanged environment is still exact.
Local compiler token epochs remain a conservative fallback for older trace
fixtures and non-directive positions.

Schema 21 also exports the compiler's conditional branch, evaluation,
selection, closure, defined-name probe, and skipped-region observations. The
sidecar reader validates their nesting and decisions. A successful physical
probe can supplement a missing trace reference only when its selected symbol
maps to a physical declaration. An unqualified probe must span exactly one
identifier. For a qualified probe, the reader projects only the trailing
identifier whose length matches that declaration's name and whose physical
token is revalidated by the navigation query. Qualifiers and generated spans
are not treated as the selected symbol. Conditional hovers display the complete
physical probe spelling, including qualifiers, rather than only its first
identifier. Stock-sidecar binding queries use this rule for Go to Definition
and Find References. Probes are present in compact binding snapshots, so this
path does not require the larger macro-expansion graph.

Schema 22 adds compiler-owned macro definitions, actual invocations, argument
payloads, replacement segments, callback output, lifecycle events, and origins
to expressions, bindings, and conditional facts. Byte payloads remain bytes,
including legacy non-UTF-8 text; wide payloads retain their exact code units.
The extension validates the expansion graph before retaining these details.
Macro-heavy translation units can exceed the sidecar's 64 MiB safety bound, so
the bridge uses `-semantic-model-compact` for binding snapshots and retries an
oversized expression snapshot without the verbose macro-expansion graph. The
normal trace still carries its independently bounded macro maps and identities.
When ordinary FBC is used without the bridge, the extension keeps macro data
compact for normal sidecar requests and asks for the full graph only after its
source model identifies a macro at an explicit navigation, Find References,
Signature Help, or hover request. This preserves stock-sidecar macro identity without
paying the graph cost for ordinary symbols, non-macro hovers, or completion. Macro
Signature Help and macro-use hovers follow the compiler-selected definition
after redefinition. Hover includes a bounded physical source-body preview when
the selected definition site maps to one source macro declaration. With
explicit project contexts, Find References also scans saved modules when all
selected macro uses map to physical root invocations. If a configured module
has a selected nested or generated use without a physical token, the project
result is withheld and the current translation-unit references remain available.
Validated project macro rename and unsaved-buffer validation still require the
editor bridge.
Interactive expression requests limit type facts to the active module and open
source buffers while keeping the complete compiler dependency inventory. Each
`E` record already carries its source range, so expression-only sidecars omit
the duplicate `LOC` ledger; full semantic models retain those locations.

Schema 23 adds `LOC` records that attach observed source ranges to opened source
contexts, with UTF-16 coordinates and byte offsets when the source revision is
verified. `MAP` records now include stable remap identities. The sidecar reader
checks location subjects, contexts, range ordering, and mapped byte bounds.
Before semantic facts are retained, analysis also verifies the sidecar's source
digest against the exact disk snapshot or compiler overlay, then checks mapped
byte offsets against the reported UTF-16 coordinates. Empty macro-result and
malformed macro-argument extents are retained only as nonphysical start points;
they are not editable ranges.

Schema 25 added parser-owned `ST`/`STE` statement boundaries, `BLK`/`BEND`
construct nesting, `OWN` statement ownership, per-module `CAP` coverage,
binding `ACC` access roles, and file-operation `SOP` facts. The current schema
27 also adds normalized type snapshots (`NT`), procedure phases and evaluation/
control-flow relationships (`PH`, `NP`, `EV`, `CB`, `CN`, `CE`, `CL`), structured
compiler diagnostics (`DI`), and source operator/operand links (`EX`). The reader
validates these records, their source contexts, subject identities, and
cross-record relationships before retaining them. Physical `LOC` spans whose
parser endpoint precedes their start are omitted by the compiler; an empty
colon-separated statement may have structural records without an editable range.

Incoming constructor/destructor hierarchy in project contexts reuses the
read-only lifetime reference families and joins their physical sites to mapped
native statement ranges. The implicit-call owner identifies the constructed
object or formal parameter, not the calling procedure. Caller selection uses
the statement owner and construct chain; source parsing only presents the
already-proven procedure header. Repeated includes are accepted only when all
containing native ranges agree. Missing/unmapped ranges and conflicting owners
withhold the project tree rather than publish partial callers. A bounded sorted
range index is retained for explicit hierarchy requests needing implicit-call
ownership, not normal editor snapshots. This does not enable lifetime
rename.

Operator incoming hierarchy now reuses that bounded ownership projection with
the existing read-only operator reference families. A native D header reselects
the callee in each compiler pass; O and typed-expression receipts supply the
selected uses. The active build's mapped statement ranges supply routine or
module callers, including closed modules and conditional caller headers. The
source index still presents the selected operator header but does not choose
callers for a successful native tree.

Local physical receipts are captured before project analysis can evict their
model. A complete native result, including an empty list, skips source caller
grouping and the older project-reference scan. Unavailable ownership retains
both the prior reference-family anchor and the captured snapshot fallback,
without querying retired operator IDs. Existing buffer/context/cancellation
guards and unmapped-range refusal apply.

Outgoing project hierarchy also joins those native lifetime/operator families
to statement owners. Complete results own ordinary and implicit edges together;
the provider must not merge source-scope supplements back into that graph.
Unmapped ownership or ambiguous operator targets withhold the projection and
retain the prior fallback. Declarations are family anchors, not call edges.
The collector retains one occurrence per proven callee at a shared span, while
ordinary CALL records still must agree on their one target. This distinguishes
construction/destruction at a temporary without accepting an ambiguous overload.

Native D records begin at callable keywords. Their per-module statement ordinal
joins a mapped statement range when retaining DECLARE/private/continued prefixes
for header presentation. Native identities still choose targets; parsing only
presents the proven header. Legacy bridge operator captions use a unique matching
physical header, preserving target selection and subsequent stale-item checks.
A nonempty legacy graph is not a completeness proof for non-index operators,
so those declarations flag the fuller projection. Ordinary/index-only graphs
retain their populated-snapshot fast path. Full implicit-call coverage remains
subject to the grammar, macro-origin and corpus audit.

Native Outline and workspace-symbol records also recover operator presentation
from one matching physical header. This repairs truncated legacy names such as
`[` and incomplete prototype strings while retaining native kind, ownership,
visibility and parent relationships. It does not add source-only declarations
to the native inventory. Ambiguous, macro-derived and expanded-view entries keep
their prior native presentation.

Navigation, hierarchy and symbol presentation share the same per-snapshot source
declaration cache: at most eight documents, four MiB per source and 20,000 parsed
declarations per document. These are the existing navigation limits, not larger
parsing allowances. The cache is lazy, retains negative bounds results and does
not start another compiler pass.

Stock-FBC hierarchy preparation can select an external constructor prototype
through its native D header without a source-indexed implementation. Header
parsing supplies presentation only after that identity is proven. Native
lifetime hierarchy records consistently select the Constructor/Destructor
keyword; a UDT display label of a different length must not shift or truncate
that selection. Incoming and outgoing records therefore retain the same target
anchor through project, bridge and source-backed lifetime paths.

The full schema also carries conceptual operator receipts (`O`) with the
selected operator code and kind, target symbol, and physical source range.
Current FBC emits these at overloaded `NEW`/`NEW[]`/`DELETE`/`DELETE[]` and
UDT `FOR`/`STEP`/`NEXT` sites, as well as ordinary overloaded binary, unary,
cast, math, and assignment expressions. The bridge uses those receipts for
navigation, references, highlights, hover, and Call Hierarchy instead of
reselecting an overload from source spelling.

Project rename joins macro-name lifetimes within a translation unit, including
`#undef` and redefinition. Include-guard absent-name checks and active
`#ifdef`/`#elseifdef` operands join the selected global macro name for
refactoring, while normal navigation leaves absent-name checks unresolved.
Recompilation must preserve lookup results, definition shapes, parameter slots,
epochs, native semantic graphs, physical maps, and expanded text. An unrelated
new-name spelling does not by itself reject parameter rename: the native slot
graph detects accidental substitution even in a body that is never expanded.

The combined declaration/parameter/reference/context limit is 200,000 records per
invocation. Missing slots, invalid ordinals, stale map IDs, wrong symbol classes,
and inconsistent epochs invalidate a snapshot. DEFINE symbol metadata is immutable
and is not repeated at every expansion; forward-type metadata still refreshes.
Compiler-provided and command-line macro lifetimes without physical declarations
remain noneditable. A replacement-list identifier resolves to a macro only when
every observed expansion of that physical token selected the same native DEFINE
symbol. Compiler-validated project rename separately covers an unexpanded,
deferred replacement-list token when all same-name macro lifetimes in each
configured translation unit form one rename family; a two-context regression
covers `#undef` and conditional redefinition. The token remains unresolved for
navigation until an observed expansion selects one target. Ambiguous deferred
targets and completion contexts not anchored by a compiler-recorded conditional
directive still need coverage. This is not a claim that every macro-related edit
is supported.

## Native inventory and lexical regions

Source scope instances and native symbol ownership are distinct. Two reopened
namespace blocks share an owner symbol but have separate source ranges. A method
written outside its TYPE has a module-level physical location and retains its
native type owner. The compiler's own block operations delimit IF branches,
loops, and explicit scopes. Parser hooks delimit namespace/type/enum regions and
procedure bodies, including error-recovery unwinds. An unclosed region is
accepted only with a partial snapshot and is marked recovered.

Committed declarations carry their native identity, source anchor, lexical
region, header extent, and prototype status. Metadata also includes native
inheritance, parameter modes, optional parameters, and array dimensions.
Namespace import edges include implicit enum imports. Anonymous union fields
refresh their ownership after the compiler moves them into the enclosing UDT.
Legacy implicit declarations retain the compiler's choice of lexical or
procedure scope rather than assuming that the nearest block owns them.

The editor builds scopes and declaration indexes exclusively from these native
records. Existing parsing may supply a display signature, but cannot introduce
a declaration, classify it, or choose its scope. Prototype parameter names and
anonymous function-pointer parameters do not become surrounding locals. Source
parameter records determine signature parameter types and modes. Definitions,
references, completion, and type lookup share the resulting native inventory.

Member completion follows native owner/base links. Its private/protected checks
follow the compiler's namespace-ancestry rules, including derived-type access
from out-of-line methods. Module PRIVATE is distinct from private UDT access.
Locals in enclosing blocks take precedence over implicit members. A method body
does not introduce a same-named global, and variables from a sibling IF branch
or completed loop do not leak into completion.

Scope, inventory, shape, and import records have a combined 200,000-record
limit. The decoder validates ownership, bounds, source spelling, missing shape
metadata, duplicate closing records, and unfinished regions. Native inventory
does not by itself provide complete macro symbol coverage, precise dependency
taint, or all remaining reference forms.

## Native expression typing

Checked wrappers around 25 expression-parser entry points record the returned
AST's full type and subtype. Binary operator loops also export intermediate
left-associative results, so later promotions do not overwrite earlier operand
types. Value-only AST annotations preserve receiver prefixes through member,
array/pointer index, method, cast, BYREF-result, and repeated dereference paths.
Each step in `**pointer` has its own type. Variable leaves and pre-dereference
function/cast results retain their own types. The compiler, including its target-specific promotion rules and
overloaded operators, makes every reported type decision.

Protocol 7 also exports a topologically ordered expression graph. IDs identify
committed records, not AST allocation addresses. The compiler often consumes,
reuses, or clones operand nodes during folding and lowering; hooks copy their
annotations before entering these operations and never follow freed operands.
The common AST initializer clears every annotation field, including those on
stack sentinels. Clones copy annotations by value. Parser prefix state is scoped
on the compiler's single-threaded call stack, so nested arguments and early
returns cannot replace the enclosing receiver location.

Completed parser-boundary syntax records can have bounded parser-family
records. They name the direct entry point and helper paths that committed or
returned the AST, such as
`cMathFunct`, `cStringFunct`, `cQuirkFunction`, or `cOperatorNew`. The decoder
keeps this as coverage provenance only: presentation and refactoring continue
to rely on the expression graph and compiler identities. The native corpus
audit groups these names so a missing parser route becomes an explicit test
gap instead of an inference from a hand-selected fixture. Transform and
argument records deliberately omit this marker. The bridge records the first
completed syntax expression for each family in an invocation, which is enough
for the corpus inventory while keeping large compiler traces within their
existing bounded-output limit. Protocol 12 adds multiple family records for
one syntax node when a helper returns an already committed expression. The
current runtime accepts protocols 14 and 15; the decoder can still read older
trace files for compatibility tests.

`cTypeOrExpression()` is the shared parser route for expression-side `LEN`,
`SIZEOF`, and `TYPEOF`. It first attempts a type layout and only then returns
the delegated expression AST. The bridge tags that already committed AST on the
expression branch, without creating a range for the type-layout branch. Native
tests cover all three forms and malformed `SIZEOF` inputs whose following
independent expression must remain authoritative.

The compiler's schema-27 `-semantic-model-expressions` mode also records completed parser
expression spans at the common `cExpression()` boundary. A normal editor
analysis requests those facts alongside the bridge trace. The editor validates
each physical range against the exact captured source snapshot and uses the
compiler type spelling as a bounded supplement when the bridge has no
expression for that span. A narrower compiler-owned span can also refine a
broader cursor result; exact bridge answers retain priority. Compiler sidecar
symbol IDs are intentionally not mixed with bridge symbol IDs, so type
navigation falls back to the exported type name for supplemented expressions.
Expression-only sidecars also retain completed source-visible member, index,
and call-result prefixes, including variable, fixed-array, and UDT-returning
call chains.
On a parser error, the expression-only sidecar can carry an explicit `R` record
and `RECOVERY` footer. The editor uses only physical facts whose source tokens
were not retracted by native recovery, marks those types provisional, and never
lets them override an existing bridge expression. The full semantic-model
reader continues to reject this incomplete form. Oversized, malformed, or
interrupted sidecars are ignored without displacing the error-tolerant bridge
model.
Compiler-backed binding analysis requests the compact full schema-27 model so
it can use compiler-selected declaration and procedure typing, written
visibility, aggregate access sections, SELECT CASE lowering facts, target-wide
literal prefixes, and scalar dynamic String declaration initializers alongside
identities and bindings. The full model
also contains the compiler AST, so it has a higher memory and output cost than
`-semantic-model-bindings`. If FBC reaches its bounded full-model work or size
limit, the extension retries with the bindings-only model while retaining the
native trace when possible. If that trace also exceeds its output bound, it
uses a trace-free bindings pass. The active fallback is recorded on the
analysis snapshot. Sidecar and trace symbol IDs remain separate; the extension
joins a sidecar property to a native symbol only through an exact physical
declaration binding, and withholds ambiguous or generated matches. Logical
`#line` filenames on source-operation ranges are validated through their
compiler source-context and captured physical file rather than treated as
dependencies. The extension keeps its 64 MiB sidecar limit.
Direct `analyzeSavedModule()` callers can request the same runtime facts with
`exportSemanticExpressions`; ordinary analysis keeps this extra compiler work
opt-in. The native corpus audit compares supplemented answers separately from
trace-only coverage so the fallback cannot certify itself.

Compiler-created calls carry their selected `FBSYMBOL` pointer only in the
private AST annotation until a parser wrapper has a complete written source
range. The bridge exports that target only when it commits the resulting source
edge. This avoids filling a trace with startup, cleanup, and lowered calls that
have no editable provenance, while retaining runtime helpers such as `CVL()` and
explicit or implicit constructor calls derived from written source. This includes
copy construction at declarations, returns, and both UDT `IIf()` branches,
BYVAL UDT arguments, and implicit construction for nontrivial BYREF UDT
arguments,
`CONSTRUCTOR()` chains, `TYPE<UDT>(...)` and `NEW UDT(...)` initialization,
and `BASE()` initialization. For explicit scalar and vector `DELETE`, the
compiler-selected UDT destructor is retained as an implicit call dependency of
the pointer expression; a selected overloaded deallocator remains a distinct
call edge. A temporary UDT destructor is retained when the compiler can anchor
the emitted cleanup to its physical source expression. Neither relationship
creates an editable destructor token. Per-exit control-flow cleanup sites for
declared locals remain outside this graph; the selected local destructor is
represented at the declaration.

The bridge builder also inventories every active direct `astBuildCall()`,
`astBuildCtorCall()`, `astBuildImplicitCtorCall()`, `astBuildDtorCall()`, and
`astBuildVarDtorCall()` site in the compiler source set. Each site is assigned
to the parser boundary, transform wrapper, statement hook, or intentionally
generated construction/destruction path that owns it. The audit ignores
disabled compiler comments, checks the enclosing routine's call count, and
rejects unowned, stale, or changed sites before a bridge is built. It detects
upstream selection-path drift; focused native fixtures still verify that
representative selected calls produce the expected graph edge.

UDT `LET` and direct combined-assignment operators commit their selected calls
at the written assignment statement after the parser has consumed both
operands. A non-overloaded combined assignment retains its ordinary typed
binary relationship without inventing a procedure target. When ordinary
assignment selects an implicit cast operator for its right-hand expression,
the source operand remains its written type while the selected conversion call
is retained as a target-bearing graph dependency.
The same source-preserving conversion edge is retained when the compiler selects
a cast to form an `IF` branch condition.

Graphics functions such as `POINT()` commit their source-derived runtime call
after their dedicated parser has consumed its arguments. Graphics statements do
not create editable expression records merely because they lower to runtime
work.

`CVA_ARG` is a compiler intrinsic with no selected `FBSYMBOL` procedure. Its
parser retains the written `cva_list` operand through both the backend-macro
and pointer-based ABI lowerings as a target-zero implicit call edge. This keeps
its result type connected to source without claiming a direct or runtime call.

The record kinds have these ordered inputs:

| Kind | First input | Second input | Third input | Options |
| --- | --- | --- | --- | --- |
| `syntax` | preceding native expression/receiver | zero | zero | zero |
| `conversion` | original operand | zero | selected lowered conversion call, if any | native conversion flags |
| `binary` | original left operand | original right operand | retained lowering result | native operator code |
| `unary` | original operand | zero | retained lowering result | native operator code |
| `conditional` | condition | true branch | false branch | zero |
| `index` | written receiver | written index | zero | zero |
| `argument` | previous argument | written value, if present | converted value, if represented | one-based insertion ordinal |
| `call`, explicit | callee/receiver, if represented | last argument | zero | one |
| `call`, implicit helper | first source operand | second source operand | argument chain, or third source operand | zero |
| `call`, runtime helper | final source-derived input | zero | zero | two |

Only call records select a target procedure. An indirect call has target zero;
its anonymous function-pointer signature must not be mistaken for a runtime
target. Argument chains retain arbitrary arity in source parameter order,
independently of the backend's reversed argument push list. Omitted defaults
have no written-value input and may depend on the default's declaration
expression. An explicit UDT construction uses a type name rather than a callee
AST, so its first call input is zero and its selected constructor and argument
chain remain authoritative. Function, method, property, and statement-call
paths retain the committed argument chains. Conditional records retain both
branches even when a constant condition lets the compiler discard one. These
are semantic dependencies, not a promise that every input executes at runtime.
Runtime-helper records use option two and are emitted only for compiler calls
whose source operand survives to a complete expression boundary. Parser-created
runtime constructs such as `THREADCALL` retain their nested source call before
the compiler replaces it with its generated helper. Option zero
continues to identify source-derived implicit helpers such as constructor
conversion. Default construction with no written initializer is also a
generated call: it is anchored to the declared variable's identifier, has no
fabricated callee or argument inputs, and records the exact compiler-selected
constructor. A fixed-array declaration records the selected relationship once
at its declaration rather than expanding one graph node per runtime element;
an unallocated dynamic array has no such call.

Zero inputs explicitly mean absent/unrepresented provenance, not an inferred
expression. Transform ranges bound their contributing source; only `syntax`
records provide written-selection types. In particular, an implicit promotion
to DOUBLE does not change the reported INTEGER type of the written operand.
The decoder limits graphs to 200,000 nodes, validates native targets/types and
UTF-8 boundaries, and requires every nonzero input to precede its consumer.
Invalid-region taint follows these edges in one forward pass. Recovery-created
symbol/type dependencies remain a separate unfinished requirement.
Argument chains depend on their inputs, not on every line between their source
bounds. An error in an unrelated procedure between a default's declaration and
its call must not retract that call's otherwise valid type.

Hover shows the compiler type where a mapped expression is available. Select
an expression and run **FreeBASIC: Show Compiler Expression Type** for its full
type. A nonempty selection must match an exported span exactly; a larger
neighboring expression is not substituted. Types include arithmetic, casts,
arrays, pointers, inferred values, intrinsics, conditional expressions, and
user-defined operator results. Native receiver types drive completion after
casts and compound expressions. Type-definition links still need a matching
declaration in the editor model.

The export is not a lossless typed AST. Array-address lowering, every intrinsic,
some implicit runtime and special-member paths, and precise symbol/type recovery
dependencies are not all connected to their source expressions.
An unrepresented selection reports no type. Member inventories and access
filtering use the native declaration, owner, base, and visibility metadata.

## Unsaved source overlays

All open named `.bas` and `.bi` buffers are captured before compilation. The
extension writes private backing files and a bounded manifest in its owned
temporary directory. Compiler source OPEN/EXISTS hooks substitute those files
without changing logical filenames, relative include search, `__FILE__`, or
dependency identity. Original source files are never overwritten or saved.
New named include buffers can participate even before their file exists.

The module itself must have an existing `.bas` path. Untitled buffers need a
filename/build context first. UTF-8 and BOM-marked UTF-16LE disk sources are
decoded into the Unicode text VS Code exposes, then passed to the compiler as
UTF-8 while retaining a leading BOM when present. Unmarked bytes are decoded as
UTF-8 when valid; invalid byte sequences use a Latin-1 single-byte mapping so
compiler byte columns remain aligned with editor columns. BOM-marked UTF-16BE
and UTF-32 sources do not receive native physical ranges. Malformed marked
encodings, NUL characters, and unmatched UTF-16 surrogates are rejected rather
than silently changing compiler input. Dirty buffers are checked again before
accepting results. Closing a dirty buffer or changing a dependency invalidates
its snapshot.
Conflicting buffers for the same physical file, or a dirty symlink alias that
the compiler opens through a different path, are rejected; open the include at
the compiler-resolved path for unambiguous overlay analysis.

Use `analysis.run: "onChange"` for a 400 ms edit debounce. Changes to compiler-
discovered headers also schedule their open dependent modules. A header with an
explicit selected context also schedules that translation unit when its module
editor is closed. Compilation can
retain partial results from erroneous buffers, as described below. This is not
yet a persistent incremental compiler or a complete error-tolerant typed AST.

## Persistent analysis worker

`lib/compiler-worker.js` owns one lazy worker per analysis service. Both ordinary
editor snapshots and project rename use it. The worker writes overlays, reads
compiler trace files, decodes native records, and keeps an exact-trace cache.
Ordinary native editor analysis also constructs and retains its semantic model
there. Completion, hover, definition/type navigation, references, highlights,
signature help, expression inspection, semantic tokens, and rename target
selection use worker queries. The host receives compact result records rather
than the native semantic graph. Project rename baseline construction,
cross-context identity joins, and semantic validation also stay in the worker.
Only candidate edit records and a short-lived freshness ticket return to the host.
It exchanges plain records through Node's supported
[worker-thread message API](https://nodejs.org/api/worker_threads.html).
VS Code objects and semantic-model methods do not cross that boundary.
Cursor coordinates are copied explicitly because VS Code positions expose
prototype getters that structured cloning does not preserve. Semantic tokens
use a typed-array result, not a list of declaration records.

Semantic highlighting requests physical symbol bindings in both native modes,
even without a NOKEYWORD option. The bridge's trace-only resolution lacks the
access and qualifier facts needed for write and readonly modifiers. This reuses
the current binding model or acquires one through the existing on-demand
service, without requesting a separate expression pass for coloring. Stock
sidecars also require macro bindings because compact snapshots omit macro
definition/use facts; bridge tracing retains these without that extra request.
Active declarations and uses retain their native symbol kinds, readonly
qualifiers, and access roles. When no suitable native snapshot can be acquired,
the source adapter remains available. The provider captures the document version
before acquisition and rejects both native and source token results after edits,
closure, or cancellation. Native token queries follow one replacement through
the shared adapter, retaining binding, macro, and backend requirements.

The host retains asynchronous process launching, output capture, cancellation,
and reaping. This ownership matters on worker failure: terminating a thread
that owns a live child can otherwise strand its process handle. A failed worker
is stopped, its child is cancelled and reaped, and its owned temporary directory
is removed before queued work starts in a replacement worker. Failed requests
are rejected rather than silently retried. No command shell is used.

Requests freeze buffer maps, option arrays, and the host environment before
queuing; a persistent thread's startup environment is not reused. Limits cover 16
requests, 64 MiB of aggregate request data, and a 512 MiB worker old-generation
heap limit.
Each request also retains the existing 32 MiB source/trace limits. The deadline
includes queue time. Cancellation settles the editor request immediately, sets
a shared flag that synchronous decoding checks, and cancels a running compiler.
A 1.5-second acknowledgement deadline bounds a stalled worker. Shutdown and
invalidation also cancel queued work. Idle workers do not keep a Node process alive.
The host checks workspace trust again for every compiler invocation, including
dependency-discovery verification passes within one preparation request.

The compiler still executes for every snapshot. The cache only reuses decoding
after matching the complete compiler output and working directory, including an
actual text comparison after hash lookup. This avoids treating saved-file hashes
as proof of unchanged include lookup, negative dependencies, or time macros.
At most eight entries and 32 MiB are retained, charging serialized graph buffers
and source strings. Oversized entries are not cached; decoded object graphs are
not retained behind that byte budget. Returned records are independent copies.

Prepared models have a separate two-entry, 128 MiB retention budget. A single
macro-heavy model can use an exclusive allowance of up to 384 MiB; it evicts all
other models and is released before the next preparation starts. Accounting
charges serialized native records and source bytes conservatively for the
additional indexes; it is not an exact heap measurement. A model exceeding that
allowance is rejected before construction. The 512 MiB old-generation limit
does not cap all external buffers or total process RSS. Raw project analyses release prepared
editor models to avoid retaining both graph sets. Eviction also removes host
snapshot metadata and its buffer diagnostics. Read-only expanded text has its
own existing eight-entry/32 MiB bound.

Dependency discovery is not accepted as an editor baseline. Newly consumed disk
files are captured between matching file stamps, then supplied as frozen overlays
to another compiler pass. Preparation allows at most four passes. Disk sources
are verified before and after each query; closed editor overlays must match disk
content. Open buffer text, context, generation, cancellation, and model identity
are checked on the host before and after the asynchronous reply. Queries have a
1 MiB input and 8 MiB output cap. Backpressure rejects a query without discarding
otherwise current models. This does not provide incremental reparsing or prove
that a newly appearing, previously absent include cannot affect an already
prepared model; filesystem events invalidate analysis and every new analysis
runs the compiler again.

**FreeBASIC: Analyze Module With Compiler** exposes cancellable progress. The
output channel separates worker round-trip/decode time from background model
time. The following benchmark compares direct, raw-worker, and prepared-worker
analysis of an editor fixture and two compiler source modules:

```bash
FREEBASIC_ROOT=/home/jkfirth/fbc \
FBC_EDITOR_EXECUTABLE=/path/to/fbc-editor npm run benchmark:analysis
```

The benchmark enables the expression-only compiler semantic sidecar used by
interactive analysis. It records its fact count alongside host timer gaps,
elapsed time, native model counts, and semantic-token query times. It does not
define a portable performance SLA.
Prepared runs include dependency capture/verification passes, so their total
analysis time is not directly equivalent to the raw single-pass mode. The first
prepared run clears decoded traces but reuses the existing worker thread.
Editor-side result formatting, source snapshots/open-buffer comparisons,
diagnostic presentation, the lightweight index/outline, and construction of VS Code
edit objects still have host costs. This worker is not yet an incremental compiler.

On 2026-09-24, the prepared runs retained 5,698 declarations and 15,094
compiler expression facts for `ast-node-call.bas`, and 6,561 declarations and
33,195 facts for `parser-proc.bas`; both reached EOF without errors. One local
Linux/Node 22 run measured the following prepared-worker costs (milliseconds):

| Module | Mode | Analysis elapsed | Largest analysis host gap | Worker sidecar decode | Worker model build | Token query |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| ast-node-call.bas | Prepared warm | 1,642 | 14 | 268 | 522 | 17 |
| parser-proc.bas | Prepared warm | 3,039 | 15 | 943 | 686 | 60 |

Token-query host gaps were 6 ms for both modules. These measurements include
the expression-only sidecar requested by interactive analysis. They show that
the large decode and model-build costs stay off the editor host thread; they do
not show an overall compiler speedup or completion of interactive tuning.
The macro-heavy upstream `compare-float-nan.bas` and `iif.bas` fixtures also fit
the exclusive prepared-model allowance and return native semantic tokens.

Editor providers share model acquisition in `editor-model.js`. Binding and macro
requests reject explicitly weaker cached snapshots even when those snapshots
contain bridge-native identities. If an upgrade loses a snapshot invalidation,
the provider can follow one successor with the same required capabilities.
Cancellation, a changed document version, or incomplete workspace initialization
prevents publication or source-only fallback. The compiler service still owns
request sharing and snapshot validity; this helper does not execute the compiler
or introduce an unbounded retry loop.

The same acquisition helper has a native-only entry point for late binding
upgrades. Argument navigation, selected-operator lookup, and bound-member
completion cannot replace a missing compiler decision with a source-only model.
Definition, declaration, and implementation stop when that upgrade is unavailable
or the document changes, rather than querying a predecessor that preparation may
have released. A superseded upgrade can still follow one current successor.

An overload probe can replace the snapshot even when its source-index mapping
finds no target. Definition, declaration, implementation, references, and
highlights then continue on the current native model. A header not yet loaded
by the source index does not erase an independently available compiler target,
and this fallback does not request another compiler pass.

## Error recovery and current-buffer diagnostics

The real parser already recovers from many errors. Protocol 4 retains that
work instead of rejecting every nonzero compiler exit. Statement/line hooks
retract all facts from failed regions, including facts emitted before the
error was detected. Native error origins also cover directives and final checks
that run outside a statement. Invalid regions are masked before constructing
the presentation parser and native inventory, while the expanded view retains their text.
`TYPE` and `ENUM` hooks separately record the compiler's missing or mismatched
terminator recovery. Those containers are therefore marked recovered even when
the parser returns a symbol after consuming to EOF or another statement. Their
invalid declarations remain hidden, and any surviving dependent native facts
are provisional rather than being presented as a closed lexical region.
In trace mode, an incomplete `#include` stops at that directive's end of line
instead of consuming the first token of the following valid source line. The
ordinary trace-disabled compiler path remains unchanged.

Member lookup already emits the selected receiver type before checking the
member name. Failed statements retain those receipts separately for completion
after a physical `.` or `->`, including partial member names, array elements,
and function results. Suggestions use native type identities, member inventory,
and access checks; missing, conflicting, or recovered type facts are withheld.
Recovered token projections remain separate from normal bindings. This does
not restore invalid expression types, navigation targets, references, or rename
sites, and it does not require a new compiler export format.

Ordinary name completion also uses retained physical token positions to enter
the native lexical inventory after a failed statement. It lists only surviving
nonprovisional declarations and the compiler-active macro environment, retaining
scope, declaration order, imports, access checks, and local-over-member shadowing.
The unfinished identifier remains unresolved. Written whitespace can shrink in
preprocessed output, so this path anchors to the last proven token instead of
allowing a large trailing gap to enter another scope. Native labels are visible
before their definitions, including definitions inside nested blocks, but only
within their native owner procedure; module labels do not leak into a procedure.

The editor's label-target filter also handles comma-separated `ON ... GOTO`
and `ON ... GOSUB` lists, including explicit continuations and trailing comments.
It keeps inline IF arms separate and does not treat single-label error handlers
or ordinary argument lists as computed branches. Label ownership still comes
from the selected model. Continued-prefix reconstruction is bounded to 128
physical lines and 65,536 characters and does not start another compiler pass.

For empty lines, completion can intersect the compiler scopes at the surrounding
direct physical tokens. Both source and expanded gaps must contain only
whitespace/comments; generated or missing anchors, unmatched occurrences, and
preprocessor boundaries remain withheld. The intersection prevents a loop local
or sibling-scope declaration from leaking across a closing block. This lookup
does not change token resolution or add bindings. Gap validation is bounded to
65,536 UTF-16 code units and 64 include occurrences. Cases without this evidence still need a
compiler-provided token-free scope context rather than a source-parser guess.

Direct string-literal receipts can also bound those gaps. Their exact source
spelling and UTF-8 byte boundaries are checked while building the existing
source-coordinate index, including escaped strings and Unicode/BOM inputs.
The opaque completion anchors retain macro epochs but never enter identifier,
navigation, rename, or recovery-binding maps. Missing, generated, mismatched,
or oversized literal contexts remain withheld. No extra compiler pass is needed
for the completion query.

A native module-end receipt also anchors trailing blank lines in the root file
to the final global scope. Only whitespace/comments may remain
after the cursor, within the same gap-size bound. Completion uses the final
compiler macro epoch, including trailing definitions and removals, rather than
inheriting a preceding procedure's scope or macro state. A partial root can use
this anchor when every native scope has an explicit nonrecovered closure and
every error has a positioned receipt on a directly observed parser line.
Matching uses compiler serials, including through logical `#line` names, rather
than treating diagnostic names as editable file paths. Unclosed scopes,
unpositioned preprocessor failures, and included-header EOFs remain withheld
without other native context. This completion-only point does not become an
identifier origin or navigation binding.

Escaped-string context probes capture the document version and honor
cancellation, including before scanning source. Ambiguous quotes in default
strings request native option facts; explicit escaped/raw strings and comments
normally stay on the local path. An uncached request can acquire the normal binding model;
a lightweight cached model can join that upgrade to obtain accepted option
contexts. The worker then uses all preceding
native escape spans, not just the span at the caret, and returns code/string/
comment state, a bounded masked line prefix, and call contexts. Range tables stay
in the worker. Signature and navigation queries also use the snapshot's native
mask so a fake call or comment opener inside a literal cannot hide following
code. BOM offsets are adjusted once.

Type Hierarchy also keeps that native masked prefix for its identifier preflight,
retaining the original suffix to include the token at the caret. A second raw
source scan must not hide an identifier following a compiler-confirmed escaped
literal. Numeric and ordinary source-only requests retain their cheap preflight.

Type Definition and Type Hierarchy acquire native bindings before applying
source-only shortcuts to a potentially disabled keyword. This keeps a conditional
NOKEYWORD REM identifier from being rejected as a comment. The option spelling
only schedules acquisition; native identity and type queries decide the result.
Literal and comment spellings do not gain an identity from this path.

Type Definition and Type Hierarchy preparation follow one replaced native query
through the shared on-demand selector, preserving its binding requirement and
stock/bridge backend. The type-definition adapter retains the successor for
later expression queries too. Root version, closure, and cancellation guards
cover context acquisition, native queries, and late source-type refinement;
backend changes and repeated replacement withhold results.

Stock member completion likewise follows one already-cached binding successor
when its receiver/base-chain or member-fact query is superseded. The entire read
restarts so captured source checks and all member facts use that same snapshot.
Type acquisition also follows the shared selector's current cached model. This fallback is
needed when an enclosing scalar expression hides the receiver's own type and
source-only inference cannot establish it; the retry adds no compiler pass.

Native completion, Signature Help, final definition/declaration/implementation,
reference, highlight, semantic-token, and primary native hover queries share
one-replacement handling in the editor-model adapter, including direct signatures
and source-overload refinement. The adapter retains the successor alongside its
result, preserves binding requirements, and requests macro metadata only when
explicitly needed. Extra macro enrichment in the
predecessor does not become a callback's retry requirement. Edits, closure,
cancellation, backend changes, and repeated replacement discard the request.

Bridge hover also requests native bindings on first use. A trace-only model
can resolve the declaration without its array, layout, parameter, or storage
facts. Acquiring the existing binding capability makes those facts available
before coloring or another provider warms the cache. Stock hover retains its
existing fact-specific and macro acquisition paths; no extra expression or
macro capability is requested for the bridge.

The primary native hover query retains its selected successor for later reads.
A masked stock identifier can already use a full macro snapshot, so this retry
keeps that capability rather than dropping its macro signature or definition.
Bridge retries retain symbol bindings without inheriting extra macro metadata.
Saved-file source-mode hover supplements now share the same bounded retry and
retain its selected model for later lookups. Their expression-only requests do
not force a binding upgrade on replacement; actual delivered bindings and
requested macro data are retained. Other adapter callers keep the existing
default that stock native queries require bindings.

Source-mode constant/enum hovers request their symbol value as an optional field
in the same worker hover reply. The declaration, type, and value therefore come
from one immutable model, and a replacement retries that whole read. Ordinary
variable hovers do not request this lookup. The existing scalar/string value
validation bounds the reply, and the separate constant query remains available to other
consumers. This extends the internal hover result, not the FBC binary schema.

Complete cached stock bindings can also answer one unambiguous variable, field,
parameter, constant, or enum-member hover directly, without initializing the
host source index or acquiring another model. The existing renderer reuses that query's result.
Eligibility requires a positive native identity, matching physical name, and no
macro identity/signature. Constants and enum members must also have a native
value in that reply. An opt-in bound-constant request performs the value lookup
only when the native entry has one of those two kinds; it does not add that walk
to ordinary variable/field/parameter hovers. Dirty documents, partial models,
ambiguous sites, and other symbol kinds retain their existing paths. The bounded
adapter handles a replaced cache; only the internal hover request is extended,
not the FBC binary schema.

The expanded/preprocessed document exposes the same per-line token index as
physical documents. It is derived lazily from the existing token vector, so
ordinary physical-source queries do not initialize it. Expanded navigation and
hover can therefore share token-based helpers without assuming a physical
document layout. Expanded highlights use compiler-bound inner occurrences in
that view's coordinates; navigation and references retain physical targets.

Opening the view also follows one metadata replacement across the editor's
open/language/show awaits. Each attempt uses a currently published URI; source
edits, closure, trust changes, or a different build signature stop the command.
If retirement leaves a pass pending, the existing explicit-check path can join
it. This is a bounded opening retry, not a permanent alias for retired views.
An empty expansion remains valid content rather than an expiration message.

Definition, Declaration, and Implementation capture the original buffer revision
before acquisition and native preparation. Their constructor probes use the same
bounded query adapter as ordinary navigation, retaining the selected successor
instead of re-querying a retired predecessor. Closed or edited requests stop
after a binding upgrade and before constructor locations are published. When a
probe resolves an ordinary argument symbol instead, its validated reply also
supplies the normal navigation fallback without a duplicate native query.

Native acquisition can bypass the source index. Navigation refreshes the current
root before obtaining a source model for constructor/operator mapping, so an
implicit argument constructor does not require Analyze or Outline first. The
compiler still selects the target; indexed source only maps its physical
declaration/body sites. Unrelated ordinary native lookups do not add this parse.

Implicit argument-constructor navigation can also use the worker's physical
declaration records directly. Anonymous constructors have D headers without
named B declaration tokens, so native constructor/destructor F kinds are kept
through those headers, as operator kinds already were. A unique committed I
target and constructor kind select the symbol; validated D roles select its
prototype and body. The D name field is not used as a token identity.

The existing per-model declaration parser/cache recovers only name ranges inside
those physical headers. This admits the active guarded declaration without
joining inactive same-signature branches or requiring the header in the host
source index. The existing 64-site, 4 MiB source, 20,000-declaration, and eight-file
cache bounds remain. Definition prefers a body, Declaration a prototype, and
Implementation never substitutes a prototype. Value bindings take precedence
over conversions, and comments or missing native identities do not gain targets.

Constructor Signature Help shares this declaration reader. Exact native
constructor call records select the overload for NEW and written type/alias
calls, including guarded headers and external prototypes without a local body.
The worker returns the parsed signature with that committed identity, preferring
a body when present. The editor does not replace those entries with a source-
indexed family or require the header to be open. Missing identity metadata still
does not authorize a guarded source guess.

Constructor hover uses that same selection at the terminal type/alias token.
It retains the selected signature for guarded and external declarations instead
of showing every source overload. Namespace qualifiers and argument values keep
their own declarations. Stock hover recognizes a possible type call only to
schedule binding acquisition; the compiler still supplies the target and active
physical declaration. A selected native constructor is not replaced by source-
only constructor-family refinement. This works before Signature Help warms the
model and does not require the header to be open.

Definition, Declaration, and Implementation also share these physical
constructor records for written NEW and type/alias calls. Definition prefers a
body, Declaration a prototype, and an external prototype never becomes an
implementation. Argument-conversion navigation keeps its existing value-binding
precedence. The worker still requires the committed target and constructor kind.

A cold bridge can resolve the callee as a type while its closed header is absent
from the source index. The editor uses that native navigation result to request
bindings once and repeat the query on the stronger snapshot. Ordinary procedure
results do not trigger this upgrade or require a source-index parse. The existing
snapshot adapter handles replacement, while document/cancellation/backend checks
guard the added await. This does not add a compiler query type or schema field.

Constructor references/highlights use the same selected identity and include
its active prototype and body when declarations are requested. Occurrence
collection joins lifetime receipts with physical written-construction receipts
without adding duplicate calls to the bridge's Call Hierarchy graph. Initializer
receipts can identify the destination variable; normalized native callee records
also expose the written type/alias token. Qualified callees use only the terminal
token, and repeated physical locations are deduplicated. These are read-only
navigation sites, not permission to rename construction-context tokens.

Cold explicit-call references reuse the bounded navigation upgrade before
collecting occurrences. A proven constructor call does not fall into the
project's type-reference lookup. With explicit project contexts it instead
requests a read-only lifetime-procedure unit. A dedicated native target query
selects the anonymous constructor/destructor's physical header anchor. Each
frozen project pass reuses the existing declaration/occurrence readers, and the
normal reference collector joins those local identities through shared physical
prototypes or bodies. This works with stock FBC and the bridge. Implicit
conversions and written callees remain reference sites, not rename tokens.

Destructor project lookup uses native D prototypes even in a consuming module
without its body. The requested lifetime kind stays separate throughout the
transaction: a temporary can construct and destroy at the same physical span
without making those two different kinds conflicting overloads. Explicit
destructor calls have a physical B use joined to their CALL node by H, despite
having no named B declaration or implicit cleanup receipt. The reference reader
uses that committed link and F destructor kind to retain the exact callee token.
Both declaration and explicit-call entry points select the same native family.
Local references/highlights reuse this binding-backed explicit-call read too.

Project lifetime references retain the existing source verification,
cancellation, context, and publication guards. Multiline occurrence endpoints
are preserved. Unrelated procedure families at one physical site remain
ambiguous; builds without a shared physical anchor are not joined by spelling
or signature. A failed/ambiguous project result falls back to the selected
translation unit. NEW lifetime spans covering only a namespace qualifier are
excluded; the committed explicit-call receipt supplies the terminal callee.
These additions change internal editor/worker requests, not the FBC schema.

Native operator references also use read-only project units. Their selected
physical D header is re-resolved with the existing declaration query on the
current model; numeric operator IDs never become cross-pass identities. The
normal project collector joins header anchors and receives native operation
ranges, not text-match occurrences. OP receipts retain priority over the typed
expression fallback, and project operator passes explicitly request expression
metadata. Other project passes keep their original compiler options. Physical
declarations are presented from source only within their proven D headers.

Explicit operator-reference passes also consume the optional native
`source-memory-applications` family. Counted applications join a compiler-selected
custom NEW/NEW[]/DELETE/DELETE[] target to its source context and physical LOC,
including macro invocation reporting anchors. Both readers validate targets,
counts, declaration contexts and macro origins before exposing those locations.
Unavailable older/compact exports retain the existing physical operation path.
Full macro provenance is requested only for the explicit reference pass, not
ordinary editor snapshots or declaration-only navigation. Defaults, field
initializers and unevaluated operands are source references, not proof of runtime
ownership. These extra locations do not enter Call Hierarchy or rename edits.

Several native memory applications can share one macro reporting location.
The read-only operator collector accepts that location only when every competing
family has a validated macro-memory receipt. A single proven application cannot
make an ordinary ambiguous binding safe. Ordinary references and rename retain
their existing editable-token checks.

The operator provider gathers current local facts before starting the project
transaction, which may evict its model. Ambiguity or failure therefore uses the
already-collected snapshot without another query on its retired ID. Buffer or
compiler-context changes reject both the project reply and that fallback.
Highlights never request the project join. Cold reference requests refresh the
root/include presentation index, while native receipts still choose identities.
Configured bridge index references share binding-backed index selection with
stock FBC; ordinary native navigation and non-project paths are unchanged.

Operator navigation can also fill a missing native declaration/body role from
other configured modules. It uses a declaration-only operator unit, skipping
operation/expression collection and the reference pass's expression-export
request. A named active build restricts the lookup to that build's jobs. With
default module options, only contexts whose compiler argument arrays exactly
match are eligible; the lookup does not borrow a different build's body.
Already-proven local roles do not start another project transaction.

The target header is queried inside the root snapshot using an optional
declaration-origin input. Its file and coordinates must belong to that model;
the query neither reads arbitrary files nor invents a standalone context for a
closed include. D records still select the native identity, while retained
presentation names let the existing navigation adapter distinguish prototypes
from bodies. Index navigation first selects an identity from an available
prototype/body, then asks for the requested role. A missing local body does not
prevent an implementation lookup in another module. Empty/failed project
lookups retain only the current native roles, not unverified source bodies.
Edits, closure, cancellation, context changes, and retired selections discard
asynchronous results. Expanded views retain their own context handling.

Constructor/destructor navigation shares that active-build project boundary.
The native lifetime target query can optionally return physical D role ranges
with its selected identity. Ordinary reference-target queries do not request
those ranges. A committed argument-constructor receipt can select an unbound
literal conversion, but an argument's own binding, namespace qualifier, or
macro identity retains precedence. NEW fallback selection stays on the callee.

Missing lifetime roles use declaration-only lifetime units, without collecting
cleanup/construction reference sites. Keyword anchors join native identities;
the navigation adapter presents the unique constructor/destructor header at
that proven line. Local roles keep their existing navigation path. A failed or
empty project lookup uses only the saved native role ranges and never queries
an evicted model. Ordinary functions do not acquire lifetime bindings or walk
the source index just to test whether they might be constructors. Document,
context, backend, and cancellation guards cover the added asynchronous work.

The declaration-only project boundary also applies to ordinary procedures.
All project jumps use the active named build, or exact default-argument
matches, so inactive function bodies from another configured build are not
returned. Reference collection and rename validation still retain all jobs.
The ordinary navigation adapter captures the document revision and compiler
context across its project await; edits, closure, cancellation, generation
changes, and context changes reject both the reply and any local fallback.

On-demand failures retain a bounded, single-line reason for language status.
The initiating check passes a request-local outcome through compatibility and
background preparation, including shared/replaced passes, so the reason does
not depend on observing a transient running-controller entry. Existing retry,
invalidation, cancellation, and publication rules still apply. The status menu
shows the actual reason and identifies a compiler-consumed unsaved dependency
when stock FBC rejects changed input. Its Save All command is an explicit user
action; status rendering and analysis never save buffers.

This does not enable overlays in stock FBC. The compiler source still lacks
the bridge's editor-overlay input, and sidecar-only analysis still verifies
consumed buffers against disk. Unsaved native analysis continues to require
the editor bridge.

Project navigation classifies qualified procedure headers at the terminal
identifier already bound by the compiler. A parser span such as
`Api.Worker.Adjust` can therefore supply the role of the exact physical `Adjust`
binding without being mistaken for another declaration. This changes header
presentation/role classification only; native family anchors still select the
namespace, owner, and overload. Definition prefers the proven body, Declaration
keeps its prototype, and Implementation no longer drops qualified bodies.

Virtual Go to Implementation follows committed override edges downward within
the current compiler snapshot. Stock FBC uses semantic override relationships;
the bridge retains its already-validated dispatch graph. Neither path joins
methods by name or return type. Ancestors and sibling families stay out of a
derived-origin query, and abstract prototypes are not implementations.
Definition and Declaration continue to resolve the statically selected method.

Bridge definition replies carry a conceptual virtual-method hint so only
virtual implementation requests need the additional native query. Ordinary
methods retain their existing route. An unavailable additional query can keep
a known current local body, while edited requests are discarded.

With explicit project contexts, virtual Implementation also follows native
override edges across module-local families joined by physical declarations.
Stock units supply semantic override edges; bridge units reuse their validated
dispatch records. The collector traverses downward only for declaration-only
Implementation requests. It does not union resolution or rename families, and
ordinary references remain statically bound. Active-build filtering still
applies. A reachable child without a physical anchor makes the project result
incomplete, preserving the existing native-snapshot fallback rather than
inventing a source match. Known local bodies do not suppress project discovery
of additional overrides in closed modules.

The compiler's trivial by-value UDT path previously skipped its argument-
constructor selection receipt. The semantic-only hook in `ast-node-arg.bas`
now exports the already-selected constructor before that fast ABI path. It does
not change lowering or require a schema/transport revision. Stock and bridge
compilers must include that fix to supply these trivial-conversion receipts.

Full binding export cannot always commit after a parser error, even when the
compiler can still certify useful expression recovery. A bridge binding request whose
partial result has no usable semantic expressions retries once with trace and
expression-only export together. This preserves authoritative independent trace
regions and provisional header/directive types from one compiler invocation;
graph identities from the failed pass are not merged into it. The retry remains
inside the caller-owned temporary tree and existing output/time bounds.

The recovered model explicitly advertises no binding or macro capability.
Worker and direct-model publication preserve those capability overrides rather
than equating a request with delivered facts. Hover can use its current partial
trace for types when declaration-layout acquisition fails, without treating it
as an identity upgrade or bypassing masked-REM binding requirements. If optional
type recovery is unavailable, the original partial trace/diagnostics remain;
explicit cancellation still stops the request.

Partial bridge traces can still certify lexical context and receiver/member
types after a metadata upgrade fails. Context acquisition checks the current
partial trace both before and after that failure, and keeps compiler-negative
comment/string results authoritative. Completion uses that trace only as a
lower-capability recovery path; it does not relabel it as committed public
binding metadata. This preserves unfinished NOKEYWORD receivers and signatures
without guessing from the option's source spelling.

Explicit Analyze/Check also retries once when its captured pass is rejected
because a closed dependency changed, not only after global invalidation. The
retry keeps the same document revision and build context, and each compiler
pass captures and validates its own inputs. Ordinary compiler errors and
timeouts do not trigger it; edits, cancellation, closure, trust changes, and
context changes still end the request.

Ordinary document highlights request native bindings when a compiler is
configured. Read/write access roles accompany those bindings; a trace-only
bridge snapshot can resolve occurrences without identifying their access.
Cached binding snapshots are reused, and macro data is requested only at macro
sites. Reference/highlight requests retain the initial buffer revision through
acquisition and descriptor preparation. Project-reference results and local
fallbacks are also discarded after edits, closure, or cancellation.

Inlay hints capture the requesting buffer revision and compiler-analysis
generation before any lookup. Edits, document closure, cancellation, or a changed
build context discard replies after acquisition and querying, for both type-only
and combined hint requests. Already-ended requests do no parsing or model work.
Existing model-change notifications schedule fresh hints; no retry or compiler
pass is added by these guards.

Signature-only call scanning also recognizes a call after a compound callee.
It separately recognizes `TYPE<...>(...)`, including parenthesized `TYPEOF`
operands whose comparisons are not type delimiters. This bounded 16-KiB syntax
scan only schedules a native lookup. Counted temporary-construction selections
identify the actual constructor, and native physical declarations supply its
signature. The selected prototype preserves written optional defaults without
a duplicate body entry. Both stock FBC and bridge requests acquire native
bindings directly, without a source-index type/overload guess. Plain aggregate
initializers without a selected constructor remain unavailable rather than
borrowing an enclosing call's parameters.

Hover on the written TYPE construction keyword uses the same committed native
temporary target and prefers its physical prototype, retaining optional defaults.
The type-argument and namespace tokens keep their own bindings. Incomplete calls
and aggregate initializers without a constructor selection do not receive a
constructor hover. First-use stock requests acquire bindings for this syntax;
an already complete cached constructor reply can be reused without a second
worker query or source-index lookup. Bridge requests retain their existing
binding acquisition, and no source overload choice is introduced.

Definition, Declaration and Implementation on that TYPE keyword also reuse the
committed target and physical declaration roles. A prototype can supply a
definition fallback when no body is present, but never becomes a fabricated
local implementation. The editor acquires native bindings before this direct
lookup and retains configured project lifetime navigation for missing bodies.
Project cancellation/context changes end the typed route without re-querying
an evicted snapshot. Real value or macro bindings keep the ordinary path; the
syntax hint itself supplies neither type nor overload identity.
An aggregate-only TYPE initializer can undergo a constructor conversion when
passed to another routine. That enclosing argument conversion is not the TYPE
operation's own target; missing explicit selections remain unavailable.

The same ownership rule applies to lifetime/reference identity and hierarchy
preparation. A committed TYPE construction selects its explicit temporary target
even when an argument conversion shares the physical span. References and
highlights use that constructor's family; project lookup receives its native
identity and declaration roles. Both actual calls remain in the native graph.
Aggregate-only and partial TYPE operations do not borrow the conversion target.
Typed hierarchy preparation can present the selected body or an external
prototype directly from native records on either backend. Editor requests
acquire bindings on first use and do not initialize source indexing for this
lookup. Value/macro bindings still control ordinary symbol reference routing.

The same native selections now supply parameter-name inlays for typed
construction on both backends. A shared bounded syntax lookup finds the actual
constructor opener beyond TYPEOF parentheses. Existing argument segmentation,
formal-mode/name checks and physical parameter links still apply. The bridge
keeps its trace-owned ordinary hints and supplements typed temporaries from
semantic identities; conflicting or duplicate positions are handled before
publication, without mutating either cached input. Visible typed calls request
binding facts on demand, while plain bridge calls retain expression-only reads.
No source type inference or additional compiler pipeline is introduced.

For incomplete typed construction, bridge recovery can instead project a
constructor family from surviving native type declarations or the actual native
type of a named TYPEOF operand. The bounded operand spelling only schedules
exact native name/member lookup; it does not infer complex expression types.
The existing constructor recovery applies caller access, import ambiguity,
shadowing and provisional-type guards. Scalar/pointer operands and inaccessible
members remain excluded. A failed binding upgrade may reuse its current bridge
recovery snapshot without falling through to source type guesses. These hints
do not restore navigation, certify the unfinished expression or select an
overload. Complex TYPEOF operands and stock-sidecar recovery still need native
support beyond this declaration-backed path.

Navigation keeps its original explicit-name scanner. A compound context merely
schedules native expression lookup; it does not establish callability. The
worker selects a nonprovisional callable expression ending exactly before the
outer opening parenthesis and formats that type without selecting a runtime
procedure. Labels preserve short callee expressions, using a generic expression
label for long or multiline spans. Scanning is bounded at 16 KiB.

When outer arguments are incomplete, bridge recovery can project a callable
type from scoped, accessible native declarations: array element types, factory
return types, grouped callback values, and explicit pointer dereferences. Array
rank and written indices are checked, as are pointer depth and FBC's TYPEOF
display wrapper. This path uses the source-built bridge inventory's inspected
dtype layout, not numeric IDs from semantic-only producers. It supplies UI
signatures only, never a committed expression type, editable reference, or an
indirect runtime target. More complicated incomplete callee expressions remain
withheld without native receipts. Factories retain their own parameter list
when the cursor is inside the inner call; array indexing alone is not invocation.

For incomplete callback fields such as `MakeHolder().invoke(1,`, an accessible
native member-completion receipt can supply the field's callable type even when
the compiler retained no exact receiver expression. The existing native field
shape and callable-type checks reject provisional members, arrays and extra
pointer indirection. These recovery hints do not certify the receiver expression
or its arguments, revive navigation bindings, or identify an indirect target.
No additional compiler pass or source-based type inference is used.

Array indexing has its own `arraySignature` reply, separate from callable values
and selected procedure targets. Exact stock bindings join native array-bound
facts or descriptor-parameter passing modes. The bridge uses the same facts when
available, otherwise its native inventory can establish rank alone. Fixed bounds
appear as `Array matrix(index1: -1 To 4, index2: 1 To 3)`; dynamic arrays expose
dimension positions, and unknown-rank descriptor parameters show `indices...`.
Missing bounds remain explicitly unavailable, never read from source syntax.
Presentation is capped at 64 dimensions. This is a UI bound, not a language limit.
Stock requests reuse available bindings; ordinary cold array indexing does not
force a compiler pass. No expression export or new compiler interface is needed.

Type Hierarchy expansion requests current binding-capable models for open
buffers. Outline can replace a snapshot after Prepare or while a related-type
query runs. Supertypes and subtypes retry once on the current snapshot using the
item's physical declaration position, not a retained native symbol ID. Edits,
closure, and cancellation discard the request; an unchanged empty result does
not retry.

Native Call Hierarchy expansion similarly reacquires expired snapshots through
the existing on-demand model service. Incoming and outgoing queries follow one
replacement using the loaded document and physical item position, retaining any
binding requirement of the original native model. Ordinary methods do not gain
an unconditional binding upgrade. Current empty results do not retry, and edits,
closure, cancellation, or repeated replacement discard the request. Stock-sidecar
and source-only call adapters retain their existing routes.

Bridge-backed Call Hierarchy preparation uses the same bounded native-query
retry before considering a source constructor fallback. A superseded Prepare
reply must not become an empty item or a source guess. Preparation also captures
the root version before cursor-context and model acquisition, rejecting edits
at those asynchronous boundaries and after the common native query.

Expand Selection captures the root version before parsing source or acquiring
native expression facts. It follows one already-cached remote replacement without
starting another analysis. If native spans are unavailable or replaced again,
unchanged source still supplies structural selection ranges; edits, closure, or
cancellation discard the request. Worker range endpoints are validated plain
coordinate records and become real VS Code Positions before offset conversion,
as required by TextDocument.offsetAt on the supported editor versions.

Completion and Signature Help also settle ambiguous REM comment state through
the native cursor query. A preceding NOKEYWORD REM option can schedule binding
acquisition; a cached binding model can settle options from headers. Neither
source spelling nor a cached type name authorizes code by itself. The source
scan records preceding REM comments because a disabled keyword can expose a
block-comment opener that changes later lines too. Native physical identifier
offsets and accepted option lines settle the full lexical prefix, with BOM
adjustment on both lists. Worker query guards use those same facts. Physical
tokenization also applies accepted option lines in recovery snapshots, where
failed statements have no committed reference bindings. This exposes only
lexical tokens to the existing native recovery lookup, not new symbol bindings.
The stock completion provider then permits its existing native receiver-type lookup even
when source-only parsing lost the member context. Ordinary REM comments without
an option hint or cached binding facts do not launch compiler analysis.

If another upgrade releases the queried model, the probe follows one cached
successor. A cleared or repeatedly replaced snapshot returns an unknown context
instead of reusing the old source interpretation. Ordinary source-only context
checks stay local, and production analysis deadlines are unchanged.

Likewise, a declaration-side `TYPEOF(` that ends at a physical source line
reports its missing expression in trace mode before the parser can consume the
following editor statement. Explicit line continuation has already been folded
by the lexer and does not take this path. The bridge uses the compiler's normal
integer recovery type for the incomplete declaration; the trace-disabled
compiler path remains unchanged. A regression covers diagnostics, hover, and
the expression-type command for the retained unsaved statement.

Expression-side `LEN(` and `SIZEOF(` take the same trace-only EOL recovery
path. Their shared type-or-expression parser receives an ordinary constant
recovery expression after reporting the missing operand, so the following
unsaved statement remains available for diagnostics, hover, and expression
inspection. Explicit continuation remains on the compiler's normal path, and
trace-disabled behavior is unchanged.

`PEEK(` has a separate two-stage optional-type parser. At physical EOL after
its opening parenthesis, trace mode reports the missing operand and returns a
byte recovery result before that helper can parse the following statement as an
address. Explicit continuation and trace-disabled compilation remain on the
normal compiler path.

`PROCPTR(` delegates its procedure spelling to a separate identifier parser.
At physical EOL, trace mode reports the missing identifier before that parser
can inspect the following source line. It returns the compiler's ordinary fake
node only in tracing mode; explicit continuation and trace-disabled compilation
retain the original path.

The ordinary parser already keeps a later independent expression after many
other incomplete delimiter forms. Regression coverage now verifies this for
29 forms: `NEW`, `DELETE`, `CPTR`, `IIF`, `MID`, `INSTR`, `LINE INPUT`,
`OPEN`, `CVA_ARG`, dereference, `CAST`, math, string, array-bound, conversion,
error, file, graphics, console, and runtime-query parser families. This is a
guard on existing recovery behavior, not a claim that every malformed parser
path is covered.

A mandatory terminal record reports the error count and whether the root parser
reached EOF. An error-limit stop can still retain earlier results; a missing
terminal record, contradictory exit status, process signal, timeout, or truncated
diagnostic output cannot. The trace flushes pending output on bounded stops
without advancing the parser. Ordinary trace-disabled compiler output is unchanged.

The analysis service publishes `fbc (buffer)` diagnostics against the captured
module/header text, including named headers that do not exist on disk. Diagnostic
ranges cover source lines because textual fbc output does not provide exact
UTF-16 spans. Edits, cancellation, settings changes, and stale inputs prevent
obsolete snapshots or diagnostics from being published.

Types whose native expression dependency path reaches a recovered region are
explicitly provisional. Independent expression types remain authoritative.
A retracted declaration taints its canonical native symbol and every symbol
that depends on its type, owner, namespace, base type, or anonymous-layout
link. The expression graph then propagates that state through subtype, selected
call target, and operand edges. Declarations in a compiler-recovered lexical
scope are explicitly provisional. Failed regions have no native type; other
regions remain useful for inspection.
Project target selection, baseline compilation, and validation still require
complete, error-free source. Unusual parser repair and structural-context cases
remain requirements in [the compiler-grade plan](compiler-grade-plan.md).

## Compiler-validated project rename

Configure the complete set of module/build pairs explicitly:

```json
"freebasic.analysis.projectContexts": [
  { "name": "normal", "modules": ["main.bas", "library.bas"] },
  {
    "name": "alternate",
    "modules": ["main.bas", "library.bas"],
    "arguments": ["-d", "ALTERNATE"]
  }
]
```

### Selecting the editor's translation unit

Run **FreeBASIC: Select Compiler Context** from a module or header. The picker
lists the configured build/module pairs and stores the choice in the current
workspace folder. The equivalent setting is:

```json
"freebasic.analysis.activeContext": {
  "name": "alternate",
  "module": "main.bas"
}
```

When a `.bi` editor is active, analysis compiles `main.bas` with the `alternate`
arguments and all current named-buffer overlays. Native types, completion,
navigation, references, semantic tokens, and expression inspection in the header
use that translation unit. The compiler must report the header as a physical
dependency. A conditional include that is inactive in this build cannot supply
a header model. No other module or previously analyzed context is substituted.
The module can be closed in the editor, but still needs an existing disk path.

When a `.bas` editor is active, it keeps its own root and uses the same named
build, which must list that module. Set `analysis.activeContext` to `null` to
restore base compiler options for modules and turn off native header selection.
Each workspace folder can select its own context. Context names must be unique.
Compiler path, module root, context name, and arguments identify snapshots;
changing any of them prevents reuse or publication of an in-flight result.

F2 in a header requires this explicit context to select a native target. It
still compiles and validates every pair in `analysis.projectContexts`, not just
the context used by the editor. This is a single-context view of a header, not
an attempt to merge contradictory conditional types or repeated include scopes.

### Rename validation

The editor adapter in `compiler-project.js` captures the selected native target,
all declared jobs, current buffers, and a context signature. The worker's
`compiler-project-transaction.js` owns the validation transaction;
`compiler-project-bindings.js` joins its physical declaration families. The same
transaction engine has an injected-analyzer path for fault tests, not a second
production resolver.

Full native baselines and compact binding projections are serialized to private
temporary files. They are read one module at a time for identity joining and
validation rather than retaining every module's graph. Scratch storage is limited
to 512 MiB, with the existing 32 MiB source/expanded-source bounds and 128-job
limit. Files use V8 serialization only within the current transaction and runtime;
they are not a persistent or cross-version data format. Cleanup runs on success
and failure. Worker failure retains the host-owned process reaping and directory
cleanup guarantees. Each child has its configured deadline; the entire queued
transaction is capped at five minutes.

Validation computes byte-length-qualified SHA-256 fingerprints of the same
canonical relationship families previously compared as full JSON strings:
dependencies, bindings, native types/owners, canonical IDs, dispatch, expression
edges, scope/type shapes, preprocessor records, and physical token origins.
Each family is processed separately so the before and after graphs need not stay
live together. These checks validate the exported semantic contract; missing
native coverage remains unfinished work, not a guarantee supplied by hashing.

The worker returns only bounded edits and a one-use freshness ticket, retaining
captured source text for at most 30 seconds. Before returning `WorkspaceEdit`,
the editor sends its current buffer map for a final worker-side check of disk
content, closed dirty buffers, newly opened dirty buffers, the canonical workspace
root, and physical edit targets. A symlink change cannot pass merely because its
new destination has identical text. The host rechecks buffers, trust, generation,
and all project context options after that reply. Expired, discarded, superseded,
or cancelled tickets cannot publish edits. No project source is written.

The ticket also records which files the compiler actually consumed. A captured
buffer that closes after deletion may be ignored only when it was unrelated to
every configured compilation. Missing consumed sources still fail, and edit
target, existing-disk, changed-buffer, and newly opened-buffer checks remain
strict. An unrelated temporary editor file therefore cannot veto project rename
solely because it no longer has a disk copy.

Final host publication uses the worker's consumed-buffer indices, referenced
against the submitted map's insertion order, rather than requiring every
unrelated editor to stay open. This bounded summary contains no source text or
duplicated paths. The final guard permits only unconsumed removals; changed/new
buffers and consumed removals still reject publication.

Background analysis likewise does not treat every captured editor buffer as a
consumed dependency. Root/header requests and known affected snapshots still
cancel promptly. Other closures defer to the worker's mandatory validation of
the compilation's actual sources before publication, so discarded consumed
header overlays remain invalid while unrelated closed scratch buffers cannot
cancel a current analysis.

If enrichment sees only buffer removals while a pass is running, it waits for
that pass's consumed-source validation before reusing results or requesting the
stronger model. It does not transfer an old caller to different inputs. New
edits, context/trust changes, cancellation, and further buffer changes reject
the wait; any follow-up preparation is bounded to one such wait.

`npm run benchmark:project` measures this path on `ast-node-call.bas` under two
explicit build contexts, using the same `FREEBASIC_ROOT` and
`FBC_EDITOR_EXECUTABLE` variables as the analysis benchmark. On 2026-09-09, direct
and worker runs both returned the same two edits after five compiler passes.
Direct execution took 5,035 ms with a largest host timer gap of 1,465 ms; the
worker took 4,659 ms with an 18 ms gap. This is a local responsiveness observation,
not a portable throughput or latency guarantee.

Paths are relative to the workspace folder, not globs. Context arguments are
appended to the normal compiler arguments. F2 on a directly represented named
symbol runs these checks before returning standard VS Code edits (use rename
preview to review them):

1. Freeze editor buffers and disk dependencies. Discovery passes are repeated
   against frozen include content before accepting a baseline.
2. Compile every module/context. Join prototype/body identities through shared
   physical declarations, not module-local IDs or bare names.
3. Require a compiler binding for every occurrence of the old name in the
   captured project. Refuse conflicting meanings across configurations, new-name
   capture, unmapped macro text, unrepresented virtual-family declarations,
   explicit external ABI entry points, and edits outside the workspace.
4. Apply candidate edits only to temporary overlays. Recompile every context
   and compare symbol bindings, canonical relationships, and native expression
   type identities, expression graph structure, scope/declaration/type-shape/import
   relationships, physical token/macro origins, expanded text, and dispatch
   slots/edges and preprocessor identities/parameter slots/epochs with its baseline. Display names may
   change during type rename. All represented overrides in configured builds
   join the selected virtual family without joining unrelated overloads.
5. Recheck buffers, disk text, cancellation, and workspace trust. Return edits
   without applying them or saving any files.

Expression validation compares source-anchored graph structure, including
ordered inputs, native types, targets, and operation options. Expected byte
positions account for changed identifier widths. Renaming one overload can
make it nonoverloaded, causing the compiler to lower the receiver before parsing
arguments instead of after them. Such independent construction-order changes
are valid. Fixed-size recursive node digests and a sorted multiset compare the
same semantic DAG without requiring identical allocation order or expanding
shared subgraphs into exponentially large strings.

Currently this supports represented variables, parameters, fields, constants,
enum members, types/aliases, namespaces, named and numeric labels, procedures, and represented
virtual families, including physically copied macro arguments and replacement
text, macro names, and macro parameters. Numeric labels retain compiler-bound
GOTO references and can rename to another numeric literal or to a named label.
The latter adds a colon at a colon-free declaration and retains an existing
colon at a colon-terminated declaration. It does not yet support
extract-function or signature changes. Unexported reference forms remain
coverage gaps.
Projects are
limited to 128 module/configuration pairs and 32 MiB each of captured source and
expanded text. Omitted modules/configurations and external consumers cannot be
validated automatically; the setting is the user's explicit project boundary.
Dynamic symbol lookup by strings is not a statically provable reference. Review
the preview and use source control as with other public-API renames.

## Source projection

Protocol 9 maps individual consumed tokens, not whole physical lines. Character
origins move with the lexer's two lookahead characters. Every lexer context
owns its physical cursor, so includes, preprocessor evaluation, and isolated
probes cannot advance the parent's cursor. The original physical filename is
retained independently of `#line` changes to the compiler's diagnostic filename.
Offsets count UTF-8 bytes after any encoding marker; the editor converts them
to UTF-16 positions only against the captured source text.

The decoder validates source dependencies, byte bounds, overlap, and record
limits (200,000 token origins and 32 MiB per source). Projection verifies each
physical slice against the expanded spelling. Rewritten literals do not prevent
neighboring identifiers from mapping. Continuations and repeated logical
`#line` locations retain distinct physical positions. The compiler omits legacy
type suffixes from emitted identifiers; projection leaves those suffixes outside
rename edits. Validation compares physical anchors after accounting for only
the proposed identifier-width changes.

Protocol 10 adds replacement-text provenance to generated tokens. Maps describe
the native preprocessor's actual text operations, not a second implementation of
its expansion rules. They retain both input text and invocation context:

| Kind | First input | Second input | Meaning |
| --- | --- | --- | --- |
| 1, unknown | none | none | Synthesized text without a physical span |
| 2, source | none | none | Physical file and byte range |
| 3, concat | left text | right text | Ordered concatenation |
| 4, slice | source map | none | Native-character offset and length |
| 5, argument | argument text | invocation | Substituted parameter ordinal |
| 6, definition | replacement text | invocation | Literal replacement-list text |
| 7, stringify | argument text | invocation | Stringified parameter ordinal |
| 8, callback | argument maps | invocation | Builtin macro result |

Expansion nodes also retain the compiler's DEFINE symbol ID. Callback arguments
are captured before the native callback can release their pooled storage. Lengths
address native lexer characters; source leaves separately retain physical UTF-8
bytes. Only a complete non-affine leaf can project across a Unicode conversion.
No interior byte location is guessed.

The native arena interns immutable maps and bounds concatenation depth. Private
append builders avoid retaining every intermediate prefix during long argument
reads. Slices discard unrelated consumed/pending text. Published IDs are positive
and acyclic; temporary builder handles never cross the protocol boundary. The
arena is bounded to one million maps and 200,000 builders, while the decoder
accepts at most 200,000 reachable maps. Compact file IDs avoid repeating a long
physical filename on every token. Overflow invalidates the snapshot instead of
returning an incomplete provenance graph.

Projection accepts a copied token only when its entire spelling comes from one
contiguous physical range. Duplicated and nested arguments can have several
expanded uses. Navigation retains all native targets; expression types must
agree across uses, and completion takes the intersection of available native
identities. Selecting separate arguments does not manufacture an expression
from operators supplied by the macro. Constructed, stringified, and callback
results stay in the expanded view. Rename compares map geometry and all retained
expanded text, including directives such as `#inclib`, so it cannot silently
alter a stringified value even when symbol bindings would remain unchanged.

Deferred replacement-list identifiers retain explicit physical records. A
definition-time token does not claim an invocation-time macro identity. When
every observed expansion projects back to that token and selects one DEFINE
symbol, navigation and refactoring can use that compiler-selected identity.
Unexpanded or multi-target replacement text remains unresolved. Structural macro
refactoring remains unfinished.
When a replacement-list token also has an unresolved macro candidate, project
rename joins it to a compiler-bound FreeBASIC symbol only if every physical
token of that spelling in the translation unit maps to one exact native family.
Unexpanded or mixed-family occurrences are still refused, and the validation
compile must preserve the preprocessor graph after the edit.
UTF-16/32 encoded source also remains unprojected pending a separate
decoding contract. Rewritten literals themselves are not yet projected as editable
expression ranges. Unmapped generated declarations keep read-only expanded
locations. Lookup within the originating `.bas` uses this model. A separately
opened header uses the explicitly selected translation unit described above;
without one, ordinary editor providers retain the lightweight document analysis.

Snapshots with nonphysical `#line` filenames are now accepted: freshness checks
use physical dependencies. Compiler diagnostics still retain their logical
locations; precise physical remapping of diagnostics and recovery dependencies
remains separate work.

## Enabling it

Run the builder from the extension repository:

```bash
FREEBASIC_ROOT=/home/jkfirth/fbc FBC_EXECUTABLE=/home/jkfirth/fbc/bin/fbc npm run build:compiler-bridge
```

In VS Code settings, set `freebasic.analysis.compilerPath` to the printed
executable, `freebasic.includePaths` to the matching `inc` directory, and any
defines/target options in `freebasic.compiler.arguments`. The normal diagnostic
compiler remains configured independently by `freebasic.compiler.path`.
After updating the bridge sources, rebuild it and replace the configured path
with the new printed path. Existing binaries are not modified in place.

If `analysis.compilerPath` is unset, **Analyze Module With Compiler** can use
`compiler.path` in sidecar-only mode when that compiler emits schema-27
semantic models. This provides exact expression types for saved dependencies,
and can activate an ordinary call's selected overload in Signature Help when
the source resolver finds multiple candidates, and can provide selected
parameter-name inlays for direct positional calls. The full binding sidecar is
requested for ambiguous signatures, callable values, or visible inlay ranges
containing calls. Hovers and prefix-matched completion details can also use
compiler-bound integer, floating-point, and string constant values. Floating-point details
retain their exact IEEE-754 bits; strings retain exact byte or wide-unit
payloads. Byte previews are ASCII-only; wide-unit previews use valid Unicode
scalars and escape controls. Hover can also show
compiler-folded expression values when the sidecar provides an exact physical
expression identity and range. Sidecar-only analysis still has no bridge
token-origin graph, native outline/symbol search, or project refactoring. If a dependency
has unsaved content, sidecar-only analysis refuses the result rather than using
stale disk text; configure the editor bridge for unsaved-buffer analysis.

Signature Help also uses compiler-confirmed procedure-pointer types for named
callable values, including fields, parameters, aliases, and inferred variables.
The existing binary T record already carries FBC's canonical type spelling; the
reader retains it only for source values with a procedure-pointer type. Stock
queries join that spelling through an exact native binding. The bridge can also
use its native inventory, and its completion scope/member recovery keeps the
declared callable type available while arguments are incomplete. Source indexing
only schedules an on-demand stock binding request and never supplies the final
callback type. Requests stop after edits or cancellation during that indexing.

When a stock binding model is already cached, ordinary Signature Help returns
the selected procedure's signature directly rather than only its declaration
locations. The existing native navigation lookup joins syntax metadata to the
compiler-selected identity, preferring a physical prototype when present. Its
source parser also receives native REM and escape overrides. Declaration sites
remain in the reply for source-mode callers that display their overload list;
no parameter-type scoring or new call-target inference is introduced.

Stock hover requests native bindings whenever source resolution leaves more
than one declaration, including mixtures of procedures and values. Expression
types alone cannot distinguish a scalar from a procedure returning that type.
The existing native declaration-selection path then presents the active value
and withholds inactive procedure guesses, without depending on a prior binding
request from another provider. Unambiguous source hovers keep their existing
lightweight acquisition path.

Cached stock signatures also expand through the compiler's explicit
`overload-next` links, not a name-based search. The bounded chain lookup includes
only proven-public siblings with the same native procedure kind, preserving
getter/setter separation. The selected target remains visible even when its
access is restricted; other private/protected siblings need additional caller
access proof and are not expanded by this path. Native declaration/reference
binding order excludes overloads declared later, including across headers.
Chronological B-record order is an inspected 1.20.5 producer behavior, not a
schema-27 guarantee. Other producer families retain their selected signature
without this expansion. Cyclic, conflicting, or oversized chains also retain
the selected result. The per-snapshot link index needs no additional analysis
pass; source-mode overload lists and bridge behavior are unchanged.

Bare-call keyword preflight now checks available native models before consulting
the source index. Generated declarations can be absent from that index even when
the compiler has a complete callable signature. Cached bridge models are reused
without a binding upgrade; cached stock bindings can answer directly. An explicit
source NOKEYWORD hint can acquire native bindings on first use, including when no
preceding REM or escaped-string context triggered analysis. Hints only schedule
lookup. Native signature queries still decide whether a callable exists; real
comments and unavailable callees do not gain signatures. With no native model,
the existing source-only guard remains in place for ordinary keyword triggers.

Reference signatures are used only when no resolved symbol or positive native
selection already owns the name. Arrays and other non-callable values must not
borrow an intrinsic's signature because their spelling happens to match.
Parenthesized source bindings can describe indexing, so stock queries retain
the selected value declaration and do not label it as a selected procedure.
Sparse native selections also prevent unrelated reference help. Genuine unbound
intrinsics keep their reference signatures, including after independent errors.

The source-mode stock overload probe also applies this identity decision. A
conditional source index can contain both procedure and array declarations for
one name. When the native probe identifies a value, its entry replaces those
procedure guesses; an exact selected declaration-site match can do the same when
the reply is sparse. Values absent from the source index remain usable native
evidence. They are not rescored using procedure return types. Actual selected
procedures retain the existing source overload alternatives and active target.

The same source-mode probe consumes native callable-value and macro signatures,
not just declaration sites. A function-pointer type replaces conditional source
procedure guesses without claiming a runtime target. Direct native queries and
late stock probes share one conversion path, preserving anonymous parameter
labels and their UTF-16 offsets. These native signatures stop further procedure
return-type rescoring; ordinary selected procedures keep their overload lists.

Signature Help checks the requesting document again after asynchronous source
refinement, not just after the native worker query. Constructor lookup can wait
for workspace indexing, and source-mode overload selection can outlive the
original call position even when the worker correctly rejects its stale reply.
Edits, cancellation, and document closure stop those requests before further
lookups or rendering. Already-cancelled requests do not copy the source text.

Hover applies the same requesting-document checks after compiler acquisition,
native fact queries, and late operator/overload refinement. An unavailable
compiler result after an edit is not permission to display a declaration from
the earlier source model. Changed, closed, and cancelled requests stop before
further snapshot lookups or rendering; already-cancelled requests do not read
source lines. Current source-only hovers remain available without a compiler.

Cached stock binding models do not make square-bracket requests callable-value
requests. Indexer Signature Help retains its existing source candidate list and
native operator-selection receipts, including same-result overloads. This keeps
an unrelated prior binding request from changing whether index help is available.

Shared stock overload selection now checks committed call bindings first when
they are available. An expression type at the cursor can describe an argument
or conversion and cannot override a proven callee identity. Weak models retain
their existing return-type fallback without forcing an upfront binding upgrade.
Indexer candidates go directly to the typed index-receipt query; expression-type
and ordinary-call queries cannot select an Operator [] and are no longer issued
first. Missing index receipts remain unselected instead of being guessed.

Committed call selection can also settle conditional source declarations. The
source join retains the exact native-selected declaration sites alongside their
ABI key. Conditional candidates are accepted only at those sites, so an inactive
branch with the same name and signature cannot inherit the target. This enables
guarded-header same-result overload hovers without return-type guessing. Other
key-only source joins retain their existing conditional/provisional safeguards.

Selected operator targets likewise accept conditional entries when a committed
operation or typed-expression receipt maps to one physical operator. Procedure
records currently identify a source line rather than a token column, so multiple
operators on that line remain ambiguous. Provisional entries and the other
key-only operator joins keep their existing safeguards.

Typed operator-expression query records retain their physical UTF-16 offsets.
At-position queries use those offsets to select the narrowest containing native
receipt, including across lines and after Unicode text. Equally narrow ranges
remain ambiguous. Dropping the offsets during compaction previously made the
width comparison NaN and discarded all overlapping receipts, breaking nested
indexer overload selection and navigation.

For a uniquely selected operator, at-position typed-expression and operation
queries also export its physical procedure-prototype and procedure-definition
D ranges, bounded to 64 sites.
These records share the selected native symbol identity; they are not joined by
name or by a guessed ABI signature. D ranges cover whole declaration headers,
so the editor requires exactly one non-provisional source operator inside each
range with the corresponding prototype/body role. This admits active guarded
prototypes without admitting identical inactive branches, and permits an alias
spelling in the body. Physical locations remain distinct even when a prototype
and body share a source-family ID. Go to Declaration uses the proven prototypes;
definition and implementation navigation retain the selected body. Indexer
navigation selects either native role without expanding a conditional source
family. Receipts lacking usable D ranges retain their previous fallbacks.
Snapshot-wide queries are not enlarged, and no additional compiler pass or query
is needed.

Call-site operator references and highlights retain the selected receipt and its
own compiler model, including a replacement obtained during indexer binding
acquisition. Symbol IDs are compared only inside that snapshot. These paths use
native operator/typed-expression receipts and physical D declarations instead
of seeding results from source-reference guesses. Operation receipts retain
priority; typed-expression receipts supply the existing intrinsic fallback.
Ambiguous target lists are excluded. Document highlights filter to the requesting
file, and asynchronous results are discarded after edits, closure, or cancellation.
These results cover the selected compilation snapshot. Cross-root operator-
reference joins remain separate work.

Operator declaration/body origins use `compilerSidecarOperatorDeclarationAt`.
Source syntax limits requests to the operator name rather than its parameters
or qualified owner. Native F kind and physical D header containment then require
one operator identity. Anonymous operators retain their F kind even without a
named B declaration. A null lookup denotes unavailable metadata and preserves
the older unconditional fallback; an empty native target is authoritative and
cannot fall back to inactive or ambiguous source guesses. Header requests use
the explicitly selected translation unit/build context. Operator call receipts
retain native identity without a local P body, so external library declarations
can find their observed callers as well. No compiler changes were needed.

Definition, declaration, and implementation requests at operator declarations
reuse that lookup. Native prototypes and bodies are selected by role, without
expanding a conditional source family. Definition falls back to a proven
prototype when no local body exists; implementation does not invent one. A
compiler-known body outside the source index retains its physical D header
location. Existing unconditional source/project navigation remains available
when another translation unit owns an already indexed implementation.

Call-site operator selection uses the same physical D data, preferring a known
body but retaining a proven prototype when no local P body exists. Operation
and typed-expression receipts share this selection rule. Hover and references
can therefore use declaration-only callees. Navigation shares the role adapter
with declaration/body origins: Definition can open the native prototype, while
Implementation requires a body. Indexers follow the same missing-body rule.

Shared operator declaration probes use the entry's terminal physical name span,
not the full written qualification. In `Operator TypeName.Cast` or
`Operator TypeName.[]`, the owner remains a normal type reference for navigation
and cannot be mistaken for an operator Call Hierarchy target. These probes use
model offsets so lightweight document facades need no editor-only offset API.

Operator Call Hierarchy preparation requests native bindings for declaration
names even when a qualified `TypeName.[]` header has no call frame. Native D
declarations and index receipts can prepare guarded/external items without the
source-only conditional filter. Incoming requests re-resolve the item's physical
declaration in the current compiler context and reject a changed signature;
they do not persist snapshot-local symbol IDs in the item. Native operator
references supply callee identity and call ranges. Existing recognized source
procedure/module grouping labels the callers; unresolved caller scopes and
cross-root joins are not inferred. This also works when editor command APIs
drop opaque item data. Outgoing-call handling retains its existing behavior.

Bulk operator queries optionally accept a positive safe-integer `targetSymbol`
from that same compiler snapshot. Reference/highlight requests supply it so
unrelated operators neither cross the worker boundary nor consume the 5,000-site
result budget. The worker first selects physical ranges containing the requested
identity, then collects every target at those ranges. This preserves ambiguity
instead of making a conflicting site falsely unique. The requested target's own
limit and unfiltered-query behavior are unchanged; missing targets return an
empty complete result. Invalid filter identities are rejected.

Canonical type spellings intentionally omit parameter names and defaults.
Signature labels therefore show anonymous parameter types, not names borrowed
from the routine that initialized the pointer. This supplies no runtime call
target or navigation identity. Generated type parsing is bounded to 16 KiB,
64 nested levels, and 256 parameters. Array indexing and extra pointer
indirection are not treated as direct callable values. Calls whose callee is an
expression rather than a named value, such as `callbacks(i)(...)` or
`(*pointer)(...)`, use the separate compound-callee path described above.

Ordinary bridge Signature Help uses the same recovery lookup when an incomplete
call has no surviving reference binding. Exact-name visibility is applied before
the completion result limit, so unrelated declarations in a large module do not
crowd out the callee. Completion's single item can be expanded into its native
owner's overload group; every declaration must precede the caller and pass native
access checks in each projected caller context. Ambiguous imports and names from
unrelated scopes are withheld. Rejected declarations do not acquire shadowing
authority from their source spelling. Recovered candidates supply signature
information only: they do not restore reference bindings or report a selected
overload. Existing committed-call selection and stock-sidecar behavior remain
separate.

For committed bridge calls, an exact AST call-target receipt can
also expand the displayed declaration into its accessible native overload family.
That same target identity selects the active signature; parameter types are not
scored in the extension. Getter and setter families stay separate. Native owner,
caller access, and declaration-order checks still apply, and single-signature
families skip the extra AST lookup. If the call-target proof is unavailable, the
existing result stays intact instead of choosing an active overload from source.

Bare calls use a native expression point at the terminal callee to obtain the
compiler-owned end of the call. The source span retains qualified receivers,
including arrow access and whitespace around dots, for the exact AST call-start
check. This avoids scanning forward across a continuation, colon, comment, or
inline IF arm to guess where a call ends. Parenthesized calls keep their existing
exact-range path, and incomplete calls still have no selected-target claim.

Completion editing preserves an existing parenthesized or square-bracketed
argument list after the current identifier. Generated call snippets become
name-only insertions, with a full-identifier replacement range independent of the
editor's suggest insert mode. This includes constructors, member calls, macros,
and offline-reference functions. Documentation, compiler facts, and additional
import edits remain attached. Fresh call sites keep their parameter placeholders.
Case-insensitive matching handles reference labels whose snippet spelling uses
different casing. Immediate brackets use a cheap line check; comments and
explicit continuations use at most 64 KiB of lookahead. An exhausted undecided
gap withholds a call snippet. Edited/cancelled results are discarded before
replacement ranges are published.

The complete completion request also captures compiler/workspace generations,
the selected compiler-context signature and workspace trust. Closure or changes
to any of these retire the menu, including source supplements and asynchronous
include-path edits. Guards run before acquisition, after asynchronous reads and
before publishing. A missing header context still allows source-only completion;
gaining or losing that context retires a pending request. Compatible snapshot
enrichment within the same context retains its existing one-replacement path.
No new compiler invocation or retry is added.

The same edit guard preserves written bare-call arguments. When code already
follows the name, the existing Signature Help parser must identify that exact
name as the bare statement head. Qualified and pointer methods, explicit
continuations, and single-line IF branches share that parser. Assignment targets,
declaration names, and identifiers inside another call do not qualify. Comment
lookahead remains bounded, and no extra compiler request is made. This is an
editing safeguard, not a new claim about symbol or overload resolution.

Procedure-address completion also keeps generated calls name-only after a
same-line `@` prefix, including namespace/global qualification and dot/arrow
members. Only the terminal identifier is replaced; documentation and import
edits survive. Fresh function-like macro completions retain their argument
templates because expansion is still required under `@`; already-written macro
arguments follow the ordinary preservation path. Other fresh calls keep their
placeholders. This guard adds no compiler request and does not infer a target
or classify `ProcPtr` from source spelling.

Source/inventory global qualification also starts lookup from the module scope,
not a local shadow or an absent WITH receiver. A single leading dot selects
globals outside WITH; two select globals inside WITH. Unresolved single-dot
WITH receivers and declared keyword receivers do not fall back to global names.
Global completion shares ordinary visible-name/include/access filtering, and
stock receiver-type enrichment leaves it intact because there is no value
receiver to type.

Type-position completion reuses the existing string/comment scan to classify
`As` and `Extends` slots, including explicit continuations and qualified names.
Only type/alias, namespace, and macro entries are retained; enum/union entries
and primitive names other than OBJECT are omitted from base-type menus. Type
names never acquire constructor snippets, while type-producing macros retain
their expansion arguments. Ordinary menus remain in callable-type calling
conventions, TYPEOF operands, initializers, fixed-string lengths, and OPEN/NAME
file operands. SELECT CASE AS
CONST is not a type slot. Source NOKEYWORD AS/EXTENDS hints withhold this filter
instead of establishing an active keyword role. Continued context is capped at
64 KiB and oversized statements leave the restriction unavailable.

Failed namespace/static-owner suffixes can use direct native token projections
and surviving native declarations for completion. Scoped exact-name lookup,
native member/access rules, bounded owner chains, and common projected contexts
still apply. Value receivers and unproven global/macro prefixes do not become
static owners. The unfinished suffix receives no binding or expression type.
Stock constructor enrichment also keeps ordinary nonconditional source value
candidates, with native names taking precedence, rather than erasing those
expression choices with a type-only snapshot. Neither path adds a compiler pass.

Stock type-slot requests also reuse physical declaration bindings to recover
type/alias, enum, and namespace candidates. The editor forwards its slot hint to
schedule this lookup; the hint never supplies an identity. Source candidates
must match one native declaration at the exact physical site and retain its
semantic symbol ID. Parsing uses native REM and escape overrides. Keyword-named
qualifiers can request stock bindings even at an empty suffix after the dot;
neither expression-type nor constructor metadata is required by this lookup.
Constructor recovery retains its aggregate-only policy and existing bounds.
The bridge separately accepts committed keyword-named namespace owners from
its native inventory, preserving native access checks and value-receiver priority.

Type-slot lookup retains conditional declaration siblings until exact native
declaration-site bindings select the active one. Value names do not replace the
type namespace, and inactive declarations cannot supply a candidate. Constructor
recovery keeps its separate conservative conditional policy. Parsed source is
cached within an interval of native root-include sites; crossing one invalidates
the cached reachable-file set without rebuilding it for every typed character.
Source type resolution also checks that a USING import precedes the lookup.

Run **FreeBASIC: Analyze Module With Compiler** on a named module. Set
`freebasic.analysis.run` to `onSave` or `onChange` for automatic analysis.
Use `freebasic.analysis.timeoutMs` to set the native analysis/refactoring request
limit (60 seconds by default, up to five minutes). Ordinary compile diagnostics
retain their separate `freebasic.diagnostics.timeoutMs` setting. Use
**FreeBASIC: Show Compiler-Expanded Module** to inspect generated text.

## Safety and validity

- Compiler analysis is opt-in, local-file-only, and disabled without workspace
  trust. Named dirty buffers are passed as immutable overlays.
- Analysis accepts a small allowlist of language/target/include arguments.
  Response files, backend passthrough commands, output options, and unrecognized
  flags are rejected. `-z nocmdline` prevents source-level `#cmdline` from
  redirecting the managed invocation. Projects relying on `#cmdline` must move
  the relevant accepted options into settings.
- Output lives in an owned temporary directory. Compiler stdout/stderr is
  limited to 2 MiB; preprocessed output is polled against a 32 MiB limit and
  checked again before reading. Polling can allow a brief file-size overshoot.
- The configured native-analysis timeout applies independently of ordinary
  diagnostic checks. Cancellation terminates the compiler process group on
  Linux. Stale results cannot replace new snapshots.
- File size and modification stamps are checked across compilation and before
  snapshot reuse. Compiler-discovered dependencies missing from the index
  require a second pass against captured pre-run stamps. These checks are not
  a hermetic filesystem snapshot or a defense against deliberately preserved
  timestamps.
- Source/model text is limited to 32 MiB and 5,000 files per analysis. Retained
  snapshots and expanded views are each limited to eight entries and 32 MiB
  of retained text. Actual model memory is larger than its source text.
- A translation unit may contain at most 200,000 procedure binding records and
  200,000 expression/receiver records, plus 200,000 expression graph nodes.
  Malformed, unsupported, duplicated, or out-of-range records reject the
  snapshot instead of producing guessed navigation locations.
- Editing source or settings invalidates snapshots. The lightweight analyzer
  continues to work. A bridge configuration routes rename exclusively through
  compiler project validation, including after invalidation; the lightweight
  rename provider cannot silently take over.

## Verification

`npm test` includes protocol, source-hook compatibility, projection, trust,
dirty-buffer, cancellation, dependency-discovery, and cache-invalidation tests.
On Linux, `npm run test:unit` discovers a nearby FreeBASIC checkout and
bootstrap compiler, then builds the editor bridge. Set
`FBC_EDITOR_EXECUTABLE` to select a specific bridge:

That variable selects an existing executable; it does not rebuild it. Rebuild
the bridge after changing the compiler checkout, even if the reported compiler
version is unchanged. The current source/binary identities and full editor
results are recorded in the [refreshed compiler checkpoint](compiler-grade-plan.md#refreshed-compiler-checkpoint-2026-10-16).

The latest consolidated installed-VSIX runs pass all 101 editor checks on each
supported editor version. The complete unit run and its two timeout-adjusted
stress reruns are recorded separately in the
[validation record](compiler-grade-plan.md#full-linux-release-checkpoint-2026-10-16).
Those combined results are not a repeated successful `npm test` command under
the new offline limits.

```bash
FBC_EDITOR_EXECUTABLE=/path/to/fbc-editor npm test
FBC_EDITOR_EXECUTABLE=/path/to/fbc-editor FBC_EXECUTABLE=/path/to/fbc npm run test:integration
FBC_EDITOR_EXECUTABLE=/path/to/fbc-editor FBC_EXECUTABLE=/path/to/fbc npm run test:corpus:native
```

The compiler tests compile both sides of a conditional configuration, expand
a declaration macro from a directive-only header, and verify the resulting
editor symbols. They also check overload conversions, prototype/body identity,
nested and generated calls, properties, static virtual targets, BYREF results,
optional arguments, indirect-call exclusion, and trace-disabled output parity.
Legacy `fblite` and `qb` tests cover suffixed procedure names. Additional tests
cover native expression promotions, compound receivers, unsaved module/header
overlays, shared-header project rename, configuration gaps, capture, and races.
Actual VS Code tests cover overload-specific definitions/references/signatures,
result-type member completion, expanded-call navigation, changed defines,
generated-definition navigation, expanded text, semantic tokens, unsaved-buffer
type inspection, and a multi-module/multi-configuration rename preview.
The compiler-independent suite remains usable on Windows; a Windows bridge
build and native integration have not been implemented or verified.

Native tests run when `FBC_EDITOR_EXECUTABLE` is supplied or the Linux unit
runner can find or build a bridge. If no bridge is available, protocol and
model tests still run and compiler-dependent tests are skipped.

On 2026-09-09, all 188 smoke, unit, native-compiler, and TextMate tests passed
with the protocol 11 bridge enabled. The packaged extension passed all 28
integration checks on both VS Code 1.85.0 and 1.121.0 on Linux. Overlay tests
include encoding rejection, ambiguous symlink buffers, and on-change debounce.
Header-context tests cover closed module editors, cancelled context selection,
stale and in-flight build changes, native conditional types, and rename previews
validated across all builds while editing an unsaved header.
Worker tests cover immutable queued buffers and environments, exact-trace cache
limits, native/direct record parity, stalled decoding, malformed messages, spawn
failure, crash recovery, and shutdown that reaps children before returning.
Trust loss also prevents the dependency-discovery verification pass and rejects
snapshot publication.
Prepared-model tests additionally cover native/direct query parity, expanded
views, stale disk files, closed dirty buffers, prototype cursor coordinates,
typed-array replies, LRU eviction, context/generation changes, and query
backpressure without global cache loss. The native corpus audit also prepares
worker models and compares their semantic tokens with direct models.
Project-worker tests cover four-context validation, one-use publication,
immutable queued jobs, unsaved BOM-prefixed sources, changes during final
verification, redirected symlinks, cancellation, trust loss, and private spool
cleanup. Existing corruption tests exercise the shared transaction engine.
Recovery tests include incomplete expressions, missing or mismatched `TYPE` and
`ENUM` endings, malformed unsaved includes with valid later expressions,
error-limit stops, diagnostic clearing, and refactoring exclusion.
Reference/dispatch recovery cases also retain independent types around malformed
virtual declarations, namespace imports, forward types, and result assignments.
Label tests cover `GOTO`, `GOSUB`, `RETURN <label>`, `ON ... GOTO/GOSUB`, `ON ERROR GOTO`, `ON LOCAL ERROR GOTO`,
numeric single-line `IF` branches, and `RESTORE` navigation and references for
named and numeric labels, semantic tokens, decimal or base-prefixed
numeric-to-numeric rename, and validated numeric-to-named conversion with
colon-free and colon-terminated declarations. Numeric labels in either branch
of a single-line `IF` are converted through a structural `GOTO name` rewrite.
`ELSE GOTO` adds one anonymous compiler scope, so project validation models its
exact ID shift and rejects any other changed declared relationship.
Compiled before/after rename programs preserve output for procedure addresses
and virtual calls. Trace-disabled preprocessing matches the unmodified compiler
on ten native fixtures. Additional checks retain folded binary operands,
conditional branches, call arguments, twenty successive overloaded dereferences,
and useful default-argument call types around an unrelated syntax error.

The repeatable native corpus audit covers 776 `.bas` files across the upstream
`expressions`, `pointers`, `numbers`, `overload`, `quirk`, `string`, `file`,
`gfx`, `sfx`, `threads`, `console`, `functions`, `qb`, `command-sweep`, and
`typedef` categories. All matched the original compiler's exit outcome and
trace-disabled preprocessing; stripped traced source matched too. The run
retained 46,327 declarations, 14,520 lexical scopes, 744,128 mapped editor
tokens, and 1,300,220 reachable macro-map nodes across snapshots. It exported
328,846 syntax nodes, 90,092 conversions, 53,997 binary operations, 2,971
unary operations, 3,648 conditionals, 176,234 argument nodes, 32,238 calls,
and 1,470 index records, including records from included test infrastructure.
Native editor models and worker-prepared models both passed for all 776
snapshots, and prepared semantic tokens matched direct-model queries. The
preprocessor inventory retained 13,130 definition instances, 11,623 parameter
declarations, and 460,426 lookup/invocation/undefinition records, with 254,418
bindings projected into physical source. These are totals across the corpus;
limits apply separately to each compiler invocation. This audits instrumented
preprocessing, not execution of the upstream test suite or completeness of every
source expression and reference form.

For every complete snapshot, the corpus audit also compares final deduplicated
type ranges with syntax-node ranges and verifies exact dtype, subtype, and
rendered-type agreement. The earlier 776-case run checked 411 complete
snapshots with no missing type/syntax ranges or disagreements. Partial snapshots
are counted separately because recovery may retract one record while preserving
an independent expression. This is a bridge-consistency gate; it does not prove
all grammar branches execute or provide an independent oracle for the
compiler's type result.

Analysis of `ast-node-call.bas` and `parser-proc.bas` also exercises thousands
of native type records. This is a regression check, not a claim that every
compiler expression is represented. Building the bridge leaves the original
compiler checkout unchanged.

The 2026-10-16 x86-64 binding audit passes all 244 upstream `scopes` and
`visibility` inputs using FBC 1.20.5-1. Direct and worker analysis use identical
export options and captured source; their semantic tokens match for all 73
complete and 171 partial models. All 2,599 physical bindings and 61 implicit
calls have valid source ranges and selected target signatures where required.
No models are missing or bounded, and stock/bridge compiler parity passes for
every input. This is reproducible with `tools/audit-native-corpus.js
--semantic-bindings --architecture=x86-64 --timeout-ms=60000 --category=scopes
--category=visibility` and the compiler environment variables above. It verifies
this subset, not complete declaration, access-control, or refactoring coverage.

The refreshed compiler's x86-64 expression-sidecar audit also passes all 248
`functions` and `overload` inputs: 121 complete and 127 partial models, without
bounded or missing analyses. All 46,571 typed trace ranges agree with their
native syntax types. Sidecar-only checks cover 8,636 expression observations;
34 ambiguous observations remain withheld, with no unexplained missing or
mistyped result. The binary model supplies 113 results absent from the trace,
and recovery checks expose no unsafe facts. Run `tools/audit-native-corpus.js
--semantic-sidecar --architecture=x86-64 --timeout-ms=60000 --category=functions
--category=overload` with the compiler environment variables above to repeat
this gate. Other categories, modes, and architectures remain separate checks.

The current compiler-source model checks retain 5,690 and 6,537 native
declarations, with 314 and 729 scope instances respectively. Both modules reach
EOF without errors. Native scope tests cover sibling IF branches, loop-local
lifetime, reopened namespaces, promoted anonymous union fields, derived-method
protected access, and legacy implicit variables promoted to procedure scope.
Project tests deliberately corrupt scope, shape, and prototype metadata and
verify that validation returns no edits.

Physical-origin tests cover LF, CRLF, CR, UTF-8 BOMs, Unicode string content,
empty unsaved includes, nested comments, lookahead, continued expressions,
rewritten literals, repeated logical line locations, and legacy suffix-preserving
rename. Deliberately altered physical anchors or missing token records fail
project validation. The packaged editor test analyzes an unsaved remapped module,
queries a multi-line expression type, navigates references to physical locations,
and previews rename without touching saved files. The compiler-source checks
projected 24,795 and 34,923 editor tokens respectively, including 753 and 2,555
copied macro tokens. Macro tests cover duplicated/nested argument typing,
exclusive selection ends, differing expansion scopes, constructed names, callback
input lifetime, and stringification-sensitive rename rejection. Altered map
edges, parameter ordinals, physical leaves, or token map IDs fail validation.
An unrelated open buffer does not become a rename coverage requirement merely
because it contains the same spelling. Configured modules and compiler-discovered
dependencies define that check; all captured buffers remain available during
include discovery and are checked for concurrent edits before returning a preview.
The compiler-source checks retained 947/990 macro definitions and 567/586 parameter
declarations, projecting 2,445/2,853 preprocessor bindings. Macro identity tests
cover empty expansions, equivalent definitions, guards, redefinition lifetimes,
shared unsaved headers, both configured branches, malformed metadata, optional
parentheses, variadics, recursive errors, and invalid parameter lists.

## Remaining stages

Signature-only call-context scanning also recognizes compound bracket receivers.
This syntax classification does not alter ordinary navigation call contexts or
establish a callable type. Bridge index signatures require an exact independently
valid aggregate receiver type, using the usual recovery-taint checks, then
intersect accessible native index members across projected caller contexts.
When recovery sidecars omit selection spans, at most 64 source token starts in
the existing 16-KiB callee window schedule exact native type queries. Source
spelling never supplies the type. Factories, indexed elements, grouping and
explicit dereference therefore work without inferring invalid array ranks or
pointer dereferences. Complete index expressions retain native target selection;
incomplete ones do not. Indirect callable signatures keep their existing path,
and compound indexing does not request stock procedure-pointer bindings.

Incomplete named-value indexing can retain its native index-operator signature
family without restoring the expression's target or navigation binding. Recovery
uses surviving scalar variable/field/parameter declarations and native shape/type
facts, then intersects overloads accessible in every projected caller context.
For implicit `This`, an independently valid exact receiver type can supply the
aggregate identity; surrounding class scope or spelling alone is insufficient.
Recovered/provisional types, arrays, pointers and type names are excluded. Native
access still controls private operators and fields. Display records reuse the
physical prototype rather than the legacy truncated index caption. This path is
bridge-only and signature-only; it does not certify the incomplete index result.

Constructor Signature Help can now use surviving native type declarations and
recovery token/scope coordinates while argument parsing is incomplete. It
intersects native caller contexts, applies native member access and rejects
ambiguous imported type owners, pointer/scalar aliases and real value shadowing.
A compiler-rejected duplicate parameter does not hide an independently valid
native type. This is signature-only recovery: it does not restore a navigation
binding, expression type or committed call target. A failed identity upgrade
may leave a reusable current bridge recovery snapshot, which Signature Help can
query without presenting it as a successful binding upgrade. Stock-sidecar and
complete-but-insufficient models retain their existing acquisition boundary.

1. Finish native reference coverage and audit the native inventory/completion
   path against all supported declaration forms and visibility contexts.
   Complete ambiguous/unexpanded deferred preprocessor bindings and
   rewritten-literal ranges.
   Keep hooks at committed parser decisions.
2. Complete source expression and implicit-call graph coverage. Remove
   the remaining heuristic dependencies from type and member lookup.
3. Audit recovery provenance through unusual parser-repair and structural-scope
   paths. Native editor models, queries, project validation, configured Outline,
   and configured workspace-symbol search now use a persistent worker. Complete
   remaining host-side indexing work. Selected translation-unit/build contexts
   support ordinary header editing; incremental context reuse and interactive
   performance still need work.
4. Complete validated project refactoring coverage, then add macro-aware and
   structural refactorings. Named virtual families are supported; implicit
   special-member and macro-origin relationships still need coverage.

These stages remain unfinished in the current bridge. They are the remaining
work needed before claiming compiler-grade semantic behavior.

<!-- end of compiler-bridge.md -->
