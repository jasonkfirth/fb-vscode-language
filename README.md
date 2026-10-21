# FreeBASIC Language

FreeBASIC support for Visual Studio Code, aligned with FreeBASIC 1.20.5.

The extension handles `.bas` and `.bi` files and combines source-backed syntax data with fast, conservative editor analysis. It does not require a separate language-server process.

## Language support

- TextMate highlighting for declarations, control flow, types, operators, compiler defines, runtime functions, graphics APIs, TCP forms, and sfxlib command families
- declaration-name scopes for procedures, aggregates, namespaces, and constants
- FreeBASIC comments, block comments, number formats, string forms, word selection, auto-closing pairs, and block indentation
- document and selection formatting for recognized block indentation, with conservative handling of continued and same-line statements
- formatting reuses cached compiler-inactive ranges to leave disabled text unchanged and keep its block keywords out of active indentation; ambiguous cross-conditional scopes remain unchanged, and formatting never starts compiler analysis
- cached compiler lexical facts also guide formatting around escaped quotes and `REM` identifiers, including options imported from headers; source/comment scans share those facts and preserve BOM-relative offsets
- native matching and context-aware auto-closing for `()`, `[]`, and `{}`, with live warnings for unclosed or unexpected delimiters
- Expand Selection follows tokens, compiler-owned expression spans when available, matched delimiters, statements, comment groups, enclosing blocks, and the document; edits discard stale ranges and one cached compiler replacement retains native spans
- compiler-proven active blocks also supply Expand Selection parents, replacing conflicting source scopes closed by inactive code; whole-line bounds preserve Unicode closing comments without another analysis pass
- snippets for common language structures, types, properties, graphics, input, files, networking, threads, serial ports, and current audio APIs
- hierarchical Outline and breadcrumb symbols for namespaces, types, enums, procedures, fields, parameters, and local declarations, including compiler-created locals when sidecar facts are available
- native Outline and workspace symbols retain complete physical operator labels/prototypes and select both index brackets; compiler-owned scope and visibility stay authoritative, with bounded source-presentation caching and no extra compiler pass
- source Outline, completion and navigation retain `THREAD LOCAL DIM SHARED` and `THREAD LOCAL EXTERN` declarations when native analysis is unavailable, including private and continued declarations; compiler checks remain authoritative for storage validity
- Outline refreshes after compiler-context and active semantic-snapshot changes without requiring a text edit; active symbol lookups finish before the provider refresh so it does not cancel its own compiler work
- source symbols and include links refresh after closing, changing, and reopening a file, even when VS Code reuses the document version number
- workspace symbol search across `.bas` and `.bi` files
- bridge workspace search covers every module in the selected build, excluding other configurations; without an active context it retains labelled all-build discovery
- compiler progress, selected build context, and availability guidance in VS Code's FreeBASIC language-status menu
- type hierarchy navigation from user-defined type declarations or typed values, including compiler-selected `VAR`/`TYPEOF` values and aliases in stock-sidecar mode, following their direct bases/derived types
- type-definition and type-hierarchy requests follow a replacement compiler snapshot after concurrent binding upgrades, without accepting stale buffer results
- Type Hierarchy can reload a closed type file and reacquire native facts after snapshot invalidation; expanding its bases or derived types does not show or save an editor
- configured project Type Hierarchy finds direct derived types in other modules using the active build and compiler-proven inheritance, including alias bases; closed results remain expandable without opening a visible editor
- compiler-backed Go to Implementation on a user-defined type or type alias finds descendant types, excluding the selected root and unrelated branches; configured projects use the active build while Type Hierarchy retains direct levels
- Go to Implementation also follows a variable, parameter, field, or extern value's native aggregate type, including pointer/alias storage, without source-name type guesses or primitive-value project scans
- incoming and outgoing call hierarchy for procedures, properties, constructors, destructors, and operators, including compiler-selected indexer calls
- compiler-accepted primitive type spellings receive native `type.defaultLibrary` semantic classification, including sized integers and pointer declarations; aliases, NOKEYWORD values and unverified macro spellings retain their own identities
- built-in type hovers can show the compiler's canonical type and target storage width, including fixed strings, pointers and dynamic string descriptors; aliases and enclosing expression results are kept separate
- project Call Hierarchy retains compiler-selected macro-generated procedure calls across modules, including nested expansion, token-pasted callees and overloads; native invocation ranges are reporting anchors, not editable callee spellings
- protocol-15 bridge Call Hierarchy distinguishes unevaluated `TypeOf`/`SizeOf` operands from runtime calls while retaining symbol references and types, including repeated macro arguments; dynamic-string `Len` operands remain evaluated
- full-sidecar project Call Hierarchy uses FBC's unevaluated-input receipts to exclude query-only construction, cast and index operations, without removing those sites from Find References
- incoming operator hierarchy searches configured modules in the active build using native overload families and statement ownership, including closed routine callers and module-level calls; complete results avoid a second project-reference scan, while unavailable ownership retains the snapshot-safe fallback
- incoming Call Hierarchy for named procedures/properties also searches configured modules in the active build, using native caller ownership and retaining closed-file expansion; complete native lists replace source-only call guesses, while failed or unprojectable lookups retain the local tree and indirect runtime targets are not guessed
- module-local procedures and properties can use the current `.bas` compiler context for native Call Hierarchy without project setup, including files outside a workspace; included-header nodes retain the originating module, while project-wide discovery still requires contexts
- expanding an included-header hierarchy node can reload its originating module without showing an editor; shared headers keep each module's own defines, and direct header editing still requires a selected translation unit
- configured stock-FBC incoming lookup for named routines tries the native project graph before requesting the source semantic model or fallback call bindings; unavailable results still use the existing source fallback
- native outgoing Call Hierarchy owns ordinary, construction, cleanup and operator edges in the selected translation unit, including conditional bodies and property accessors; complete projections replace source-scope guesses, while unavailable ownership retains the prior fallback
- stock-FBC file-level outgoing trees also use native ownership for global calls and implicit construction/cleanup/operators, keeping each file separate from routine bodies, included-file sites and address-taking
- shared spans can retain distinct compiler-selected construction and cleanup targets without duplicate ranges; ambiguous overload receipts cannot masquerade as multiple proven calls
- populated ordinary/index-only outgoing trees reuse a complete, current bridge snapshot without another compiler invocation; non-index operators and replacement-body callees require fuller projection because legacy traces cannot report all physical invocation sites
- module Call Hierarchy includes compiler-selected shared UDT initialization inside namespaces; constructor callers and bodies remain expandable through incoming and outgoing trees
- native destructor callers remain expandable to compiler-selected delete, scope-exit, and temporary cleanup sites, including requests from their prototypes
- constructor/destructor incoming trees also search configured modules in the active build, joining compiler-selected lifetime sites to mapped native statements; ambiguous or unmapped ownership keeps the existing fallback instead of returning a partial native tree
- stock-FBC constructor prototypes can prepare hierarchy without an open implementation; native incoming/outgoing lifetime items share the callable keyword selection rather than conflicting type-name anchors
- native outgoing Call Hierarchy includes compiler-selected construction and cleanup for procedures and modules; explicit temporary constructors also retain overload-specific hierarchy, references, and highlights when no implicit-call receipt is exported
- ordinary FBC uses counted temporary-construction selections and mapped opening contexts for constructor references, highlights, and Call Hierarchy, including defaulted calls and `TYPE<...>` construction
- typed temporary constructor calls also use the selected overload for Signature Help and parameter-name hints with ordinary FBC, without requiring the editor bridge
- `Type<UDT>(...)`, qualified/aliased types and `Type<TypeOf(...)>(...)` retain their own compiler-selected constructor Signature Help instead of borrowing an enclosing call's signature; prototype defaults are preserved without duplicate body entries
- hover on the `Type` construction keyword also shows that selected constructor prototype and its defaults; type-argument names keep their own bindings, and incomplete or aggregate-only initializers do not acquire a guessed constructor hover
- Go to Definition, Declaration and Implementation on the same `Type` keyword follow the selected constructor's native body/prototype roles, including guarded and header-only declarations, without source overload guesses
- references, highlights, project lifetime identity and Call Hierarchy on typed construction also select its explicit constructor when an enclosing call performs another conversion at the same source span; the conversion remains a separate native relationship
- the bridge also retains overload help for incomplete typed construction using native type declarations, named/parenthesized `TYPEOF` values and unambiguous empty factory calls; factories must have no required arguments, and pointer/scalar, ambiguous, rebound and provisional operands cannot supply guessed constructor families
- with the editor bridge, incomplete constructor arguments retain accessible native signature families for ordinary/NEW calls, aliases and qualified types; private, shadowed and ambiguous families stay excluded, and no overload selection or navigation binding is invented
- incomplete named-value index operations also retain native operator Signature Help, including aliases, public fields, parameters and valid `This` receivers; arrays, pointers, inaccessible fields, static-method `This` and provisional receiver types cannot supply guessed operator signatures
- with the bridge, compound index receivers such as `MakeValue()[`, `items(0)[`, `(value)[` and `(*pointer)[` use exact compiler receiver types for Signature Help; invalid-rank, whole-array, pointer, scalar, unknown and provisional receivers do not become guessed overloads
- qualified constructor references and hierarchy ranges select the terminal type or alias instead of its namespace; Signature Help retains the selected overload across namespace qualification
- Find References and highlights on destructor declarations load compiler-selected cleanup facts on first use with stock FBC or the bridge; stock FBC can resolve external destructors from header prototypes without an included body
- stock-FBC constructor references also use compiler-confirmed prototypes through include guards, even without a constructor body in the selected translation unit
- constructor Find References joins configured project modules/builds through shared physical prototypes or bodies, preserving the selected overload and implicit conversions without treating those sites as rename edits
- destructor Find References uses the same read-only project join for native cleanup and explicit calls, including header-only prototypes and closed modules, without mixing unrelated types or constructor identities
- native operator Find References joins configured modules/builds through physical headers, retaining selected binary/index overloads and closed-module uses; ambiguous project families fall back to the current compiler snapshot
- operator Definition/Declaration/Implementation can follow missing roles into other configured modules using the active build; closed guarded implementations are selected without editor-buffer edits or source-signature guesses
- constructor/destructor navigation can fill missing roles across configured modules, including NEW/type calls and compiler-selected argument conversions, while keeping aliases and namespace qualifiers on their proper identities
- ordinary procedure project jumps also use only the active build, with stale-request protection; Find References and rename validation still cover all configured builds
- compiler language status includes bounded failure reasons and identifies stock-FBC unsaved dependencies, with an explicit Save All action rather than a generic retry message
- virtual Go to Implementation follows compiler-proven override descendants in the current snapshot; Definition and Declaration remain statically bound, with no source-name matching of override families
- configured project implementation lookup extends virtual descendants into closed modules in the active build, without adding bases/siblings to derived-origin queries or changing ordinary references and rename behavior
- **FreeBASIC: Go to Base Method** in the Command Palette or editor context menu follows one native override edge upward, preferring a local body, then a configured project body in the active build, and otherwise its prototype; repeated invocation climbs the hierarchy without name-based inference
- project jumps recognize qualified namespace/method definitions at their compiler-bound terminal token, retaining the selected namespace and overload without requiring the implementation file to be open
- Call Hierarchy reloads and indexes closed caller files without showing their editors, preserving compiler-selected optional calls and overloads in stock-FBC and native modes
- native Call Hierarchy items reacquire expired compiler models and follow concurrent snapshot replacements without losing compiler-selected targets or macro-mapped call ranges
- operator receipt lookups also follow a current snapshot after binding/macro upgrades, keeping returned target identities attached to the compiler model that produced them and rejecting changed buffers/backends
- compiler-identified reference CodeLens on procedures, overloaded operators, constructors, and destructors, linking to physical symbol and operation sites from a current native snapshot or cached binding-capable FBC sidecar
- constructor CodeLens also counts compiler-selected written temporaries, optional calls, aliases, and qualified types, using the same selected overloads and physical sites as Find References
- reference CodeLens discards stale results after edits or context changes and follows one compatible cached enrichment without starting compiler analysis; invalid declaration ranges are omitted
- scope-aware completion plus `.` and `->` members for declared types, aliases, namespaces, arrays, and common return-value chains
- stock-FBC member completion retains compiler-selected base chains across cached analysis upgrades, keeping captured sources and member metadata on the same snapshot
- bridge-backed member completion retains the compiler-selected receiver while typing incomplete `value.` or `value.prefix` expressions, including pointer, array, and function-result receivers; invalid expressions and navigation bindings remain withheld
- bridge-backed name completion retains compiler-known locals, parameters, imports, and active macros in broken statements, preserving lexical scope and local-over-field shadowing
- empty-line bridge completion uses verified surrounding compiler tokens, retaining common visible declarations across whitespace/comment gaps while withholding unmapped or conflicting contexts
- compiler-origin string boundaries keep empty-line completion available after ordinary, escaped, and Unicode literals without exposing string contents as identifiers
- root-file EOF completion retains native globals, imports, and active macros after independently positioned errors when all compiler scopes are closed; unclosed scopes and unpositioned preprocessor failures remain withheld
- `Using` completion is restricted to namespaces, including child namespaces after a dot, instead of mixing in functions and API names
- completion discards pending menus and include-path edits after document closure, compiler/build-context changes, workspace invalidation or trust changes; compatible snapshot enrichment still retains native suggestions
- bundled API completion can add its uniquely mapped header and namespace import when accepting a type or function
- context-sensitive `GOTO`/`GOSUB`/`RESTORE` label completion, including forward procedure labels, computed `ON` target lists across commas and explicit continuations, and compiler-selected QB numeric labels
- unique non-overloaded procedure, indexed-getter, and parameterized-macro completion inserts argument placeholders and omits defaulted trailing arguments; offline-reference functions do the same when signatures share required argument names, while ambiguous overloads/accessors stay name-only and list their visible signatures; written bracketed and statement-head bare-call arguments are preserved instead of receiving a second call snippet
- procedure-address completion such as `@Handler` or `@Namespace.Handler` inserts only the name, not a call; fresh function-like macros still retain their expansion arguments
- `As` and `Extends` completion focuses on types, aliases, namespaces, and type-producing macros; `TYPEOF` operands, initializers, string lengths, and file-handle expressions retain ordinary completion
- stock-FBC type slots also retain compiler-bound names enabled by `NOKEYWORD`, including enum/alias names and keyword-named namespace qualifiers; the bridge uses native namespace owners for these qualifiers
- binding-backed type completion follows the active conditional declaration and cursor-relative include visibility; later `Using` imports do not affect earlier type lookups
- hover, go to definition/declaration/implementation/type definition, find references, document highlights, and guarded workspace rename
- offline built-in reference help and signatures generated from 618 current manual/header names, plus reference documentation on compiler-resolved bundled API hovers and signatures for user procedures and macros
- sized `CInt<bits>(...)` and `CUInt<bits>(...)` casts retain their own documented Signature Help, including nested calls and width expressions, without treating shadowed user names as intrinsics
- current gfxlib3 screen-capture and screen-to-surface copy APIs have source-backed highlighting, parameter snippets, signatures and automatic `fbgfx3.bi`/`Using fb` imports; reference excerpts from modified compiler inputs are labelled as working-copy snapshots
- bridge Signature Help keeps accessible overload alternatives for committed calls with or without parentheses while activating FBC's selected target; recovery retains procedure/method signatures while arguments are incomplete without guessing a selection
- method Signature Help also follows factory results, array elements, grouped pointers and arrow receivers, retaining accessible overloads and getter/setter separation; unfinished bridge method calls retain candidates without a guessed target
- calls without parentheses also retain native method help on compound receivers and `With`'s leading-dot calls, including continued arguments and incomplete bridge calls; a leading dot outside its native `With` context does not invent a receiver
- public instance-member completion also survives unclosed bridge scopes when a direct native receiver receipt remains available; private/protected members, provisional types, unknown producers and missing receivers stay withheld in that recovery path
- binary semantic models retain `thread-local` storage instead of rejecting TLS modules; native hover and completion details distinguish per-thread storage, and current contextual `THREAD` fields/namespace variables retain their own navigation identities
- compiler-backed Signature Help covers named function/Sub pointer values, including inferred variables, aliases, callback parameters and fields; the bridge also retains help while arguments are incomplete
- native Signature Help also covers callable expressions such as `callbacks(0)(...)`, `GetCallback(...)(...)`, `(callback)(...)`, and `(*callbackPointer)(...)`; the bridge retains native declaration-based help for these tested incomplete-call forms
- incomplete callback field calls on factory results and array elements can reuse accessible native member-completion types; this supplies parameter help without restoring the receiver's expression type or selecting an indirect target
- native array index Signature Help shows dimension positions and fixed bounds when available, with explicit `Array` labels; dynamic and descriptor arrays do not receive guessed bounds or callback parameter lists
- array fields on factory results, array elements and grouped pointer receivers retain native index help; arrays of callbacks distinguish indexing the array from invoking an element, including incomplete bridge index lists
- native Signature Help follows one concurrent compiler-model replacement, keeping callback and overload assistance on the current snapshot and discarding stale requests
- Signature Help supports procedure calls without parentheses, including qualified and pointer methods, continued arguments, and single-line `If` branches; space and comma trigger assistance, and manual invocation remains available
- native Signature Help retains disabled-keyword procedures, including generated declarations and broken bridge calls, without requiring the source index to recognize the callee; explicit `NOKEYWORD` hints can acquire native bindings on first use
- resolved arrays and other non-callable names shadow offline builtin signatures instead of receiving misleading intrinsic help; unrelated genuine builtins remain available after failed calls
- stock-FBC Signature Help and hover follow the compiler-selected macro definition and parameter names after redefinition
- stock-FBC semantic sidecar bindings can activate the selected ordinary overload when the source resolver finds multiple candidates, without requesting bindings for single-signature calls
- cached stock-FBC binding models retain compiler-linked public overload alternatives for ordinary, bare, namespace, method, and property calls, preserving the active native target, declaration order, and getter/setter separation
- signature help for overloaded `Operator []` indexers using the receiver's declared type; native analysis activates FBC's selected overload while retaining the visible candidates
- Hover on an index expression shows its `Operator []` signature and compiler-resolved result type
- Go to Declaration, Definition, and Implementation on an index expression follow its `Operator []` family, with native analysis selecting the compiler-bound overload
- compiler-backed Go to Type Definition on an index expression follows the selected operator's result type
- native Find References and document highlights include compiler-selected `Operator []` expressions without mixing overloads
- compiler-backed signature help preserves written default values for optional parameters
- compiler-selected parameter-name inlay hints label positional arguments for resolved user procedures, explicit constructor calls, and selected function-like macro definitions, including nested macro calls and calls in preprocessor expressions; tooltips also show compiler-selected parameter passing modes when available
- parameter hints also cover calls without parentheses, continued arguments, and dot/pointer methods; native method hints distinguish the hidden receiver from written arguments
- procedure and constructor parameter hints link to their physical parameter declarations when unambiguous, following the compiler-selected overload and build context, including continued header declarations
- typed `Type<...>(...)` constructor hints also follow native selections for aliases, qualification and `TYPEOF` type arguments, on stock FBC and the bridge; inner type-query parentheses do not receive the constructor's labels
- inlay hints refresh after compiler/model changes without a text edit, including when the first request had no compiler facts or hints; edits, closure, cancellation, and build-context changes discard stale replies
- set `freebasic.inlayHints.parameterNames.enabled` to `false` to hide parameter labels while retaining type/control-flow hints; parameter-only requests then avoid compiler binding and macro-graph work
- compiler-selected type inlay hints show implicit primitive types for variables (including `INPUT`/`READ` targets), parameters, and function results, including with ordinary stock-FBC sidecars
- current-compiler `Integer<128>` and `UInteger<128>` types retain their native layouts; inferred primitive hints and explicit-type refactors use valid source spellings, without confusing user types named `Integer128`
- native inferred-variable hovers show the compiler-selected primitive, aggregate or callback type even when the source signature only contains `Var`; explicit `As` declarations do not receive a redundant inferred-type label
- explicit-Var primitive-pointer refactors retain native `Const` qualifiers at every pointer level, including pointers to const data and pointers to fixed pointers
- hover on compiler-created `INPUT`/`READ` targets shows FBC's selected variable type and storage class
- hover on an implicit scalar `FOR` counter shows its compiler-selected type and storage class
- parameter hover reports positive compiler observations of direct assignments to the parameter value; field/pointee writes and indirect calls are not presented as direct assignments, and missing observations do not imply read-only or pure behavior
- a refactor action can declare an unresolved procedure-local `INPUT`/`READ` target with FBC's selected type
- native refactors retain separately returned facts and follow one compatible compiler-model refresh; refactor and Quick Fix requests discard late results after document, compiler-context, or trust changes, while source-only fixes remain available without trust
- enum-value refactors use a single native reply for the declaration and exact value, keeping each edit on one current compiler decision
- parameter and declaration refactors also retain native facts alongside populated sidecar entries; enum actions use the native physical range and constant query when entry-level enum inputs are absent
- calling-convention refactors retain the compiler's selected-header provenance and require a matching declaration statement; already-written conventions remain untouched
- semantic highlighting for resolved declarations and uses, using native bindings for ordinary saved stock-FBC files as well as bridge data; active build branches retain their compiler-selected symbol kinds, readonly qualifiers, and `modification` markers for writes; source fallback remains available when analysis cannot run; document highlights distinguish reads and writes when compiler access roles are available
- compiler-confirmed value-level const qualifiers add the standard `readonly` token modifier when binding facts are available, distinguishing fixed pointers from mutable pointers to const data without starting extra analysis
- stock-FBC semantic tokens retain ordinary variables, parameters, procedures, types, and fields alongside `OPTION NOKEYWORD` identifiers, with compiler-confirmed parameter aliases and declaration/definition roles
- compiler-confirmed `OPTION NOKEYWORD REM` contexts retain member completion and Signature Help without exposing real comments or strings as code, including block comments opened after a disabled keyword
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
- compiler-proven unreachable statement tokens also receive quiet unnecessary-code hints, independent of inlay hints; these reuse cached facts and clear after edits, without guessing that a whole source line is unreachable
- compiler analysis labels constant `IF` and `ELSEIF` predicates as `always true` or `always false`, using FBC's original integer predicate values before branch folding; runtime or conflicting observations remain unlabelled
- folding for language blocks, continued statements, consecutive `#include`/`USING` imports, comment blocks, and `' #region` or `REM #region` markers
- cached compiler block spans correct active-code folds, including procedures containing inactive terminators; source folds remain for comments, imports, regions and unrepresented constructs, without starting compiler analysis for folding
- cached native folding also applies the compiler's escape and `REM` policies to comments and regions; the worker combines and caches those folds with native block spans, without adding a second editor query
- clickable `#include` paths, following compiler-selected active physical includes when a semantic snapshot is available
- include-link targets refresh after compiler/build-context or include-path changes without requiring a source edit, including snapshot changes in visible split editors

