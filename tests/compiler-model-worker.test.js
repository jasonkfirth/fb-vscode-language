/*
    Project: FreeBASIC VS Code Language Extension Tests
    File: tests/compiler-model-worker.test.js
    Purpose: Protect worker-owned models and the editor query boundary.
    Responsibilities: verify native parity, source freshness, and bounded lifetime.
    Does not contain: compiler instrumentation or changes to user source files.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CompilerAnalysisWorker } = require("../lib/compiler-worker");
const { CompilerAnalysisService } = require("../lib/compiler-analysis-service");
const { CompilerRemoteModel } = require("../lib/compiler-remote-model");
const { CompilerModelStore, CompilerUri } = require("../lib/compiler-model-store");
const { CompilerSemanticModel, compilerSourceDeclarations, MAX_COMPILER_SOURCE_DECLARATION_BYTES,
    MAX_COMPILER_SOURCE_DECLARATION_DOCUMENTS, compilerParameterDeclarationLocation, freeBasicCallArgumentRanges } = require("../lib/compiler-semantic-model");
const { procedurePointerSignature, queryCompilerModel } = require("../lib/compiler-model-queries");
const { CompilerWorkspaceSymbols, WORKSPACE_SYMBOL_STRIDE, compactWorkspaceEntries, mapPackedWorkspaceEntries, packWorkspaceSymbols, workspaceSymbolKey, workspaceSymbolKeyFromPacked } = require("../lib/compiler-workspace-symbols");
const { indexWorkspaceJobs } = require("../lib/compiler-workspace-service");
const { analyzeSavedModule } = require("../lib/compiler-analysis");
const { TOKEN_MODIFIERS, TOKEN_TYPES } = require("../lib/semantic-token-data");
const { resolveFreeBasicRoot } = require("../tools/audit-freebasic-coverage");

const expandedUri = { scheme: "freebasic-preprocessed", value: "freebasic-preprocessed:/worker-test.bas", path: "/worker-test.bas" };
const native = { skip: !process.env.FBC_EDITOR_EXECUTABLE };
const pointAt = (text, spelling, relative = 0) => {
    const offset = text.indexOf(spelling) + relative;
    assert.ok(offset >= relative, `Missing fixture text: ${spelling}`);
    return { line: text.slice(0, offset).split("\n").length - 1, character: offset - text.lastIndexOf("\n", offset - 1) - 1 };
};

function decodeSemanticTokenRecords(data) {
    const records = [];
    let line = 0, character = 0;
    for (let index = 0; index < data.length; index += 5) {
        const lineDelta = data[index];
        line += lineDelta;
        character = lineDelta ? data[index + 1] : character + data[index + 1];
        records.push({
            line,
            character,
            length: data[index + 2],
            type: data[index + 3],
            modifiers: data[index + 4]
        });
    }
    return records;
}

test("remote header queries validate the owning context and retain ordinary query guards", async () => {
    for (const mode of ["current", "default", "replacement", "generation", "cancel", "outside"]) {
        const root = CompilerUri.file("/workspace/main.bas"), header = CompilerUri.file("/workspace/api.bi");
        const token = { isCancellationRequested: false }, messages = [];
        let current, calls = 0;
        const service = { generation: 1, vscode: { workspace: { textDocuments: [] } }, output: { appendLine: (value) => messages.push(value) },
            getModel: (uri) => uri.toString() === root.toString() ? current : null,
            analysisWorker: { models: new Map([["snapshot", {}]]), async query(_id, operation, input) {
                calls++;
                assert.equal(operation, "definition");
                assert.equal(input.uri.fsPath, mode === "default" ? root.fsPath : header.fsPath);
                if (mode === "replacement") current = {};
                if (mode === "generation") service.generation++;
                if (mode === "cancel") token.isCancellationRequested = true;
                if (mode === "outside") throw new Error("This source is not part of the compiler model.");
                return { result: [] };
            } } };
        const model = new CompilerRemoteModel(service, "snapshot", false, true, true);
        current = model;
        const result = mode === "default" ? await model.query("definition", root, {}, token)
            : await model.query("definition", header, {}, token, root);
        assert.deepEqual(result, ["current", "default"].includes(mode) ? [] : null, mode);
        assert.equal(calls, 1);
        assert.equal(messages.length, mode === "outside" ? 1 : 0);
        assert.equal(model.available(), true, "an unavailable header must not expire the owning model");
    }
});

test("module projection requests cannot enter project write or declaration modes", async (t) => {
    const worker = new CompilerAnalysisWorker();
    t.after(() => worker.dispose());
    const options = { root: "/workspace", selectedKey: "", oldName: "main.bas", newName: "main.bas",
        jobs: [{ name: "current", filePath: "/workspace/main.bas", compilerArguments: [] }],
        moduleOutgoingFile: "/workspace/main.bas", referencesOnly: true, outgoingCalls: true };
    for (const invalid of [{ referencesOnly: false }, { incomingCalls: true }, { declarationsOnly: true }, { moduleOutgoingFile: "relative.bas" }]) {
        await assert.rejects(worker.project({ ...options, ...invalid }), /Module outgoing projection/);
    }
    assert.equal(worker.worker, null, "invalid mode combinations must not launch native work");
});

test("native folding caches corrected lexical ranges without source-only region guesses", () => {
    const { tokenize } = require("../lib/semantic-model");
    const uri = CompilerUri.file("/workspace/native-folds.bas");
    const text = "Sub Main()\nREM = 1 /' block\n' #region fake\n' notes\n' #endregion\n'/\nPrint 1\nEnd Sub\n";
    const document = { uri, text, ...tokenize(text) };
    let lexicalReads = 0;
    const model = { partial: false, getDocument: () => document,
        semanticFoldingRanges: [{ filePath: uri.fsPath, startLine: 0, endLine: 7 }],
        compilerBracketMaskOverrides() {
            lexicalReads++;
            return { remIdentifierOffsets: [], remKeywordDisabledLineOffsets: [text.indexOf("REM")], defaultEscapedStringRanges: [] };
        } };
    const query = () => queryCompilerModel(model, "compilerFoldingRanges", { uri }, () => {});
    const result = query();
    assert.deepEqual(result, [{ startLine: 0, endLine: 7 }, { startLine: 1, endLine: 5, kind: "comment" }]);
    assert.equal(query(), result, "immutable snapshot queries reuse their folding projection");
    assert.equal(lexicalReads, 1);
});

test("procedure pointer signatures preserve native nested types without inventing targets", () => {
    const signature = procedurePointerSignature("callbacks.invoke",
        "function cdecl(as long, byref as string, as function(as long, as double) as double) byref as integer");
    assert.equal(signature.name, "callbacks.invoke");
    assert.equal(signature.parameters.length, 3);
    assert.equal(signature.parameters[1].label, "byref as string");
    assert.equal(signature.parameters[2].label, "as function(as long, as double) as double");
    for (const parameter of signature.parameters) {
        assert.equal(signature.signature.slice(...parameter.labelOffsets), parameter.label);
    }
    const repeated = procedurePointerSignature("combine", "function(as long, as long) as long");
    assert.ok(repeated.parameters[1].labelOffsets[0] > repeated.parameters[0].labelOffsets[1]);
    assert.equal(repeated.signature.slice(...repeated.parameters[1].labelOffsets), "as long");
    assert.equal(signature.signature,
        "Function callbacks.invoke cdecl(as long, byref as string, as function(as long, as double) as double) byref as integer");
    assert.equal(procedurePointerSignature("action", "sub()").parameters.length, 0);
    const variadic = procedurePointerSignature("action", "sub cdecl((any, any) as double, ...)");
    assert.equal(variadic.parameters.length, 2);
    assert.equal(variadic.parameters[1].variadic, true);
    for (const type of ["long", "typeof(function() as long) ptr", "sub() as long", "function()", "function(as long",
        "function(unknown) as long", "sub(" + Array(257).fill("as long").join(",") + ")",
        "sub(" + "(".repeat(65) + "as long" + ")".repeat(65) + ")", "sub()\n", "sub(" + " ".repeat(16384) + ")"]) {
        assert.equal(procedurePointerSignature("callback", type), null, type.slice(0, 80));
    }
});

test("physical header presentation uses a bounded per-snapshot source cache", () => {
    let reads = 0;
    const model = { compilerRemIdentifierOffsets() { reads++; return []; } };
    const source = { uri: CompilerUri.file("/workspace/physical-header.bas"), text: "Declare Sub Apply(ByVal amount As Long)\n" };
    const declarations = compilerSourceDeclarations(model, source);
    assert.equal(declarations[0].signature, "Declare Sub Apply(ByVal amount As Long)");
    assert.equal(compilerSourceDeclarations(model, source), declarations);
    assert.equal(reads, 1, "repeated presentation must not rescan the same captured source");
    assert.notEqual(compilerSourceDeclarations({}, source), declarations, "snapshots must not share parsed-source state");
    for (let index = 0; index < MAX_COMPILER_SOURCE_DECLARATION_DOCUMENTS; index++) {
        compilerSourceDeclarations(model, { ...source, uri: CompilerUri.file(`/workspace/header-${index}.bas`) });
    }
    assert.notEqual(compilerSourceDeclarations(model, source), declarations, "the oldest document is evicted at the existing cache bound");
    const before = reads;
    const large = { ...source, uri: CompilerUri.file("/workspace/oversized-header.bas"), text: " ".repeat(MAX_COMPILER_SOURCE_DECLARATION_BYTES + 1) };
    assert.equal(compilerSourceDeclarations(model, large), null);
    assert.equal(compilerSourceDeclarations(model, large), null);
    assert.equal(reads, before, "oversized sources must be refused before parsing or consulting lexer facts");
});

test("operator expression queries retain the innermost physical range and equal-span ambiguity", () => {
    const { tokenize } = require("../lib/semantic-model");
    const uri = CompilerUri.file("/workspace/nested-indexers.bas");
    const text = "' Unicode prefix: \u{1f600}\nPrint outer[ _\n    inner[CDbl(1)] _\n]\n";
    const document = { uri, text, ...tokenize(text) };
    const outerStart = text.indexOf("outer[");
    const outerEnd = text.lastIndexOf("]") + 1;
    const innerStart = text.indexOf("inner[");
    const innerEnd = text.indexOf("]") + 1;
    const point = (offset) => ({ line: text.slice(0, offset).split("\n").length - 1,
        character: offset - text.lastIndexOf("\n", offset - 1) - 1 });
    const fact = (symbol, startOffset, endOffset) => ({ operatorKind: "overloaded", operatorCode: "index",
        compilerSidecarSymbolId: symbol, startOffset, endOffset, start: point(startOffset), end: point(endOffset) });
    const facts = [fact(1, outerStart, outerEnd), fact(2, innerStart, innerEnd)];
    const model = { getDocument: () => document, sources: new Map([[uri.toString(), document]]),
        semanticProcedures: [1, 2, 3].map((symbol) => ({ symbol, symbolClass: 3,
            filePath: uri.fsPath, startLine: symbol, endLine: symbol })),
        compilerSidecarExpressions: new Map([[uri.toString(), facts]]) };
    const query = (offset) => queryCompilerModel(model, "compilerSidecarOperatorExpressionAt",
        { uri, position: point(offset), operatorCode: "index" }, () => {});
    const inner = query(innerEnd - 1);
    assert.equal(inner.expressions.length, 1);
    assert.deepEqual(inner.expressions[0].targetSymbols, [2]);
    assert.equal(inner.expressions[0].startOffset, innerStart);
    assert.equal(inner.expressions[0].endOffset, innerEnd);
    assert.deepEqual(query(outerEnd - 1).expressions[0].targetSymbols, [1]);
    facts.push(fact(3, innerStart - 1, innerEnd - 1));
    assert.equal(query(innerStart + 2).expressions.length, 2,
        "equally narrow physical ranges must remain ambiguous");
    facts.at(-1).provisional = true;
    assert.deepEqual(query(innerStart + 2).expressions[0].targetSymbols, [2]);
});

test("native operator target filters exclude unrelated budgets without hiding ambiguity", () => {
    const { tokenize } = require("../lib/semantic-model");
    const uri = CompilerUri.file("/workspace/operator-reference-budget.bas");
    // One more unrelated site than the existing 5,000-receipt query budget.
    const unrelated = 5001;
    const lines = [...Array(unrelated).fill("Print other + 1"), "Print selected + 1", "Print ambiguous + 1"];
    const text = lines.join("\n") + "\n";
    const document = { uri, text, ...tokenize(text) };
    const facts = [], operations = [];
    for (let line = 0; line < lines.length; line++) {
        const symbol = line < unrelated ? 1 : 2;
        const startOffset = document.lineOffsets[line] + "Print ".length;
        const endOffset = document.lineOffsets[line] + lines[line].length;
        facts.push({ operatorKind: "overloaded", operatorCode: "add", compilerSidecarSymbolId: symbol,
            startOffset, endOffset, start: { line, character: "Print ".length }, end: { line, character: lines[line].length } });
        const column = lines[line].indexOf("+");
        operations.push({ operatorKind: "overloaded", operatorCode: "add", physical: true, target: symbol,
            filePath: uri.fsPath, startLine: line + 1, startColumn: column, endLine: line + 1, endColumn: column + 1 });
    }
    facts.push({ ...facts.at(-1), compilerSidecarSymbolId: 1 });
    operations.push({ ...operations.at(-1), target: 1 });
    const model = { getDocument: () => document, sources: new Map([[uri.toString(), document]]),
        semanticProcedures: [1, 2].map((symbol) => ({ symbol, symbolClass: 3, filePath: uri.fsPath, startLine: 1, endLine: 1 })),
        compilerSidecarExpressions: new Map([[uri.toString(), facts]]), semanticOperations: operations };
    for (const [operation, key] of [["compilerSidecarOperatorExpressionsInSnapshot", "expressions"],
        ["compilerSidecarOperatorOperationsInSnapshot", "operations"]]) {
        assert.equal(queryCompilerModel(model, operation, { uri }, () => {}).complete, false);
        const result = queryCompilerModel(model, operation, { uri, targetSymbol: 2 }, () => {});
        assert.equal(result.complete, true);
        assert.equal(result[key].length, 2);
        assert.deepEqual(result[key][0].targetSymbols, [2]);
        assert.deepEqual([...result[key][1].targetSymbols].sort(), [1, 2],
            "filtering must not turn an ambiguous physical site into a selected reference");
        assert.deepEqual(queryCompilerModel(model, operation, { uri, targetSymbol: 3 }, () => {})[key], []);
        assert.equal(queryCompilerModel(model, operation, { uri, targetSymbol: 1 }, () => {}).complete, false,
            "the matching target's own reference budget remains enforced");
        for (const invalid of [0, -1, 1.5, NaN, Infinity, "2"]) {
            assert.throws(() => queryCompilerModel(model, operation, { uri, targetSymbol: invalid }, () => {}), /target symbol/i);
        }
    }
});

test("operator declaration lookup requires one physical native operator identity", () => {
    const { tokenize } = require("../lib/semantic-model");
    const uri = CompilerUri.file("/workspace/operator-declaration.bas");
    const text = "Type Operand\nvalue As Long\nEnd Type\nDeclare Operator +(ByRef value As Operand, ByVal amount As Long) As Long\n";
    const document = { uri, text, ...tokenize(text) };
    const position = pointAt(text, "+");
    const declaration = { symbol: 1, physical: true, kind: "procedure-prototype", filePath: uri.fsPath,
        startLine: 4, startColumn: 8, endLine: 4, endColumn: text.split("\n")[3].length };
    const rootUri = CompilerUri.file("/workspace/operator-root.bas");
    const rootText = '#include "operator-declaration.bas"\n';
    const root = { uri: rootUri, text: rootText, ...tokenize(rootText) };
    const model = { getDocument: (requested) => requested.fsPath === uri.fsPath ? document
        : requested.fsPath === rootUri.fsPath ? root : null, semanticDeclarations: [declaration],
        semanticBindingsAvailable: true, compilerSemanticModelSchemaVersion: 27,
        compilerProcedureKindsBySemanticIdentity: new Map([[1, "operator"], [2, "operator"]]) };
    const query = (point = position, kind = "procedure-prototype") => queryCompilerModel(model,
        "compilerSidecarOperatorDeclarationAt", { uri, position: point, kind }, () => {});
    assert.deepEqual(query()?.targetSymbols, [1]);
    const fromRoot = (origin) => queryCompilerModel(model, "compilerSidecarOperatorDeclarationAt", {
        uri: rootUri, position: { line: 0, character: 0 }, kind: "procedure-prototype", declarationOrigin: origin
    }, () => {});
    const origin = { filePath: uri.fsPath, startLine: 4, startColumn: position.character };
    assert.deepEqual(fromRoot(origin)?.targetSymbols, [1], "included declarations retain the root snapshot's context");
    assert.equal(fromRoot({ ...origin, filePath: "/workspace/not-in-this-snapshot.bi" }), null);
    assert.equal(fromRoot({ ...origin, startColumn: 9999 }), null);
    assert.throws(() => fromRoot({ ...origin, startLine: -1 }), /Invalid compiler operator declaration origin/);
    assert.deepEqual(query({ line: 3, character: 0 })?.targetSymbols, []);
    assert.deepEqual(query(position, "procedure-definition")?.targetSymbols, []);
    model.compilerProcedureKindsBySemanticIdentity.set(1, "function");
    assert.deepEqual(query()?.targetSymbols, []);
    model.compilerProcedureKindsBySemanticIdentity.set(1, null);
    assert.deepEqual(query()?.targetSymbols, [], "conflicting procedure kinds cannot identify an operator");
    model.compilerProcedureKindsBySemanticIdentity.set(1, "operator");
    declaration.physical = false;
    assert.deepEqual(query()?.targetSymbols, []);
    declaration.physical = true;
    model.semanticDeclarations.push({ ...declaration, symbol: 2 });
    assert.deepEqual(query()?.targetSymbols, [], "overlapping operator identities remain ambiguous");
    model.semanticDeclarations.pop();
    model.partial = true;
    assert.equal(query(), null);
});

test("native cursor context uses all preceding escape spans without exporting their table", () => {
    const { tokenize } = require("../lib/semantic-model");
    const { getCodeContext } = require("../lib/freebasic-parser");
    const uri = CompilerUri.file("/workspace/escape-context.bas");
    for (const bom of [0, 1]) {
        for (const literal of [String.raw`"inside \" Fake(99, 2)"`, String.raw`"inside \" /' still text"`]) {
            const text = `Print ${literal} : Work(1)\nWork 1, 2\n`;
            const ranges = [{ start: 0, end: text.indexOf(" :") },
                { start: text.indexOf("Work("), end: text.indexOf("\n") }];
            const document = { text, ...tokenize(text, null, ranges), defaultEscapedStringRanges: ranges };
            const model = Object.create(CompilerSemanticModel.prototype);
            model.getDocument = () => document;
            const offset = text.indexOf("Work(") + "Work(".length;
            assert.notEqual(getCodeContext(text, offset), "code", "source-only scanning must reproduce the bug");
            const context = queryCompilerModel(model, "compilerCodeContext", {
                uri, offset, offsetAdjustment: bom
            }, () => {});
            assert.equal(context.context, "code");
            assert.deepEqual(context.callContext, {
                name: "Work", openParenthesisOffset: offset - 1 + bom, activeParameter: 0
            });
            assert.deepEqual(context.signatureCallContext, context.callContext);
            assert.ok(context.maskedLinePrefix.endsWith(" : Work("));
            assert.equal(context.defaultEscapedStringRanges, undefined);
            const inside = model.compilerCodeContext(uri, text.indexOf("inside") + 2, bom);
            assert.deepEqual(inside, { context: "string" });
            const bare = model.compilerCodeContext(uri, text.indexOf("Work 1,") + "Work 1,".length, bom);
            assert.equal(bare.callContext, null);
            assert.deepEqual(bare.signatureCallContext, {
                name: "Work", openParenthesisOffset: text.indexOf("Work 1,") + 4 + bom,
                activeParameter: 1, bare: true
            });
            for (const invalid of [-1, 0.5, text.length + 1, NaN]) assert.equal(model.compilerCodeContext(uri, invalid), null);
            assert.equal(model.compilerCodeContext(uri, offset, 2), null);
        }
    }
});

test("native cursor context respects REM bindings and accepted option lines", () => {
    const { tokenize } = require("../lib/semantic-model");
    const uri = CompilerUri.file("/workspace/rem-context.bas");
    const text = "#if 1\nOption NoKeyword REM\n#endif\nPrint REM.value : Work(1)\nPrint \"REM.value\"\n' REM.value\n";
    const remOffset = text.indexOf("REM.value");
    for (const bom of [0, 1]) for (const accepted of [false, true]) {
        const model = Object.create(CompilerSemanticModel.prototype);
        const document = { text, ...tokenize(text, accepted ? [remOffset] : null) };
        model.getDocument = () => document;
        model.compilerRemIdentifierOffsets = () => accepted ? [remOffset] : [];
        model.compilerRemKeywordDisabledLineOffsets = () => accepted ? [text.indexOf("Option")] : [];
        for (const offset of [remOffset + 4, text.indexOf("Work(") + 5]) {
            const context = model.compilerCodeContext(uri, offset, bom);
            assert.equal(context.context, accepted ? "code" : "comment");
            if (accepted && offset > text.indexOf("Work(")) {
                assert.equal(context.signatureCallContext.name, "Work");
                assert.equal(context.signatureCallContext.openParenthesisOffset, text.indexOf("Work(") + 4 + bom);
            }
        }
        assert.equal(model.compilerCodeContext(uri, text.indexOf('"REM.value"') + 5, bom).context, "string");
        assert.equal(model.compilerCodeContext(uri, text.indexOf("' REM.value") + 7, bom).context, "comment");
    }
});

test("argument hint ranges handle bare calls and malformed delimiters", () => {
    const { tokenize } = require("../lib/semantic-model");
    const scan = (text, bare = true, remainingCharacters = 4096) => {
        const document = { text, ...tokenize(text) };
        const opening = bare ? { ...document.tokens[0], bare: true } : document.tokens[1];
        const result = freeBasicCallArgumentRanges(document, opening, () => {}, remainingCharacters);
        assert.ok(result, "malformed code must still return a scanner result");
        return { result, arguments: result.arguments?.map((argument) => argument && text.slice(argument.start, argument.end).trim()) };
    };
    for (const [text, expected] of [
        ['Target 1, "a,b", Nested(2, 3)', ['1', '"a,b"', 'Nested(2, 3)']],
        ['Target 1, _\n    "continued", _\n    3', ['1', '"continued"', '3']],
        ['Target _\r\n    1, 2\r\nOther 3, 4', ['1', '2']],
        ['Target 1, "text": Other 2, 3', ['1', '"text"']],
        ['Target 1, "text" Else Other 2, 3', ['1', '"text"']],
        ['Target "first" & Chr(65), ""', ['"first" & Chr(65)', '""']],
        ["Target 1, 2 ' comment, ignored\nOther 3", ['1', "2 ' comment, ignored"]],
        ['Target 1, 2\nOther 3, 4', ['1', '2']]
    ]) assert.deepEqual(scan(text).arguments, expected, text);
    assert.deepEqual(scan('Target("first" & Chr(65), "")', false).arguments, ['"first" & Chr(65)', '""']);
    for (const text of ['Target(1, [2))', 'Target(1, 2']) {
        assert.equal(scan(text, false).result.arguments, null, text);
    }
    assert.equal(scan('Target 1, [2)', true).result.arguments, null);
    assert.equal(scan('Target 1, 2', true, 3).result.exceeded, true);
    assert.equal(scan('Target ' + Array(256).fill('1').join(',')).arguments.length, 256);
    assert.equal(scan('Target ' + Array(257).fill('1').join(',')).result.exceeded, true);
});

test("parameter hint navigation rejects ambiguous and nonphysical source targets", () => {
    const uri = CompilerUri.file("/workspace/parameter-target.bas");
    const text = "Declare Sub Work(ByVal amount As Long)\nDeclare Sub Other(ByVal amount As Long)\n";
    const { createDocumentModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const source = createDocumentModel(uri, parseFreeBasicText(text));
    const parameters = source.entries.filter((entry) => entry.declaration.type === "parameter");
    const model = { getDocument: (target) => target.toString() === uri.toString() ? source : null };
    const location = { filePath: uri.fsPath, line: 0, startColumn: 23, endColumn: 29 };
    assert.deepEqual(compilerParameterDeclarationLocation(model, [parameters[0]], "amount"), location);
    assert.deepEqual(compilerParameterDeclarationLocation(model, [parameters[0], parameters[0]], "amount"), location);
    assert.equal(compilerParameterDeclarationLocation(model, parameters, "amount"), null);
    assert.equal(compilerParameterDeclarationLocation(model, [parameters[0]], "differentName"), null);
    assert.equal(compilerParameterDeclarationLocation(model, [{ ...parameters[0], provisional: true }], "amount"), null);
    assert.equal(compilerParameterDeclarationLocation(model, [{ ...parameters[0], uri: {
        scheme: "freebasic-preprocessed", toString: () => "freebasic-preprocessed:/generated.bas"
    } }], "amount"), null);
    assert.equal(compilerParameterDeclarationLocation(model, [{ ...parameters[0], declaration: {
        ...parameters[0].declaration, startColumn: 0, endColumn: 6
    } }], "amount"), null, "matching metadata must not link a token whose physical spelling disagrees");
});

test("destructor cleanup does not join coincident IDs without a source declaration", () => {
    const { createDocumentModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const uri = CompilerUri.file("/workspace/guarded-destructor.bas");
    const document = createDocumentModel(uri, parseFreeBasicText("Destructor Guarded()\nEnd Destructor\nDelete value\n"));
    const target = document.entries.find((entry) => entry.declaration.type === "destructor");
    target.compilerSymbolId = 42;
    const model = { expandedUri: uri, canonicalSymbolIds: new Map(), semanticSymbolNativeIds: new Map(),
        semanticProcedures: [], procedureBindings: [],
        semanticImplicitCalls: [{ kind: "delete-destructor", physical: true, filePath: uri.fsPath,
            startLine: 3, endLine: 3, startColumn: 0, endColumn: 12, target: 42 }],
        getDocument: () => document, resolveAt: () => [target],
        inner: { entries: [target], getDocument: () => document },
        projectPositions() { assert.fail("a coincident semantic/native number must not become a cleanup edge"); }
    };
    assert.deepEqual(queryCompilerModel(model, "callHierarchyIncoming", { uri, position: { line: 0, character: 0 } }, () => {}), []);
});

test("navigation serialization omits macro bodies at every result position", () => {
    const { createDocumentModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const uri = CompilerUri.file("/workspace/macros.bas");
    const document = createDocumentModel(uri, parseFreeBasicText("Print ScopedMacro\n"));
    const entries = Array.from({ length: 3 }, (_value, index) => ({
        id: `macro:${index}`, name: "ScopedMacro", qualifiedName: "Scope.ScopedMacro", uri,
        compilerPreprocessorId: index + 1,
        declaration: { name: "ScopedMacro", type: "macro", detail: "Macro", signature: "#define ScopedMacro value",
            line: index, startColumn: 8, endColumn: 19, modifiers: [], parameters: [],
            compilerMacroDefinition: "macro replacement text\n".repeat(4096) }
    }));
    const model = { getDocument: () => document, resolveAt: () => entries, declarationSources: (targets) => targets };
    const records = queryCompilerModel(model, "declaration", { uri, position: { line: 0, character: 8 } }, () => {});
    assert.equal(records.length, entries.length);
    assert.deepEqual(records.map((entry) => entry.qualifiedName), entries.map((entry) => entry.qualifiedName),
        "navigation identities must keep their existing qualified names");
    assert.ok(records.every((entry) => entry.declaration.compilerMacroDefinition === ""),
        "a result index must not enable macro previews in a navigation reply");
    assert.ok(Buffer.byteLength(JSON.stringify(records)) < 4096, "navigation should carry locations and signatures, not replacement bodies");
});

test("compact workspace replies preserve symbol fields and host dedupe keys", () => {
    const entries = [
        {
            name: "Value",
            type: "Variable",
            containerName: "Module",
            qualifiedName: "Module.Value",
            signature: "",
            deprecated: true,
            uri: { scheme: "file", fsPath: "/workspace/module.bas" },
            selection: { start: { line: 8, character: 4 }, end: { line: 8, character: 9 } }
        },
        {
            name: "ReadValue",
            type: "Function",
            containerName: "Module",
            qualifiedName: "Module.ReadValue",
            signature: "function Module.ReadValue() as double",
            deprecated: false,
            callableKind: "method",
            uri: { scheme: "file", fsPath: "/workspace/module.bas" },
            selection: { start: { line: 12, character: 8 }, end: { line: 12, character: 17 } }
        }
    ];
    const full = packWorkspaceSymbols(entries);
    const compact = compactWorkspaceEntries(full.entries, full.strings);
    const compactSymbols = mapPackedWorkspaceEntries(compact.entries, compact.strings);

    assert.ok(full.entries instanceof Int32Array);
    assert.ok(compact.entries instanceof Int32Array);
    assert.deepEqual(compactSymbols, entries);
    const namespaceProcedure = { ...entries[1], type: "Sub", callableKind: "function", deprecated: true };
    const namespacePacked = packWorkspaceSymbols([namespaceProcedure]);
    assert.deepEqual(mapPackedWorkspaceEntries(namespacePacked.entries, namespacePacked.strings), [namespaceProcedure]);
    for (const flags of [6, 8, -1]) {
        const invalid = full.entries.slice();
        invalid[12] = flags;
        assert.throws(() => mapPackedWorkspaceEntries(invalid, full.strings), /presentation flags/,
            "unknown or contradictory callable flags must not be published");
    }
    assert.deepEqual(mapPackedWorkspaceEntries(compact.entries, compact.strings, workspaceSymbolKeyFromPacked),
        mapPackedWorkspaceEntries(full.entries, full.strings, workspaceSymbolKeyFromPacked));
    assert.deepEqual(compactSymbols.map((entry) => workspaceSymbolKey(entry)),
        mapPackedWorkspaceEntries(compact.entries, compact.strings, workspaceSymbolKeyFromPacked));
    assert.ok(compact.strings.length <= full.strings.length);

    const streamed = packWorkspaceSymbols((function* () { yield* entries; })());
    assert.deepEqual([...streamed.entries], [...full.entries]);
    assert.deepEqual(streamed.strings, full.strings);
    assert.equal(streamed.hasExpandedSymbol, false);

    const chunkBoundary = packWorkspaceSymbols((function* () {
        for (let index = 0; index <= 8192; index++) yield {
            ...entries[0],
            name: `Value${index}`,
            qualifiedName: `Module.Value${index}`
        };
    })());
    assert.equal(chunkBoundary.entries.length, 8193 * WORKSPACE_SYMBOL_STRIDE);
    assert.equal(chunkBoundary.strings[chunkBoundary.entries[8192 * WORKSPACE_SYMBOL_STRIDE]], "Value8192");
});

test("workspace symbol pass expiration refreshes between module jobs", async (t) => {
    const workspace = new CompilerWorkspaceSymbols();
    t.after(() => workspace.clear());
    const { workspaceId } = workspace.begin(new Map(), "", 100);
    const firstExpiry = workspace.pass.expiresAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const active = workspace.active(workspaceId);
    assert.ok(active.expiresAt > firstExpiry, "Each completed module request should renew the idle lease.");
    active.expiresAt = Date.now() - 1;
    assert.throws(() => workspace.active(workspaceId), /pass has expired/);
});

test("workspace projection memory sampling is opt-in", async (t) => {
    const workspace = new CompilerWorkspaceSymbols();
    t.after(() => workspace.clear());
    const models = {
        models: new Map(),
        async prepare() {
            const snapshotId = "workspace-memory-snapshot";
            this.models.set(snapshotId, { model: { inventory: null }, sources: [] });
            return { snapshotId, text: "" };
        },
        remove(snapshotId) { this.models.delete(snapshotId); }
    };
    const options = {
        compilerPath: "fbc-editor",
        filePath: "/project/main.bas",
        compilerArguments: [],
        environment: undefined,
        allowErrors: true
    };

    const profiledPass = workspace.begin(new Map(), "", 10);
    const profiled = await workspace.index({ ...options, profileWorkspaceMemory: true },
        { id: profiledPass.workspaceId }, models, async () => {}, () => {});
    assert.ok(profiled.workspaceMemory.projection.workerHeapUsedBytes > 0);
    assert.ok(profiled.workspaceMemory.afterSearch.processRssBytes > 0);
    workspace.discard(profiledPass.workspaceId);

    const ordinaryPass = workspace.begin(new Map(), "", 10);
    const ordinary = await workspace.index(options, { id: ordinaryPass.workspaceId }, models, async () => {}, () => {});
    assert.equal(Object.hasOwn(ordinary, "workspaceMemory"), false,
        "normal workspace requests must not sample profiling data");
    workspace.discard(ordinaryPass.workspaceId);
});

test("workspace symbol caches and publication guards notice rebuilt compiler files", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-workspace-compiler-test-"));
    const workspace = new CompilerWorkspaceSymbols();
    t.after(() => { workspace.clear(); fs.rmSync(directory, { recursive: true, force: true }); });
    const compilerPath = path.join(directory, "compiler.exe");
    fs.writeFileSync(compilerPath, "first compiler", { mode: 0o755 });
    let calls = 0, changeDuringPreparation = false;
    const models = {
        models: new Map(),
        async prepare() {
            calls++;
            if (changeDuringPreparation) fs.appendFileSync(compilerPath, " changed during preparation");
            const snapshotId = `compiler-freshness-${calls}`;
            this.models.set(snapshotId, { model: { inventory: null }, sources: [] });
            return { snapshotId, text: "" };
        },
        remove(id) { this.models.delete(id); }
    };
    const options = { compilerPath, filePath: path.join(directory, "main.bas"), compilerArguments: [] };
    const index = async () => {
        const { workspaceId } = workspace.begin(new Map(), "", 10);
        const result = await workspace.index(options, { id: workspaceId }, models, async () => {}, () => {});
        workspace.finish(workspaceId, new Map(), () => {});
        return result;
    };
    assert.equal((await index()).cached, false);
    assert.equal((await index()).cached, true);
    assert.equal(calls, 1);
    fs.appendFileSync(compilerPath, " rebuilt");
    assert.equal((await index()).cached, false, "an unchanged filename must not reuse the previous compiler's symbols");
    assert.equal(calls, 2);
    const { workspaceId } = workspace.begin(new Map(), "", 10);
    assert.equal((await workspace.index(options, { id: workspaceId }, models, async () => {}, () => {})).cached, true);
    fs.appendFileSync(compilerPath, " changed before publication");
    assert.throws(() => workspace.finish(workspaceId, new Map(), () => {}), /Compiler executable changed/);
    changeDuringPreparation = true;
    const next = workspace.begin(new Map(), "", 10);
    await assert.rejects(workspace.index(options, { id: next.workspaceId }, models, async () => {}, () => {}),
        /Compiler executable changed/);
});

test("foreground worker idle barriers wait for queued work and honor cancellation", async (t) => {
    const worker = new CompilerAnalysisWorker(path.join(__dirname, "fixtures/compiler-worker.js"));
    t.after(() => worker.dispose());
    worker.active = { id: 1 };
    const waiting = worker.waitForIdle();
    worker.active = null;
    worker.dispatch();
    await waiting;

    worker.active = { id: 2 };
    const controller = new AbortController();
    const cancelled = worker.waitForIdle(controller.signal);
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    worker.active = null;
    worker.dispatch();
});

test("workspace symbol indexing uses bounded worker waves and stable context merging", async () => {
    let active = 0, maximumActive = 0;
    const indexedByWorker = [[], []];
    const workers = [0, 1].map((workerIndex) => ({
        async indexWorkspace(options, context) {
            assert.equal(context.id, `pass-${workerIndex}`);
            active++;
            maximumActive = Math.max(maximumActive, active);
            const jobIndex = Number(path.basename(options.filePath, ".bas").slice("job".length));
            indexedByWorker[workerIndex].push(jobIndex);
            await new Promise((resolve) => setTimeout(resolve, workerIndex === 0 ? 5 : 1));
            active--;
            const location = { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } };
            const shared = {
                name: "sharedSymbol",
                type: "Variable",
                signature: "",
                deprecated: jobIndex === 0,
                containerName: "",
                uri: { scheme: "file", fsPath: "/project/shared.bas" },
                selection: location
            };
            const unique = {
                ...shared,
                name: `jobSymbol${jobIndex}`,
                uri: { scheme: "file", fsPath: options.filePath }
            };
            return {
                cached: jobIndex === 0 || jobIndex === 3,
                expanded: null,
                entries: [shared, unique],
                resultBytes: 100 + jobIndex,
                workspaceMemory: {
                    projection: { workerHeapUsedBytes: 1000 + jobIndex, processRssBytes: 4000 + jobIndex },
                    afterSearch: { workerHeapUsedBytes: 2000 + jobIndex, processRssBytes: 5000 + jobIndex }
                }
            };
        }
    }));
    const jobs = Array.from({ length: 4 }, (_, index) => ({ filePath: `/project/job${index}.bas`, label: `context ${index}` }));
    const controller = new AbortController();

    const result = await indexWorkspaceJobs(
        workers,
        jobs,
        ["pass-0", "pass-1"],
        controller.signal,
        () => assert.equal(controller.signal.aborted, false),
        () => {},
        100
    );

    assert.equal(maximumActive, 2, "At most the dedicated workspace worker count should run at once.");
    assert.deepEqual(indexedByWorker, [[0, 2], [1, 3]], "Module-to-worker assignment must remain stable across queries.");
    assert.equal(result.indexed, 4);
    assert.equal(result.cached, 2);
    assert.equal(result.resultEntries, 8);
    assert.equal(result.resultBytes, 406);
    assert.equal(result.workspaceMemorySamples, 8);
    assert.deepEqual(result.maximumWorkspaceMemory, {
        projection: { workerHeapUsedBytes: 1003, processRssBytes: 4003 },
        afterSearch: { workerHeapUsedBytes: 2003, processRssBytes: 5003 }
    });
    assert.equal(result.maximumBatchResultEntries, 4);
    assert.equal(result.maximumBatchResultBytes, 205);
    assert.ok(Number.isFinite(result.maximumBatchMergeMs));
    assert.ok(result.totalBatchMergeMs >= result.maximumBatchMergeMs);
    assert.deepEqual([...result.results.values()].map((entry) => entry.name), ["sharedSymbol", "jobSymbol0", "jobSymbol1", "jobSymbol2", "jobSymbol3"]);
    assert.deepEqual([...result.results.values()][0].contexts, new Set(["context 0", "context 1", "context 2", "context 3"]));
    assert.equal([...result.results.values()][0].deprecated, false,
        "a symbol should not appear deprecated when any indexed build context disagrees");
    assert.equal([...result.results.values()].find((entry) => entry.name === "jobSymbol0")?.deprecated, true,
        "a unique symbol should preserve its compiler-selected deprecation status");
});

test("workspace symbol result limits bound extra parallel indexing to one wave", async () => {
    const started = [];
    const workers = [0, 1].map(() => ({
        async indexWorkspace(options) {
            const jobIndex = Number(path.basename(options.filePath, ".bas").slice("job".length));
            started.push(jobIndex);
            return {
                cached: false,
                expanded: null,
                entries: [{
                    name: `jobSymbol${jobIndex}`,
                    type: "Variable",
                    signature: "",
                    containerName: "",
                    uri: { scheme: "file", fsPath: options.filePath },
                    selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }
                }]
            };
        }
    }));
    const jobs = Array.from({ length: 6 }, (_, index) => ({ filePath: `/project/job${index}.bas`, label: `context ${index}` }));

    const result = await indexWorkspaceJobs(workers, jobs, ["pass-0", "pass-1"], undefined, () => {}, () => {}, 1);

    assert.deepEqual(started, [0, 1], "Only the active bounded wave may complete beyond the result limit.");
    assert.equal(result.indexed, 2);
    assert.deepEqual([...result.results.values()].map((entry) => entry.name), ["jobSymbol0"]);
});

test("workspace symbol waves yield to foreground analysis before scheduling more modules", async () => {
    const events = [];
    let hostTurnObserved = false;
    const hostTurn = new Promise((resolve) => setImmediate(() => {
        hostTurnObserved = true;
        events.push("host event-loop turn");
        resolve();
    }));
    const workers = [0, 1].map((workerIndex) => ({
        async indexWorkspace(options, context) {
            assert.equal(context.id, `pass-${workerIndex}`);
            const jobIndex = Number(path.basename(options.filePath, ".bas").slice("job".length));
            if (jobIndex >= 2) assert.equal(hostTurnObserved, true, "A later workspace wave must yield to the extension-host event loop.");
            events.push(`index ${jobIndex}`);
            return { cached: false, entries: [], expanded: null };
        }
    }));
    const jobs = Array.from({ length: 4 }, (_, index) => ({ filePath: `/project/job${index}.bas`, label: `context ${index}` }));

    const result = await indexWorkspaceJobs(
        workers,
        jobs,
        ["pass-0", "pass-1"],
        undefined,
        () => {},
        () => {},
        100,
        () => {},
        async () => { events.push("foreground idle gate"); }
    );

    await hostTurn;
    assert.equal(result.indexed, 4);
    assert.deepEqual(events, ["index 0", "index 1", "foreground idle gate", "host event-loop turn", "index 2", "index 3"]);
});

function setup(t, real = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-model-worker-test-"));
    const filePath = path.join(directory, "main.bas");
    fs.writeFileSync(filePath, "Dim modelValue As Long\nPrint modelValue\n");
    const worker = new CompilerAnalysisWorker(real ? undefined : path.join(__dirname, "fixtures/compiler-worker.js"));
    t.after(async () => { await worker.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
    const options = { compilerPath: real ? process.env.FBC_EDITOR_EXECUTABLE : process.execPath, filePath, allowErrors: true };
    const preparation = { requestedFile: filePath, expandedUri };
    const input = { uri: { scheme: "file", fsPath: filePath }, openFiles: [] };
    return { directory, filePath, worker, options, preparation, input };
}

for (const sidecar of [true, false]) test(`native folding retains physical active block boundaries (${sidecar ? "sidecar" : "bridge"})`, native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "blocks.bi");
    const header = "Type IncludedBlock\nnumber As Long\nEnd Type\n";
    const text = ['#include "blocks.bi"', "Sub Kept()", "#if 0", "End Sub", "#endif", "If 1 Then", "Print 1", "End If", "End Sub ' \u{1f600}", ""].join("\n");
    fs.writeFileSync(filePath, text);
    fs.writeFileSync(headerPath, header);
    const reply = await worker.analyze({ ...options, compilerPath: sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
        semanticModelOnly: sidecar, exportSemanticExpressions: true, exportSemanticBindings: false }, preparation);
    assert.equal(reply.partial, false);
    const folds = async (uri) => (await worker.query(reply.snapshotId, "compilerFoldingRanges", { ...input, uri })).result;
    assert.deepEqual(await folds(input.uri), [{ startLine: 1, endLine: 8 }, { startLine: 2, endLine: 4, kind: "region" }, { startLine: 5, endLine: 7 }],
        "the inactive END SUB must not close the real body, and header folds must not leak into the root");
    assert.deepEqual(await folds({ scheme: "file", fsPath: headerPath }), [{ startLine: 0, endLine: 2 }]);
    const blocks = async (uri, point) => (await worker.query(reply.snapshotId, "compilerSelectionRanges",
        { ...input, uri, positions: [point] })).result[0].filter((range) => range.kind === "block");
    assert.deepEqual(await blocks(input.uri, { line: 6, character: 2 }), [
        { start: { line: 5, character: 0 }, end: { line: 7, character: 6 }, kind: "block" },
        { start: { line: 1, character: 0 }, end: { line: 8, character: text.split("\n")[8].length }, kind: "block" }
    ], "selection parents use the active block and UTF-16 closing-line length");
    assert.deepEqual(await blocks(input.uri, { line: 0, character: 2 }), [], "header blocks cannot become root selection parents");
    assert.deepEqual(await blocks({ scheme: "file", fsPath: headerPath }, { line: 1, character: 2 }), [
        { start: { line: 0, character: 0 }, end: { line: 2, character: 8 }, kind: "block" }
    ]);
    assert.equal(fs.readFileSync(filePath, "utf8"), text);
    assert.equal(fs.readFileSync(headerPath, "utf8"), header);
});

test("editor bridge retains native assistance after conditional escaped literals", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const text = String.raw`#lang "fblite"
#if 1
Option Escape
#endif
#define EscapeValue 1
Declare Sub Work(ByVal amount As Long)
Print "inside \" Fake(99, 2)" : Work(1)
Print "inside \" /' still text" : Print EscapeValue
`;
    const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
        exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    try {
        assert.equal(reply.partial, false);
        const position = pointAt(text, " : Work(", " : Work(".length);
        const signature = (await worker.query(reply.snapshotId, "signature", { ...input, position })).result;
        assert.equal(signature?.context.name, "Work");
        assert.equal(signature.context.activeParameter, 0);
        assert.ok(signature.entries.some((entry) => entry.name === "Work"));
        const completion = (await worker.query(reply.snapshotId, "completion", {
            ...input, position: pointAt(text, " : Print EscapeValue", " : Print EscapeVa".length), limit: 100
        })).result;
        assert.ok(completion.entries.some((entry) => entry.name === "EscapeValue"));
        const inside = pointAt(text, "Fake(99,", "Fake(".length);
        assert.equal((await worker.query(reply.snapshotId, "signature", { ...input, position: inside })).result, null);
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native cursor assistance survives conditional NOKEYWORD REM", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const text = ['#lang "fblite"', "#if 1", "Option NoKeyword REM", "#endif", "Type KeywordPayload",
        "    value As Long", "End Type", "Declare Sub Work(ByVal amount As Long, ByVal scale As Long)",
        "Dim REM As KeywordPayload", "Print REM.value", "Work(REM.value, 2)", "Work REM.value, 2",
        'Print "REM.value Work(1, 2)"', "' REM.value Work(1, 2)", ""].join("\n");
    fs.writeFileSync(filePath, text);
    for (const semanticModelOnly of [true, false]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: semanticModelOnly ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            semanticModelOnly, exportSemanticExpressions: true, exportSemanticBindings: true,
            ...(semanticModelOnly ? {} : { overlays: new Map([[filePath, text + "' unsaved overlay\n"]]) })
        }, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            const completionPosition = pointAt(text, "Print REM.value", "Print REM.v".length);
            const offset = text.indexOf("Print REM.value") + "Print REM.v".length;
            const context = (await worker.query(reply.snapshotId, "compilerCodeContext", { ...input, offset })).result;
            assert.equal(context.context, "code");
            assert.equal(context.maskedLinePrefix, "Print REM.v");
            const completion = (await worker.query(reply.snapshotId, "completion", {
                ...input, position: completionPosition, limit: 100
            })).result;
            assert.equal(completion.member, true, "stock member contexts must reach the provider's native type lookup");
            if (!semanticModelOnly) assert.ok(completion.entries.some((entry) => entry.name === "value"));
            for (const call of ["Work(REM.value,", "Work REM.value,"]) {
                const position = pointAt(text, call, call.length);
                const signature = (await worker.query(reply.snapshotId, "signature", { ...input, position })).result;
                assert.equal(signature?.context.name, "Work");
                assert.equal(signature.context.activeParameter, 1);
                assert.ok(signature.entries.some((entry) => entry.name === "Work"));
                if (semanticModelOnly) assert.ok(signature.selectedSidecarDeclarations?.length);
            }
            for (const spelling of ['"REM.value Work(', "' REM.value Work("]) {
                const position = pointAt(text, spelling, spelling.length);
                assert.equal((await worker.query(reply.snapshotId, "signature", { ...input, position })).result, null);
            }
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
    const incomplete = text.replace("Print REM.value", "Print REM.v").replace("Work(REM.value, 2)", "Work(REM.value, )");
    const recovered = await worker.analyze({ ...options, exportSemanticExpressions: true, exportSemanticBindings: true,
        overlays: new Map([[filePath, incomplete]]) }, preparation);
    try {
        assert.equal(recovered.partial, true);
        const completion = (await worker.query(recovered.snapshotId, "completion", {
            ...input, position: pointAt(incomplete, "Print REM.v", "Print REM.v".length), limit: 100
        })).result;
        assert.ok(completion.entries.some((entry) => entry.name === "value"), "an unfinished native REM receiver must retain its members");
        const definition = (await worker.query(recovered.snapshotId, "definition", {
            ...input, position: pointAt(incomplete, "Print REM.v", "Print REM.".length)
        })).result;
        assert.deepEqual(definition, [], "completion recovery must not bind the unfinished field name");
        const call = "Work(REM.value,";
        const signature = (await worker.query(recovered.snapshotId, "signature", {
            ...input, position: pointAt(incomplete, call, call.length)
        })).result;
        assert.equal(signature?.context.activeParameter, 1);
        assert.ok(signature.entries.some((entry) => entry.name === "Work"));
    } finally {
        worker.releaseModel(recovered.snapshotId);
    }
});

test("native disabled-keyword procedures retain bare-call and recovery signatures", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const prefix = ['#lang "fblite"', "#if 1", "Option NoKeyword IF", "#endif"];
    for (const [semanticModelOnly, bindings] of [[true, true], [false, true], [false, false]]) {
        const declaration = semanticModelOnly ? ["Declare Sub IF(ByVal amount As Long, ByVal scale As Double)"]
            : ["#macro EmitProcedure(procName)", "Declare Sub procName(ByVal amount As Long, ByVal scale As Double)",
                "#endmacro", "EmitProcedure(IF)"];
        const text = [...prefix, ...declaration, "IF 1, 2", "IF(1, 2)", "IF 1, _", "    2", ""].join("\n");
        fs.writeFileSync(filePath, text);
        const settings = { ...options, compilerPath: semanticModelOnly ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            semanticModelOnly, exportSemanticExpressions: true, exportSemanticBindings: bindings };
        const reply = await worker.analyze(settings, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            for (const spelling of ["IF 1,", "IF(1,", "IF 1, _"]) {
                const position = pointAt(text, spelling, spelling.indexOf(",") + 1);
                const offset = text.indexOf(spelling) + spelling.indexOf(",") + 1;
                const context = (await worker.query(reply.snapshotId, "compilerCodeContext", { ...input, offset })).result;
                assert.equal(context.context, "code");
                assert.equal(context.signatureCallContext.name, "IF");
                const result = (await worker.query(reply.snapshotId, "signature", { ...input, position })).result;
                assert.equal(result?.entries.length, 1, spelling);
                assert.equal(result.context.activeParameter, 1);
                assert.equal(result.entries[0].declaration.parameters.length, 2);
            }
        } finally { worker.releaseModel(reply.snapshotId); }
        if (semanticModelOnly) continue;
        const incomplete = text.replace("IF 1, 2", "IF 1,");
        const recovered = await worker.analyze({ ...settings, overlays: new Map([[filePath, incomplete]]) }, preparation);
        try {
            assert.equal(recovered.partial, true);
            const result = (await worker.query(recovered.snapshotId, "signature", {
                ...input, position: pointAt(incomplete, "IF 1,", "IF 1,".length)
            })).result;
            assert.equal(result?.entries.length, 1);
            assert.equal(result.context.activeParameter, 1);
        } finally { worker.releaseModel(recovered.snapshotId); }
    }
});

test("native signatures retain builtin-shadowing array identities", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const text = ['#lang "fblite"', "Option NoKeyword Abs", "#ifdef FUNCTION_BUILD",
        "Declare Function Abs Overload(ByVal amount As Long) As Long",
        "Declare Function Abs Overload(ByVal amount As Double) As Double", "#else",
        "Dim Abs(2) As Long", "#endif", "Print Abs(0)", "Print Sin(0.5)", ""].join("\n");
    fs.writeFileSync(filePath, text);
    for (const [semanticModelOnly, bindings] of [[true, true], [false, true], [false, false]]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: semanticModelOnly ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            semanticModelOnly, exportSemanticExpressions: true, exportSemanticBindings: bindings }, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, "Print Abs(0)", "Print Abs(".length)
            })).result;
            assert.match(result?.arraySignature?.signature || "", /^Array Abs\(index1(?:: 0 To 2)?\)$/i);
            assert.equal(result?.entries.length, 0, "array help must not retain inactive procedure candidates");
            assert.equal(result.selectedCompilerSymbolId || 0, 0, "an array identity is not a selected procedure target");
            const builtin = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, "Print Sin(0.5)", "Print Sin(".length)
            })).result;
            assert.equal(builtin?.entries.length || 0, 0, "unbound intrinsic spellings may use reference signatures");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    const scalar = '#lang "fblite"\nOption NoKeyword Abs\nSub Work()\nDim Abs As Long\nPrint Abs(1)\nEnd Sub\n';
    const recovered = await worker.analyze({ ...options, overlays: new Map([[filePath, scalar]]),
        exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    try {
        assert.equal(recovered.partial, true);
        const result = (await worker.query(recovered.snapshotId, "signature", {
            ...input, position: pointAt(scalar, "Print Abs(1)", "Print Abs(".length)
        })).result;
        assert.ok(result?.entries.some((entry) => entry.declaration.type === "variable" && entry.name.toLowerCase() === "abs"),
            "a valid local declaration must still shadow builtin help in a failed call");
    } finally { worker.releaseModel(recovered.snapshotId); }
});

test("native conditional callbacks retain callable types instead of procedure guesses", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["#ifdef PROCEDURE_BUILD",
        "Declare Function Choose Overload(ByVal amount As Long) As Long",
        "Declare Function Choose Overload(ByVal amount As Double) As Double", "#else",
        "Dim Choose As Function(ByVal amount As Long) As Double", "#endif", "Print Choose(1)", ""].join("\n");
    fs.writeFileSync(filePath, text);
    for (const [semanticModelOnly, bindings] of [[true, true], [false, true], [false, false]]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: semanticModelOnly ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            semanticModelOnly, exportSemanticExpressions: true, exportSemanticBindings: bindings }, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, "Print Choose(1)", "Print Choose(".length)
            })).result;
            assert.equal(result?.procedurePointerSignature.signature, "Function Choose(as long) as double");
            assert.equal(result.procedurePointerSignature.parameters.length, 1);
            assert.equal(result.selectedCompilerSymbolId || 0, 0, "a callable type does not select a runtime procedure");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("stock binding hover distinguishes physical scalars from macro spellings", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["Namespace Storage", "Dim Shared amount As Long", "End Namespace", "Dim ordinary As Long",
        "#define amount() Storage.amount", "#define forwarded Storage.amount", "Print ordinary", "Print amount()", "Print forwarded", ""].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true, allowErrors: false, exportSemanticExpressions: true, exportSemanticBindings: true,
        exportSemanticMacroBindings: false }, preparation);
    try {
        assert.equal(reply.partial, false);
        for (const name of ["ordinary", "amount", "forwarded"]) {
            const result = (await worker.query(reply.snapshotId, "hover", {
                ...input, position: pointAt(text, "Print " + name, "Print ".length + 1)
            })).result;
            const entries = result.entries || [];
            const scalar = entries.length === 1 && ["variable", "field", "parameter"].includes(entries[0].declaration.type) &&
                entries[0].compilerSymbolId > 0 && !entries[0].compilerPreprocessorId &&
                entries[0].name.toLowerCase() === result.occurrence?.name.toLowerCase() &&
                !result.macroSignature && !result.deferredMacroReference;
            assert.equal(scalar, name === "ordinary", name + ": " + JSON.stringify(result));
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock native hover bindings distinguish conditional procedures from a scalar", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["#ifdef PROCEDURE_BUILD",
        "Declare Function Chosen Overload(ByVal amount As Long) As Long",
        "Declare Function Chosen Overload(ByVal amount As Double) As Double", "#else",
        "Dim Chosen As Long", "#endif", "Print Chosen", ""].join("\n");
    fs.writeFileSync(filePath, text);
    for (const bindings of [false, true]) {
        const reply = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
            semanticModelOnly: true, exportSemanticExpressions: true, exportSemanticBindings: bindings }, preparation);
        try {
            assert.equal(reply.partial, false);
            const result = (await worker.query(reply.snapshotId, "hover", {
                ...input, position: pointAt(text, "Print Chosen", "Print C".length)
            })).result;
            assert.equal(result.expression.typeName.toLowerCase(), "long");
            if (bindings) {
                assert.equal(result.entries.length, 1);
                assert.equal(result.entries[0].declaration.type, "variable");
                assert.equal(result.entries[0].declaration.line, 4);
            } else assert.equal(result.entries.length, 0, "expression type alone does not settle the source symbol's kind");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("stock type slots select the compiler-bound conditional declaration", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["#ifdef FIRST_TYPE", "Type BranchType", "firstValue As Long", "End Type", "#else",
        "Type BranchType", "secondValue As Double", "End Type", "#endif", "Dim selected As BranchType", ""].join("\n");
    fs.writeFileSync(filePath, text);
    for (const first of [false, true]) {
        const reply = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE, semanticModelOnly: true,
            compilerArguments: first ? ["-d", "FIRST_TYPE"] : [], exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false);
            const result = (await worker.query(reply.snapshotId, "completion", { ...input,
                position: pointAt(text, "Dim selected As BranchType", "Dim selected As Bran".length), typeCompletionContext: "type"
            })).result;
            const types = result.entries.filter((entry) => entry.name === "BranchType");
            assert.equal(types.length, 1, "conditional type names need the compiler's declaration selection");
            assert.equal(types[0].declaration.line, first ? 1 : 5);
            assert.ok(types[0].compilerSymbolId > 0);
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("stock type cache follows include visibility when moving within one snapshot", native, async (t) => {
    const { worker, directory, filePath, options, preparation, input } = setup(t, true);
    fs.writeFileSync(path.join(directory, "types.bi"), "Type HeaderType\nvalue As Long\nEnd Type\n");
    const text = ["Type RootType", "value As Long", "End Type", "Dim beforeInclude As RootType",
        '#include "types.bi"', "Dim afterInclude As HeaderType", ""].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE, semanticModelOnly: true,
        exportSemanticBindings: true }, preparation);
    try {
        assert.equal(reply.partial, false);
        for (const after of [true, false, true]) {
            const spelling = after ? "Dim afterInclude As HeaderType" : "Dim beforeInclude As RootType";
            const prefix = after ? "Dim afterInclude As " : "Dim beforeInclude As ";
            const result = (await worker.query(reply.snapshotId, "completion", { ...input,
                position: pointAt(text, spelling, prefix.length), typeCompletionContext: "type"
            })).result;
            assert.equal(result.entries.some((entry) => entry.name === "HeaderType"), after,
                "cached source scopes must reflect the include boundary at this cursor");
            assert.ok(result.entries.some((entry) => entry.name === "RootType"));
        }
    } finally { worker.releaseModel(reply.snapshotId); }
});

test("stock type completion uses native declaration bindings for disabled-keyword names", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/stock-type-completions.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    for (const sidecar of [true, false]) {
        const reply = await worker.analyze({ ...options, compilerPath: sidecar ? process.env.FBC_EXECUTABLE : options.compilerPath,
            semanticModelOnly: sidecar, exportSemanticBindings: true, exportSemanticExpressions: false }, preparation);
        try {
            assert.equal(reply.partial, false);
            for (const [spelling, prefix, name, type] of [
                ["Dim directValue As REM", "Dim directValue As RE", "REM", "type"],
                ["Dim aliasValue As IF", "Dim aliasValue As IF", "IF", "type"],
                ["Dim enumValue As WHILE", "Dim enumValue As WH", "WHILE", "enum"],
                ["Dim qualifiedValue As PRINT.Payload", "Dim qualifiedValue As PR", "PRINT", "namespace"],
                ["Dim qualifiedValue As PRINT.Payload", "Dim qualifiedValue As PRINT.", "Payload", "type"],
                ["Dim qualifiedValue As PRINT.Payload", "Dim qualifiedValue As PRINT.Pay", "Payload", "type"]
            ]) {
                const result = (await worker.query(reply.snapshotId, "completion", { ...input,
                    position: pointAt(text, spelling, prefix.length), typeCompletionContext: "type"
                })).result;
                const entry = result.entries.find((entry) => entry.name === name);
                assert.ok(entry, `${sidecar ? "stock" : "bridge"}: ${spelling}: ${prefix}`);
                assert.equal(entry.declaration.type, type);
                assert.ok(Number.isSafeInteger(entry.compilerSymbolId) && entry.compilerSymbolId > 0,
                    "type candidates must retain native declaration identity");
                assert.equal(entry.constructorCallParameters, undefined);
            }
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    const weak = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE, semanticModelOnly: true,
        exportSemanticBindings: false, exportSemanticExpressions: true }, preparation);
    try {
        const result = (await worker.query(weak.snapshotId, "completion", { ...input,
            position: pointAt(text, "Dim directValue As REM", "Dim directValue As RE".length), typeCompletionContext: "type"
        })).result;
        assert.ok(!result.entries.some((entry) => entry.name === "REM"), "source spelling alone must not create native type candidates");
    } finally { worker.releaseModel(weak.snapshotId); }
});

test("native type completion contexts preserve expression boundaries and namespace prefixes", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/type-completions.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    for (const sidecar of [true, false]) {
        const reply = await worker.analyze({ ...options, semanticModelOnly: sidecar,
            compilerPath: sidecar ? process.env.FBC_EXECUTABLE : options.compilerPath,
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false);
            for (const [spelling, prefix, expected] of [
                ["Dim selected As SampleType", "Dim selected As S", "type"],
                ["Dim qualified As TypeSpace.SampleAlias", "Dim qualified As TypeSpace.Sam", "type"],
                ["Dim continued As _\n    SampleAlias", "Dim continued As _\n    Samp", "type"],
                ["Type DerivedType Extends Object", "Type DerivedType Extends Ob", "base"],
                ["Typeof(ordinaryValue)", "Typeof(ordinaryVa", null],
                ["String * lengthValue", "String * lengthVa", null],
                ["Long = BuildValue(1)", "Long = BuildVa", null]
            ]) {
                const result = (await worker.query(reply.snapshotId, "compilerCodeContext", {
                    ...input, offset: text.indexOf(spelling) + prefix.length
                })).result;
                assert.equal(result.typeCompletionContext, expected, `${sidecar ? "stock" : "bridge"}: ${spelling}`);
            }
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    input.openFiles = [filePath];
    for (const [statement, suffix, expected] of [
        ["Dim unfinished As TypeSpace.Samp", "Samp", "SampleType"],
        ["Dim unfinished As TypeSpace.Nested.Inn", "Inn", "InnerType"],
        ["Sub Shadow()\nDim SampleType As Long\nPrint SampleType.Samp\nEnd Sub", "Samp", null],
        ["Print BuildValue(1).Samp", "Samp", null]
    ]) {
        const partial = text + "\n" + statement;
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, partial]]),
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, true);
            const offset = partial.lastIndexOf(suffix) + suffix.length;
            const position = pointAt(partial, statement, offset - partial.indexOf(statement));
            const result = (await worker.query(reply.snapshotId, "completion", { ...input, position })).result;
            assert.ok(result.member);
            if (expected) assert.ok(result.entries.some((entry) => entry.name === expected),
                "native namespace types should survive an unfinished type name: " + statement);
            else assert.deepEqual(result.entries, [], "failed value receivers must not become static owners: " + statement);
            const definition = (await worker.query(reply.snapshotId, "definition", { ...input, position })).result;
            assert.deepEqual(definition, [], "completion candidates must not bind the unfinished suffix");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("native array index signatures retain compiler bounds and dimension roles", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/array-index-signatures.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    for (const [sidecar, bindings] of [[true, true], [false, true], [false, false]]) {
        const reply = await worker.analyze({ ...options, semanticModelOnly: sidecar,
            compilerPath: sidecar ? process.env.FBC_EXECUTABLE : options.compilerPath,
            exportSemanticExpressions: true, exportSemanticBindings: bindings }, preparation);
        try {
            assert.equal(reply.partial, false);
            for (const [spelling, prefix, parameters, first] of [
                ["matrix(0, 2)", "matrix(0,", 2, "index1: -1 To 4"],
                ["holder.values(0)", "holder.values(", 1, "index1: -2 To 2"],
                ["GetHolder().values(0)", "GetHolder().values(", 1, "index1: -2 To 2"],
                ["holders(0).values(0)", "holders(0).values(", 1, "index1: -2 To 2"],
                ["(*holderPointer).values(0)", "(*holderPointer).values(", 1, "index1: -2 To 2"],
                ["GetHolder().callbacks(0)(1)", "GetHolder().callbacks(", 1, "index1: -1 To 1"],
                ["dynamicValues(0, 2)", "dynamicValues(0,", 2, "index1"],
                ["Print values(0, 2)", "Print values(0,", 1, "indices..."]
            ]) {
                const result = (await worker.query(reply.snapshotId, "signature", {
                    ...input, position: pointAt(text, spelling, prefix.length)
                })).result;
                const signature = result?.arraySignature;
                assert.ok(signature, `${sidecar ? "stock" : "bridge"}: ${spelling}`);
                assert.equal(signature.kind, "array");
                assert.equal(signature.parameters.length, parameters);
                assert.equal(signature.parameters[0].label, !bindings && first.includes(":") ? "index1" : first);
                for (const parameter of signature.parameters) assert.equal(
                    signature.signature.slice(...parameter.labelOffsets), parameter.label);
                assert.equal(result.selectedCompilerSymbolId, undefined, "array indexing must not select a procedure");
                assert.equal(result.procedurePointerSignature, undefined);
            }
            const callback = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(text, "GetHolder().callbacks(0)(1)", "GetHolder().callbacks(0)(".length) })).result;
            assert.equal(callback?.arraySignature, undefined, "the second argument list invokes the array element");
            assert.equal(callback.procedurePointerSignature?.parameters.length, 1);
            assert.match(callback.procedurePointerSignature.parameters[0].label, /\bas long\b/i);
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("bridge compound array field signatures survive incomplete arguments", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const prefix = fs.readFileSync(path.join(__dirname, "fixtures/array-index-signatures.bas"), "utf8");
    fs.writeFileSync(filePath, prefix);
    input.openFiles = [filePath];
    for (const statement of ["Print GetHolder().values(", "Print holders(0).values(",
        "Print (*holderPointer).values(", "Print GetHolder().callbacks(", "Print unknownHolder.values("]) {
        const text = prefix + statement;
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: false }, preparation);
        try {
            assert.equal(reply.partial, true);
            const position = { line: prefix.split("\n").length - 1, character: statement.length };
            const result = (await worker.query(reply.snapshotId, "signature", { ...input, position })).result;
            if (statement.includes("unknownHolder")) {
                assert.equal(result?.arraySignature, undefined, "a matching member spelling cannot supply the receiver's type");
            } else {
                assert.equal(result?.arraySignature?.parameters.length, 1, statement);
                assert.match(result.arraySignature.signature, /^Array (?:values|callbacks)\(/);
            }
            assert.equal(result?.procedurePointerSignature, undefined, "the first argument list indexes the array");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), prefix, "signature queries must not save unfinished buffers");
});

test("native procedure pointer signatures cover values, aliases, fields, and parameters", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/procedure-pointer-signatures.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    for (const sidecar of [true, false]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: sidecar ? process.env.FBC_EXECUTABLE || path.join(resolveFreeBasicRoot(), "bin", "fbc") : options.compilerPath,
            semanticModelOnly: sidecar, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false);
            for (const spelling of ["injected(1,", "callback(1,", "inferred(1,", "produced(1,", "handlersValue.invoke(1,",
                "callbackArray(0)(1,", "callbackValues(0)(1,", "GetCallback(1)(1,", "(*callbackPointer)(1,", "(callback)(1,"]) {
                const result = (await worker.query(reply.snapshotId, "signature", {
                    ...input, position: pointAt(text, spelling, spelling.length)
                })).result;
                assert.ok(result?.procedurePointerSignature, (sidecar ? "stock " : "bridge ") + spelling);
                assert.equal(result.arraySignature, undefined, "a callback invocation is not array indexing");
                assert.equal(result.context.activeParameter, 1);
                assert.equal(result.procedurePointerSignature.parameters.length, 2);
                assert.match(result.procedurePointerSignature.parameters[0].label, /\bas long\b/i);
                assert.match(result.procedurePointerSignature.parameters[1].label, /\bas double\b/i);
                assert.equal(result.selectedCompilerSymbolId, undefined, "a callable type is not a runtime target");
            }
            const factory = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, "GetCallback(1)", "GetCallback(".length)
            })).result;
            assert.equal(factory.procedurePointerSignature, undefined, "a factory's return type is not its own parameter list");
            assert.equal(factory.entries[0].declaration.parameters.length, 1);
            for (const name of ["callbackArray", "callbackValues"]) {
                const array = (await worker.query(reply.snapshotId, "signature", {
                    ...input, position: pointAt(text, `Print ${name}(0)`, `Print ${name}(`.length)
                })).result;
                assert.equal(array?.procedurePointerSignature, undefined, "array indexing is not a callback invocation: " + name);
            }
            const action = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, "action(resultValue)", "action(".length)
            })).result;
            assert.match(action?.procedurePointerSignature?.signature || "", /^Sub action\(byref as long\)$/i);
            assert.equal(action.context.activeParameter, 0);
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("editor bridge retains procedure pointer signatures while arguments are incomplete", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const prefix = ["Declare Function Compute(ByVal value As Long, ByVal scale As Double) As Double",
        "Dim callback As Function(ByVal value As Long, ByVal scale As Double) As Double = @Compute", ""].join("\n");
    for (const statement of ["Print callback(1, )", "Print callback(1,"]) {
        const text = prefix + statement + "\n";
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: false, exportSemanticBindings: false }, preparation);
        try {
            assert.equal(reply.partial, true);
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, statement, statement.indexOf(",") + 1)
            })).result;
            assert.equal(result?.procedurePointerSignature?.parameters.length, 2, statement);
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("bridge compound callback signatures retain native declared types during incomplete calls", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const original = fs.readFileSync(path.join(__dirname, "fixtures/procedure-pointer-signatures.bas"), "utf8");
    for (const [complete, statement] of [
        ["Print callbackArray(0)(1, 2)", "Print callbackArray(0)(1, )"],
        ["Print callbackArray(0)(1, 2)", "Print callbackArray(0)(1,"],
        ["Print callbackValues(0)(1, 2)", "Print callbackValues(0)(1, )"],
        ["Print GetCallback(1)(1, 2)", "Print GetCallback(1)(1, )"],
        ["Print (*callbackPointer)(1, 2)", "Print (*callbackPointer)(1, )"],
        ["Print (callback)(1, 2)", "Print (callback)(1, )"]
    ]) {
        const text = original.replace(complete, statement);
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, true, statement);
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, statement, statement.lastIndexOf(",") + 1)
            })).result;
            assert.equal(result?.context.expressionCallee, true, statement);
            assert.equal(result?.procedurePointerSignature?.parameters.length, 2, statement);
            assert.equal(result.context.activeParameter, 1);
            assert.equal(result.selectedCompilerSymbolId, undefined, "recovery must not invent an indirect runtime target");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    for (const statement of ["Print callbackArray()(1, )", "Print callbackArray(0, 1)(1, )",
        "Print Compute(1, 2)(1, )", "Print (callbackPointer)(1, )", "Print (resultValue)(1, )"]) {
        const text = original.replace("Print callbackArray(0)(1, 2)", statement);
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, statement, statement.lastIndexOf(",") + 1)
            })).result;
            assert.equal(result?.procedurePointerSignature, undefined, "do not invent a callable element or dereference: " + statement);
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("public recovered members keep access and producer guards without a reliable caller scope", () => {
    const { tokenize } = require("../lib/semantic-model");
    const uri = CompilerUri.file("/workspace/unclosed-members.bas");
    const text = ".Mea", lexical = tokenize(text);
    const document = { ...lexical, text, uri, byLine: new Map([[0, lexical.tokens]]),
        root: { start: 0, end: text.length, children: [], recovered: true, symbol: 1 } };
    // These are the inspected ABI's two restricted class-member attribute bits.
    const entries = [["PublicMethod", 0], ["PrivateMethod", 0x200000], ["ProtectedMethod", 0x400000]]
        .map(([name, attributes]) => ({ id: name, name, provisional: false,
            declaration: { provisional: false }, nativeSymbol: { attributes, owner: 1 } }));
    for (const [version, provisional] of [["1.20.5", false], ["1.21.0", false], ["", false], ["1.20.5", true]]) {
        const model = { inventory: {}, compilerSemanticModelCompilerVersion: version,
            getDocument: () => document, inner: { getDocument: () => document },
            projectPositions: () => [], recoveredMemberCompletion: CompilerSemanticModel.prototype.recoveredMemberCompletion,
            recoverySourceToExpanded: new Map([[`${uri}:0`, [lexical.tokens[0]]], [`${uri}:1`, [lexical.tokens[1]]]]),
            recoveryCompletionReceivers: new Map([[1, [{ dtype: 22, subtype: 1, typeName: "Service", start: { line: 0, character: 1 } }]]]),
            commonProjectedEntries: (positions, query) => positions.flatMap(query),
            nativeTypeEntries: () => [{ provisional, declaration: { provisional } }], nativeMembers: () => entries,
            nativeAccess: CompilerSemanticModel.prototype.nativeAccess,
            nativeSymbols: new Map([[1, { id: 1, symbolClass: 10, owner: 0 }]]), canonicalSymbolIds: new Map() };
        const complete = (allowPublicRecovery) => CompilerSemanticModel.prototype.completeMembers.call(model, uri, 0, text.length, allowPublicRecovery);
        assert.deepEqual(complete(false), [], "ordinary scope-dependent lookup must remain closed");
        assert.deepEqual(complete(true).map((entry) => entry.name), version === "1.20.5" && !provisional ? ["PublicMethod"] : [],
            "only concrete public members from the known producer can survive caller-scope uncertainty");
    }
});

test("callback field signature recovery rejects provisional members and unknown producers", () => {
    const { createDocumentModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const uri = CompilerUri.file("/workspace/recovered-callback-field.bas");
    const text = "Print MakeHolder().invoke(1,";
    const document = createDocumentModel(uri, parseFreeBasicText(text));
    for (const mode of ["valid", "entry", "declaration", "producer", "array", "pointer"]) {
        const entry = { key: "invoke", provisional: mode === "entry",
            declaration: { type: "field", provisional: mode === "declaration" },
            nativeSymbol: { id: 1, typeName: mode === "pointer" ? "typeof(function(as long, as double) as double) ptr"
                : "function(as long, as double) as double" } };
        const model = { partial: true, semanticSidecarOnly: false,
            inventory: { shapes: new Map([[1, { dimensions: mode === "array" ? 1 : 0 }]]) },
            compilerSemanticModelCompilerVersion: mode === "producer" ? "1.21.0" : "1.20.5",
            getDocument: () => document, resolveAt: () => [], compilerSelectionRanges: () => [], completeMembers: () => [entry] };
        const result = queryCompilerModel(model, "signature", { uri, position: { line: 0, character: text.length } }, () => {});
        assert.equal(result.arraySignature?.parameters.length, mode === "array" ? 1 : undefined, mode);
        assert.equal(result.procedurePointerSignature?.parameters.length, mode === "valid" ? 2 : undefined, mode);
        assert.equal(result.selectedCompilerSymbolId, undefined);
    }
});

test("callback recovery follows canonical types when private datatype numbers shift", () => {
    const { createDocumentModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const uri = CompilerUri.file("/workspace/callback-datatype-layout.bas");
    const text = "Print MakeCallback()(1,";
    const document = createDocumentModel(uri, parseFreeBasicText(text));
    for (const [datatype, typeName, version, expected] of [
        [22, "function(as long, as double) as double", "1.20.5", 2],
        [24, "function(as long, as double) as double", "1.20.5", 2],
        [22, "Widget ptr", "1.20.5", undefined],
        [16, "uinteger<128> ptr", "1.20.5", undefined],
        [24, "function(as long, as double) as double", "1.21.0", undefined]
    ]) {
        // The inspected family retains pointer bit 5. Its FUNCTION primitive
        // moved from 22 to 24 when the two 128-bit scalar slots were inserted.
        const entry = { declaration: { type: "function", provisional: false }, provisional: false,
            nativeSymbol: { id: 1, dtype: datatype | 0x20, typeName } };
        const model = { partial: true, semanticSidecarOnly: false, compilerSemanticModelCompilerVersion: version,
            inventory: { shapes: new Map([[1, { dimensions: 0 }]]) }, getDocument: () => document,
            compilerSelectionRanges: () => [], resolveAt: () => [entry] };
        const result = queryCompilerModel(model, "signature", { uri, position: { line: 0, character: text.length } }, () => {});
        assert.equal(result.procedurePointerSignature?.parameters.length, expected, `${version}: ${datatype}: ${typeName}`);
    }
});

test("bridge callback field signatures survive incomplete factory and array receivers", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const prefix = ["Type CallbackType As Function(ByVal amount As Long, ByVal scale As Double) As Double",
        "Type CallbackHolder", "invoke As CallbackType", "scalar As Long", "pointer As CallbackType Ptr",
        "Private:", "hidden As CallbackType", "End Type",
        "Declare Function MakeHolder() As CallbackHolder", "Declare Function MakeHolderPointer() As CallbackHolder Ptr",
        "Dim holders(0 To 1) As CallbackHolder", "Dim holderValue As CallbackHolder", ""].join("\n");
    for (const receiver of ["MakeHolder().invoke", "MakeHolderPointer()->invoke", "holders(0).invoke", "(holderValue.invoke)"]) {
        const statement = `Print ${receiver}(1,`;
        const text = prefix + statement + "\n";
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, true, statement);
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(text, statement, statement.length) })).result;
            assert.equal(result.procedurePointerSignature?.parameters.length, 2, statement);
            assert.match(result.procedurePointerSignature.parameters[0].label, /as long/i);
            assert.match(result.procedurePointerSignature.parameters[1].label, /as double/i);
            assert.equal(result.selectedCompilerSymbolId, undefined, "a callable field's type cannot identify an indirect runtime target");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    for (const receiver of ["MakeHolder().hidden", "MakeHolder().missing", "MakeHolder().scalar", "MakeHolder().pointer",
        "MakeHolderPointer().invoke", "UnknownHolder().invoke"]) {
        const statement = `Print ${receiver}(1,`;
        const text = prefix + statement + "\n";
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(text, statement, statement.length) })).result;
            assert.equal(result?.procedurePointerSignature, undefined, "native access and callable field type must be proven: " + statement);
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("native Signature Help recovers scoped procedure overloads without selecting a target", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const declarations = [
        "Declare Function Calculate Overload(ByVal amount As Long, ByVal scale As Double) As Double",
        "Declare Function Calculate Overload(ByVal amount As Double, ByVal scale As Double) As Double"
    ].join("\n") + "\n";
    for (const [statement, padding] of [["Print Calculate(1, )", ""], ["Print Calculate(1,", ""],
        ["Print Calculate(1, )", Array.from({ length: 2100 }, (_, index) => `Dim paddingValue${index} As Long\n`).join("")]]) {
        const text = padding + declarations + statement + "\n";
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
        try {
            assert.equal(reply.partial, true);
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, statement, statement.indexOf(",") + 1)
            })).result;
            assert.equal(result.entries.length, 2, statement);
            assert.ok(result.entries.some((entry) => /amount As Long/i.test(entry.declaration.signature)));
            assert.ok(result.entries.some((entry) => /amount As Double/i.test(entry.declaration.signature)));
            assert.equal(result.context.activeParameter, 1);
            assert.equal(result.selectedCompilerSymbolId, 0, "recovery is not an overload-selection receipt");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("committed native Signature Help retains accessible overloads and the compiler-selected target", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const declarations = [
        "Declare Function Calculate Overload(ByVal amount As Long, ByVal scale As Double) As Double",
        "Declare Function Calculate Overload(ByVal amount As Double, ByVal scale As Double) As Double",
        "Type Service", "    value As Long",
        "Declare Function Measure Overload(ByVal amount As Long, ByVal scale As Double) As Double",
        "Declare Function Measure Overload(ByVal amount As Double, ByVal scale As Double) As Double",
        "Declare Property Item(ByVal amount As Long) As Double",
        "Declare Property Item(ByVal amount As Double) As Double",
        "Declare Property Item(ByVal amount As Long, ByVal assignedValue As Double)",
        "Private:", "Declare Function Measure Overload(ByVal amount As String, ByVal scale As Double) As Double",
        "End Type", "Dim instance As Service", ""
    ].join("\n");
    for (const callee of ["Calculate", "instance.Measure", "instance.Item"]) for (const [cast, expected] of [["CLng", "long"], ["CDbl", "double"]]) {
        const statement = `Print ${callee}(${cast}(1)${callee.endsWith(".Item") ? "" : ", 2"})`;
        const text = declarations + statement + "\n";
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
        try {
            assert.equal(reply.partial, false);
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, statement, statement.length - 1)
            })).result;
            assert.equal(result.entries.length, 2, statement);
            const selected = result.entries.filter((entry) => entry.compilerSymbolId === result.selectedCompilerSymbolId);
            assert.equal(selected.length, 1, "the selected ID must identify exactly one displayed overload");
            assert.equal(selected[0].declaration.parameters[0].typeName.toLowerCase(), expected, statement);
            assert.ok(result.entries.every((entry) => entry.declaration.parameters[0].typeName.toLowerCase() !== "string"));
            if (callee.endsWith(".Item")) assert.ok(result.entries.every((entry) => entry.declaration.parameters.length === 1),
                "getter assistance must not include setter signatures");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("unevaluated source roles prefer inner native inputs and retain conflicting physical uses", () => {
    const uri = CompilerUri.file("/workspace/query.bas");
    const model = Object.create(CompilerSemanticModel.prototype);
    model.getDocument = () => ({ text: "SizeOf(Factory())", lineOffsets: [0] });
    const ranges = [{ start: 0, end: 17, unevaluated: false, maximum: 17 },
        { start: 7, end: 16, unevaluated: true, maximum: 17 }];
    model.compilerUnevaluatedSourceRanges = new Map([[uri.toString(), ranges]]);
    const occurrence = { line: 0, startColumn: 7, endColumn: 14 };
    assert.equal(model.isUnevaluatedSourceOccurrence(uri, occurrence), true);
    ranges.push({ start: 7, end: 16, unevaluated: false, maximum: 17 });
    assert.equal(model.isUnevaluatedSourceOccurrence(uri, occurrence), false,
        "another evaluated expansion at the same physical span must retain its runtime edge");
    assert.equal(model.isUnevaluatedSourceOccurrence(CompilerUri.file("/workspace/other.bas"), occurrence), false);
});

test("native macro definition names retain references but require invocation-level call projection", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    for (const [definition, call, bodyReference] of [["#define FixedCall() Factory()", "FixedCall()", true],
        ["#define Glue(prefix, suffix) prefix##suffix()", "Glue(Fa, ctory)", false]]) {
        const text = ["Declare Function Factory() As Long", definition, "Sub Caller()", "    Print Factory()",
            "    Print " + call, "End Sub", ""].join("\n");
        fs.writeFileSync(filePath, text);
        const reply = await worker.analyze({ ...options, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false);
            const outgoing = (await worker.query(reply.snapshotId, "callHierarchyOutgoing", { ...input,
                position: pointAt(text, "Sub Caller", "Sub ".length) })).result;
            assert.deepEqual(outgoing.flatMap((entry) => entry.fromRanges.map((range) => range.line)), [3]);
            assert.ok(outgoing.every((entry) => entry.compilerRequiresImplicitProjection === true),
                "replacement-body and pasted callee names need invocation-level projection");
            if (bodyReference) {
                const references = (await worker.query(reply.snapshotId, "references", { ...input,
                    position: pointAt(text, "Function Factory", "Function ".length), includeDeclaration: true })).result;
                assert.ok(references.some((entry) => entry.occurrence.line === 1), "the written macro body name remains a symbol reference");
            }
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("native call hierarchy excludes unevaluated query calls without removing references", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["Declare Function Factory() As Long", "Declare Function TextFactory() As String",
        "#define FactoryType(name) TypeOf(name())", "Sub Caller()", "    Dim first As TypeOf(Factory())",
        "    Print SizeOf(Factory())", "    Dim nested As TypeOf(CLng(SizeOf(Factory())))",
        "    Dim expanded As FactoryType(Factory)", "    Print Factory()", "    Print Len(TextFactory())",
        "#define DualUse(name) Dim mixed As TypeOf(name()) : Print name()", "    DualUse(Factory)", "End Sub",
        "#if SizeOf(Integer) > 0", "#assert TypeOf(CLng(1)) = TypeOf(Long)", "#endif", ""].join("\n");
    fs.writeFileSync(filePath, text);
    for (const bindings of [false, true]) {
        const reply = await worker.analyze({ ...options, exportSemanticExpressions: true, exportSemanticBindings: bindings }, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            const outgoing = (await worker.query(reply.snapshotId, "callHierarchyOutgoing", { ...input,
                position: pointAt(text, "Sub Caller", "Sub ".length) })).result;
            assert.deepEqual(outgoing.map((entry) => entry.fromRanges.map((range) => range.line)).flat().sort((a, b) => a - b), [8, 9, 11],
                "TYPEOF/SIZEOF operands are not calls, but LEN's dynamic String operand is evaluated");
            const incoming = (await worker.query(reply.snapshotId, "callHierarchyIncoming", { ...input,
                position: pointAt(text, "Function Factory", "Function ".length) })).result;
            assert.deepEqual(incoming.map((entry) => entry.fromRanges.map((range) => range.line)).flat(), [8, 11]);
            const references = (await worker.query(reply.snapshotId, "references", { ...input,
                position: pointAt(text, "Function Factory", "Function ".length), includeDeclaration: true })).result;
            assert.deepEqual([...new Set(references.map((entry) => entry.occurrence.line))].sort((a, b) => a - b), [0, 4, 5, 6, 7, 8, 11],
                "unevaluated uses remain actual symbol references");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("unevaluated query hierarchy excludes constructor and index-operator relationships", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["Type QueryBox", "    value As Long", "    Declare Constructor()", "    Declare Operator Cast() As Long",
        "    Declare Operator [](ByVal index As Long) As Long", "End Type", "Sub Caller()",
        "    Dim converted As TypeOf(CLng(Type<QueryBox>()))", "    Dim instance As QueryBox = Any",
        "    Dim indexed As TypeOf(instance[0])", "End Sub", ""].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    try {
        assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
        const outgoing = (await worker.query(reply.snapshotId, "callHierarchyOutgoing", { ...input,
            position: pointAt(text, "Sub Caller", "Sub ".length) })).result;
        assert.deepEqual(outgoing, [], "type queries must not create implicit runtime edges");
        const references = (await worker.query(reply.snapshotId, "references", { ...input,
            position: pointAt(text, "Declare Constructor", "Declare ".length), includeDeclaration: true })).result;
        assert.ok(references.some((entry) => entry.occurrence.line === 7), "the constructor remains referenced by typed syntax");
    } finally { worker.releaseModel(reply.snapshotId); }
});

test("native compound method signatures retain accessible overloads and selections", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/compound-method-signatures.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    for (const sidecar of [true, false]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: sidecar ? process.env.FBC_EXECUTABLE : options.compilerPath,
            semanticModelOnly: sidecar, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            for (const [call, expected, count] of [["MakeService().Measure(CLng(1), 2)", "long", 2],
                ["MakeService().Measure(CDbl(1), 2)", "double", 2], ["services(0).Measure(CLng(1), 2)", "long", 2],
                ["(*servicePointer).Measure(CDbl(1), 2)", "double", 2], ["MakeServicePointer()->Measure(CDbl(1), 2)", "double", 2],
                ["MakeService().Item(CLng(1))", "long", 2], ["MakeService().Item(CDbl(1))", "double", 2],
                ["MakeService().Apply(1, 2)", "long", 1]]) {
                const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                    position: pointAt(text, call, call.length - 1) })).result;
                assert.equal(result?.entries.length, count, `${sidecar ? "stock" : "bridge"}: ${call}`);
                assert.ok(result.entries.every((entry) => !/amount As String/i.test(entry.declaration.signature)));
                assert.equal(result.procedurePointerSignature, undefined, "a method is not a callback value");
                assert.equal(result.arraySignature, undefined);
                if (count > 1) {
                    const selected = result.entries.filter((entry) => entry.compilerSymbolId === result.selectedCompilerSymbolId);
                    assert.equal(selected.length, 1, "one displayed method must match the native target for " + call);
                    assert.equal(selected[0].declaration.parameters[0].typeName.toLowerCase(), expected);
                }
                if (call.includes(".Item")) assert.ok(result.entries.every((entry) => entry.declaration.parameters.length === 1),
                    "property getter help must not include its setter");
            }
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("native bare compound and WITH method calls retain signatures and selections", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/compound-method-signatures.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    for (const sidecar of [true, false]) {
        const reply = await worker.analyze({ ...options, compilerPath: sidecar ? process.env.FBC_EXECUTABLE : options.compilerPath,
            semanticModelOnly: sidecar, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            for (const [call, type, count] of [["MakeService().Measure CLng(1), 2", "long", 2],
                ["services(0).Measure CDbl(1), 2", "double", 2], ["(*servicePointer).Apply 1, 2", "long", 1],
                ["MakeServicePointer()->Apply 1, 2", "long", 1], ["    .Measure CLng(1), 2", "long", 2],
                ["    .Measure CDbl(1), 2", "double", 2], ["    .Apply 1, 2", "long", 1],
                ["If 1 Then .Apply 1, 2", "long", 1], ["    .Apply 1, _\n        2", "long", 1]]) {
                const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                    position: pointAt(text, call, call.length) })).result;
                assert.equal(result?.entries.length, count, `${sidecar ? "stock" : "bridge"}: ${call}`);
                assert.equal(result.context.bare, true);
                assert.equal(result.context.activeParameter, 1);
                assert.ok(result.entries.every((entry) => !/amount As String/i.test(entry.declaration.signature)));
                if (count > 1) {
                    const selected = result.entries.filter((entry) => entry.compilerSymbolId === result.selectedCompilerSymbolId);
                    assert.equal(selected.length, 1);
                    assert.equal(selected[0].declaration.parameters[0].typeName.toLowerCase(), type);
                }
            }
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("bridge bare receiver and WITH method recovery requires an active native receiver", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const prefix = fs.readFileSync(path.join(__dirname, "fixtures/compound-method-signatures.bas"), "utf8");
    fs.writeFileSync(filePath, prefix);
    input.openFiles = [filePath];
    for (const [before, statement, count, closeWith = true] of [["", "MakeService().Measure ", 2], ["", "services(0).Measure ", 2],
        ["", "(*servicePointer).Apply 1,", 1], ["With services(0)\n", "    .Apply 1,", 1],
        ["With services(0)\n", "    .HiddenMethod ", 0], ["", ".Apply 1,", 0],
        ["With services(0)\n", "    .Apply 1,", 1, false], ["With services(0)\n", "    .HiddenMethod ", 0, false]]) {
        const text = prefix + before + statement + "\n" + (before && closeWith ? "End With\n" : "");
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: false }, preparation);
        try {
            assert.equal(reply.partial, true, statement);
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: { line: prefix.split("\n").length + before.split("\n").length - 2,
                    character: statement.length } })).result;
            assert.equal(result?.entries.length || 0, count, statement);
            assert.equal(result?.selectedCompilerSymbolId || 0, 0, "unfinished required arguments cannot select a target");
            assert.ok((result?.entries || []).every((entry) => !/amount As String/i.test(entry.declaration.signature)));
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), prefix);
});

test("bridge compound method signatures survive incomplete arguments without selecting a target", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const prefix = fs.readFileSync(path.join(__dirname, "fixtures/compound-method-signatures.bas"), "utf8");
    fs.writeFileSync(filePath, prefix);
    input.openFiles = [filePath];
    for (const [statement, count] of [["Print MakeService().Measure(1,", 2], ["Print services(0).Measure(", 2],
        ["Print (*servicePointer).Measure(1,", 2], ["Print MakeServicePointer()->Measure(1,", 2],
        ["MakeService().Apply(1,", 1], ["Print MakeService().HiddenMethod(", 0], ["Print unknownService.Measure(", 0]]) {
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, prefix + statement]]),
            exportSemanticExpressions: true, exportSemanticBindings: false }, preparation);
        try {
            assert.equal(reply.partial, true);
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: { line: prefix.split("\n").length - 1, character: statement.length } })).result;
            assert.equal(result?.entries.length || 0, count, statement);
            assert.equal(result?.selectedCompilerSymbolId || 0, 0, "unfinished arguments do not select an overload");
            assert.ok((result?.entries || []).every((entry) => !/amount As String/i.test(entry.declaration.signature)));
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), prefix);
});

test("committed bare-call Signature Help keeps native selections across statement boundaries", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const declarations = [
        "Declare Sub Apply Overload(ByVal amount As Long, ByVal scale As Double)",
        "Declare Sub Apply Overload(ByVal amount As Double, ByVal scale As Double)",
        "Namespace Helpers",
        "Declare Sub Apply Overload(ByVal amount As Long, ByVal scale As Double)",
        "Declare Sub Apply Overload(ByVal amount As Double, ByVal scale As Double)",
        "End Namespace", "Type Service", "    value As Long",
        "Declare Sub Apply Overload(ByVal amount As Long, ByVal scale As Double)",
        "Declare Sub Apply Overload(ByVal amount As Double, ByVal scale As Double)",
        "End Type", "Dim instance As Service", "Dim pointerValue As Service Ptr = @instance", ""
    ].join("\n");
    const statements = [
        "Apply CLng(1), 2", "Apply CDbl(1), 2",
        "Helpers.Apply CDbl(1), 2", "instance.Apply CDbl(1), 2", "pointerValue->Apply CDbl(1), 2",
        "instance . Apply CDbl(1), 2", "Apply CDbl(1), _\n    2",
        "If 1 Then Apply CLng(1), 2 Else Apply CDbl(1), 2",
        "Apply CLng(1), 2: Apply CDbl(1), 2", "Apply CLng(1), 2 ' Apply CDbl(1), 2"
    ];
    const text = declarations + statements.join("\n") + "\n";
    const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
    try {
        assert.equal(reply.partial, false, reply.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        for (const statement of statements) {
            for (const match of statement.matchAll(/Apply[ (](CLng|CDbl)\(1\),/g)) {
                if (statement.slice(0, match.index).includes("'")) continue;
                const offset = text.indexOf(statement, declarations.length) + match.index + match[0].length;
                const position = { line: text.slice(0, offset).split("\n").length - 1,
                    character: offset - text.lastIndexOf("\n", offset - 1) - 1 };
                const result = (await worker.query(reply.snapshotId, "signature", { ...input, position })).result;
                assert.equal(result.entries.length, 2, statement);
                const selected = result.entries.filter((entry) => entry.compilerSymbolId === result.selectedCompilerSymbolId);
                assert.equal(selected.length, 1, statement);
                assert.equal(selected[0].declaration.parameters[0].typeName.toLowerCase(),
                    match[1] === "CLng" ? "long" : "double", statement);
                assert.equal(result.context.activeParameter, 1);
            }
        }
    } finally { worker.releaseModel(reply.snapshotId); }
});

test("compound index signatures refuse provisional receiver types", () => {
    const { createDocumentModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const uri = CompilerUri.file("/workspace/uncertain-compound-index.bas");
    const text = "Print MakeValue()[";
    const document = createDocumentModel(uri, parseFreeBasicText(text));
    let queries = 0;
    const model = { partial: true, inventory: {}, semanticSidecarOnly: false,
        getDocument: () => document, compilerSelectionRanges: () => [],
        expressionAt() { queries++; return { typeName: "UncertainType", subtype: 7, provisional: true }; },
        nativeTypeEntries() { assert.fail("a provisional receiver cannot supply operator members"); }
    };
    const result = queryCompilerModel(model, "signature", { uri, position: { line: 0, character: text.length } }, () => {});
    assert.ok(queries > 0);
    assert.deepEqual(result.entries, []);
    assert.equal(result.selectedCompilerSymbolId, 0);
});

test("native compound index signatures use compiler-typed expression receivers", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const prefix = ["Type ExpressionIndex", "value As Long", "Declare Operator [](ByVal index As Long) As Long",
        "Declare Operator [](ByVal index As Double) As Long", "Private:", "Declare Operator [](ByVal index As String) As Long", "End Type",
        "Declare Function MakeIndex() As ExpressionIndex", "Declare Function MakePointer() As ExpressionIndex Ptr",
        "Declare Function MakeScalar() As Long", "Dim item As ExpressionIndex", "Dim pointerValue As ExpressionIndex Ptr = @item",
        "Dim values(0 To 1) As ExpressionIndex", ""].join("\n");
    for (const receiver of ["MakeIndex()", "values(0)", "(*pointerValue)", "(item)"]) for (const closed of [false, true]) {
        const statement = `Print ${receiver}[${closed ? "CLng(1)]" : ""}`;
        const text = prefix + statement + "\n";
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, !closed, statement);
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(text, statement, `Print ${receiver}[`.length) })).result;
            assert.equal(result?.context.indexing, true, statement);
            assert.equal(result.context.expressionCallee, true);
            const operators = result.entries.filter((entry) => entry.declaration.type === "operator");
            assert.equal(operators.length, 2, "only compiler-proven accessible index signatures should be returned: " + statement);
            assert.ok(operators.every((entry) => !/index As String/i.test(entry.declaration.signature)));
            if (!closed) assert.equal(result.selectedCompilerSymbolId || 0, 0);
            else assert.equal(result.selectedCompilerSymbolId, operators.find((entry) =>
                /\bindex As Long\b/i.test(entry.declaration.signature)).compilerSymbolId,
            "complete compound indexing must preserve the compiler-selected overload");
            assert.equal(result.procedurePointerSignature, undefined, "an indexed aggregate is not an indirect procedure invocation");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    for (const receiver of ["(pointerValue)", "MakePointer()", "MakeScalar()", "values()", "values(0, 1)", "(values)", "UnknownFactory()"]) {
        const statement = `Print ${receiver}[`;
        const text = prefix + statement + "\n";
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(text, statement, statement.length) })).result;
            assert.deepEqual(result?.entries || [], [], "do not infer a scalar indexable value from invalid/pointer/array receivers: " + statement);
            assert.equal(result?.selectedCompilerSymbolId || 0, 0);
            assert.equal(result?.procedurePointerSignature, undefined);
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("provisional receiver types cannot recover index operator signatures", () => {
    const { createDocumentModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const uri = CompilerUri.file("/workspace/provisional-index.bas");
    const text = "Print This[";
    const document = createDocumentModel(uri, parseFreeBasicText(text));
    let typed = 0;
    const model = { partial: true, inventory: {}, semanticSidecarOnly: false,
        getDocument: () => document, resolveAt: () => [], completeMembers: () => null, visibleEntries: () => [],
        expressionAt() { typed++; return { typeName: "UncertainType", subtype: 7, provisional: true }; },
        nativeTypeEntries() { assert.fail("a provisional type must not supply members"); }
    };
    const result = queryCompilerModel(model, "signature", { uri, position: { line: 0, character: text.length } }, () => {});
    assert.equal(typed, 1);
    assert.deepEqual(result.entries, []);
    assert.equal(result.selectedCompilerSymbolId, 0);
});

test("native index operator signatures remain available while brackets are incomplete", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const prefix = ["Type RecoveryIndex", "value As Long", "Declare Operator [](ByVal index As Long) As Long",
        "Declare Operator [](ByVal index As Double) As Long", "Private:",
        "Declare Operator [](ByVal index As String) As Long", "Public:", "Declare Sub Inspect()", "Declare Static Sub InspectStatic()", "End Type",
        "Type IndexAlias As RecoveryIndex", "Type Holder", "item As RecoveryIndex", "Private:", "hidden As RecoveryIndex", "End Type",
        "Dim item As RecoveryIndex", "Dim aliasValue As IndexAlias", "Dim holderValue As Holder", "Dim indexedValues(0 To 1) As RecoveryIndex",
        "Dim pointerValue As RecoveryIndex Ptr", "Dim scalarValue As Long", "Namespace Values", "Dim Shared qualified As RecoveryIndex",
        "End Namespace", ""].join("\n");
    for (const [statement, expected, before = "", after = ""] of [
        ["Print item[", 2], ["Print item[1 +", 2], ["Print aliasValue[", 2], ["Print holderValue.item[", 2],
        ["Print Values.qualified[", 2], ["Print borrowed[", 2, "Sub Work(ByRef borrowed As RecoveryIndex)\n", "End Sub\n"],
        ["Print This[", 3, "Sub RecoveryIndex.Inspect()\n", "End Sub\n"],
        ["Print This[", 0, "Sub RecoveryIndex.InspectStatic()\n", "End Sub\n"],
        ["Print holderValue.hidden[", 0], ["Print indexedValues[", 0], ["Print pointerValue[", 0], ["Print scalarValue[", 0],
        ["Print RecoveryIndex[", 0], ["Print item[", 0, "Sub Shadow(ByVal item As Long)\n", "End Sub\n"]
    ]) {
        const text = prefix + before + statement + "\n" + after;
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: false, exportSemanticBindings: false }, preparation);
        try {
            assert.equal(reply.partial, true);
            const receiver = /([A-Za-z_]\w*)\[/.exec(statement)[1];
            const receiverPosition = pointAt(text, statement, statement.indexOf(receiver + "[") + 1);
            const bindings = (await worker.query(reply.snapshotId, "definition", { ...input, position: receiverPosition })).result;
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(text, statement, statement.length) })).result;
            const operators = (result?.entries || []).filter((entry) => entry.declaration.type === "operator");
            assert.equal(operators.length, expected, "incomplete indexing must retain only accessible scalar-value native overloads: " + before + statement);
            assert.ok(operators.every((entry) => entry.declaration.parameters.length === 1), "native index signatures must retain their parameter");
            assert.ok(operators.every((entry) => /Declare Operator \[\]\(ByVal index As (?:Long|Double|String)\) As Long/i.test(entry.declaration.signature)),
                "recovery must present the full physical index signature, not a truncated trace caption");
            if (expected !== 3) assert.ok(operators.every((entry) => !/index As String/i.test(entry.declaration.signature)), "private operators must stay hidden");
            assert.equal(result.context.activeParameter, 0);
            assert.equal(result.selectedCompilerSymbolId || 0, 0, "an incomplete index expression has no committed target");
            assert.deepEqual((await worker.query(reply.snapshotId, "definition", { ...input, position: receiverPosition })).result, bindings,
                "index signature recovery must not alter navigation bindings");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("native constructor signatures remain available while arguments are incomplete", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const prefix = ["Type RecoveryWidget", "value As Long",
        "Declare Constructor(ByVal amount As Long, ByVal scale As Double)",
        "Declare Constructor(ByVal amount As Double, ByVal scale As Double)",
        "Private:", "Declare Constructor(ByVal amount As String, ByVal scale As Double)", "End Type", ""].join("\n");
    const fixtures = [
        { statement: "Dim result As RecoveryWidget = RecoveryWidget(1,", expected: 2 },
        { statement: "Dim allocated As RecoveryWidget Ptr = New RecoveryWidget(1,", expected: 2 },
        { prefix: prefix + "Type RecoveryAlias As RecoveryWidget\n", statement: "Print RecoveryAlias(1,", expected: 2 },
        { prefix: "Namespace Widgets\n" + prefix + "End Namespace\n", statement: "Print Widgets.RecoveryWidget(1,", expected: 2 },
        { prefix: "Namespace Hidden\n" + prefix + "End Namespace\n", statement: "Print RecoveryWidget(1,", expected: 0 },
        { prefix: prefix + "Sub Work(ByVal RecoveryWidget As Long)\n", statement: "Print RecoveryWidget(1,", suffix: "End Sub\n", expected: 2, rejectedShadow: true },
        { prefix: "Namespace Types\n" + prefix + "End Namespace\nUsing Types\nSub Work(ByVal RecoveryWidget As Long)\n",
            statement: "Print RecoveryWidget(1,", suffix: "End Sub\n", expected: 0 },
        { prefix: prefix + "Type ScalarAlias As Long\n", statement: "Print ScalarAlias(1,", expected: 0 },
        { prefix: prefix + "Type WidgetPointer As RecoveryWidget Ptr\n", statement: "Print WidgetPointer(1,", expected: 0 },
        { prefix: "Namespace First\n" + prefix + "End Namespace\nNamespace Second\n" + prefix +
            "End Namespace\nUsing First\nUsing Second\n", statement: "Print RecoveryWidget(1,", expected: 0 }
    ];
    for (const fixture of fixtures) {
        const { statement, expected } = fixture;
        const text = (fixture.prefix || prefix) + statement + "\n" + (fixture.suffix || "");
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: false, exportSemanticBindings: false }, preparation);
        try {
            assert.equal(reply.partial, true);
            if (fixture.rejectedShadow) assert.ok(reply.diagnostics.some((diagnostic) => /duplicated definition/i.test(diagnostic.message)),
                "a rejected parameter cannot shadow the independently valid native type");
            const callee = /([A-Za-z_]\w*)\([^()]*$/.exec(statement)[1];
            const calleePosition = pointAt(text, statement, statement.lastIndexOf(callee + "(") + 1);
            const before = (await worker.query(reply.snapshotId, "definition", { ...input, position: calleePosition })).result;
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(text, statement, statement.length) })).result;
            const constructors = (result?.entries || []).filter((entry) => entry.declaration.type === "constructor");
            assert.equal(constructors.length, expected, "incomplete construction must retain only accessible, unambiguous native overloads: " + text);
            assert.ok(constructors.every((entry) => !/amount As String/i.test(entry.declaration.signature)),
                "private constructors must remain inaccessible");
            assert.equal(result.context.activeParameter, 1);
            assert.equal(result.selectedCompilerSymbolId || 0, 0, "an incomplete call has no committed overload selection");
            assert.deepEqual((await worker.query(reply.snapshotId, "definition", { ...input, position: calleePosition })).result, before,
                "signature-only recovery must not alter navigation bindings");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

for (const sidecar of [true, false]) test(`native sized cast signatures retain their own context (${sidecar ? "sidecar" : "bridge"})`, native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const unsignedWidth = process.env.FBC_INTEGER128_EXECUTABLE ? 128 : 32;
    const source = ["Type ConvertedValue", "    value As Short", "    Declare Operator Cast() As Short", "End Type",
        "Operator ConvertedValue.Cast() As Short", "    Return this.value", "End Operator",
        "Declare Function Scale(ByVal amount As Short) As Long", "Dim item As ConvertedValue",
        "Dim small As Short = CInt<16>(item)", `Dim wide As UInteger<${unsignedWidth}> = CUInt<${unsignedWidth}>(1)`,
        "Print Scale(CInt<(8 Shl 1)>(1))", ""].join("\n");
    fs.writeFileSync(filePath, source);
    const reply = await worker.analyze({ ...options,
        compilerPath: sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
        semanticModelOnly: sidecar, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    try {
        assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
        for (const spelling of ["CInt<16>(item)", `CUInt<${unsignedWidth}>(1)`, "CInt<(8 Shl 1)>(1)"]) {
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(source, spelling, spelling.lastIndexOf(">(") + 2) })).result;
            assert.equal(result?.context.sizedCast, true, spelling);
            assert.equal(result.context.activeParameter, 0);
            assert.equal(result.context.name, spelling.startsWith("CUInt") ? "CUInt" : "CInt");
            assert.deepEqual(result.entries, [], "a conversion operator is not the cast intrinsic's signature");
            assert.equal(result.selectedCompilerSymbolId || 0, 0);
        }
        assert.equal(fs.readFileSync(filePath, "utf8"), source);
    } finally { worker.releaseModel(reply.snapshotId); }
    if (!sidecar) {
        const statement = "Print Scale(CInt<32>(";
        const text = source + statement;
        input.openFiles = [filePath];
        const incomplete = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(incomplete.partial, true);
            const result = (await worker.query(incomplete.snapshotId, "signature", { ...input,
                position: pointAt(text, statement, statement.length) })).result;
            assert.equal(result?.context.sizedCast, true);
            assert.equal(result.context.name, "CInt");
            assert.deepEqual(result.entries, []);
            assert.equal(fs.readFileSync(filePath, "utf8"), source, "Signature Help must not save the unfinished buffer");
        } finally { worker.releaseModel(incomplete.snapshotId); }
    }
});

test("native typed constructor signatures remain available while arguments are incomplete", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const saved = fs.readFileSync(filePath, "utf8");
    const prefix = ["Namespace RecoveryTypes", "Type RecoveryWidget", "value As Long",
        "Declare Constructor(ByVal amount As Long, ByVal scale As Double)",
        "Declare Constructor(ByVal amount As Double, ByVal scale As Double)",
        "Declare Sub Inspect()", "Private:", "Declare Constructor(ByVal amount As String, ByVal scale As Double)", "End Type", "End Namespace",
        "Type RecoveryAlias As RecoveryTypes.RecoveryWidget", "Type PointerAlias As RecoveryAlias Ptr", "Type ScalarAlias As Long",
        "Type Holder", "item As RecoveryAlias = Any", "Private:", "hidden As RecoveryAlias = Any", "End Type",
        "Dim item As RecoveryAlias = Any", "Dim holderValue As Holder = Any", "Dim pointerValue As RecoveryAlias Ptr",
        "Declare Function MakeWidget() As RecoveryAlias",
        "Declare Function OptionalWidget(ByVal amount As Long = 0) As RecoveryAlias",
        "Declare Function NeedsArgument(ByVal amount As Long) As RecoveryAlias",
        "Declare Function PointerFactory() As RecoveryAlias Ptr", "Declare Function ScalarFactory() As Long",
        "Declare Function OverloadedFactory Overload() As RecoveryAlias",
        "Declare Function OverloadedFactory Overload(ByVal amount As Long = 0) As RecoveryAlias",
        "Namespace Factories", "Declare Function QualifiedWidget() As RecoveryAlias", "End Namespace", ""].join("\n");
    const cases = [
        ["RecoveryAlias", 2, ""], ["RecoveryAlias", 2, "1,"], ["RecoveryAlias", 2, "1, )"],
        ["RecoveryTypes.RecoveryWidget", 2], ["TypeOf(RecoveryAlias)", 2], ["TypeOf(item)", 2], ["TypeOf(holderValue.item)", 2],
        ["TypeOf(MakeWidget())", 2], ["TypeOf((item))", 2],
        ["TypeOf(OptionalWidget())", 2], ["TypeOf(Factories.QualifiedWidget())", 2], ["TypeOf((holderValue.item))", 2],
        ["TypeOf(NeedsArgument())", 0], ["TypeOf(PointerFactory())", 0], ["TypeOf(ScalarFactory())", 0],
        ["TypeOf(OverloadedFactory())", 0], ["TypeOf(MakeWidget(1))", 0], ["TypeOf((RecoveryAlias))", 0],
        ['TypeOf(OptionalWidget("1"))', 0], ["TypeOf(OptionalWidget(/' empty '/))", 2],
        ["TypeOf((holderValue.hidden))", 0],
        ["TypeOf(MakeWidget())", 2, "1,", "Sub Work(ByVal MakeWidget As Long)\n", "End Sub\n"],
        ["TypeOf(QualifiedWidget())", 0, "1,", "Using Factories\nSub Work(ByVal QualifiedWidget As Long)\n", "End Sub\n"],
        ["TypeOf(MakeWidget())", 0, "1,", "Option NoKeyword TYPEOF\nDeclare Function TYPEOF(ByVal value As RecoveryAlias) As Long\n"],
        ["RecoveryAlias", 0, "1,", "Option NoKeyword TYPE\nDim TYPE As Long\n"],
        ["RecoveryAlias", 0, "1,", "Option NoKeyword TYPE\n#define TYPE 1\n"],
        ["TypeOf((pointerValue))", 0], ["TypeOf((ScalarAlias))", 0],
        ["UnknownType", 0], ["RecoveryWidget", 0], ["item", 0], ["ScalarAlias", 0], ["PointerAlias", 0],
        ["RecoveryAlias Ptr", 0], ["TypeOf(pointerValue)", 0], ["TypeOf(PointerAlias)", 0],
        ["TypeOf(MakeWidget)", 0], ["TypeOf(holderValue.hidden)", 0],
        ["RecoveryWidget", 0, "1,", "Using RecoveryTypes\nSub Work(ByVal RecoveryWidget As Long)\n", "End Sub\n"],
        ["RecoveryWidget", 0, "1,", "Namespace Other\nType RecoveryWidget\nvalue As Long\n" +
            "Declare Constructor(ByVal amount As Long, ByVal scale As Double)\nEnd Type\nEnd Namespace\n" +
            "Using RecoveryTypes\nUsing Other\n"],
        ["RecoveryAlias", 3, "1,", "Sub RecoveryTypes.RecoveryWidget.Inspect()\n", "End Sub\n"]
    ];
    for (const [type, expected, argumentsText = "1,", before = "", after = ""] of cases) {
        const statement = `Dim result As RecoveryAlias = Type<${type}>(${argumentsText}`;
        const dialect = before.startsWith("Option NoKeyword") ? '#lang "deprecated"\n' : "";
        const text = dialect + prefix + before + statement + "\n" + after;
        if (type === "TypeOf(MakeWidget())" && before.startsWith("Sub Work(ByVal MakeWidget As Long)")) {
            const complete = await worker.analyze({ ...options,
                overlays: new Map([[filePath, prefix + before + statement + "1)\n" + after]]),
                exportSemanticExpressions: false, exportSemanticBindings: false }, preparation);
            try {
                assert.equal(complete.partial, true);
                assert.ok(complete.diagnostics.some((diagnostic) => diagnostic.code === 4),
                    "FBC rejects the duplicate formal rather than replacing its existing native factory");
            } finally { worker.releaseModel(complete.snapshotId); }
        }
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: false, exportSemanticBindings: false }, preparation);
        try {
            assert.equal(reply.partial, true);
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(text, statement, argumentsText.endsWith(")") ? statement.lastIndexOf(",") + 1 : statement.length) })).result;
            assert.equal(result?.entries.length || 0, expected, "retain accessible native constructors for " + statement);
            if (result) {
                assert.ok(result.entries.every((entry) => entry.declaration.type === "constructor" && entry.declaration.parameters.length === 2));
                if (expected !== 3) assert.ok(result.entries.every((entry) => !/amount As String/i.test(entry.declaration.signature)));
                assert.equal(result.context.activeParameter, argumentsText ? 1 : 0);
                assert.equal(result.selectedCompilerSymbolId || 0, 0, "recovery must not select an overload");
            }
            if (["RecoveryAlias", "TypeOf(MakeWidget())", "TypeOf((item))"].includes(type) && argumentsText === "1," &&
                !/^Option NoKeyword TYPE\b/.test(before)) {
                const hover = (await worker.query(reply.snapshotId, "hover", { ...input,
                    position: pointAt(text, statement, statement.indexOf("Type<") + 1) })).result;
                assert.ok(hover.entries.every((entry) => entry.declaration.type !== "constructor"),
                    "an unfinished typed call has no committed constructor hover");
                for (const operation of ["definition", "declaration", "implementation"]) assert.deepEqual(
                    (await worker.query(reply.snapshotId, operation, { ...input,
                        position: pointAt(text, statement, statement.indexOf("Type<") + 1) })).result, [],
                    "an unfinished typed call must not navigate to a guessed constructor");
            }
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), saved);
});

test("typed constructor recovery refuses provisional types and pointer operands", () => {
    const { createDocumentModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const uri = CompilerUri.file("/workspace/uncertain-typed-constructor.bas");
    for (const mode of ["entry", "declaration", "pointer", "value", "scalar"]) {
        const text = `Print Type<${mode === "scalar" ? "TypeOf(operand)" : "operand"}>(1,`;
        const document = createDocumentModel(uri, parseFreeBasicText(text));
        const entry = { name: "operand", key: "operand", provisional: mode === "entry",
            declaration: { type: ["value", "scalar"].includes(mode) ? "variable" : "type", provisional: mode === "declaration" },
            nativeSymbol: { typeName: mode === "pointer" ? "Widget ptr" : mode === "scalar" ? "long" : "Widget" } };
        const model = { partial: true, inventory: {}, semanticSidecarOnly: false, semanticBindingsAvailable: false,
            getDocument: () => document, completeMembers: () => null, visibleEntries: () => [entry],
            typeEntries() { assert.equal(mode, "scalar"); return []; },
            nativeMembers() { assert.fail("unproven types cannot supply a constructor family"); } };
        assert.equal(queryCompilerModel(model, "signature", { uri, position: { line: 0, character: text.length } }, () => {}), null, mode);
    }
});

test("TYPEOF factory recovery rejects incomplete or ambiguous native callable metadata", () => {
    const { createDocumentModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const uri = CompilerUri.file("/workspace/uncertain-typeof-factory.bas");
    const text = "Print Type<Typeof(Factory())>(1,";
    const document = createDocumentModel(uri, parseFreeBasicText(text));
    for (const mode of ["required", "parameters", "identity", "overloads", "pointer", "entry", "declaration", "keyword", "macro"]) {
        const entry = { name: "Factory", key: "factory", compilerSymbolId: mode === "identity" ? 0 : 1,
            nativeSymbol: { id: mode === "identity" ? 0 : 1, typeName: mode === "pointer" ? "Widget ptr" : "Widget" },
            provisional: mode === "entry", declaration: { type: "function", provisional: mode === "declaration",
                parameters: mode === "parameters" ? null : mode === "required" ? [{ optional: false }] : [] } };
        const entries = mode === "overloads" ? [entry, { ...entry, compilerSymbolId: 2, nativeSymbol: { ...entry.nativeSymbol, id: 2 } }] : [entry];
        const model = { partial: true, inventory: {}, semanticSidecarOnly: false, canonicalSymbolIds: new Map(), getDocument: () => document,
            completeMembers: () => entries,
            visibleEntries: () => mode === "keyword" ? [{ key: "typeof", nativeSymbol: { id: 2 } }]
                : mode === "macro" ? [{ key: "typeof", compilerPreprocessorId: 2 }] : [],
            typeEntries() { assert.fail("unproven factory metadata must not supply a return-type owner"); } };
        assert.equal(queryCompilerModel(model, "signature", { uri, position: { line: 0, character: text.length } }, () => {}), null, mode);
    }
});

test("native Signature Help recovery preserves member access, scope, and shadowing", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const declaration = "Declare Function Calculate(ByVal amount As Long, ByVal scale As Double) As Double\n";
    const cases = [
        { text: "Declare Sub Apply(ByVal amount As Long, ByVal scale As Double)\nApply 1,\n",
            statement: "Apply 1,", expected: 1 },
        { text: '#lang "fblite"\nDeclare Function GetText$(ByVal amount As Long, ByVal scale As Double)\nPrint GetText$(1, )\n',
            statement: "Print GetText$(1, )", expected: 1 },
        { text: declaration + "Sub Work(ByVal Calculate As Long)\nPrint Calculate(1, )\nEnd Sub\n",
            statement: "Print Calculate(1, )", expected: 1, duplicate: true },
        { text: declaration + "Namespace LocalScope\n" +
            "Declare Function Calculate(ByVal amount As String, ByVal scale As Double) As Double\n" +
            'Print Calculate("one", )\nEnd Namespace\n',
            statement: 'Print Calculate("one", )', expected: 1, requiredType: "String" },
        { text: "Namespace Hidden\n" + declaration + "End Namespace\nPrint Calculate(1, )\n",
            statement: "Print Calculate(1, )", expected: 0 },
        { text: "Namespace FirstScope\n" + declaration + "End Namespace\nNamespace SecondScope\n" + declaration +
            "End Namespace\nUsing FirstScope\nUsing SecondScope\nPrint Calculate(1, )\n",
            statement: "Print Calculate(1, )", expected: 0 },
        { text: ["Type Service", "    value As Long",
            "Declare Function Measure Overload(ByVal amount As Long, ByVal scale As Double) As Double",
            "Declare Function Measure Overload(ByVal amount As Double, ByVal scale As Double) As Double",
            "Private:", "Declare Function Measure Overload(ByVal amount As String, ByVal scale As Double) As Double",
            "End Type", "Dim instance As Service", "Print instance.Measure(1, )", ""].join("\n"),
            statement: "Print instance.Measure(1, )", expected: 2, excludePrivate: true }
    ];
    for (const fixture of cases) {
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, fixture.text]]) }, preparation);
        try {
            assert.equal(reply.partial, true);
            if (fixture.duplicate) assert.ok(reply.diagnostics.some((diagnostic) => /Duplicated definition/.test(diagnostic.message)),
                "a rejected parameter cannot shadow an independently valid native procedure");
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(fixture.text, fixture.statement, fixture.statement.indexOf(",") + 1)
            })).result;
            const entries = (result?.entries || []).filter((entry) => ["function", "sub"].includes(entry.declaration.type));
            assert.equal(entries.length, fixture.expected, fixture.text + "\n" +
                reply.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
            if (fixture.requiredType) assert.ok(entries.every((entry) =>
                entry.declaration.parameters[0]?.typeName.toLowerCase() === fixture.requiredType.toLowerCase()));
            if (fixture.excludePrivate) assert.ok(entries.every((entry) => !/amount As String/i.test(entry.declaration.signature)),
                "a private overload must remain inaccessible outside its native type");
            assert.equal(result?.selectedCompilerSymbolId || 0, 0);
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("native member completion retains selected receivers in broken unsaved statements", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const original = fs.readFileSync(filePath, "utf8");
    const source = fs.readFileSync(path.join(__dirname, "integration/workspace/compiler-scopes.bas"), "utf8")
        .replace("Dim instance As Child", [
            "Dim instance As Child",
            "Dim pointerValue As Child Ptr",
            "Dim arrayValues(1) As Child",
            "Declare Function MakeChild() As Child"
        ].join("\n"));
    for (const [statement, internal] of [
        ["Print instance.", false], ["Print instance.pub", false], ["Print instance.   pub", false],
        ["Print pointerValue->", false], ["Print pointerValue->pub", false],
        ["Print arrayValues(0).", false], ["Print MakeChild().", false],
        ["    Print This.", true], ["    Print This.prot", true], ["    Return This.prot", true]
    ]) {
        const replaced = internal ? "    Print This.protectedValue" : "Print instance.publicValue";
        const text = source.replace(replaced, statement);
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
        try {
            assert.equal(reply.partial, true, statement);
            const position = pointAt(text, statement, statement.length);
            const completion = (await worker.query(reply.snapshotId, "completion", {
                ...input, openFiles: [filePath], position, limit: 100
            })).result;
            assert.equal(completion.member, true, statement);
            const names = completion.entries.map((entry) => entry.name);
            assert.ok(names.includes("publicValue"), statement);
            assert.ok(names.includes("ownValue"), statement);
            assert.equal(names.includes("protectedValue"), internal, statement);
            assert.ok(!names.includes("privateValue"), statement);
            const receiver = statement.match(/(?:This|instance|pointerValue|arrayValues|MakeChild)/)[0];
            const receiverPosition = pointAt(text, statement, statement.indexOf(receiver));
            assert.deepEqual((await worker.query(reply.snapshotId, "definition", {
                ...input, openFiles: [filePath], position: receiverPosition
            })).result, [], "completion receipts must not revive retracted navigation bindings");
            assert.equal((await worker.query(reply.snapshotId, "expression", {
                ...input, openFiles: [filePath], position: receiverPosition,
                end: { ...receiverPosition, character: receiverPosition.character + receiver.length }
            })).result, null, "completion receipts must not revive invalid expression types");
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), original, "completion must leave the saved input unchanged");
});

test("current compiler keeps contextual THREAD bindings separate from THREAD LOCAL storage", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/contextual-thread.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    for (const sidecar of [true, false]) {
        const reply = await worker.analyze({ ...options, compilerPath: sidecar ? process.env.FBC_EXECUTABLE : options.compilerPath,
            semanticModelOnly: sidecar, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            for (const [line, character, declarationLine] of [[11, 8, 8], [12, 14, 8], [16, 18, 14]]) {
                const targets = (await worker.query(reply.snapshotId, "definition", { ...input, position: { line, character } })).result;
                assert.equal(targets.length, 1, `${sidecar ? "stock" : "bridge"}: THREAD at line ${line + 1}`);
                assert.equal(targets[0].declaration.line, declarationLine, "the field and namespace variable must keep separate native identities");
            }
            assert.deepEqual((await worker.query(reply.snapshotId, "definition", { ...input,
                position: { line: 6, character: 1 } })).result, [], "the THREAD LOCAL modifier is not a variable reference");
            const hover = (await worker.query(reply.snapshotId, "hover", { ...input,
                position: pointAt(text, "perThread", 1) })).result;
            const storage = hover.compilerStorageClass || hover.entries[0]?.declaration.compilerFacts?.compilerStorageClass;
            assert.equal(storage, "thread-local", `${sidecar ? "stock" : "bridge"}: TLS storage must survive the native declaration-fact boundary`);
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), text);
});

test("rejected declarations preserve compiler diagnostics and independent unsaved analysis", native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const saved = fs.readFileSync(filePath, "utf8");
    for (const rejected of ["Dim repeated As Long\nDim repeated As Long", "Dim kept As Long = 2",
        "Dim repeated As Long\nDim acceptedBefore As Long, repeated As Long, acceptedAfter As Long"]) {
        const text = "Dim kept As Long = 3\n" + rejected + "\nDim laterValue As Long = 4\nPrint kept + laterValue\n";
        const probePath = path.join(directory, "rejected.bas");
        fs.writeFileSync(probePath, text);
        const arguments_ = ["-r", probePath, "-o", path.join(directory, "rejected.asm")];
        const disabled = spawnSync(options.compilerPath, arguments_, { cwd: directory, encoding: "utf8", timeout: 30000 });
        const enabled = spawnSync(options.compilerPath,
            [...arguments_, "-semantic-model", path.join(directory, "rejected.fbcsem")],
            { cwd: directory, encoding: "utf8", timeout: 30000 });
        assert.equal(disabled.status, 1, disabled.stderr);
        assert.equal(enabled.status, 1, enabled.stderr);
        assert.equal(enabled.stdout, disabled.stdout, "sidecar export must not add an internal failure to source diagnostics");
        assert.equal(enabled.stderr, disabled.stderr, "semantic failure reporting must remain reserved for actual producer faults");
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: true, allowSemanticSidecarFallback: false }, preparation);
        try {
            assert.equal(reply.partial, true);
            assert.ok(reply.diagnostics.some((diagnostic) => diagnostic.code === 4), "the duplicate-definition diagnostic must remain");
            const result = (await worker.query(reply.snapshotId, "expression", { ...input,
                position: pointAt(text, "kept + laterValue", 1) })).result;
            assert.ok(result && /^(?:long|integer)$/i.test(result.typeName), "a rejected declaration must not erase an independent typed expression");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), saved);
});

test("native public member completion survives unclosed WITH scopes without restoring bindings", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const prefix = fs.readFileSync(path.join(__dirname, "fixtures/compound-method-signatures.bas"), "utf8");
    fs.writeFileSync(filePath, prefix);
    input.openFiles = [filePath];
    // Worker replies retain public candidates; the editor filters their prefix.
    for (const [before, statement, expected] of [["With services(0)\n", "    .Mea", "Measure"],
        ["With services(0)\n", "    .", "value"], ["With services(0)\n", "    .Hid", "value"],
        ["", ".Mea", null], ["With unknownService\n", "    .Mea", null]]) {
        const text = prefix + before + statement;
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
            exportSemanticExpressions: true, exportSemanticBindings: false }, preparation);
        try {
            assert.equal(reply.partial, true);
            const position = { line: prefix.split("\n").length + before.split("\n").length - 2, character: statement.length };
            const result = (await worker.query(reply.snapshotId, "completion", { ...input, position })).result;
            assert.equal(result?.member, true, statement);
            if (expected) assert.ok(result.entries.some((entry) => entry.name === expected), statement);
            else assert.deepEqual(result.entries, [], "a private/missing receiver must not borrow public candidates");
            assert.ok(result.entries.every((entry) => entry.name !== "HiddenMethod" &&
                !/amount As String/i.test(entry.declaration.signature)));
            assert.deepEqual((await worker.query(reply.snapshotId, "definition", { ...input, position })).result, [],
                "a completion candidate is not a binding for an unfinished member name");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), prefix);
});

test("native name completion retains lexical scope in broken unsaved statements", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const original = fs.readFileSync(filePath, "utf8");
    const source = "#define VISIBLE_EDIT_MACRO 1\n#define REMOVED_EDIT_MACRO 1\n#undef REMOVED_EDIT_MACRO\n" +
        fs.readFileSync(path.join(__dirname, "integration/workspace/compiler-scopes.bas"), "utf8")
            .replace("    Dim localValue As Long", "    Dim brokenLocal As\n    Dim localValue As Long")
            .replace("    Print localValue", "    Print localValue\n    Dim declaredLater As Long");
    for (const [before, after, expected, excluded] of [
        ["    Print localValue", "    Print loc", ["localValue", "amount", "ownValue"], ["branchValue", "loopValue", "declaredLater"]],
        ["    Print localValue", "    Print loc" + " ".repeat(2048), ["localValue", "amount"], ["branchValue", "loopValue", "declaredLater"]],
        ["        Print branchValue", "        Print bra", ["branchValue", "localValue", "amount", "ownValue"], ["loopValue", "declaredLater"]],
        ["Print instance.ownValue", "Print inst", ["instance", "sharedValue"], ["localValue", "amount", "branchValue"]]
    ]) {
        const text = source.replace(before, after);
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
        try {
            assert.equal(reply.partial, true, after);
            const position = { line: text.split("\n").findIndex((line) => line === after), character: after.length };
            assert.ok(position.line >= 0, after);
            const completion = (await worker.query(reply.snapshotId, "completion", {
                ...input, openFiles: [filePath], position, limit: 2000
            })).result;
            assert.equal(completion.member, false, after);
            const names = completion.entries.map((entry) => entry.name);
            for (const name of [...expected, "VISIBLE_EDIT_MACRO"]) assert.ok(names.includes(name), after + ": " + name);
            for (const name of [...excluded, "brokenLocal", "REMOVED_EDIT_MACRO"]) assert.ok(!names.includes(name), after + ": " + name);
            if (expected.includes("ownValue")) {
                assert.equal(completion.entries.find((entry) => entry.name === "ownValue").declaration.typeName, "double",
                    "an enclosing local must shadow the implicit field even inside a nested block");
            }
            if (expected.includes("branchValue")) {
                assert.equal(completion.entries.find((entry) => entry.name === "branchValue").declaration.typeName, "long",
                    "the sibling ELSE declaration must not replace the current IF-local identity");
            }
            assert.deepEqual((await worker.query(reply.snapshotId, "definition", {
                ...input, openFiles: [filePath], position
            })).result, [], "an incomplete name must remain unresolved");
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("native completion retains compiler scopes on empty unsaved lines", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const original = fs.readFileSync(filePath, "utf8");
    const source = "#define EMPTY_LINE_MACRO 1\n" +
        fs.readFileSync(path.join(__dirname, "integration/workspace/compiler-scopes.bas"), "utf8");
    for (const [before, expected, excluded, gap = "    \n"] of [
        ["    Print localValue", ["localValue", "amount", "ownValue"], ["branchValue", "loopValue", "index"]],
        ["    Print localValue", ["localValue", "amount"], ["branchValue", "loopValue", "index"], "    /' scope note '/\n    \n"],
        ["        Print branchValue", ["branchValue", "localValue", "amount"], ["loopValue", "index"]],
        ["Print instance.ownValue", ["instance", "sharedValue"], ["localValue", "amount", "branchValue"]]
    ]) {
        const insertion = source.indexOf(before);
        assert.ok(insertion >= 0);
        const text = source.slice(0, insertion) + gap + source.slice(insertion);
        const position = { line: pointAt(text, before).line - 1, character: 4 };
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
        try {
            assert.equal(reply.partial, false);
            const completion = (await worker.query(reply.snapshotId, "completion", {
                ...input, openFiles: [filePath], position, limit: 2000
            })).result;
            const names = completion.entries.map((entry) => entry.name);
            assert.ok(names.includes("EMPTY_LINE_MACRO"));
            for (const name of expected) assert.ok(names.includes(name), before + ": " + name);
            for (const name of excluded) assert.ok(!names.includes(name), before + ": " + name);
            assert.deepEqual((await worker.query(reply.snapshotId, "definition", {
                ...input, openFiles: [filePath], position
            })).result, [], "empty-line completion must not create a navigation binding");
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
    for (const literal of ['"literal"', '!"escaped\\ntext"', '"Unicode café 😀"']) {
        const statement = "    Print " + literal;
        const literalGap = (literal.includes("Unicode") ? "\uFEFF" : "") +
            source.replace("    Print localValue", statement + "\n    \n    Print localValue");
        const literalReply = await worker.analyze({ ...options, overlays: new Map([[filePath, literalGap]]) }, preparation);
        try {
            assert.equal(literalReply.partial, false, literal);
            const line = pointAt(literalGap, statement).line + 1;
            const completion = (await worker.query(literalReply.snapshotId, "completion", {
                ...input, openFiles: [filePath], position: { line, character: 4 }, limit: 2000
            })).result;
            const names = completion.entries.map((entry) => entry.name);
            assert.ok(names.includes("EMPTY_LINE_MACRO"), "literal anchors must retain the compiler's macro epoch");
            for (const name of ["localValue", "amount", "ownValue"]) assert.ok(names.includes(name), literal + ": " + name);
            for (const name of ["branchValue", "loopValue", "index"]) assert.ok(!names.includes(name), literal + ": " + name);
            const literalPosition = pointAt(literalGap, statement, statement.indexOf(literal) + 1);
            assert.deepEqual((await worker.query(literalReply.snapshotId, "definition", {
                ...input, openFiles: [filePath], position: literalPosition
            })).result, [], "completion literal anchors must not become navigation bindings");
        } finally {
            worker.releaseModel(literalReply.snapshotId);
        }
    }
    const inactive = source.replace("    Print localValue", "    #if 0\n    \n    #endif\n    Print localValue");
    const inactiveReply = await worker.analyze({ ...options, overlays: new Map([[filePath, inactive]]) }, preparation);
    try {
        const line = pointAt(inactive, "    #if 0").line + 1;
        const completion = (await worker.query(inactiveReply.snapshotId, "completion", {
            ...input, openFiles: [filePath], position: { line, character: 4 }, limit: 2000
        })).result;
        assert.deepEqual(completion.entries.filter((entry) => entry.declaration.type !== "macro"), [],
            "an unmapped preprocessor branch must not inherit a nearby native scope");
    } finally {
        worker.releaseModel(inactiveReply.snapshotId);
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("native EOF completion uses compiler module closure without leaking previous scopes", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const sources = [
        ["Dim moduleValue As Double", "Sub Work(ByVal hidden As Long)", "    Dim localOnly As Long", "End Sub", "    ", ""],
        ["Namespace Imported", "    Dim Shared importedValue As Long", "End Namespace", "Using Imported", "    ", ""],
        ["Dim moduleValue As Double", 'Print "literal café 😀"', "    ", ""],
        ["Dim moduleValue As Double", "#define LATER_MACRO 2", "    ", ""],
        ["Dim moduleValue As Double", "#define RETIRED_MACRO 2", "#undef RETIRED_MACRO", "    ", ""],
        ["Dim moduleValue As Double", "    ", "' trailing module note", ""]
    ];
    for (const lines of sources) {
        const text = "#define END_MACRO 1\n" + lines.join("\n");
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
        try {
            assert.equal(reply.partial, false);
            const position = { line: text.split("\n").findIndex((line) => line === "    "), character: 4 };
            const completion = (await worker.query(reply.snapshotId, "completion", {
                ...input, openFiles: [filePath], position, limit: 2000
            })).result;
            const names = completion.entries.map((entry) => entry.name);
            assert.ok(names.includes("END_MACRO"));
            assert.ok(names.includes(text.includes("importedValue") ? "importedValue" : "moduleValue"));
            assert.ok(!names.includes("hidden") && !names.includes("localOnly"));
            assert.ok(!names.includes("RETIRED_MACRO"));
            if (text.includes("LATER_MACRO")) assert.ok(names.includes("LATER_MACRO"));
            assert.deepEqual((await worker.query(reply.snapshotId, "definition", {
                ...input, openFiles: [filePath], position
            })).result, [], "the module-end completion point is not an identifier origin");
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
});

test("native EOF completion preserves module facts after independently positioned errors", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    for (const lines of [
        ["Dim moduleValue As Double", "Print missingValue", "    ", ""],
        ["Dim moduleValue As Double", "Sub Work(ByVal hidden As Long)", "    Dim localOnly As Long",
            "    Print missingValue", "End Sub", "    ", ""],
        ["Namespace Imported", "    Dim Shared importedValue As Long", "    Print missingValue",
            "End Namespace", "Using Imported", "    ", ""],
        ["Dim moduleValue As Double", "Print missingValue", "Print otherMissingValue", "    ", ""],
        ["Dim moduleValue As Double", '#line 200 "logical-name.bas"', "Print missingValue", "    ", ""]
    ]) {
        const text = "#define ACTIVE_EOF_MACRO 1\n" + lines.join("\n");
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
        try {
            assert.equal(reply.partial, true);
            const position = { line: text.split("\n").findIndex((line) => line === "    "), character: 4 };
            const completion = (await worker.query(reply.snapshotId, "completion", {
                ...input, openFiles: [filePath], position, limit: 2000
            })).result;
            const names = completion.entries.map((entry) => entry.name);
            const expected = text.includes("importedValue") ? "importedValue" : "moduleValue";
            assert.ok(names.includes(expected), expected);
            assert.ok(names.includes("ACTIVE_EOF_MACRO"));
            for (const excluded of ["hidden", "localOnly", "missingValue", "otherMissingValue"]) {
                assert.ok(!names.includes(excluded), excluded);
            }
            assert.deepEqual((await worker.query(reply.snapshotId, "definition", {
                ...input, openFiles: [filePath], position
            })).result, [], "completion must not restore an EOF navigation binding");
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
});

test("native EOF completion withholds unproven root scopes and included-header contexts", native, async (t) => {
    const { directory, worker, filePath, options, preparation, input } = setup(t, true);
    for (const text of [
        "Dim moduleValue As Long\nSub Work(ByVal hidden As Long)\n    Dim localOnly As Long\n    \n",
        "Dim moduleValue As Long\nNamespace OpenSpace\n    Dim nestedOnly As Long\n    \n",
        "Dim moduleValue As Long\nIf 1 Then\n    Dim nestedOnly As Long\n    \n",
        "Dim moduleValue As Long\nFor counter As Long=0 To 1\n    Dim nestedOnly As Long\n    \n",
        "Dim moduleValue As Long\nType OpenType\n    fieldOnly As Long\n    \n",
        "Dim moduleValue As Long\nEnum OpenEnum\n    memberOnly\n    \n",
        "Dim moduleValue As Long\nSelect Case moduleValue\nCase 1\n    Dim nestedOnly As Long\n    \n",
        "Dim moduleValue As Long\nPrint moduleValue\n#macro Wrapped(a)\n Print a\n    \n",
        "Dim moduleValue As Long\n#if 1\n    \n",
        "Dim moduleValue As Long\n/' unfinished comment\n    \n"
    ]) {
        const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
        try {
            assert.equal(reply.partial, true);
            const completion = (await worker.query(reply.snapshotId, "completion", {
                ...input, openFiles: [filePath], position: pointAt(text, "    \n", 4), limit: 2000
            })).result;
            assert.deepEqual(completion.entries.filter((entry) => entry.declaration.type !== "macro"), [],
                "unclosed scopes and unpositioned errors do not prove an EOF context");
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
    const headerPath = path.join(directory, "completion-eof.bi");
    const header = "Dim headerLocal As Long\n    \n";
    fs.writeFileSync(headerPath, header);
    const text = ["Dim moduleValue As Long", "Sub Work(ByVal hidden As Long)",
        '#include "completion-eof.bi"', "    Print hidden + headerLocal", "End Sub", ""].join("\n");
    const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
    try {
        assert.equal(reply.partial, false);
        const completion = (await worker.query(reply.snapshotId, "completion", {
            uri: { scheme: "file", fsPath: headerPath }, openFiles: [filePath, headerPath],
            position: pointAt(header, "    \n", 4), limit: 2000
        })).result;
        assert.deepEqual(completion.entries.filter((entry) => entry.declaration.type !== "macro"), [],
            "module closure is not a receipt for an included header's lexical scope");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native completion includes forward labels without leaking another procedure's labels", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "If 0 Then", "moduleFinish:", "End If", "Goto mod",
        "Sub Work()", "    Goto fin", "    If 0 Then", "finish:", "    Print 1", "    End If", "End Sub",
        "Sub Other()", "otherFinish:", "    Print 2", "End Sub", "Work()", ""
    ].join("\n");
    const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]) }, preparation);
    try {
        assert.equal(reply.partial, true);
        const completion = (await worker.query(reply.snapshotId, "completion", {
            ...input, openFiles: [filePath], position: pointAt(text, "    Goto fin", "    Goto fin".length), limit: 100
        })).result;
        assert.deepEqual(completion.entries.filter((entry) => entry.declaration.type === "label").map((entry) => entry.name),
            ["finish"], "labels are procedure-wide, but another procedure is a separate compiler scope");
        const moduleCompletion = (await worker.query(reply.snapshotId, "completion", {
            ...input, openFiles: [filePath], position: pointAt(text, "Goto mod", "Goto mod".length), limit: 100
        })).result;
        assert.deepEqual(moduleCompletion.entries.filter((entry) => entry.declaration.type === "label").map((entry) => entry.name),
            ["moduleFinish"], "a module-owned label remains visible outside its physical IF block");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

for (const sidecar of [true, false]) test(`compiler parameter hints cover bare calls (${sidecar ? "sidecar" : "bridge"})`, native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/bare-signature-help.bas"), "utf8")
        .replace("Sub SelectValues Overload(ByVal first As Long", "Sub SelectValues Overload(ByVal wholeValue As Long")
        .replace("Sub SelectValues Overload(ByVal first As Double", "Sub SelectValues Overload(ByVal fractionalValue As Double")
        .replace("'' end of bare-signature-help.bas", [
            'BareCalls.AcceptValues 4, "optional"',
            'receiver.SetValues(3, "parenthesized")',
            'Sub AssignValue(ByRef destination As Long)',
            'End Sub',
            'Dim suppliedResult As Long',
            'AssignValue suppliedResult',
            'Type StaticReceiver',
            '    value As Long',
            '    Declare Static Sub ApplyValue(ByVal amount As Long)',
            'End Type',
            'Sub StaticReceiver.ApplyValue(ByVal amount As Long)',
            'End Sub',
            'StaticReceiver.ApplyValue 8',
            'BareCalls.AcceptValues 5, "first" & Chr(65), 6',
            "'' end of bare-signature-help.bas"
        ].join("\n"));
    fs.writeFileSync(filePath, text);
    const compilerPath = sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath;
    const compiled = spawnSync(compilerPath, ["-c", filePath, "-o", path.join(path.dirname(filePath), "bare-inlays.o")], { encoding: "utf8" });
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    const reply = await worker.analyze({
        ...options,
        compilerPath,
        semanticModelOnly: sidecar,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.partial, false);
    try {
        const hints = (await worker.query(reply.snapshotId, "compilerParameterInlayHints", {
            ...input, position: { line: 0, character: 0 }, end: pointAt(text, "'' end of bare-signature-help.bas")
        })).result;
        for (const [spelling, prefix, label] of [
            ['BareCalls.AcceptValues CLng(1)', 'BareCalls.AcceptValues ', 'first:'],
            ['"a,b", 3', '', 'second:'],
            ['"continued,argument", _', '', 'second:'],
            ['    3\nBareCalls.SelectValues', '    ', 'third:'],
            ['BareCalls.SelectValues CDbl(2)', 'BareCalls.SelectValues ', 'fractionalValue:'],
            ['receiver.SetValues 1, "member"', 'receiver.SetValues ', 'first:'],
            ['"member"', '', 'second:'],
            ['receiverPointer->SetValues 2, "pointer"', 'receiverPointer->SetValues ', 'first:'],
            ['"pointer"', '', 'second:'],
            ['"inline", 2 Else', '', 'second:'],
            ['"else", 3', '', 'second:'],
            ['BareCalls.AcceptValues 4, "optional"', 'BareCalls.AcceptValues ', 'first:'],
            ['"optional"', '', 'second:'],
            ['receiver.SetValues(3, "parenthesized")', 'receiver.SetValues(', 'first:'],
            ['"parenthesized"', '', 'second:'],
            ['AssignValue suppliedResult', 'AssignValue ', 'destination:'],
            ['StaticReceiver.ApplyValue 8', 'StaticReceiver.ApplyValue ', 'amount:'],
            ['"first" & Chr(65)', '', 'second:']
        ]) {
            const position = pointAt(text, spelling, prefix.length);
            assert.ok(hints.some((hint) => hint.label === label && hint.position.line === position.line &&
                hint.position.character === position.character), `${spelling}: ${JSON.stringify(hints)}`);
        }
        assert.ok(hints.some((hint) => hint.label === "destination:" && hint.passingMode === "byref"));
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

for (const sidecar of [true, false]) test(`parameter hint navigation selects physical header parameters (${sidecar ? "sidecar" : "bridge"})`, native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "hint-api.bi");
    const header = [
        "Declare Function SelectHint Overload(ByVal wholeNumber As Long, _",
        "    ByRef labelText As String) As Long",
        "Declare Function SelectHint Overload(ByVal fractionalNumber As Double) As Double",
        "Type HintOwner", "    number As Long",
        "    Declare Constructor(ByVal seed As Long)",
        "    Declare Sub SetValue(ByVal nextValue As Long)", "End Type", ""
    ].join("\n");
    const text = [
        '#include "hint-api.bi"',
        "Function SelectHint(ByVal wholeNumber As Long, ByRef labelText As String) As Long",
        "    Return wholeNumber", "End Function",
        "Function SelectHint(ByVal fractionalNumber As Double) As Double",
        "    Return fractionalNumber", "End Function",
        "Constructor HintOwner(ByVal seed As Long)", "    number = seed", "End Constructor",
        "Sub HintOwner.SetValue(ByVal nextValue As Long)", "    number = nextValue", "End Sub",
        'Dim description As String = "label"', "Print SelectHint(1, description)",
        "Print SelectHint(1.5)", "Dim receiver As HintOwner = HintOwner(3)",
        "receiver.SetValue(7)", ""
    ].join("\n");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(filePath, text);
    const compilerPath = sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath;
    const reply = await worker.analyze({ ...options, compilerPath, semanticModelOnly: sidecar,
        exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false);
    try {
        const hints = (await worker.query(reply.snapshotId, "compilerParameterInlayHints", {
            ...input, position: { line: 0, character: 0 }, end: { line: text.split("\n").length - 1, character: 0 }
        })).result;
        for (const [call, argument, parameter] of [
            ["Print SelectHint(1, description)", "1", "wholeNumber"],
            ["Print SelectHint(1, description)", "description", "labelText"],
            ["Print SelectHint(1.5)", "1.5", "fractionalNumber"],
            ["HintOwner(3)", "3", "seed"],
            ["receiver.SetValue(7)", "7", "nextValue"]
        ]) {
            const position = pointAt(text, call, call.indexOf(argument));
            const hint = hints.find((hint) => hint.position.line === position.line && hint.position.character === position.character);
            assert.equal(hint?.parameterName, parameter, `${call}: ${JSON.stringify(hints)}`);
            const target = pointAt(header, parameter);
            assert.deepEqual(hint.declarationLocation, { filePath: headerPath, line: target.line,
                startColumn: target.character, endColumn: target.character + parameter.length },
            "the selected overload's physical parameter, not its body or another overload, should be clickable");
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native document links retain selected include paths across contexts", native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    fs.writeFileSync(filePath, '#ifdef FIRST_LINK\n#include once "selected.bi"\n#else\n#include once "selected.bi"\n#endif\nPrint selectedIncludeValue\n');
    for (const [name, value] of [["first", 1], ["second", 2]]) {
        fs.mkdirSync(path.join(directory, name));
        fs.writeFileSync(path.join(directory, name, "selected.bi"), `Const selectedIncludeValue = ${value}\n`);
    }
    for (const [name, line] of [["first", 1], ["second", 3]]) {
        const reply = await worker.analyze({ ...options, exportSemanticExpressions: true,
            compilerArguments: [...(name === "first" ? ["-d", "FIRST_LINK"] : []), "-i", path.join(directory, name)]
        }, preparation);
        assert.equal(reply.partial, false);
        try {
            const links = (await worker.query(reply.snapshotId, "documentLinks", input)).result;
            assert.equal(links.length, 1, `${name}: ${JSON.stringify(links)}`);
            assert.equal(links[0].target, path.join(directory, name, "selected.bi"));
            assert.equal(links[0].start.line, line);
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
});

test("native destructor callers expand through selected cleanup receipts", native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/destructor-hierarchy.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    const executable = path.join(directory, "destructor-hierarchy");
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const compiled = spawnSync(process.env.FBC_EXECUTABLE || options.compilerPath,
        ["-prefix", root, filePath, "-x", executable], { encoding: "utf8" });
    assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    const executed = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
    const reply = await worker.analyze({ ...options, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false);
    try {
        const helper = pointAt(text, "Sub RecordCleanup", "Sub ".length + 1);
        const incoming = (await worker.query(reply.snapshotId, "callHierarchyIncoming", { ...input, position: helper })).result;
        const destructor = incoming.find((entry) => entry.declaration.type === "destructor");
        assert.ok(destructor, "the destructor body must remain the helper's caller");
        assert.deepEqual([destructor.declaration.startColumn, destructor.declaration.endColumn], [0, 10],
            "native lifetime hierarchy selects the callable keyword, not its type label");
        const position = { line: destructor.declaration.line, character: destructor.declaration.startColumn };
        const callers = (await worker.query(reply.snapshotId, "callHierarchyIncoming", { ...input, position })).result;
        assert.deepEqual(callers.map((entry) => entry.name).sort(), ["LeaveEarly", "LeaveScope", "ReleaseOne", "main.bas"],
            "cleanup sites must retain their owning procedure and exclude the other destructor");
        const receipts = (await worker.query(reply.snapshotId, "compilerSidecarImplicitCallsInSnapshot", input)).result;
        const kinds = new Set(receipts.calls.filter((call) => call.procedures.some((procedure) =>
            procedure.filePath === filePath && procedure.startLine === destructor.declaration.line + 1)).map((call) => call.kind));
        for (const kind of ["delete-destructor", "destructor-call", "scope-exit-destructor", "temporary-destructor"]) {
            assert.ok(kinds.has(kind), `the compiler fixture must cover ${kind}: ${[...kinds]}`);
        }
        const references = (await worker.query(reply.snapshotId, "references", { ...input, position, includeDeclaration: true })).result;
        const highlights = (await worker.query(reply.snapshotId, "highlights", { ...input, position })).result;
        const sites = callers.flatMap((entry) => entry.fromRanges);
        for (const site of sites) {
            assert.ok(references.some((reference) => reference.occurrence.line === site.line &&
                reference.occurrence.startColumn === site.startColumn), "selected cleanup must also be a destructor reference");
            assert.ok(highlights.some((reference) => reference.occurrence.line === site.line &&
                reference.occurrence.startColumn === site.startColumn), "selected cleanup must also be highlighted");
        }
        const outgoing = (await worker.query(reply.snapshotId, "callHierarchyOutgoing", { ...input, position })).result;
        assert.deepEqual(outgoing.map((entry) => entry.name), ["RecordCleanup"]);
        for (const caller of callers) {
            const module = caller.declaration.type === "module";
            const callees = (await worker.query(reply.snapshotId, "callHierarchyOutgoing", { ...input,
                position: { line: caller.declaration.line, character: caller.declaration.startColumn }, module
            })).result;
            const cleanup = callees.filter((entry) => entry.declaration.type === "destructor" &&
                entry.declaration.line === destructor.declaration.line);
            assert.equal(cleanup.length, 1, `${caller.name}: outgoing calls must retain the selected cleanup routine`);
            assert.deepEqual([cleanup[0].declaration.startColumn, cleanup[0].declaration.endColumn],
                [destructor.declaration.startColumn, destructor.declaration.endColumn],
                "incoming and outgoing native targets must use the same selection anchor");
            const siteKey = (site) => `${site.line}:${site.startColumn}:${site.endLine ?? site.line}:${site.endColumn}`;
            assert.deepEqual(cleanup[0].fromRanges.map(siteKey).sort(), caller.fromRanges.map(siteKey).sort(),
                "incoming and outgoing cleanup must describe the same physical sites");
            const constructors = callees.filter((entry) => entry.declaration.type === "constructor");
            assert.equal(constructors.length, 1, `${caller.name}: initialization must retain its selected constructor`);
            assert.equal(new Set(constructors[0].fromRanges.map(siteKey)).size, constructors[0].fromRanges.length,
                "an explicit constructor already present in procedure bindings must not be duplicated");
            if (!module) assert.equal(callees.some((entry) => entry.declaration.type === "destructor" &&
                entry.declaration.line !== destructor.declaration.line), false, "unrelated cleanup must not leak into this procedure");
        }
        const prototype = pointAt(text, "Declare Destructor", "Declare ".length + 1);
        const prototypeCallers = (await worker.query(reply.snapshotId, "callHierarchyIncoming", { ...input, position: prototype })).result;
        assert.deepEqual(prototypeCallers.map((entry) => entry.name).sort(), callers.map((entry) => entry.name).sort(),
            "the native prototype must join its body before looking up semantic cleanup targets");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native constructor graph calls do not duplicate qualified initializer receipts", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/namespace-initializer-calls.bas"), "utf8")
        .replace("Type TrackedValue\n", "Namespace TypeScope\nType TrackedValue\n")
        .replace("End Constructor\n", "End Constructor\nEnd Namespace\n")
        .replace(/As TrackedValue = TrackedValue/g, "As TypeScope.TrackedValue = TypeScope.TrackedValue");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false);
    try {
        const position = pointAt(text, "Constructor TrackedValue(");
        const incoming = (await worker.query(reply.snapshotId, "callHierarchyIncoming", { ...input, position })).result;
        const module = incoming.find((entry) => entry.declaration.type === "module");
        assert.equal(module?.fromRanges.length, 3, "one declaration initialization must remain one incoming constructor site");
        assert.equal(incoming.filter((entry) => entry.declaration.type !== "module").length, 1);
        const outgoing = (await worker.query(reply.snapshotId, "callHierarchyOutgoing", { ...input,
            position: { line: 0, character: 0 }, module: true })).result;
        const constructor = outgoing.filter((entry) => entry.declaration.type === "constructor");
        assert.equal(constructor.length, 1);
        assert.deepEqual(constructor[0].fromRanges, module.fromRanges, "both directions must use the same deduplicated receipts");
        assert.equal(outgoing.filter((entry) => entry.name === "ModuleAction").length, 1);
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

function temporaryConstructorSource() {
    return fs.readFileSync(path.join(__dirname, "fixtures/temporary-constructor-calls.bas"), "utf8");
}

test("native explicit temporary constructors retain selected hierarchy without implicit receipts", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = temporaryConstructorSource();
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false);
    try {
        const receipts = (await worker.query(reply.snapshotId, "compilerSidecarImplicitCallsInSnapshot", input)).result;
        assert.deepEqual(receipts.calls, [], "this fixture must exercise native CALLs rather than implicit I receipts");
        for (const [spelling, type, module, call] of [
            ["Sub MakeTemporary()", "Long", false, "TemporaryValue(CLng(1))"],
            ["", "Double", true, "TemporaryValue(CDbl(2))"]
        ]) {
            const position = module ? { line: 0, character: 0 } : pointAt(text, spelling, "Sub ".length + 1);
            const outgoing = (await worker.query(reply.snapshotId, "callHierarchyOutgoing", { ...input, position, module })).result;
            const constructors = outgoing.filter((entry) => entry.declaration.type === "constructor");
            assert.equal(constructors.length, 1, `${type}: the written temporary needs one constructor edge`);
            assert.match(constructors[0].declaration.signature, new RegExp(`initialValue As ${type}`, "i"));
            const site = pointAt(text, call);
            const prepared = (await worker.query(reply.snapshotId, "callHierarchyPrepare", { ...input, position: site })).result;
            assert.equal(prepared.length, 1, "preparing a written temporary must use its native selected constructor");
            assert.equal(prepared[0].declaration.type, "constructor");
            assert.deepEqual(constructors[0].fromRanges.map((range) => [range.line, range.startColumn, range.endColumn]),
                [[site.line, site.character, site.character + "TemporaryValue".length]]);
            const target = { line: constructors[0].declaration.line, character: constructors[0].declaration.startColumn };
            const incoming = (await worker.query(reply.snapshotId, "callHierarchyIncoming", { ...input, position: target })).result;
            assert.deepEqual(incoming.map((entry) => entry.name), [module ? "main.bas" : "MakeTemporary"],
                "the other constructor overload must not acquire this call");
            const references = (await worker.query(reply.snapshotId, "references", { ...input, position: target })).result;
            assert.ok(references.some((entry) => entry.occurrence.line === site.line && entry.occurrence.startColumn === site.character));
            assert.equal(references.some((entry) => entry.occurrence.line === (module ? pointAt(text, "TemporaryValue(CLng(1))").line :
                pointAt(text, "TemporaryValue(CDbl(2))").line)), false, "constructor references must retain the selected overload");
            const highlights = (await worker.query(reply.snapshotId, "highlights", { ...input, position: target })).result;
            assert.ok(highlights.some((entry) => entry.occurrence.line === site.line && entry.occurrence.startColumn === site.character),
                "constructor highlights must also include its explicit temporary use");
            assert.equal(highlights.some((entry) => entry.occurrence.line === (module ? pointAt(text, "TemporaryValue(CLng(1))").line :
                pointAt(text, "TemporaryValue(CDbl(2))").line)), false, "constructor highlights must not mix overloads");
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock temporary construction observations retain selected physical constructor calls", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = temporaryConstructorSource().replace("'' end of temporary-constructor-calls.bas",
        "ConsumeTemporary(TemporaryValue())\nConsumeTemporary(Type<TemporaryValue>(CLng(3)))\n'' end of temporary-constructor-calls.bas");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false);
    try {
        const selected = (await worker.query(reply.snapshotId, "compilerSidecarImplicitCallsInSnapshot", input)).result;
        const calls = selected.calls.filter((call) => call.kind === "explicit-constructor");
        assert.equal(calls.length, 4, "stock FBC must retain typed, optional, and TYPE<> temporary construction selections");
        for (const [spelling, type] of [["TemporaryValue(CLng(1))", "Long"], ["TemporaryValue(CDbl(2))", "Double"],
            ["TemporaryValue()", "Long"], ["Type<TemporaryValue>(CLng(3))", "Long"]]) {
            const site = pointAt(text, spelling);
            const call = calls.find((call) => call.line === site.line && call.startColumn === site.character);
            assert.ok(call, `${spelling}: ${JSON.stringify(calls)}`);
            const target = pointAt(text, `Constructor TemporaryValue(ByVal initialValue As ${type})`);
            assert.ok(call.procedures.some((procedure) => procedure.filePath === filePath && procedure.startLine === target.line + 1));
            const references = (await worker.query(reply.snapshotId, "references", { ...input, position: target })).result;
            assert.ok(references.some((entry) => entry.occurrence.line === site.line && entry.occurrence.startColumn === site.character),
                `${spelling}: the selected constructor should retain its temporary reference`);
            const highlights = (await worker.query(reply.snapshotId, "highlights", { ...input, position: target })).result;
            assert.ok(highlights.some((entry) => entry.occurrence.line === site.line && entry.occurrence.startColumn === site.character));
            const callReferences = (await worker.query(reply.snapshotId, "references", { ...input, position: site })).result;
            assert.ok(callReferences.some((entry) => entry.occurrence.line === site.line && entry.occurrence.startColumn === site.character),
                "a reference request on the written construction must also use the selected constructor");
        }
        const inlays = (await worker.query(reply.snapshotId, "compilerInlayHints", { ...input,
            position: { line: 0, character: 0 }, end: { line: text.split("\n").length - 1, character: 0 }, parameterHints: true
        })).result;
        for (const spelling of ["TemporaryValue(CLng(1))", "TemporaryValue(CDbl(2))"]) {
            const site = pointAt(text, spelling, "TemporaryValue(".length);
            assert.ok(inlays.parameters.some((hint) => hint.parameterName === "initialValue" &&
                hint.position.line === site.line && hint.position.character === site.character),
            "typed constructor arguments should receive the selected formal's inlay hint");
        }
        const lenses = (await worker.query(reply.snapshotId, "compilerProcedureReferenceCodeLenses", input)).result;
        assert.equal(lenses.complete, true);
        for (const [type, count] of [["Long", 3], ["Double", 1]]) {
            const target = pointAt(text, `Constructor TemporaryValue(ByVal initialValue As ${type})`);
            const lens = lenses.entries.find((entry) => entry.line === target.line);
            assert.equal(lens?.references.length, count, `${type}: CodeLens must count the same selected temporary calls as references`);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

for (const sidecar of [true, false]) test(`typed temporary Signature Help selects its own constructor (${sidecar ? "sidecar" : "bridge"})`, native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const calls = [["Type<TemporaryAlias>(CLng(3))", "Long"],
        ["Type<ConstructionScope.TemporaryValue>(CDbl(4))", "Double"],
        ["Type<TypeOf(TemporaryAlias)>(CLng(5))", "Long"]];
    const text = fs.readFileSync(path.join(__dirname, "fixtures/qualified-temporary-constructor-calls.bas"), "utf8") +
        calls.map(([call]) => `ConsumeTemporary(${call})\n`).join("") +
        "Type PlainAggregate\nvalue As Long\nEnd Type\nDim plain As PlainAggregate = Type<PlainAggregate>(1)\n" +
        "Type Wrapper\nvalue As Long\nDeclare Constructor(ByRef incoming As PlainAggregate)\nEnd Type\n" +
        "Constructor Wrapper(ByRef incoming As PlainAggregate)\nThis.value = incoming.value\nEnd Constructor\n" +
        "Sub ConsumeWrapper(ByVal item As Wrapper)\nEnd Sub\nConsumeWrapper(Type<PlainAggregate>(2))\n";
    const saved = fs.readFileSync(filePath, "utf8");
    if (sidecar) fs.writeFileSync(filePath, text);
    else input.openFiles = [filePath];
    const reply = await worker.analyze({ ...options,
        compilerPath: sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
        semanticModelOnly: sidecar, overlays: sidecar ? undefined : new Map([[filePath, text]]),
        exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    try {
        assert.equal(reply.partial, false);
        for (const [call, type] of calls) {
            const result = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(text, call, call.lastIndexOf(">(") + 2) })).result;
            assert.equal(result?.context.typedConstructor, true, call);
            assert.equal(result.entries.length, 1, "prototype and body are one selected constructor, not separate overloads");
            assert.match(result.entries[0]?.declaration.signature || "", new RegExp(`initialValue As ${type}\\b`, "i"), call);
            assert.equal(result.entries[0].declaration.type, "constructor");
            assert.equal(result.entries[0].declaration.parameters[0].optional, type === "Long", "keep the selected prototype's default value");
            assert.equal(result.selectedCompilerSymbolId, result.entries[0].compilerSymbolId);
            const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position: pointAt(text, call, 1) })).result;
            const constructors = hover.entries.filter((entry) => entry.declaration.type === "constructor");
            assert.equal(constructors.length, 1, "hover on TYPE uses its selected constructor for " + call);
            assert.match(constructors[0].declaration.signature, new RegExp(`initialValue As ${type}\\b`, "i"));
            assert.equal(constructors[0].declaration.parameters[0].optional, type === "Long");
            for (const operation of ["definition", "declaration", "implementation"]) {
                const navigation = (await worker.query(reply.snapshotId, operation, { ...input, position: pointAt(text, call, 1) })).result;
                assert.equal(navigation.length, 1, `${operation} selects the constructor at ${call}`);
                assert.equal(navigation[0].declaration.type, "constructor");
                const spelling = operation === "declaration" ? `Declare Constructor(ByVal initialValue As ${type}`
                    : `Constructor TemporaryValue(ByVal initialValue As ${type}`;
                assert.equal(navigation[0].declaration.line, pointAt(text, spelling).line);
                assert.equal(navigation[0].declaration.modifiers.includes("DECLARE"), operation === "declaration");
            }
            const typeArgument = (await worker.query(reply.snapshotId, "hover", { ...input,
                position: pointAt(text, call, call.indexOf("Temporary") >= 0 ? call.indexOf("Temporary") : "Type<".length) })).result;
            assert.ok(typeArgument.entries.every((entry) => entry.declaration.type !== "constructor"),
                "type argument names do not become constructor hover sites");
        }
        const aggregate = (await worker.query(reply.snapshotId, "signature", { ...input,
            position: pointAt(text, "Type<PlainAggregate>(1)", "Type<PlainAggregate>(".length) })).result;
        assert.equal(aggregate, null, "an aggregate initializer without a selected constructor has no constructor signature");
        const aggregateHover = (await worker.query(reply.snapshotId, "hover", { ...input,
            position: pointAt(text, "Type<PlainAggregate>(1)", 1) })).result;
        assert.ok(aggregateHover.entries.every((entry) => entry.declaration.type !== "constructor"),
            "an aggregate-only initializer must not acquire a constructor hover");
        for (const operation of ["definition", "declaration", "implementation"]) {
            const converted = (await worker.query(reply.snapshotId, operation, { ...input,
                position: pointAt(text, "Type<PlainAggregate>(2)", 1) })).result;
            assert.deepEqual(converted, [], "the TYPE operation must not jump to its enclosing argument's conversion constructor");
        }
        const convertedHover = (await worker.query(reply.snapshotId, "hover", { ...input,
            position: pointAt(text, "Type<PlainAggregate>(2)", 1) })).result;
        assert.ok(convertedHover.entries.every((entry) => entry.declaration.type !== "constructor"),
            "the TYPE hover must not borrow its enclosing argument's conversion constructor");
        const plainPosition = pointAt(text, "Type<PlainAggregate>(2)", 1);
        const plainTarget = (await worker.query(reply.snapshotId, "lifetimeReferenceTarget", { ...input,
            position: plainPosition, includeDeclarations: true })).result;
        assert.deepEqual(plainTarget.entries, [], "aggregate-only TYPE has no lifetime reference identity");
        for (const operation of ["references", "highlights", "callHierarchyPrepare"]) assert.deepEqual(
            (await worker.query(reply.snapshotId, operation, { ...input, position: plainPosition })).result, [],
            "aggregate-only TYPE must not select the enclosing conversion for " + operation);
        const conversionReferences = (await worker.query(reply.snapshotId, "references", { ...input,
            position: pointAt(text, "Constructor Wrapper(ByRef incoming As PlainAggregate)", 1) })).result;
        assert.ok(conversionReferences.some((entry) => entry.occurrence.line === plainPosition.line),
            "the legitimate implicit conversion remains in its own reference family");
        const hints = (await worker.query(reply.snapshotId, "compilerParameterInlayHints", { ...input,
            position: { line: 0, character: 0 }, end: { line: text.split("\n").length - 1, character: 0 } })).result;
        for (const [call, type] of calls) {
            const point = pointAt(text, call, call.lastIndexOf(">(") + 2);
            const matching = hints.filter((hint) => hint.position.line === point.line && hint.position.character === point.character);
            assert.equal(matching.length, 1, "one selected constructor parameter hint for " + call);
            assert.equal(hints.filter((hint) => hint.position.line === point.line && hint.parameterName === "initialValue").length, 1,
                "constructor formals do not label the TYPEOF operand or duplicate trace-owned hints");
            assert.equal(matching[0].parameterName, "initialValue");
            const declaration = pointAt(text, `Declare Constructor(ByVal initialValue As ${type}`, "Declare Constructor(ByVal ".length);
            const location = matching[0].declarationLocation;
            assert.deepEqual(location && { line: location.line, character: location.startColumn }, declaration,
                "typed hints link to the selected physical formal");
        }
        const combined = (await worker.query(reply.snapshotId, "compilerInlayHints", { ...input,
            position: { line: 0, character: 0 }, end: { line: text.split("\n").length - 1, character: 0 }, parameterHints: true })).result;
        assert.deepEqual(combined.parameters, hints, "combined and parameter-only hint requests use the same native selections");
        assert.equal(fs.readFileSync(filePath, "utf8"), sidecar ? text : saved);
    } finally { worker.releaseModel(reply.snapshotId); }
});

for (const sidecar of [true, false]) test(`typed construction reference identity excludes enclosing conversions (${sidecar ? "sidecar" : "bridge"})`, native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/qualified-temporary-constructor-calls.bas"), "utf8") + [
        "Type ConvertedWrapper", "value As Long", "Declare Constructor(ByRef incoming As TemporaryAlias)", "End Type",
        "Constructor ConvertedWrapper(ByRef incoming As TemporaryAlias)", "This.value = incoming.number", "End Constructor",
        "Sub ConsumeConverted(ByVal item As ConvertedWrapper)", "End Sub", "ConsumeConverted(Type<TemporaryAlias>(CLng(6)))", ""
    ].join("\n");
    if (sidecar) fs.writeFileSync(filePath, text);
    else input.openFiles = [filePath];
    const reply = await worker.analyze({ ...options,
        compilerPath: sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
        semanticModelOnly: sidecar, overlays: sidecar ? undefined : new Map([[filePath, text]]),
        exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    try {
        assert.equal(reply.partial, false);
        const spelling = "Type<TemporaryAlias>(CLng(6))", position = pointAt(text, spelling, 1);
        const signature = (await worker.query(reply.snapshotId, "signature", { ...input,
            position: pointAt(text, spelling, "Type<TemporaryAlias>(".length) })).result;
        const target = (await worker.query(reply.snapshotId, "lifetimeReferenceTarget", { ...input, position, includeDeclarations: true })).result;
        assert.equal(target.entries.length, 1);
        assert.equal(target.entries[0].compilerSymbolId, signature.selectedCompilerSymbolId,
            "the explicit TYPE constructor, not its argument conversion, supplies project identity");
        const own = pointAt(text, "Constructor TemporaryValue(ByVal initialValue As Long)");
        const conversion = pointAt(text, "Constructor ConvertedWrapper(ByRef incoming As TemporaryAlias)");
        const references = (await worker.query(reply.snapshotId, "references", { ...input, position, includeDeclaration: true })).result;
        assert.ok(references.some((entry) => entry.occurrence.line === own.line), "references retain the explicit constructor");
        assert.equal(references.some((entry) => entry.occurrence.line === conversion.line), false, "conversion constructors have separate reference families");
        const highlights = (await worker.query(reply.snapshotId, "highlights", { ...input, position })).result;
        assert.ok(highlights.some((entry) => entry.occurrence.line === own.line));
        assert.equal(highlights.some((entry) => entry.occurrence.line === conversion.line), false);
        const prepared = (await worker.query(reply.snapshotId, "callHierarchyPrepare", { ...input, position })).result;
        assert.equal(prepared.length, 1, "shared source spans must not make an explicit constructor ambiguous");
        assert.equal(prepared[0].declaration.line, own.line);
    } finally { worker.releaseModel(reply.snapshotId); }
});

for (const sidecar of [true, false]) test(`qualified and aliased temporary constructors retain exact navigation (${sidecar ? "sidecar" : "bridge"})`, native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/qualified-temporary-constructor-calls.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, compilerPath: sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
        semanticModelOnly: sidecar, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false);
    try {
        for (const [spelling, type, prefix] of [["TemporaryAlias(CLng(1))", "Long", ""],
            ["ConstructionScope.TemporaryValue(CDbl(2))", "Double", "ConstructionScope."]]) {
            const site = pointAt(text, spelling, prefix.length);
            const target = pointAt(text, `Constructor TemporaryValue(ByVal initialValue As ${type})`);
            const references = (await worker.query(reply.snapshotId, "references", { ...input, position: target })).result;
            assert.ok(references.some((entry) => entry.occurrence.line === site.line && entry.occurrence.startColumn === site.character),
                `${spelling}: constructor references must identify the type or alias, not its namespace`);
            const lenses = (await worker.query(reply.snapshotId, "compilerProcedureReferenceCodeLenses", input)).result;
            assert.equal(lenses.complete, true);
            const lens = lenses.entries.find((entry) => entry.line === target.line);
            assert.deepEqual(lens?.references.map((reference) => [reference.line, reference.startColumn, reference.endColumn]),
                [[site.line, site.character, site.character + (prefix ? "TemporaryValue" : "TemporaryAlias").length]],
                "constructor CodeLens must use the same terminal source token as references");
            if (prefix) assert.equal(references.some((entry) => entry.occurrence.line === site.line &&
                entry.occurrence.startColumn === site.character - prefix.length), false,
            "the namespace prefix is not a separate constructor call");
            const signature = (await worker.query(reply.snapshotId, "signature", { ...input,
                position: pointAt(text, spelling, spelling.indexOf("(") + 1) })).result;
            if (sidecar) assert.equal(signature.selectedConstructorProcedure?.startLine, target.line + 1,
                `${spelling}: the written qualification must not hide the compiler-selected constructor signature`);
            else {
                assert.equal(signature.entries.length, 1);
                assert.match(signature.entries[0].declaration.signature, new RegExp(`initialValue As ${type}`, "i"));
            }
            const hints = (await worker.query(reply.snapshotId, "compilerInlayHints", { ...input, parameterHints: true,
                position: { line: site.line, character: 0 }, end: { line: site.line, character: text.split("\n")[site.line].length }
            })).result;
            const argument = pointAt(text, spelling, spelling.indexOf("(") + 1);
            assert.ok(hints.parameters.some((hint) => hint.parameterName === "initialValue" &&
                hint.position.line === argument.line && hint.position.character === argument.character));
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock destructor references use a header declaration without an included body", native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "external.bi");
    fs.writeFileSync(headerPath, "Type ExternalCleanup\nvalue As Long\nDeclare Destructor()\nEnd Type\n");
    const text = '#include "external.bi"\nDim allocated As ExternalCleanup Ptr = New ExternalCleanup\nDelete allocated\n';
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false);
    try {
        const descriptor = { filePath: path.join(directory, "not-in-this-pass.bas"), startLine: 5,
            declarations: [{ filePath: headerPath, line: 2 }] };
        const records = (await worker.query(reply.snapshotId, "references", { ...input,
            position: pointAt(text, "Delete allocated"), destructorProcedure: descriptor, includeDeclaration: true })).result;
        assert.ok(records.some((entry) => entry.uri.fsPath === filePath && entry.occurrence.line === 2),
            "the selected header procedure must retain its DELETE reference without a definition in this pass");
        assert.ok(records.some((entry) => entry.uri.fsPath === headerPath && entry.occurrence.line === 2));
        const referencesOnly = (await worker.query(reply.snapshotId, "references", { ...input,
            position: pointAt(text, "Delete allocated"), destructorProcedure: descriptor, includeDeclaration: false })).result;
        assert.equal(referencesOnly.some((entry) => entry.uri.fsPath === headerPath), false);
        const highlights = (await worker.query(reply.snapshotId, "highlights", { ...input,
            uri: { scheme: "file", fsPath: headerPath }, position: { line: 2, character: 9 }, destructorProcedure: descriptor })).result;
        assert.ok(highlights.some((entry) => entry.occurrence.line === 2));
        assert.ok(highlights.every((entry) => entry.uri.fsPath === headerPath), "header highlights must not escape into the consuming module");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native argument constructors navigate to active physical sites in guarded headers", native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "guarded.bi");
    const header = fs.readFileSync(path.join(__dirname, "fixtures/guarded-argument-constructors.bi"), "utf8");
    const prototypeLines = (type) => header.split("\n").flatMap((line, index) =>
        new RegExp(`^\\s*Declare Constructor\\(ByVal initial As ${type}\\)`).test(line) ? [index] : []);
    const bodyLines = (type) => header.split("\n").flatMap((line, index) =>
        new RegExp(`^Constructor GuardedArgumentValue\\(ByVal initial As ${type}\\)`).test(line) ? [index] : []);
    const text = ['#include "guarded.bi"', "Declare Sub consumeGuarded(ByVal item As GuardedArgumentValue)",
        "consumeGuarded(17)", "Dim argumentValue As Long", "consumeGuarded(argumentValue)", "consumeGuarded 17",
        "' consumeGuarded(17)", 'consumeGuarded("text")', "consumeGuarded(Type<GuardedArgumentValue>(17))", ""].join("\n");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(filePath, text);
    input.openFiles = [filePath];
    for (const semanticModelOnly of [true, false]) for (const alternate of [false, true]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: semanticModelOnly ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            compilerArguments: alternate ? ["-d", "ALTERNATE"] : [],
            semanticModelOnly, exportSemanticExpressions: true, exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(reply.partial, false);
            const selected = alternate ? 0 : 1;
            const receipts = (await worker.query(reply.snapshotId, "compilerSidecarImplicitCallsInSnapshot", input)).result;
            assert.ok(receipts.complete && receipts.calls.some((call) => call.kind === "argument-constructor" && call.line === 2),
                JSON.stringify(receipts));
            for (const [position, type] of [[pointAt(text, "consumeGuarded(17)", "consumeGuarded(".length), "Long"],
                [pointAt(text, "consumeGuarded 17", "consumeGuarded ".length), "Long"],
                [pointAt(text, "Type<GuardedArgumentValue>(17)", 1), "Long"],
                [pointAt(text, 'consumeGuarded("text")', 'consumeGuarded("'.length), "String"]]) {
                for (const operation of ["definition", "declaration", "implementation"]) {
                    const entries = (await worker.query(reply.snapshotId, operation, { ...input, position })).result;
                    assert.deepEqual(entries.map((entry) => [entry.uri.fsPath, entry.declaration.line]),
                        [[headerPath, operation === "declaration" ? prototypeLines(type)[selected] : bodyLines(type)[selected]]],
                        `${operation}, sidecar=${semanticModelOnly}, alternate=${alternate}, line=${position.line}`);
                    for (const entry of entries) assert.equal(header.split("\n")[entry.declaration.line]
                        .slice(entry.declaration.startColumn, entry.declaration.endColumn), entry.name);
                }
            }
            const argument = pointAt(text, "consumeGuarded(argumentValue)", "consumeGuarded(".length);
            for (const operation of ["definition", "declaration"]) {
                const entries = (await worker.query(reply.snapshotId, operation, { ...input, position: argument })).result;
                assert.deepEqual(entries.map((entry) => [entry.uri.fsPath, entry.declaration.line]), [[filePath, 3]],
                    "a conversion must not replace its argument variable's own declaration");
            }
            assert.deepEqual((await worker.query(reply.snapshotId, "implementation", { ...input, position: argument })).result, []);
            const comment = pointAt(text, "' consumeGuarded(17)", "' consumeGuarded(".length);
            assert.deepEqual((await worker.query(reply.snapshotId, "definition", { ...input, position: comment })).result, []);
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
    const bodyStart = header.indexOf("\n#ifdef ALTERNATE\nConstructor");
    assert.ok(bodyStart > 0);
    fs.writeFileSync(headerPath, header.slice(0, bodyStart) + "\n#endif\n");
    for (const semanticModelOnly of [true, false]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: semanticModelOnly ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            semanticModelOnly, exportSemanticExpressions: true, exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(reply.partial, false);
            for (const position of [pointAt(text, "consumeGuarded(17)", "consumeGuarded(".length), pointAt(text, "Type<GuardedArgumentValue>(17)", 1)]) {
                for (const operation of ["definition", "declaration"]) {
                    const entries = (await worker.query(reply.snapshotId, operation, { ...input, position })).result;
                    assert.deepEqual(entries.map((entry) => [entry.uri.fsPath, entry.declaration.line]), [[headerPath, prototypeLines("Long")[1]]],
                        "an external constructor can navigate to its proven prototype without a local P body");
                }
                assert.deepEqual((await worker.query(reply.snapshotId, "implementation", { ...input, position })).result, [],
                    "a prototype must not manufacture a local implementation");
            }
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
    const weak = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true, exportSemanticExpressions: true, exportSemanticBindings: false }, preparation);
    try {
        const position = pointAt(text, "consumeGuarded(17)", "consumeGuarded(".length);
        for (const operation of ["definition", "declaration", "implementation"]) {
            assert.deepEqual((await worker.query(weak.snapshotId, operation, { ...input, position })).result, [],
                "missing native identity must not admit a guarded source guess");
        }
    } finally {
        worker.releaseModel(weak.snapshotId);
    }
});

test("constructor calls use active guarded and external declarations", native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "guarded.bi");
    const header = fs.readFileSync(path.join(__dirname, "fixtures/guarded-argument-constructors.bi"), "utf8");
    const bodyStart = header.indexOf("\n#ifdef ALTERNATE\nConstructor");
    assert.ok(bodyStart > 0);
    const text = ['#include "guarded.bi"', "Declare Sub consumeGuarded(ByVal item As GuardedArgumentValue)",
        "consumeGuarded(17)", "Dim argumentValue As Long", "consumeGuarded(argumentValue)", "consumeGuarded 17",
        'consumeGuarded("text")', "Dim wholePtr As GuardedArgumentValue Ptr = New GuardedArgumentValue(17)",
        'Dim textPtr As GuardedArgumentValue Ptr = New GuardedArgumentValue("text")',
        "Dim wholeValue As GuardedArgumentValue = GuardedArgumentValue(23)",
        'Dim textValue As GuardedArgumentValue = GuardedArgumentValue("other")',
        "Namespace GuardedNames", "Type ValueAlias As GuardedArgumentValue", "End Namespace",
        "Dim aliasedPtr As GuardedNames.ValueAlias Ptr = New GuardedNames.ValueAlias(29)",
        "Dim aliasedValue As GuardedNames.ValueAlias = GuardedNames.ValueAlias(31)",
        "Dim sourceValue As Long", "Dim fromValue As GuardedArgumentValue = GuardedArgumentValue(sourceValue)",
        "' GuardedArgumentValue(17)", 'Print "GuardedArgumentValue(17)"', ""].join("\n");
    const referenceLines = {
        Long: ["consumeGuarded(17)", "consumeGuarded(argumentValue)", "consumeGuarded 17",
            "GuardedArgumentValue(17)", "GuardedArgumentValue(23)", "GuardedNames.ValueAlias(29)",
            "GuardedNames.ValueAlias(31)", "GuardedArgumentValue(sourceValue)"].map((anchor) => pointAt(text, anchor).line),
        String: ['consumeGuarded("text")', 'GuardedArgumentValue("text")',
            'GuardedArgumentValue("other")'].map((anchor) => pointAt(text, anchor).line)
    };
    fs.writeFileSync(filePath, text);
    for (const external of [false, true]) {
        const source = external ? header.slice(0, bodyStart) + "\n#endif\n" : header;
        fs.writeFileSync(headerPath, source);
        for (const semanticModelOnly of [true, false]) for (const alternate of [false, true]) {
            const reply = await worker.analyze({ ...options,
                compilerPath: semanticModelOnly ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
                compilerArguments: alternate ? ["-d", "ALTERNATE"] : [],
                semanticModelOnly, exportSemanticExpressions: true, exportSemanticBindings: true
            }, preparation);
            try {
                assert.equal(reply.partial, false);
                for (const [anchor, type] of [["GuardedArgumentValue(17)", "Long"],
                    ['GuardedArgumentValue("text")', "String"], ["GuardedArgumentValue(23)", "Long"],
                    ['GuardedArgumentValue("other")', "String"], ["GuardedNames.ValueAlias(29)", "Long"],
                    ["GuardedNames.ValueAlias(31)", "Long"]]) {
                    const position = pointAt(text, anchor, anchor.indexOf("(") + 1);
                    const signature = (await worker.query(reply.snapshotId, "signature", { ...input, position })).result;
                    const label = `${anchor}, external=${external}, sidecar=${semanticModelOnly}, alternate=${alternate}`;
                    assert.equal(signature?.entries.length, 1, label + ": " + JSON.stringify(signature));
                    const entry = signature.entries[0];
                    const pattern = external ? `^\\s*Declare Constructor\\(ByVal initial As ${type}\\)`
                        : `^Constructor GuardedArgumentValue\\(ByVal initial As ${type}\\)`;
                    const lines = source.split("\n").flatMap((line, index) => new RegExp(pattern).test(line) ? [index] : []);
                    assert.equal(entry.uri.fsPath, headerPath, label);
                    assert.equal(entry.declaration.line, lines[alternate ? 0 : 1], label);
                    assert.equal(signature.selectedCompilerSymbolId, entry.compilerSymbolId, label);
                    assert.ok(signature.selectedCompilerSymbolId > 0, label);
                    const hoverPosition = pointAt(text, anchor, anchor.lastIndexOf(".") + 2);
                    const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position: hoverPosition })).result;
                    const constructors = hover.entries.filter((candidate) => candidate.declaration.type === "constructor");
                    assert.equal(constructors.length, 1, label + ": " + JSON.stringify(hover));
                    assert.equal(constructors[0].compilerSymbolId, entry.compilerSymbolId, label);
                    assert.equal(constructors[0].uri.fsPath, headerPath, label);
                    assert.equal(constructors[0].declaration.line, entry.declaration.line, label);
                    const prototypes = source.split("\n").flatMap((line, index) =>
                        new RegExp(`^\\s*Declare Constructor\\(ByVal initial As ${type}\\)`).test(line) ? [index] : []);
                    for (const operation of ["definition", "declaration", "implementation"]) {
                        const entries = (await worker.query(reply.snapshotId, operation, { ...input, position: hoverPosition })).result;
                        if (external && operation === "implementation") {
                            assert.deepEqual(entries, [], `${operation}: ${label}`);
                        } else {
                            assert.equal(entries.length, 1, `${operation}: ${label}: ${JSON.stringify(entries)}`);
                            assert.equal(entries[0].declaration.type, "constructor", `${operation}: ${label}`);
                            assert.equal(entries[0].uri.fsPath, headerPath, `${operation}: ${label}`);
                            assert.equal(entries[0].declaration.line, external || operation === "declaration"
                                ? prototypes[alternate ? 0 : 1] : entry.declaration.line, `${operation}: ${label}`);
                        }
                    }
                    for (const operation of ["references", "highlights"]) {
                        const entries = (await worker.query(reply.snapshotId, operation, {
                            ...input, position: hoverPosition, includeDeclaration: true
                        })).result;
                        const root = entries.filter((entry) => entry.uri.fsPath === filePath);
                        assert.deepEqual([...new Set(root.map((entry) => entry.occurrence.line))].sort((a, b) => a - b),
                            referenceLines[type], `${operation}: ${label}`);
                        assert.ok(root.some((entry) => entry.occurrence.line === hoverPosition.line &&
                            text.split("\n")[entry.occurrence.line].slice(entry.occurrence.startColumn, entry.occurrence.endColumn) ===
                                anchor.slice(0, anchor.indexOf("(")).split(".").at(-1)),
                            `${operation}: ${label}: the selected callee must retain its terminal token`);
                        const headerLines = entries.filter((entry) => entry.uri.fsPath === headerPath).map((entry) => entry.occurrence.line);
                        assert.deepEqual([...new Set(headerLines)].sort((a, b) => a - b), operation === "highlights" ? []
                            : external ? [prototypes[alternate ? 0 : 1]]
                                : [prototypes[alternate ? 0 : 1], entry.declaration.line], `${operation}: ${label}: declaration sites`);
                    }
                }
                const argument = pointAt(text, "GuardedArgumentValue(sourceValue)", "GuardedArgumentValue(".length);
                const valueHover = (await worker.query(reply.snapshotId, "hover", { ...input, position: argument })).result;
                assert.ok(valueHover.entries.some((entry) => entry.name === "sourceValue"));
                assert.equal(valueHover.entries.some((entry) => entry.declaration.type === "constructor"), false,
                    "hovering an argument must not substitute its enclosing constructor");
                for (const [position, name] of [[argument, "sourceValue"],
                    [pointAt(text, "GuardedNames.ValueAlias(29)", 1), "GuardedNames"]]) {
                    for (const operation of ["references", "highlights"]) {
                        const entries = (await worker.query(reply.snapshotId, operation, {
                            ...input, position, includeDeclaration: true
                        })).result;
                        assert.ok(entries.length > 0, `${operation}: ${name}`);
                        assert.ok(entries.every((entry) => entry.uri.fsPath === filePath &&
                            text.split("\n")[entry.occurrence.line].slice(entry.occurrence.startColumn, entry.occurrence.endColumn) === name),
                            `${operation}: constructor context must not steal ${name}'s identity`);
                    }
                }
                const referencesWithoutDeclarations = (await worker.query(reply.snapshotId, "references", {
                    ...input, position: pointAt(text, "GuardedArgumentValue(23)", 1), includeDeclaration: false
                })).result;
                assert.equal(referencesWithoutDeclarations.some((entry) => entry.uri.fsPath === headerPath), false);
                for (const position of [pointAt(text, "GuardedNames.ValueAlias(29)", 1),
                    pointAt(text, "' GuardedArgumentValue(17)", 3), pointAt(text, 'Print "GuardedArgumentValue(17)"', 8)]) {
                    const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position })).result;
                    assert.equal(hover.entries.some((entry) => entry.declaration.type === "constructor"), false,
                        "namespace qualifiers, comments, and string contents are not constructor callees");
                }
            } finally {
                worker.releaseModel(reply.snapshotId);
            }
        }
    }
    const weak = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true, exportSemanticExpressions: true, exportSemanticBindings: false }, preparation);
    try {
        const position = pointAt(text, "GuardedArgumentValue(17)", "GuardedArgumentValue(".length);
        const signature = (await worker.query(weak.snapshotId, "signature", { ...input, position })).result;
        assert.deepEqual(signature?.entries, [], "missing committed identity must not admit guarded source guesses");
        const hover = (await worker.query(weak.snapshotId, "hover", {
            ...input, position: pointAt(text, "GuardedArgumentValue(17)", 1)
        })).result;
        assert.equal(hover.entries.some((entry) => entry.declaration.type === "constructor"), false,
            "missing committed identity must not authorize a guarded constructor hover");
        for (const operation of ["definition", "declaration", "implementation"]) {
            const entries = (await worker.query(weak.snapshotId, operation, {
                ...input, position: pointAt(text, "GuardedArgumentValue(17)", 1)
            })).result;
            assert.equal(entries.some((entry) => entry.declaration.type === "constructor"), false,
                "missing committed identity must not manufacture constructor navigation");
        }
    } finally {
        worker.releaseModel(weak.snapshotId);
    }
});

test("stock constructor references use selected prototypes in guarded external headers", native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "external.bi");
    const header = '#ifndef EXTERNAL_BUILD_BI\n#define EXTERNAL_BUILD_BI\nType ExternalBuild\nvalue As Long\n' +
        'Declare Constructor(ByVal initialValue As Long = 0)\nDeclare Constructor(ByVal fractionalValue As Double)\n' +
        '#if 0\nDeclare Constructor(ByVal inactiveValue As String)\n#endif\nEnd Type\n#endif\n';
    const text = '#include "external.bi"\nDim defaultValue As ExternalBuild\n' +
        'Dim allocated As ExternalBuild Ptr = New ExternalBuild(7)\n' +
        'Dim selectedValue As ExternalBuild = ExternalBuild(3)\n' +
        'Dim otherValue As ExternalBuild = ExternalBuild(CDbl(1.5))\n';
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false);
    try {
        const headerInput = { ...input, uri: { scheme: "file", fsPath: headerPath }, position: { line: 4, character: 9 } };
        for (const line of [4, 5]) {
            const hierarchy = (await worker.query(reply.snapshotId, "callHierarchyPrepare", {
                ...headerInput, position: { line, character: 9 }
            })).result;
            assert.equal(hierarchy.length, 1, "external constructor prototypes must prepare without a body or source family");
            assert.equal(hierarchy[0].declaration.type, "constructor");
            assert.equal(hierarchy[0].declaration.line, line);
            assert.equal(hierarchy[0].declaration.startColumn, 8);
            assert.equal(hierarchy[0].declaration.endColumn, 19);
        }
        assert.deepEqual((await worker.query(reply.snapshotId, "callHierarchyPrepare", {
            ...headerInput, position: { line: 7, character: 9 }
        })).result, [], "an inactive constructor header has no native preparation identity");
        const records = (await worker.query(reply.snapshotId, "references", { ...headerInput, includeDeclaration: true })).result;
        const rootLines = records.filter((entry) => entry.uri.fsPath === filePath).map((entry) => entry.occurrence.line);
        assert.deepEqual([...new Set(rootLines)].sort(), [1, 2, 3], "default, NEW and initializer calls must use the Long prototype only");
        assert.ok(records.some((entry) => entry.uri.fsPath === headerPath && entry.occurrence.line === 4));
        assert.equal(records.some((entry) => entry.uri.fsPath === headerPath && entry.occurrence.line === 5), false);
        const highlights = (await worker.query(reply.snapshotId, "highlights", headerInput)).result;
        assert.equal(highlights.length, 1);
        assert.equal(highlights[0].occurrence.line, 4);
        const inactive = (await worker.query(reply.snapshotId, "references", { ...headerInput,
            position: { line: 7, character: 9 }, includeDeclaration: true })).result;
        assert.deepEqual(inactive, [], "unselected header declarations must not acquire construction sites");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("sidecar navigation follows physical bindings omitted by the source token index", () => {
    const { createDocumentModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const filePath = "/workspace/conditional-rem.bas";
    const uri = CompilerUri.file(filePath);
    const text = [
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Dim REM As Integer",
        "Print REM",
        ""
    ].join("\n");
    const parsed = parseFreeBasicText(text);
    assert.equal(parsed.declarations.some((declaration) => declaration.name.toUpperCase() === "REM"), false,
        "the source-only tokenizer should reproduce the contextual comment-boundary gap");
    const document = createDocumentModel(uri, parsed);
    const symbol = 1;
    const facts = {
        storageType: { primitive: "integer", storageBytes: 4, pointerDepth: 0, isReference: false },
        compilerStorageClass: "local",
        declarationInputs: [{
            ordinal: 1,
            symbol,
            writtenType: "as",
            group: { identity: 1, statement: 1, kind: "dim", count: 1, provisional: false },
            provisional: false
        }],
        properties: []
    };
    const model = {
        semanticSidecarOnly: true,
        partial: false,
        sources: new Map([[uri.toString(), document]]),
        semanticBindings: [{
            symbol,
            name: "REM",
            role: "declaration",
            physical: true,
            filePath,
            startLine: 4,
            startColumn: 4,
            endLine: 4,
            endColumn: 7
        }, {
            symbol,
            name: "REM",
            role: "reference",
            physical: true,
            filePath,
            startLine: 5,
            startColumn: 6,
            endLine: 5,
            endColumn: 9
        }],
        semanticDeclarations: [],
        compilerFactsBySemanticIdentity: new Map([[symbol, facts]]),
        getDocument: () => document,
        resolveAt: () => [],
        tokenAt: () => null,
        expressionAt: () => null,
        compilerSidecarFactAt: () => null,
        compilerSidecarExpressionAlternativesAt: () => [],
        compilerConditionalDecisionAt: () => null,
        compilerDefinedNameProbeAt: () => null,
        compilerDeferredMacroReferenceAt: () => null,
        compilerAssignmentInputAt: () => null
    };

    const definition = queryCompilerModel(model, "definition", {
        uri,
        position: { line: 4, character: 7 }
    }, () => {});
    assert.deepEqual(definition.map((entry) => [
        entry.declaration.name,
        entry.declaration.type,
        entry.declaration.line,
        entry.declaration.startColumn,
        entry.declaration.endColumn
    ]), [["REM", "variable", 3, 4, 7]]);

    const hover = queryCompilerModel(model, "hover", {
        uri,
        position: { line: 4, character: 7 }
    }, () => {});
    assert.deepEqual(hover.entries.map((entry) => [entry.name, entry.declaration.typeName]),
        [["REM", "integer"]],
    "hover should reuse the compiler binding when the source parser treats the identifier as a comment");
});

function remoteFixture(t, real = false) {
    const fixture = setup(t, real);
    const document = { uri: CompilerUri.file(fixture.filePath), languageId: "freebasic", getText: () => fs.readFileSync(fixture.filePath, "utf8") };
    const values = { "analysis.compilerPath": real ? process.env.FBC_EDITOR_EXECUTABLE : process.execPath };
    const workspace = { isTrusted: true, textDocuments: [document], getWorkspaceFolder: () => ({ uri: CompilerUri.file(fixture.directory) }), getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback }) };
    const vscode = { workspace, Uri: { file: CompilerUri.file, from: (value) => CompilerUri.from({ ...value, value: `${value.scheme}:${value.path}?${value.query}` }), parse: (value) => CompilerUri.from({ scheme: "freebasic-preprocessed", value }) }, window: {} };
    const index = { ensureInitialized() { assert.fail("Native model preparation must not initialize the host parser index"); }, notifyChange() {} };
    const service = new CompilerAnalysisService(vscode, index, { appendLine() {} });
    // The lifecycle fixture runs Node rather than FBC. Its compatibility is a
    // test precondition; real version probing has its own service tests.
    if (!real) service.compilerCompatibilityFor = () => ({ state: "supported", version: "fixture", message: "" });
    // The service still uses its production background path; only the compiler
    // worker entry is replaced with deterministic lifecycle fixture output.
    service.analysisWorker = fixture.worker;
    fixture.worker.onModelEvicted = (id) => service.expireModel(id);
    t.after(() => service.dispose());
    return { ...fixture, service, document, workspace, values };
}

test("failed binding recovery preserves provisional unsaved header types without advertising identities", native, async (t) => {
    const { service, document, worker, workspace, values, directory, filePath } = remoteFixture(t, true);
    const headerPath = path.join(directory, "recovery.bi");
    fs.writeFileSync(filePath, '#include "recovery.bi"\nPrint 1\n');
    fs.writeFileSync(headerPath, "Dim headerValue As Long\n");
    document.version = 2;
    document.isDirty = true;
    document.getText = () => '#include "recovery.bi"\nPrint (\n';
    const headerText = "Dim headerValue As Double\n#if 1 + 2 = 3\n#assert 1 + 2 = 3\n#endif\n";
    const header = { uri: CompilerUri.file(headerPath), languageId: "freebasic", version: 2, isDirty: true, getText: () => headerText };
    workspace.textDocuments.push(header);
    values["analysis.projectContexts"] = [{ name: "recovery", modules: ["main.bas"] }];
    values["analysis.activeContext"] = { name: "recovery", module: "main.bas" };
    let requests = 0;
    const analyze = worker.analyze.bind(worker);
    worker.analyze = (...args) => { requests++; return analyze(...args); };
    assert.equal(await service.getModelForEditor(document, null, true, true), null,
        "expression-only recovery cannot satisfy a native identity request");
    const model = service.getModel(header.uri);
    assert.ok(model?.partial);
    assert.equal(model.semanticSidecarOnly, false, "recovery must retain the independently valid native trace too");
    assert.equal(model.semanticBindingsAvailable, false);
    assert.equal(model.semanticMacroBindingsAvailable, false);
    const hover = await model.query("hover", header.uri, { position: pointAt(headerText, "1 + 2 = 3") });
    assert.equal(hover?.expression?.typeName.toLowerCase(), "integer");
    assert.equal(hover.expression.provisional, true);
    assert.equal(await service.getModelForEditor(header, null, true), model);
    assert.equal(requests, 1, "the failed identity request must retain reusable current recovery types");
});

test("manual analysis retries a changed closed source once without following edited requests", async (t) => {
    for (const mode of ["source", "capture", "compiler", "edit", "context", "cancel"]) {
        const { service, document, values } = remoteFixture(t);
        document.version = 1;
        const token = { isCancellationRequested: false };
        const key = document.uri.toString();
        let calls = 0;
        service.check = () => {
            if (++calls > 1) return Promise.resolve(true);
            const state = {};
            service.runningContexts.set(key, state);
            return Promise.resolve().then(() => {
                state.errorMessage = mode === "capture" ? "Compiler source changed while being captured: /workspace/flags.bi"
                    : mode === "compiler" ? "Compiler timed out after 15000 ms."
                        : "Compiler snapshot source changed: /workspace/flags.bi";
                service.runningContexts.delete(key);
                if (mode === "edit") document.version++;
                if (mode === "context") values["compiler.arguments"] = ["-d", "CHANGED"];
                if (mode === "cancel") token.isCancellationRequested = true;
                return false;
            });
        };
        assert.equal(await service.checkCurrent(document, false, token), ["source", "capture"].includes(mode), mode);
        assert.equal(calls, ["source", "capture"].includes(mode) ? 2 : 1, mode);
    }
});

/* Hold a completed worker reply before host publication. Lifecycle assertions
   then exercise a known scheduling window without depending on compiler speed. */
function holdPreparedModel(t, worker) {
    const analyze = worker.analyze.bind(worker);
    let ready, failed, release;
    const prepared = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    const gate = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    worker.analyze = async (...args) => {
        try {
            const reply = await analyze(...args);
            ready(reply);
            await gate;
            return reply;
        } catch (error) { failed(error); throw error; }
    };
    return { prepared, release };
}

test("closing an unused deleted buffer does not cancel current background analysis", async (t) => {
    const { service, document, worker, workspace, directory } = remoteFixture(t);
    const unused = { uri: CompilerUri.file(path.join(directory, "unused.bi")), getText: () => "' unused named buffer\n" };
    workspace.textDocuments.push(unused);
    const gate = holdPreparedModel(t, worker);
    const pending = service.checkCurrent(document, false);
    await gate.prepared;
    workspace.textDocuments = [document];
    service.documentClosed(unused);
    gate.release();
    assert.equal(await pending, true, "worker freshness must decide whether the closed buffer was actually consumed");
    assert.ok(service.getModel(document.uri));
});

test("binding enrichment waits for analysis across an unrelated buffer closure", async (t) => {
    const { service, document, worker, workspace, directory } = remoteFixture(t);
    const unused = { uri: CompilerUri.file(path.join(directory, "unused.bi")), getText: () => "' unused named buffer\n" };
    workspace.textDocuments.push(unused);
    const gate = holdPreparedModel(t, worker);
    const manual = service.checkCurrent(document, false);
    await gate.prepared;
    workspace.textDocuments = [document];
    service.documentClosed(unused);
    const enriched = service.check(document, false, null, true);
    gate.release();
    assert.equal(await manual, true, "enrichment must not cancel a pass solely because an unused buffer closed");
    assert.equal(await enriched, true);
    assert.equal(service.getModel(document.uri)?.semanticBindingsAvailable, true);
});

test("closing a newly consumed dirty header cannot publish pending background analysis", native, async (t) => {
    for (const enrich of [false, true]) {
        const { service, document, worker, workspace, directory, filePath } = remoteFixture(t, true);
        const headerPath = path.join(directory, "consumed.bi");
        fs.writeFileSync(headerPath, "Type HeaderType As Long\n");
        fs.writeFileSync(filePath, '#include "consumed.bi"\nDim value As HeaderType\n');
        const header = { uri: CompilerUri.file(headerPath), getText: () => "Type HeaderType As Double\n" };
        workspace.textDocuments.push(header);
        const gate = holdPreparedModel(t, worker);
        const pending = service.checkCurrent(document, false);
        await gate.prepared;
        workspace.textDocuments = [document];
        service.documentClosed(header);
        const enriched = enrich ? service.check(document, false, null, true) : null;
        gate.release();
        assert.equal(await pending, false, "the original pass must reject consumed overlay contents discarded on close");
        if (enrich) {
            assert.equal(await enriched, true, "a later request may compile the current disk header after validation rejects the old pass");
            assert.equal(service.getModel(document.uri)?.semanticBindingsAvailable, true);
        } else assert.equal(service.getModel(document.uri), null);
    }
});

for (const sidecar of [false, true]) test(`readonly value qualifiers distinguish const pointers from const pointees (${sidecar ? "sidecar" : "bridge"})`, native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["Dim writableValue As Long = 1", "Dim immutableValue As Const Long = 2",
        "Dim pointerToConst As Const Long Ptr = @immutableValue", "Dim fixedPointer As Long Const Ptr = @writableValue",
        "Sub InspectConst(ByRef inputValue As Const Long, ByVal dataPointer As Const Long Ptr)",
        "    Print inputValue, *dataPointer", "End Sub", "Print immutableValue, *pointerToConst, *fixedPointer",
        "pointerToConst = @immutableValue", ""].join("\n");
    fs.writeFileSync(filePath, text);
    if (sidecar) {
        const executable = path.join(path.dirname(filePath), "const-values");
        const compiled = spawnSync(process.env.FBC_EXECUTABLE || options.compilerPath, [filePath, "-x", executable],
            { cwd: path.dirname(filePath), encoding: "utf8", timeout: 30000 });
        assert.equal(compiled.status, 0, `${compiled.stdout}${compiled.stderr}`);
        const executed = spawnSync(executable, [], { encoding: "utf8", timeout: 10000 });
        assert.equal(executed.status, 0, executed.stderr);
        assert.deepEqual(executed.stdout.trim().split(/\s+/), ["2", "2", "1"]);
    }
    const reply = await worker.analyze({ ...options, semanticModelOnly: sidecar,
        exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
    const sites = [];
    for (const [line, lineText] of text.split("\n").entries()) {
        for (const match of lineText.matchAll(/\b(writableValue|immutableValue|pointerToConst|fixedPointer|inputValue|dataPointer)\b/g)) {
            sites.push({ filePath, line, startColumn: match.index, endColumn: match.index + match[0].length,
                readonly: ["immutableValue", "fixedPointer", "inputValue"].includes(match[0]) });
        }
    }
    if (sidecar) {
        const uses = (await worker.query(reply.snapshotId, "compilerSidecarAccessRolesAtSites", { ...input, sites })).result;
        for (let index = 0; index < sites.length; index++) {
            assert.equal(uses.find((use) => use.index === index)?.readonly === true, sites[index].readonly,
                `readonly qualifier at ${sites[index].line}:${sites[index].startColumn}`);
        }
    } else {
        const records = decodeSemanticTokenRecords((await worker.query(reply.snapshotId, "semanticTokens", input)).result);
        for (const site of sites) {
            const record = records.find((token) => token.line === site.line && token.character === site.startColumn);
            assert.ok(record, `missing native value token at ${site.line}:${site.startColumn}`);
            assert.equal(Boolean(record.modifiers & (1 << TOKEN_MODIFIERS.indexOf("readonly"))), site.readonly,
                `readonly qualifier at ${site.line}:${site.startColumn}`);
        }
    }
});

for (const values of [[true, true], [true, false], [true, null]]) {
    test(`readonly qualifiers require agreement across shared physical contexts (${values.join(",")})`, () => {
        const { createDocumentModel } = require("../lib/semantic-model");
        const { parseFreeBasicText } = require("../lib/freebasic-parser");
        const uri = CompilerUri.file("/project/const-context.bas");
        const document = createDocumentModel(uri, parseFreeBasicText("Dim sample As Long\nPrint sample\n"));
        document.byLine = new Map();
        for (const token of document.tokens) {
            const tokens = document.byLine.get(token.line) || [];
            tokens.push(token);
            document.byLine.set(token.line, tokens);
        }
        const model = { semanticSidecarOnly: true, partial: false, semanticAccessRoles: [],
            semanticBindings: values.flatMap((_value, index) => [
                { symbol: index + 1, role: "declaration", physical: true, filePath: uri.fsPath,
                    startLine: 1, endLine: 1, startColumn: 4, endColumn: 10 },
                { symbol: index + 1, role: "reference", physical: true, filePath: uri.fsPath,
                    startLine: 2, endLine: 2, startColumn: 6, endColumn: 12 }
            ]),
            compilerFactsBySemanticIdentity: new Map(values.map((value, index) => [index + 1, { valueConst: value }])),
            getDocument: () => document };
        const result = queryCompilerModel(model, "compilerSidecarAccessRolesAtSites", {
            uri, sites: [{ filePath: uri.fsPath, line: 1, startColumn: 6, endColumn: 12 }]
        }, () => {});
        assert.deepEqual(result, values.every((value) => value === true) ? [{ index: 0, readonly: true }] : []);
    });
}

test("prepared models retain native graphs in the worker and bound their lifetime", async (t) => {
    const { worker, options, preparation, input } = setup(t);
    const first = await worker.analyze(options, preparation);
    assert.ok(first.snapshotId);
    assert.equal(first.symbolGraph, undefined);
    assert.equal(first.expressionGraph, undefined);
    assert.equal(first.origins, undefined);
    assert.equal(first.sources.length, 1);
    assert.equal((await worker.query(first.snapshotId, "validate", input)).result, true);
    const retained = [first];
    for (let index = 1; index < 8; index++) retained.push(await worker.analyze(options, preparation));
    assert.equal(worker.models.size, 8, "small graphs should use the byte budget rather than churn after two modules");
    await worker.query(first.snapshotId, "validate", input);
    const next = await worker.analyze(options, preparation);
    assert.equal(worker.models.size, 8);
    assert.ok(worker.models.has(first.snapshotId), "querying a model must refresh its LRU position");
    assert.ok(worker.models.has(next.snapshotId));
    await assert.rejects(worker.query(retained[1].snapshotId, "validate", input), /expired/);
    worker.cancelAll();
    assert.equal(worker.models.size, 0);
});

for (const real of [false, true]) test(`three editor modules reuse current compiler models (${real ? "native" : "fixture"})`,
    { skip: real && !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
        const { service, document, worker, workspace, directory } = remoteFixture(t, real);
        for (const [name, type] of [["second", "Double"], ["third", "Single"]]) {
            const file = path.join(directory, `${name}.bas`);
            const text = `Dim ${name}Value As ${type}\nPrint ${name}Value\n`;
            fs.writeFileSync(file, text);
            workspace.textDocuments.push({ uri: CompilerUri.file(file), languageId: "freebasic", version: 1, isDirty: false,
                getText: () => text });
        }
        const analyze = worker.analyze.bind(worker);
        let preparations = 0;
        worker.analyze = (...args) => { preparations++; return analyze(...args); };
        for (const current of workspace.textDocuments) assert.ok(await service.getModelForEditor(current));
        assert.equal(preparations, 3);
        for (let pass = 0; pass < 2; pass++) {
            for (const current of workspace.textDocuments) {
                const model = await service.getModelForEditor(current);
                assert.ok(await model.query("validate", current.uri));
            }
        }
        assert.equal(preparations, 3, "switching tabs or re-requesting providers must not recompile unchanged modules");
        assert.ok(service.getModel(document.uri));
    });

test("more small cache entries do not enlarge the model byte budget", async (t) => {
    const { options, preparation, directory, filePath } = setup(t);
    const store = new CompilerModelStore();
    t.after(() => store.clear());
    const analyze = async () => ({ text: "", dependencies: [filePath], origins: [], expressions: [] });
    const prepare = (run = analyze) => store.prepare({ ...options, overlays: new Map(), temporaryDirectory: directory }, preparation, run, () => {});
    const first = await prepare();
    /* Charge a tiny fixture to the 128 MiB retention boundary. This exercises
       eviction without allocating a large compiler graph just for the test. */
    const limit = 128 * 1024 * 1024;
    store.models.get(first.snapshotId).weight = limit - 1;
    store.weight = limit - 1;
    const second = await prepare();
    assert.equal(store.models.has(first.snapshotId), false, "the byte limit must evict before the larger entry-count cap is reached");
    assert.equal(store.models.size, 1);
    assert.equal(store.weight, second.modelWeight);
    store.models.get(second.snapshotId).weight = limit + 1;
    store.weight = limit + 1;
    await prepare(async () => {
        assert.equal(store.models.size, 0, "an enlarged exclusive model must be released before another analysis starts");
        assert.equal(store.weight, 0);
        return analyze();
    });
});

test("prepared requests freeze metadata and cancelled queries do not evict current models", async (t) => {
    const { worker, options, preparation, input } = setup(t);
    const metadata = structuredClone(preparation);
    const pending = worker.analyze({ ...options, compilerArguments: ["-d", "wait"] }, metadata);
    metadata.requestedFile = path.join(path.dirname(options.filePath), "changed.bi");
    const reply = await pending;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(worker.query(reply.snapshotId, "validate", input, controller.signal), /cancelled/);
    assert.equal((await worker.query(reply.snapshotId, "validate", input)).result, true);
    await assert.rejects(worker.analyze(options, { ...preparation, expandedUri: { ...expandedUri, value: "file:///wrong" } }), /preparation/);
});

test("worker queries reject stale disk sources and dirty buffers closed without saving", async (t) => {
    const { worker, options, preparation, input, filePath } = setup(t);
    const first = await worker.analyze(options, preparation);
    fs.writeFileSync(filePath, "Dim replacedValue As Double\n");
    await assert.rejects(worker.query(first.snapshotId, "validate", input), /source changed/);
    assert.equal(worker.models.has(first.snapshotId), false);
    const overlays = new Map([[filePath, "Dim unsavedValue As String\n"]]);
    const unsaved = await worker.analyze({ ...options, overlays }, preparation);
    assert.equal((await worker.query(unsaved.snapshotId, "validate", { ...input, openFiles: [filePath] })).result, true);
    await assert.rejects(worker.query(unsaved.snapshotId, "validate", input), /buffer closed/);
    assert.equal(fs.readFileSync(filePath, "utf8"), "Dim replacedValue As Double\n");
});

test("model preparation rejects a compiler replaced before its snapshot is retained", async (t) => {
    const { options, preparation, directory, filePath } = setup(t);
    const compilerPath = path.join(directory, "compiler.exe");
    fs.writeFileSync(compilerPath, "first compiler", { mode: 0o755 });
    const models = new CompilerModelStore();
    t.after(() => models.clear());
    await assert.rejects(models.prepare({ ...options, compilerPath, overlays: new Map(), temporaryDirectory: directory },
        preparation, async () => {
            fs.appendFileSync(compilerPath, " changed during analysis");
            return { text: "", dependencies: [filePath] };
        }, () => {}), /Compiler executable changed during analysis/);
    assert.equal(models.models.size, 0);
    assert.equal(models.weight, 0);
});

test("worker queries expire compiler models after an in-place compiler rebuild", async (t) => {
    const { worker, options, preparation, input, directory } = setup(t);
    const compilerPath = path.join(directory, "compiler.exe");
    fs.writeFileSync(compilerPath, "first compiler", { mode: 0o755 });
    const reply = await worker.analyze({ ...options, compilerPath }, preparation);
    assert.equal((await worker.query(reply.snapshotId, "validate", input)).result, true);
    fs.appendFileSync(compilerPath, " rebuilt");
    await assert.rejects(worker.query(reply.snapshotId, "validate", input), /executable changed/);
    assert.equal(worker.models.has(reply.snapshotId), false);
    const fresh = await worker.analyze({ ...options, compilerPath }, preparation);
    assert.equal((await worker.query(fresh.snapshotId, "validate", input)).result, true);
});

test("query positions reject out-of-range and reversed spans without losing the model", async (t) => {
    const { worker, options, preparation, input } = setup(t);
    const reply = await worker.analyze(options, preparation);
    for (const position of [{ line: -1, character: 0 }, { line: 500, character: 0 }, { line: 0, character: 1000 }, { line: 0, character: 1.5 }]) {
        await assert.rejects(worker.query(reply.snapshotId, "expression", { ...input, position }), /position/);
    }
    await assert.rejects(worker.query(reply.snapshotId, "expression", { ...input, position: { line: 1, character: 0 }, end: { line: 0, character: 0 } }), /reversed/);
    const validation = await worker.query(reply.snapshotId, "validate", input);
    assert.equal(validation.result, true);
    for (const phase of ["queryFreshnessBeforeMs", "modelQueryMs", "queryFreshnessAfterMs"]) {
        assert.ok(Number.isFinite(validation.workerStats[phase]) && validation.workerStats[phase] >= 0,
            `Worker query timing should report ${phase}.`);
    }
});

test("source discovery recompiles captured dependencies before retaining a model", async (t) => {
    const { options, preparation, directory, filePath } = setup(t);
    const header = path.join(directory, "types.bi");
    fs.writeFileSync(header, "Dim includedValue As Double\n");
    const store = new CompilerModelStore();
    let calls = 0;
    const analyze = async (request) => {
        calls++;
        assert.equal(request.overlays.get(filePath), fs.readFileSync(filePath, "utf8"));
        if (calls > 1) assert.equal(request.overlays.get(header), "Dim includedValue As Double\n");
        return { text: "", dependencies: [filePath, header], origins: [], expressions: [] };
    };
    const reply = await store.prepare({ ...options, overlays: new Map(), temporaryDirectory: directory }, preparation, analyze, () => {});
    assert.equal(calls, 2);
    assert.equal(reply.sources.length, 2);
    assert.ok(store.get(reply.snapshotId, [], () => {}));
    assert.throws(() => store.get(reply.snapshotId, [], () => { throw new Error("Cancelled source check"); }), /Cancelled/);
    assert.equal(store.models.size, 1, "Cancelling a query must not evict otherwise current source");
    fs.writeFileSync(header, "Dim changedValue As Single\n");
    assert.throws(() => store.get(reply.snapshotId, [], () => {}), /source changed/);
    assert.equal(store.models.size, 0);
    assert.equal(store.weight, 0);
});

test("prepared models preload verified dependency paths and retry when the build context changes", async (t) => {
    const { options, preparation, directory, filePath } = setup(t);
    const header = path.join(directory, "types.bi");
    const extraHeader = path.join(directory, "extra.bi");
    fs.writeFileSync(header, "Dim includedValue As Double\n");
    const store = new CompilerModelStore();
    const observed = [];
    let discoveredExtraHeader = false;
    const analyze = async (request) => {
        observed.push(new Map(request.overlays));
        return { text: "", dependencies: [filePath, header, ...(discoveredExtraHeader ? [extraHeader] : [])], origins: [], expressions: [] };
    };
    const prepare = (requestOptions) => store.prepare({ ...options, temporaryDirectory: directory, ...requestOptions }, preparation, analyze, () => {});

    const first = await prepare({ overlays: new Map() });
    assert.equal(first.analysisPasses, 2, "The initial model must discover then freeze its included header");
    assert.equal(first.dependencyCacheHit, false);
    assert.equal(observed[0].has(header), false);
    assert.equal(observed[1].get(header), "Dim includedValue As Double\n");
    store.remove(first.snapshotId);

    fs.writeFileSync(header, "Dim changedValue As Single\n");
    const overlay = new Map([[filePath, "Dim unsavedRoot As Long\n"]]);
    const second = await prepare({ overlays: overlay });
    assert.equal(second.dependencyCacheHit, true);
    assert.equal(second.analysisPasses, 1, "A cached path hint should avoid a separate dependency-discovery compile");
    assert.equal(observed[2].get(header), "Dim changedValue As Single\n", "A hint must reread current source instead of retaining text");
    assert.equal(second.sources.find((source) => source.filePath === header)?.text, "Dim changedValue As Single\n");
    store.remove(second.snapshotId);

    fs.writeFileSync(extraHeader, "Dim newDependency As Long\n");
    discoveredExtraHeader = true;
    const third = await prepare({ overlays: overlay });
    assert.equal(third.dependencyCacheHit, true);
    assert.equal(third.analysisPasses, 2, "A newly discovered include must still trigger a frozen-source recompile");
    assert.equal(observed[3].has(extraHeader), false);
    assert.equal(observed[4].get(extraHeader), "Dim newDependency As Long\n");
    assert.ok(third.sources.some((source) => source.filePath === extraHeader));
    store.remove(third.snapshotId);

    const fourth = await prepare({ overlays: overlay, compilerArguments: ["-d", "DIFFERENT_CONTEXT"] });
    assert.equal(fourth.dependencyCacheHit, false, "Dependency paths must not cross compiler argument contexts");
    assert.equal(fourth.analysisPasses, 2);
    assert.equal(observed[5].has(header), false);
    assert.equal(observed[6].has(header), true);

    const fifth = await prepare({ overlays: overlay, environment: { FB_INCLUDE: "different-include-path" } });
    assert.equal(fifth.dependencyCacheHit, false, "Dependency paths must not cross compiler environment contexts");
    assert.equal(fifth.analysisPasses, 2);
    assert.equal(observed[7].has(header), false);
    assert.equal(observed[8].has(header), true);

    for (let index = 0; index < 40; index++) store.rememberDependencies(`bounded-context-${index}`, [filePath, header]);
    assert.equal(store.dependencyHints.size, 32, "Dependency path hints must evict older compiler contexts");
    assert.ok(store.dependencyHintBytes > 0);
    assert.ok(store.dependencyHintBytes <= 4 * 1024 * 1024);
});

test("workspace include hints avoid redundant dependency discovery but cannot hide compiler includes", async (t) => {
    const { options, preparation, directory, filePath } = setup(t);
    const header = path.join(directory, "types.bi");
    const unrelated = path.join(directory, "unrelated.bi");
    fs.writeFileSync(header, "Dim includedValue As Double\n");
    fs.writeFileSync(unrelated, "Dim unrelatedValue As Long\n");

    const prepareWithHints = async (dependencyHints) => {
        const store = new CompilerModelStore();
        let calls = 0;
        const headerFrozenByPass = [];
        const analyze = async (request) => {
            calls++;
            headerFrozenByPass.push(request.overlays.has(header));
            return { text: "", dependencies: [filePath, header], origins: [], expressions: [] };
        };
        const reply = await store.prepare({ ...options, overlays: new Map(), dependencyHints, temporaryDirectory: directory }, preparation, analyze, () => {});
        store.remove(reply.snapshotId);
        return { calls, reply, headerFrozenByPass };
    };

    const hinted = await prepareWithHints([filePath, header]);
    assert.equal(hinted.reply.dependencyCacheHit, true);
    assert.equal(hinted.reply.analysisPasses, 1);
    assert.equal(hinted.calls, 1);
    assert.deepEqual(hinted.headerFrozenByPass, [true]);

    const incomplete = await prepareWithHints([unrelated]);
    assert.equal(incomplete.reply.dependencyCacheHit, true);
    assert.equal(incomplete.reply.analysisPasses, 2,
        "A compiler-reported include omitted by the textual hint must still trigger the freshness pass.");
    assert.equal(incomplete.calls, 2);
    assert.deepEqual(incomplete.headerFrozenByPass, [false, true]);
    assert.ok(incomplete.reply.sources.some((source) => source.filePath === header));
});

test("prepared native models use workspace include hints and recompile when a compiler include is missing", native, async (t) => {
    const run = async (useCorrectHint) => {
        const fixture = setup(t, true);
        const header = path.join(fixture.directory, "types.bi");
        const unrelated = path.join(fixture.directory, "unrelated.bi");
        const source = '#include "types.bi"\nPrint includedValue\n';
        fs.writeFileSync(fixture.filePath, source);
        fs.writeFileSync(header, "Dim includedValue As Long\n");
        fs.writeFileSync(unrelated, "Dim unrelatedValue As Double\n");
        const reply = await fixture.worker.analyze({
            ...fixture.options,
            compilerArguments: ["-i", fixture.directory],
            dependencyHints: [useCorrectHint ? header : unrelated]
        }, fixture.preparation);
        return { fixture, reply, header };
    };

    const hinted = await run(true);
    assert.equal(hinted.reply.analysisPasses, 1,
        "A workspace include graph hint should let the compiler result become a model in one pass.");
    assert.equal(hinted.reply.dependencyCacheHit, true);
    assert.ok(hinted.reply.dependencies.includes(hinted.header));
    assert.ok(hinted.reply.sources.some((source) => source.filePath === hinted.header));
    assert.equal(fs.readFileSync(hinted.header, "utf8"), "Dim includedValue As Long\n");

    const incomplete = await run(false);
    assert.equal(incomplete.reply.analysisPasses, 2,
        "A compiler dependency missing from the workspace hint must be captured and recompiled before publication.");
    assert.ok(incomplete.reply.dependencies.includes(incomplete.header));
    assert.ok(incomplete.reply.sources.some((source) => source.filePath === incomplete.header));
});

test("background service avoids host parsing and serializes prototype cursor coordinates", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    assert.equal(await service.check(document, false), true);
    const model = service.getModel(document.uri);
    assert.ok(model instanceof CompilerRemoteModel);
    const query = worker.query.bind(worker);
    worker.query = (id, operation, input, signal) => {
        assert.deepEqual(input.position, { line: 1, character: 8 });
        return query(id, operation, input, signal);
    };
    class Position { get line() { return 1; } get character() { return 8; } }
    const hover = await model.query("hover", document.uri, { position: new Position() });
    assert.equal(hover.occurrence.name, "modelValue");
    worker.query = query;
    const tokens = await model.query("semanticTokens", document.uri);
    assert.ok(tokens instanceof Uint32Array);
    assert.equal(service.getModel(document.uri), model, "Typed arrays have an entries method, not an entries result list");
    const facts = { entries: [{ name: "compiler-only fact" }] };
    worker.query = async () => ({ result: facts });
    assert.deepEqual(await model.query("facts", document.uri), facts,
        "fact lists without URI fields must not be treated as navigation locations");
    worker.query = query;
});

function sharedHeaderFixture(t, included) {
    const fixture = remoteFixture(t, true);
    const headerPath = path.join(fixture.directory, "shared.bi");
    fs.writeFileSync(headerPath, "Dim sharedValue As Long\n");
    fs.writeFileSync(fixture.filePath, included ? '#include "shared.bi"\nPrint sharedValue\n' : "Print 0\n");
    const header = { uri: CompilerUri.file(headerPath), languageId: "freebasic", version: 1, isDirty: false,
        getText: () => fs.readFileSync(headerPath, "utf8") };
    fixture.workspace.textDocuments.push(header);
    fixture.values["analysis.projectContexts"] = [{ name: "shared", modules: [fixture.filePath] }];
    fixture.values["analysis.activeContext"] = { name: "shared", module: fixture.filePath };
    const warnings = [], information = [];
    fixture.service.vscode.window.showWarningMessage = (message) => warnings.push(message);
    fixture.service.vscode.window.showInformationMessage = (message) => information.push(message);
    return { ...fixture, header, warnings, information };
}

for (const creator of ["root", "header"]) for (const included of [false, true]) {
    test(`shared header checks validate each consumer (${creator} first, ${included ? "included" : "excluded"})`, native, async (t) => {
        const { service, document, header, worker, warnings, information } = sharedHeaderFixture(t, included);
        const gate = holdPreparedModel(t, worker);
        let calls = 0;
        const analyze = worker.analyze.bind(worker);
        worker.analyze = (...args) => { calls++; return analyze(...args); };
        const first = service.check(creator === "root" ? document : header, false);
        await gate.prepared;
        const second = service.check(creator === "root" ? header : document, true);
        gate.release();
        const results = await Promise.all([first, second]);
        assert.equal(results[creator === "root" ? 0 : 1], true, "a valid root must not inherit another consumer's exclusion failure");
        assert.equal(results[creator === "root" ? 1 : 0], included, "successful root analysis is not proof that a header was consumed");
        assert.equal(calls, 1, "per-consumer validation must share one compiler preparation");
        assert.ok(service.getModel(document.uri));
        assert.equal(Boolean(service.getModel(header.uri)), included);
        if (creator === "root" && !included) assert.match(warnings[0], /did not include|did not consume/);
        else assert.equal(information.length, 1, "a manual joiner must receive its own result notification");
    });
}

test("excluded shared headers remain throttled after binding-upgrade transfers", native, async (t) => {
    const { service, document, header, worker } = sharedHeaderFixture(t, false);
    const gate = holdPreparedModel(t, worker);
    let calls = 0;
    const analyze = worker.analyze.bind(worker);
    worker.analyze = (...args) => { calls++; return analyze(...args); };
    const headerRequest = service.getModelForEditor(header);
    await gate.prepared;
    const rootRequest = service.getModelForEditor(document, null, false, true);
    gate.release();
    const [headerModel, rootModel] = await Promise.all([headerRequest, rootRequest]);
    assert.equal(headerModel, null);
    assert.ok(rootModel?.semanticBindingsAvailable);
    assert.equal(calls, 2);
    assert.equal(await service.getModelForEditor(header), null);
    assert.equal(calls, 2, "an excluded header must not repeatedly recompile or evict its valid root");
    assert.equal(service.getModel(document.uri), rootModel);
});

for (const [name, firstManual, secondManual, cancelled] of [
    ["silent creator", false, true, -1],
    ["manual creator", true, false, -1],
    ["cancelled creator", true, true, 0],
    ["cancelled joiner", true, true, 1],
    ["silent callers", false, false, -1],
    ["cancelled only manual caller", true, false, 0]
]) test(`shared analysis failures notify active manual callers (${name})`, async (t) => {
    const { service, document, worker } = remoteFixture(t);
    const warnings = [], listeners = new Set();
    service.vscode.window.showWarningMessage = (message) => warnings.push(message);
    const token = { isCancellationRequested: false,
        onCancellationRequested(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; } };
    let fail, calls = 0, signal;
    worker.analyze = (options) => {
        calls++;
        signal = options.signal;
        return new Promise((_resolve, reject) => { fail = () => reject(new Error("Shared compiler export failed.")); });
    };
    const first = service.check(document, firstManual, cancelled === 0 ? token : null);
    const second = service.check(document, secondManual, cancelled === 1 ? token : null);
    assert.equal(calls, 1);
    if (cancelled >= 0) {
        token.isCancellationRequested = true;
        for (const listener of [...listeners]) listener();
        assert.equal(signal.aborted, false, "the uncancelled caller still owns this preparation");
    }
    fail();
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    const manual = firstManual && cancelled !== 0 || secondManual && cancelled !== 1;
    assert.deepEqual(warnings, manual ? ["Shared compiler export failed."] : [],
        "only the active manual caller should receive a warning, regardless of who started the pass");
    assert.equal(listeners.size, 0);
});

for (const macro of [false, true]) test(`shared analysis failures follow the last binding upgrade (${macro ? "macro" : "bindings"})`, async (t) => {
    const { service, document, worker } = remoteFixture(t);
    const warnings = [], requests = [];
    service.vscode.window.showWarningMessage = (message) => warnings.push(message);
    worker.analyze = (options) => new Promise((_resolve, reject) => {
        requests.push({ options, reject });
        options.signal.addEventListener("abort", () => reject(new Error("Superseded preparation cancelled.")), { once: true });
    });
    const waiting = [service.check(document, true), service.check(document, false, null, true)];
    if (macro) waiting.push(service.check(document, false, null, true, true));
    assert.equal(requests.length, macro ? 3 : 2);
    requests.at(-1).reject(new Error("Upgraded compiler export failed."));
    assert.deepEqual(await Promise.all(waiting), waiting.map(() => false));
    assert.deepEqual(warnings, ["Upgraded compiler export failed."],
        "transferred manual callers need the final failure, not a superseded compiler's cancellation");
});

test("matching background requests share one immutable compiler preparation", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    const activity = [];
    service.analysisChangeEmitter = { fire: () => activity.push(service.running.size), dispose() {} };
    const analyze = worker.analyze.bind(worker);
    let release, calls = 0;
    worker.analyze = async (...args) => {
        calls++;
        await new Promise((resolve) => { release = resolve; });
        return analyze(...args);
    };
    const first = service.check(document, false);
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.check(document, false);
    assert.equal(calls, 1, "The second provider request must join the first immutable input");
    release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(calls, 1);
    assert.deepEqual(activity, [1, 0], "shared callers must not create duplicate activity or leave progress busy");
});

test("cancelling one provider leaves a shared compiler preparation available to other waiters", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    const analyze = worker.analyze.bind(worker);
    let release, cancelled = false;
    const listeners = new Set();
    const token = {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }
    };
    let signal;
    worker.analyze = async (options, preparation) => {
        signal = options.signal;
        await new Promise((resolve) => { release = resolve; });
        return analyze(options, preparation);
    };
    const first = service.check(document, false, token);
    const second = service.check(document, false);
    cancelled = true;
    for (const listener of [...listeners]) listener();
    assert.equal(await first, false);
    assert.equal(signal.aborted, false, "the remaining waiter still owns the compiler work");
    release();
    assert.equal(await second, true);
    assert.ok(service.getModel(document.uri));
    assert.equal(listeners.size, 0);
});

test("internally cancelled on-demand passes remain immediately retryable", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    const analyze = worker.analyze.bind(worker);
    worker.analyze = (options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("Compiler analysis was cancelled.")), { once: true });
    });
    const pending = service.getModelForEditor(document);
    service.running.get(document.uri.toString()).abort();
    assert.equal(await pending, null);
    worker.analyze = analyze;
    assert.ok(await service.getModelForEditor(document), "internal cancellation is not a compiler failure");
    assert.equal(service.onDemandFailures.has(document), false);
});

test("a full worker queue does not cache an on-demand compiler failure", async (t) => {
    const { service, document, worker, options } = remoteFixture(t);
    const waiting = Array.from({ length: 16 }, () => worker.analyze({ ...options, compilerArguments: ["-d", "wait"] }));
    const settled = Promise.allSettled(waiting);
    assert.equal(await service.getModelForEditor(document), null);
    assert.equal(service.onDemandFailures.has(document), false, "queue admission rejection must not disable compiler assistance for 30 seconds");
    worker.cancelAll();
    await settled;
    assert.ok(await service.getModelForEditor(document), "the same inputs must work as soon as capacity is available");
});

test("on-demand binding upgrades return the shared successor despite the original pass being aborted", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    const activity = [];
    service.analysisChangeEmitter = { fire: () => activity.push(service.running.size), dispose() {} };
    const analyze = worker.analyze.bind(worker);
    let release;
    worker.analyze = (options, preparation) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("Compiler analysis was cancelled.")), { once: true });
        release = async () => {
            try { resolve(await analyze(options, preparation)); } catch (error) { reject(error); }
        };
    });
    const expression = service.getModelForEditor(document);
    const binding = service.getModelForEditor(document, null, false, true);
    await release();
    const models = await Promise.all([expression, binding]);
    assert.ok(models[0]);
    assert.equal(models[0], models[1]);
    assert.equal(models[0].semanticBindingsAvailable, true);
    assert.equal(service.onDemandFailures.has(document), false);
    assert.deepEqual(activity, [1, 1, 0], "transferred providers must stay busy until the replacement finishes");
});

test("saved-header fixes release an on-demand failure for the native compiler", native, async (t) => {
    const { service, document, worker, workspace, filePath, directory } = remoteFixture(t, true);
    const source = '#include "retry.bi"\nDim retryValue As RetryAlias\nPrint retryValue\n';
    fs.writeFileSync(filePath, source);
    const headerPath = path.join(directory, "retry.bi");
    fs.writeFileSync(headerPath, "Type RetryAlias As Long\n");
    const header = { uri: CompilerUri.file(headerPath), version: 1, isDirty: false,
        getText: () => fs.readFileSync(headerPath, "utf8") };
    workspace.textDocuments.push(header);
    const analyze = worker.analyze.bind(worker);
    let calls = 0;
    worker.analyze = (...args) => ++calls === 1 ? Promise.reject(new Error("Initial export was unavailable.")) : analyze(...args);
    assert.equal(await service.getModelForEditor(document), null);
    assert.equal(await service.getModelForEditor(document), null);
    assert.equal(calls, 1, "unchanged failing input must remain throttled");
    fs.writeFileSync(headerPath, "Type RetryAlias As Double\n");
    header.version++;
    service.documentChanged(header);
    const model = await service.getModelForEditor(document);
    assert.ok(model, "the saved header revision must release the root's failure throttle");
    const expression = await model.expressionAt(document.uri, pointAt(source, "Print retryValue", "Print r".length));
    assert.equal(expression?.typeName.toLowerCase(), "double");
    assert.equal(calls, 2);
});

for (const reason of ["backpressure", "eviction"]) test(`on-demand post-preparation ${reason} does not throttle new work`, async (t) => {
    const { service, document, worker } = remoteFixture(t);
    const analyze = worker.analyze.bind(worker), query = worker.query.bind(worker);
    let rejectNext = true;
    if (reason === "backpressure") {
        worker.query = (...args) => {
            if (args[1] === "validate" && rejectNext) {
                rejectNext = false;
                return Promise.reject(new Error("The compiler analysis queue is full."));
            }
            return query(...args);
        };
    } else {
        worker.analyze = async (...args) => {
            const reply = await analyze(...args);
            if (rejectNext) {
                rejectNext = false;
                worker.releaseModel(reply.snapshotId);
            }
            return reply;
        };
    }
    assert.equal(await service.getModelForEditor(document), null);
    assert.equal(worker.models.size, 0, "discarded preparations must still release their graphs");
    assert.ok(await service.getModelForEditor(document), "a successful compiler preparation must not become a cached compiler failure");
    assert.equal(service.onDemandFailures.has(document), false);
});

for (const macro of [false, true]) test(`new named headers refresh cached missing includes (${macro ? "macro" : "literal"})`, native, async (t) => {
    const { service, document, worker, workspace, filePath, directory } = remoteFixture(t, true);
    const source = macro ? '#define HEADER_NAME "appeared.bi"\n#include HEADER_NAME\nPrint includedValue\n'
        : '#include "appeared.bi"\nPrint includedValue\n';
    fs.writeFileSync(filePath, source);
    const first = await service.getModelForEditor(document);
    assert.equal(first?.partial, true);
    const headerPath = path.join(directory, "appeared.bi");
    const header = { uri: CompilerUri.file(headerPath), languageId: "freebasic", version: 1, isDirty: true,
        getText: () => "Dim includedValue As Double\n" };
    workspace.textDocuments.push(header);
    service.documentOpened(header);
    assert.equal(worker.models.has(first.snapshotId), false, "the compiler-reported failed include must retire its old graph");
    const model = await service.getModelForEditor(document);
    assert.equal(model?.partial, false);
    const expression = await model.expressionAt(document.uri, pointAt(source, "Print includedValue", "Print i".length));
    assert.equal(expression?.typeName.toLowerCase(), "double");
    assert.equal(fs.existsSync(headerPath), false, "the new named buffer must remain unsaved");
    assert.equal(fs.readFileSync(filePath, "utf8"), source, "the root must not be edited to release the partial snapshot");
});

test("worker freshness rejects new unsaved includes before a delayed open event", native, async (t) => {
    const { service, document, workspace, filePath, directory } = remoteFixture(t, true);
    const source = '#include "appeared.bi"\nPrint includedValue\n';
    fs.writeFileSync(filePath, source);
    const first = await service.getModelForEditor(document);
    assert.equal(first?.partial, true);
    const header = { uri: CompilerUri.file(path.join(directory, "appeared.bi")), isDirty: true, version: 1,
        getText: () => "Dim includedValue As Double\n" };
    workspace.textDocuments.push(header);
    assert.equal(await first.query("validate", document.uri), null, "worker-owned freshness must not wait for the editor open event");
    assert.equal(service.getModel(document.uri), null);
    assert.equal((await service.getModelForEditor(document))?.partial, false);
});

test("same-named unrelated buffers do not repeatedly invalidate missing-include models", native, async (t) => {
    const { service, document, workspace, filePath, directory } = remoteFixture(t, true);
    fs.writeFileSync(filePath, '#include "appeared.bi"\nPrint includedValue\n');
    assert.equal((await service.getModelForEditor(document))?.partial, true);
    const header = { uri: CompilerUri.file(path.join(directory, "unrelated", "appeared.bi")), version: 1, isDirty: true,
        getText: () => "Dim unrelatedValue As Double\n" };
    workspace.textDocuments.push(header);
    service.documentOpened(header);
    const current = await service.getModelForEditor(document);
    assert.equal(current?.partial, true, "FBC must decide whether the same-named candidate is in its include search path");
    service.documentOpened(header);
    header.version++;
    header.getText = () => "Dim unrelatedValue As Long\n";
    service.documentChanged(header);
    assert.equal(await current.query("validate", document.uri), true);
    assert.equal(service.getModel(document.uri), current, "an ignored candidate must not cause an expiry loop");
});

test("late header-open events preserve a replacement already carrying the new buffer", native, async (t) => {
    const { service, document, worker, workspace, filePath, directory } = remoteFixture(t, true);
    fs.writeFileSync(filePath, '#include "appeared.bi"\nPrint includedValue\n');
    assert.equal((await service.getModelForEditor(document))?.partial, true);
    const header = { uri: CompilerUri.file(path.join(directory, "appeared.bi")), version: 1, isDirty: true,
        getText: () => "Dim includedValue As Double\n" };
    workspace.textDocuments.push(header);
    const gate = holdPreparedModel(t, worker);
    const pending = service.check(document, false, null, true);
    assert.equal((await gate.prepared).partial, false);
    const controller = service.running.get(document.uri.toString());
    service.documentOpened(header);
    assert.equal(controller.signal.aborted, false);
    gate.release();
    assert.equal(await pending, true);
    assert.equal(service.getModel(document.uri)?.partial, false);
});

test("a new provider does not join a cancelled pass that is still being reaped", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    const analyze = worker.analyze.bind(worker);
    let cancel, reap, calls = 0;
    const token = { isCancellationRequested: false,
        onCancellationRequested(listener) { cancel = listener; return { dispose() {} }; } };
    worker.analyze = (options, preparation) => {
        if (++calls > 1) return analyze(options, preparation);
        return new Promise((_resolve, reject) => { reap = () => reject(new Error("Compiler analysis was cancelled.")); });
    };
    const first = service.check(document, false, token);
    token.isCancellationRequested = true;
    cancel();
    const second = service.check(document, false);
    assert.equal(calls, 2);
    reap();
    assert.deepEqual(await Promise.all([first, second]), [false, true]);
});

test("binding upgrades transfer matching expression waiters to the replacement compiler pass", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    const analyze = worker.analyze.bind(worker);
    const requests = [];
    worker.analyze = (options, preparation) => new Promise((resolve, reject) => {
        const cancel = () => reject(new Error("Compiler analysis was cancelled."));
        options.signal.addEventListener("abort", cancel, { once: true });
        requests.push({ options, release: async () => {
            options.signal.removeEventListener("abort", cancel);
            try { resolve(await analyze(options, preparation)); } catch (error) { reject(error); }
        } });
    });
    const expression = service.check(document, false);
    const bindings = service.check(document, false, null, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.signal.aborted, true);
    await requests[1].release();
    assert.deepEqual(await Promise.all([expression, bindings]), [true, true]);
    assert.equal(service.getModel(document.uri).semanticBindingsAvailable, true);
});

test("cancelling an upgrade provider retains expression waiters while the old pass is reaped", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    const analyze = worker.analyze.bind(worker);
    let cancel, reap, release;
    const requests = [];
    const token = { isCancellationRequested: false,
        onCancellationRequested(listener) { cancel = listener; return { dispose() {} }; } };
    worker.analyze = (options, preparation) => {
        requests.push(options);
        if (requests.length === 1) {
            return new Promise((_resolve, reject) => { reap = () => reject(new Error("Compiler analysis was cancelled.")); });
        }
        return new Promise((resolve, reject) => { release = async () => {
            try { resolve(await analyze(options, preparation)); } catch (error) { reject(error); }
        }; });
    };
    const expression = service.check(document, false);
    const bindings = service.check(document, false, token, true);
    token.isCancellationRequested = true;
    cancel();
    assert.equal(await bindings, false);
    assert.equal(requests[1].signal.aborted, false,
        "the waiting expression provider must own the stronger pass before the old compiler finishes cleanup");
    await release();
    assert.equal(await expression, true);
    reap();
    assert.equal(service.getModel(document.uri).semanticBindingsAvailable, true);
});

for (const real of [false, true]) test(`binding upgrades retain current results until replacement publication (${real ? "native" : "fixture"})`,
    { skip: real && !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
        const { service, document, worker } = remoteFixture(t, real);
        assert.equal(await service.check(document, false), true);
        const first = service.getModel(document.uri);
        const firstSnapshot = service.snapshotFor(document.uri);
        const expanded = service.provideTextDocumentContent(firstSnapshot.uri);
        let publications = 0;
        const publish = service.publishDiagnostics.bind(service);
        service.publishDiagnostics = () => { publications++; publish(); };
        const gate = holdPreparedModel(t, worker);
        const pending = service.check(document, false, null, true);
        await gate.prepared;
        assert.equal(service.getModel(document.uri), first,
            "requesting stronger binding facts must not withdraw the current expression snapshot");
        assert.equal(publications, 0, "unchanged diagnostics must not disappear during an upgrade");
        assert.equal(service.provideTextDocumentContent(firstSnapshot.uri), expanded);
        assert.equal(first.semanticBindingsAvailable, false, "the retained snapshot must not claim the requested new capability");
        assert.ok(worker.models.has(first.snapshotId));
        const hover = await first.query("hover", document.uri, { position: { line: 1, character: 8 } });
        assert.equal(hover.occurrence.name, "modelValue");
        gate.release();
        assert.equal(await pending, true);
        const second = service.getModel(document.uri);
        assert.notEqual(second, first);
        assert.equal(second.semanticBindingsAvailable, true);
        assert.equal(worker.models.has(first.snapshotId), false, "publication must release the old graph, not increase the cache budget");
        assert.equal(worker.models.size, 1);
        assert.equal(service.expanded.has(firstSnapshot.uri.toString()), false);
        assert.equal(publications, 1, "publish replacement diagnostics once, without a preceding empty result");
    });

test("cancelled and failed binding upgrades preserve only the existing capabilities", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    assert.equal(await service.check(document, false), true);
    const first = service.getModel(document.uri);
    let cancel;
    const token = { isCancellationRequested: false,
        onCancellationRequested(listener) { cancel = listener; return { dispose() {} }; } };
    worker.analyze = (options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("Compiler analysis was cancelled.")), { once: true });
    });
    const pending = service.check(document, false, token, true);
    token.isCancellationRequested = true;
    cancel();
    assert.equal(await pending, false);
    assert.equal(service.getModel(document.uri), first);
    worker.analyze = async () => { throw new Error("Binding export failed."); };
    assert.equal(await service.getModelForEditor(document, null, false, true), null,
        "an unsuccessful upgrade must not substitute weaker facts for required bindings");
    assert.equal(await service.getModelForEditor(document), first);
    assert.equal(first.semanticBindingsAvailable, false);
    assert.ok(await first.query("hover", document.uri, { position: { line: 1, character: 8 } }));
});

for (const change of ["edit", "context"]) test(`binding upgrades do not retain results after a ${change} change`, async (t) => {
    const { service, document, worker, values } = remoteFixture(t);
    assert.equal(await service.check(document, false), true);
    const first = service.getModel(document.uri);
    const gate = holdPreparedModel(t, worker);
    const pending = service.check(document, false, null, true);
    await gate.prepared;
    assert.equal(service.getModel(document.uri), first);
    if (change === "edit") {
        document.getText = () => "Dim editedValue As Double\n";
        service.documentChanged(document);
    } else {
        values["compiler.arguments"] = ["-d", "CHANGED_CONTEXT"];
        service.refreshContexts();
    }
    assert.equal(service.getModel(document.uri), null);
    assert.equal(worker.models.has(first.snapshotId), false);
    gate.release();
    assert.equal(await pending, false);
    await new Promise(setImmediate);
    assert.equal(service.snapshots.size, 0, "discarded work must not resurrect the previous snapshot");
    assert.equal(worker.models.size, 0);
});

test("macro binding upgrades retain the current ordinary binding snapshot", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    assert.equal(await service.check(document, false, null, true), true);
    const first = service.getModel(document.uri);
    const gate = holdPreparedModel(t, worker);
    const pending = service.check(document, false, null, true, true);
    await gate.prepared;
    assert.equal(service.getModel(document.uri), first);
    assert.equal(first.semanticMacroBindingsAvailable, false);
    gate.release();
    assert.equal(await pending, true);
    assert.equal(service.getModel(document.uri).semanticMacroBindingsAvailable, true);
    assert.equal(worker.models.has(first.snapshotId), false);
});

test("retained binding upgrade snapshots still reject changed closed disk sources", async (t) => {
    const { service, document, worker, workspace, filePath } = remoteFixture(t);
    assert.equal(await service.check(document, false), true);
    const first = service.getModel(document.uri);
    workspace.textDocuments = [];
    service.documentClosed(document);
    const gate = holdPreparedModel(t, worker);
    const pending = service.check(document, false, null, true);
    await gate.prepared;
    assert.equal(service.getModel(document.uri), first);
    fs.writeFileSync(filePath, "Dim changedDiskValue As Double\nPrint changedDiskValue\n");
    assert.equal(await first.query("hover", document.uri, { position: { line: 1, character: 8 } }), null,
        "keeping the old host snapshot must not bypass worker-owned disk freshness checks");
    assert.equal(service.getModel(document.uri), null);
    gate.release();
    assert.equal(await pending, false, "the already-prepared replacement is stale as well");
    assert.equal(worker.models.size, 0);
});

test("background reanalysis releases the replaced worker snapshot", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    assert.equal(await service.check(document, false), true);
    const first = service.getModel(document.uri);
    assert.ok(first instanceof CompilerRemoteModel);
    assert.ok(worker.models.has(first.snapshotId));

    const gate = holdPreparedModel(t, worker);
    const pending = service.check(document, false);
    await gate.prepared;
    assert.equal(service.getModel(document.uri), null, "an explicit same-capability recheck must not keep stale results");
    gate.release();
    assert.equal(await pending, true);
    const second = service.getModel(document.uri);
    assert.ok(second instanceof CompilerRemoteModel);
    assert.notEqual(second.snapshotId, first.snapshotId);
    assert.equal(worker.models.has(first.snapshotId), false);
    assert.equal(worker.models.has(second.snapshotId), true);

    document.getText = () => "Dim editedValue As String\nPrint editedValue\n";
    service.documentChanged(document);
    assert.equal(service.getModel(document.uri), null);
    assert.equal(worker.models.has(second.snapshotId), false, "A changed source must promptly release its worker graph");
});

test("background query replies cannot outlive changed editor buffers or generations", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    for (const change of [() => { document.getText = () => "Dim differentValue As Double\n"; }, () => service.invalidate()]) {
        document.getText = () => fs.readFileSync(document.uri.fsPath, "utf8");
        assert.equal(await service.check(document, false), true);
        const model = service.getModel(document.uri);
        const query = worker.query.bind(worker);
        worker.query = async (...args) => { const result = await query(...args); change(); return result; };
        assert.equal(await model.query("hover", document.uri, { position: { line: 1, character: 8 } }), null);
        worker.query = query;
        assert.equal(service.getModel(document.uri), null);
    }
});

test("query backpressure does not discard valid compiler snapshots", async (t) => {
    const { service, document, worker } = remoteFixture(t);
    assert.equal(await service.check(document, false), true);
    const model = service.getModel(document.uri);
    const query = worker.query.bind(worker);
    worker.query = async () => { throw new Error("The compiler analysis queue is full."); };
    assert.equal(await model.query("hover", document.uri), null);
    assert.equal(service.getModel(document.uri), model);
    worker.query = query;
    assert.ok(await model.query("hover", document.uri));
});

test("background preparation rejects trust loss, changed contexts, and closed dirty buffers", async (t) => {
    const { service, document, worker, workspace, values } = remoteFixture(t);
    const analyze = worker.analyze.bind(worker);
    for (const change of [() => { workspace.isTrusted = false; }, () => { values["analysis.compilerPath"] = "different-bridge"; }, () => { workspace.textDocuments = []; }]) {
        workspace.isTrusted = true;
        workspace.textDocuments = [document];
        values["analysis.compilerPath"] = process.execPath;
        document.getText = () => "Dim unsavedValue As Double\n";
        worker.analyze = async (...args) => { const reply = await analyze(...args); change(); return reply; };
        assert.equal(await service.check(document, false), false);
        assert.equal(service.snapshots.size, 0);
    }
});

test("a stale broken-buffer reply releases its prepared native worker model", native, async (t) => {
    const { service, document, worker, filePath } = remoteFixture(t, true);
    const diskSource = fs.readFileSync(filePath, "utf8");
    const brokenBuffer = "Dim recoveryValue As Double\nPrint recoveryValue +\nPrint recoveryValue * 2\n";
    const changedBuffer = "Dim latestValue As String\nPrint latestValue\n";
    document.getText = () => brokenBuffer;

    const analyze = worker.analyze.bind(worker);
    let prepared, release;
    const preparedResult = new Promise((resolve) => { prepared = resolve; });
    const waitForHost = new Promise((resolve) => { release = resolve; });
    let preparedSnapshotId;
    worker.analyze = async (...args) => {
        const reply = await analyze(...args);
        assert.equal(reply.partial, true, "The captured unsaved source must be analyzed in recovery mode");
        preparedSnapshotId = reply.snapshotId;
        prepared();
        await waitForHost;
        return reply;
    };

    const pending = service.check(document, false);
    await preparedResult;
    assert.ok(worker.models.has(preparedSnapshotId), "The worker should own the completed recovery model before host publication");
    document.getText = () => changedBuffer;
    service.documentChanged(document);
    release();

    assert.equal(await pending, false, "An edit during recovery publication must reject the stale result");
    assert.equal(service.snapshots.size, 0);
    assert.equal(worker.models.has(preparedSnapshotId), false, "The discarded native graph must not remain retained by the worker");
    assert.equal(fs.readFileSync(filePath, "utf8"), diskSource, "Neither captured editor version may be saved by analysis");
});

test("rapid broken-buffer edits publish only the newest worker snapshot", { ...native, timeout: 30000 }, async (t) => {
    const { service, document, worker, filePath } = remoteFixture(t, true);
    const diskSource = fs.readFileSync(filePath, "utf8");
    const versions = [
        "Dim firstRecoveryValue As Double\nPrint firstRecoveryValue +\nPrint firstRecoveryValue * 2\n",
        "Dim secondRecoveryValue As Long\nPrint secondRecoveryValue +\nPrint secondRecoveryValue * 3\n",
        "Dim latestValue As String\nPrint latestValue\n"
    ];
    const gates = new Map(versions.map((source) => {
        let reportReady, resume;
        return [source, {
            ready: new Promise((resolve) => { reportReady = resolve; }),
            wait: new Promise((resolve) => { resume = resolve; }),
            reportReady: (reply) => reportReady(reply),
            resume: () => resume()
        }];
    }));
    const analyze = worker.analyze.bind(worker);
    worker.analyze = async (...args) => {
        const reply = await analyze(...args);
        const source = args[0].overlays?.get(filePath);
        const gate = gates.get(source);
        assert.ok(gate, "Every worker request must use one captured editor version");
        gate.reportReady(reply);
        await gate.wait;
        return reply;
    };

    const pending = [];
    try {
        document.getText = () => versions[0];
        pending.push(service.check(document, false));
        const first = await gates.get(versions[0]).ready;
        assert.equal(first.partial, true, "The first broken buffer should finish recovery before the next edit");

        document.getText = () => versions[1];
        service.documentChanged(document);
        pending.push(service.check(document, false));
        const second = await gates.get(versions[1]).ready;
        assert.equal(second.partial, true, "The second broken buffer should finish recovery before the next edit");

        document.getText = () => versions[2];
        service.documentChanged(document);
        pending.push(service.check(document, false));
        const latest = await gates.get(versions[2]).ready;
        assert.equal(latest.partial, false, "The newest editor version should be complete");

        for (const gate of gates.values()) gate.resume();
        assert.deepEqual(await Promise.all(pending), [false, false, true]);
        assert.equal(service.snapshots.size, 1, "Only the latest completed buffer may publish a snapshot");
        assert.equal(worker.models.has(first.snapshotId), false, "The first stale recovery graph must be reclaimed");
        assert.equal(worker.models.has(second.snapshotId), false, "The second stale recovery graph must be reclaimed");
        assert.equal(worker.models.has(latest.snapshotId), true, "The latest graph must remain available");

        const model = service.getModel(document.uri);
        assert.ok(model);
        const typed = await model.expressionAt(document.uri, { line: 1, character: 6 }, { line: 1, character: 17 });
        assert.equal(typed?.typeName.toLowerCase(), "string", "Queries must use the newest unsaved buffer model");
        assert.equal(fs.readFileSync(filePath, "utf8"), diskSource, "None of the rapidly edited buffers may be saved by analysis");
    } finally {
        for (const gate of gates.values()) gate.resume();
        await Promise.allSettled(pending);
    }
});

test("editing during native compilation cancels the old buffer and publishes only the latest", { ...native, timeout: 30000 }, async (t) => {
    const { service, document, worker, filePath } = remoteFixture(t, true);
    const diskSource = fs.readFileSync(filePath, "utf8");
    const busyBuffer = Array.from({ length: 20000 }, (_, index) => `Print ${index + 1} + ${index + 2}`).join("\n") + "\n";
    const latestBuffer = "Dim latestBufferValue As String\nPrint latestBufferValue\n";
    document.getText = () => busyBuffer;

    const first = service.check(document, false);
    const processWaitStarted = Date.now();
    while (!worker.active?.pid && Date.now() - processWaitStarted < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(worker.active?.pid > 0, "Initial buffer analysis must reach an active compiler process");
    const processId = worker.active.pid;
    const oldTemporaryDirectory = worker.active.directory;

    const editStarted = Date.now();
    document.getText = () => latestBuffer;
    service.documentChanged(document);
    const second = service.check(document, false);
    assert.equal(await first, false, "The cancelled buffer must not publish a model");
    assert.equal(await second, true, "The latest buffer should run after the old compiler exits");

    const elapsedMs = Date.now() - editStarted;
    t.diagnostic(`Edit-to-current native model publication: ${elapsedMs} ms.`);
    assert.ok(elapsedMs < 10000, `The final buffer should publish promptly after cancelling obsolete work, got ${elapsedMs} ms`);
    assert.equal(service.snapshots.size, 1, "Only the latest editor generation may be retained");
    assert.equal(worker.models.size, 1, "Only the latest prepared compiler model may remain in the worker");
    assert.equal(fs.existsSync(oldTemporaryDirectory), false, "The cancelled compiler scratch directory must be removed");
    assert.throws(() => process.kill(processId, 0), { code: "ESRCH" }, "The obsolete compiler process must be reaped");

    const model = service.getModel(document.uri);
    assert.ok(model);
    const typed = await model.expressionAt(document.uri, { line: 1, character: 6 }, { line: 1, character: 23 });
    assert.equal(typed?.typeName.toLowerCase(), "string", "The published expression query must use the latest unsaved contents");
    assert.equal(fs.readFileSync(filePath, "utf8"), diskSource, "Neither analysis generation may write the user buffer to disk");
});

test("sustained broken-buffer edits reclaim each obsolete native analysis", { ...native, timeout: 30000 }, async (t) => {
    const { service, document, worker, filePath } = remoteFixture(t, true);
    const diskSource = fs.readFileSync(filePath, "utf8");
    const makeBrokenBuffer = (generation) => {
        const valueName = `sustainedValue${generation}`;
        return [
            `Dim ${valueName} As Double`,
            `Print ${valueName} +`,
            ...Array.from({ length: 20000 }, (_, index) => `Print ${valueName} * ${index + 1}`),
            ""
        ].join("\n");
    };
    const revisions = Array.from({ length: 5 }, (_, index) => makeBrokenBuffer(index));
    const finalBuffer = "Dim sustainedLatestValue As String\nPrint sustainedLatestValue\n";
    let currentBuffer = revisions[0];
    document.getText = () => currentBuffer;
    const waitForProcess = async (afterRequestId) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const entry = worker.active;
            if (entry?.pid > 0 && entry.id > afterRequestId) return { id: entry.id, pid: entry.pid, directory: entry.directory };
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        assert.fail("A sustained-edit revision did not reach an active native compiler process");
    };

    let peakRss = process.memoryUsage().rss;
    const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
    let pending = null;
    let active = null;
    let finalEditAt = 0;
    const cancelled = [];
    try {
        pending = service.check(document, false);
        active = await waitForProcess(0);
        for (let index = 0; index < revisions.length; index++) {
            currentBuffer = index + 1 < revisions.length ? revisions[index + 1] : finalBuffer;
            if (currentBuffer === finalBuffer) finalEditAt = Date.now();
            document.getText = () => currentBuffer;
            const cancelledAt = Date.now();
            service.documentChanged(document);
            const next = service.check(document, false);

            assert.equal(await pending, false, `Revision ${index} must be discarded after the next edit`);
            const discardMs = Date.now() - cancelledAt;
            const nextActive = await waitForProcess(active.id);
            const cleanupMs = Date.now() - cancelledAt;
            assert.equal(fs.existsSync(active.directory), false, `Revision ${index} compiler scratch directory must be removed`);
            assert.throws(() => process.kill(active.pid, 0), { code: "ESRCH" }, `Revision ${index} compiler process must be reaped`);
            assert.equal(worker.models.size, 0, `Revision ${index} must not retain a stale native model`);
            cancelled.push({ revision: index, requestId: active.id, discardMs, cleanupMs });
            pending = next;
            active = nextActive;
        }

        assert.equal(await pending, true, "The final valid buffer should publish after repeated cancellation");
        pending = null;

        const elapsedMs = Date.now() - finalEditAt;
        const maxDiscardMs = Math.max(...cancelled.map((entry) => entry.discardMs));
        const maxCleanupMs = Math.max(...cancelled.map((entry) => entry.cleanupMs));
        t.diagnostic(`Sustained edit burst: ${cancelled.length} obsolete runs; max discard ${maxDiscardMs} ms, max native cleanup ${maxCleanupMs} ms, latest publication ${elapsedMs} ms, sampled peak RSS ${(peakRss / (1024 * 1024)).toFixed(1)} MiB.`);
        assert.ok(elapsedMs < 10000, `The final buffer should publish after sustained edits, got ${elapsedMs} ms`);
        assert.equal(service.snapshots.size, 1, "Only the newest editor generation may remain published");
        assert.equal(worker.models.size, 1, "Only the newest native graph may remain retained");
        const model = service.getModel(document.uri);
        assert.ok(model);
        assert.equal(worker.models.has(model.snapshotId), true);
        assert.equal(fs.existsSync(active.directory), false, "A completed request must release its compiler scratch directory");
        const queryStart = { line: 1, character: 6 };
        const queryEnd = { line: 1, character: 6 + "sustainedLatestValue".length };
        assert.equal((await model.expressionAt(document.uri, queryStart, queryEnd))?.typeName.toLowerCase(), "string");
        assert.equal(fs.readFileSync(filePath, "utf8"), diskSource, "Sustained editor analysis must never save an overlay");
    } finally {
        clearInterval(memoryTimer);
        if (pending) {
            service.invalidate();
            await pending.catch(() => {});
        }
    }
});

test("model eviction removes matching host diagnostics and snapshot metadata", async (t) => {
    const { service, document, worker, options, preparation } = remoteFixture(t);
    const published = new Map();
    service.diagnosticCollection = { set: (uri, diagnostics) => published.set(uri.toString(), diagnostics), clear: () => published.clear(), dispose() {} };
    assert.equal(await service.check(document, false), true);
    const id = service.getModel(document.uri).snapshotId;
    const expandedUri = [...service.snapshots.values()][0].uri.toString();
    assert.ok(service.expanded.has(expandedUri));
    for (let index = 0; index < 8; index++) await worker.analyze(options, preparation);
    assert.equal(worker.models.has(id), false);
    assert.equal(service.snapshots.size, 0);
    assert.equal(service.expanded.has(expandedUri), false);
    assert.equal(published.size, 0);
});

test("expanded native call queries preserve physical overload targets", native, async (t) => {
    const { worker } = setup(t, true);
    const filePath = path.join(__dirname, "integration/workspace/compiler-overloads.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const options = { compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, allowErrors: false,
        exportSemanticExpressions: true, exportSemanticBindings: true };
    const analysis = await analyzeSavedModule(options);
    const reply = await worker.analyze(options, { requestedFile: filePath, expandedUri });
    const call = "Print SelectValue(CLng(1)), SelectValue(CDbl(1))";
    const sourcePosition = pointAt(text, call, call.lastIndexOf("SelectValue") + 1);
    const expandedCall = analysis.text.match(/SelectValue\s*\(\s*CDbl\s*\(\s*1\s*\)\s*\)/i);
    assert.ok(expandedCall);
    const expandedPosition = pointAt(analysis.text, expandedCall[0], 1);
    const query = async (operation, expanded = false) => (await worker.query(reply.snapshotId, operation, {
        uri: expanded ? expandedUri : { scheme: "file", fsPath: filePath },
        position: expanded ? expandedPosition : sourcePosition, openFiles: [], includeDeclaration: true
    })).result;
    try {
        const expected = await query("definition");
        assert.equal(expected.length, 1);
        const definitions = await query("definition", true);
        assert.deepEqual(definitions.map((entry) => [entry.uri.fsPath, entry.declaration.line]),
            expected.map((entry) => [entry.uri.fsPath, entry.declaration.line]));
        const hover = await query("hover", true);
        assert.ok(hover.entries.some((entry) => /value As Double/i.test(entry.declaration.signature)));
        const references = await query("references", true);
        assert.ok(references.some((entry) => entry.uri.fsPath === filePath && entry.occurrence.line === sourcePosition.line));
        const highlights = await query("highlights", true);
        assert.ok(highlights.some((entry) => entry.occurrence.line === expandedPosition.line &&
            entry.occurrence.startColumn <= expandedPosition.character && entry.occurrence.endColumn > expandedPosition.character));
        const otherCall = analysis.text.match(/SelectValue\s*\(\s*CLng\s*\(\s*1\s*\)\s*\)/i);
        assert.ok(otherCall);
        const otherPosition = pointAt(analysis.text, otherCall[0], 1);
        assert.equal(highlights.some((entry) => entry.occurrence.line === otherPosition.line &&
            entry.occurrence.startColumn <= otherPosition.character && entry.occurrence.endColumn > otherPosition.character), false,
            "expanded highlights must not mix native overload identities");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native worker queries match direct model results across source and expanded views", native, async (t) => {
    const { worker } = setup(t, true);
    for (const name of ["compiler-symbols.bas", "compiler-types.bas", "compiler-preprocessor.bas", "compiler-dispatch.bas",
        "compiler-constructor-overloads.bas", "implicit-argument-constructor.bas"]) {
        const filePath = path.join(__dirname, "integration/workspace", name);
        const text = fs.readFileSync(filePath, "utf8");
        const options = { compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, allowErrors: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: ["compiler-types.bas", "compiler-constructor-overloads.bas", "implicit-argument-constructor.bas"].includes(name) };
        const analysis = await analyzeSavedModule(options);
        const direct = new CompilerSemanticModel(CompilerUri.from(expandedUri), analysis, analysis.dependencies.map((file) => ({ uri: CompilerUri.file(file), text: fs.readFileSync(file, "utf8") })));
        const reply = await worker.analyze(options, { requestedFile: filePath, expandedUri });
        assert.equal(reply.declarationCount, direct.inner.entries.length);
        assert.equal(reply.semanticExpressionCount, analysis.semanticExpressions.length);
        assert.equal(reply.partial, false);
        const uri = { scheme: "file", fsPath: filePath };
        const query = async (operation, input = {}) => {
            const request = { uri, openFiles: [], ...input };
            const remote = (await worker.query(reply.snapshotId, operation, request)).result;
            assert.deepEqual(remote, queryCompilerModel(direct, operation, request, () => {}), `${name}: ${operation}`);
            return remote;
        };
        const tokens = await query("semanticTokens");
        assert.ok(tokens.length > 0);
        await query("semanticTokens", { uri: expandedUri });
        const source = direct.getDocument(CompilerUri.file(filePath));
        const identifiers = source.tokens.filter((token) => token.kind === "identifier");
        for (const token of identifiers) {
            const position = { line: token.line, character: token.startColumn };
            await query("definition", { position });
            await query("expression", { position });
        }
        if (name === "compiler-types.bas") {
            const threadCall = await query("expression", { position: pointAt(text, "ThreadCall ThreadWorker(0)") });
            assert.equal(threadCall?.typeName.toLowerCase(), "any ptr",
                "The prepared worker must retain the compiler-owned THREADCALL type fact.");
            const selectionRanges = await query("compilerSelectionRanges", {
                positions: [pointAt(text, "inferred * 2")]
            });
            assert.ok(selectionRanges[0].length >= 2,
                "The prepared worker should retain nested compiler expression ranges for Expand Selection.");
            const procedureReferences = await query("compilerProcedureReferenceCodeLenses");
            assert.ok(procedureReferences.entries.some((entry) => entry.name === "+" &&
                entry.references.some((reference) => reference.line === 35)),
                "The overloaded operator should include its compiler-receipted physical use site in CodeLens.");
            const inlayHints = await query("compilerInlayHints", {
                position: pointAt(text, "ThreadWorker(0)"),
                end: pointAt(text, "ThreadWorker(0)", "ThreadWorker(0)".length),
                parameterHints: true
            });
            assert.ok(inlayHints.parameters.some((hint) => hint.parameterName.toLowerCase() === "value"),
                "The prepared worker should return compiler-selected parameter names for explicit calls.");
        }
        if (name === "compiler-constructor-overloads.bas") {
            const constructorCall = "New ConstructorChoice(5)";
            const constructorHints = await query("compilerInlayHints", {
                position: pointAt(text, constructorCall),
                end: pointAt(text, constructorCall, constructorCall.length),
                parameterHints: true
            });
            assert.ok(constructorHints.parameters.some((hint) => hint.parameterName === "source"),
                "an explicit constructor call should use the selected constructor's parameter name");
            for (const [call, typeName] of [
                ["New ConstructorChoice(5)", "Long"],
                ["New ConstructorChoice(CDbl(5))", "Double"]
            ]) {
                const position = pointAt(text, call, "New ".length + "ConstructorChoice".length - 1);
                const definitions = await query("definition", { position });
                assert.equal(definitions.length, 1, `Definition should select the ${typeName} constructor.`);
                assert.equal(definitions[0].declaration.type, "constructor");
                assert.match(definitions[0].declaration.signature, new RegExp(`ByVal source As ${typeName}`, "i"));
            }
            const bareNewLine = "Dim defaultChoice As ConstructorChoice Ptr = New ConstructorChoice";
            const bareNewDefinitions = await query("definition", {
                position: pointAt(text, bareNewLine, bareNewLine.length - 1)
            });
            assert.equal(bareNewDefinitions.length, 1);
            assert.match(bareNewDefinitions[0].declaration.signature, /ConstructorChoice\(\)/i);
            const returnLine = "Return ConstructorChoice()";
            const returnDefinitions = await query("definition", {
                position: pointAt(text, returnLine, "Return ".length + "ConstructorChoice".length - 1)
            });
            assert.equal(returnDefinitions.length, 1);
            assert.match(returnDefinitions[0].declaration.signature, /ConstructorChoice\(\)/i);
        }
        if (name === "implicit-argument-constructor.bas") {
            const constructorLenses = await query("compilerProcedureReferenceCodeLenses");
            const selectedConstructors = constructorLenses.entries.filter((entry) =>
                /constructor/i.test(entry.name) && entry.references.length
            );
            assert.equal(selectedConstructors.length, 2,
                "the overload-specific implicit argument conversions should appear on their constructors");
            assert.equal(selectedConstructors.reduce((total, entry) => total + entry.references.length, 0), 2);
            const destructorLenses = constructorLenses.entries.filter((entry) =>
                /destructor/i.test(entry.name) && entry.references.length
            );
            assert.equal(destructorLenses.length, 1);
            assert.equal(destructorLenses[0].references.length, 2,
                "the temporary cleanup calls should appear on the destructor CodeLens");
            for (const [call, typeName] of [
                ["takeArgument(17)", "Long"],
                ["takeArgument(2.5)", "Double"]
            ]) {
                const position = pointAt(text, call, "takeArgument(".length);
                const definitions = await query("definition", { position });
                assert.equal(definitions.length, 1, `Definition should follow the ${typeName} argument conversion.`);
                assert.equal(definitions[0].declaration.type, "constructor");
                assert.match(definitions[0].declaration.signature, new RegExp(`ByVal initial As ${typeName}`, "i"));
                const declarations = await query("declaration", { position });
                assert.equal(declarations.length, 1, `Declaration should follow the ${typeName} argument conversion.`);
                assert.match(declarations[0].declaration.signature, new RegExp(`Declare Constructor\\(ByVal initial As ${typeName}\\)`, "i"));
            }
        }
        if (name === "compiler-symbols.bas") {
            const position = pointAt(text, "actual.value", 2);
            assert.equal((await query("references", { position, includeDeclaration: true })).length, 3);
            assert.equal((await query("target", { position })).entries[0].compilerSymbolId > 0, true);
            const procedureLenses = await query("compilerProcedureReferenceCodeLenses");
            assert.ok(procedureLenses.complete);
            assert.ok(procedureLenses.entries.some((entry) => entry.name.endsWith("ReadValue") && entry.references.length > 0),
                "the native worker should return compiler-identified procedure references for CodeLens");
            await query("highlights", { position });
            await query("hover", { position });
            const completion = await query("completion", { position: pointAt(text, "recordValue.value", 12) });
            assert.ok(completion.entries.some((entry) => entry.name === "value"));
            const signature = await query("signature", { position: pointAt(text, "Catalog.ReadValue(recordValue)", 23) });
            assert.match(signature.entries[0].declaration.signature, /ReadValue/);
            await query("typeDefinition", { position: pointAt(text, "recordValue.value", 2) });
        }
    }
});

test("stock FBC sidecar retains a bare call with omitted optional arguments", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Function OptionalValue(ByVal value As Long = 7) As Long",
        "    Return value",
        "End Function",
        "Sub OptionalAction(ByVal value As Long = 7)",
        "End Sub",
        "Sub Caller()",
        "    Dim result As Long = OptionalValue",
        "    OptionalAction",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "fb"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const line = 6;
        const startColumn = text.split("\n")[line].indexOf("OptionalValue");
        const position = { line, character: startColumn + 2 };
        const result = (await worker.query(reply.snapshotId, "compilerSidecarCallBindingAt", {
            ...input,
            position,
            name: "OptionalValue"
        })).result;
        assert.equal(result.complete, true);
        assert.deepEqual(result.calls.map((call) => [call.line, call.startColumn, call.endColumn,
            call.targetSymbols.length, call.declarations.map((declaration) => [
                declaration.line, declaration.startColumn, declaration.endColumn, declaration.name
            ])]), [[line, startColumn, startColumn + "OptionalValue".length, 1, [[0, 9, 22, "OptionalValue"]]]],
        "FBC should bind the bare call to the exact optional-argument declaration and physical token");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock FBC sidecar binds bare calls that omit defaulted arguments", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Function OptionalValue(ByVal value As Long = 7) As Long",
        "    Return value",
        "End Function",
        "Sub OptionalAction(ByVal value As Long = 7)",
        "End Sub",
        "Sub Caller()",
        "    Dim result As Long = OptionalValue",
        "    OptionalAction",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "fb"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const line = 6;
        const startColumn = text.split("\n")[line].indexOf("OptionalValue");
        const result = (await worker.query(reply.snapshotId, "compilerSidecarCallBindingAt", {
            ...input,
            position: { line, character: startColumn + 2 },
            name: "OptionalValue"
        })).result;
        assert.equal(result.complete, true);
        assert.deepEqual(result.calls.map((call) => [call.line, call.startColumn, call.endColumn,
            call.targetSymbols.length, call.declarations.map((declaration) => [
                declaration.line, declaration.startColumn, declaration.endColumn, declaration.name
            ])]), [[line, startColumn, startColumn + "OptionalValue".length, 1,
            [[0, 9, 22, "OptionalValue"]]]],
        "FBC should bind the bare optional-argument call to its exact declaration and token");
        const subCall = (await worker.query(reply.snapshotId, "compilerSidecarCallBindingAt", {
            ...input,
            position: { line: 7, character: 6 },
            name: "OptionalAction"
        })).result;
        assert.deepEqual(subCall.calls.map((call) => [call.line, call.startColumn, call.endColumn,
            call.targetSymbols.length, call.declarations.map((declaration) => [
                declaration.line, declaration.startColumn, declaration.endColumn, declaration.name
            ])]), [[7, 4, 18, 1, [[3, 4, 18, "OptionalAction"]]]],
        "FBC should also bind a bare Sub call with a defaulted argument");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native indexer navigation follows compiler-owned operator declarations", native, async (t) => {
    const { worker } = setup(t, true);
    const filePath = path.join(__dirname, "integration/workspace/compiler-expression-operations.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const options = {
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        allowErrors: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    };
    const reply = await worker.analyze(options, { requestedFile: filePath, expandedUri });
    try {
        const input = { uri: { scheme: "file", fsPath: filePath }, openFiles: [] };
        const position = pointAt(text, "indexedInstance[0]", "indexedInstance[".length);
        const definition = (await worker.query(reply.snapshotId, "definition", { ...input, position })).result;
        assert.equal(definition.length, 1);
        assert.match(definition[0].declaration.signature, /Operator\s+IndexedValue\.\[\]\(ByVal index As Long\)/i,
            "F12 should select the compiler-owned Operator [] implementation");
        const references = (await worker.query(reply.snapshotId, "references", { ...input, position, includeDeclaration: true })).result;
        const longUseColumn = text.split(/\r?\n/)[position.line].indexOf("indexedInstance[0]");
        assert.ok(references.some((entry) => entry.occurrence.line === position.line &&
            entry.occurrence.startColumn === longUseColumn &&
            entry.occurrence.endColumn === longUseColumn + "indexedInstance[0]".length),
        "Long operator references should include the physical index expression");
        assert.equal(references.some((entry) => entry.occurrence.line === pointAt(text, "indexedInstance[0.5]").line), false,
            "Long operator references must exclude the compiler-selected Double index call");
        const operatorDeclarationPosition = pointAt(text,
            "Operator IndexedValue.[](ByVal index As Long)", "Operator IndexedValue.".length);
        const declarationHierarchy = (await worker.query(reply.snapshotId, "callHierarchyPrepare", {
            ...input, position: operatorDeclarationPosition
        })).result;
        assert.equal(declarationHierarchy.length, 1);
        assert.match(declarationHierarchy[0].declaration.signature, /ByVal index As Long/i);
        const declarationReferences = (await worker.query(reply.snapshotId, "references", {
            ...input, position: operatorDeclarationPosition, includeDeclaration: true
        })).result;
        assert.ok(declarationReferences.some((entry) => entry.occurrence.line === position.line &&
            entry.occurrence.startColumn === longUseColumn),
        "Go to References on the operator declaration should include its implicit index call");
        const highlights = (await worker.query(reply.snapshotId, "highlights", { ...input, position })).result;
        assert.ok(highlights.some((entry) => entry.occurrence.line === position.line &&
            entry.occurrence.startColumn === longUseColumn &&
            entry.occurrence.endColumn === longUseColumn + "indexedInstance[0]".length));
        assert.equal(highlights.some((entry) => entry.occurrence.line === pointAt(text, "indexedInstance[0.5]").line), false,
            "document highlights should exclude the other index overload");
        const declaration = (await worker.query(reply.snapshotId, "declaration", { ...input, position })).result;
        assert.equal(declaration.length, 1);
        assert.ok(declaration[0].declaration.modifiers.includes("DECLARE"));
        assert.match(text.split(/\r?\n/)[declaration[0].declaration.line] || "",
            /Declare\s+Operator\s+\[\]\(ByVal index As Long\)/i,
            "Go to Declaration should return the compiler-owned Operator [] prototype");

        const doublePosition = pointAt(text, "indexedInstance[0.5]", "indexedInstance[".length);
        const doubleDefinition = (await worker.query(reply.snapshotId, "definition", { ...input, position: doublePosition })).result;
        assert.equal(doubleDefinition.length, 1);
        assert.match(doubleDefinition[0].declaration.signature, /Operator\s+IndexedValue\.\[\]\(ByVal index As Double\)/i,
            "the compiler-selected Double index overload should remain distinct");
        const doubleReferences = (await worker.query(reply.snapshotId, "references", { ...input, position: doublePosition, includeDeclaration: true })).result;
        assert.ok(doubleReferences.some((entry) => entry.occurrence.line === doublePosition.line));
        assert.equal(doubleReferences.some((entry) => entry.occurrence.line === position.line), false,
            "Double operator references must exclude the compiler-selected Long index call");
        const resultPosition = pointAt(text, 'indexedInstance["slot"]', "indexedInstance[".length);
        const resultTypes = (await worker.query(reply.snapshotId, "typeDefinition", { ...input, position: resultPosition })).result;
        assert.ok(resultTypes.some((entry) => entry.name.toLowerCase() === "indexedresult"),
            "type definition on an index expression should use the compiler-selected operator result type");
        const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position })).result;
        assert.equal(hover.entries.length, 1);
        assert.match(hover.entries[0].declaration.signature, /Operator\s+IndexedValue\.\[\]\(ByVal index As Long\)/i,
            "hover should present the compiler-selected index overload");
        assert.match(hover.expression.typeName, /double/i,
            "hover should show the result type of the complete index expression");

        const hierarchy = (await worker.query(reply.snapshotId, "callHierarchyPrepare", { ...input, position })).result;
        assert.equal(hierarchy.length, 1);
        assert.match(hierarchy[0].declaration.signature, /Operator\s+IndexedValue\.\[\]\(ByVal index As Long\)/i);
        const incoming = (await worker.query(reply.snapshotId, "callHierarchyIncoming", { ...input, position })).result;
        assert.ok(incoming.some((caller) => caller.declaration.detail === "Module-level calls" &&
            caller.fromRanges.some((range) => range.line === position.line && range.startColumn === longUseColumn)),
        "the selected indexer should show its implicit module-level call site");
        assert.equal(incoming.some((caller) => caller.fromRanges.some((range) =>
            range.line === pointAt(text, "indexedInstance[0.5]").line)), false,
        "indexer call hierarchy should not mix another overload's call site");
        const moduleCalls = (await worker.query(reply.snapshotId, "callHierarchyOutgoing", { ...input, module: true })).result;
        assert.ok(moduleCalls.some((callee) => /ByVal index As Long/i.test(callee.declaration.signature)));
        assert.ok(moduleCalls.some((callee) => /ByVal index As Double/i.test(callee.declaration.signature)));
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock guarded indexer declaration ranges drive source navigation", native, async (t) => {
    const { FreeBasicSemanticModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const { createSemanticFeatures } = require("../lib/semantic-features");
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "indexed.bi");
    const header = ["#ifndef INDEXED_BI", "#define INDEXED_BI", "Type IndexNumber As Double", "Type Indexed", "value As Long",
        "#ifdef INACTIVE_BUILD", "Declare Operator [](ByVal inactiveIndex As Double) As Long", "#else",
        "Declare Operator [](ByVal activeIndex As Double) As Long", "#endif",
        "Declare Operator [](ByVal longIndex As Long) As Long", "End Type",
        "Operator Indexed.[](ByVal activeIndex As IndexNumber) As Long", "Return CLng(activeIndex)", "End Operator",
        "Operator Indexed.[](ByVal longIndex As Long) As Long", "Return longIndex", "End Operator", "#endif", ""].join("\n");
    const text = '#include "indexed.bi"\nDim item As Indexed\nPrint item[CDbl(1)]\nPrint item[CLng(2)]\nPrint item[CDbl(3)]\n' +
        "Function InvokeIndexed(ByRef value As Indexed) As Long\nReturn value[CDbl(4)]\nEnd Function\n";
    fs.writeFileSync(filePath, text);
    fs.writeFileSync(headerPath, header);
    const compiled = spawnSync(process.env.FBC_EXECUTABLE || options.compilerPath,
        ["-r", "-o", path.join(directory, "main.asm"), filePath], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const uri = CompilerUri.file(filePath), headerUri = CompilerUri.file(headerPath);
    const parsed = parseFreeBasicText(text);
    const source = new FreeBasicSemanticModel([{ uri: headerUri, parsed: parseFreeBasicText(header) },
        { uri, parsed, includeUris: new Set([headerUri.toString()]) }]);
    const point = pointAt(text, "item[CDbl(1)]", "item[CDbl(1)]".length - 1);
    const reply = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false);
    const receipt = (await worker.query(reply.snapshotId, "compilerSidecarOperatorExpressionAt", {
        ...input, position: point, operatorCode: "index"
    })).result;
    assert.equal(receipt.expressions.length, 1);
    assert.equal(receipt.expressions[0].declarations?.length, 2);
    class Range { constructor(line, column, endLine, endColumn) {
        this.start = { line, character: column }; this.end = { line: endLine, character: endColumn };
    } }
    class Location { constructor(uri, range) { Object.assign(this, { uri, range }); } }
    class DocumentHighlight { constructor(range, kind) { Object.assign(this, { range, kind }); } }
    class CallHierarchyItem { constructor(kind, name, detail, uri, range, selectionRange) {
        Object.assign(this, { kind, name, detail, uri, range, selectionRange });
    } }
    class CallHierarchyIncomingCall { constructor(from, fromRanges) { Object.assign(this, { from, fromRanges }); } }
    const workspace = { textDocuments: [] };
    const compiler = { remote: true, semanticSidecarOnly: true, semanticBindingsAvailable: true,
        async query(operation, uri, query) {
            if (["compilerSidecarOperatorExpressions", "compilerSidecarOperatorExpressionsInSnapshot"].includes(operation)) {
                assert.equal(query.targetSymbol, receipt.expressions[0].targetSymbols[0],
                    "operator references must send the selected snapshot's native symbol to the worker");
            }
            return (await worker.query(reply.snapshotId, operation, { ...input, ...query, uri })).result;
        } };
    const features = createSemanticFeatures({ Range, Location, DocumentHighlight, DocumentHighlightKind: { Text: 0 },
        CallHierarchyItem, CallHierarchyIncomingCall, SymbolKind: { File: 0, Method: 5, Function: 11 }, workspace,
        Uri: { file: CompilerUri.file }, SemanticTokensLegend: class {} }, {
        compilerAnalysis: { analysisCompilerFor: () => ({ semanticModelOnly: true }),
            getModelForEditor: async () => compiler, getModel: () => compiler },
        getParsedDocument: () => parsed, ensureInitialized: async () => true, getSourceSemanticModel: () => source,
        getSemanticModel: () => source
    }, { keywords: [], types: [], operatorKeywords: [], constants: [] });
    const makeDocument = (uri, content) => ({ uri, version: 1, getText: () => content,
        lineAt: (line) => ({ text: content.split("\n")[line] }),
        positionAt: (offset) => ({ line: content.slice(0, offset).split("\n").length - 1,
            character: offset - content.lastIndexOf("\n", offset - 1) - 1 }),
        offsetAt: (position) => content.split("\n").slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character });
    const document = makeDocument(uri, text);
    const included = makeDocument(headerUri, header);
    workspace.textDocuments = [document, included];
    const declarations = await features.declaration.provideDeclaration(document, point);
    assert.equal(declarations.length, 1, JSON.stringify(receipt));
    assert.equal(declarations[0].range.start.line, 8);
    source.references = () => assert.fail("a selected native operator must not seed references from source guesses");
    const references = await features.reference.provideReferences(document, point, { includeDeclaration: true });
    assert.deepEqual(references.filter((entry) => entry.uri.fsPath === filePath).map((entry) => entry.range.start.line).sort(), [2, 4, 6]);
    assert.deepEqual(references.filter((entry) => entry.uri.fsPath === headerPath).map((entry) => entry.range.start.line).sort((a, b) => a - b), [8, 12]);
    const uses = await features.reference.provideReferences(document, point, { includeDeclaration: false });
    assert.ok(uses.every((entry) => entry.uri.fsPath === filePath));
    assert.deepEqual(uses.map((entry) => entry.range.start.line).sort(), [2, 4, 6]);
    const highlights = await features.documentHighlight.provideDocumentHighlights(document, point);
    assert.deepEqual(highlights.map((entry) => entry.range.start.line).sort(), [2, 4, 6]);
    for (const line of [8, 12]) {
        const entry = source.getDocument(headerUri).entries.find((entry) =>
            entry.declaration.type === "operator" && entry.declaration.line === line);
        const origin = { line, character: entry.declaration.endColumn - 1 };
        const references = await features.reference.provideReferences(included, origin, { includeDeclaration: false });
        assert.deepEqual(references.filter((entry) => entry.uri.fsPath === filePath)
            .map((entry) => entry.range.start.line).sort(), [2, 4, 6], "native references must also work from guarded declarations and bodies");
        const highlights = await features.documentHighlight.provideDocumentHighlights(included, origin);
        assert.deepEqual(highlights.map((entry) => entry.range.start.line).sort((a, b) => a - b), [8, 12]);
        for (const [provider, method, expected] of [[features.declaration, "provideDeclaration", 8],
            [features.definition, "provideDefinition", 12], [features.implementation, "provideImplementation", 12]]) {
            const locations = await provider[method](included, origin);
            assert.deepEqual(locations.map((entry) => [entry.uri.fsPath, entry.range.start.line]), [[headerPath, expected]],
                "guarded prototypes and bodies must preserve the requested native navigation role");
        }
    }
    const inactive = { line: 6, character: header.split("\n")[6].indexOf("]") };
    const getDocument = source.getDocument.bind(source);
    source.getDocument = (uri) => {
        const document = getDocument(uri);
        return document?.uri.fsPath === headerPath ? { ...document, entries: document.entries.filter((entry) =>
            !(entry.declaration.type === "operator" && entry.declaration.line === 12)) } : document;
    };
    const bodySite = receipt.expressions[0].declarations.find((site) => site.kind === "procedure-definition");
    const nativeOnly = await features.implementation.provideImplementation(included, { line: 8, character: header.split("\n")[8].indexOf("]") });
    assert.deepEqual(nativeOnly.map((entry) => [entry.uri.fsPath, entry.range.start.line, entry.range.start.character]),
        [[headerPath, bodySite.startLine - 1, bodySite.startColumn]], "an unindexed body must retain its physical compiler header target");
    source.getDocument = getDocument;
    for (const origin of [point, { line: 8, character: header.split("\n")[8].indexOf("]") },
        { line: 12, character: header.split("\n")[12].indexOf("]") }]) {
        const current = origin === point ? document : included;
        const prepared = await features.callHierarchy.prepareCallHierarchy(current, origin);
        assert.equal(prepared?.length, 1, "a guarded native indexer must prepare a hierarchy item");
        const portable = { ...prepared[0] };
        delete portable.data;
        const incoming = await features.callHierarchy.provideCallHierarchyIncomingCalls(portable);
        const module = incoming.find((call) => call.from.detail === "Module-level calls");
        assert.deepEqual(module?.fromRanges.map((range) => range.start.line).sort(), [2, 4]);
        const caller = incoming.find((call) => call.from.name === "InvokeIndexed");
        assert.deepEqual(caller?.fromRanges.map((range) => range.start.line), [6]);
        assert.deepEqual(await features.callHierarchy.provideCallHierarchyIncomingCalls({ ...portable,
            detail: portable.detail + " changed" }), [], "a stale hierarchy signature must not bind to a current declaration");
    }
    assert.deepEqual(await features.reference.provideReferences(included, inactive, { includeDeclaration: true }), []);
    assert.deepEqual(await features.documentHighlight.provideDocumentHighlights(included, inactive), []);
    const query = compiler.query.bind(compiler);
    compiler.query = async (operation, uri, input) => {
        const result = await query(operation, uri, input);
        if (operation === "compilerSidecarOperatorExpressionsInSnapshot") document.version++;
        return result;
    };
    assert.deepEqual(await features.reference.provideReferences(document, point, { includeDeclaration: true }), [],
        "an edit after the native reference query must discard its results without source fallback");
});

test("bridge hierarchy preserves physical operator captions and flags incomplete traces", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    for (const binary of [false, true]) {
        const lines = ["Type ExternalValue", "value As Long", "Declare Operator [](ByVal index As Long) As Long", "End Type",
            ...(binary ? ["Declare Operator +(ByRef value As ExternalValue, ByVal amount As Long) As Long"] : []),
            "Dim item As ExternalValue", "Print item[1]", ...(binary ? ["Print item + 2"] : []), ""];
        fs.writeFileSync(filePath, lines.join("\n"));
        const reply = await worker.analyze({ ...options, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        assert.equal(reply.partial, false);
        try {
            const records = (await worker.query(reply.snapshotId, "callHierarchyOutgoing", { ...input, module: true })).result;
            const indexed = records.find((entry) => entry.declaration.type === "operator" && entry.declaration.line === 2);
            assert.ok(indexed, "a bridge trace must retain its known index call");
            assert.equal(indexed.declaration.signature, lines[2], "display must use the complete physical prototype, not normalized trace text");
            const column = lines[2].indexOf("[]");
            assert.deepEqual([indexed.declaration.startColumn, indexed.declaration.endColumn], [column, column + 2]);
            const symbols = (await worker.query(reply.snapshotId, "documentSymbols", input)).result;
            const outline = symbols.find((entry) => entry.type === "operator" && entry.selection.start.line === 2);
            assert.ok(outline, "native Outline must retain the external index operator");
            assert.equal(outline.name, "Operator []");
            assert.equal(outline.signature, lines[2], "native Outline must present the complete physical prototype");
            assert.deepEqual([outline.selection.start.character, outline.selection.end.character], [column, column + 2]);
            assert.equal(symbols[outline.parent].name, "ExternalValue", "presentation must retain native parent ownership");
            assert.equal(records.some((entry) => entry.compilerRequiresImplicitProjection === true), binary,
                "non-index operator declarations require full projection, while index-only graphs keep their fast path");
            const pass = await worker.beginWorkspace(new Map(), "", 5000);
            try {
                const indexedWorkspace = await worker.indexWorkspace(options, { id: pass.workspaceId });
                const workspace = mapPackedWorkspaceEntries(indexedWorkspace.packedEntries, indexedWorkspace.strings)
                    .find((entry) => entry.type === "operator" && entry.selection.start.line === 2);
                assert.ok(workspace, "workspace symbol search must retain the native operator");
                assert.deepEqual([workspace.name, workspace.signature, workspace.selection], [outline.name, outline.signature, outline.selection],
                    "workspace symbols and Outline must share physical operator presentation");
                await worker.finishWorkspace(pass.workspaceId, new Map());
            } finally { worker.discardWorkspace(pass.workspaceId); }
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("stock external operator declarations retain calls without local procedure bodies", native, async (t) => {
    const { FreeBasicSemanticModel } = require("../lib/semantic-model");
    const { parseFreeBasicText } = require("../lib/freebasic-parser");
    const { sidecarSelectedOperatorTarget } = require("../lib/semantic-features");
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["Type ExternalValue", "value As Long", "Declare Operator [](ByVal index As Long) As Long", "End Type",
        "Declare Operator +(ByRef value As ExternalValue, ByVal amount As Long) As Long",
        "Dim item As ExternalValue", "Print item[1]", "Print item + 2", ""].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false);
    for (const [declaration, query, key, call] of [
        ["Declare Operator []", "compilerSidecarOperatorExpressionsInSnapshot", "expressions", "item[1]"],
        ["Declare Operator +", "compilerSidecarOperatorOperationsInSnapshot", "operations", "item + 2"]
    ]) {
        const target = (await worker.query(reply.snapshotId, "compilerSidecarOperatorDeclarationAt", {
            ...input, position: pointAt(text, declaration, declaration.length - 1), kind: "procedure-prototype"
        })).result;
        assert.equal(target?.targetSymbols.length, 1);
        const result = (await worker.query(reply.snapshotId, query, input)).result;
        assert.equal(result.complete, true);
        const uses = result[key].filter((record) => record.targetSymbols.length === 1 && record.targetSymbols[0] === target.targetSymbols[0]);
        assert.equal(uses.length, 1, "native call identity must not depend on a local P body");
        assert.equal(uses[0].line, pointAt(text, call).line);
        assert.deepEqual(uses[0].procedures, []);
    }
    const uri = CompilerUri.file(filePath);
    const source = new FreeBasicSemanticModel([{ uri, parsed: parseFreeBasicText(text) }]);
    const document = { uri, version: 1, getText: () => text,
        lineAt: (line) => ({ text: text.split("\n")[line] }),
        offsetAt: (position) => source.getDocument(uri).lineOffsets[position.line] + position.character };
    const compiler = { remote: true, semanticSidecarOnly: true, semanticBindingsAvailable: true,
        async query(operation, uri, query) {
            return (await worker.query(reply.snapshotId, operation, { ...input, ...query, uri })).result;
        },
        expressionAt(uri, position, end) { return this.query("expression", uri, { position, end }); } };
    const selected = await sidecarSelectedOperatorTarget({}, document, pointAt(text, "item + 2", "item ".length),
        source, null, compiler);
    assert.equal(selected?.entry?.declaration.line, pointAt(text, "Declare Operator +").line,
        "external operator call sites must retain their native prototype without a P body");
});

test("native and stock-sidecar navigation preserve identifier bindings inside index arguments", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Type IndexArgument",
        "    value As Long",
        "End Type",
        "Type IndexedValue",
        "    value As Long",
        "    Declare Operator [](ByRef index As IndexArgument) As Double",
        "End Type",
        "Operator IndexedValue.[](ByRef index As IndexArgument) As Double",
        "    Return index.value",
        "End Operator",
        "Function MakeIndex() As IndexArgument",
        "    Return Type<IndexArgument>(1)",
        "End Function",
        "Dim item As IndexedValue",
        "#if 1",
        "Dim indexChoice As IndexArgument",
        "#else",
        "Dim indexChoice As Long",
        "#endif",
        "Print item[indexChoice]",
        "Print item[MakeIndex()]",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const position = pointAt(text, "item[indexChoice]", "item[".length + 2);
    const declarationLine = pointAt(text, "Dim indexChoice").line;
    const compiled = spawnSync(process.env.FBC_EXECUTABLE || options.compilerPath, ["-pp", filePath], { encoding: "utf8" });
    assert.equal(compiled.status, 0, `${compiled.stdout}${compiled.stderr}`);
    for (const semanticModelOnly of [true, false]) {
        const reply = await worker.analyze({ ...options, semanticModelOnly,
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            for (const operation of ["definition", "declaration"]) {
                const entries = (await worker.query(reply.snapshotId, operation, { ...input, position })).result;
                assert.deepEqual(entries.map((entry) => [entry.name, entry.declaration.line]), [["indexChoice", declarationLine]],
                    `${operation} should select the argument variable with stock sidecar=${semanticModelOnly}`);
            }
            for (const operation of ["references", "highlights"]) {
                const entries = (await worker.query(reply.snapshotId, operation,
                    { ...input, position, includeDeclaration: true })).result;
                assert.deepEqual(entries.map((entry) => entry.occurrence.line).sort((first, second) => first - second),
                    [declarationLine, position.line]);
            }
            const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position })).result;
            assert.deepEqual(hover.entries.map((entry) => entry.name), ["indexChoice"],
                "hover must describe the argument identifier, not the surrounding index operator");
            assert.equal(hover.entries[0].declaration.line, declarationLine,
                "hover must use the compiler-selected declaration rather than an inactive same-named variable");
            assert.equal(hover.expression.typeName.toLowerCase(), "indexargument");
            const types = (await worker.query(reply.snapshotId,
                semanticModelOnly ? "compilerSidecarTypeDefinition" : "typeDefinition", { ...input, position })).result;
            assert.deepEqual(types.map((entry) => [entry.name, entry.declaration.line]), [["IndexArgument", 0]]);
            const hierarchy = (await worker.query(reply.snapshotId, "callHierarchyPrepare", { ...input, position })).result;
            assert.deepEqual(hierarchy, [], "a variable argument is not a call to its surrounding index operator");
            const nestedPosition = pointAt(text, "item[MakeIndex()]", "item[".length + 2);
            const nestedHover = (await worker.query(reply.snapshotId, "hover", { ...input, position: nestedPosition })).result;
            assert.deepEqual(nestedHover.entries.map((entry) => entry.name), ["MakeIndex"]);
            if (!semanticModelOnly) {
                const nestedCalls = (await worker.query(reply.snapshotId, "callHierarchyPrepare",
                    { ...input, position: nestedPosition })).result;
                assert.deepEqual(nestedCalls.map((entry) => entry.name), ["MakeIndex"],
                    "Call Hierarchy should select the nested callee rather than the index operator");
            }
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
});

test("native type-call signature help selects the declared UDT constructor", native, async (t) => {
    const { worker } = setup(t, true);
    const filePath = path.join(__dirname, "integration/workspace/compiler-types.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const reply = await worker.analyze({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        allowErrors: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, { requestedFile: filePath, expandedUri });
    try {
        const position = pointAt(text, "WrappedValue(5)", "WrappedValue(".length);
        const result = (await worker.query(reply.snapshotId, "signature", {
            uri: { scheme: "file", fsPath: filePath },
            openFiles: [],
            position
        })).result;
        assert.equal(result.entries.length, 1);
        assert.match(result.entries[0].declaration.signature, /Constructor\s+WrappedValue\(ByVal source As Long\)/i);
        assert.equal(result.selectedCompilerSymbolId, result.entries[0].compilerSymbolId,
            "signature help should use the compiler-selected constructor family");
        const newPosition = pointAt(text, "New WrappedValue(5)", "New WrappedValue(".length);
        const newResult = (await worker.query(reply.snapshotId, "signature", {
            uri: { scheme: "file", fsPath: filePath },
            openFiles: [],
            position: newPosition
        })).result;
        assert.equal(newResult.entries.length, 1);
        assert.match(newResult.entries[0].declaration.signature, /Constructor\s+WrappedValue\(ByVal source As Long\)/i);
        assert.equal(newResult.selectedCompilerSymbolId, newResult.entries[0].compilerSymbolId,
            "NEW calls should activate the selected constructor when binding facts are requested");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native NEW constructor signature help selects the exact overload from binding facts", native, async (t) => {
    const { worker } = setup(t, true);
    const filePath = path.join(__dirname, "integration/workspace/compiler-constructor-overloads.bas");
    const text = fs.readFileSync(filePath, "utf8");
    const reply = await worker.analyze({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        allowErrors: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, { requestedFile: filePath, expandedUri });
    try {
        const position = pointAt(text, "New ConstructorChoice(CDbl(5))", "New ConstructorChoice(".length);
        const result = (await worker.query(reply.snapshotId, "signature", {
            uri: { scheme: "file", fsPath: filePath },
            openFiles: [],
            position
        })).result;
        assert.equal(result.entries.length, 1);
        assert.match(result.entries[0].declaration.signature, /Constructor\s+ConstructorChoice\(ByVal source As Double\)/i);
        assert.equal(result.selectedCompilerSymbolId, result.entries[0].compilerSymbolId);

        const declarationReferences = (await worker.query(reply.snapshotId, "references", {
            uri: { scheme: "file", fsPath: filePath },
            openFiles: [],
            position: pointAt(text, "Declare Constructor(ByVal source As Double)", "Declare ".length),
            includeDeclaration: true
        })).result;
        const doubleNewLine = pointAt(text, "New ConstructorChoice(CDbl(5))").line;
        const longNewLine = pointAt(text, "New ConstructorChoice(5)").line;
        assert.ok(declarationReferences.some((entry) => entry.occurrence.line === doubleNewLine),
            "constructor references should include the compiler-selected NEW use");
        assert.equal(declarationReferences.some((entry) => entry.occurrence.line === longNewLine), false,
            "constructor references should not include a sibling overload's NEW use");

        const callReferences = (await worker.query(reply.snapshotId, "references", {
            uri: { scheme: "file", fsPath: filePath },
            openFiles: [],
            position: pointAt(text, "New ConstructorChoice(CDbl(5))", "New ".length)
        })).result;
        assert.ok(callReferences.some((entry) => entry.occurrence.line === doubleNewLine),
            "references from a NEW call should resolve to its compiler-selected constructor");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native document symbols preserve physical scopes, macro parameters, and recovery results", native, async (t) => {
    const { worker, directory, options, preparation } = setup(t, true);
    const symbolsPath = path.join(__dirname, "integration/workspace/compiler-symbols.bas");
    const preprocessorPath = path.join(__dirname, "integration/workspace/compiler-preprocessor.bas");
    const input = (filePath, uri = { scheme: "file", fsPath: filePath }) => ({ uri, openFiles: [] });
    const read = async (filePath, uri = { scheme: "file", fsPath: filePath }) => {
        const reply = await worker.analyze({ ...options, filePath }, { ...preparation, requestedFile: filePath, expandedUri });
        return (await worker.query(reply.snapshotId, "documentSymbols", input(filePath, uri))).result;
    };
    const symbols = await read(symbolsPath);
    const workspacePass = await worker.beginWorkspace(new Map(), "", 5000);
    try {
        const workspaceResult = await worker.indexWorkspace({ ...options, filePath: symbolsPath }, { id: workspacePass.workspaceId });
        const workspaceRecords = mapPackedWorkspaceEntries(workspaceResult.packedEntries, workspaceResult.strings);
        const symbolShape = (entry) => ({
            name: entry.name,
            type: entry.type,
            containerName: entry.containerName,
            qualifiedName: entry.qualifiedName,
            signature: entry.signature,
            uri: entry.uri.scheme === "file" ? entry.uri.fsPath : entry.uri.value,
            selection: entry.selection
        });
        assert.deepEqual(workspaceRecords.map(symbolShape), symbols.filter((entry) => entry.workspaceVisible).map(symbolShape));
        assert.equal(workspaceResult.declarations, workspaceRecords.length);
        await worker.finishWorkspace(workspacePass.workspaceId, new Map());
    } finally {
        worker.discardWorkspace(workspacePass.workspaceId);
    }
    const byLocation = new Map(symbols.map((entry) => [`${entry.name}:${entry.selection.start.line}`, entry]));
    const catalog = byLocation.get("Catalog:8");
    const record = byLocation.get("Record:9");
    const field = byLocation.get("value:10");
    const prototype = byLocation.get("ReadValue:17");
    const body = byLocation.get("ReadValue:20");
    assert.equal(catalog.parent, null);
    assert.equal(record.parent, catalog.index);
    assert.equal(field.parent, record.index);
    assert.equal(prototype.parent, catalog.index);
    assert.equal(body.parent, null, "Out-of-line method definitions must retain their physical location.");
    assert.equal(byLocation.get("declared:17").parent, prototype.index);
    assert.equal(byLocation.get("actual:20").parent, body.index);
    assert.equal(byLocation.get("value:21").parent, body.index);
    assert.equal(byLocation.get("complete:33").workspaceVisible, false);
    assert.equal(catalog.range.end.line, 18);
    const macros = await read(preprocessorPath);
    const macroByLocation = new Map(macros.map((entry) => [`${entry.name}:${entry.selection.start.line}`, entry]));
    assert.equal(macroByLocation.get("value:8").parent, macroByLocation.get("SCALE_VALUE:8").index);
    assert.equal(macroByLocation.get("item:9").parent, macroByLocation.get("SCALE_VALUE:9").index);
    const nestedMacro = macros.find((entry) => entry.name === "NESTED_SCALE");
    const nestedArgument = macros.find((entry) => entry.name === "argument");
    assert.ok(nestedMacro, "the nested macro should be visible at its physical source definition");
    assert.ok(nestedArgument, "the nested macro parameter should be visible at its physical source definition");
    assert.equal(nestedArgument.parent, nestedMacro.index);
    const expanded = await read(preprocessorPath, expandedUri);
    assert.ok(expanded.some((entry) => entry.name === "inputValue"));
    assert.ok(!expanded.some((entry) => entry.type === "macro"), "Expanded source must not fabricate preprocessor directives.");
    const recoveryPath = path.join(directory, "recovery.bas");
    fs.writeFileSync(recoveryPath, "Namespace Ready\n    Dim keptValue As Long\nEnd Namespace\nPrint keptValue +\nDim laterValue As Double\n");
    const recovery = await worker.analyze({ ...options, filePath: recoveryPath }, { ...preparation, requestedFile: recoveryPath, expandedUri });
    assert.equal(recovery.partial, true);
    const recovered = (await worker.query(recovery.snapshotId, "documentSymbols", input(recoveryPath))).result;
    assert.deepEqual(recovered.map((entry) => entry.name), ["Ready", "keptValue", "laterValue"]);
    assert.ok(recovered.every((entry) => !entry.partial));
    const scopeRecoveryPath = path.join(directory, "scope-recovery.bas");
    fs.writeFileSync(scopeRecoveryPath, "Function ActiveValue() As Long\n    Dim insideValue As Long\n    ActiveValue = insideValue\n");
    const scopeRecovery = await worker.analyze({ ...options, filePath: scopeRecoveryPath }, { ...preparation, requestedFile: scopeRecoveryPath, expandedUri });
    assert.equal(scopeRecovery.partial, true);
    const recoveredScope = (await worker.query(scopeRecovery.snapshotId, "documentSymbols", input(scopeRecoveryPath))).result;
    assert.deepEqual(recoveredScope.map((entry) => entry.name), ["ActiveValue", "insideValue"]);
    assert.ok(recoveredScope.every((entry) => entry.partial));
    const scopeCompletion = (await worker.query(scopeRecovery.snapshotId, "completion", { ...input(scopeRecoveryPath), position: { line: 2, character: 26 } })).result;
    assert.ok(scopeCompletion.entries.some((entry) => entry.name === "insideValue" && entry.declaration.provisional));
});

test("stock semantic sidecar selects ordinary procedure signatures from physical call bindings", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "declare function SidecarOverload overload (byval value as integer) as integer",
        "declare function SidecarOverload overload (byval value as double) as double",
        "dim as integer integerResult = SidecarOverload(1)",
        "dim as double doubleResult = SidecarOverload(1.0)",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    try {
        for (const [call, declarationLine] of [
            ["SidecarOverload(1)", 0],
            ["SidecarOverload(1.0)", 1]
        ]) {
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input,
                position: pointAt(text, call, "SidecarOverload(".length)
            })).result;
            assert.equal(result.entries.length, 2, "cached binding models must retain native overload alternatives");
            const selected = result.entries.find((entry) => entry.compilerSymbolId === result.selectedCompilerSymbolId);
            assert.equal(selected.declaration.line, declarationLine);
            assert.equal(selected.declaration.parameters[0].typeName.toLowerCase(),
                declarationLine === 0 ? "integer" : "double");
            assert.ok(Array.isArray(result.selectedSidecarDeclarations));
            assert.ok(result.selectedSidecarDeclarations.some((site) => site.line === declarationLine),
                `FBC should map ${call} to its selected physical declaration`);
        }
        const codeLenses = (await worker.query(reply.snapshotId, "compilerProcedureReferenceCodeLenses", input)).result;
        const overloadLenses = codeLenses.entries.filter((entry) => entry.name === "SidecarOverload")
            .sort((first, second) => first.line - second.line);
        assert.deepEqual(overloadLenses.map((entry) => [entry.line,
            entry.references.map((reference) => reference.line)]), [[0, [2]], [1, [3]]],
        "procedure CodeLens should retain FBC's selected overload at each call site");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock overload signatures retain native families, access, roles, and declaration order", native, async (t) => {
    const { worker, directory, filePath, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "signatures.bi");
    const header = ["Declare Function Choose Overload(ByVal amount As Long) As Long",
        "Declare Function Choose Overload(ByVal amount As Double) As Double",
        "Declare Sub Apply Overload(ByVal amount As Long)", "Declare Sub Apply Overload(ByVal amount As Double)",
        "Namespace OtherFamily", "Declare Function Choose Overload(ByVal amount As Long) As Long",
        "Declare Function Choose Overload(ByVal amount As Double) As Double", "End Namespace",
        "Type SignatureService", "    value As Long",
        "Declare Function Measure Overload(ByVal amount As Long) As Long",
        "Declare Function Measure Overload(ByVal amount As Double) As Double",
        "Declare Property Item(ByVal index As Long) As Long",
        "Declare Property Item(ByVal index As Double) As Double",
        "Declare Property Item(ByVal index As Long, ByVal newValue As Long)",
        "Private:", "Declare Function Measure Overload(ByVal amount As String) As Long",
        "Protected:", "Declare Function Measure Overload(ByVal amount As Short) As Long", "End Type",
        "Declare Function Early Overload(ByVal amount As Double) As Double", ""].join("\n");
    const text = ["Declare Function Early Overload(ByVal amount As Long) As Long", "Print Early(CLng(1))",
        '#include "signatures.bi"',
        "Print Early(CDbl(1))", "Dim service As SignatureService", "Print Choose(CLng(1))", "Print Choose(CDbl(1))",
        "Print OtherFamily.Choose(CDbl(1))", "Apply CDbl(1)", "Print service.Measure(CLng(1))",
        "Print service.Measure(CDbl(1))", "Print service.Item(CLng(1))", "Print service.Item(CDbl(1))", ""].join("\n");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options,
        compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true, exportSemanticBindings: true }, preparation);
    try {
        assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
        for (const [spelling, count, selectedType] of [["Early(CLng(1))", 1, "long"], ["Early(CDbl(1))", 2, "double"],
            ["Choose(CLng(1))", 2, "long"], ["Choose(CDbl(1))", 2, "double"],
            ["OtherFamily.Choose(CDbl(1))", 2, "double"], ["Apply CDbl(1)", 2, "double"],
            ["service.Measure(CLng(1))", 2, "long"], ["service.Measure(CDbl(1))", 2, "double"],
            ["service.Item(CLng(1))", 2, "long"], ["service.Item(CDbl(1))", 2, "double"]]) {
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input, position: pointAt(text, spelling, spelling.length - (spelling.startsWith("Apply ") ? 0 : 1))
            })).result;
            assert.equal(result?.entries.length, count, spelling);
            const selected = result.entries.find((entry) => entry.compilerSymbolId === result.selectedCompilerSymbolId);
            assert.equal(selected?.declaration.parameters[0].typeName.toLowerCase(), selectedType, spelling);
            assert.ok(result.entries.every((entry) => entry.declaration.parameters.length === 1), "getter/setter roles must stay separate");
            if (spelling.startsWith("OtherFamily")) assert.ok(result.entries.every((entry) => entry.declaration.line >= 4));
            if (spelling.startsWith("service.Measure")) assert.ok(result.entries.every((entry) =>
                !/amount As (?:String|Short)/i.test(entry.declaration.signature)), "inaccessible overloads must stay hidden");
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock overload expansion withholds uninspected producers and invalid native chains", native, async (t) => {
    const { filePath } = setup(t, true);
    const text = ["Declare Function Choose Overload(ByVal amount As Long) As Long",
        "Declare Function Choose Overload(ByVal amount As Double) As Double", "Print Choose(CLng(1))", ""].join("\n");
    fs.writeFileSync(filePath, text);
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EXECUTABLE || process.env.FBC_EDITOR_EXECUTABLE,
        filePath, semanticModelOnly: true, exportSemanticBindings: true, allowErrors: true });
    assert.equal(analysis.partial, false);
    const declaration = analysis.semanticBindings.find((binding) => binding.role === "declaration" &&
        binding.filePath === filePath && binding.startLine === 1 && binding.startColumn === text.indexOf("Choose"));
    assert.ok(declaration);
    const edge = analysis.semanticRelationships.find((relation) => relation.kind === "overload-next" &&
        (relation.source === declaration.symbol || relation.target === declaration.symbol));
    assert.ok(edge);
    const uri = CompilerUri.file(filePath);
    const query = { uri, position: pointAt(text, "Choose(CLng(1))", "Choose(CLng(1)".length), openFiles: [filePath] };
    for (const mode of ["current", "unknown", "future", "cycle", "oversized"]) {
        const model = new CompilerSemanticModel(CompilerUri.from(expandedUri), analysis, [{ uri, text }]);
        if (mode === "unknown") model.compilerSemanticModelCompilerVersion = "";
        if (mode === "future") model.compilerSemanticModelCompilerVersion = "1.20.6";
        if (mode === "cycle") model.compilerSemanticRelationships = [...analysis.semanticRelationships,
            { ...edge, source: edge.target, target: edge.source }];
        if (mode === "oversized") {
            const extra = [];
            let source = edge.target;
            const firstUnusedSymbol = analysis.semanticBindings.reduce((maximum, binding) => Math.max(maximum, binding.symbol), 0) + 1;
            // The query allows at most 64 linked overload identities.
            for (let index = 0; index < 64; index++) {
                const target = firstUnusedSymbol + index;
                extra.push({ ...edge, source, target });
                source = target;
            }
            model.compilerSemanticRelationships = [...analysis.semanticRelationships, ...extra];
        }
        const result = queryCompilerModel(model, "signature", query, () => {});
        assert.equal(result.entries.length, mode === "current" ? 2 : 1, mode);
        assert.ok(result.entries.some((entry) => entry.compilerSymbolId === result.selectedCompilerSymbolId), mode);
    }
});

test("semantic sidecar supplies procedure reference CodeLens from cached bindings", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Type SidecarLengthValue",
        "    value As Long",
        "End Type",
        "Declare Operator Len(ByRef value As SidecarLengthValue) As Long",
        "Operator Len(ByRef value As SidecarLengthValue) As Long",
        "    Return value.value",
        "End Operator",
        "Dim lengthValue As SidecarLengthValue",
        "Print Len(lengthValue)",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "fb"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const result = (await worker.query(reply.snapshotId, "compilerProcedureReferenceCodeLenses", input)).result;
        const lines = text.split("\n");
        const lengthDeclaration = lines.findIndex((line) => /^\s*Operator Len\(/i.test(line));
        const lengthCall = lines.findIndex((line) => /Print Len\(lengthValue\)/i.test(line));

        assert.equal(result.complete, true);
        assert.equal(result.entries.some((entry) => ["value", "lengthValue"].includes(entry.name)), false,
            "operator argument bindings must not become procedure reference lenses");
        const lengthEntry = result.entries.find((entry) => entry.line === lengthDeclaration &&
            entry.references.some((reference) => reference.line === lengthCall));
        assert.ok(lengthEntry, "the compiler-selected Operator Len should receive a reference lens");
        const lengthReference = lengthEntry.references.find((reference) => reference.line === lengthCall);
        const lengthSpelling = "Len(lengthValue)";
        assert.deepEqual([lengthReference.filePath, lengthReference.startColumn, lengthReference.endColumn], [
            filePath,
            lines[lengthCall].indexOf(lengthSpelling),
            lines[lengthCall].indexOf(lengthSpelling) + lengthSpelling.length
        ]);
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar maps parameter facts and selected direct-call hints", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Declare Function ParameterHints Overload(ByVal wholeValue As Integer, ByVal fractionalValue As Double) As Double",
        "Declare Function ParameterHints Overload(ByVal label As String, ByVal repeatCount As Integer) As Integer",
        "Dim result As Double = ParameterHints(7, 1.5)",
        "Declare Function UncertainParameters(ByVal declaredName As Integer) As Integer",
        "Function UncertainParameters(ByVal implementationName As Integer) As Integer",
        "    Return implementationName",
        "End Function",
        "Dim uncertainResult As Integer = UncertainParameters(3)",
        "Const inferredNumber = 1.5",
        "Const SidecarConstant As ULongInt = 42",
        "Print SidecarConstant",
        "Enum SidecarMode",
        "    SidecarModeFast = 7",
        "End Enum",
        "Print SidecarModeFast",
        "Print SidecarModeFast",
        "Sub SidecarEnumUse()",
        "    Print SidecarModeFast",
        "End Sub",
        "Enum SidecarOtherMode",
        "    SidecarModeOther = 9",
        "End Enum",
        "Print SidecarModeOther",
        "Enum SidecarExplicitMode Explicit",
        "    SidecarModeExplicit = 11",
        "    SidecarModeExplicitTwo = 12",
        "End Enum",
        "Sub SidecarExplicitEnumUse()",
        "    Dim SidecarModeEntry As Integer",
        "    Print SidecarModeEntry",
        "End Sub",
        "Const SidecarFloat As Double = 1.5",
        "Print SidecarFloat",
        "Print 2 + 3",
        "Const SidecarString As String = \"Hello\"",
        "Print SidecarString",
        "Print WStr(\"café\")",
        "Dim sidecarAccessValue As Integer",
        "sidecarAccessValue = 1",
        "sidecarAccessValue += 2",
        "Print sidecarAccessValue",
        "Sub SidecarReference(ByRef referencedValue As Integer)",
        "End Sub",
        "Dim callerValue As Integer",
        "SidecarReference(callerValue)",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false, "different prototype and implementation parameter names are legal FreeBASIC");
    try {
        const line = text.split("\n")[2];
        const hints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 2, character: 0 },
            end: { line: 2, character: line.length },
            parameterHints: true
        })).result;
        assert.deepEqual(hints.parameters.map((hint) => hint.parameterName), ["wholeValue", "fractionalValue"]);
        assert.deepEqual(hints.parameters.map((hint) => hint.position.character), [line.indexOf("7"), line.indexOf("1.5")]);

        const byRefLine = text.split("\n").findIndex((sourceLine) => sourceLine.includes("SidecarReference(callerValue)"));
        const byRefCallLine = text.split("\n")[byRefLine];
        const byRefHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: byRefLine, character: 0 },
            end: { line: byRefLine, character: byRefCallLine.length },
            parameterHints: true
        })).result;
        assert.ok(byRefHints.parameters.some((hint) => hint.parameterName === "referencedValue" &&
            hint.passingMode === "byref"),
        `the stock semantic sidecar should carry compiler-selected ByRef mode to argument hints: ${JSON.stringify(byRefHints.parameters)}`);

        const parameterLine = text.split("\n").findIndex((sourceLine) =>
            sourceLine.includes("Sub SidecarReference(ByRef referencedValue")
        );
        const parameterSource = text.split("\n")[parameterLine];
        const parameterHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: { line: parameterLine, character: parameterSource.indexOf("referencedValue") + 2 }
        })).result;
        assert.equal(parameterHover.compilerParameterFacts?.parameterPassing?.mode, "byref",
            "stock-sidecar parameter declaration hover should show its compiler-selected passing mode");

        const uncertainLine = text.split("\n")[7];
        const uncertainHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 7, character: 0 },
            end: { line: 7, character: uncertainLine.length },
            parameterHints: true
        })).result;
        assert.deepEqual(uncertainHints.parameters, [],
            "disagreeing source signatures for one procedure should not guess a parameter label");

        const typeHints = (await worker.query(reply.snapshotId, "compilerTypeInlayHints", {
            ...input,
            position: { line: 8, character: 0 },
            end: { line: 8, character: text.split("\n")[8].length }
        })).result;
        assert.ok(typeHints.some((hint) => hint.typeName.toLowerCase() === "double"),
            `the stock sidecar should still expose compiler-selected types for an inferred declaration: ${JSON.stringify(typeHints)}`);

        for (const position of [
            pointAt(text, "SidecarConstant"),
            { line: 10, character: text.split("\n")[10].lastIndexOf("SidecarConstant") }
        ]) {
            const constant = (await worker.query(reply.snapshotId, "compilerSidecarConstantAt", {
                ...input,
                position
            })).result;
            assert.equal(constant?.value, "42",
                "the sidecar should map both constant declarations and references to the exact value");
            const hover = (await worker.query(reply.snapshotId, "hover", {
                ...input, position, includeSymbolConstant: true
            })).result;
            assert.deepEqual(hover.symbolConstant, constant, "hover must return the symbol's value on the same snapshot");
            const boundHover = (await worker.query(reply.snapshotId, "hover", {
                ...input, position, includeBoundSymbolConstant: true
            })).result;
            assert.deepEqual(boundHover.symbolConstant, constant, "resolved constant hovers should fetch their values without a source-model hint");
            const ordinaryHover = (await worker.query(reply.snapshotId, "hover", { ...input, position })).result;
            assert.equal(Object.hasOwn(ordinaryHover, "symbolConstant"), false, "unrequested hovers must not fetch symbol values");
        }
        const constantLine = text.split("\n")[9];
        const constantStart = constantLine.indexOf("SidecarConstant");
        const constantValues = (await worker.query(reply.snapshotId, "compilerSidecarConstantsAtSites", {
            ...input,
            sites: [{
                index: 0,
                filePath,
                line: 9,
                startColumn: constantStart,
                endColumn: constantStart + "SidecarConstant".length
            }]
        })).result;
        assert.deepEqual(constantValues, [{ index: 0, kind: "unsigned", value: "42" }],
            "completion should be able to request values for a bounded list of exact declaration sites");

        for (const position of [
            pointAt(text, "SidecarModeFast"),
            { line: 14, character: text.split("\n")[14].lastIndexOf("SidecarModeFast") }
        ]) {
            const enumValue = (await worker.query(reply.snapshotId, "compilerSidecarConstantAt", {
                ...input,
                position
            })).result;
            assert.equal(enumValue?.value, "7",
                "compiler enum member values should be available on declarations and references");
            const hover = (await worker.query(reply.snapshotId, "hover", {
                ...input, position, includeSymbolConstant: true
            })).result;
            assert.deepEqual(hover.symbolConstant, enumValue, "enum hover values must use the selected query snapshot");
            const boundHover = (await worker.query(reply.snapshotId, "hover", {
                ...input, position, includeBoundSymbolConstant: true
            })).result;
            assert.deepEqual(boundHover.symbolConstant, enumValue, "resolved enum hovers should fetch their native values");
        }
        const variableHover = (await worker.query(reply.snapshotId, "hover", {
            ...input, position: pointAt(text, "Dim sidecarAccessValue", "Dim ".length + 1), includeBoundSymbolConstant: true
        })).result;
        assert.equal(variableHover.entries[0]?.declaration?.type, "variable");
        assert.equal(Object.hasOwn(variableHover, "symbolConstant"), false, "ordinary cached variables must not fetch constant values");
        const enumLine = text.split("\n")[12];
        const enumStart = enumLine.indexOf("SidecarModeFast");
        const enumValueSites = (await worker.query(reply.snapshotId, "compilerSidecarConstantsAtSites", {
            ...input,
            sites: [{
                index: 0,
                filePath,
                line: 12,
                startColumn: enumStart,
                endColumn: enumStart + "SidecarModeFast".length
            }]
        })).result;
        assert.deepEqual(enumValueSites, [{ index: 0, kind: "signed", value: "7" }],
            "stock-sidecar completion sites should resolve enum member values too");

        const repeatedEnumLine = text.split("\n").findIndex((sourceLine, index) =>
            index > 14 && sourceLine.trim() === "Print SidecarModeFast");
        const otherEnumLine = text.split("\n").findIndex((sourceLine) => sourceLine.trim() === "Print SidecarModeOther");
        const repeatedEnumColumn = text.split("\n")[repeatedEnumLine].indexOf("SidecarModeFast");
        const otherEnumColumn = text.split("\n")[otherEnumLine].indexOf("SidecarModeOther");
        const enumOwners = (await worker.query(reply.snapshotId, "compilerSidecarEnumMembersAtSites", {
            ...input,
            sites: [
                {
                    filePath,
                    line: 14,
                    startColumn: text.split("\n")[14].indexOf("SidecarModeFast"),
                    endColumn: text.split("\n")[14].indexOf("SidecarModeFast") + "SidecarModeFast".length
                },
                {
                    filePath,
                    line: repeatedEnumLine,
                    startColumn: repeatedEnumColumn,
                    endColumn: repeatedEnumColumn + "SidecarModeFast".length
                },
                {
                    filePath,
                    line: otherEnumLine,
                    startColumn: otherEnumColumn,
                    endColumn: otherEnumColumn + "SidecarModeOther".length
                }
            ]
        })).result;
        assert.equal(enumOwners.length, 3,
            "the sidecar should resolve every exact enum-member reference site");
        assert.equal(enumOwners[0].owner, enumOwners[1].owner,
            "references to members of one enum should share the compiler-selected owner");
        assert.notEqual(enumOwners[0].owner, enumOwners[2].owner,
            "members from different enums should not be treated as interchangeable");

        const enumProcedureLine = text.split("\n").findIndex((sourceLine, index) =>
            index > 14 && sourceLine.trim() === "Print SidecarModeFast");
        const enumReferenceLine = text.split("\n")[enumProcedureLine];
        const enumReferenceStart = enumReferenceLine.indexOf("SidecarModeFast");
        const enumCompletions = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: enumProcedureLine, character: enumReferenceStart + "SidecarModeF".length },
            limit: 100
        })).result;
        assert.ok(enumCompletions.entries.some((entry) => entry.declaration.type === "enumMember" &&
            entry.name.toLowerCase() === "sidecarmodefast"),
        `stock-sidecar completion should offer compiler-bound enum members: ${JSON.stringify(enumCompletions)}`);

        const explicitEnumUseLine = text.split("\n").findIndex((sourceLine) =>
            sourceLine.trim() === "Print SidecarModeEntry");
        const explicitEnumLineText = text.split("\n")[explicitEnumUseLine];
        const explicitEnumUseColumn = explicitEnumLineText.indexOf("SidecarModeEntry");
        const explicitEnumCompletions = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: explicitEnumUseLine, character: explicitEnumUseColumn + "SidecarModeE".length },
            limit: 100
        })).result;
        assert.ok(!explicitEnumCompletions.entries.some((entry) =>
            entry.name.toLowerCase() === "sidecarmodeexplicit"),
        "unqualified completion must not expose an Explicit enum member");

        const floatValue = (await worker.query(reply.snapshotId, "compilerSidecarConstantAt", {
            ...input,
            position: pointAt(text, "SidecarFloat")
        })).result;
        assert.deepEqual(floatValue, { kind: "float64-bits", value: "0x3FF8000000000000" },
            "stock-sidecar floating constants should retain the producer's exact IEEE-754 bits");
        const floatLineIndex = text.split("\n").findIndex((sourceLine) => sourceLine.startsWith("Const SidecarFloat"));
        const floatLine = text.split("\n")[floatLineIndex];
        const floatStart = floatLine.indexOf("SidecarFloat");
        const floatValueSites = (await worker.query(reply.snapshotId, "compilerSidecarConstantsAtSites", {
            ...input,
            sites: [{
                index: 0,
                filePath,
                line: floatLineIndex,
                startColumn: floatStart,
                endColumn: floatStart + "SidecarFloat".length
            }]
        })).result;
        assert.deepEqual(floatValueSites, [{
            index: 0,
            kind: "float64-bits",
            value: "0x3FF8000000000000"
        }], "stock-sidecar completion lookups should retain float bits as well as display values");

        const foldedExpression = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "2 + 3", 2)
        })).result;
        assert.deepEqual(foldedExpression.expressionConstantValues, [{ kind: "signed", value: "5" }],
            "stock-sidecar hover should join a folded value to its exact physical expression identity");
        const foldedSelection = (await worker.query(reply.snapshotId, "expression", {
            ...input,
            position: pointAt(text, "2 + 3"),
            end: pointAt(text, "2 + 3", "2 + 3".length)
        })).result;
        assert.deepEqual(foldedSelection.compilerConstantValues, [{ kind: "signed", value: "5" }],
            "the explicit expression-type command query should retain the folded compiler value");
        const stringConstant = (await worker.query(reply.snapshotId, "compilerSidecarConstantAt", {
            ...input,
            position: pointAt(text, "SidecarString")
        })).result;
        assert.deepEqual(stringConstant, { kind: "bytes", value: "48656C6C6F" },
            "stock-sidecar bindings should expose exact bytes for named string constants");
        const stringExpression = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "\"Hello\"")
        })).result;
        assert.deepEqual(stringExpression.expressionConstantValues, [{ kind: "bytes", value: "48656C6C6F" }],
            "stock-sidecar expression hovers should retain the same exact string bytes");
        const wideExpression = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "WStr(\"café\")")
        })).result;
        assert.deepEqual(wideExpression.expressionConstantValues, [{
            kind: "wide-units",
            value: "000000630000006100000066000000E9"
        }], "stock-sidecar expression hovers should retain compiler-reported wide Unicode units");

        const accessSites = [
            ["sidecarAccessValue = 1", 0],
            ["sidecarAccessValue += 2", 0],
            ["Print sidecarAccessValue", "Print ".length]
        ].map(([spelling, relative], index) => {
            const position = pointAt(text, spelling, relative);
            const token = "sidecarAccessValue";
            return {
                index,
                filePath,
                line: position.line,
                startColumn: position.character,
                endColumn: position.character + token.length
            };
        });
        const accessRoles = (await worker.query(reply.snapshotId, "compilerSidecarAccessRolesAtSites", {
            ...input,
            sites: accessSites
        })).result;
        assert.deepEqual(accessRoles, [
            { index: 0, role: "write" },
            { index: 1, role: "read-write" },
            { index: 2, role: "read" }
        ], "cached stock-sidecar binding roles should support exact read/write highlighting");

    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock FBC semantic sidecar binds qualified Explicit-enum parameter defaults", {
    skip: !process.env.FBC_EXECUTABLE
}, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-qualified-enum-defaults-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "qualified-default.bas");
    const text = [
        "Enum ExplicitColors Explicit",
        "    Red = 1",
        "    Blue = 2",
        "End Enum",
        "Declare Sub ChooseColor(value As Integer = ExplicitColors.Red)",
        "Sub ChooseColor(value As Integer = ExplicitColors.Blue)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EXECUTABLE,
        filePath,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        allowErrors: true
    });
    assert.equal(analysis.semanticSidecarOnly, true);
    assert.equal(analysis.partial, false, JSON.stringify(analysis.diagnostics.map((item) => item.message)));
    assert.ok(analysis.diagnostics.some((item) => /Mismatching parameter initializer/i.test(item.message)),
        "the current stock compiler should report the qualified enum-default mismatch");

    const uri = CompilerUri.file(filePath);
    const model = new CompilerSemanticModel(expandedUri, analysis, [{ uri, text }]);
    const lines = text.split("\n");
    const declarationLine = lines.findIndex((line) => line.startsWith("Declare Sub ChooseColor"));
    const definitionLine = lines.findIndex((line) => line.startsWith("Sub ChooseColor"));
    const declarationMemberStart = lines[declarationLine].lastIndexOf("Red");
    const definitionMemberStart = lines[definitionLine].lastIndexOf("Blue");
    const owners = queryCompilerModel(model, "compilerSidecarEnumMembersAtSites", {
        uri: { scheme: "file", fsPath: filePath },
        position: { line: declarationLine, character: declarationMemberStart },
        sites: [
            {
                filePath,
                line: declarationLine,
                startColumn: declarationMemberStart,
                endColumn: declarationMemberStart + "Red".length
            },
            {
                filePath,
                line: definitionLine,
                startColumn: definitionMemberStart,
                endColumn: definitionMemberStart + "Blue".length
            }
        ]
    }, () => {});
    assert.equal(owners.length, 2,
        "FBC should retain physical bindings for both qualified parameter defaults");
    assert.equal(owners[0].owner, owners[1].owner,
        "both defaults should resolve to the same Explicit enum owner");
});

test("stock semantic sidecar completes enum members from an included header", native, async (t) => {
    const { worker, directory, filePath, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "colors.bi");
    const headerText = [
        "Enum IncludedColors",
        "    IncludedColorRed = 1",
        "End Enum",
        "Enum ExplicitIncludedColors Explicit",
        "    ExplicitIncludedColorRed = 2",
        "End Enum",
        "Namespace ImportedPalette",
        "    Enum PaletteColors",
        "        ImportedPaletteRed = 3",
        "        ImportedPaletteRedDark = 4",
        "    End Enum",
        "End Namespace",
        "Using ImportedPalette",
        ""
    ].join("\n");
    const text = [
        "Dim IncludedColorTemp As Integer",
        "Print IncludedColorTemp",
        "Dim ImportedPaletteRedEarlier As Integer",
        "Print ImportedPaletteRedEarlier",
        '#include "colors.bi"',
        "Sub UseIncludedColor()",
        "    Print IncludedColorRed",
        "    Dim ExplicitIncludedColorTemp As Integer",
        "    Print ExplicitIncludedColorTemp",
        "    Print ExplicitIncludedColors.ExplicitIncludedColorRed",
        "End Sub",
        "Sub UseImportedPalette()",
        "    Print ImportedPaletteRedDark",
        "End Sub",
        "Sub CompleteImportedPalette()",
        "    Dim ImportedPaletteRedCurrent As Integer",
        "    Print ImportedPaletteRedCurrent",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(headerPath, headerText);
    fs.writeFileSync(filePath, text);

    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics.map((diagnostic) => diagnostic.message)));
    assert.ok(reply.sources.some((source) => source.filePath === headerPath),
        "the selected compiler snapshot should retain the enum's included declaration source");
    try {
        const lines = text.split("\n");
        const beforeIncludeLineNumber = lines.findIndex((line) => line.trim() === "Print IncludedColorTemp");
        const beforeIncludeLine = lines[beforeIncludeLineNumber];
        const beforeIncludeStart = beforeIncludeLine.indexOf("IncludedColorTemp");
        const beforeInclude = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: beforeIncludeLineNumber, character: beforeIncludeStart + "IncludedColor".length },
            limit: 100
        })).result;
        assert.ok(!beforeInclude.entries.some((entry) => entry.name.toLowerCase() === "includedcolorred"),
            "a header enum must not be suggested before its accepted include directive");

        const beforeUsingLineNumber = lines.findIndex((line) => line.trim() === "Print ImportedPaletteRedEarlier");
        const beforeUsingLine = lines[beforeUsingLineNumber];
        const beforeUsingStart = beforeUsingLine.indexOf("ImportedPaletteRedEarlier");
        const beforeUsing = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: beforeUsingLineNumber, character: beforeUsingStart + "ImportedPaletteRed".length },
            limit: 100
        })).result;
        assert.ok(!beforeUsing.entries.some((entry) => entry.name.toLowerCase() === "importedpalettered"),
            "a header USING must not introduce its namespace before the accepted include directive");

        const includedEnumLineNumber = lines.findIndex((line) => line.trim() === "Print IncludedColorRed");
        const line = lines[includedEnumLineNumber];
        const memberStart = line.indexOf("IncludedColorRed");
        const result = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: includedEnumLineNumber, character: memberStart + "IncludedColorR".length },
            limit: 100
        })).result;
        assert.ok(result.entries.some((entry) => entry.declaration.type === "enumMember" &&
            entry.name.toLowerCase() === "includedcolorred"),
        `included enum members should be offered after their compiler-confirmed include: ${JSON.stringify(result)}`);

        const explicitUnqualifiedLine = lines.findIndex((line) => line.trim() === "Print ExplicitIncludedColorTemp");
        const explicitUnqualifiedText = lines[explicitUnqualifiedLine];
        const explicitUnqualifiedStart = explicitUnqualifiedText.indexOf("ExplicitIncludedColorTemp");
        const explicitUnqualifiedCompletions = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: {
                line: explicitUnqualifiedLine,
                character: explicitUnqualifiedStart + "ExplicitIncludedColor".length
            },
            limit: 100
        })).result;
        assert.ok(!explicitUnqualifiedCompletions.entries.some((entry) =>
            entry.name.toLowerCase() === "explicitincludedcolorred"),
        "an Explicit enum member from an included header must stay out of unqualified completion");

        const explicitLineNumber = lines.findIndex((line) => line.includes("ExplicitIncludedColors.ExplicitIncludedColorRed"));
        const explicitLine = lines[explicitLineNumber];
        const explicitMemberStart = explicitLine.indexOf("ExplicitIncludedColors.ExplicitIncludedColorRed");
        const explicitMemberReferenceStart = explicitLine.lastIndexOf("ExplicitIncludedColorRed");
        const explicitMemberOwner = (await worker.query(reply.snapshotId, "compilerSidecarEnumMembersAtSites", {
            ...input,
            sites: [{
                filePath,
                line: explicitLineNumber,
                startColumn: explicitMemberReferenceStart,
                endColumn: explicitMemberReferenceStart + "ExplicitIncludedColorRed".length
            }]
        })).result;
        assert.equal(explicitMemberOwner.length, 1,
            "FBC should bind the qualified Explicit enum member reference to its enum owner");
        const explicitMemberCompletions = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: {
                line: explicitLineNumber,
                character: explicitMemberStart + "ExplicitIncludedColors.ExplicitIncludedColorR".length
            },
            limit: 100
        })).result;
        assert.ok(explicitMemberCompletions.entries.some((entry) =>
            entry.name.toLowerCase() === "explicitincludedcolorred"),
        `qualified completion should retain Explicit enum members: ${JSON.stringify(explicitMemberCompletions)}`);

        const importedPaletteLine = lines.findIndex((line) => line.trim() === "Print ImportedPaletteRedDark");
        const importedPaletteText = lines[importedPaletteLine];
        const importedPaletteStart = importedPaletteText.indexOf("ImportedPaletteRedDark");
        const importedPaletteCompletions = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: importedPaletteLine, character: importedPaletteStart + "ImportedPaletteRed".length },
            limit: 100
        })).result;
        assert.ok(importedPaletteCompletions.entries.some((entry) => entry.declaration.type === "enumMember" &&
            entry.name.toLowerCase() === "importedpalettered"),
        `compiler-imported namespace members should complete from the included header: ${JSON.stringify(importedPaletteCompletions)}`);

        const unboundImportedLine = lines.findIndex((line) => line.trim() === "Print ImportedPaletteRedCurrent");
        const unboundImportedText = lines[unboundImportedLine];
        const unboundImportedStart = unboundImportedText.indexOf("ImportedPaletteRedCurrent");
        const unboundImportedCompletions = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: unboundImportedLine, character: unboundImportedStart + "ImportedPaletteRed".length },
            limit: 100
        })).result;
        assert.ok(unboundImportedCompletions.entries.some((entry) => entry.declaration.type === "enumMember" &&
            entry.name.toLowerCase() === "importedpalettered"),
        `accepted USING receipts should expose included namespace members without an existing enum reference: ${JSON.stringify(unboundImportedCompletions)}`);
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar uses selected constructors for parameter inlays", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Type SidecarChoice",
        "    wholeCount As Long",
        "    message As String",
        "    Declare Constructor(ByVal wholeCount As Long)",
        "    Declare Constructor(ByVal message As String)",
        "    Declare Constructor(ByRef copySource As SidecarChoice)",
        "End Type",
        "Type SidecarChoiceAlias As SidecarChoice",
        "Type SidecarChoiceAlias2 As SidecarChoiceAlias",
        "Constructor SidecarChoice(ByVal wholeCount As Long)",
        "    This.wholeCount = wholeCount",
        "End Constructor",
        "Constructor SidecarChoice(ByVal message As String)",
        "    This.message = message",
        "End Constructor",
        "Constructor SidecarChoice(ByRef copySource As SidecarChoice)",
        "    This.wholeCount = copySource.wholeCount",
        "End Constructor",
        "Declare Sub ConsumeSidecarChoice(ByVal marker As Long, ByVal choice As SidecarChoice)",
        "Sub ConsumeSidecarChoice(ByVal marker As Long, ByVal choice As SidecarChoice)",
        "End Sub",
        "Function MakeSidecarChoice() As SidecarChoice",
        "    Return SidecarChoice(5)",
        "End Function",
        "Function CopySidecarChoice() As SidecarChoice",
        "    Return MakeSidecarChoice()",
        "End Function",
        "Function MakeAliasSidecarChoice() As SidecarChoice",
        "    Return SidecarChoiceAlias(13)",
        "End Function",
        "Function MakeSecondAliasSidecarChoice() As SidecarChoice",
        "    Return SidecarChoiceAlias2(15)",
        "End Function",
        "Dim originalChoice As SidecarChoice = SidecarChoice(3)",
        "Dim copiedChoice As SidecarChoice = originalChoice",
        "Dim explicitInitializer As SidecarChoice = SidecarChoice(7)",
        "Dim convertedInitializer As SidecarChoice = 9",
        "Dim aliasInitializer As SidecarChoice = SidecarChoiceAlias(17)",
        "Dim secondAliasInitializer As SidecarChoice = SidecarChoiceAlias2(19)",
        "Dim firstChoice As SidecarChoice Ptr = New SidecarChoice(5)",
        "Dim secondChoice As SidecarChoice Ptr = New SidecarChoice(\"hello\")",
        "Dim aliasChoice As SidecarChoiceAlias Ptr = New SidecarChoiceAlias(11)",
        "Dim secondAliasChoice As SidecarChoiceAlias2 Ptr = New SidecarChoiceAlias2(21)",
        "ConsumeSidecarChoice(1, SidecarChoiceAlias2(23))",
        "ConsumeSidecarChoice 1, SidecarChoiceAlias2(25)",
        "ConsumeSidecarChoice(1, MakeSidecarChoice())",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticBindings: true
    }, preparation);
        assert.equal(reply.semanticSidecarOnly, true);
        assert.equal(reply.partial, false);
    try {
        const lines = text.split("\n");
        const implicitCalls = (await worker.query(reply.snapshotId, "compilerSidecarImplicitCallsInSnapshot", {
            ...input
        })).result;
        const argumentConstructor = implicitCalls.calls.find((call) => call.kind === "argument-constructor" &&
            call.line === lines.findIndex((line) => line.includes("ConsumeSidecarChoice(1, SidecarChoiceAlias2(23))")));
        assert.ok(argumentConstructor, "FBC should retain the selected constructor at a nested UDT argument");
        for (const [line, expectedName, expectedArgument] of [
            [lines.findIndex((line) => line.includes("New SidecarChoice(5)")), "wholeCount", "5"],
            [lines.findIndex((line) => line.includes("New SidecarChoice(\"hello\")")), "message", "\"hello\""],
            [lines.findIndex((line) => line.includes("Return SidecarChoice(5)")), "wholeCount", "5"],
            [lines.findIndex((line) => line.includes("Return SidecarChoiceAlias(13)")), "wholeCount", "13"],
            [lines.findIndex((line) => line.includes("Return SidecarChoiceAlias2(15)")), "wholeCount", "15"],
            [lines.findIndex((line) => line.includes("Return MakeSidecarChoice()")), "", ""],
            [lines.findIndex((line) => line.includes("= SidecarChoice(3)")), "wholeCount", "3"],
            [lines.findIndex((line) => line.includes("= originalChoice")), "", ""],
            [lines.findIndex((line) => line.includes("= SidecarChoice(7)")), "wholeCount", "7"],
            [lines.findIndex((line) => line.includes("= 9")), "", ""],
            [lines.findIndex((line) => line.includes("= SidecarChoiceAlias(17)")), "wholeCount", "17"],
            [lines.findIndex((line) => line.includes("= SidecarChoiceAlias2(19)")), "wholeCount", "19"],
            [lines.findIndex((line) => line.includes("New SidecarChoiceAlias(11)")), "wholeCount", "11"],
            [lines.findIndex((line) => line.includes("New SidecarChoiceAlias2(21)")), "wholeCount", "21"],
            [lines.findIndex((line) => line.includes("ConsumeSidecarChoice(1, SidecarChoiceAlias2(23))")), "wholeCount", "23"],
            [lines.findIndex((line) => line.includes("ConsumeSidecarChoice 1, SidecarChoiceAlias2(25)")), "wholeCount", "25"]
        ]) {
            const lineText = lines[line];
            const hints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
                ...input,
                position: { line, character: 0 },
                end: { line, character: lineText.length },
                parameterHints: true
            })).result;
            if (/^ConsumeSidecarChoice(?:\(|\s)/.test(lineText)) {
                assert.deepEqual(hints.parameters.map((hint) => [hint.parameterName, hint.passingMode]), [
                    ["marker", "byval"],
                    ["choice", "byval"],
                    ["wholeCount", "byval"]
                ]);
                assert.equal(hints.parameters.find((hint) => hint.parameterName === "wholeCount").position.character,
                    lineText.indexOf(expectedArgument),
                    "both parenthesized and bare outer calls should retain the nested constructor's own label");
                continue;
            }
            if (!expectedName) {
                assert.deepEqual(hints.parameters, [],
                    "an implicit copy constructor must not relabel a source function call as its constructor argument");
            } else {
                assert.deepEqual(hints.parameters.map((hint) => [hint.parameterName, hint.passingMode]), [
                    [expectedName, "byval"]
                ]);
                assert.equal(hints.parameters[0].position.character, lineText.indexOf(expectedArgument));
            }
        }
        const constructorDefinitionLine = lines.findIndex((line) =>
            line.startsWith("Constructor SidecarChoice(ByVal wholeCount")
        );
        for (const callLine of [
            lines.findIndex((line) => line.includes("New SidecarChoice(5)")),
            lines.findIndex((line) => line.includes("Return SidecarChoice(5)")),
            lines.findIndex((line) => line.includes("= SidecarChoice(7)")),
            lines.findIndex((line) => line.includes("Return SidecarChoiceAlias(13)")),
            lines.findIndex((line) => line.includes("Return SidecarChoiceAlias2(15)")),
            lines.findIndex((line) => line.includes("= SidecarChoiceAlias(17)")),
            lines.findIndex((line) => line.includes("= SidecarChoiceAlias2(19)")),
            lines.findIndex((line) => line.includes("ConsumeSidecarChoice(1, SidecarChoiceAlias2(23))")),
            lines.findIndex((line) => line.includes("ConsumeSidecarChoice 1, SidecarChoiceAlias2(25)"))
        ]) {
            const lineText = lines[callLine];
            const constructorNameStart = lineText.includes("ConsumeSidecarChoice(1, SidecarChoiceAlias2(23))")
                ? lineText.lastIndexOf("SidecarChoice", lineText.indexOf("(23)"))
                : lineText.lastIndexOf("SidecarChoice", lineText.indexOf("(", lineText.indexOf("SidecarChoice") + 1));
            const openParenthesis = lineText.indexOf("(", constructorNameStart);
            const signature = (await worker.query(reply.snapshotId, "signature", {
                ...input,
                position: { line: callLine, character: openParenthesis + 1 }
            })).result;
            assert.equal(signature.selectedConstructorProcedure?.startLine, constructorDefinitionLine + 1,
                `Signature Help should retain the selected constructor at line ${callLine + 1}`);
        }
        const implicitCopyLine = lines.findIndex((line) => line.includes("ConsumeSidecarChoice(1, MakeSidecarChoice())"));
        const implicitCopyText = lines[implicitCopyLine];
        const implicitCopyHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: implicitCopyLine, character: 0 },
            end: { line: implicitCopyLine, character: implicitCopyText.length },
            parameterHints: true
        })).result;
        assert.equal(implicitCopyHints.parameters.some((hint) => hint.parameterName === "wholeCount"), false,
            "an implicit copy of a function result must not be treated as a written constructor call");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar completes physical type aliases with their constructor parameters", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Type SnippetTarget",
        "    value As Long",
        "    Declare Constructor(ByVal amount As Long)",
        "End Type",
        "Constructor SnippetTarget(ByVal amount As Long)",
        "    This.value = amount",
        "End Constructor",
        "Sub ConsumeSnippetTarget(ByVal value As SnippetTarget)",
        "End Sub",
        "Type ShortAlias As SnippetTarget",
        "Function MakeSnippetTarget() As SnippetTarget",
        "    Return ShortAlias(3)",
        "End Function",
        "Dim initializedSnippet As SnippetTarget = SnippetTarget(4)",
        "ConsumeSnippetTarget(ShortAlias(5))",
        "Namespace CompletionSpace",
        "    Type NestedAlias As SnippetTarget",
        "End Namespace",
        "Function MakeQualifiedSnippetTarget() As SnippetTarget",
        "    Return CompletionSpace.NestedAlias(6)",
        "End Function",
        "Dim aliasObject As ShortAlias Ptr = New ShortAlias(1)",
        "Dim directObject As SnippetTarget Ptr = New SnippetTarget(1)",
        "Dim nestedObject As CompletionSpace.NestedAlias Ptr = New CompletionSpace.NestedAlias(2)",
        "Dim qualifiedInitialized As SnippetTarget = CompletionSpace.NestedAlias(7)",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics.map((diagnostic) => diagnostic.message)));
    try {
        const lines = text.split("\n");
        const lineNumber = lines.findIndex((line) => line.includes("New ShortAlias(1)"));
        const line = lines[lineNumber];
        const typeStart = line.indexOf("ShortAlias", line.indexOf("New"));
        const result = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: lineNumber, character: typeStart + "ShortAl".length },
            limit: 2000
        })).result;
        const alias = result.entries.find((entry) => entry.name === "ShortAlias");
        assert.ok(alias, JSON.stringify({ member: result.member,
            entries: result.entries.map((entry) => [entry.name, entry.declaration?.type, entry.declaration?.detail]) }));
        assert.deepEqual(alias?.constructorCallParameters?.map((parameter) => parameter.name), ["amount"],
            "FBC-anchored completion should resolve a type alias to its unique constructor");
        const returnLineNumber = lines.findIndex((line) => line.includes("Return ShortAlias(3)"));
        const returnLine = lines[returnLineNumber];
        const returnNameStart = returnLine.indexOf("ShortAlias");
        const returnResult = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: returnLineNumber, character: returnNameStart + "ShortAl".length },
            limit: 2000
        })).result;
        assert.deepEqual(returnResult.entries.find((entry) => entry.name === "ShortAlias")?.constructorCallParameters
            ?.map((parameter) => parameter.name), ["amount"],
        "Return type-constructor completion should use the same compiler-confirmed type candidate");
        const initializerLineNumber = lines.findIndex((line) => line.includes("= SnippetTarget(4)"));
        const initializerLine = lines[initializerLineNumber];
        const initializerNameStart = initializerLine.lastIndexOf("SnippetTarget");
        const initializerResult = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: initializerLineNumber, character: initializerNameStart + "SnippetT".length },
            limit: 2000
        })).result;
        assert.deepEqual(initializerResult.entries.find((entry) => entry.name === "SnippetTarget")
            ?.constructorCallParameters?.map((parameter) => parameter.name), ["amount"],
        "initializer type-constructor completion should offer compiler-declared constructor parameters");
        const argumentLineNumber = lines.findIndex((line) => line.includes("ConsumeSnippetTarget(ShortAlias(5))"));
        const argumentLine = lines[argumentLineNumber];
        const argumentNameStart = argumentLine.indexOf("ShortAlias", argumentLine.indexOf("ConsumeSnippetTarget"));
        const argumentResult = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: argumentLineNumber, character: argumentNameStart + "ShortAli".length },
            limit: 2000
        })).result;
        assert.deepEqual(argumentResult.entries.find((entry) => entry.name === "ShortAlias")
            ?.constructorCallParameters?.map((parameter) => parameter.name), ["amount"],
        "procedure-argument type constructors should offer their compiler-declared parameters");
        const qualifiedReturnLineNumber = lines.findIndex((line) => line.includes("Return CompletionSpace.NestedAlias(6)"));
        const qualifiedReturnLine = lines[qualifiedReturnLineNumber];
        const qualifiedReturnStart = qualifiedReturnLine.indexOf("CompletionSpace.NestedAlias");
        const qualifiedReturnResult = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: qualifiedReturnLineNumber, character: qualifiedReturnStart + "CompletionSpace.NestedAli".length },
            limit: 2000
        })).result;
        assert.deepEqual(qualifiedReturnResult.entries.find((entry) => entry.name === "NestedAlias")
            ?.constructorCallParameters?.map((parameter) => parameter.name), ["amount"],
        "qualified Return constructor completion should retain the FBC declaration identity");
        const qualifiedInitializerLineNumber = lines.findIndex((line) => line.includes("= CompletionSpace.NestedAlias(7)"));
        const qualifiedInitializerLine = lines[qualifiedInitializerLineNumber];
        const qualifiedInitializerStart = qualifiedInitializerLine.lastIndexOf("CompletionSpace.NestedAlias");
        const qualifiedInitializerResult = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: qualifiedInitializerLineNumber,
                character: qualifiedInitializerStart + "CompletionSpace.NestedAli".length },
            limit: 2000
        })).result;
        assert.deepEqual(qualifiedInitializerResult.entries.find((entry) => entry.name === "NestedAlias")
            ?.constructorCallParameters?.map((parameter) => parameter.name), ["amount"],
        "qualified initializer constructor completion should retain the FBC declaration identity");
        const directLineNumber = lines.findIndex((line) => line.includes("New SnippetTarget(1)"));
        const directLine = lines[directLineNumber];
        const directStart = directLine.indexOf("SnippetTarget", directLine.indexOf("New"));
        const directResult = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: directLineNumber, character: directStart + "SnippetT".length },
            limit: 2000
        })).result;
        const directType = directResult.entries.find((entry) => entry.name === "SnippetTarget");
        assert.deepEqual(directType?.constructorCallParameters?.map((parameter) => parameter.name), ["amount"],
            "flat-source sidecar completion should expose compiler-declared aggregate constructors too");
        const nestedLineNumber = lines.findIndex((line) => line.includes("New CompletionSpace.NestedAlias(2)"));
        const nestedLine = lines[nestedLineNumber];
        const nestedStart = nestedLine.indexOf("CompletionSpace.NestedAlias", nestedLine.indexOf("New"));
        const nestedResult = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: nestedLineNumber, character: nestedStart + "CompletionSpace.NestedAli".length },
            limit: 2000
        })).result;
        const nestedAlias = nestedResult.entries.find((entry) => entry.name === "NestedAlias");
        assert.deepEqual(nestedAlias?.constructorCallParameters?.map((parameter) => parameter.name), ["amount"],
            "qualified NEW type completion should recover namespace members from the exact source scope");
        assert.equal(nestedResult.member, false,
            "a qualified type prefix after NEW should remain constructor completion, not member access");
        const nestedOpenParenthesis = nestedLine.indexOf("(", nestedStart);
        const nestedSignature = (await worker.query(reply.snapshotId, "signature", {
            ...input,
            position: { line: nestedLineNumber, character: nestedOpenParenthesis + 1 }
        })).result;
        assert.equal(nestedSignature.selectedConstructorProcedure?.startLine, 5,
            "qualified constructor calls should retain the compiler-selected signature");
        const nestedHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: nestedLineNumber, character: 0 },
            end: { line: nestedLineNumber, character: nestedLine.length },
            parameterHints: true
        })).result;
        assert.deepEqual(nestedHints.parameters.map((hint) => hint.parameterName), ["amount"],
            "qualified constructor calls should keep the compiler-selected parameter hint");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar completes compiler-bound constructor types from included headers", native, async (t) => {
    const { worker, directory, filePath, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "constructor-types.bi");
    fs.writeFileSync(headerPath, [
        "Type HeaderChoice",
        "    value As Long",
        "    Declare Constructor(ByVal count As Long)",
        "End Type",
        ""
    ].join("\n"));
    const text = [
        '#include "constructor-types.bi"',
        "Constructor HeaderChoice(ByVal count As Long)",
        "    This.value = count",
        "End Constructor",
        "Function MakeHeaderChoice() As HeaderChoice",
        "    Return HeaderChoice(2)",
        "End Function",
        "Dim initializedHeaderChoice As HeaderChoice = HeaderChoice(3)",
        "Dim selectedHeaderObject As HeaderChoice Ptr = New HeaderChoice(1)",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-i", directory],
        semanticModelOnly: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics.map((diagnostic) => diagnostic.message)));
    try {
        const lines = text.split("\n");
        const lineNumber = lines.findIndex((line) => line.includes("New HeaderChoice(1)"));
        const line = lines[lineNumber];
        const typeStart = line.indexOf("HeaderChoice", line.indexOf("New"));
        const result = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: lineNumber, character: typeStart + "HeaderCho".length },
            limit: 2000
        })).result;
        const headerType = result.entries.find((entry) => entry.name === "HeaderChoice");
        assert.deepEqual(headerType?.constructorCallParameters?.map((parameter) => parameter.name), ["count"],
            "an included header type should use its exact FBC declaration binding and constructor signature");
        for (const [lineNumber, marker] of [
            [lines.findIndex((line) => line.includes("Return HeaderChoice(2)")), "Return HeaderCho"],
            [lines.findIndex((line) => line.includes("= HeaderChoice(3)")), "= HeaderCho"]
        ]) {
            const currentLine = lines[lineNumber];
            const prefixLength = marker.length;
            const completion = (await worker.query(reply.snapshotId, "completion", {
                ...input,
                position: { line: lineNumber, character: currentLine.indexOf(marker) + prefixLength },
                limit: 2000
            })).result;
            assert.deepEqual(completion.entries.find((entry) => entry.name === "HeaderChoice")
                ?.constructorCallParameters?.map((parameter) => parameter.name), ["count"],
            "included-header types should retain snippets in Return and initializer expressions");
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar type inlays retain continued initializer ranges", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Const continuedConstant = 1 + _",
        "    2",
        "Sub ContinuedInitializerProbe()",
        "    Dim continuedValue = 1 + _",
        "        2",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const lines = text.split("\n");
        const declaratorLine = 3;
        const line = lines[declaratorLine];
        const hints = (await worker.query(reply.snapshotId, "compilerTypeInlayHints", {
            ...input,
            position: { line: 0, character: 0 },
            end: { line: lines.length - 1, character: 0 }
        })).result;
        assert.equal(hints.length, 2,
            "continued compiler expressions should type preceding CONST and DIM declarations");
        const constantHint = hints.find((hint) => hint.position.line === 0);
        const variableHint = hints.find((hint) => hint.position.line === declaratorLine);
        assert.equal(constantHint?.position.character,
            lines[0].indexOf("continuedConstant") + "continuedConstant".length);
        assert.equal(variableHint?.position.character,
            line.indexOf("continuedValue") + "continuedValue".length);
        assert.ok(hints.every((hint) => /^(?:integer|long)$/i.test(hint.typeName)));
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native parameter facts report direct value writes without inferring indirect effects", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["Type ParameterRecord", "    fieldValue As Long", "End Type",
        "Sub AssignIndirect(ByRef destination As Long)", "    destination = 5", "End Sub",
        "Declare Sub ExternalWrites(ByRef externalValue As Long)",
        "Sub ReviewWrites(ByRef changed As Long, ByVal localCopy As Long, ByRef inputOnly As Long, " +
            "ByVal pointerValue As Long Ptr, ByRef recordValue As ParameterRecord, " +
            "ByRef indirectOnly As Long, ByVal textValue As String)",
        "    changed += 1", "    localCopy = 2", "    Print inputOnly", "    *pointerValue = 3",
        "    recordValue.fieldValue = 4", "    AssignIndirect(indirectOnly)", "    Print textValue", "End Sub", ""].join("\n");
    fs.writeFileSync(filePath, text);
    for (const sidecar of [false, true]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            semanticModelOnly: sidecar, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false);
            for (const name of ["changed", "localCopy", "inputOnly", "pointerValue", "recordValue", "indirectOnly", "textValue", "externalValue"]) {
                const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position: pointAt(text, name) })).result;
                assert.equal(hover.compilerParameterFacts?.parameterDirectSourceWrite === true,
                    ["changed", "localCopy"].includes(name),
                    `${sidecar ? "stock" : "bridge"}: only direct parameter-value writes may be reported for ${name}`);
            }
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("stock semantic sidecar maps parameter modes, type origins, and physical ranges", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Sub SidecarDefaultParameter(defaultModeValue As Integer)",
        "End Sub",
        "Sub SidecarImplicitParameter(ByVal implicitValue)",
        "End Sub",
        "Sub SidecarImplicitByRefParameter(ByRef implicitReference)",
        "End Sub",
        "Sub SidecarImplicitArrayParameter(values())",
        "End Sub",
        "Sub SidecarSuffixParameter(ByVal suffixValue%)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const lineNumberFor = (marker) => text.split("\n").findIndex((line) => line.includes(marker));
        const hoverAt = async (marker, name) => {
            const line = lineNumberFor(marker);
            const sourceLine = text.split("\n")[line];
            const startColumn = sourceLine.indexOf(name);
            const result = (await worker.query(reply.snapshotId, "hover", {
                ...input,
                position: { line, character: startColumn + 2 }
            })).result;
            return { result, line, startColumn };
        };

        const defaultParameter = await hoverAt("SidecarDefaultParameter", "defaultModeValue");
        assert.equal(defaultParameter.result.compilerParameterFacts?.parameterPassing?.mode, "byref");
        assert.deepEqual(defaultParameter.result.compilerParameterFacts?.properties
            ?.filter((property) => property.name === "formal-written-mode")
            .map((property) => property.value), ["0"],
        "FBC should distinguish its deprecated-language default from a written mode");
        assert.deepEqual(defaultParameter.result.compilerParameterDeclarationRange, {
            line: defaultParameter.line,
            startColumn: defaultParameter.startColumn,
            endColumn: defaultParameter.startColumn + "defaultModeValue".length
        });
        const defaultParameterOutline = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: defaultParameter.line,
                startColumn: defaultParameter.startColumn,
                endColumn: defaultParameter.startColumn + "defaultModeValue".length
            }]
        })).result;
        assert.equal(defaultParameterOutline[0]?.compilerFacts?.parameterPassing?.mode, "byref");
        assert.deepEqual(defaultParameterOutline[0]?.compilerFacts?.properties
            ?.filter((property) => property.name === "formal-written-mode")
            .map((property) => property.value), ["0"]);

        const implicitParameter = await hoverAt("SidecarImplicitParameter", "implicitValue");
        assert.deepEqual(implicitParameter.result.compilerParameterFacts?.formalWrittenTypes, ["implicit"]);
        assert.equal(implicitParameter.result.compilerParameterFacts?.storageType?.primitive, "integer");
        const outlineParameterType = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: implicitParameter.line,
                startColumn: implicitParameter.startColumn,
                endColumn: implicitParameter.startColumn + "implicitValue".length
            }]
        })).result;
        assert.equal(outlineParameterType[0]?.compilerFacts?.storageType?.primitive, "integer");
        assert.deepEqual(outlineParameterType[0]?.compilerFacts?.formalWrittenTypes, ["implicit"]);

        const implicitByRefParameter = await hoverAt("SidecarImplicitByRefParameter", "implicitReference");
        assert.deepEqual(implicitByRefParameter.result.compilerParameterFacts?.formalWrittenTypes, ["implicit"]);
        assert.equal(implicitByRefParameter.result.compilerParameterFacts?.parameterPassing?.mode, "byref");
        assert.equal(implicitByRefParameter.result.compilerParameterFacts?.storageType?.primitive, "integer");

        const implicitArrayParameter = await hoverAt("SidecarImplicitArrayParameter", "values");
        assert.deepEqual(implicitArrayParameter.result.compilerParameterFacts?.formalWrittenTypes, ["implicit"]);
        assert.equal(implicitArrayParameter.result.compilerParameterFacts?.parameterPassing?.mode, "bydesc");
        assert.equal(implicitArrayParameter.result.compilerParameterFacts?.storageType?.primitive, "integer");

        const suffixParameter = await hoverAt("SidecarSuffixParameter", "suffixValue");
        assert.deepEqual(suffixParameter.result.compilerParameterFacts?.formalWrittenTypes, ["suffix"]);
        assert.equal(suffixParameter.result.compilerParameterFacts?.storageType?.primitive, "integer");
        assert.deepEqual(suffixParameter.result.compilerParameterDeclarationRange, {
            line: suffixParameter.line,
            startColumn: suffixParameter.startColumn,
            endColumn: suffixParameter.startColumn + "suffixValue%".length
        }, "the physical parameter binding should include the exact source suffix range");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar exposes array declaration facts and selected bound, index, and ByDesc storage", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Type SidecarArrayOwner",
        "    selected_values(0 To 3) As Long",
        "End Type",
        "Declare Sub ConsumeArray(values() As Long)",
        "Sub InspectArray(ByRef owner As SidecarArrayOwner, ByVal index As Long)",
        "    Dim value As Long",
        "    Dim local_values(0 To 3) As Long",
        "    value = UBound(local_values)",
        "    value = UBound(owner.selected_values)",
        "    value = owner.selected_values(index)",
        "    ConsumeArray(owner.selected_values())",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const declarationHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Dim local_values", "Dim ".length)
        })).result;
        assert.equal(declarationHover.compilerArrayFacts?.arrayBounds?.mode, "bounds",
            "stock-sidecar declaration hovers should map array bounds through the physical symbol binding");
        assert.equal(declarationHover.compilerArrayFacts?.storageType?.storageBytes, 4,
            "array declaration hover should retain the target width of one element");
        const arrayDeclarationPosition = pointAt(text, "local_values");
        const arrayDeclarationLine = text.split("\n")[arrayDeclarationPosition.line];
        const outlineArrayFacts = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: arrayDeclarationPosition.line,
                startColumn: arrayDeclarationPosition.character,
                endColumn: arrayDeclarationPosition.character + "local_values".length
            }]
        })).result;
        assert.equal(outlineArrayFacts[0]?.compilerFacts?.arrayBounds?.mode, "bounds",
            `exact array declaration sites should retain FBC bounds for parser Outline enrichment (${arrayDeclarationLine})`);

        const cases = [
            ["UBound(local_values)", 0, { kind: "variable", name: "local_values" }],
            ["UBound(owner.selected_values)", "UBound(".length + "owner.".length,
                { kind: "field", name: "selected_values" }],
            ["owner.selected_values(index)", "owner.".length, { kind: "field", name: "selected_values" }],
            ["ConsumeArray(owner.selected_values())", "ConsumeArray(".length + "owner.".length,
                { kind: "field", name: "selected_values" }]
        ];
        for (const [spelling, offset, expected] of cases) {
            const position = pointAt(text, spelling, offset);
            const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position })).result;
            assert.equal(hover.arrayStorageSelection?.kind, expected.kind,
                `FBC should identify the selected array kind: ${JSON.stringify(hover)}`);
            assert.equal(hover.arrayStorageSelection?.name, expected.name,
                `FBC array storage selection should reach the hover query: ${JSON.stringify(hover)}`);
            assert.equal(hover.arrayStorageSelection?.compilerFacts?.arrayBounds?.mode, "bounds",
                "FBC's exact array bounds should follow the selected storage symbol");
            assert.equal(hover.arrayStorageSelection?.compilerFacts?.storageType?.storageBytes, 4,
                "the selected array's element width should come from the target layout");
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar exposes compiler field layout and visibility on declarations", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Type SidecarFieldLayout",
        "    Private:",
        "    privateField As Long",
        "    Public:",
        "    publicField As Byte",
        "End Type",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        for (const [spelling, visibility] of [
            ["privateField As Long", "private"],
            ["publicField As Byte", "public"]
        ]) {
            const hover = (await worker.query(reply.snapshotId, "hover", {
                ...input,
                position: pointAt(text, spelling)
            })).result;
            assert.ok(Number.isSafeInteger(hover.compilerFieldFacts?.fieldLayout?.byteOffset) &&
                hover.compilerFieldFacts.fieldLayout.byteOffset >= 0,
            `FBC should return the exact field offset: ${JSON.stringify(hover)}`);
            assert.equal(hover.compilerFieldFacts.compilerVisibility, visibility,
                "compiler-selected field visibility should follow the physical declaration binding");
            const fieldName = spelling.split(" ")[0];
            const fieldPosition = pointAt(text, fieldName);
            const outlineFacts = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
                ...input,
                sites: [{
                    index: 0,
                    line: fieldPosition.line,
                    startColumn: fieldPosition.character,
                    endColumn: fieldPosition.character + fieldName.length
                }]
            })).result;
            assert.ok(Number.isSafeInteger(outlineFacts[0]?.compilerFacts?.fieldLayout?.byteOffset),
                "the exact field query should return compiler layout facts for Outline");
            assert.equal(outlineFacts[0]?.compilerFacts?.compilerVisibility, visibility);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar exposes target aggregate size and alignment on type declarations", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Type SidecarAggregateLayout",
        "    firstByte As Byte",
        "    Protected:",
        "    secondValue As Long",
        "    Private:",
        "    hiddenValue As Integer",
        "End Type",
        "Dim layoutValue As SidecarAggregateLayout",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Type SidecarAggregateLayout", "Type ".length)
        })).result;
        assert.ok(Number.isSafeInteger(hover.compilerAggregateFacts?.aggregateSizeBytes) &&
            hover.compilerAggregateFacts.aggregateSizeBytes > 0,
        `FBC should map the target aggregate size to its type declaration: ${JSON.stringify(hover)}`);
        assert.ok(hover.compilerAggregateFacts?.properties?.some((property) =>
            property.name === "natural-alignment" && Number(property.value) > 0),
        "FBC's target-selected natural alignment should reach the type declaration hover");
        assert.deepEqual(hover.compilerAggregateFacts?.aggregateAccess?.sections?.map((section) => section.visibility),
            ["protected", "private"],
        "FBC's compiler-selected aggregate access sections should reach the type declaration hover");
        const aggregatePosition = pointAt(text, "SidecarAggregateLayout");
        const aggregateName = "SidecarAggregateLayout";
        const outlineFacts = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: aggregatePosition.line,
                startColumn: aggregatePosition.character,
                endColumn: aggregatePosition.character + aggregateName.length
            }]
        })).result;
        assert.ok(Number.isSafeInteger(outlineFacts[0]?.compilerFacts?.aggregateSizeBytes) &&
            outlineFacts[0].compilerFacts.aggregateSizeBytes > 0,
        "the exact aggregate query should return compiler layout facts for Outline");
        assert.ok(outlineFacts[0]?.compilerFacts?.properties?.some((property) =>
            property.name === "natural-alignment"));
        assert.deepEqual(hover.compilerAggregateFacts?.aggregateAccess?.sections?.map((section) => section.visibility),
            ["protected", "private"],
        "FBC's compiler-selected aggregate access sections should reach the type declaration hover");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar exposes compiler-selected procedure ABI on declarations", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Extern \"C\"",
        "    Declare Function SidecarCProbe Cdecl(ByVal value As Long) As Long",
        "    Declare Function SidecarCDefault(ByVal value As Integer) As Integer",
        "End Extern",
        "Declare Function SidecarReferenceProbe() ByRef As Integer",
        "Sub SidecarDefaultVisibilityProbe()",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const cHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "SidecarCProbe")
        })).result;
        assert.equal(cHover.compilerProcedureFacts?.procedureCallingConvention, "cdecl");
        assert.ok(cHover.compilerProcedureFacts?.properties?.some((property) =>
            property.name === "procedure-linkage" && property.value === "c"));
        assert.deepEqual(cHover.compilerProcedureFacts?.procedureAbiPolicyInputs?.map((policy) =>
            [policy.writtenConvention, policy.managedString]), [[true, false]]);
        const cPosition = pointAt(text, "SidecarCProbe");
        const cOutline = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: cPosition.line,
                startColumn: cPosition.character,
                endColumn: cPosition.character + "SidecarCProbe".length
            }]
        })).result;
        assert.equal(cOutline[0]?.compilerFacts?.procedureCallingConvention, "cdecl");
        assert.ok(cOutline[0]?.compilerFacts?.properties?.some((property) =>
            property.name === "procedure-linkage" && property.value === "c"));

        const cDefaultHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "SidecarCDefault")
        })).result;
        assert.equal(cDefaultHover.compilerProcedureFacts?.procedureCallingConvention, "cdecl");
        assert.deepEqual(cDefaultHover.compilerProcedureFacts?.procedureAbiPolicyInputs?.map((policy) =>
            [policy.writtenConvention, policy.managedString]), [[false, false]],
        "the stock sidecar should distinguish compiler-default Cdecl from a written convention");
        const policyStatement = cDefaultHover.compilerProcedureFacts?.procedureAbiPolicyInputs?.[0]?.statement;
        assert.ok(Number.isSafeInteger(policyStatement) && policyStatement > 0,
            "a uniquely selected header must retain the native ABI policy statement for refactors");
        assert.equal(policyStatement, cDefaultHover.compilerProcedureVisibilityFacts?.procedureTypingInputs?.[0]?.statement);

        const refHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "SidecarReferenceProbe")
        })).result;
        assert.equal(refHover.compilerProcedureFacts?.procedureReturnsByReference, true,
            "stock-sidecar procedure declaration hover should preserve the compiler-selected ByRef return");

        const visibilityHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "SidecarDefaultVisibilityProbe")
        })).result;
        const visibilityNameStart = text.split("\n")[5].indexOf("SidecarDefaultVisibilityProbe");
        assert.deepEqual(visibilityHover.compilerProcedureDeclarationRange, {
            line: 5,
            startColumn: visibilityNameStart,
            endColumn: visibilityNameStart + "SidecarDefaultVisibilityProbe".length
        }, "stock-sidecar procedure declaration ranges should isolate the physical name for bounded refactors");
        assert.ok(["public", "private"].includes(visibilityHover.compilerProcedureVisibilityFacts?.compilerVisibility));
        assert.deepEqual(visibilityHover.compilerProcedureVisibilityFacts?.procedureWrittenVisibility
            ?.map((input) => input.visibility), ["default"],
        "stock-sidecar procedure hover should identify visibility selected by scope rather than source text");
        assert.deepEqual(visibilityHover.compilerProcedureVisibilityFacts?.procedureTypingInputs
            ?.map((input) => input.role), ["definition"]);
        const visibilityPosition = pointAt(text, "SidecarDefaultVisibilityProbe");
        const visibilityOutline = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: visibilityPosition.line,
                startColumn: visibilityPosition.character,
                endColumn: visibilityPosition.character + "SidecarDefaultVisibilityProbe".length
            }]
        })).result;
        assert.equal(visibilityOutline[0]?.compilerFacts?.compilerVisibility,
            visibilityHover.compilerProcedureVisibilityFacts.compilerVisibility);
        assert.deepEqual(visibilityOutline[0]?.compilerFacts?.procedureWrittenVisibility
            ?.map((input) => input.visibility), ["default"]);

        const explicitText = text.replace("SidecarCDefault(", "SidecarCDefault Cdecl(");
        fs.writeFileSync(filePath, explicitText);
        const explicitReply = await worker.analyze({ ...options, semanticModelOnly: true,
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        assert.equal(explicitReply.partial, false, "the offered explicit convention must compile");
        try {
            const explicitHover = (await worker.query(explicitReply.snapshotId, "hover", {
                ...input, position: pointAt(explicitText, "SidecarCDefault")
            })).result;
            assert.equal(explicitHover.compilerProcedureFacts?.procedureCallingConvention,
                cDefaultHover.compilerProcedureFacts.procedureCallingConvention);
            assert.equal(explicitHover.compilerProcedureFacts?.procedureReturnsByReference,
                cDefaultHover.compilerProcedureFacts.procedureReturnsByReference);
            assert.deepEqual(explicitHover.compilerStorageTypeFacts?.storageType, cDefaultHover.compilerStorageTypeFacts?.storageType);
            assert.deepEqual(explicitHover.compilerProcedureFacts?.procedureAbiPolicyInputs?.map((policy) => policy.writtenConvention), [true],
                "only the written-convention receipt should change after making Cdecl explicit");
        } finally { worker.releaseModel(explicitReply.snapshotId); }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native implementation follows override descendants without changing static navigation", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const lines = ["Type BasePicker Extends Object",
        "    Declare Virtual Function Pick Overload(ByVal value As Long) As Long",
        "    Declare Virtual Function Pick Overload(ByVal value As Double) As Long", "End Type",
        "Type ChildPicker Extends BasePicker", "    Declare Virtual Function Pick(ByVal value As Long) As Long Override", "End Type",
        "Type LeafPicker Extends ChildPicker", "    Declare Function Pick(ByVal value As Long) As Long Override", "End Type",
        "Type UnrelatedPicker Extends Object", "    Declare Virtual Function Pick(ByVal value As Long) As Long", "End Type",
        "Type AbstractPicker Extends Object", "    Declare Abstract Function Run() As Long", "End Type",
        "Type ConcretePicker Extends AbstractPicker", "    Declare Function Run() As Long Override", "End Type"];
    const aliasLine = lines.length;
    lines.push("Type PickerAlias As BasePicker");
    const holderLine = lines.length;
    lines.push("Type PickerHolder", "    target As PickerAlias Ptr", "End Type",
        "Sub InspectPicker(ByVal parameter As BasePicker Ptr)", "    Print parameter", "End Sub");
    const externLine = lines.length;
    lines.push("Extern externalPicker As BasePicker Ptr");
    const bodies = new Map();
    for (const signature of ["BasePicker.Pick(ByVal value As Long)", "BasePicker.Pick(ByVal value As Double)",
        "ChildPicker.Pick(ByVal value As Long)", "LeafPicker.Pick(ByVal value As Long)",
        "UnrelatedPicker.Pick(ByVal value As Long)", "ConcretePicker.Run()"]) {
        bodies.set(signature, lines.length);
        lines.push(`Function ${signature} As Long`, "    Return 1", "End Function");
    }
    lines.push("Dim selected As BasePicker Ptr", "Print selected->Pick(CLng(1))", "");
    const text = lines.join("\n");
    fs.writeFileSync(filePath, text);
    for (const stock of [false, true]) {
        const reply = await worker.analyze({ ...options, compilerPath: stock ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            semanticModelOnly: stock, exportSemanticBindings: stock }, preparation);
        assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
        try {
            const query = async (operation, position) => (await worker.query(reply.snapshotId, operation, { ...input, position })).result;
            const point = { line: 1, character: lines[1].indexOf("Pick") + 1 };
            const locations = (entries) => entries.map((entry) => entry.declaration.line).sort((a, b) => a - b);
            const expected = [bodies.get("BasePicker.Pick(ByVal value As Long)"), bodies.get("ChildPicker.Pick(ByVal value As Long)"),
                bodies.get("LeafPicker.Pick(ByVal value As Long)")];
            assert.deepEqual(locations(await query("implementation", point)), expected,
                `stock=${stock}: include only the selected overload's native descendants`);
            assert.deepEqual(locations(await query("implementation", { line: 5, character: lines[5].indexOf("Pick") + 1 })), expected.slice(1),
                "a derived origin must not return its base or sibling implementations");
            assert.deepEqual(locations(await query("implementation", { line: 2, character: lines[2].indexOf("Pick") + 1 })),
                [bodies.get("BasePicker.Pick(ByVal value As Double)")]);
            assert.deepEqual(locations(await query("implementation", { line: 14, character: lines[14].indexOf("Run") + 1 })),
                [bodies.get("ConcretePicker.Run()")], "abstract prototypes are not implementations");
            const definition = await query("definition", point);
            assert.deepEqual(locations(definition), [expected[0]], "Definition must retain the static target");
            if (!stock) assert.equal(definition[0]?.compilerVirtualMethod, true, "bridge providers need a conceptual virtual-method hint");
            assert.deepEqual(locations(await query("declaration", point)), [1]);
            assert.deepEqual(locations(await query("baseDefinition", { line: 5, character: lines[5].indexOf("Pick") + 1 })),
                [expected[0]], "a child jumps to the selected overload's base body");
            assert.deepEqual(locations(await query("baseDefinition", { line: 8, character: lines[8].indexOf("Pick") + 1 })),
                [expected[1]], "a leaf jumps to its immediate parent, not the root");
            assert.deepEqual(locations(await query("baseDefinition", { line: 17, character: lines[17].indexOf("Run") + 1 })),
                [14], "an abstract base without a body remains a valid prototype target");
            assert.deepEqual(await query("baseDefinition", point), [], "a root has no base method");
            assert.deepEqual(await query("baseDefinition", { line: 11, character: lines[11].indexOf("Pick") + 1 }), [],
                "an unrelated same-name method is not a base");
            assert.deepEqual(locations(await query("typeImplementations", { line: 0, character: 6 })), [4, 7],
                `stock=${stock}: type implementations include descendants but not the base or unrelated types`);
            assert.deepEqual(locations(await query("typeImplementations", { line: 4, character: 6 })), [7],
                "a derived origin excludes its ancestors");
            assert.deepEqual(await query("typeImplementations", { line: 7, character: 6 }), [], "a leaf has no implementations");
            assert.deepEqual(locations(await query("typeImplementations", { line: aliasLine, character: 6 })), [4, 7],
                "a type alias uses the actual native inheritance root");
            for (const [line, name] of [[holderLine + 1, "target"], [holderLine + 4, "parameter"],
                [externLine, "externalPicker"], [lines.findIndex((line) => line.startsWith("Dim selected")), "selected"]]) {
                assert.deepEqual(locations(await query("typeImplementations", { line, character: lines[line].indexOf(name) + 1 })), [4, 7],
                    `stock=${stock}: ${name} follows its native aggregate type, including pointer/alias storage`);
            }
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("stock semantic sidecar maps overrides and type navigation across included headers", native, async (t) => {
    const { worker, directory, filePath, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "type-hierarchy.bi");
    const headerText = [
        "Type BaseSelector Extends Object",
        "    Declare Virtual Function Choose(ByVal value As Long) As Long",
        "End Type",
        ""
    ].join("\n");
    const text = [
        '#include "type-hierarchy.bi"',
        "Type DerivedSelector Extends BaseSelector",
        "    '' @deprecated Use another selector.",
        "    Declare Function Choose(ByVal value As Long) As Long",
        "End Type",
        "Dim derivedValue As DerivedSelector",
        "Function DerivedSelector.Choose(ByVal value As Long) As Long",
        "    Return value",
        "End Function",
        ""
    ].join("\n");
    fs.writeFileSync(headerPath, headerText);
    fs.writeFileSync(filePath, text);
    const headerInput = { uri: { scheme: "file", fsPath: headerPath }, openFiles: [] };
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Declare Function Choose(ByVal value", "Declare Function ".length)
        })).result;
        assert.ok(Number.isSafeInteger(hover.compilerProcedureFacts?.overriddenProcedure?.compilerSymbolId) &&
            hover.compilerProcedureFacts.overriddenProcedure.compilerSymbolId > 0,
        "FBC's semantic override edge should identify the selected base procedure in the stock sidecar");
        const overrideLine = text.split("\n").findIndex((line) => /Declare Function Choose/.test(line));
        const overridePosition = { line: overrideLine, character: text.split("\n")[overrideLine].indexOf("Choose") };
        const baseMethod = (await worker.query(reply.snapshotId, "baseDefinition", {
            ...input, position: overridePosition
        })).result;
        assert.deepEqual(baseMethod.map((entry) => [entry.uri.fsPath, entry.declaration.line]), [[headerPath, 1]],
            "an implicit override follows the native edge to its included base prototype");
        const outlineFacts = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: overridePosition.line,
                startColumn: overridePosition.character,
                endColumn: overridePosition.character + "Choose".length
            }]
        })).result;
        assert.ok(Number.isSafeInteger(outlineFacts[0]?.compilerFacts?.overriddenProcedure?.compilerSymbolId) &&
            outlineFacts[0].compilerFacts.overriddenProcedure.compilerSymbolId > 0,
        "the exact Outline query should preserve FBC's selected base symbol identity");
        assert.equal(hover.compilerProcedureFacts?.properties
            ?.find((property) => property.name === "written-override")?.value, "0");
        assert.deepEqual(hover.compilerProcedureDeclarationRange, {
            line: overrideLine,
            startColumn: text.split("\n")[overrideLine].indexOf("Choose"),
            endColumn: text.split("\n")[overrideLine].indexOf("Choose") + "Choose".length
        });
        const derivedLine = text.split("\n").findIndex((line) => /Type DerivedSelector/.test(line));
        const derivedNameColumn = text.split("\n")[derivedLine].indexOf("DerivedSelector");
        const derivedHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: { line: derivedLine, character: derivedNameColumn + 1 }
        })).result;
        assert.equal(derivedHover.compilerAggregateFacts?.baseType, "BaseSelector",
            "the stock sidecar should retain FBC's selected base type identity for declaration hover");
        const derivedOutline = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: derivedLine,
                startColumn: derivedNameColumn,
                endColumn: derivedNameColumn + "DerivedSelector".length
            }]
        })).result;
        assert.equal(derivedOutline[0]?.compilerFacts?.baseType, "BaseSelector",
            "the cached stock Outline facts should carry the compiler-confirmed base spelling");
        const includedBaseLine = headerText.split("\n").findIndex((line) => /Type BaseSelector/.test(line));
        const includedBaseNameColumn = headerText.split("\n")[includedBaseLine].indexOf("BaseSelector");
        const includedBaseOutline = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                filePath: headerPath,
                line: includedBaseLine,
                startColumn: includedBaseNameColumn,
                endColumn: includedBaseNameColumn + "BaseSelector".length
            }]
        })).result;
        assert.equal(includedBaseOutline[0]?.compilerFacts?.baseType, "Object",
            "Outline facts should resolve explicitly identified source sites in included files");
        const derivedHierarchy = (await worker.query(reply.snapshotId, "typeHierarchyPrepare", {
            ...input,
            position: { line: derivedLine, character: derivedNameColumn + 1 }
        })).result;
        assert.equal(derivedHierarchy.length, 1);
        assert.equal(derivedHierarchy[0].name, "DerivedSelector");
        const derivedItem = derivedHierarchy[0];
        const variableLine = text.split("\n").findIndex((line) => /Dim derivedValue/.test(line));
        const variableNameColumn = text.split("\n")[variableLine].indexOf("derivedValue");
        const variableHierarchy = (await worker.query(reply.snapshotId, "typeHierarchyPrepare", {
            ...input,
            position: { line: variableLine, character: variableNameColumn + 1 }
        })).result;
        assert.equal(variableHierarchy.length, 1,
            "a variable with a compiler-selected UDT subtype should prepare the type hierarchy");
        assert.equal(variableHierarchy[0].name, "DerivedSelector");
        assert.equal(variableHierarchy[0].declaration.line, derivedLine);
        const typeDefinitions = (await worker.query(reply.snapshotId, "compilerSidecarTypeDefinition", {
            ...input,
            position: { line: variableLine, character: variableNameColumn + 1 }
        })).result;
        assert.deepEqual(typeDefinitions.map((entry) => [entry.uri.fsPath,
            entry.declaration.line, entry.name]), [[filePath, derivedLine, "DerivedSelector"]],
        "type definition should follow the same compiler-selected subtype identity");
        const hierarchyParents = (await worker.query(reply.snapshotId, "typeHierarchySupertypes", {
            ...input,
            position: { line: derivedItem.declaration.line, character: derivedItem.declaration.startColumn }
        })).result;
        const baseHierarchyItem = hierarchyParents.find((entry) => entry.name === "BaseSelector");
        assert.ok(baseHierarchyItem,
            "stock-sidecar Type Hierarchy should follow FBC's selected base identity");
        const baseLine = headerText.split("\n").findIndex((line) => /Type BaseSelector/.test(line));
        const baseNameColumn = headerText.split("\n")[baseLine].indexOf("BaseSelector");
        assert.deepEqual([baseHierarchyItem.uri.fsPath, baseHierarchyItem.declaration.line,
            baseHierarchyItem.declaration.startColumn, baseHierarchyItem.declaration.endColumn], [
            headerPath, baseLine, baseNameColumn, baseNameColumn + "BaseSelector".length
        ]);
        const baseHierarchy = (await worker.query(reply.snapshotId, "typeHierarchyPrepare", {
            ...headerInput,
            position: { line: baseLine, character: baseNameColumn + 1 }
        })).result;
        const hierarchyChildren = (await worker.query(reply.snapshotId, "typeHierarchySubtypes", {
            ...headerInput,
            position: { line: baseHierarchy[0].declaration.line, character: baseHierarchy[0].declaration.startColumn }
        })).result;
        const derivedChild = hierarchyChildren.find((entry) => entry.name === "DerivedSelector");
        assert.ok(derivedChild,
            "stock-sidecar Type Hierarchy should find direct derived types by compiler base identity");
        assert.equal(derivedChild.uri.fsPath, filePath);
        assert.equal(derivedChild.declaration.line, derivedLine);
        assert.equal(baseHierarchy[0].uri.fsPath, headerPath,
            "the base type hierarchy item should preserve its physical included-header location");
        const tokens = decodeSemanticTokenRecords((await worker.query(reply.snapshotId, "semanticTokens", input)).result);
        const bodyLine = text.split("\n").findIndex((line) => line.startsWith("Function DerivedSelector.Choose"));
        for (const [line, column, modifier] of [[overrideLine, overridePosition.character, "declaration"],
            [bodyLine, text.split("\n")[bodyLine].indexOf("Choose"), "definition"]]) {
            const token = tokens.find((entry) => entry.line === line && entry.character === column);
            assert.ok(token, `missing stock method token at ${line}:${column}`);
            assert.equal(token.type, TOKEN_TYPES.indexOf("method"));
            assert.ok(token.modifiers & (1 << TOKEN_MODIFIERS.indexOf(modifier)));
            assert.ok(token.modifiers & (1 << TOKEN_MODIFIERS.indexOf("deprecated")),
                "a documented prototype deprecates the same compiler identity's body too");
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar maps implicit and suffix function return types", native, async (t) => {
    const { worker, directory, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Function SidecarImplicitReturnProbe()",
        "    Return 1",
        "End Function",
        "Function SidecarContinuedImplicitReturnProbe( _",
        "    ByVal firstValue As Long, _",
        "    ByVal secondValue As Long)",
        "    Return firstValue + secondValue",
        "End Function",
        "Function SidecarContinuedSuffixReturnProbe%( _",
        "    ByVal firstSuffixValue As Long, _",
        "    ByVal secondSuffixValue As Long)",
        "    Return firstSuffixValue + secondSuffixValue",
        "End Function",
        "Sub SidecarImplicitParameterProbe(ByVal parameterValue)",
        "    Print parameterValue",
        "End Sub",
        "Function SidecarSuffixReturnProbe%()",
        "    Return 1",
        "End Function",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const syntaxCheck = spawnSync(options.compilerPath,
        ["-lang", "deprecated", "-c", filePath, "-o", path.join(directory, "implicit-returns.o")],
        { encoding: "utf8" });
    assert.equal(syntaxCheck.status, 0, `${syntaxCheck.stdout}\n${syntaxCheck.stderr}`);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        for (const [name, resultForm] of [
            ["SidecarImplicitReturnProbe", "implicit"],
            ["SidecarContinuedImplicitReturnProbe", "implicit"],
            ["SidecarContinuedSuffixReturnProbe%", "suffix"],
            ["SidecarSuffixReturnProbe%", "suffix"]
        ]) {
            const position = pointAt(text, name);
            const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position })).result;
            assert.deepEqual(hover.compilerProcedureVisibilityFacts?.procedureTypingInputs
                ?.map((typing) => typing.resultForm), [resultForm]);
            assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
            assert.deepEqual(hover.compilerProcedureDeclarationRange, {
                line: position.line,
                startColumn: position.character,
                endColumn: position.character + name.length
            }, "FBC should bind the selected return type to the complete physical procedure name");
        }
        const returnLine = text.split("\n").findIndex((line) => line.startsWith("Function SidecarImplicitReturnProbe"));
        const returnColumn = text.split("\n")[returnLine].indexOf("SidecarImplicitReturnProbe");
        const parameterLine = text.split("\n").findIndex((line) => line.startsWith("Sub SidecarImplicitParameterProbe"));
        const parameterColumn = text.split("\n")[parameterLine].indexOf("parameterValue");
        const outlineFacts = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [
                {
                    index: 0,
                    line: returnLine,
                    startColumn: returnColumn,
                    endColumn: returnColumn + "SidecarImplicitReturnProbe".length
                },
                {
                    index: 1,
                    line: parameterLine,
                    startColumn: parameterColumn,
                    endColumn: parameterColumn + "parameterValue".length
                }
            ]
        })).result;
        assert.equal(outlineFacts.find((fact) => fact.index === 0)?.compilerFacts?.storageType?.primitive, "integer",
            "the procedure Outline query should retain FBC's implicit return storage type");
        assert.equal(outlineFacts.find((fact) => fact.index === 0)?.compilerFacts?.procedureTypingInputs?.[0]?.resultForm,
            "implicit");
        assert.equal(outlineFacts.find((fact) => fact.index === 1)?.compilerFacts?.storageType?.primitive, "integer",
            "the parameter Outline query should retain FBC's selected type");
        assert.deepEqual(outlineFacts.find((fact) => fact.index === 1)?.compilerFacts?.formalWrittenTypes, ["implicit"]);
        const inlays = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 0, character: 0 },
            end: { line: text.split("\n").length - 1, character: 0 },
            parameterHints: false
        })).result;
        const suffixReturnLine = text.split("\n").findIndex((line) => line.startsWith("Function SidecarSuffixReturnProbe%"));
        assert.equal(inlays.implicitDeclarations.some((hint) => hint.position.line === suffixReturnLine), false,
            "written suffix types must not receive redundant inlays");
        assert.ok(inlays.implicitDeclarations.some((hint) =>
            hint.position.line === returnLine && hint.storageType.primitive === "integer"),
        "stock-sidecar Inlay Hints should include the compiler-selected implicit function result type");
        assert.ok(inlays.implicitDeclarations.some((hint) =>
            hint.position.line === parameterLine && hint.position.character === parameterColumn + "parameterValue".length &&
            hint.storageType.primitive === "integer"),
        "stock-sidecar Inlay Hints should include the compiler-selected implicit parameter type");

        const refactoredText = text.replace(
            "    ByVal secondValue As Long)",
            "    ByVal secondValue As Long) As Integer"
        ).replace(
            "Function SidecarContinuedSuffixReturnProbe%(",
            "Function SidecarContinuedSuffixReturnProbe("
        ).replace(
            "    ByVal secondSuffixValue As Long)",
            "    ByVal secondSuffixValue As Long) As Integer"
        );
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "placing As Integer after the closing parenthesis should compile for a continued header");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar confirms and compiles Override on a continued method", native, async (t) => {
    const { worker, directory, filePath, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "continued-override.bi");
    const headerText = [
        "Type ContinuedBase Extends Object",
        "    Declare Virtual Function Choose(ByVal value As Long) As Long",
        "End Type",
        ""
    ].join("\n");
    const text = [
        '#include "continued-override.bi"',
        "Type ContinuedDerived Extends ContinuedBase",
        "    Declare Function Choose( _",
        "        ByVal value As Long) As Long",
        "End Type",
        ""
    ].join("\n");
    fs.writeFileSync(headerPath, headerText);
    fs.writeFileSync(filePath, text);
    const syntaxCheck = spawnSync(options.compilerPath,
        ["-lang", "fb", "-c", filePath, "-o", path.join(directory, "continued-override.o")],
        { encoding: "utf8" });
    assert.equal(syntaxCheck.status, 0, `${syntaxCheck.stdout}\n${syntaxCheck.stderr}`);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "fb"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const position = pointAt(text, "Choose( _");
        const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position })).result;
        assert.ok(Number.isSafeInteger(hover.compilerProcedureFacts?.overriddenProcedure?.compilerSymbolId) &&
            hover.compilerProcedureFacts.overriddenProcedure.compilerSymbolId > 0,
        "FBC should identify the exact overridden base method for the continued declaration");
        assert.equal(hover.compilerProcedureFacts?.properties?.find((property) =>
            property.name === "written-override")?.value, "0");

        const refactoredText = text.replace(
            "    Declare Function Choose( _\n        ByVal value As Long) As Long",
            "    Declare Function Choose( _\n        ByVal value As Long) As Long Override"
        );
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "fb"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "adding Override at the end of the continued declaration should compile");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar binds implicit parameters in continued procedure headers", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        '#lang "deprecated"',
        "Sub ContinuedParameterProbe( _",
        "    ByVal firstParameter, _",
        "    secondParameter _",
        ")",
        "    Print firstParameter, secondParameter",
        "End Sub",
        "Sub ContinuedArrayParameterProbe( _",
        "    arrayValues( _",
        "    ) _",
        ")",
        "    Print arrayValues(0)",
        "End Sub",
        "Sub ContinuedSuffixArrayParameterProbe( _",
        "    suffixValues%( _",
        "    ) _",
        ")",
        "    Print suffixValues(0)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const line = 3;
        const name = "secondParameter";
        const startColumn = text.split("\n")[line].indexOf(name);
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: { line, character: startColumn + 1 }
        })).result;
        assert.equal(hover.compilerParameterFacts?.storageType?.primitive, "integer");
        assert.deepEqual(hover.compilerParameterFacts?.formalWrittenTypes, ["implicit"]);
        assert.deepEqual(hover.compilerParameterDeclarationRange, {
            line,
            startColumn,
            endColumn: startColumn + name.length
        });

        const arrayPosition = pointAt(text, "arrayValues( _");
        const arrayHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: arrayPosition
        })).result;
        assert.equal(arrayHover.compilerParameterFacts?.storageType?.primitive, "integer");
        assert.deepEqual(arrayHover.compilerParameterFacts?.formalWrittenTypes, ["implicit"]);
        assert.deepEqual(arrayHover.compilerParameterDeclarationRange, {
            line: arrayPosition.line,
            startColumn: arrayPosition.character,
            endColumn: arrayPosition.character + "arrayValues".length
        });

        const suffixArrayPosition = pointAt(text, "suffixValues%( _");
        const suffixArrayHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: suffixArrayPosition
        })).result;
        assert.equal(suffixArrayHover.compilerParameterFacts?.storageType?.primitive, "integer");
        assert.deepEqual(suffixArrayHover.compilerParameterFacts?.formalWrittenTypes, ["suffix"]);
        assert.deepEqual(suffixArrayHover.compilerParameterDeclarationRange, {
            line: suffixArrayPosition.line,
            startColumn: suffixArrayPosition.character,
            endColumn: suffixArrayPosition.character + "suffixValues%".length
        });

        const refactoredText = text.replace(
            "    secondParameter _",
            "    secondParameter As Integer _"
        ).replace(
            "    arrayValues( _\n    ) _",
            "    arrayValues( _\n    ) As Integer _"
        ).replace(
            "    suffixValues%( _\n    ) _",
            "    suffixValues( _\n    ) As Integer _"
        );
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "adding As Integer to continued scalar and array parameters should compile");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar confirms the default ABI for a continued C declaration", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        'Extern "C"',
        "Declare Function ContinuedCDefault( _",
        "    ByVal firstValue As Long, _",
        "    ByVal secondValue As Long) As Long",
        "End Extern",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const position = pointAt(text, "ContinuedCDefault");
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position
        })).result;
        assert.equal(hover.compilerProcedureFacts?.procedureCallingConvention, "cdecl");
        assert.ok(hover.compilerProcedureFacts?.properties?.some((property) =>
            property.name === "procedure-linkage" && property.value === "c"));
        assert.deepEqual(hover.compilerProcedureFacts?.procedureAbiPolicyInputs?.map((policy) => [
            policy.writtenConvention, policy.managedString, policy.provisional
        ]), [[false, false, false]]);
        assert.deepEqual(hover.compilerProcedureDeclarationRange, {
            line: position.line,
            startColumn: position.character,
            endColumn: position.character + "ContinuedCDefault".length
        });

        const refactoredText = text.replace(
            "Declare Function ContinuedCDefault( _",
            "Declare Function ContinuedCDefault Cdecl( _"
        );
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "adding Cdecl after the continued declaration name should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar exposes implicit assignment, LET, INPUT, and READ target types", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Data 42, 24",
        "Sub StorageProbe()",
        "    Dim explicitInput As Long",
        "    implicitLocal = 1",
        "    Let _",
        "        implicitLetLocal _",
        "            = 2",
        "    Input explicitInput",
        '    Input "Enter a value: "; implicitInput, implicitInputTwo',
        "    Read implicitRead, implicitReadTwo",
        "    Print implicitLocal, implicitLetLocal, implicitInput, implicitInputTwo, implicitRead, implicitReadTwo",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitLocal")
        })).result;
        assert.equal(hover.compilerStorageClass, "local",
            "FBC should report the procedure-local class for its compiler-created implicit variable");
        assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "integer",
            "the selected implicit local should carry its compiler-resolved type as well as its scope");
        const letHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitLetLocal")
        })).result;
        assert.equal(letHover.compilerStorageClass, "local");
        assert.equal(letHover.compilerStorageTypeFacts?.storageType?.primitive, "integer",
            "FBC should report compiler-selected type facts for an implicit LET target");
        const assignmentLine = text.split("\n").findIndex((sourceLine) => sourceLine.includes("implicitLocal ="));
        const assignmentSource = text.split("\n")[assignmentLine];
        const letLine = text.split("\n").findIndex((sourceLine) => sourceLine.includes("implicitLetLocal"));
        const letSource = text.split("\n")[letLine];
        const implicitHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 0, character: 0 },
            end: { line: text.split("\n").length - 1, character: 0 },
            parameterHints: false
        })).result;
        const inputLine = text.split("\n").findIndex((line) => /\bInput\b/i.test(line) && /implicitInput/.test(line));
        const inputSource = text.split("\n")[inputLine];
        const secondInputColumn = inputSource.indexOf("implicitInputTwo");
        const readLine = text.split("\n").findIndex((line) => line.includes("Read implicitRead"));
        const readSource = text.split("\n")[readLine];
        const secondReadColumn = readSource.indexOf("implicitReadTwo");
        assert.deepEqual(implicitHints.implicitVariables?.map((hint) => [
            hint.position.line, hint.position.character, hint.storageType.primitive
        ]), [
            [assignmentLine, assignmentSource.indexOf("implicitLocal") + "implicitLocal".length, "integer"],
            [letLine, letSource.indexOf("implicitLetLocal") + "implicitLetLocal".length, "integer"],
            [inputLine, inputSource.indexOf("implicitInput") + "implicitInput".length, "integer"],
            [inputLine, secondInputColumn + "implicitInputTwo".length, "integer"],
            [readLine, readSource.indexOf("implicitRead") + "implicitRead".length, "integer"],
            [readLine, secondReadColumn + "implicitReadTwo".length, "integer"]
        ], "the stock sidecar should map compiler-selected types to physical assignment, INPUT, and READ targets");
        for (const name of ["implicitInput", "implicitRead"]) {
            const targetPosition = pointAt(text, name);
            const targetHover = (await worker.query(reply.snapshotId, "hover", {
                ...input,
                position: targetPosition
            })).result;
            assert.equal(targetHover.compilerStorageClass, "local",
                `FBC should identify ${name} as a compiler-created local`);
            assert.equal(targetHover.compilerStorageTypeFacts?.storageType?.primitive, "integer",
                `FBC should provide ${name}'s selected type for hover`);
            const targetDefinitions = (await worker.query(reply.snapshotId, "definition", {
                ...input,
                position: targetPosition
            })).result;
            assert.equal(targetDefinitions.length, 1,
                `Go to Definition should recognize the compiler-created ${name}`);
            assert.equal(targetDefinitions[0].name, name);
            const targetReferences = (await worker.query(reply.snapshotId, "references", {
                ...input,
                position: targetPosition,
                includeDeclaration: true
            })).result;
            assert.ok(targetReferences.length >= 2,
                `Find References should include the ${name} target and its later use`);
        }
        const outlineVariables = (await worker.query(reply.snapshotId, "compilerSidecarOutlineImplicitVariables", input)).result;
        assert.deepEqual(outlineVariables.map((variable) => [
            variable.name, variable.line, variable.startColumn, variable.endColumn,
            variable.storageClass, variable.storageType.primitive
        ]), [[
            "implicitLocal", assignmentLine, assignmentSource.indexOf("implicitLocal"),
            assignmentSource.indexOf("implicitLocal") + "implicitLocal".length, "local", "integer"
        ], [
            "implicitLetLocal", letLine, letSource.indexOf("implicitLetLocal"),
            letSource.indexOf("implicitLetLocal") + "implicitLetLocal".length, "local", "integer"
        ], [
            "implicitInput", inputLine, inputSource.indexOf("implicitInput"),
            inputSource.indexOf("implicitInput") + "implicitInput".length, "local", "integer"
        ], [
            "implicitInputTwo", inputLine, secondInputColumn,
            secondInputColumn + "implicitInputTwo".length, "local", "integer"
        ], [
            "implicitRead", readLine, readSource.indexOf("implicitRead"),
            readSource.indexOf("implicitRead") + "implicitRead".length, "local", "integer"
        ], [
            "implicitReadTwo", readLine, secondReadColumn,
            secondReadColumn + "implicitReadTwo".length, "local", "integer"
        ]], "the stock-sidecar Outline query should return the compiler-created local's exact physical declaration");

        const readOffset = text.lastIndexOf("implicitLocal");
        const referencePosition = pointAt(text, "implicitLocal", readOffset - text.indexOf("implicitLocal"));
        const definitions = (await worker.query(reply.snapshotId, "definition", {
            ...input,
            position: referencePosition
        })).result;
        assert.deepEqual(definitions.map((entry) => [entry.name, entry.declaration.line,
            entry.declaration.startColumn, entry.declaration.endColumn]), [[
            "implicitLocal", assignmentLine, assignmentSource.indexOf("implicitLocal"),
            assignmentSource.indexOf("implicitLocal") + "implicitLocal".length
        ]], "Go to Definition should use the compiler's physical binding for an implicit local");
        const references = (await worker.query(reply.snapshotId, "references", {
            ...input,
            position: referencePosition,
            includeDeclaration: true
        })).result;
        assert.deepEqual(references.map((entry) => [entry.occurrence.line,
            entry.occurrence.startColumn, entry.occurrence.endColumn]), [
            [assignmentLine, assignmentSource.indexOf("implicitLocal"),
                assignmentSource.indexOf("implicitLocal") + "implicitLocal".length],
            [referencePosition.line, referencePosition.character, referencePosition.character + "implicitLocal".length]
        ], "Find References should return the compiler-bound declaration and use ranges");

        const refactoredText = text.replace(
            "    Let _\n        implicitLetLocal _\n            = 2",
            "    Dim implicitLetLocal As Integer\n    Let _\n        implicitLetLocal _\n            = 2"
        );
        assert.notEqual(refactoredText, text, "the refactor fixture should match the continued LET assignment");
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "placing the explicit declaration before the logical LET should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar identifies a first assignment in module-scope code", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        '#lang "deprecated"',
        "implicitModuleValue = 1",
        "Print implicitModuleValue",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const position = pointAt(text, "implicitModuleValue");
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position
        })).result;
        assert.equal(hover.compilerStorageClass, "local");
        assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        assert.deepEqual(hover.compilerStorageTypeDeclarationRange, {
            line: position.line,
            startColumn: position.character,
            endColumn: position.character + "implicitModuleValue".length
        });

        const refactoredText = text.replace(
            "implicitModuleValue = 1",
            "Dim implicitModuleValue As Integer = 1"
        );
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "an explicit module-scope DIM initializer should compile in place of the implicit first write");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock sidecar maps continued INPUT and GET targets to physical implicit declarations", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const compilerPath = process.env.FBC_EXECUTABLE || options.compilerPath;
    const text = [
        '#lang "deprecated"',
        "DefStr C",
        "DefInt I",
        "Sub ContinuedInputProbe()",
        '    Input "Prompt" _',
        "        , continuedInput",
        "    Get #1, , _",
        "        implicitGetValue",
        "    Print continuedInput, implicitGetValue",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerPath,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const lines = text.split("\n");
        const result = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 0, character: 0 },
            end: { line: lines.length - 1, character: 0 },
            parameterHints: false
        })).result;
        assert.deepEqual(result.implicitVariables.map((hint) => [
            hint.name, hint.position.line, hint.position.character, hint.storageType.primitive
        ]), [
            ["continuedInput", 5, lines[5].indexOf("continuedInput") + "continuedInput".length, "string"],
            ["implicitGetValue", 7, lines[7].indexOf("implicitGetValue") + "implicitGetValue".length, "integer"]
        ]);
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar locates an implicit variable at its first read", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        '#lang "fblite"',
        "Sub ImplicitFirstReadProbe()",
        "    Print implicitFirstRead + implicitFirstRead",
        "    Print implicitFirstRead",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const line = 2;
        const nameColumn = text.split("\n")[line].indexOf("implicitFirstRead");
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: { line, character: nameColumn }
        })).result;
        assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "integer",
            "the compiler-selected implicit variable should retain its type at a first-read occurrence");
        assert.equal(hover.compilerStorageClass, "local");
        assert.deepEqual(hover.compilerStorageTypeDeclarationRange, {
            line,
            startColumn: nameColumn,
            endColumn: nameColumn + "implicitFirstRead".length
        }, "FBC should bind the implicit declaration to its exact first-read token");
        const sameLineSecondReadColumn = text.split("\n")[line].lastIndexOf("implicitFirstRead");
        const hints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line, character: 0 },
            end: { line, character: text.split("\n")[line].length },
            parameterHints: false
        })).result;
        assert.deepEqual(hints.implicitVariables?.map((hint) => [
            hint.name, hint.line, hint.startColumn, hint.endColumn, hint.storageType.primitive
        ]), [["implicitFirstRead", line, nameColumn, nameColumn + "implicitFirstRead".length, "integer"]],
        "the compiler declaration occurrence should locate implicit variables even when their first use is a read");
        const outline = (await worker.query(reply.snapshotId, "compilerSidecarOutlineImplicitVariables", input)).result;
        assert.deepEqual(outline.map((variable) => [
            variable.name, variable.line, variable.startColumn, variable.endColumn, variable.storageType.primitive
        ]), [["implicitFirstRead", line, nameColumn, nameColumn + "implicitFirstRead".length, "integer"]]);

        const referencePosition = {
            line: line + 1,
            character: text.split("\n")[line + 1].indexOf("implicitFirstRead")
        };
        const definitions = (await worker.query(reply.snapshotId, "definition", {
            ...input,
            position: referencePosition
        })).result;
        assert.deepEqual(definitions.map((entry) => [
            entry.declaration.line, entry.declaration.startColumn, entry.declaration.endColumn
        ]), [[line, nameColumn, nameColumn + "implicitFirstRead".length]],
        "Go to Definition should bind a first-read variable to its exact compiler declaration occurrence");
        const references = (await worker.query(reply.snapshotId, "references", {
            ...input,
            position: referencePosition,
            includeDeclaration: true
        })).result;
        assert.deepEqual(references.map((entry) => [
            entry.occurrence.line, entry.occurrence.startColumn, entry.occurrence.endColumn
        ]), [
            [line, nameColumn, nameColumn + "implicitFirstRead".length],
            [line, sameLineSecondReadColumn, sameLineSecondReadColumn + "implicitFirstRead".length],
            [referencePosition.line, referencePosition.character, referencePosition.character + "implicitFirstRead".length]
        ], "Find References should include the first-read declaration and every repeated read");

        const refactoredText = text.replace(
            "    Print implicitFirstRead",
            "    Dim implicitFirstRead As Integer\n    Print implicitFirstRead"
        );
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "the exact compiler-selected local type should compile when made explicit before the first read");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar resolves an FBLite first read at module scope", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        '#lang "fblite"',
        "Print implicitModuleFirstRead",
        "Print implicitModuleFirstRead",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "fblite"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const position = pointAt(text, "implicitModuleFirstRead");
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position
        })).result;
        assert.equal(hover.compilerStorageClass, "local");
        assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        assert.deepEqual(hover.compilerStorageTypeDeclarationRange, {
            line: position.line,
            startColumn: position.character,
            endColumn: position.character + "implicitModuleFirstRead".length
        });
        const implicitVariables = (await worker.query(reply.snapshotId,
            "compilerSidecarOutlineImplicitVariables", input)).result;
        assert.deepEqual(implicitVariables.map((variable) => [
            variable.name, variable.line, variable.startColumn, variable.endColumn,
            variable.storageClass, variable.storageType.primitive
        ]), [[
            "implicitModuleFirstRead", position.line, position.character,
            position.character + "implicitModuleFirstRead".length, "local", "integer"
        ]]);
        const moduleLine = text.split("\n")[position.line];
        const hints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: position.line, character: 0 },
            end: { line: position.line, character: moduleLine.length },
            parameterHints: false
        })).result;
        assert.deepEqual(hints.implicitVariables?.map((hint) => [
            hint.position.line, hint.position.character, hint.storageType.primitive
        ]), [[position.line, position.character + "implicitModuleFirstRead".length, "integer"]]);
        const referenceLine = 2;
        const referenceColumn = text.split("\n")[referenceLine].indexOf("implicitModuleFirstRead");
        const definitions = (await worker.query(reply.snapshotId, "definition", {
            ...input,
            position: { line: referenceLine, character: referenceColumn + 1 }
        })).result;
        assert.deepEqual(definitions.map((entry) => [entry.declaration.line,
            entry.declaration.startColumn, entry.declaration.endColumn]), [[
            position.line, position.character, position.character + "implicitModuleFirstRead".length
        ]]);
        const references = (await worker.query(reply.snapshotId, "references", {
            ...input,
            position: { line: referenceLine, character: referenceColumn + 1 },
            includeDeclaration: true
        })).result;
        assert.deepEqual(references.map((entry) => entry.occurrence.line), [position.line, referenceLine]);

        const refactoredText = text.replace(
            "Print implicitModuleFirstRead",
            "Dim implicitModuleFirstRead As Integer\nPrint implicitModuleFirstRead"
        );
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "fblite"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "a typed module-scope declaration before the first read should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native bridge refactors a module-scope FBLite first read in an unsaved overlay", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const original = fs.readFileSync(filePath);
    const text = [
        '#lang "fblite"',
        "Print implicitModuleFirstRead",
        "Print implicitModuleFirstRead",
        ""
    ].join("\n");
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "fblite"],
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        overlays: new Map([[filePath, text]])
    }, preparation);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics.map((diagnostic) => diagnostic.message)));
    try {
        const queryInput = { ...input, openFiles: [filePath] };
        const position = pointAt(text, "implicitModuleFirstRead");
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...queryInput,
            position
        })).result;
        const declaration = hover.entries?.find((entry) => entry.name === "implicitModuleFirstRead")?.declaration;
        assert.equal(declaration?.line, position.line);
        assert.equal(declaration?.typeName?.toLowerCase(), "integer");
        assert.equal(declaration?.compilerFacts?.compilerStorageClass, "local");
        const outline = (await worker.query(reply.snapshotId, "documentSymbols", queryInput)).result;
        assert.ok(outline.some((symbol) => symbol.name === "implicitModuleFirstRead"),
            "native Outline should retain the module-scope implicit local");
        const completionLine = 2;
        const completionColumn = text.split("\n")[completionLine].indexOf("implicitModuleFirstRead") + 8;
        const completion = (await worker.query(reply.snapshotId, "completion", {
            ...queryInput,
            position: { line: completionLine, character: completionColumn },
            limit: 2000
        })).result;
        assert.ok(completion.entries?.some((entry) => entry.name === "implicitModuleFirstRead"),
            "native completion should expose the module-scope first-read local after its declaration");

        const refactoredText = text.replace(
            "Print implicitModuleFirstRead",
            "Dim implicitModuleFirstRead As Integer\nPrint implicitModuleFirstRead"
        );
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "fblite"],
            exportSemanticExpressions: true,
            exportSemanticBindings: true,
            overlays: new Map([[filePath, refactoredText]])
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "the explicit module variable before its first read should compile in the overlay");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
        assert.equal(fs.readFileSync(filePath).equals(original), true,
            "native FBLite first-read analysis must not save the unsaved root");
    }
});

test("stock callable tokens follow namespace and type owners across headers", native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "owners.bi");
    const header = ["Namespace Helpers", "Declare Function Calculate() As Long", "End Namespace",
        "Type Widget", "number As Long", "Declare Sub Touch()", "End Type", ""].join("\n");
    const source = ['#include "owners.bi"', "Function Helpers.Calculate() As Long", "Return 1", "End Function",
        "Sub Widget.Touch()", "End Sub", "Dim value As Widget", "value.Touch()", "Print Helpers.Calculate()", ""].join("\n");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(filePath, source);
    const compiled = spawnSync(process.env.FBC_EXECUTABLE || options.compilerPath,
        ["-c", filePath, "-o", path.join(directory, "owners.o")], { cwd: directory, encoding: "utf8", timeout: 30000 });
    assert.equal(compiled.status, 0, `${compiled.stdout}${compiled.stderr}`);
    const reply = await worker.analyze({ ...options, semanticModelOnly: true,
        exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
    for (const [text, file] of [[source, filePath], [header, headerPath]]) {
        const tokens = decodeSemanticTokenRecords((await worker.query(reply.snapshotId, "semanticTokens", {
            ...input, uri: { scheme: "file", fsPath: file }
        })).result);
        for (const [line, lineText] of text.split("\n").entries()) {
            for (const match of lineText.matchAll(/\b(Calculate|Touch)\b/g)) {
                const token = tokens.find((entry) => entry.line === line && entry.character === match.index);
                assert.ok(token, `missing ${match[0]} at ${file}:${line}:${match.index}`);
                assert.equal(token.type, TOKEN_TYPES.indexOf(match[0] === "Calculate" ? "function" : "method"), match[0]);
            }
        }
    }
    for (const bindings of [false, true]) {
        const bridge = await worker.analyze({ ...options, exportSemanticExpressions: true, exportSemanticBindings: bindings }, preparation);
        assert.equal(bridge.partial, false, JSON.stringify(bridge.diagnostics));
        const tokens = decodeSemanticTokenRecords((await worker.query(bridge.snapshotId, "semanticTokens", input)).result);
        for (const [line, text] of source.split("\n").entries()) {
            for (const match of text.matchAll(/\b(Calculate|Touch)\b/g)) {
                assert.equal(tokens.find((token) => token.line === line && token.character === match.index)?.type,
                    TOKEN_TYPES.indexOf(match[0] === "Calculate" ? "function" : "method"), `${match[0]} at ${line}, bindings=${bindings}`);
            }
        }
        if (!bindings) continue;
        for (const [text, name, kind] of [["Print Helpers.Calculate()", "Calculate", "function"], ["value.Touch()", "Touch", "method"]]) {
            const position = pointAt(source, text, text.indexOf(name) + 1);
            const hierarchy = (await worker.query(bridge.snapshotId, "callHierarchyPrepare", { ...input, position })).result;
            assert.equal(hierarchy.length, 1);
            assert.equal(hierarchy[0].callableKind, kind, "worker serialization must retain resolved callable ownership");
            const outline = (await worker.query(bridge.snapshotId, "documentSymbols", input)).result;
            assert.equal(outline.find((entry) => entry.name === name)?.callableKind, kind,
                "native Outline projection must preserve the same callable owner");
            const completionPosition = pointAt(source, text, text.indexOf(name));
            const completions = (await worker.query(bridge.snapshotId, "completion", { ...input, position: completionPosition, limit: 20 })).result;
            assert.equal(completions.entries.find((entry) => entry.name === name)?.callableKind, kind);
        }
    }
});

test("primitive type layout lookup withholds conflicting or unverified physical contexts", () => {
    const filePath = path.join(os.tmpdir(), "primitive-layout.bas"), uri = CompilerUri.file(filePath);
    const model = Object.create(CompilerSemanticModel.prototype);
    const token = { kind: "identifier", startColumn: 0, endColumn: 7 };
    model.getDocument = () => ({ byLine: new Map([[0, [token]]]) });
    const layout = { typeName: "integer", storageKind: "value", storageBytes: "8", pointerDepth: 0 };
    const inputs = [{ startLine: 1, endLine: 1, startColumn: 0, endColumn: 7, layout }];
    const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
    model.compilerPrimitiveTypesByFileLine = new Map([[key, new Map([[0, inputs]])]]);
    const point = { line: 0, character: 1 };
    assert.equal(model.compilerPrimitiveTypeAt(uri, point), layout);
    inputs.push({ ...inputs[0], layout: { ...layout, storageBytes: "4" } });
    assert.equal(model.compilerPrimitiveTypeAt(uri, point), null, "shared source cannot choose one target/context layout");
    inputs[1] = { ...inputs[0], layout: undefined };
    assert.equal(model.compilerPrimitiveTypeAt(uri, point), null, "a missing companion is not evidence of agreement");
    inputs.pop();
    token.kind = "string";
    assert.equal(model.compilerPrimitiveTypeAt(uri, point), null, "only the exact identifier token is eligible");
    token.kind = "identifier";
    model.partial = true;
    assert.equal(model.compilerPrimitiveTypeAt(uri, point), null);
});

test("native primitive hovers report the accepted type component and target storage", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["Dim longValue As Long", "Dim nativeValue As Integer", "Dim wideValue As Integer<128>",
        "Dim pointerValue As Const Long Ptr", "Dim textValue As String", "Dim fixedValue As String * 1",
        "Dim zeroPointer As ZString Ptr", "Dim wideText As WString * 4",
        "Declare Function Work(ByVal amount As Double) As Single", "Declare Sub AcceptBuffer(ByRef bufferValue As Any)",
        "#define NumericType Long", "Dim macroValue As NumericType", "Type LocalAlias As Long", "Dim aliased As LocalAlias",
        "Print SizeOf(Long)", ""].join("\n");
    fs.writeFileSync(filePath, text);
    // Trace-free output from the refreshed compiler exercises the stock-model
    // path too, without replacing the user's independently built normal fbc.
    for (const sidecar of [false, true]) {
        const reply = await worker.analyze({ ...options, semanticModelOnly: sidecar,
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            const hover = async (line, word) => (await worker.query(reply.snapshotId, "hover", { ...input,
                position: { line, character: text.split("\n")[line].lastIndexOf(word) + 1 } })).result;
            for (const [line, word, typeName, storageKind, storageBytes, pointerDepth] of [
                [0, "Long", "long", "value", "4", 0], [2, "Integer", "integer<128>", "value", "16", 0],
                [5, "String", "string * 1", "value", "1", 0], [8, "Double", "double", "value", "8", 0],
                [8, "Single", "single", "value", "4", 0], [9, "Any", "any", "unsized", "0", 0]
            ]) assert.deepEqual((await hover(line, word)).primitiveType, { typeName, storageKind, storageBytes, pointerDepth });
            for (const [line, word, variable, typeName, kind, depth, elements = 1] of [[1, "Integer", "nativeValue", "integer", "value", 0],
                [3, "Long", "pointerValue", "const long ptr", "pointer", 1], [4, "String", "textValue", "string", "string-descriptor", 0],
                [6, "ZString", "zeroPointer", "zstring ptr", "pointer", 1], [7, "WString", "wideText", "wstring * 4", "value", 0, 4]]) {
                const selected = (await hover(line, word)).primitiveType;
                const declaration = await hover(line, variable);
                assert.deepEqual(selected, { typeName, storageKind: kind,
                    // NT reports a WSTRING code unit; the accepted fixed type
                    // includes the source's four-element character storage.
                    storageBytes: String(declaration.compilerStorageTypeFacts.storageType.storageBytes * elements), pointerDepth: depth });
            }
            assert.equal((await hover(11, "NumericType")).primitiveType, null);
            assert.equal((await hover(13, "LocalAlias")).primitiveType, null);
            const queryType = await hover(14, "Long");
            assert.equal(queryType.primitiveType.typeName, "long");
            assert.equal(queryType.expression, null, "the type keyword must not borrow SIZEOF's enclosing expression type");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("native semantic tokens classify accepted primitive types without borrowing alias or macro identity", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const headerPath = path.join(path.dirname(filePath), "types.bi"), header = "Type HeaderAlias As Long";
    const additionalTypes = [["Dim booleanValue As Boolean", "Boolean"], ["Dim byteValue As Byte", "Byte"],
        ["Dim unsignedByte As UByte", "UByte"], ["Dim shortValue As Short", "Short"], ["Dim unsignedShort As UShort", "UShort"],
        ["Dim unsignedLong As ULong", "ULong"], ["Dim longInteger As LongInt", "LongInt"], ["Dim unsignedLongInteger As ULongInt", "ULongInt"],
        ["Dim zeroText As ZString * 16", "ZString"], ["Dim wideText As WString * 16", "WString"], ["Dim unicodeText As UString", "UString"],
        ["Dim fixedText As String * 8", "String"], ["Dim explicitUnsigned As Unsigned Long", "Long"],
        ["Declare Sub AcceptBuffer(ByVal bufferValue As Any Ptr)", "Any"], ['Print "é😀" : Dim unicodeByte As Byte', "Byte"]];
    const source = ["Type LocalAlias As Long", "Dim wide As Integer<128>", "Dim values(0 To 1) As Const UInteger Ptr",
        "Declare Function Identity(ByVal value As Double) As Single", "Dim textValue As String", "Dim aliased As LocalAlias",
        "#define NumericType Long", "Dim macroValue As NumericType", "#if 0", "Dim inactive As Short", "#endif",
        "' Long in a comment", 'Print "Long in a literal"', '#include once "types.bi"',
        ...additionalTypes.map(([text]) => text), ""].join("\n");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(filePath, source);
    for (const sidecar of [false, true]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            semanticModelOnly: sidecar, compactSemanticMacros: !sidecar,
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            const records = decodeSemanticTokenRecords((await worker.query(reply.snapshotId, "semanticTokens", input)).result);
            for (const [line, word] of [[0, "Long"], [1, "Integer"], [2, "UInteger"], [3, "Double"], [3, "Single"], [4, "String"],
                ...additionalTypes.map(([, word], index) => [14 + index, word])]) {
                const column = source.split("\n")[line].lastIndexOf(word);
                const record = records.find((entry) => entry.line === line && entry.character === column);
                assert.equal(record?.type, TOKEN_TYPES.indexOf("type"), `${sidecar ? "stock" : "bridge"}: ${word} at ${line}`);
                assert.ok(record.modifiers & (1 << TOKEN_MODIFIERS.indexOf("defaultLibrary")));
                assert.equal(record.length, word.length);
            }
            for (const [line, word] of [[0, "LocalAlias"], [5, "LocalAlias"], [7, "NumericType"], [9, "Short"], [11, "Long"], [12, "Long"]]) {
                const column = source.split("\n")[line].indexOf(word);
                const record = records.find((entry) => entry.line === line && entry.character === column);
                assert.equal(Boolean(record && record.modifiers & (1 << TOKEN_MODIFIERS.indexOf("defaultLibrary"))), false,
                    "only an accepted primitive receipt grants built-in type classification: " + word);
            }
            const headerTokens = decodeSemanticTokenRecords((await worker.query(reply.snapshotId, "semanticTokens", {
                ...input, uri: { scheme: "file", fsPath: headerPath }
            })).result);
            const primitive = headerTokens.find((entry) => entry.line === 0 && entry.character === header.indexOf("Long"));
            assert.equal(primitive?.type, TOKEN_TYPES.indexOf("type"));
            assert.ok(primitive.modifiers & (1 << TOKEN_MODIFIERS.indexOf("defaultLibrary")),
                "included headers without a final newline retain their physical primitive occurrence");
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("native primitive highlighting keeps NOKEYWORD aliases and values separate", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const source = ['#lang "fblite"', "Option NoKeyword Integer, Double", "Type Double As Long",
        "Dim number As Double", "Dim Integer As Long", "Print Integer", ""].join("\n");
    fs.writeFileSync(filePath, source);
    for (const sidecar of [false, true]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            semanticModelOnly: sidecar, compactSemanticMacros: !sidecar,
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
            const records = decodeSemanticTokenRecords((await worker.query(reply.snapshotId, "semanticTokens", input)).result);
            for (const [line, word, expected] of [[2, "Double", "type"], [3, "Double", "type"], [4, "Integer", "variable"], [5, "Integer", "variable"]]) {
                const record = records.find((entry) => entry.line === line && entry.character === source.split("\n")[line].indexOf(word));
                assert.equal(record?.type, TOKEN_TYPES.indexOf(expected), word);
                assert.equal(Boolean(record.modifiers & (1 << TOKEN_MODIFIERS.indexOf("defaultLibrary"))), false, word);
                const hover = (await worker.query(reply.snapshotId, "hover", { ...input,
                    position: { line, character: source.split("\n")[line].indexOf(word) + 1 } })).result;
                assert.equal(hover.primitiveType, null, "aliases and values must not borrow primitive type layout");
            }
        } finally { worker.releaseModel(reply.snapshotId); }
    }
});

test("stock FBC semantic tokens retain ordinary symbols beside NOKEYWORD names", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["Option NoKeyword REM", "Dim Shared ordinaryValue As Long = 1", "Dim REM As Const Long = 2",
        "Function ComputeValue(ByVal inputValue As Long) As Long", "    Return inputValue + ordinaryValue", "End Function",
        "Function OtherValue(ByVal inputValue As Long) As Long", "    Return inputValue", "End Function",
        "Declare Sub ExternalSub()", "Type TokenOwner", "    fieldValue As Long", "End Type", "Dim owner As TokenOwner",
        "ordinaryValue = ComputeValue(REM)", "owner.fieldValue = ordinaryValue", "Print ordinaryValue", ""].join("\n");
    fs.writeFileSync(filePath, text);
    const compiled = spawnSync(process.env.FBC_EXECUTABLE || options.compilerPath,
        ["-lang", "deprecated", "-c", filePath, "-o", path.join(path.dirname(filePath), "tokens.o")],
        { encoding: "utf8", timeout: 30000 });
    assert.equal(compiled.status, 0, `${compiled.stdout}${compiled.stderr}`);
    const reply = await worker.analyze({ ...options, compilerArguments: ["-lang", "deprecated"], semanticModelOnly: true,
        exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics));
    const records = decodeSemanticTokenRecords((await worker.query(reply.snapshotId, "semanticTokens", input)).result);
    const expectedTypes = { ordinaryValue: "variable", REM: "variable", ComputeValue: "function", OtherValue: "function",
        inputValue: "parameter", TokenOwner: "struct", ExternalSub: "function", fieldValue: "property", owner: "variable" };
    for (const [line, lineText] of text.split("\n").entries()) {
        if (line === 0) continue;
        for (const match of lineText.matchAll(/\b(ordinaryValue|REM|ComputeValue|OtherValue|inputValue|TokenOwner|ExternalSub|fieldValue|owner)\b/g)) {
            const record = records.find((token) => token.line === line && token.character === match.index);
            assert.ok(record, `missing ${match[0]} semantic token at ${line}:${match.index}`);
            assert.equal(record.type, TOKEN_TYPES.indexOf(expectedTypes[match[0]]), match[0]);
            if (match[0] === "REM") assert.ok(record.modifiers & (1 << TOKEN_MODIFIERS.indexOf("readonly")));
        }
    }
    const procedureDeclaration = records.find((token) => token.line === 9 && token.character === "Declare Sub ".length);
    assert.ok(procedureDeclaration.modifiers & (1 << TOKEN_MODIFIERS.indexOf("declaration")));
    const procedureDefinition = records.find((token) => token.line === 3 && token.character === "Function ".length);
    assert.ok(procedureDefinition.modifiers & (1 << TOKEN_MODIFIERS.indexOf("definition")));
    const parameterPoint = pointAt(text, "Return inputValue +", "Return i".length);
    const definitions = (await worker.query(reply.snapshotId, "definition", { ...input, position: parameterPoint })).result;
    assert.deepEqual(definitions.map((entry) => entry.declaration.line), [3]);
    const references = (await worker.query(reply.snapshotId, "references", { ...input, position: parameterPoint, includeDeclaration: true })).result;
    assert.deepEqual(references.map((entry) => entry.occurrence.line).sort((first, second) => first - second), [3, 4],
        "parameter aliases must not join an identically named parameter in another procedure");
});

test("stock FBC accepts REM as an identifier after OPTION NOKEYWORD", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures", "option-no-keyword-rem.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const lines = text.split("\n");
        const bracketOverrides = (await worker.query(reply.snapshotId, "compilerBracketMaskOverrides", input)).result;
        assert.deepEqual(bracketOverrides.remIdentifierOffsets, [
            text.indexOf("REM As Integer"),
            text.indexOf("REM ="),
            text.lastIndexOf("REM")
        ], "complete sidecar bindings should authorize only their exact physical REM identifier tokens");
        const declarationLine = lines.findIndex((line) => /^\s*Dim REM\b/.test(line));
        const declarationColumn = lines[declarationLine].indexOf("REM");
        const assignmentLine = lines.findIndex((line) => /^\s*REM\s*=/.test(line));
        const referenceLine = lines.findIndex((line) => /^\s*Print REM\s*$/.test(line));
        const referenceColumn = lines[referenceLine].lastIndexOf("REM");
        const position = { line: referenceLine, character: referenceColumn };
        const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position })).result;
        assert.deepEqual(hover.entries?.map((entry) => entry.name), ["REM"],
            "sidecar hover should recover a compiler-bound identifier hidden by the source masker");
        assert.equal(hover.entries[0].declaration.typeName?.toLowerCase(), "integer",
            "hover should retain the compiler-selected type for the masked identifier");
        const semanticTokens = (await worker.query(reply.snapshotId, "semanticTokens", input)).result;
        const tokenRecords = decodeSemanticTokenRecords(semanticTokens);
        for (const [line, column, role] of [
            [declarationLine, declarationColumn, "definition"],
            [assignmentLine, lines[assignmentLine].indexOf("REM"), "modification"],
            [referenceLine, referenceColumn, "read"]
        ]) {
            const semanticToken = tokenRecords.find((entry) => entry.line === line &&
                entry.character === column && entry.length === "REM".length);
            assert.ok(semanticToken,
                `semantic tokens should color the compiler-bound ${role} hidden by the source masker`);
            assert.equal(semanticToken.type, TOKEN_TYPES.indexOf("variable"));
            if (role === "definition") {
                assert.ok(semanticToken.modifiers & (1 << TOKEN_MODIFIERS.indexOf("definition")));
            } else if (role === "modification") {
                assert.ok(semanticToken.modifiers & (1 << TOKEN_MODIFIERS.indexOf("modification")));
            }
        }
        const completion = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: referenceLine, character: referenceColumn + 2 },
            limit: 2000
        })).result;
        assert.ok(completion.entries?.some((entry) => entry.name === "REM"),
            "completion should include compiler-bound names even when the source masker treats them as comments");
        const outline = (await worker.query(reply.snapshotId, "compilerSidecarOutlineMaskedVariables", input)).result;
        assert.deepEqual(outline.map((entry) => [entry.name, entry.declaration.type,
            entry.declaration.line, entry.declaration.startColumn, entry.declaration.endColumn]), [[
            "REM", "variable", declarationLine, declarationColumn, declarationColumn + "REM".length
        ]], "Outline records should retain the compiler-selected physical declaration site");
        const otherProcedureLine = lines.findIndex((line) => /^\s*Print otherValue\s*$/.test(line));
        const otherProcedureColumn = lines[otherProcedureLine].indexOf("otherValue") + 3;
        const otherProcedureCompletion = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: otherProcedureLine, character: otherProcedureColumn },
            limit: 2000
        })).result;
        assert.ok(!otherProcedureCompletion.entries?.some((entry) => entry.name === "REM"),
            "a masked local should not leak into completion in another procedure");
        const definitions = (await worker.query(reply.snapshotId, "definition", { ...input, position })).result;
        assert.deepEqual(definitions.map((entry) => [entry.declaration.line,
            entry.declaration.startColumn, entry.declaration.endColumn]), [[
            declarationLine, declarationColumn, declarationColumn + "REM".length
        ]], "a compiler binding should preserve Go to Definition when the parser masks REM as a comment");
        const highlights = (await worker.query(reply.snapshotId, "highlights", {
            ...input,
            position: { line: referenceLine, character: referenceColumn + 1 }
        })).result;
        assert.deepEqual(highlights.map((entry) => [entry.occurrence.line, entry.occurrence.startColumn,
            entry.occurrence.endColumn, entry.accessRole]), [
            [declarationLine, declarationColumn, declarationColumn + "REM".length, undefined],
            [assignmentLine, lines[assignmentLine].indexOf("REM"), lines[assignmentLine].indexOf("REM") + "REM".length, "write"],
            [referenceLine, referenceColumn, referenceColumn + "REM".length, "read"]
        ], "compiler-backed document highlights should mark the exact declaration, write, and read");
        const references = (await worker.query(reply.snapshotId, "references", {
            ...input,
            position,
            includeDeclaration: true
        })).result;
        assert.deepEqual(references.map((entry) => [entry.occurrence.line,
            entry.occurrence.startColumn, entry.occurrence.endColumn]), [
            [declarationLine, declarationColumn, declarationColumn + "REM".length],
            [assignmentLine, lines[assignmentLine].indexOf("REM"), lines[assignmentLine].indexOf("REM") + "REM".length],
            [referenceLine, referenceColumn, referenceColumn + "REM".length]
        ], "compiler-bound references should survive source-masker keyword mismatches");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock FBC sidecar uses disabled keyword bindings for hover, tokens, and implicit inlays", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        '#lang "deprecated"',
        "Option NoKeyword Print, Input, Abs",
        "Sub PrintIdentifierProbe()",
        "    Dim Print As Integer",
        "    Print = Print + 1",
        "End Sub",
        "Sub InputIdentifierProbe()",
        "    Input = 1",
        "    Input = Input + 1",
        "End Sub",
        "Sub AbsIdentifierProbe()",
        "    Abs = 1",
        "    Abs = Abs + 1",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const position = { line: 4, character: text.split("\n")[4].lastIndexOf("Print") + 2 };
        const hover = (await worker.query(reply.snapshotId, "hover", { ...input, position })).result;
        assert.deepEqual(hover.entries?.map((entry) => entry.name), ["Print"],
            "hover should use the compiler binding when the source resolver still treats the spelling as a keyword");
        assert.equal(hover.entries[0].declaration.type, "variable");
        assert.equal(hover.entries[0].declaration.typeName?.toLowerCase(), "integer");
        const semanticTokens = (await worker.query(reply.snapshotId, "semanticTokens", input)).result;
        const tokenRecords = decodeSemanticTokenRecords(semanticTokens);
        const declarationLine = 3;
        const assignmentLine = 4;
        for (const [line, column, modifier] of [
            [declarationLine, 8, "definition"],
            [assignmentLine, 4, "modification"],
            [assignmentLine, 12, ""]
        ]) {
            const token = tokenRecords.find((entry) => entry.line === line && entry.character === column && entry.length === 5);
            assert.ok(token, `semantic tokens should include compiler-bound PRINT at ${line}:${column}`);
            assert.equal(token.type, TOKEN_TYPES.indexOf("variable"));
            if (modifier) {
                assert.ok(token.modifiers & (1 << TOKEN_MODIFIERS.indexOf(modifier)));
            }
        }
        const absLine = 11;
        const absToken = tokenRecords.find((entry) => entry.line === absLine && entry.character === 4 && entry.length === 3);
        assert.ok(absToken, "semantic tokens should include the compiler-created ABS local");
        assert.equal(absToken.type, TOKEN_TYPES.indexOf("variable"));
        assert.ok(absToken.modifiers & (1 << TOKEN_MODIFIERS.indexOf("definition")));
        const lines = text.split("\n");
        const implicitLine = 7;
        const implicitHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: implicitLine, character: 0 },
            end: { line: 8, character: lines[8].length }
        })).result;
        assert.deepEqual(implicitHints.implicitVariables.map((hint) => [
            hint.name, hint.position.line, hint.storageType?.primitive
        ]), [["Input", implicitLine, "integer"]],
        "stock FBC should retain the compiler-created local after its INPUT keyword is disabled");
        const absHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: absLine, character: 0 },
            end: { line: 12, character: lines[12].length }
        })).result;
        assert.deepEqual(absHints.implicitVariables.map((hint) => [
            hint.name, hint.position.line, hint.storageType?.primitive
        ]), [["Abs", absLine, "integer"]],
        "stock FBC should retain the implicit local created from a released runtime name");
        const absCompletion = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: 12, character: 6 },
            limit: 2000
        })).result;
        assert.ok(absCompletion.entries.some((entry) => entry.name === "Abs" &&
            entry.declaration.type === "variable"),
        "compiler bindings should offer the previously created implicit ABS local over its removed runtime symbol");
        const runtimeNameHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: { line: 12, character: 11 }
        })).result;
        assert.deepEqual(runtimeNameHover.entries?.map((entry) => entry.name), ["Abs"],
            "stock FBC should use physical bindings when NOKEYWORD releases a runtime symbol spelling");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock FBC retains the implicit-variable declaration for a masked REM first write", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        '#lang "deprecated"',
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub RemImplicitWriteProbe()",
        "    REM = 1",
        "    Print REM",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    try {
        const lines = text.split("\n");
        const line = lines.findIndex((value) => /^\s*REM\s*=/.test(value));
        const startColumn = lines[line].indexOf("REM");
        const result = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line, character: 0 },
            end: { line, character: lines[line].length }
        })).result;
        assert.deepEqual(result.implicitVariables.map((hint) => [
            hint.position.line,
            hint.position.character,
            hint.storageType?.primitive
        ]), [[line, startColumn + "REM".length, "integer"]],
        "FBC's physical declaration occurrence should retain the masked identifier's selected type");
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: { line, character: startColumn + 1 }
        })).result;
        assert.deepEqual([
            hover.entries?.[0]?.declaration.typeName?.toLowerCase(),
            hover.compilerStorageClass,
            hover.compilerStorageTypeDeclarationRange?.line,
            hover.compilerStorageTypeDeclarationRange?.startColumn,
            hover.compilerStorageTypeDeclarationRange?.endColumn
        ], ["integer", "local", line, startColumn, startColumn + "REM".length],
        "the same exact compiler declaration should authorize the typed-Dim refactor");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("editor bridge preserves conditional REM bindings in source navigation", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures", "option-no-keyword-rem.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, false);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    try {
        const lines = text.split("\n");
        const declarationLine = lines.findIndex((line) => /^\s*Dim REM\b/.test(line));
        const declarationColumn = lines[declarationLine].indexOf("REM");
        const referenceLine = lines.findIndex((line) => /^\s*Print REM\s*$/.test(line));
        const referenceColumn = lines[referenceLine].lastIndexOf("REM");
        const position = { line: referenceLine, character: referenceColumn + 1 };
        const definitions = (await worker.query(reply.snapshotId, "definition", { ...input, position })).result;
        assert.deepEqual(definitions.map((entry) => [entry.declaration.line,
            entry.declaration.startColumn, entry.declaration.endColumn]), [[
            declarationLine, declarationColumn, declarationColumn + "REM".length
        ]], "the native bridge should retain the exact compiler-selected declaration through preprocessing");
        const references = (await worker.query(reply.snapshotId, "references", {
            ...input, position, includeDeclaration: true
        })).result;
        assert.deepEqual(references.map((entry) => [entry.occurrence.line,
            entry.occurrence.startColumn, entry.occurrence.endColumn]), [
            [declarationLine, declarationColumn, declarationColumn + "REM".length],
            [lines.findIndex((line) => /^\s*REM\s*=/.test(line)),
                lines.find((line) => /^\s*REM\s*=/.test(line)).indexOf("REM"),
                lines.find((line) => /^\s*REM\s*=/.test(line)).indexOf("REM") + "REM".length],
            [referenceLine, referenceColumn, referenceColumn + "REM".length]
        ], "native references should map the declaration and uses back to the physical source");
        const completion = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: { line: referenceLine, character: referenceColumn + 2 },
            limit: 2000
        })).result;
        assert.ok(completion.entries.some((entry) => entry.name === "REM"),
            "native completion should retain compiler-bound REM declarations through preprocessing");
        const semanticTokens = decodeSemanticTokenRecords(
            (await worker.query(reply.snapshotId, "semanticTokens", input)).result
        );
        assert.ok(semanticTokens.some((entry) => entry.line === declarationLine &&
            entry.character === declarationColumn && entry.length === "REM".length &&
            entry.type === TOKEN_TYPES.indexOf("variable")),
        "the bridge semantic-token stream should preserve the masked declaration as a variable");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("editor bridge retains the compiler-selected type for an implicit conditional REM local", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        '#lang "deprecated"',
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub RemImplicitBridgeProbe()",
        "    REM = 1",
        "    Print REM",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    try {
        const line = 5;
        const startColumn = text.split("\n")[line].indexOf("REM");
        const endColumn = startColumn + "REM".length;
        const hints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line, character: 0 },
            end: { line, character: text.split("\n")[line].length }
        })).result;
        assert.ok(hints.types.some((hint) => hint.position.line === line &&
            hint.position.character === endColumn && hint.typeName.toLowerCase() === "integer"),
        "the native bridge should recover the implicit variable's type from its compiler binding");
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: { line, character: startColumn + 1 }
        })).result;
        assert.deepEqual([hover.entries?.[0]?.name, hover.entries?.[0]?.declaration.typeName?.toLowerCase()],
            ["REM", "integer"]);
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("editor bridge maps conditional REM bindings in an unsaved root overlay", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const original = fs.readFileSync(filePath);
    const text = fs.readFileSync(path.join(__dirname, "fixtures", "option-no-keyword-rem.bas"), "utf8");
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        overlays: new Map([[filePath, text]])
    }, preparation);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    try {
        const lines = text.split("\n");
        const declarationLine = lines.findIndex((line) => /^\s*Dim REM\b/.test(line));
        const declarationColumn = lines[declarationLine].indexOf("REM");
        const referenceLine = lines.findIndex((line) => /^\s*Print REM\s*$/.test(line));
        const referenceColumn = lines[referenceLine].lastIndexOf("REM");
        const queryInput = { ...input, openFiles: [filePath] };
        const definitions = (await worker.query(reply.snapshotId, "definition", {
            ...queryInput,
            position: { line: referenceLine, character: referenceColumn + 1 }
        })).result;
        assert.deepEqual(definitions.map((entry) => [entry.declaration.line,
            entry.declaration.startColumn, entry.declaration.endColumn]), [[
            declarationLine, declarationColumn, declarationColumn + "REM".length
        ]]);
        const references = (await worker.query(reply.snapshotId, "references", {
            ...queryInput,
            position: { line: referenceLine, character: referenceColumn + 1 },
            includeDeclaration: true
        })).result;
        assert.equal(references.length, 3,
            "all compiler-bound physical occurrences should project from the unsaved source snapshot");
        assert.equal(fs.readFileSync(filePath).equals(original), true,
            "the editor bridge must not save the buffer overlay");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native bridge preserves unsaved statement-target semantics and compiles typed refactors", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const original = fs.readFileSync(filePath);
    const text = [
        '#lang "deprecated"',
        "ReDim Shared _",
        "    implicitSharedOverlay( _",
        "        0 To 2)",
        "Sub UnsavedContinuedLetProbe()",
        "    Let _",
        "        implicitContinuedValue _",
        "            = 2",
        "    Print implicitContinuedValue",
        "End Sub",
        "Sub UnsavedContinuedForProbe()",
        "    For _",
        "        implicitLoopCounter = 1 To 3",
        "    Next implicitLoopCounter",
        "End Sub",
        "Sub UnsavedInputSwapProbe()",
        '    Input "Value"; implicitInputValue',
        "    Swap implicitSwapFirst, _",
        "        implicitSwapSecond",
        "End Sub",
        "Sub UnsavedRedimProbe()",
        "    ReDim implicitOverlayArray(0 To 2)",
        "End Sub",
        ""
    ].join("\n");
    const overlay = new Map([[filePath, text]]);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        overlays: overlay
    }, preparation);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics.map((diagnostic) => diagnostic.message)));
    try {
        const queryInput = { ...input, openFiles: [filePath] };
        const position = pointAt(text, "implicitContinuedValue");
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...queryInput,
            position
        })).result;
        const declaration = hover.entries?.find((entry) => entry.name === "implicitContinuedValue")?.declaration;
        assert.equal(declaration?.line, position.line);
        assert.equal(declaration?.typeName?.toLowerCase(), "integer");
        assert.equal(declaration?.compilerFacts?.compilerStorageClass, "local");

        const loopPosition = pointAt(text, "implicitLoopCounter");
        const loopHover = (await worker.query(reply.snapshotId, "hover", {
            ...queryInput,
            position: loopPosition
        })).result;
        const loopDeclaration = loopHover.entries?.find((entry) => entry.name === "implicitLoopCounter")?.declaration;
        assert.equal(loopDeclaration?.line, loopPosition.line);
        assert.equal(loopDeclaration?.typeName?.toLowerCase(), "integer");
        assert.equal(loopDeclaration?.compilerFacts?.compilerStorageClass, "local");

        for (const name of ["implicitInputValue", "implicitSwapFirst", "implicitSwapSecond"]) {
            const position = pointAt(text, name);
            const targetHover = (await worker.query(reply.snapshotId, "hover", {
                ...queryInput,
                position
            })).result;
            const targetDeclaration = targetHover.entries?.find((entry) => entry.name === name)?.declaration;
            assert.equal(targetDeclaration?.typeName?.toLowerCase(), "integer");
            assert.equal(targetDeclaration?.compilerFacts?.compilerStorageClass, "local");
        }
        const arrayPosition = pointAt(text, "implicitOverlayArray");
        const arrayHover = (await worker.query(reply.snapshotId, "hover", {
            ...queryInput,
            position: arrayPosition
        })).result;
        const arrayDeclaration = arrayHover.entries?.find((entry) => entry.name === "implicitOverlayArray")?.declaration;
        assert.equal(arrayDeclaration?.line, arrayPosition.line);
        const arrayStartColumn = text.split("\n")[arrayPosition.line].indexOf("implicitOverlayArray");
        assert.equal(arrayDeclaration?.startColumn, arrayStartColumn);
        assert.equal(arrayDeclaration?.endColumn, arrayStartColumn + "implicitOverlayArray".length);
        assert.equal(arrayDeclaration?.typeName?.toLowerCase(), "integer");
        assert.equal(arrayDeclaration?.compilerFacts?.compilerStorageClass, "local");
        const arrayLineText = text.split("\n")[arrayPosition.line];
        const arrayHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...queryInput,
            position: { line: arrayPosition.line, character: 0 },
            end: { line: arrayPosition.line, character: arrayLineText.length },
            parameterHints: false
        })).result;
        assert.ok(arrayHints.types?.some((hint) => hint.position.line === arrayPosition.line &&
            hint.position.character === arrayStartColumn + "implicitOverlayArray".length &&
            hint.typeName.toLowerCase() === "integer"),
        "the native overlay should provide a type inlay for a new REDIM array");
        const sharedPosition = pointAt(text, "implicitSharedOverlay");
        const sharedHover = (await worker.query(reply.snapshotId, "hover", {
            ...queryInput,
            position: sharedPosition
        })).result;
        const sharedDeclaration = sharedHover.entries?.find((entry) => entry.name === "implicitSharedOverlay")?.declaration;
        assert.equal(sharedDeclaration?.line, sharedPosition.line);
        const sharedStartColumn = text.split("\n")[sharedPosition.line].indexOf("implicitSharedOverlay");
        assert.equal(sharedDeclaration?.startColumn, sharedStartColumn);
        assert.equal(sharedDeclaration?.endColumn, sharedStartColumn + "implicitSharedOverlay".length);
        assert.equal(sharedDeclaration?.typeName?.toLowerCase(), "integer");
        assert.equal(sharedDeclaration?.compilerFacts?.compilerStorageClass, "static");
        assert.equal(sharedDeclaration?.compilerFacts?.storageType?.primitive, "integer");

        const refactoredText = text.replace(
            "    Let _\n        implicitContinuedValue _\n            = 2",
            "    Dim implicitContinuedValue As Integer\n    Let _\n        implicitContinuedValue _\n            = 2"
        ).replace(
            "    For _\n        implicitLoopCounter = 1 To 3",
            "    For _\n        implicitLoopCounter As Integer = 1 To 3"
        ).replace(
            '    Input "Value"; implicitInputValue',
            '    Dim implicitInputValue As Integer\n    Input "Value"; implicitInputValue'
        ).replace(
            "    Swap implicitSwapFirst, _\n        implicitSwapSecond",
            "    Dim implicitSwapFirst As Integer\n    Dim implicitSwapSecond As Integer\n" +
                "    Swap implicitSwapFirst, _\n        implicitSwapSecond"
        ).replace(
            "    ReDim implicitOverlayArray(0 To 2)",
            "    Dim implicitOverlayArray() As Integer\n    ReDim implicitOverlayArray(0 To 2)"
        ).replace(
            "ReDim Shared _\n    implicitSharedOverlay( _\n        0 To 2)",
            "ReDim Shared _\n    implicitSharedOverlay( _\n        0 To 2) As Integer"
        );
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            exportSemanticExpressions: true,
            exportSemanticBindings: true,
            overlays: new Map([[filePath, refactoredText]])
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "the explicit local before the continued LET should compile cleanly in the unsaved overlay");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
        assert.equal(fs.readFileSync(filePath).equals(original), true,
            "native analysis and refactoring checks must not write the unsaved overlay to disk");
    }
});

test("stock semantic sidecar reports an implicit compound-assignment target", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Sub CompoundImplicitProbe()",
        "    implicitCompoundValue _",
        "        += 1",
        "    Print implicitCompoundValue",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const target = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitCompoundValue")
        })).result;
        assert.equal(target.compilerStorageClass, "local");
        assert.equal(target.compilerStorageTypeFacts?.storageType?.primitive, "integer");

        const line = text.split("\n").findIndex((sourceLine) => sourceLine.includes("implicitCompoundValue"));
        const lineText = text.split("\n")[line];
        const inlays = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line, character: 0 },
            end: { line, character: lineText.length },
            parameterHints: false
        })).result;
        assert.deepEqual(inlays.implicitVariables?.map((hint) => [
            hint.position.line, hint.position.character, hint.storageType.primitive
        ]), [[line, lineText.indexOf("implicitCompoundValue") + "implicitCompoundValue".length, "integer"]]);
        const outlineVariables = (await worker.query(reply.snapshotId, "compilerSidecarOutlineImplicitVariables", input)).result;
        assert.deepEqual(outlineVariables.map((variable) => [
            variable.name, variable.line, variable.storageClass, variable.storageType.primitive
        ]), [["implicitCompoundValue", line, "local", "integer"]],
        "cached Outline and completion records should retain the same compiler-created compound target");

        fs.writeFileSync(filePath, text.replace(
            "    implicitCompoundValue _\n        += 1",
            "    Dim implicitCompoundValue As Integer\n    implicitCompoundValue _\n        += 1"
        ));
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "declaring the compiler-created compound target before its update should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar reports implicit SWAP targets", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Sub SwapImplicitProbe()",
        "    Dim declaredSwapFirst As Integer, declaredSwapSecond As Integer",
        "    Swap declaredSwapFirst, declaredSwapSecond",
        "    Swap implicitSwapFirst, _",
        "        implicitSwapSecond",
        "    Print implicitSwapFirst, implicitSwapSecond",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        for (const name of ["implicitSwapFirst", "implicitSwapSecond"]) {
            const hover = (await worker.query(reply.snapshotId, "hover", {
                ...input,
                position: pointAt(text, name)
            })).result;
            assert.equal(hover.compilerStorageClass, "local");
            assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        }
        const line = text.split("\n").findIndex((sourceLine) => sourceLine.includes("Swap implicitSwapFirst"));
        const lineText = text.split("\n")[line];
        const inlays = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 0, character: 0 },
            end: { line: text.split("\n").length - 1, character: 0 },
            parameterHints: false
        })).result;
        assert.deepEqual(inlays.implicitVariables?.map((hint) => [
            hint.position.line, hint.position.character, hint.storageType.primitive
        ]), [
            [line, lineText.indexOf("implicitSwapFirst") + "implicitSwapFirst".length, "integer"],
            [line + 1, text.split("\n")[line + 1].indexOf("implicitSwapSecond") + "implicitSwapSecond".length, "integer"]
        ], "new SWAP destinations should receive type inlays while existing variables do not");
        const outlineVariables = (await worker.query(reply.snapshotId, "compilerSidecarOutlineImplicitVariables", input)).result;
        assert.deepEqual(outlineVariables.map((variable) => [
            variable.name, variable.line, variable.storageClass, variable.storageType.primitive
        ]), [
            ["implicitSwapFirst", line, "local", "integer"],
            ["implicitSwapSecond", line + 1, "local", "integer"]
        ]);

        fs.writeFileSync(filePath, text.replace(
            "    Swap implicitSwapFirst, _\n        implicitSwapSecond",
            "    Dim implicitSwapFirst As Integer\n    Dim implicitSwapSecond As Integer\n    Swap implicitSwapFirst, implicitSwapSecond"
        ));
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "declaring SWAP targets before the statement should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar reports implicit LSET and RSET destinations", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "DefStr I",
        "Sub ImplicitStringWriteProbe()",
        "    LSet _",
        '        implicitLeftText = "left"',
        "    RSet _",
        '        implicitRightText = "right"',
        "    Print implicitLeftText, implicitRightText",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        for (const name of ["implicitLeftText", "implicitRightText"]) {
            const hover = (await worker.query(reply.snapshotId, "hover", {
                ...input,
                position: pointAt(text, name)
            })).result;
            assert.equal(hover.compilerStorageClass, "local", `${name} should be a compiler-created local`);
            assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "string",
                `${name} should carry its compiler-selected string type`);
        }
        const inlays = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 0, character: 0 },
            end: { line: text.split("\n").length - 1, character: 0 },
            parameterHints: false
        })).result;
        assert.deepEqual(inlays.implicitVariables?.map((hint) => [
            hint.position.line, hint.position.character, hint.storageType.primitive
        ]), [
            [3, text.split("\n")[3].indexOf("implicitLeftText") + "implicitLeftText".length, "string"],
            [5, text.split("\n")[5].indexOf("implicitRightText") + "implicitRightText".length, "string"]
        ]);
        const outlineVariables = (await worker.query(reply.snapshotId, "compilerSidecarOutlineImplicitVariables", input)).result;
        assert.deepEqual(outlineVariables.map((variable) => [
            variable.name, variable.line, variable.storageClass, variable.storageType.primitive
        ]), [[
            "implicitLeftText", 3, "local", "string"
        ], [
            "implicitRightText", 5, "local", "string"
        ]]);

        fs.writeFileSync(filePath, text.replace(
            '    LSet _\n        implicitLeftText = "left"',
            '    Dim implicitLeftText As String\n    LSet _\n        implicitLeftText = "left"'
        ).replace(
            '    RSet _\n        implicitRightText = "right"',
            '    Dim implicitRightText As String\n    RSet _\n        implicitRightText = "right"'
        ));
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "explicit string declarations before LSET/RSET targets should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar reports an implicit GET destination", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Sub ImplicitGetProbe()",
        "    Get #1, , implicitGetValue",
        "    Dim existingGetValue As Integer",
        "    Get #1, , existingGetValue",
        "    Print implicitGetValue",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitGetValue")
        })).result;
        assert.equal(hover.compilerStorageClass, "local");
        assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        const line = text.split("\n").findIndex((sourceLine) => sourceLine.includes("Get #1"));
        const lineText = text.split("\n")[line];
        const hints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line, character: 0 },
            end: { line, character: lineText.length },
            parameterHints: false
        })).result;
        assert.deepEqual(hints.implicitVariables?.map((hint) => [
            hint.position.line, hint.position.character, hint.storageType.primitive
        ]), [[line, lineText.indexOf("implicitGetValue") + "implicitGetValue".length, "integer"]]);
        const outlineVariables = (await worker.query(reply.snapshotId, "compilerSidecarOutlineImplicitVariables", input)).result;
        assert.deepEqual(outlineVariables.map((variable) => [
            variable.name, variable.line, variable.storageClass, variable.storageType.primitive
        ]), [["implicitGetValue", line, "local", "integer"]]);

        fs.writeFileSync(filePath, text.replace(
            "    Get #1, , implicitGetValue",
            "    Dim implicitGetValue As Integer\n    Get #1, , implicitGetValue"
        ));
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "declaring the GET destination with its selected type should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar reports the type of an implicitly declared REDIM array", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const compilerPath = process.env.FBC_EXECUTABLE || options.compilerPath;
    const text = [
        "Sub RedimImplicitProbe()",
        "    ReDim _",
        "        implicitArray(0 To 2)",
        "    Dim existingArray() As Long",
        "    ReDim existingArray(0 To 2)",
        "    ReDim explicitlyTypedArray(0 To 2) As Double",
        "    ReDim suffixTypedArray%(0 To 2)",
        "    Print implicitArray(0), existingArray(0), explicitlyTypedArray(0), suffixTypedArray%(0)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerPath,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), [],
        "the REDIM declaration should be accepted without compiler errors");
    try {
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitArray")
        })).result;
        assert.equal(hover.compilerStorageClass, "local");
        assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        const existingPosition = pointAt(text, "ReDim existingArray");
        existingPosition.character += "ReDim ".length;
        const existingHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: existingPosition
        })).result;
        assert.equal(Boolean(existingHover.compilerStorageClass), false,
            "a REDIM reference to an already declared array must not look like a new local declaration");
        assert.equal(Boolean(existingHover.compilerStorageTypeFacts), false,
            "an existing-array resize must not expose declaration-site storage facts");
        const implicitArrayLine = text.split("\n").findIndex((line) => line.includes("implicitArray(0 To 2)"));
        const implicitArraySource = text.split("\n")[implicitArrayLine];
        const implicitArrayStart = implicitArraySource.indexOf("implicitArray");
        const existingArrayLine = text.split("\n").findIndex((line) => line.includes("ReDim existingArray"));
        const existingArraySource = text.split("\n")[existingArrayLine];
        const existingArrayStart = existingArraySource.indexOf("existingArray");
        const outlineFacts = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: implicitArrayLine,
                startColumn: implicitArrayStart,
                endColumn: implicitArrayStart + "implicitArray".length
            }, {
                index: 1,
                line: existingArrayLine,
                startColumn: existingArrayStart,
                endColumn: existingArrayStart + "existingArray".length
            }]
        })).result;
        assert.deepEqual(outlineFacts.map((fact) => [
            fact.index, fact.compilerFacts.storageType.primitive, fact.compilerFacts.compilerStorageClass
        ]), [
            [0, "integer", "local"]
        ], "only the newly declared REDIM array should have exact Outline storage facts");
        const inlays = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 0, character: 0 },
            end: { line: text.split("\n").length - 1, character: 0 },
            parameterHints: false
        })).result;
        assert.deepEqual(inlays.implicitDeclarations?.map((hint) => [
            hint.position.line, hint.storageType.primitive
        ]), [[implicitArrayLine, "integer"]],
        "only the newly declared untyped REDIM array should receive the compiler-selected type inlay");

        const refactoredText = text.replace(
            "    ReDim _\n        implicitArray(0 To 2)",
            "    Dim implicitArray() As Integer\n    ReDim _\n        implicitArray(0 To 2)"
        );
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "the explicit dynamic-array declaration offered by the refactor should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar distinguishes a first REDIM PRESERVE declaration", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Sub PreserveImplicitProbe()",
        "    ReDim Preserve _",
        "        implicitPreservedArray(0 To 2)",
        "    Print implicitPreservedArray(0)",
        "    Dim existingPreservedArray() As Long",
        "    ReDim Preserve existingPreservedArray(0 To 3)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const implicitHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitPreservedArray")
        })).result;
        assert.equal(implicitHover.compilerStorageClass, "local");
        assert.equal(implicitHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        const existingPosition = pointAt(text, "ReDim Preserve existingPreservedArray");
        existingPosition.character += "ReDim Preserve ".length;
        const existingHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: existingPosition
        })).result;
        assert.equal(Boolean(existingHover.compilerStorageClass), false);
        assert.equal(Boolean(existingHover.compilerStorageTypeFacts), false);
        const implicitLine = text.split("\n").findIndex((line) => line.includes("implicitPreservedArray"));
        const existingLine = text.split("\n").findIndex((line) => line.includes("ReDim Preserve existingPreservedArray"));
        const implicitSourceLine = text.split("\n")[implicitLine];
        const existingSourceLine = text.split("\n")[existingLine];
        const outlineFacts = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: implicitLine,
                startColumn: implicitSourceLine.indexOf("implicitPreservedArray"),
                endColumn: implicitSourceLine.indexOf("implicitPreservedArray") + "implicitPreservedArray".length
            }, {
                index: 1,
                line: existingLine,
                startColumn: existingSourceLine.indexOf("existingPreservedArray"),
                endColumn: existingSourceLine.indexOf("existingPreservedArray") + "existingPreservedArray".length
            }]
        })).result;
        assert.deepEqual(outlineFacts.map((fact) => [
            fact.index, fact.compilerFacts.storageType.primitive, fact.compilerFacts.compilerStorageClass
        ]), [[0, "integer", "local"]],
        "only the first PRESERVE declaration should receive compiler storage facts");
        const inlays = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 0, character: 0 },
            end: { line: text.split("\n").length - 1, character: 0 },
            parameterHints: false
        })).result;
        assert.deepEqual(inlays.implicitDeclarations?.map((hint) => [
            hint.position.line, hint.storageType.primitive
        ]), [[implicitLine, "integer"]],
        "only the first PRESERVE declaration should receive the compiler-selected array type");
        assert.equal(inlays.implicitDeclarations?.some((hint) => hint.position.line === existingLine), false);

        const refactoredText = text.replace(
            "    ReDim Preserve _\n        implicitPreservedArray(0 To 2)",
            "    Dim implicitPreservedArray() As Integer\n    ReDim Preserve _\n        implicitPreservedArray(0 To 2)"
        );
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "a typed dynamic-array declaration before the first PRESERVE should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar reports a module-scope REDIM SHARED array", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "ReDim Shared _",
        "    implicitSharedArray( _",
        "        0 To 2)",
        "ReDim Preserve implicitSharedArray(0 To 3)",
        "Print implicitSharedArray(0)",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    assert.deepEqual(reply.diagnostics.map((diagnostic) => diagnostic.message), []);
    try {
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitSharedArray")
        })).result;
        assert.equal(hover.compilerStorageClass, "static");
        assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        const declarationLine = text.split("\n").findIndex((line) => line.includes("implicitSharedArray"));
        const startColumn = text.split("\n")[declarationLine].indexOf("implicitSharedArray");
        assert.deepEqual(hover.compilerStorageTypeDeclarationRange, {
            line: declarationLine,
            startColumn,
            endColumn: startColumn + "implicitSharedArray".length
        });
        const existingPosition = pointAt(text, "ReDim Preserve implicitSharedArray");
        existingPosition.character += "ReDim Preserve ".length;
        const existingHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: existingPosition
        })).result;
        assert.equal(Boolean(existingHover.compilerStorageClass), false);
        assert.equal(Boolean(existingHover.compilerStorageTypeFacts), false);

        const refactoredText = text.replace(
            "ReDim Shared _\n    implicitSharedArray( _\n        0 To 2)",
            "ReDim Shared _\n    implicitSharedArray( _\n        0 To 2) As Integer"
        );
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "adding the compiler-selected type to module-scope REDIM SHARED should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar preserves compound-expression operands through lowering", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Const unitValue As Long = 1",
        "Function ReadIndex() As Integer",
        "    Return 0",
        "End Function",
        "Sub Review(ByVal inputValue As Long, ByVal realValue As Double)",
        "    Dim resultValue As Long",
        "    Dim values(0 To 1) As Long",
        "    resultValue \\= unitValue",
        "    resultValue Mod= unitValue",
        "    resultValue += inputValue",
        "    resultValue *= realValue",
        "    values(ReadIndex()) Mod= unitValue",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const probe = (operator, expectedCode, expectedRight, expectedResult = "Integer") => {
            const position = pointAt(text, operator);
            return worker.query(reply.snapshotId, "hover", { ...input, position }).then(({ result }) => {
                const assignment = result.assignmentInput;
                assert.ok(assignment, `FBC should provide compound assignment facts for ${operator}`);
                assert.equal(assignment.operatorKind, "builtin");
                assert.equal(assignment.operatorCode, expectedCode);
                assert.equal(assignment.rightTypeName.toLowerCase(), expectedRight.toLowerCase());
                assert.equal(assignment.targetTypeName.toLowerCase(), "long");
                assert.equal(assignment.resultTypeName.toLowerCase(), expectedResult.toLowerCase());
            });
        };

        await probe("\\=", "integer-divide", "long", "integer");
        await probe("Mod=", "modulo", "long", "integer");
        await probe("+=", "add", "long");
        await probe("*=", "multiply", "double", "double");
        const indexedLine = text.split("\n").find((line) => line.includes("values(ReadIndex())"));
        const indexedLineNumber = text.split("\n").indexOf(indexedLine);
        const indexedOperatorColumn = indexedLine.indexOf("Mod=");
        const indexed = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: { line: indexedLineNumber, character: indexedOperatorColumn + 1 }
        })).result.assignmentInput;
        assert.ok(indexed, "FBC should preserve compound inputs when the lvalue contains an indexed call");
        assert.equal(indexed.operatorCode, "modulo");
        assert.equal(indexed.leftTypeName.toLowerCase(), "long");
        assert.equal(indexed.rightTypeName.toLowerCase(), "long");
        assert.equal(indexed.resultTypeName.toLowerCase(), "integer");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar navigation follows compiler bindings into included headers", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const headerPath = path.join(path.dirname(filePath), "navigation.bi");
    const headerText = "Dim Shared navigationHeaderValue As Long\n";
    const headerColumn = headerText.indexOf("navigationHeaderValue");
    const text = [
        '#include "navigation.bi"',
        "Sub HeaderNavigationProbe()",
        '    Print "é"; navigationHeaderValue',
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(headerPath, headerText);
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const referencePosition = pointAt(text, "navigationHeaderValue");
        const definitions = (await worker.query(reply.snapshotId, "definition", {
            ...input,
            position: referencePosition
        })).result;
        assert.deepEqual(definitions.map((entry) => [entry.uri.fsPath, entry.name,
            entry.declaration.line, entry.declaration.startColumn, entry.declaration.endColumn]), [[
            headerPath, "navigationHeaderValue", 0, headerColumn,
            headerColumn + "navigationHeaderValue".length
        ]], "the compiler's binding should navigate from the root source into the declaration header");

        const references = (await worker.query(reply.snapshotId, "references", {
            ...input,
            position: referencePosition,
            includeDeclaration: true
        })).result;
        assert.deepEqual(references.map((entry) => [entry.uri.fsPath, entry.occurrence.line,
            entry.occurrence.startColumn, entry.occurrence.endColumn]), [
            [headerPath, 0, headerColumn, headerColumn + "navigationHeaderValue".length],
            [filePath, referencePosition.line, referencePosition.character,
                referencePosition.character + "navigationHeaderValue".length]
        ], "the exact sidecar references should span the include declaration and root use");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar navigates numeric label bindings", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = "10 Print 1\nGoto 10\n";
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "qb"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const declarationPosition = pointAt(text, "10");
        const referencePosition = { line: 1, character: 5 };
        const definitions = (await worker.query(reply.snapshotId, "definition", {
            ...input,
            position: declarationPosition
        })).result;
        const references = (await worker.query(reply.snapshotId, "references", {
            ...input,
            position: referencePosition,
            includeDeclaration: true
        })).result;
        const highlights = (await worker.query(reply.snapshotId, "highlights", {
            ...input,
            position: declarationPosition
        })).result;

        assert.deepEqual(definitions.map((entry) => [entry.declaration.type, entry.declaration.line,
            entry.declaration.startColumn, entry.declaration.endColumn]), [["label", 0, 0, 2]]);
        assert.deepEqual(references.map((entry) => [entry.occurrence.line,
            entry.occurrence.startColumn, entry.occurrence.endColumn]), [[0, 0, 2], [1, 5, 7]]);
        assert.deepEqual(highlights.map((entry) => [entry.occurrence.line,
            entry.occurrence.startColumn, entry.occurrence.endColumn]), [[0, 0, 2], [1, 5, 7]]);
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar expands its macro graph only for compiler-backed macro navigation", native, async (t) => {
    const { service, document, filePath, values } = remoteFixture(t, true);
    values["analysis.compilerPath"] = "";
    values["compiler.path"] = process.env.FBC_EDITOR_EXECUTABLE;
    const text = [
        "#define SidecarNavigationValue 42",
        "Print SidecarNavigationValue",
        "#undef SidecarNavigationValue",
        "#define SidecarNavigationValue 43",
        "Print SidecarNavigationValue",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const model = await service.getModelForEditor(document, null, false, true, true);
    assert.equal(model?.semanticSidecarOnly, true);
    assert.equal(model?.semanticMacroBindingsAvailable, true,
        "macro navigation should publish a dedicated, noncompact binding snapshot");

    const usePosition = {
        line: 1,
        character: text.split("\n")[1].indexOf("SidecarNavigationValue")
    };
    const definitions = await model.query("definition", document.uri, { position: usePosition });
    const references = await model.query("references", document.uri, {
        position: usePosition,
        includeDeclaration: true
    });

    assert.deepEqual(definitions.map((entry) => [entry.name, entry.uri.fsPath,
        entry.declaration.line, entry.declaration.startColumn, entry.declaration.endColumn]), [[
        "SidecarNavigationValue", filePath, 0, 8, 8 + "SidecarNavigationValue".length
    ]]);
    assert.deepEqual(references.map((entry) => [entry.occurrence.line,
        entry.occurrence.startColumn, entry.occurrence.endColumn]), [
        [0, 8, 8 + "SidecarNavigationValue".length],
        [1, 6, 6 + "SidecarNavigationValue".length],
        [2, 7, 7 + "SidecarNavigationValue".length]
    ]);
});

test("stock semantic sidecar binds compiler-selected conditional macro probes", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "#define SidecarConditionalProbe 1",
        "#if defined(SidecarConditionalProbe)",
        "Print 1",
        "#endif",
        "#ifdef SidecarConditionalProbe",
        "Print 2",
        "#endif",
        "#if 0",
        "Print 0",
        "#elseifdef SidecarConditionalProbe",
        "Print 3",
        "#endif",
        "#ifndef MissingSidecarConditionalProbe",
        "Print 4",
        "#endif",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const lines = text.split("\n");
        const positionAt = (line, spelling) => ({ line, character: lines[line].indexOf(spelling) });
        const expectedReferences = [
            [0, 8, 8 + "SidecarConditionalProbe".length],
            [1, 12, 12 + "SidecarConditionalProbe".length],
            [4, 7, 7 + "SidecarConditionalProbe".length],
            [9, 11, 11 + "SidecarConditionalProbe".length]
        ];

        for (const [line, spelling] of [
            [1, "SidecarConditionalProbe"],
            [4, "SidecarConditionalProbe"],
            [9, "SidecarConditionalProbe"]
        ]) {
            const position = positionAt(line, spelling);
            const definitions = (await worker.query(reply.snapshotId, "definition", {
                ...input, position
            })).result;
            const references = (await worker.query(reply.snapshotId, "references", {
                ...input,
                position,
                includeDeclaration: true
            })).result;
            const hover = (await worker.query(reply.snapshotId, "hover", {
                ...input, position
            })).result;

            assert.deepEqual(definitions.map((entry) => [entry.declaration.line,
                entry.declaration.startColumn, entry.declaration.endColumn]), [[
                0, 8, 8 + "SidecarConditionalProbe".length
            ]]);
            assert.equal(hover.definedNameProbe?.spelling, "SidecarConditionalProbe");
            assert.deepEqual(references.map((entry) => [entry.occurrence.line,
                entry.occurrence.startColumn, entry.occurrence.endColumn]), expectedReferences);
        }

        const absentPosition = positionAt(12, "MissingSidecarConditionalProbe");
        assert.deepEqual((await worker.query(reply.snapshotId, "definition", {
            ...input, position: absentPosition
        })).result, [], "an absent #ifndef name must not navigate to a later declaration");
        assert.deepEqual((await worker.query(reply.snapshotId, "references", {
            ...input, position: absentPosition, includeDeclaration: true
        })).result, [], "an absent #ifndef name must not invent a reference binding");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar maps qualified conditional probes to the selected final identifier", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "namespace SidecarQualifiedProbe",
        "    const QualifiedValue = 1",
        "end namespace",
        "#if defined(SidecarQualifiedProbe. _",
        "    QualifiedValue)",
        "Print SidecarQualifiedProbe.QualifiedValue",
        "#endif",
        "#if defined(SidecarQualifiedProbe.QualifiedValue)",
        "Print SidecarQualifiedProbe.QualifiedValue",
        "#endif",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const lines = text.split("\n");
        const queryStart = lines[4].lastIndexOf("QualifiedValue");
        const useStart = lines[5].lastIndexOf("QualifiedValue");
        const secondQueryStart = lines[7].lastIndexOf("QualifiedValue");
        const secondUseStart = lines[8].lastIndexOf("QualifiedValue");
        const position = { line: 4, character: queryStart + 1 };
        const definitions = (await worker.query(reply.snapshotId, "definition", {
            ...input, position
        })).result;
        const references = (await worker.query(reply.snapshotId, "references", {
            ...input, position, includeDeclaration: true
        })).result;
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input, position
        })).result;
        const conditionStartHover = (await worker.query(reply.snapshotId, "hover", {
            ...input, position: { line: 3, character: 4 }
        })).result;

        assert.deepEqual(definitions.map((entry) => [entry.declaration.line,
            entry.declaration.startColumn, entry.declaration.endColumn]), [[1, 10, 24]]);
        assert.equal(hover.definedNameProbe?.spelling, "SidecarQualifiedProbe.QualifiedValue");
        assert.deepEqual(hover.preprocessorDecision, {
            directive: "if", evaluation: "evaluated", result: 1, selected: true
        });
        assert.deepEqual(conditionStartHover.preprocessorDecision, hover.preprocessorDecision,
            "the compiler-selected condition should be available from its opening line and continued operand");
        assert.deepEqual(references.map((entry) => [entry.occurrence.line,
            entry.occurrence.startColumn, entry.occurrence.endColumn]), [
            [1, 10, 24],
            [4, queryStart, queryStart + "QualifiedValue".length],
            [5, useStart, useStart + "QualifiedValue".length],
            [7, secondQueryStart, secondQueryStart + "QualifiedValue".length],
            [8, secondUseStart, secondUseStart + "QualifiedValue".length]
        ]);
        const continuationHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: { line: 3, character: lines[3].lastIndexOf("SidecarQualifiedProbe") + 1 }
        })).result;
        assert.equal(continuationHover.definedNameProbe?.spelling, "SidecarQualifiedProbe.QualifiedValue");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar Signature Help uses the compiler-selected macro definition", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "#define SidecarSignatureMacro(oldValue) oldValue",
        "#undef SidecarSignatureMacro",
        "#define SidecarSignatureMacro(firstValue, secondValue) firstValue",
        "Print SidecarSignatureMacro(1, 2)",
        "#undef SidecarSignatureMacro",
        "#define SidecarSignatureMacro(finalValue) finalValue",
        "Print SidecarSignatureMacro(3)",
        "#define SidecarVariadicMacro(firstValue, restValues...) firstValue",
        "Print SidecarVariadicMacro(1, 2, 3)",
        "#define SidecarObjectMacro 42",
        "Print SidecarObjectMacro",
        "#macro SidecarBlockMacro(blockValue)",
        "    Print blockValue",
        "#endmacro",
        "SidecarBlockMacro(7)",
        "#define SidecarNestedInner(innerValue) innerValue",
        "#define SidecarNestedOuter(outerValue) outerValue",
        "Print SidecarNestedOuter(SidecarNestedInner(9))",
        "#define SidecarEvaluationMacro(conditionValue, alternateValue) conditionValue",
        "#if SidecarEvaluationMacro(1, 2)",
        "    Print 3",
        "#endif",
        "#assert SidecarEvaluationMacro(3, 4)",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true,
        compactSemanticMacros: false
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const lines = text.split("\n");
        const calls = [
            {
                line: 3,
                signature: "SidecarSignatureMacro(firstValue, secondValue)",
                parameters: ["firstValue", "secondValue"],
                sourceDefinition: lines[2]
            },
            {
                line: 6,
                signature: "SidecarSignatureMacro(finalValue)",
                parameters: ["finalValue"],
                sourceDefinition: lines[5]
            },
            {
                line: 8,
                signature: "SidecarVariadicMacro(firstValue, restValues...)",
                parameters: ["firstValue", "restValues..."],
                sourceDefinition: lines[7]
            },
            {
                line: 14,
                signature: "SidecarBlockMacro(blockValue)",
                parameters: ["blockValue"],
                sourceDefinition: lines.slice(11, 14).join("\n")
            },
            {
                line: 17,
                signature: "SidecarNestedOuter(outerValue)",
                parameters: ["outerValue"],
                sourceDefinition: lines[16]
            },
            {
                line: 17,
                signature: "SidecarNestedInner(innerValue)",
                parameters: ["innerValue"],
                sourceDefinition: lines[15]
            }
        ];
        for (const call of calls) {
            const callName = call.signature.split("(")[0];
            const position = {
                line: call.line,
                character: lines[call.line].indexOf(`${callName}(`) + callName.length + 1
            };
            const result = (await worker.query(reply.snapshotId, "signature", {
                ...input, position
            })).result;
            const hoverPosition = {
                line: call.line,
                character: lines[call.line].indexOf(callName) + 1
            };
            const hover = (await worker.query(reply.snapshotId, "hover", {
                ...input, position: hoverPosition
            })).result;
            assert.equal(result.macroSignature?.signature, call.signature);
            assert.deepEqual(result.macroSignature.parameters.map((parameter) => parameter.label), call.parameters);
            assert.equal(result.macroSignature.sourceDefinition, call.sourceDefinition);
            assert.equal(hover.macroSignature?.signature, call.signature);
            assert.equal(hover.macroSignature?.sourceDefinition, call.sourceDefinition);
            if ([3, 6, 8, 14, 17].includes(call.line)) {
                const line = lines[call.line];
                const hints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
                    ...input,
                    position: { line: call.line, character: 0 },
                    end: { line: call.line, character: line.length },
                    parameterHints: true
                })).result;
                const expectedNames = call.line === 17 ? ["outerValue", "innerValue"]
                    : call.line === 3 ? ["firstValue", "secondValue"]
                    : call.line === 6 ? ["finalValue"]
                        : call.line === 14 ? ["blockValue"] : ["firstValue"];
                assert.deepEqual(hints.parameters.map((hint) => hint.parameterName), expectedNames,
                    "macro parameter hints should use the compiler-selected definition and omit variadic labels");
            }
        }
        const objectHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: { line: 10, character: lines[10].indexOf("SidecarObjectMacro") + 1 }
        })).result;
        assert.equal(objectHover.macroSignature?.signature, "SidecarObjectMacro");
        assert.equal(objectHover.macroSignature?.sourceDefinition, lines[9]);
        const evaluationHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 19, character: 0 },
            end: { line: 19, character: lines[19].length },
            parameterHints: true
        })).result;
        assert.deepEqual(evaluationHints.parameters.map((hint) => hint.parameterName),
            ["conditionValue", "alternateValue"],
            "physical macro calls in #if evaluation should use the compiler-selected formal names");
        const assertionHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: 22, character: 0 },
            end: { line: 22, character: lines[22].length },
            parameterHints: true
        })).result;
        assert.deepEqual(assertionHints.parameters.map((hint) => hint.parameterName),
            ["conditionValue", "alternateValue"],
            "physical macro calls in #assert evaluation should use the compiler-selected formal names");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar navigation separates declarations from implementations", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Declare Function BoundNavigationValue Overload(ByVal value As Long) As Long",
        "Declare Function BoundNavigationValue Overload(ByVal value As Double) As Long",
        "Function BoundNavigationValue Overload(ByVal value As Long) As Long",
        "    Return value",
        "End Function",
        "Function BoundNavigationValue Overload(ByVal value As Double) As Long",
        "    Return CInt(value)",
        "End Function",
        "Sub NavigationCaller()",
        "    Print BoundNavigationValue(2)",
        "    Print BoundNavigationValue(2.5)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const longPrototypeLine = 0;
        const doublePrototypeLine = 1;
        const longImplementationLine = 2;
        const doubleImplementationLine = 5;
        for (const [call, prototypeLine, implementationLine, parameterType] of [
            ["BoundNavigationValue(2)", longPrototypeLine, longImplementationLine, "Long"],
            ["BoundNavigationValue(2.5)", doublePrototypeLine, doubleImplementationLine, "Double"]
        ]) {
            const position = pointAt(text, call);
            const definitions = (await worker.query(reply.snapshotId, "definition", {
                ...input, position
            })).result;
            const declarations = (await worker.query(reply.snapshotId, "declaration", {
                ...input, position
            })).result;
            const implementations = (await worker.query(reply.snapshotId, "implementation", {
                ...input, position
            })).result;

            assert.deepEqual(definitions.map((entry) => entry.declaration.line), [implementationLine],
                `Go to Definition should select only the ${parameterType} implementation`);
            assert.deepEqual(declarations.map((entry) => entry.declaration.line), [prototypeLine],
                `Go to Declaration should select the ${parameterType} prototype`);
            assert.deepEqual(implementations.map((entry) => entry.declaration.line), [implementationLine],
                `Go to Implementation should select only the ${parameterType} body`);
            assert.match(definitions[0].declaration.signature, new RegExp(`ByVal value As ${parameterType}`, "i"));
            assert.match(declarations[0].declaration.signature, new RegExp(`ByVal value As ${parameterType}`, "i"));
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar maps compiler-accepted header linker directives to hovers", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const libraryPath = "/opt/freebasic/é-sidecar-libs";
    const text = [
        '#inclib "sidecar-test-library"',
        `#libpath "${libraryPath}"`,
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const inclibHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "sidecar-test-library")
        })).result;
        assert.ok(inclibHover.compilerHeaderLibraries?.some((library) =>
            library.kind === "inclib" && library.value === "sidecar-test-library"),
        `FBC should map its accepted #inclib value to the physical directive: ${JSON.stringify(inclibHover)}`);
        const libpathHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, libraryPath, libraryPath.length - 1)
        })).result;
        assert.ok(libpathHover.compilerHeaderLibraries?.some((library) =>
            library.kind === "libpath" && library.value === libraryPath),
        `FBC should map its accepted #libpath value to the physical directive: ${JSON.stringify(libpathHover)}`);
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("current compiler retains normalized 128-bit scalar declarations", { skip: !process.env.FBC_INTEGER128_EXECUTABLE }, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Type Integer128",
        "    memberValue As Long",
        "End Type",
        "Dim ordinaryValue As Integer128",
        "Dim signedWide As Integer<128> = 1",
        "Dim unsignedWide As UInteger<128> = 1",
        "Var inferredWide = signedWide + 1",
        "Var inferredUnsignedWide = unsignedWide + 1",
        "Var inferredPointer = @signedWide",
        "Dim pointerToConst As Const Integer<128> Ptr = @signedWide",
        "Var inferredConstPointer = pointerToConst",
        "Var inferredOrdinary = ordinaryValue",
        "Print SizeOf(signedWide), SizeOf(unsignedWide), SizeOf(inferredWide), ordinaryValue.memberValue",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, compilerPath: process.env.FBC_INTEGER128_EXECUTABLE,
        semanticModelOnly: true, requireSemanticModel: true, exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
    try {
        assert.equal(reply.partial, false);
        assert.equal(reply.semanticSidecarOnly, true);
        for (const [name, primitive] of [["signedWide", "integer128"], ["unsignedWide", "uinteger128"],
            ["inferredWide", "integer128"], ["inferredUnsignedWide", "uinteger128"]]) {
            const hover = (await worker.query(reply.snapshotId, "hover", { ...input,
                position: pointAt(text, name, 1) })).result;
            assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, primitive);
            const facts = hover.compilerStorageTypeFacts;
            assert.equal(facts.storageType.storageBytes, 16);
        }
        const ordinaryHover = (await worker.query(reply.snapshotId, "hover", { ...input,
            position: pointAt(text, "ordinaryValue", 1) })).result;
        assert.equal(ordinaryHover.compilerStorageTypeFacts?.storageType?.primitive, "type",
            "the source identifier Integer128 is not the built-in Integer<128> type");
        const hints = (await worker.query(reply.snapshotId, "compilerTypeInlayHints", { ...input,
            position: { line: 0, character: 0 }, end: { line: text.split("\n").length - 1, character: 0 } })).result;
        for (const [name, typeName] of [["inferredWide", "Integer<128>"], ["inferredUnsignedWide", "UInteger<128>"],
            ["inferredPointer", "Integer<128> ptr"], ["inferredConstPointer", "const Integer<128> ptr"],
            ["inferredOrdinary", "INTEGER128"]]) {
            assert.equal(hints.find((hint) => hint.position.line === pointAt(text, name, 1).line)?.typeName?.toLowerCase(), typeName.toLowerCase(),
                "only a normalized primitive fact may replace the internal 128-bit spelling");
        }
    } finally { worker.releaseModel(reply.snapshotId); }
});

test("current bridge presents source-valid 128-bit inferred types without changing nominal names", {
    skip: !process.env.FBC_INTEGER128_EXECUTABLE || !process.env.FBC_EDITOR_EXECUTABLE
}, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    input.openFiles = [filePath];
    const text = ["Type Integer128", "    value As Long", "End Type", "Dim ordinary As Integer128",
        "Dim signedWide As Integer<128> = 1", "Dim unsignedWide As UInteger<128> = 1",
        "Var inferredWide = signedWide + 1", "Var inferredUnsignedWide = unsignedWide + 1",
        "Dim pointerToConst As Const Integer<128> Ptr = @signedWide", "Var inferredPointer = pointerToConst",
        "Var inferredOrdinary = ordinary",
        "Dim callback As Function(ByVal As Integer<128>, ByVal As Integer128) As UInteger<128>",
        "Var inferredCallback = callback", ""].join("\n");
    const reply = await worker.analyze({ ...options, overlays: new Map([[filePath, text]]),
        exportSemanticExpressions: true, exportSemanticBindings: false }, preparation);
    try {
        assert.equal(reply.partial, false);
        assert.equal(reply.semanticSidecarOnly, false);
        const hints = (await worker.query(reply.snapshotId, "compilerTypeInlayHints", { ...input,
            position: { line: 0, character: 0 }, end: { line: text.split("\n").length - 1, character: 0 } })).result;
        for (const [name, expected] of [["inferredWide", "Integer<128>"], ["inferredUnsignedWide", "UInteger<128>"],
            ["inferredPointer", "const Integer<128> ptr"], ["inferredOrdinary", "INTEGER128"]]) {
            assert.equal(hints.find((hint) => hint.position.line === pointAt(text, name).line)?.typeName?.toLowerCase(), expected.toLowerCase(),
                "native inferred type presentation must retain valid source spellings and nominal identities");
        }
        const callbackHint = hints.find((hint) => hint.position.line === pointAt(text, "inferredCallback").line);
        assert.match(callbackHint?.typeName || "", /^function\(as integer<128>, byval as integer128\) as uinteger<128>$/i,
            "nested primitive types must use width syntax without rewriting the nominal Integer128 parameter");
        const canonical = await worker.analyze({ ...options,
            overlays: new Map([[filePath, `${text}Dim canonicalCallback As ${callbackHint.typeName}\n`]]),
            exportSemanticExpressions: true, exportSemanticBindings: true }, preparation);
        try {
            assert.equal(canonical.partial, false, "FBC must accept its own nested canonical type spelling as source");
        } finally { worker.releaseModel(canonical.snapshotId); }
        assert.equal(fs.readFileSync(filePath, "utf8").includes("signedWide"), false,
            "the editor bridge must obtain these types from the unsaved buffer");
    } finally { worker.releaseModel(reply.snapshotId); }
});

test("stock semantic sidecar exposes compiler storage and declaration-type facts", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Dim storageWidthValue As Long",
        "Dim implicitTypeValue",
        "Dim implicitArrayType(1)",
        "Dim suffixTypeValue%",
        "Dim suffixArrayType%(1)",
        "Static implicitStaticValue",
        "Common implicitCommonValue",
        "Extern implicitExternValue",
        "Const inferredConstantValue = 42",
        "Const inferredConstantPairA = 42, inferredConstantPairB = 1.5",
        "Const suffixConstantValue% = 7",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "storageWidthValue")
        })).result;
        assert.ok(Number.isSafeInteger(hover.compilerStorageTypeFacts?.storageType?.storageBytes) &&
            hover.compilerStorageTypeFacts.storageType.storageBytes > 0,
        `the target storage width should follow the physical variable declaration: ${JSON.stringify(hover)}`);
        assert.equal(hover.compilerStorageTypeFacts.storageType.pointerDepth, 0);
        const implicitHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitTypeValue")
        })).result;
        assert.equal(implicitHover.compilerStorageTypeFacts?.storageType?.primitive, "integer",
            "FBC's default type should be available for an implicit DIM variable declaration");
        assert.equal(implicitHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "implicit",
            "the declaration-type group should confirm that the source omitted AS");
        assert.equal(implicitHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.kind, "dim");
        assert.equal(implicitHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.count, 1,
            "the refactor should receive a complete single-declarator DIM receipt");
        assert.equal(implicitHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.provisional, false);
        const implicitTypeLine = text.split("\n").findIndex((line) => line.includes("implicitTypeValue"));
        const implicitTypeSource = text.split("\n")[implicitTypeLine];
        const implicitTypeStart = implicitTypeSource.indexOf("implicitTypeValue");
        const outlineTypeFacts = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: implicitTypeLine,
                startColumn: implicitTypeStart,
                endColumn: implicitTypeStart + "implicitTypeValue".length
            }]
        })).result;
        assert.equal(outlineTypeFacts[0]?.compilerFacts?.storageType?.primitive, "integer");
        assert.equal(outlineTypeFacts[0]?.compilerFacts?.declarationInputs?.[0]?.writtenType, "implicit");
        const implicitDeclarationHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: implicitTypeLine, character: 0 },
            end: { line: implicitTypeLine, character: implicitTypeSource.length },
            parameterHints: false
        })).result;
        assert.deepEqual(implicitDeclarationHints.implicitDeclarations?.map((hint) => [
            hint.position.line, hint.position.character, hint.storageType.primitive
        ]), [[implicitTypeLine, implicitTypeSource.indexOf("implicitTypeValue") + "implicitTypeValue".length, "integer"]],
        "the stock sidecar should provide the compiler default type even without an initializer expression");
        const implicitArrayHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitArrayType")
        })).result;
        assert.equal(implicitArrayHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        assert.equal(implicitArrayHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "implicit");
        assert.equal(implicitArrayHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.count, 1,
            "one untyped array DIM should carry a complete declaration group for its refactor");
        const suffixHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "suffixTypeValue%")
        })).result;
        assert.equal(suffixHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        assert.equal(suffixHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "suffix");
        assert.equal(suffixHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.kind, "dim");
        assert.equal(suffixHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.count, 1);
        const suffixArrayHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "suffixArrayType%")
        })).result;
        assert.equal(suffixArrayHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        assert.equal(suffixArrayHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "suffix");
        assert.equal(suffixArrayHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.kind, "dim");
        assert.equal(suffixArrayHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.count, 1);
        const staticHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitStaticValue")
        })).result;
        assert.equal(staticHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "implicit");
        assert.equal(staticHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.kind, "static");
        assert.equal(staticHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        const commonHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitCommonValue")
        })).result;
        assert.equal(commonHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "implicit");
        assert.equal(commonHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.kind, "common");
        assert.equal(commonHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        const externHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitExternValue")
        })).result;
        assert.equal(externHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "implicit");
        assert.equal(externHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.kind, "extern");
        assert.equal(externHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        const inferredConstantHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "inferredConstantValue")
        })).result;
        assert.equal(inferredConstantHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "inferred");
        assert.equal(inferredConstantHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.kind, "const");
        assert.equal(inferredConstantHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        const inferredConstantPairHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "inferredConstantPairA")
        })).result;
        assert.equal(inferredConstantPairHover.compilerStorageTypeFacts?.declarationInputs?.length, 1);
        assert.equal(inferredConstantPairHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "inferred");
        assert.equal(inferredConstantPairHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.ordinal, 1);
        assert.equal(inferredConstantPairHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.count, 2);
        assert.equal(inferredConstantPairHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        const suffixConstantHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "suffixConstantValue%")
        })).result;
        assert.equal(suffixConstantHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "suffix");
        assert.equal(suffixConstantHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.kind, "const");
        assert.equal(suffixConstantHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar validates a typed declarator within a multi-name DIM", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const initialText = "Dim firstValue, secondValue\n";
    fs.writeFileSync(filePath, initialText);
    const initialReply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(initialReply.semanticSidecarOnly, true);
    assert.equal(initialReply.partial, false);
    let typedReply = null;
    try {
        const initialHover = (await worker.query(initialReply.snapshotId, "hover", {
            ...input,
            position: pointAt(initialText, "firstValue")
        })).result;
        assert.equal(initialHover.compilerStorageTypeFacts?.declarationInputs?.length, 1);
        assert.equal(initialHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.ordinal, 1);
        assert.equal(initialHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.count, 2);
        assert.equal(initialHover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "implicit");

        const typedText = "Dim firstValue As Integer, secondValue\n";
        fs.writeFileSync(filePath, typedText);
        typedReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        assert.equal(typedReply.partial, false);
        const typedFirst = (await worker.query(typedReply.snapshotId, "hover", {
            ...input,
            position: pointAt(typedText, "firstValue")
        })).result;
        assert.equal(typedFirst.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "as");
        assert.equal(typedFirst.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.count, 2);
        const untouchedSecond = (await worker.query(typedReply.snapshotId, "hover", {
            ...input,
            position: pointAt(typedText, "secondValue")
        })).result;
        assert.equal(untouchedSecond.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "implicit");
        assert.equal(untouchedSecond.compilerStorageTypeFacts?.storageType?.primitive, "integer");
    } finally {
        worker.releaseModel(initialReply.snapshotId);
        if (typedReply?.snapshotId) worker.releaseModel(typedReply.snapshotId);
    }
});

test("stock semantic sidecar maps inferred Var declaration types", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["Var inferredVarValue = 42", "Dim pointee As Long = 1",
        "Dim constPointee As Const Long Ptr = @pointee", "Dim fixedPointer As Long Const Ptr = @pointee",
        "Var inferredConstPointer = constPointee", "Var inferredNestedPointer = @fixedPointer", ""].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "inferredVarValue")
        })).result;
        assert.equal(hover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        assert.equal(hover.compilerStorageTypeFacts?.declarationInputs?.[0]?.writtenType, "inferred");
        assert.equal(hover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.kind, "var");
        assert.equal(hover.compilerStorageTypeFacts?.declarationInputs?.[0]?.group?.count, 1);
        for (const [name, constBits] of [["inferredConstPointer", "01"], ["inferredNestedPointer", "010"]]) {
            const pointerHover = (await worker.query(reply.snapshotId, "hover", { ...input,
                position: pointAt(text, name) })).result;
            assert.equal(pointerHover.compilerStorageTypeFacts?.storageType?.constBits, constBits,
                "inferred pointer refactors need constness at each native dereference level");
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar exposes scalar String initialization facts on declarations", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Dim defaultText As String",
        "Dim explicitText As String = \"Hello\"",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const defaultHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "defaultText")
        })).result;
        assert.equal(defaultHover.compilerStorageTypeFacts?.scalarStringDeclaration?.expression, 0,
            "FBC should confirm default scalar String initialization at the declaration binding");
        const defaultPosition = pointAt(text, "defaultText");
        const defaultOutline = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: defaultPosition.line,
                startColumn: defaultPosition.character,
                endColumn: defaultPosition.character + "defaultText".length
            }]
        })).result;
        assert.equal(defaultOutline[0]?.compilerFacts?.scalarStringDeclaration?.expression, 0,
            "the exact Outline query should retain FBC's default String initialization receipt");
        const explicitHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "explicitText")
        })).result;
        assert.deepEqual(explicitHover.compilerStorageTypeFacts?.scalarStringDeclaration?.initializerValue,
            { kind: "bytes", value: "48656C6C6F" },
        "FBC should preserve the exact constant scalar String initializer");
        const explicitPosition = pointAt(text, "explicitText");
        const explicitOutline = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: explicitPosition.line,
                startColumn: explicitPosition.character,
                endColumn: explicitPosition.character + "explicitText".length
            }]
        })).result;
        assert.deepEqual(explicitOutline[0]?.compilerFacts?.scalarStringDeclaration?.initializerValue,
            { kind: "bytes", value: "48656C6C6F" },
            "the exact Outline query should preserve FBC's constant String payload");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar exposes explicit and implicit enum member values", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Enum SidecarSequence",
        "    firstValue = 10",
        "    nextValue",
        "End Enum",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const explicitHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "firstValue")
        })).result;
        assert.deepEqual(explicitHover.compilerEnumElementFacts, { explicit: true, ordinal: 1 });
        const implicitHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "nextValue")
        })).result;
        assert.deepEqual(implicitHover.compilerEnumElementFacts, { explicit: false, ordinal: 2 });
        const nextValueColumn = text.split("\n")[2].indexOf("nextValue");
        assert.deepEqual(implicitHover.compilerEnumElementRange, {
            line: 2, startColumn: nextValueColumn, endColumn: nextValueColumn + "nextValue".length
        }, "FBC should provide the exact physical enum member token range for the refactor");
        const firstPosition = pointAt(text, "firstValue");
        const nextPosition = pointAt(text, "nextValue");
        const outlineValues = (await worker.query(reply.snapshotId, "compilerSidecarConstantsAtSites", {
            ...input,
            sites: [
                { index: 0, filePath, line: firstPosition.line, startColumn: firstPosition.character,
                    endColumn: firstPosition.character + "firstValue".length },
                { index: 1, filePath, line: nextPosition.line, startColumn: nextPosition.character,
                    endColumn: nextPosition.character + "nextValue".length }
            ]
        })).result;
        assert.deepEqual(outlineValues.map(({ index, kind, value }) => [index, kind, value]), [
            [0, "signed", "10"], [1, "signed", "11"]
        ], "the exact Outline constant query should return FBC's explicit and implicit enum values");
        const outlineOrigin = (await worker.query(reply.snapshotId, "compilerSidecarOutlineFactsAtSites", {
            ...input,
            sites: [{
                index: 0,
                line: nextPosition.line,
                startColumn: nextPosition.character,
                endColumn: nextPosition.character + "nextValue".length
            }]
        })).result;
        assert.deepEqual(outlineOrigin[0]?.compilerFacts?.enumElementInput, { explicit: false, ordinal: 2 },
            "the exact Outline query should retain whether FBC assigned the enum value");
        const implicitValue = await worker.query(reply.snapshotId, "compilerSidecarConstantAt", {
            ...input,
            position: pointAt(text, "nextValue")
        });
        assert.deepEqual(implicitValue.result, { kind: "signed", value: "11" },
            "the stock sidecar should provide the exact value to a safe explicit-value refactor");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native occurrence queries retain module variable access roles", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = ["#define OCCURRENCE_VALUE 42", "Dim sharedValue As Long", "sharedValue = OCCURRENCE_VALUE",
        "sharedValue += 1", "Print sharedValue, OCCURRENCE_VALUE", ""].join("\n");
    fs.writeFileSync(filePath, text);
    for (const semanticModelOnly of [true, false]) {
        const reply = await worker.analyze({ ...options,
            compilerPath: semanticModelOnly ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
            semanticModelOnly, exportSemanticExpressions: true, exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(reply.partial, false);
            const position = pointAt(text, "Print sharedValue", "Print ".length + 2);
            const highlights = (await worker.query(reply.snapshotId, "highlights", { ...input, position })).result;
            assert.deepEqual(highlights.map((entry) => [entry.occurrence.line, entry.accessRole]),
                [[1, undefined], [2, "write"], [3, "read-write"], [4, "read"]], `sidecar=${semanticModelOnly}`);
        } finally {
            worker.releaseModel(reply.snapshotId);
        }
    }
});

test("compiler access roles mark variable writes in semantic tokens", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Extern \"C\"",
        "    Declare Function cProbe Cdecl(ByVal cValue As Long) As Long",
        "    Declare Function cDefaultProbe(ByVal cDefaultCount As Integer) As Integer",
        "End Extern",
        "Extern \"Windows\"",
        "    Declare Function windowsDefaultProbe(ByVal windowsCount As Integer) As Integer",
        "End Extern",
        "Declare Sub managedStringProbe(ByVal value As String)",
        "Declare Function refProbe() ByRef As Integer",
        "'' @deprecated Use the replacement routine.",
        "Declare Sub deprecatedProbe()",
        "deprecatedProbe()",
        "Type BaseSelector Extends Object",
        "    Declare Virtual Function Choose(ByVal value As Long) As Long",
        "End Type",
        "Type DerivedSelector Extends BaseSelector",
        "    Declare Function Choose(ByVal value As Long) As Long",
        "End Type",
        "Type AbstractWidget Extends Object",
        "    Declare Abstract Sub Draw()",
        "End Type",
        "Type FlowLayout",
        "    byteValue As Byte",
        "    Protected:",
        "    fieldValue As Long",
        "    Private:",
        "    flagBits : 3 As UByte",
        "End Type",
        "Dim layoutInstance As FlowLayout",
        "Dim boundsArray(-1 To 4, 1 To 3) As Long",
        "Dim integerArray(0 To 2) As Integer",
        "Sub consumeByRef(ByRef value As Integer)",
        "    Print value",
        "End Sub",
        "Sub consumeDefault(defaultValue As Integer)",
        "    Print defaultValue",
        "End Sub",
        "Sub consumeAnyRank(anyRankValues() As Integer)",
        "End Sub",
        "Sub consumeMatrix(matrixValues(Any, Any) As Integer)",
        "End Sub",
        "Var inferredVar = 42",
        "Dim explicitVar As Integer = 42",
        "Dim defaultText As String",
        "Dim explicitText As String = \"Hello\"",
        "Dim accessValue As Integer",
        "accessValue = 1",
        "accessValue += 2",
        "Print accessValue",
        "consumeByRef(accessValue)",
        "consumeDefault(1)",
        "Dim loopIndex As Integer",
        "For loopIndex = 3 To 1",
        "Next",
        "For loopIndex = 1 To 3",
        "Next",
        "Print layoutInstance.byteValue",
        "Function defaultVisibilityProbe() As Integer",
        "    Return 1",
        "End Function",
        "consumeAnyRank(integerArray())",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        exportSemanticBindings: true,
        exportSemanticExpressions: true
    }, preparation);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics.map((diagnostic) => diagnostic.message)));
    assert.equal(reply.semanticSidecarOnly, false);
    try {
        const semanticTokens = (await worker.query(reply.snapshotId, "semanticTokens", input)).result;
        const tokenRecords = decodeSemanticTokenRecords(semanticTokens);
        const modificationBit = 1 << TOKEN_MODIFIERS.indexOf("modification");
        const deprecatedBit = 1 << TOKEN_MODIFIERS.indexOf("deprecated");
        for (const [spelling, relative, modified] of [
            ["accessValue = 1", 0, true],
            ["accessValue += 2", 0, true],
            ["Print accessValue", "Print ".length, false],
            ["consumeByRef(accessValue)", "consumeByRef(".length, false]
        ]) {
            const position = pointAt(text, spelling, relative);
            const token = tokenRecords.find((record) => record.line === position.line &&
                record.character === position.character && record.length === "accessValue".length);
            assert.ok(token, `semantic tokens should include ${spelling}`);
            assert.equal(Boolean(token.modifiers & modificationBit), modified,
                `${spelling} should ${modified ? "carry" : "not carry"} the compiler-confirmed modification modifier`);
        }
        for (const [spelling, relative] of [
            ["Declare Sub deprecatedProbe", "Declare Sub ".length],
            ["deprecatedProbe()", 0]
        ]) {
            const position = pointAt(text, spelling, relative);
            const token = tokenRecords.find((record) => record.line === position.line && record.character === position.character);
            assert.ok(token && token.modifiers & deprecatedBit,
                `${spelling} should carry FBC's source-documentation deprecated modifier`);
        }
        const ordinaryProbePosition = pointAt(text, "consumeByRef(accessValue)");
        const ordinaryProbeToken = tokenRecords.find((record) => record.line === ordinaryProbePosition.line &&
            record.character === ordinaryProbePosition.character);
        assert.ok(ordinaryProbeToken && !(ordinaryProbeToken.modifiers & deprecatedBit),
            "ordinary procedures must not be marked deprecated without a source tag");
        const outline = (await worker.query(reply.snapshotId, "documentSymbols", input)).result;
        assert.equal(outline.find((symbol) => symbol.name === "deprecatedProbe")?.deprecated, true,
            "FBC documentation should mark the deprecated declaration in Outline data");
        assert.equal(outline.find((symbol) => symbol.name === "consumeByRef")?.deprecated, false,
            "ordinary declarations should remain untagged in Outline data");
        assert.match(outline.find((symbol) => symbol.name === "AbstractWidget")?.detail || "",
            /1 unimplemented abstract member/,
            "Outline details should warn when a type cannot be instantiated yet");
        assert.match(outline.find((symbol) => symbol.name === "DerivedSelector")?.detail || "",
            /extends BaseSelector/i,
            "Outline details should show the compiler-selected base type");
        const derivedTypeHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Type DerivedSelector", "Type ".length)
        })).result;
        assert.equal(derivedTypeHover.entries[0]?.declaration.baseType?.toLowerCase(), "baseselector",
            "the compiler-selected base type should survive the native editor query");
        assert.match(outline.find((symbol) => symbol.name === "boundsArray")?.detail || "",
            /bounds: -1 to 4, 1 to 3/,
            "Outline details should preserve the compiler-selected multidimensional array bounds");
        assert.match(outline.find((symbol) => symbol.name === "boundsArray")?.detail || "",
            /18 elements/,
            "Outline should show an element count only when it agrees with the compiler's fixed bounds");
        assert.match(outline.find((symbol) => symbol.name === "defaultValue")?.detail || "",
            /passing: ByVal/,
            "Outline parameter details should include the compiler-selected scalar passing mode");
        assert.match(outline.find((symbol) => symbol.name === "defaultValue")?.detail || "",
            /passing: ByVal \(keyword omitted\)/,
            "Outline should distinguish an FBC-selected default mode from a written ByVal keyword");
        const explicitByRefParameter = outline.find((symbol) => symbol.name === "value" &&
            /passing: ByRef/.test(symbol.detail || ""));
        assert.ok(explicitByRefParameter, "the explicit ByRef parameter should retain its written passing mode");
        assert.doesNotMatch(explicitByRefParameter.detail,
            /keyword omitted/,
            "written parameter modes should not be marked as compiler defaults");
        assert.match(outline.find((symbol) => symbol.name === "anyRankValues")?.detail || "",
            /passing: ByDesc \(any array rank\)/,
            "Outline parameter details should include the compiler-selected any-rank array mode");
        for (const [spelling, relative, expectedRole] of [
            ["accessValue = 1", 0, "write"],
            ["accessValue += 2", 0, "read-write"],
            ["Print accessValue", "Print ".length, "read"],
            ["consumeByRef(accessValue)", "consumeByRef(".length, "byref"]
        ]) {
            const position = pointAt(text, spelling, relative);
            const highlights = (await worker.query(reply.snapshotId, "highlights", {
                ...input,
                position
            })).result;
            const selected = highlights.find((entry) => entry.occurrence.line === position.line &&
                entry.occurrence.startColumn === position.character);
            assert.equal(selected?.accessRole, expectedRole,
                `${spelling} should retain FBC's access role in document highlights`);
        }
        const valueHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Print accessValue", "Print ".length)
        })).result;
        const storageType = valueHover.entries[0]?.declaration.compilerFacts?.storageType;
        assert.equal(storageType?.primitive, "integer",
            "FBC normalized type facts should follow the source variable into its hover record");
        assert.ok(Number.isSafeInteger(storageType?.storageBytes) && storageType.storageBytes > 0,
            "the compiler-selected target width should be retained without hardcoded type-size guesses");
        const cProbeHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Declare Function cProbe", "Declare Function ".length)
        })).result;
        const cProbeFacts = cProbeHover.entries[0]?.declaration.compilerFacts;
        assert.equal(cProbeFacts?.procedureCallingConvention, "cdecl",
            "the selected procedure calling convention should follow the source declaration identity");
        assert.ok(cProbeFacts.properties.some((property) => property.name === "procedure-linkage" && property.value === "c"),
            "the compiler-selected C linkage should remain available beside the calling convention");
        assert.match(outline.find((symbol) => symbol.name === "cProbe")?.detail || "",
            /ABI: C linkage, cdecl/,
            "Outline should expose the selected foreign linkage and calling convention");
        assert.equal(cProbeFacts.procedureReturnsByReference, false,
            "the compiler should distinguish an ordinary value return from a ByRef return");
        assert.deepEqual(cProbeFacts.procedureAbiPolicyInputs?.map((policy) =>
            [policy.writtenConvention, policy.managedString]), [[true, false]],
        "FBC should retain that CDECL was written and no STRING-based type is in this header");
        const cDefaultHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Declare Function cDefaultProbe", "Declare Function ".length)
        })).result;
        const cDefaultFacts = cDefaultHover.entries[0]?.declaration.compilerFacts;
        assert.equal(cDefaultFacts?.procedureCallingConvention, "cdecl");
        assert.deepEqual(cDefaultFacts?.procedureAbiPolicyInputs?.map((policy) =>
            [policy.writtenConvention, policy.managedString]), [[false, false]],
        "FBC should confirm the default C calling convention and absence of managed STRING types");
        const windowsDefaultHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Declare Function windowsDefaultProbe", "Declare Function ".length)
        })).result;
        const windowsDefaultFacts = windowsDefaultHover.entries[0]?.declaration.compilerFacts;
        assert.ok(["stdcall", "stdcall-ms"].includes(windowsDefaultFacts?.procedureCallingConvention));
        assert.deepEqual(windowsDefaultFacts?.procedureAbiPolicyInputs?.map((policy) =>
            [policy.writtenConvention, policy.managedString]), [[false, false]],
        "FBC should retain the implicit Windows calling convention and unmanaged scalar parameters");
        const managedStringHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Declare Sub managedStringProbe", "Declare Sub ".length)
        })).result;
        const managedStringPolicy = managedStringHover.entries[0]?.declaration.compilerFacts?.procedureAbiPolicyInputs;
        assert.deepEqual(managedStringPolicy?.map((policy) =>
            [policy.writtenConvention, policy.managedString]), [[false, true]],
        "FBC should retain the managed STRING policy even when no calling convention was written");
        const refProbeHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Declare Function refProbe", "Declare Function ".length)
        })).result;
        assert.equal(refProbeHover.entries[0]?.declaration.compilerFacts?.procedureReturnsByReference, true,
            "the compiler-selected ByRef return mode should follow the source declaration identity");
        assert.match(outline.find((symbol) => symbol.name === "refProbe")?.detail || "",
            /ByRef return/,
            "Outline should expose compiler-confirmed ByRef returns");
        const overrideHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Declare Function Choose(ByVal value As Long) As Long",
                "Declare Function ".length)
        })).result;
        assert.equal(overrideHover.entries[0]?.declaration.compilerFacts?.overriddenProcedure?.qualifiedName?.toLowerCase(),
            "baseselector.choose",
            "FBC's override edge should resolve to the exact base method for the derived declaration");
        assert.equal(overrideHover.entries[0]?.declaration.compilerFacts?.properties
            .find((property) => property.name === "written-override")?.value, "0",
        "FBC should distinguish an implicit override from a written Override marker");
        assert.ok(outline.some((symbol) => symbol.name === "Choose" &&
            /overrides baseselector\.choose/i.test(symbol.detail || "")),
        "the compiler-backed Outline should show the selected base method for an override");
        const abstractTypeHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Type AbstractWidget", "Type ".length)
        })).result;
        assert.equal(abstractTypeHover.entries[0]?.declaration.compilerFacts?.abstractMemberCount, 1,
            "FBC should export the unresolved abstract-member count for a type");
        const parameterHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "defaultValue As Integer")
        })).result;
        const parameterEntry = parameterHover.entries[0];
        assert.equal(parameterEntry?.declaration.compilerFacts?.parameterPassing?.mode, "byval",
            "the compiler should confirm FreeBASIC's default parameter mode even when it is not written");
        assert.equal(parameterEntry?.declaration.compilerFacts?.properties
            .find((property) => property.name === "formal-written-mode")?.value, "0",
        "the compiler should distinguish its default mode from a written ByVal or ByRef keyword");
        const defaultSignature = (await worker.query(reply.snapshotId, "signature", {
            ...input,
            position: pointAt(text, "consumeDefault(1)", "consumeDefault(".length)
        })).result;
        assert.equal(defaultSignature.entries[0]?.declaration.parameters[0]?.compilerParameterPassing?.modeWritten, false,
            "Signature Help should retain that FBC selected its default mode because no keyword was written");
        const byRefCallLine = text.split("\n").findIndex((line) => line.includes("consumeByRef(accessValue)"));
        const byRefCallText = text.split("\n")[byRefCallLine];
        const byRefHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: byRefCallLine, character: 0 },
            end: { line: byRefCallLine, character: byRefCallText.length },
            parameterHints: true
        })).result;
        assert.ok(byRefHints.parameters.some((hint) => hint.parameterName === "value" && hint.passingMode === "byref"),
            "compiler-selected ByRef mode should reach the positional argument's inlay tooltip");
        const anyRankHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "anyRankValues() As Integer")
        })).result;
        assert.deepEqual({
            mode: anyRankHover.entries[0]?.declaration.compilerFacts?.parameterPassing?.mode,
            dimensions: anyRankHover.entries[0]?.declaration.compilerFacts?.parameterPassing?.dimensions
        }, { mode: "bydesc", dimensions: -1 },
        "FBC should identify an unsized array parameter as ByDesc with any rank");
        const matrixHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "matrixValues(Any, Any) As Integer")
        })).result;
        assert.deepEqual({
            mode: matrixHover.entries[0]?.declaration.compilerFacts?.parameterPassing?.mode,
            dimensions: matrixHover.entries[0]?.declaration.compilerFacts?.parameterPassing?.dimensions
        }, { mode: "bydesc", dimensions: 2 },
        "FBC should expose the declared rank of a multidimensional array parameter");
        const inferredVarHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Var inferredVar", "Var ".length)
        })).result;
        const inferredVar = inferredVarHover.entries[0]?.declaration;
        assert.equal(inferredVar?.typeName?.toLowerCase(), "integer");
        assert.ok(inferredVar?.compilerFacts?.declarationInputs?.some((declaration) =>
            declaration.writtenType === "inferred" && declaration.group?.kind === "var" &&
            declaration.group.count === 1),
        "FBC should retain one inferred Var declarator and its compiler-selected type");
        const layoutHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Type FlowLayout", "Type ".length)
        })).result;
        const layoutEntry = layoutHover.entries.find((entry) => entry.declaration.type === "type");
        assert.ok(Number.isSafeInteger(layoutEntry?.declaration.compilerFacts?.aggregateSizeBytes) &&
            layoutEntry.declaration.compilerFacts.aggregateSizeBytes > 0,
            "the compiler-selected UDT width should follow normalized member types to the type declaration");
        const outlineLayout = outline.find((symbol) => symbol.name === "FlowLayout");
        assert.match(outlineLayout?.detail || "",
            new RegExp(`layout: size: ${layoutEntry.declaration.compilerFacts.aggregateSizeBytes} bytes`),
            "the Outline should show the compiler-selected aggregate size");
        const layoutProperties = layoutEntry?.declaration.compilerFacts?.properties || [];
        const naturalAlignment = layoutProperties.find((property) => property.name === "natural-alignment");
        assert.ok(naturalAlignment && Number.isSafeInteger(Number(naturalAlignment.value)) && Number(naturalAlignment.value) > 0,
            "FBC's target-selected natural UDT alignment should reach the declaration hover");
        const alignmentUnit = Number(naturalAlignment.value) === 1 ? "byte" : "bytes";
        assert.match(outlineLayout?.detail || "", new RegExp(`alignment: ${naturalAlignment.value} ${alignmentUnit}`),
            "the Outline should show the compiler-selected natural alignment");
        const packingAlignment = layoutProperties.find((property) => property.name === "packing-alignment");
        assert.ok(packingAlignment && Number.isSafeInteger(Number(packingAlignment.value)) && Number(packingAlignment.value) >= 0,
            "FBC's UDT packing policy should reach the declaration hover");
        assert.deepEqual(layoutEntry?.declaration.compilerFacts?.aggregateAccess?.sections
            ?.map((section) => section.visibility), ["protected", "private"],
        "FBC should retain the ordered access sections on the aggregate declaration");
        const defaultTextHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "defaultText")
        })).result;
        const defaultTextInitialization = defaultTextHover.entries[0]?.declaration.compilerFacts?.scalarStringDeclaration;
        assert.equal(defaultTextInitialization?.kind, "dim");
        assert.equal(defaultTextInitialization?.expression, 0,
            "FBC should mark the scalar String declaration as using default initialization");
        assert.equal(defaultTextInitialization?.provisional, false);
        const explicitTextHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "explicitText")
        })).result;
        assert.deepEqual(explicitTextHover.entries[0]?.declaration.compilerFacts?.scalarStringDeclaration?.initializerValue,
            { kind: "bytes", value: "48656C6C6F" },
            "FBC should preserve an exact constant scalar String initializer through its expression identity");
        const publicFieldHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "byteValue As Byte")
        })).result;
        const publicField = publicFieldHover.entries.find((entry) => entry.declaration.type === "field");
        assert.equal(publicField?.declaration.compilerFacts?.compilerVisibility, "public",
            "FBC should retain the default public access on an unqualified aggregate field");
        const defaultVisibilityHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Function defaultVisibilityProbe", "Function ".length)
        })).result;
        const defaultVisibility = defaultVisibilityHover.entries[0]?.declaration.compilerFacts;
        assert.equal(defaultVisibilityHover.entries[0]?.declaration.containerName || "", "",
            "the visibility refactor should recognize only standalone, uncontained procedure definitions");
        assert.ok(["public", "private"].includes(defaultVisibility?.compilerVisibility),
            "FBC should select the standalone procedure's effective visibility");
        assert.deepEqual(defaultVisibility?.procedureWrittenVisibility?.map((fact) => fact.visibility), ["default"],
            "FBC should distinguish a scope-selected procedure visibility from a written modifier");
        const defaultVisibilityWord = defaultVisibility.compilerVisibility[0].toUpperCase() +
            defaultVisibility.compilerVisibility.slice(1);
        assert.match(outline.find((symbol) => symbol.name === "defaultVisibilityProbe")?.detail || "",
            new RegExp(`${defaultVisibilityWord} by scope default`),
            "the Outline should explain when standalone procedure visibility comes from the module default");
        assert.deepEqual(defaultVisibility?.procedureTypingInputs?.map((fact) => [fact.role, fact.kind]),
            [["definition", "function"]],
            "the visibility refactor needs one compiler-confirmed definition, not a prototype family");
        assert.equal(defaultVisibility?.procedureWrittenVisibility?.[0]?.statement,
            defaultVisibility?.procedureTypingInputs?.[0]?.statement,
            "the original visibility choice should be tied to the same accepted definition statement");
        const memberCompletion = (await worker.query(reply.snapshotId, "completion", {
            ...input,
            position: pointAt(text, "layoutInstance.byteValue", "layoutInstance.".length)
        })).result;
        const byteValueCompletion = memberCompletion.entries.find((entry) => entry.name === "byteValue");
        assert.ok(typeof byteValueCompletion?.qualifiedName === "string" &&
            byteValueCompletion.qualifiedName.includes("."),
        "contained member completions should retain qualified identity for access details");
        const fieldHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "fieldValue As Long")
        })).result;
        const fieldEntry = fieldHover.entries.find((entry) => entry.declaration.type === "field");
        const fieldLayout = fieldEntry?.declaration.compilerFacts?.fieldLayout;
        assert.ok(Number.isSafeInteger(fieldLayout?.byteOffset) && fieldLayout.byteOffset >= 0,
            "the compiler-selected byte offset should follow the physical field into its hover record");
        assert.match(outline.find((symbol) => symbol.name === "fieldValue")?.detail || "",
            /offset: \d+ bytes/,
            "the compiler-backed Outline should make the field's byte offset visible");
        assert.match(outline.find((symbol) => symbol.name === "fieldValue")?.detail || "",
            /Protected access/,
            "the compiler-backed Outline should identify protected members");
        assert.equal(fieldEntry?.declaration.compilerFacts?.compilerVisibility, "protected",
            "the compiler-selected protected section should follow its physical field");
        const bitFieldHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "flagBits : 3")
        })).result;
        const bitFieldEntry = bitFieldHover.entries.find((entry) => entry.declaration.type === "field");
        const bitFieldProperties = bitFieldEntry?.declaration.compilerFacts?.properties || [];
        assert.equal(bitFieldProperties.find((property) => property.name === "bit-width")?.value, "3",
            "the compiler should retain the bitfield width at the physical field declaration");
        assert.match(outline.find((symbol) => symbol.name === "flagBits")?.detail || "",
            /bit position: \d+, width: 3 bits/,
            "the compiler-backed Outline should expose the selected bitfield position and width");
        assert.match(outline.find((symbol) => symbol.name === "flagBits")?.detail || "",
            /Private access/,
            "the compiler-backed Outline should identify private members");
        assert.equal(bitFieldEntry?.declaration.compilerFacts?.compilerVisibility, "private",
            "the compiler-selected private section should follow its physical field");
        const arrayHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Dim boundsArray", "Dim ".length)
        })).result;
        const arrayBounds = arrayHover.entries[0]?.declaration.compilerFacts?.arrayBounds;
        assert.equal(arrayBounds?.mode, "bounds");
        assert.equal(arrayBounds?.rank, 2);
        assert.deepEqual(arrayBounds?.dimensions, [
            { dimension: 0, kind: "fixed", lower: -1, upper: 4 },
            { dimension: 1, kind: "fixed", lower: 1, upper: 3 }
        ], "FBC should provide each dimension's actual lower and upper bounds");
        const arrayProperties = arrayHover.entries[0]?.declaration.compilerFacts?.properties || [];
        assert.deepEqual(arrayProperties
            .filter((property) => property.name === "array-elements" && property.provisional !== true)
            .map((property) => property.value), ["18"],
        "FBC's element count should agree with the two fixed dimensions");
        const arrayElementWidth = arrayHover.entries[0]?.declaration.compilerFacts?.storageType?.storageBytes;
        assert.ok(Number.isSafeInteger(arrayElementWidth) && arrayElementWidth > 0);
        assert.match(outline.find((symbol) => symbol.name === "boundsArray")?.detail || "",
            new RegExp(`element storage: ${BigInt(arrayElementWidth) * 18n} bytes`),
            "Outline should multiply only FBC-confirmed fixed element count and target width");
        const skippedLoop = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "For loopIndex = 3 To 1")
        })).result;
        assert.equal(skippedLoop.forEntryResult, "skip",
            "FBC should confirm that the descending default-step loop skips its body");
        const enteredLoop = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "For loopIndex = 1 To 3")
        })).result;
        assert.equal(enteredLoop.forEntryResult, "enter",
            "FBC should confirm that the ascending loop passes its initial test");
        const anyRankCall = pointAt(text, "consumeAnyRank(integerArray())", "consumeAnyRank(".length + 1);
        const anyRankSignature = (await worker.query(reply.snapshotId, "signature", {
            ...input,
            position: anyRankCall
        })).result;
        assert.equal(anyRankSignature.entries.length, 1);
        assert.deepEqual(anyRankSignature.entries[0].declaration.parameters[0].compilerParameterPassing, {
            mode: "bydesc", dimensions: -1, optional: false, receiver: false
        }, "Signature Help should carry the compiler-selected descriptor mode and rank on its matching parameter");
        const skippedLoopPosition = pointAt(text, "For loopIndex = 3 To 1");
        const skippedLoopLine = text.split("\n")[skippedLoopPosition.line];
        const inlayHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: skippedLoopPosition.line, character: 0 },
            end: { line: skippedLoopPosition.line, character: skippedLoopLine.length }
        })).result;
        assert.deepEqual(inlayHints.forEntries.map((hint) => [hint.position.line, hint.position.character, hint.label]), [
            [skippedLoopPosition.line, skippedLoopPosition.character + 3, "body skipped"]
        ], "the compiler's skip result should be available as an inline editor hint");

        const visibilityKeyword = defaultVisibility.compilerVisibility === "public" ? "Public" : "Private";
        const explicitVisibilityText = text.replace(
            "Function defaultVisibilityProbe() As Integer",
            visibilityKeyword + " Function defaultVisibilityProbe() As Integer"
        ).replace(
            "Declare Function cDefaultProbe(",
            "Declare Function cDefaultProbe Cdecl("
        ).replace(
            "Declare Function windowsDefaultProbe(",
            "Declare Function windowsDefaultProbe Stdcall("
        );
        fs.writeFileSync(filePath, explicitVisibilityText);
        const explicitVisibilityReply = await worker.analyze({
            ...options,
            exportSemanticBindings: true,
            exportSemanticExpressions: true
        }, preparation);
        try {
            assert.equal(explicitVisibilityReply.partial, false,
                JSON.stringify(explicitVisibilityReply.diagnostics.map((diagnostic) => diagnostic.message)));
            assert.deepEqual(
                explicitVisibilityReply.diagnostics.map((diagnostic) => diagnostic.message),
                reply.diagnostics.map((diagnostic) => diagnostic.message),
                "writing the selected default visibility explicitly must not add compiler diagnostics"
            );
            const explicitVisibilityHover = (await worker.query(explicitVisibilityReply.snapshotId, "hover", {
                ...input,
                position: pointAt(explicitVisibilityText, "Function defaultVisibilityProbe", "Function ".length)
            })).result;
            const explicitVisibilityFacts = explicitVisibilityHover.entries[0]?.declaration.compilerFacts;
            assert.equal(explicitVisibilityFacts?.compilerVisibility, defaultVisibility.compilerVisibility);
            assert.equal(explicitVisibilityFacts?.procedureWrittenVisibility?.[0]?.visibility,
                defaultVisibility.compilerVisibility);
            const explicitCDefaultHover = (await worker.query(explicitVisibilityReply.snapshotId, "hover", {
                ...input,
                position: pointAt(explicitVisibilityText, "Declare Function cDefaultProbe", "Declare Function ".length)
            })).result;
            const explicitCDefaultFacts = explicitCDefaultHover.entries[0]?.declaration.compilerFacts;
            assert.equal(explicitCDefaultFacts?.procedureCallingConvention, cDefaultFacts.procedureCallingConvention);
            assert.equal(explicitCDefaultFacts?.procedureAbiPolicyInputs?.[0]?.writtenConvention, true,
                "the explicit CDECL refactor should preserve the compiler-selected C convention");
            const explicitWindowsHover = (await worker.query(explicitVisibilityReply.snapshotId, "hover", {
                ...input,
                position: pointAt(explicitVisibilityText, "Declare Function windowsDefaultProbe",
                    "Declare Function ".length)
            })).result;
            const explicitWindowsFacts = explicitWindowsHover.entries[0]?.declaration.compilerFacts;
            assert.equal(explicitWindowsFacts?.procedureCallingConvention,
                windowsDefaultFacts.procedureCallingConvention);
            assert.equal(explicitWindowsFacts?.procedureAbiPolicyInputs?.[0]?.writtenConvention, true,
                "the explicit STDCALL refactor should preserve the compiler-selected Windows convention");
        } finally {
            worker.releaseModel(explicitVisibilityReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native sidecar supplies implicit function return types", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Function implicitResult()",
        "    Return 42",
        "End Function",
        "Function suffixResult%()",
        "    Return 42",
        "End Function",
        "Sub implicitParameterProbe(ByVal parameterValue)",
        "End Sub",
        "Sub suffixParameterProbe(ByVal suffixValue%)",
        "End Sub",
        "Sub implicitArrayProbe(values())",
        "End Sub",
        "Sub implicitStorageProbe()",
        "    implicitLocal = 1",
        "End Sub",
        "Dim implicitDimValue",
        "Dim implicitArray(1)",
        "Const implicitConstant = 42",
        "Const suffixConstant% = 7",
        "Dim suffixDimValue%",
        "Dim suffixDimArray%(1)",
        "Print implicitResult()",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        exportSemanticBindings: true,
        exportSemanticExpressions: true
    }, preparation);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics.map((diagnostic) => diagnostic.message)));
    try {
        const hover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Function implicitResult", "Function ".length)
        })).result;
        const declaration = hover.entries[0]?.declaration;
        assert.equal(declaration?.typeName?.toLowerCase(), "integer",
            "the native symbol inventory should retain the function's resolved default return type");
        assert.ok(declaration?.compilerFacts?.procedureTypingInputs?.some((typing) =>
            typing.kind === "function" && typing.resultForm === "implicit"),
        "the semantic sidecar should certify that the return type was implicit");
        const suffixReturnHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "Function suffixResult%", "Function ".length)
        })).result;
        const suffixReturn = suffixReturnHover.entries[0]?.declaration;
        assert.equal(suffixReturn?.typeName?.toLowerCase(), "integer",
            "the native inventory should resolve a function suffix to its compiler-selected return type");
        assert.equal(suffixReturn?.signature, "Function suffixResult()",
            "the source-shaped signature should preserve suffix semantics for a checked refactor");
        const parameterHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "parameterValue")
        })).result;
        const parameter = parameterHover.entries[0]?.declaration;
        assert.equal(parameter?.typeName?.toLowerCase(), "integer",
            "FBC should retain the resolved type of an implicitly typed formal parameter");
        assert.ok(parameter?.compilerFacts?.formalWrittenTypes?.includes("implicit"),
            "the semantic sidecar should distinguish an implicit parameter type from a written AS type");
        assert.equal(parameter?.signature,
            "Sub implicitParameterProbe(ByVal parameterValue)",
            "native inventory should retain the source-shaped parent signature on the parameter entry");
        const suffixParameterHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "suffixValue%")
        })).result;
        const suffixParameter = suffixParameterHover.entries[0]?.declaration;
        assert.equal(suffixParameter?.typeName?.toLowerCase(), "integer");
        assert.equal(suffixParameter?.signature, "Sub suffixParameterProbe(ByVal suffixValue)",
            "the compiler inventory should resolve the suffixed formal type while retaining the parent signature");
        const implicitArrayHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "values()")
        })).result;
        const implicitArray = implicitArrayHover.entries[0]?.declaration;
        assert.equal(implicitArray?.typeName?.toLowerCase(), "integer");
        assert.ok(implicitArray?.compilerFacts?.formalWrittenTypes?.includes("implicit"));
        assert.equal(implicitArray?.compilerFacts?.parameterPassing?.mode, "bydesc");
        assert.equal(implicitArray?.compilerFacts?.parameterPassing?.dimensions, -1);
        const implicitVariableHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitLocal")
        })).result;
        const implicitVariable = implicitVariableHover.entries[0]?.declaration;
        assert.equal(implicitVariable?.compilerFacts?.compilerStorageClass, "local",
            "FBC should report the procedure-local storage class of an implicit variable");
        assert.match(implicitVariable?.signature || "", /^variable\s+implicitLocal\s+As\s+integer$/i,
            "the native inventory should identify the source declaration as an implicit variable");
        const implicitStorageOutline = (await worker.query(reply.snapshotId, "documentSymbols", input)).result
            .find((symbol) => symbol.name === "implicitLocal");
        assert.match(implicitStorageOutline?.detail || "", /storage: local/,
            "the Outline should make an implicit assignment-created variable's compiler scope visible");
        const implicitVariablePosition = pointAt(text, "implicitLocal");
        assert.equal(implicitVariable?.line, implicitVariablePosition.line);
        assert.equal(implicitVariable?.startColumn, implicitVariablePosition.character);
        assert.equal(implicitVariable?.endColumn, implicitVariablePosition.character + "implicitLocal".length);
        const implicitDimHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitDimValue")
        })).result;
        const implicitDim = implicitDimHover.entries[0]?.declaration;
        assert.equal(implicitDim?.typeName?.toLowerCase(), "integer");
        assert.equal(implicitDim?.signature, "Dim implicitDimValue");
        assert.ok(implicitDim?.compilerFacts?.declarationInputs?.some((input) =>
            input.writtenType === "implicit" && input.group?.kind === "dim" &&
            Number.isSafeInteger(input.group.count) && input.group.count > 0),
        "FBC should provide a complete implicit type fact for a plain DIM declarator");
        const implicitDimArrayHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitArray(1)")
        })).result;
        const implicitDimArray = implicitDimArrayHover.entries[0]?.declaration;
        assert.equal(implicitDimArray?.typeName?.toLowerCase(), "integer");
        assert.ok(implicitDimArray?.compilerFacts?.declarationInputs?.some((input) => input.writtenType === "implicit"));
        const implicitConstantHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitConstant")
        })).result;
        const implicitConstant = implicitConstantHover.entries[0]?.declaration;
        assert.equal(implicitConstant?.type, "const");
        assert.equal(implicitConstant?.typeName?.toLowerCase(), "integer");
        assert.ok(implicitConstant?.compilerFacts?.declarationInputs?.some((input) =>
            input.writtenType === "inferred" && input.group?.kind === "const"),
        "FBC should distinguish an inferred Const type from explicit AS and suffix forms");
        const inferredOutline = (await worker.query(reply.snapshotId, "documentSymbols", input)).result;
        assert.match(inferredOutline.find((symbol) => symbol.name === "implicitResult")?.detail || "",
            /implicit return type/,
            "Outline should distinguish an implicit function result type from a written As clause");
        assert.match(inferredOutline.find((symbol) => symbol.name === "implicitDimValue")?.detail || "",
            /implicit type/,
            "Outline should distinguish an untyped Dim from an explicit declaration");
        assert.match(inferredOutline.find((symbol) => symbol.name === "parameterValue")?.detail || "",
            /implicit parameter type/,
            "Outline should distinguish an implicitly typed formal parameter");
        assert.match(inferredOutline.find((symbol) => symbol.name === "implicitConstant")?.detail || "",
            /inferred type/,
            "Outline should distinguish an inferred Const type from an explicit declaration");
        const suffixConstantHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "suffixConstant%")
        })).result;
        const suffixConstant = suffixConstantHover.entries[0]?.declaration;
        assert.equal(suffixConstant?.type, "const");
        assert.equal(suffixConstant?.typeName?.toLowerCase(), "integer");
        assert.equal(suffixConstant?.signature, "Const suffixConstant = 7");
        const suffixDimHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "suffixDimValue%")
        })).result;
        const suffixDim = suffixDimHover.entries[0]?.declaration;
        assert.equal(suffixDim?.typeName?.toLowerCase(), "integer");
        assert.equal(suffixDim?.signature, "Dim suffixDimValue");
        const suffixDimArrayHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "suffixDimArray%")
        })).result;
        const suffixDimArray = suffixDimArrayHover.entries[0]?.declaration;
        assert.equal(suffixDimArray?.typeName?.toLowerCase(), "integer");
        assert.equal(suffixDimArray?.signature, "Dim suffixDimArray(1)");

        const refactoredText = text
            .replace("    implicitLocal = 1", "    Dim implicitLocal As Integer = 1")
            .replace("    Let _\n        implicitLetLocal = 2",
                "    Dim implicitLetLocal As Integer\n    Let _\n        implicitLetLocal = 2")
            .replace("Const suffixConstant% = 7", "Const suffixConstant As Integer = 7");
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            exportSemanticBindings: true,
            exportSemanticExpressions: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false,
                JSON.stringify(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message)));
            assert.deepEqual(
                refactoredReply.diagnostics.map((diagnostic) => diagnostic.message),
                reply.diagnostics.map((diagnostic) => diagnostic.message),
                "the explicit declarations produced by these refactors must not add compiler diagnostics"
            );
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar reports compiler-selected FOR-entry results", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Sub SidecarForEntryProbe()",
        "    Dim loopIndex As Integer",
        "    For loopIndex = 3 To 1",
        "    Next",
        "    For loopIndex = 1 To 3",
        "    Next",
        "End Sub",
        "Sub SidecarImplicitForProbe()",
        "    For _",
        "        implicitLoopIndex = 1 To 2",
        "    Next",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerArguments: ["-lang", "deprecated"],
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const skippedPosition = pointAt(text, "For loopIndex = 3 To 1");
        const skippedHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: skippedPosition
        })).result;
        assert.equal(skippedHover.forEntryResult, "skip");
        const skippedLine = text.split("\n")[skippedPosition.line];
        const hints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: skippedPosition.line, character: 0 },
            end: { line: skippedPosition.line, character: skippedLine.length }
        })).result;
        assert.deepEqual(hints.forEntries.map((hint) => [hint.position.line, hint.position.character, hint.label]), [
            [skippedPosition.line, skippedPosition.character + "For".length, "body skipped"]
        ]);

        const enteredHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "For loopIndex = 1 To 3")
        })).result;
        assert.equal(enteredHover.forEntryResult, "enter");
        const implicitCounterHover = (await worker.query(reply.snapshotId, "hover", {
            ...input,
            position: pointAt(text, "implicitLoopIndex")
        })).result;
        assert.equal(implicitCounterHover.compilerStorageClass, "local");
        assert.equal(implicitCounterHover.compilerStorageTypeFacts?.storageType?.primitive, "integer");
        const implicitForLine = text.split("\n").findIndex((line) => line.includes("implicitLoopIndex ="));
        const implicitForSource = text.split("\n")[implicitForLine];
        const implicitForHints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: implicitForLine, character: 0 },
            end: { line: implicitForLine, character: implicitForSource.length },
            parameterHints: false
        })).result;
        assert.deepEqual(implicitForHints.implicitVariables?.map((hint) => [
            hint.position.line, hint.position.character, hint.storageType.primitive
        ]), [[implicitForLine, implicitForSource.indexOf("implicitLoopIndex") + "implicitLoopIndex".length, "integer"]],
        "the sidecar should attach an implicit FOR counter type to its physical header name");

        const refactoredText = text.replace(
            "    For _\n        implicitLoopIndex = 1 To 2",
            "    For _\n        implicitLoopIndex As Integer = 1 To 2"
        );
        assert.notEqual(refactoredText, text, "the refactor fixture should match the continued FOR counter");
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            compilerArguments: ["-lang", "deprecated"],
            semanticModelOnly: true,
            exportSemanticExpressions: true,
            exportSemanticBindings: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false);
            assert.deepEqual(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message), [],
                "making the continued FOR counter's type explicit should compile cleanly");
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native enum semantic facts retain physical explicitness and compiler values", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Enum StableCode",
        "    FirstCode",
        "    ExplicitCode = 7",
        "    NextCode",
        "End Enum",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        exportSemanticBindings: true,
        exportSemanticExpressions: true
    }, preparation);
    assert.equal(reply.partial, false, JSON.stringify(reply.diagnostics.map((diagnostic) => diagnostic.message)));
    try {
        for (const [name, explicit, value] of [
            ["FirstCode", false, "0"],
            ["ExplicitCode", true, "7"],
            ["NextCode", false, "8"]
        ]) {
            const hover = (await worker.query(reply.snapshotId, "hover", {
                ...input,
                position: pointAt(text, name)
            })).result;
            const declaration = hover.entries[0]?.declaration;
            const elementInputs = declaration?.compilerFacts?.enumElementInputs;
            assert.ok(Array.isArray(elementInputs) && elementInputs.length > 0,
                "FBC enum initializer facts should follow native members into their declaration records");
            assert.ok(elementInputs.every((element) =>
                element.explicit === explicit && element.physical === true &&
                element.filePath === filePath && element.line === declaration.line + 1 &&
                element.startColumn === declaration.startColumn),
            "enum initializer facts should agree with the physical member declaration");
            assert.equal(declaration.compilerFacts.constantValues?.[0]?.value, value,
                "the member's effective value should remain the exact compiler-selected integer");
        }

        const refactoredText = text.replace("    FirstCode", "    FirstCode = 0");
        fs.writeFileSync(filePath, refactoredText);
        const refactoredReply = await worker.analyze({
            ...options,
            exportSemanticBindings: true,
            exportSemanticExpressions: true
        }, preparation);
        try {
            assert.equal(refactoredReply.partial, false,
                JSON.stringify(refactoredReply.diagnostics.map((diagnostic) => diagnostic.message)));
            assert.deepEqual(
                refactoredReply.diagnostics.map((diagnostic) => diagnostic.message),
                reply.diagnostics.map((diagnostic) => diagnostic.message),
                "writing the compiler-selected enum value explicitly must not add diagnostics"
            );
        } finally {
            worker.releaseModel(refactoredReply.snapshotId);
        }
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native constructor declarations retain references to converted arguments", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "integration/workspace/implicit-argument-constructor.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, exportSemanticBindings: true, exportSemanticExpressions: true }, preparation);
    try {
        assert.equal(reply.partial, false);
        for (const [type, argument, other] of [["Long", "17", "2.5"], ["Double", "2.5", "17"]]) {
            for (const prefix of ["Constructor", "Constructor ArgumentValue"]) {
                const position = pointAt(text, `Constructor ArgumentValue(ByVal initial As ${type})`, prefix.length - 1);
                for (const operation of ["references", "highlights"]) {
                    const records = (await worker.query(reply.snapshotId, operation, { ...input, position, includeDeclaration: true })).result;
                    const ranges = records.map((record) => text.split("\n")[record.occurrence.line]
                        .slice(record.occurrence.startColumn, record.occurrence.endColumn));
                    assert.ok(ranges.some((range) => range.includes(argument)), `${type}: ${operation}: ${prefix}: ${ranges}`);
                    assert.equal(ranges.some((range) => range.includes(other)), false, "sibling conversions remain separate");
                }
            }
        }
    } finally { worker.releaseModel(reply.snapshotId); }
});

test("native constructor hierarchy prepares the compiler-connected body from its header", native, async (t) => {
    const { worker, filePath, directory, options, preparation, input } = setup(t, true);
    const headerPath = path.join(directory, "constructors.bi");
    const header = "Type HeaderConstructed\nvalue As Long\nDeclare Constructor(ByVal initial As Long)\n" +
        "Declare Constructor(ByVal initial As Double)\nEnd Type\n";
    const text = '#include "constructors.bi"\nConstructor HeaderConstructed(ByVal initial As Long)\nvalue = initial\nEnd Constructor\n' +
        "Constructor HeaderConstructed(ByVal initial As Double)\nvalue = initial\nEnd Constructor\n" +
        "Dim first As HeaderConstructed = HeaderConstructed(7)\nDim second As HeaderConstructed = HeaderConstructed(1.5)\n";
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options, exportSemanticBindings: true, exportSemanticExpressions: true }, preparation);
    try {
        assert.equal(reply.partial, false);
        for (const [prototype, body] of [
            ["Declare Constructor(ByVal initial As Long)", "Constructor HeaderConstructed(ByVal initial As Long)"],
            ["Declare Constructor(ByVal initial As Double)", "Constructor HeaderConstructed(ByVal initial As Double)"]
        ]) {
            const result = (await worker.query(reply.snapshotId, "callHierarchyPrepare", {
                ...input, uri: { scheme: "file", fsPath: headerPath }, position: pointAt(header, prototype, "Declare C".length)
            })).result;
            assert.deepEqual(result.map((entry) => [entry.uri.fsPath, entry.declaration.line]), [[filePath, pointAt(text, body).line]],
                "the native symbol's connected body must be preferred without joining the other overload");
        }
    } finally { worker.releaseModel(reply.snapshotId); }
});

for (const sidecar of [true, false]) test(`compiler constant IF hints retain original predicates (${sidecar ? "sidecar" : "bridge"})`, native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = fs.readFileSync(path.join(__dirname, "fixtures/constant-condition-hints.bas"), "utf8");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({ ...options,
        compilerPath: sidecar ? process.env.FBC_EXECUTABLE || options.compilerPath : options.compilerPath,
        semanticModelOnly: sidecar, exportSemanticBindings: true, exportSemanticExpressions: true
    }, preparation);
    try {
        assert.equal(reply.partial, false);
        const end = pointAt(text, "'' end of constant-condition-hints.bas");
        const hints = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input, position: { line: 0, character: 0 }, end
        })).result.ifConditions;
        assert.deepEqual(hints.map((hint) => [hint.position, hint.label]), [
            [pointAt(text, "If 0 Then", "If 0".length), "always false"],
            [pointAt(text, "ElseIf 2 + 2 = 4 Then", "ElseIf 2 + 2 = 4".length), "always true"],
            [pointAt(text, "If 1 Then", "If 1".length), "always true"],
            [pointAt(text, "If 3 <> 3 Then", "If 3 <> 3".length), "always false"],
            [pointAt(text, "4 = 4 Then", "4 = 4".length), "always true"]
        ], "folded predicates retain source results; runtime and inactive conditions have no constant hint");
        const single = (await worker.query(reply.snapshotId, "compilerInlayHints", { ...input,
            position: pointAt(text, "ElseIf"), end: pointAt(text, "ElseIf 2 + 2 = 4 Then", "ElseIf 2 + 2 = 4 Then".length)
        })).result.ifConditions;
        assert.equal(single.length, 1, "hints stay inside the requested visible range");
        assert.match(single[0].tooltip, /earlier branches/);
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native control-flow inlays identify unreachable physical statements", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Sub FlowProbe()",
        "    Goto doneLabel",
        "    /' \u{1f600} '/ Print \"unreachable\"",
        "doneLabel:",
        "    Print \"reachable\"",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        exportSemanticBindings: true,
        exportSemanticExpressions: true
    }, preparation);
    assert.equal(reply.partial, false);
    try {
        const unreachablePosition = pointAt(text, "Print \"unreachable\"");
        const unreachableLine = text.split("\n")[unreachablePosition.line];
        const unreachable = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: unreachablePosition.line, character: 0 },
            end: { line: unreachablePosition.line, character: unreachableLine.length }
        })).result;
        assert.deepEqual(unreachable.unreachableStatements.map((hint) => [
            hint.position.line, hint.position.character, hint.label
        ]), [[unreachablePosition.line, unreachablePosition.character + "Print".length, "unreachable"]]);
        const sourceRanges = (await worker.query(reply.snapshotId, "compilerUnreachableSourceRanges", input)).result;
        assert.deepEqual(sourceRanges, [{ start: text.indexOf('Print "unreachable"'), end: text.indexOf('Print "unreachable"') + "Print".length }],
            "fading uses the native token's UTF-16 offsets, not the whole line or reachable label");
        const batch = (await worker.query(reply.snapshotId, "compilerSourceDiagnosticRanges", input)).result;
        assert.deepEqual(batch.unreachable, sourceRanges);
        assert.deepEqual(batch.inactive, []);
        assert.ok(Array.isArray(batch.lexical.remIdentifierOffsets));
        assert.ok(Array.isArray(batch.lexical.defaultEscapedStringRanges));

        const reachablePosition = pointAt(text, "Print \"reachable\"");
        const reachableLine = text.split("\n")[reachablePosition.line];
        const reachable = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: reachablePosition.line, character: 0 },
            end: { line: reachablePosition.line, character: reachableLine.length }
        })).result;
        assert.deepEqual(reachable.unreachableStatements, [],
            "the compiler-resolved GOTO label remains reachable and must not be marked");
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("stock semantic sidecar exposes compiler-confirmed unreachable statements", native, async (t) => {
    const { worker, filePath, options, preparation, input } = setup(t, true);
    const text = [
        "Sub SidecarFlowProbe()",
        "    Goto doneLabel",
        "    /' \u{1f600} '/ Print \"unreachable\"",
        "doneLabel:",
        "    Print \"reachable\"",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, text);
    const reply = await worker.analyze({
        ...options,
        compilerPath: process.env.FBC_EXECUTABLE || options.compilerPath,
        semanticModelOnly: true,
        exportSemanticExpressions: true,
        exportSemanticBindings: true
    }, preparation);
    assert.equal(reply.semanticSidecarOnly, true);
    assert.equal(reply.partial, false);
    try {
        const unreachablePosition = pointAt(text, "Print \"unreachable\"");
        const line = text.split("\n")[unreachablePosition.line];
        const result = (await worker.query(reply.snapshotId, "compilerInlayHints", {
            ...input,
            position: { line: unreachablePosition.line, character: 0 },
            end: { line: unreachablePosition.line, character: line.length }
        })).result;
        assert.deepEqual(result.unreachableStatements?.map((hint) => [
            hint.position.line, hint.position.character, hint.label
        ]), [[unreachablePosition.line, unreachablePosition.character + "Print".length, "unreachable"]]);
        const sourceRanges = (await worker.query(reply.snapshotId, "compilerUnreachableSourceRanges", input)).result;
        assert.deepEqual(sourceRanges, [{ start: text.indexOf('Print "unreachable"'), end: text.indexOf('Print "unreachable"') + "Print".length }]);
        const batch = (await worker.query(reply.snapshotId, "compilerSourceDiagnosticRanges", input)).result;
        assert.deepEqual(batch.unreachable, sourceRanges);
        assert.deepEqual(batch.inactive, []);
        assert.ok(Array.isArray(batch.lexical.remKeywordDisabledLineOffsets));
    } finally {
        worker.releaseModel(reply.snapshotId);
    }
});

test("native workspace symbols invalidate changed module and header sources", native, async (t) => {
    const { worker, directory, filePath, options } = setup(t, true);
    const headerPath = path.join(directory, "workspace-symbols.bi");
    const secondFilePath = path.join(directory, "workspace-symbols-secondary.bas");
    const originalHeader = "Namespace WorkspaceCatalog\n    Dim Shared closedValue As Long\nEnd Namespace\n";
    const changedHeader = "Namespace WorkspaceCatalog\n    Dim Shared changedHeaderValue As Double\nEnd Namespace\n";
    const unsavedHeader = "Namespace WorkspaceCatalog\n    Dim Shared unsavedHeaderValue As String\nEnd Namespace\n";
    const changedRoot = '#include "workspace-symbols.bi"\nDim Shared changedRootValue As Double\n';
    const secondRoot = '#include "workspace-symbols.bi"\nDim Shared secondaryRootValue As Long\n';
    fs.writeFileSync(filePath, '#include "workspace-symbols.bi"\nDim Shared changedRootValue As Long\n');
    fs.writeFileSync(secondFilePath, secondRoot);
    fs.writeFileSync(headerPath, originalHeader);
    const modules = [filePath, secondFilePath];
    const index = async (buffers, query = "value") => {
        const pass = await worker.beginWorkspace(buffers, query, 100);
        const results = [];
        for (const modulePath of modules) results.push(await worker.indexWorkspace({ ...options, filePath: modulePath }, { id: pass.workspaceId }));
        const entries = results.flatMap((result) => result.packedEntries
            ? mapPackedWorkspaceEntries(result.packedEntries, result.strings)
            : result.entries);
        return { pass, results, entries };
    };
    let request = await index(new Map());
    assert.deepEqual(request.results.map((result) => result.cached), [false, false]);
    assert.ok(request.entries.some((entry) => entry.name === "closedValue"));
    assert.deepEqual((await worker.finishWorkspace(request.pass.workspaceId, new Map())).verified, true);
    request = await index(new Map());
    assert.deepEqual(request.results.map((result) => result.cached), [true, true], "Repeated workspace queries should reuse both module summaries.");
    assert.deepEqual((await worker.finishWorkspace(request.pass.workspaceId, new Map())).verified, true);
    fs.writeFileSync(headerPath, changedHeader);
    request = await index(new Map());
    assert.deepEqual(request.results.map((result) => result.cached), [false, false], "A changed closed include must invalidate every dependent translation unit.");
    assert.ok(request.entries.some((entry) => entry.name === "changedHeaderValue"));
    await worker.finishWorkspace(request.pass.workspaceId, new Map());
    request = await index(new Map([[headerPath, unsavedHeader]]));
    assert.deepEqual(request.results.map((result) => result.cached), [false, false], "An unsaved included header must replace both cached disk declarations.");
    assert.ok(request.entries.some((entry) => entry.name === "unsavedHeaderValue"));
    assert.ok(!request.entries.some((entry) => entry.name === "changedHeaderValue"));
    assert.equal(fs.readFileSync(headerPath, "utf8"), changedHeader, "Workspace symbol analysis must not save header overlays.");
    await worker.finishWorkspace(request.pass.workspaceId, new Map([[headerPath, unsavedHeader]]));
    const rootAndHeaderOverlays = new Map([[headerPath, unsavedHeader], [filePath, changedRoot]]);
    request = await index(rootAndHeaderOverlays);
    assert.deepEqual(request.results.map((result) => result.cached), [false, true], "An unsaved root must invalidate only its translation unit while preserving the shared header overlay cache.");
    assert.ok(request.entries.some((entry) => entry.name === "changedRootValue"));
    await assert.rejects(worker.finishWorkspace(request.pass.workspaceId, new Map([[headerPath, unsavedHeader], [filePath, `${changedRoot}Print changedRootValue\n`]])), /editor buffers changed/);
    request = await index(rootAndHeaderOverlays, "changedRoot");
    assert.deepEqual(request.results.map((result) => result.cached), [true, true]);
    const verified = await worker.finishWorkspace(request.pass.workspaceId, rootAndHeaderOverlays);
    assert.equal(verified.verified, true);
});

test("native prepared headers use unsaved content and reject changed disk dependencies", native, async (t) => {
    const { worker, options, directory, filePath, input } = setup(t, true);
    const header = path.join(directory, "value.bi");
    const diskHeader = "Dim headerValue As Long\nPrint headerValue\n";
    fs.writeFileSync(filePath, '#include "value.bi"\n');
    fs.writeFileSync(header, diskHeader);
    const preparation = { requestedFile: header, expandedUri };
    const overlays = new Map([[header, diskHeader.replace("Long", "Double")]]);
    const reply = await worker.analyze({ ...options, overlays }, preparation);
    const query = { uri: { scheme: "file", fsPath: header }, openFiles: [header], position: { line: 1, character: 8 } };
    assert.equal((await worker.query(reply.snapshotId, "expression", query)).result.typeName, "double");
    assert.equal(fs.readFileSync(header, "utf8"), diskHeader);
    fs.writeFileSync(filePath, '#include "value.bi"\nPrint 42\n');
    await assert.rejects(worker.query(reply.snapshotId, "validate", input), /source changed/);
});

test("native worker retains later types from a broken unsaved include", native, async (t) => {
    const { worker, options, directory, filePath } = setup(t, true);
    const headerPath = path.join(directory, "recovery.bi");
    const source = '#include "recovery.bi"\nPrint includedValue * 2\n';
    const diskHeader = "Dim includedValue As Long\n";
    const header = "Dim includedValue As Double\nPrint includedValue +\nPrint includedValue * 3\n";
    fs.writeFileSync(filePath, source);
    fs.writeFileSync(headerPath, diskHeader);

    const reply = await worker.analyze({
        ...options,
        overlays: new Map([[filePath, source], [headerPath, header]]),
        exportSemanticExpressions: true
    }, { requestedFile: filePath, expandedUri });
    assert.equal(reply.partial, true);
    assert.ok(reply.sources.some((sourceFile) => sourceFile.filePath === headerPath && sourceFile.text === header));

    const query = (line, character, endCharacter) => worker.query(reply.snapshotId, "expression", {
        uri: { scheme: "file", fsPath: headerPath },
        openFiles: [filePath, headerPath],
        position: { line, character },
        end: { line, character: endCharacter }
    });
    assert.equal((await query(1, 0, "Print includedValue +".length)).result, null,
        "The malformed line must remain unavailable through the prepared worker model");
    const laterText = "includedValue * 3";
    const later = (await query(2, 6, 6 + laterText.length)).result;
    assert.equal(later?.typeName.toLowerCase(), "double");
    assert.equal(fs.readFileSync(headerPath, "utf8"), diskHeader,
        "Worker analysis must not save the editor's unsaved header overlay");
});

test("native dependency verification rechecks host trust before launching another compiler", native, async (t) => {
    const { worker, options, directory, filePath, preparation } = setup(t, true);
    fs.writeFileSync(filePath, '#include "discovered.bi"\n');
    fs.writeFileSync(path.join(directory, "discovered.bi"), "Dim discoveredValue As Long\n");
    let checks = 0;
    worker.canExecute = () => ++checks === 1;
    await assert.rejects(worker.analyze(options, preparation), /untrusted/);
    assert.equal(checks, 2);
    assert.equal(worker.models.size, 0);
    assert.equal(worker.active, null);
    worker.canExecute = () => true;
    assert.equal((await worker.analyze(options, preparation)).partial, false);
});

test("prepared worker models answer initializer types from compiler semantic expressions", native, async (t) => {
    const { worker } = setup(t, true);
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/gfx/palette.bas");
    const source = fs.readFileSync(filePath, "utf8");
    const lines = source.split(/\r\n|\n|\r/);
    const line = lines.findIndex((value) => value.trimStart().startsWith("&h"));
    assert.ok(line >= 0);
    const startColumn = lines[line].indexOf("&h");
    const endColumn = lines[line].indexOf(",", startColumn);
    assert.ok(startColumn >= 0 && endColumn > startColumn);
    const options = {
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")],
        allowErrors: true,
        exportSemanticExpressions: true
    };
    for (const [exportSemanticBindings, unsaved] of [[false, false], [true, false], [true, true]]) {
        const overlays = unsaved ? new Map([[filePath, `${source}\n' Unsaved initializer type probe\n`]]) : undefined;
        const reply = await worker.analyze({ ...options, exportSemanticBindings, overlays }, { requestedFile: filePath, expandedUri });
        assert.equal(reply.partial, false);
        const typed = await worker.query(reply.snapshotId, "expression", {
            uri: { scheme: "file", fsPath: filePath },
            openFiles: unsaved ? [filePath] : [],
            position: { line, character: startColumn },
            end: { line, character: endColumn }
        });
        assert.equal(typed.result?.semanticSource, "compiler-sidecar");
        assert.equal(typed.result?.typeName.toLowerCase(), "integer",
            `initializer types must survive a binding upgrade=${exportSemanticBindings}`);
        if (exportSemanticBindings) {
            assert.equal(typed.result.compilerSidecarSymbolId, undefined,
                "supplementary type facts must not leak independent export identities");
        }
        worker.releaseModel(reply.snapshotId);
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), source, "supplementary analysis must not save an editor overlay");
});

test("prepared workers retain sidecar expression types when a trace exceeds the analysis bound", native, async (t) => {
    const { worker } = setup(t, true);
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const filePath = path.join(root, "tests/compound/select_const2.bas");
    const originalBytes = fs.readFileSync(filePath);
    const original = originalBytes.toString("utf8");
    const expression = "1 + 2.0";
    const source = `${original}${original.endsWith("\n") ? "" : "\n"}Print ${expression}\n`;
    const lines = source.split(/\r\n|\n|\r/);
    const line = lines.findIndex((value) => value === `Print ${expression}`);
    const startColumn = lines[line].indexOf(expression);
    const reply = await worker.analyze({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")],
        overlays: new Map([[filePath, source]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 120000
    }, { requestedFile: filePath, expandedUri });

    assert.equal(reply.partial, false);
    assert.ok(reply.sources.some((item) => item.filePath === filePath && item.text === source));
    const typed = await worker.query(reply.snapshotId, "expression", {
        uri: { scheme: "file", fsPath: filePath },
        openFiles: [filePath],
        position: { line, character: startColumn },
        end: { line, character: startColumn + expression.length }
    });
    assert.equal(typed.result.semanticSource, "compiler-sidecar");
    assert.equal(typed.result.typeName.toLowerCase(), "double");
    assert.equal(typed.result.provisional, false);
    assert.equal(fs.readFileSync(filePath).equals(originalBytes), true,
        "the worker must preserve the unsaved overlay without writing it to disk");
});

test("macro-heavy upstream models use the bounded exclusive allowance", native, async (t) => {
    const { worker } = setup(t, true);
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    // Offline resource checks may share the host with CPU-heavy jobs. Keep the
    // editor deadline unchanged while allowing these large models to finish.
    const analysisTimeoutMs = 5 * 60 * 1000;
    let previous;
    for (const name of ["compare-float-nan.bas", "iif.bas"]) {
        const filePath = path.join(root, "tests/expressions", name);
        const options = {
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            compilerArguments: ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")],
            allowErrors: true,
            timeoutMs: analysisTimeoutMs
        };
        const reply = await worker.analyze(options, { requestedFile: filePath, expandedUri });
        assert.equal(reply.partial, false);
        assert.ok(reply.modelWeight > 128 * 1024 * 1024);
        assert.ok(reply.modelWeight <= 384 * 1024 * 1024);
        assert.equal(worker.models.size, 1);
        if (previous) assert.equal(worker.models.has(previous), false);
        const tokens = await worker.query(reply.snapshotId, "semanticTokens", { uri: { scheme: "file", fsPath: filePath }, openFiles: [] });
        assert.ok(tokens.result.length > 0);
        previous = reply.snapshotId;
    }
});

test("LLVM select-constant stress timeout reclaims the request and leaves the worker reusable", { ...native, timeout: 15000 }, async (t) => {
    const { worker, filePath, options, preparation } = setup(t, true);
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const stressPath = path.join(root, "tests/compound/select_const2.bas");
    const includeArguments = ["-i", path.join(root, "inc"), "-i", path.join(root, "tests/fbcunit/inc")];

    await assert.rejects(worker.analyze({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath: stressPath,
        compilerArguments: ["-gen", "llvm", ...includeArguments],
        allowErrors: true,
        exportSemanticExpressions: true,
        timeoutMs: 1000
    }, { requestedFile: stressPath, expandedUri }), /timed out/i);
    assert.equal(worker.models.size, 0, "a timed-out compiler run must not publish a partial worker model");

    const recovered = await worker.analyze({
        ...options,
        compilerArguments: ["-gen", "gcc", ...includeArguments],
        exportSemanticExpressions: true,
        timeoutMs: 30000
    }, preparation);
    assert.equal(recovered.partial, false);
    assert.equal(worker.models.size, 1, "the worker must accept a fresh request after reaping the timeout");
    assert.ok(recovered.sources.some((source) => path.resolve(source.filePath) === path.resolve(filePath)));
});

/* end of tests/compiler-model-worker.test.js */