The workspace index follows transitive includes and unsaved edits. A shared semantic model distinguishes local variables, fields, parameters, and unrelated declarations with the same name. Rename follows declaration identity and rejects ambiguous overloads, duplicate declarations, collisions, and incomplete indexes. Built-in help works offline; the matching compiler checkout is only needed to regenerate or audit the data.

Custom-extension headers, such as `.inc`, participate in compiler buffers and
explicit header contexts when their VS Code language mode is FreeBASIC. Select
that mode or configure the corresponding `files.associations` entry. With the
bridge, unsaved edits feed the selected module; stock FBC still requires saved
inputs. Unrelated plaintext buffers are not included, and default file
associations are unchanged.

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

Compiler-backed source diagnostics use one batched snapshot read per document.
This keeps included-header refreshes from filling the worker queue ahead of
interactive navigation and Call Hierarchy requests; queue bounds are unchanged.

A query that discovers stale source retires that translation unit only.
Unrelated compiler models and expanded views remain cached; existing global
filesystem-change cancellation is unchanged.

Up to eight small module snapshots can stay warm in the worker. The byte budget still takes priority, so large analyses evict other entries as needed rather than increasing the memory allowance.

Repeated compiler failures are throttled for unchanged inputs. Fixing and saving an open header releases that throttle even if its root module was not edited. Cancelled work, changed analysis timeouts, models discarded after preparation, and temporary worker-queue admission errors can be retried without the failure delay. Inputs that exceed the worker's individual safety limits remain ordinary errors.

Opening a new named header can also retire a partial snapshot that the compiler reported as missing that include, including macro-expanded include names. FBC confirms the new file and its types on the next analysis; on-change roots use their existing debounce. Newly available physical files also retire saved-file missing-include errors when they match the root's working-directory lookup, without hiding errors for unrelated paths.

Include-file completion closes an unfinished quoted filename and converts C-style `<...>` operands to FreeBASIC's supported double-quoted form. Directory completions keep the path open for continued typing.

Include completion and source-only navigation honor `-i` options from the selected build context. For a header with a selected translation unit, relative compiler paths and `-i` values use the root module's working directory. The header's own directory is searched first, followed by that working directory and the effective include options in compiler order. `includePaths` remains workspace-relative. Switching contexts refreshes source include caches automatically.

The duplicate-`DIM` Quick Fix also supports untyped declarations when their case-folded names imply the same default type.

When FBC reports an undeclared name after a single-counter `NEXT`, the Quick Fix can also remove that optional name; it does not apply to multi-counter `NEXT` statements.

Useful settings:

- `freebasic.compiler.path`: compiler path or command name, default `fbc`; on Windows, automatically checks `C:\freebasic\fbc64.exe`, `C:\freebasic\fbc32.exe`, then `C:\freebasic\fbc.exe` before PATH
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
