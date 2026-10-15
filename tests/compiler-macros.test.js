/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/compiler-macros.test.js
    Purpose: Verify native macro provenance and physical editor projections.
    Responsibilities: test bounded decoding, repeated arguments, and ambiguity.
    Does not contain: a replacement preprocessor or edits to compiler sources.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { decodePreprocessed, analyzeSavedModule } = require("../lib/compiler-analysis");
const { createMacroProjector, createMacroPartProjector } = require("../lib/compiler-macros");
const { CompilerSemanticModel } = require("../lib/compiler-semantic-model");

function uri(filePath) { return { fsPath: filePath, toString: () => `file://${filePath}` }; }

test("macro map decoding validates file identities, graph edges, and native targets", () => {
    const file = path.resolve("macro-map.bas"), hex = Buffer.from(file).toString("hex");
    const output = [
        "''@fb-editor-protocol 10",
        `''@fb-editor-file-v10 1 ${hex}`,
        "''@fb-editor-symbol 1 5 0 0 0 0 0 0 0 0 434f5059 766f6964",
        "''@fb-editor-shape 1 0 0 0 0 0 0",
        "''@fb-editor-map 1 2 5 0 0 0 20 25 0 0 1",
        "''@fb-editor-map 2 2 4 0 0 0 0 4 0 0 1",
        "''@fb-editor-map 3 5 5 1 2 0 0 0 1 0 0",
        "''@fb-editor-token-v10 1 6 11 generated 0 0 1 3",
        `''@fb-editor-v2 1 1 1 ${hex}`,
        "Print value",
        "''@fb-editor-end 0 1"
    ].join("\n");
    const analysis = decodePreprocessed(output, process.cwd());
    assert.equal(analysis.protocolVersion, 10);
    assert.deepEqual(createMacroProjector(analysis.macroGraph)(3), { filePath: file, sourceStart: 20, sourceEnd: 25 });
    const broken = [
        output.replace("map 3 5 5 1 2", "map 3 5 5 3 2"),
        output.replace("map 3 5 5 1 2", "map 9 5 5 8 2"),
        output.replace("map 3 5 5", "map 1000001 5 5"),
        output.replace("map 3 5 5", "map 3 99 5"),
        output.replace("map 3 5 5", "map 3 5 33554433"),
        output.replace("20 25 0 0 1", "25 20 0 0 1"),
        output.replace("20 25 0 0 1", "20 25 0 0 2"),
        output.replace("0 0 0 1 0 0", "0 0 0 1 32 0"),
        output.replace("0 0 0 1 0 0", "0 0 0 0 0 0"),
        output.replace("symbol 1 5", "symbol 1 1"),
        output.replace("generated 0 0 1 3", "generated 0 0 1 4"),
        output.replace("generated 0 0 1 3", "source 20 25 1 3"),
        output.replace("generated 0 0 1 3", "generated 0 0 2 3"),
        output.replace(`file-v10 1 ${hex}`, `file-v10 1 ${hex}\n''@fb-editor-file-v10 1 6f74686572`),
        output.replace("''@fb-editor-end", "''@fb-editor-map-overflow\n''@fb-editor-end")
    ];
    for (const text of broken) assert.throws(() => decodePreprocessed(text, process.cwd()), /macro|physical|source|record|origin|identity/i);
});

test("macro projection distinguishes contiguous copies from constructed and transformed text", () => {
    const nodes = [
        { id: 1, kind: "source", length: 3, sourceStart: 5, sourceEnd: 8, filePath: "one.bas" },
        { id: 2, kind: "source", length: 2, sourceStart: 8, sourceEnd: 10, filePath: "one.bas" },
        { id: 3, kind: "concat", length: 5, first: 1, second: 2 },
        { id: 4, kind: "slice", length: 3, first: 3, offset: 1 },
        { id: 5, kind: "argument", length: 3, first: 4 },
        { id: 6, kind: "definition", length: 3, first: 5 },
        { id: 7, kind: "source", length: 2, sourceStart: 30, sourceEnd: 32, filePath: "one.bas" },
        { id: 8, kind: "concat", length: 5, first: 1, second: 7 },
        { id: 9, kind: "stringify", length: 5, first: 1 },
        { id: 10, kind: "callback", length: 3, first: 1 },
        { id: 11, kind: "unknown", length: 3 },
        { id: 12, kind: "source", length: 1, sourceStart: 20, sourceEnd: 24, filePath: "two.bas" },
        { id: 13, kind: "concat", length: 4, first: 1, second: 12 },
        { id: 14, kind: "source", length: 2, sourceStart: 20, sourceEnd: 25, filePath: "two.bas" },
        { id: 15, kind: "slice", length: 1, first: 14, offset: 1 }
    ];
    const project = createMacroProjector({ nodes });
    assert.deepEqual(project(3), { filePath: "one.bas", sourceStart: 5, sourceEnd: 10 });
    assert.deepEqual(project(6), { filePath: "one.bas", sourceStart: 6, sourceEnd: 9 });
    assert.deepEqual(project(12), { filePath: "two.bas", sourceStart: 20, sourceEnd: 24 });
    for (const id of [0, 8, 9, 10, 11, 13, 15]) assert.equal(project(id), null);
    assert.deepEqual(project(6), project(6), "Cached projection must preserve its physical span");
});

test("macro part projection separates one argument from fixed token-paste text", () => {
    const graph = { nodes: [
        { id: 1, kind: "source", length: 2, sourceStart: 20, sourceEnd: 22, filePath: "one.bas" },
        { id: 2, kind: "argument", length: 2, first: 1 },
        { id: 3, kind: "source", length: 5, sourceStart: 40, sourceEnd: 45, filePath: "one.bas" },
        { id: 4, kind: "definition", length: 5, first: 3 },
        { id: 5, kind: "concat", length: 7, first: 2, second: 4 },
        { id: 6, kind: "stringify", length: 4, first: 1 },
        { id: 7, kind: "concat", length: 6, first: 2, second: 6 }
    ] };
    const project = createMacroPartProjector(graph);
    assert.deepEqual(project(5), [
        { outputStart: 0, outputEnd: 2, filePath: "one.bas", sourceStart: 20, sourceEnd: 22, role: "argument" },
        { outputStart: 2, outputEnd: 7, filePath: "one.bas", sourceStart: 40, sourceEnd: 45, role: "definition" }
    ]);
    assert.equal(project(7), null, "Stringified token-paste inputs cannot be edited through a generated name.");
});

test("native macro maps project nested and duplicated arguments from unsaved Unicode buffers", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-macro-origins.bas");
    const saved = fs.readFileSync(filePath, "utf8");
    for (const newline of ["\n", "\r\n", "\r"]) for (const bom of ["", "\uFEFF"]) {
        const text = ("' café 🌍\n" + saved + '\nPrint TwiceValue(sourceValue + 1)\nPrint TwiceValue(item.amount)\nPrint CopyValue("café 🌍")\nPrint __FB_EVAL__(1 + 2)\nPrint __FB_JOIN__(source, Value)\n').replace(/\n/g, newline);
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, bom + text]]) });
        const sourceUri = uri(filePath);
        const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/macro-map.bas" }, analysis, [{ uri: sourceUri, text }]);
        const source = model.getDocument(sourceUri);
        const lines = text.split(/\r\n|\n|\r/);
        const at = (prefix, name) => source.tokens.find((token) => token.name === name && lines[token.line].startsWith(prefix));
        const select = (token) => model.expressionAt(sourceUri, { line: token.line, character: token.startColumn }, { line: token.line, character: token.endColumn });
        const declaration = at("Dim sourceValue", "sourceValue");
        const target = model.resolveAt(sourceUri, declaration.line, declaration.startColumn)[0];
        assert.ok(target?.compilerSymbolId);
        for (const [prefix, count] of [["#define DirectValue", 1], ["Print CopyValue(sourceValue)", 1], ["Print TwiceValue(sourceValue)", 2], ["Print NestedValue", 2]]) {
            const token = at(prefix, "sourceValue");
            assert.equal(model.sourceToExpanded.get(`${sourceUri}:${token.offset}`).length, count);
            assert.deepEqual(model.resolveAt(sourceUri, token.line, token.startColumn).map((entry) => entry.id), [target.id]);
            assert.equal(select(token)?.typeName, "double", prefix);
            if (count === 2) assert.equal(new Set(select(token).compilerExpressionIds).size, 2);
        }
        const start = at("Print TwiceValue(sourceValue +", "sourceValue");
        const literal = source.tokens.find((token) => token.line === start.line && token.name === "1");
        const expression = model.expressionAt(sourceUri, { line: start.line, character: start.startColumn }, { line: literal.line, character: literal.endColumn });
        assert.equal(expression?.typeName, "double");
        assert.equal(new Set(expression.compilerExpressionIds).size, 2);
        const doubledMember = at("Print TwiceValue(item.amount)", "amount");
        assert.ok(model.completeMembers(sourceUri, doubledMember.line, doubledMember.startColumn).some((entry) => entry.name.toLowerCase() === "amount"));
        assert.ok(model.visibleEntries(sourceUri, start.line, start.startColumn).some((entry) => entry.id === target.id));
        for (const [prefix, name] of [["Print JoinName", "source"], ["Print JoinName", "Value"], ["Print QuoteValue", "sourceValue"]]) {
            const token = at(prefix, name);
            assert.deepEqual(model.resolveAt(sourceUri, token.line, token.startColumn), []);
            assert.equal(select(token), null);
        }
        const created = at("DeclareValue", "createdValue");
        assert.equal(model.resolveAt(sourceUri, created.line, created.startColumn)[0]?.uri.fsPath, filePath);
        const member = at("Print ReadMember", "amount"), item = at("Print ReadMember", "item");
        assert.equal(model.resolveAt(sourceUri, member.line, member.startColumn)[0]?.name.toLowerCase(), "amount");
        assert.equal(model.expressionAt(sourceUri, { line: item.line, character: item.startColumn }, { line: member.line, character: member.endColumn }), null, "A comma-separated argument list is not the expanded member expression");
        assert.ok(analysis.macroGraph.nodes.some((node) => node.kind === "stringify" && node.first && node.second && node.target));
        const callbacks = analysis.macroGraph.nodes.filter((node) => node.kind === "callback");
        assert.ok(callbacks.length >= 2);
        for (const callback of callbacks) {
            assert.ok(callback.first && callback.second && callback.target, "Callbacks must retain inputs before the native argument table is released");
            assert.equal(createMacroProjector(analysis.macroGraph)(callback.id), null, "Callback output is not a verbatim argument copy");
        }
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), saved);
});

test("one physical macro argument can bind to different native symbols and types", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-macro-origins.bas");
    const text = "#macro READ_BOTH(value)\nPrint value\nScope\nDim value As Double\nPrint value\nEnd Scope\n#endmacro\nDim outside As Long\nREAD_BOTH(outside)\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/macro-map.bas" }, analysis, [{ uri: sourceUri, text }]);
    const token = model.getDocument(sourceUri).tokens.filter((token) => token.name === "outside").at(-1);
    assert.equal(model.sourceToExpanded.get(`${sourceUri}:${token.offset}`).length, 3);
    const targets = model.resolveAt(sourceUri, token.line, token.startColumn);
    assert.equal(targets.length, 2);
    assert.deepEqual(new Set(targets.map((entry) => entry.nativeSymbol.typeName)), new Set(["long", "double"]));
    assert.ok(!model.visibleEntries(sourceUri, token.line, token.startColumn).some((entry) => entry.name.toLowerCase() === "outside"));
    assert.equal(model.expressionAt(sourceUri, { line: token.line, character: token.startColumn }), null);
    assert.equal(model.expressionAt(sourceUri, { line: token.line, character: token.startColumn }, { line: token.line, character: token.endColumn }), null);
});

test("native preprocessor identities retain empty calls, definition parameters, and active epochs", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-preprocessor.bas");
    const text = fs.readFileSync(filePath, "utf8").replace("#undef CURRENT_STATE\n", "#undef CURRENT_STATE\nPrint inputValue\n");
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/macro-symbols.bas" }, analysis, [{ uri: sourceUri, text }]);
    const lines = text.split("\n"), source = model.getDocument(sourceUri);
    const at = (statement, name) => {
        const line = lines.indexOf(statement);
        assert.ok(line >= 0, statement);
        return model.resolveAt(sourceUri, line, statement.indexOf(name) + 1);
    };
    const macro = at("Print SCALE_VALUE(inputValue)", "SCALE_VALUE")[0];
    assert.match(macro.compilerPreprocessorId, /^macro:/);
    assert.equal(model.declarationTargets([macro]).length, 2);
    assert.equal(model.references(macro, true).length, 5);
    const callLine = lines.indexOf("Print SCALE_VALUE(inputValue)");
    assert.equal(model.completeMembers(sourceUri, callLine, 8), null, "A macro name is an ordinary completion context");
    assert.ok(model.visibleEntries(sourceUri, callLine, 8).some((entry) => entry.id === macro.id));
    assert.equal(at("#if defined(SCALE_VALUE)", "SCALE_VALUE")[0].id, macro.id);
    const qualified = at("#if defined(MacroQuery.qualifiedValue)", "qualifiedValue")[0];
    assert.equal(qualified.declaration.type, "const");
    assert.equal(qualified.name, "qualifiedValue");
    assert.equal(at("Print MacroQuery.qualifiedValue", "qualifiedValue")[0].id, qualified.id);
    const first = at("#define SCALE_VALUE(value) ((value) * 2)", "value")[0];
    const second = at("#define SCALE_VALUE(item) ((item) * 2)", "item")[0];
    assert.notEqual(first.id, second.id, "Equivalent definitions do not merge local parameter names");
    assert.equal(model.references(first, true).length, 2);
    assert.equal(model.references(second, true).length, 2);
    const empty = at("EMPTY_VALUE()", "EMPTY_VALUE")[0];
    assert.ok(empty);
    assert.equal(model.references(empty, true).length, 2, "Empty expansion still has a native invocation");
    const states = model.preprocessor.entries.filter((entry) => entry.name === "CURRENT_STATE");
    assert.equal(states.length, 2);
    assert.notEqual(states[0].id, states[1].id);
    assert.deepEqual(at("#ifndef CURRENT_STATE", "CURRENT_STATE"), [], "An absent-name query must remain unresolved");
    const calls = source.tokens.filter((token) => token.name === "CURRENT_STATE" && lines[token.line].startsWith("Print"));
    for (const [index, token] of calls.entries()) assert.equal(model.resolveAt(sourceUri, token.line, token.startColumn)[0].id, states[index].id);
    const between = lines.indexOf("Print inputValue");
    assert.equal(model.completeMembers(sourceUri, between, 6), null, "Ordinary native identifiers must not suppress global completion");
    assert.ok(!model.visibleEntries(sourceUri, between, 6).some((entry) => entry.name === "CURRENT_STATE"));
    const last = source.tokens.find((token) => token.line === calls.at(-1).line && token.name === "Print");
    assert.equal(model.visibleEntries(sourceUri, last.line, 1).find((entry) => entry.name === "CURRENT_STATE")?.id, states[1].id);
});

test("active #ifdef and #elseifdef directives retain selected macro identities", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-preprocessor.bas");
    const text = "#define PRIMARY_VALUE 1\n#ifdef PRIMARY_VALUE\nPrint 1\n#endif\n#if 0\n#elseifdef PRIMARY_VALUE\nPrint 2\n#endif\n#if 0\n#elseifndef MISSING_VALUE\nPrint 3\n#endif\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/macro-queries.bas" }, analysis, [{ uri: sourceUri, text }]);
    const lines = text.split("\n");
    const at = (statement, name) => {
        const line = lines.indexOf(statement);
        assert.ok(line >= 0, statement);
        return model.resolveAt(sourceUri, line, statement.lastIndexOf(name) + 1);
    };
    const macro = at("#define PRIMARY_VALUE 1", "PRIMARY_VALUE")[0];
    assert.ok(macro);
    assert.equal(at("#ifdef PRIMARY_VALUE", "PRIMARY_VALUE")[0]?.id, macro.id);
    assert.equal(at("#elseifdef PRIMARY_VALUE", "PRIMARY_VALUE")[0]?.id, macro.id);
    assert.deepEqual(at("#elseifndef MISSING_VALUE", "MISSING_VALUE"), [], "An absent-name query must not select an earlier macro.");
});

test("schema-21 defined-name probes supplement only exact compiler-selected macro references", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-preprocessor.bas");
    const text = "#define SIDE_VALUE 1\n#if defined(SIDE_VALUE)\nPrint SIDE_VALUE\n#endif\n";
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, text]]),
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    const probe = analysis.semanticPreprocessorFacts?.definedNameProbes.find((entry) =>
        entry.spelling.toLowerCase() === "side_value" && entry.defined && entry.physical);
    assert.ok(probe?.symbol, "the schema-21 sidecar should retain the selected macro identity");
    assert.ok(analysis.semanticBindings.some((binding) => binding.symbol === probe.symbol &&
        binding.role === "declaration" && binding.name.toLowerCase() === "side_value"));

    /* Remove only the independent trace query to prove that the sidecar probe
       fills an exact identifier occurrence, not a spelling-based guess. */
    const reducedAnalysis = {
        ...analysis,
        preprocessorGraph: {
            ...analysis.preprocessorGraph,
            references: analysis.preprocessorGraph.references.filter((reference) =>
                !(reference.role === "query" && reference.name.toLowerCase() === "side_value"))
        }
    };
    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/schema21-defined-probe.bas" },
        reducedAnalysis,
        [{ uri: sourceUri, text }]
    );
    const queryLine = 1;
    const queryColumn = text.split("\n")[queryLine].indexOf("SIDE_VALUE");
    const target = model.resolveAt(sourceUri, queryLine, queryColumn);
    assert.equal(target.length, 1);
    assert.equal(target[0].name.toLowerCase(), "side_value");
    assert.ok(model.preprocessor.bindings.some((binding) => binding.record.sidecarProbeId === probe.id),
        "the compiler query should remain available to project binding validation");
});

test("unfinished conditional directives complete only compiler-active macro names", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-preprocessor.bas");
    const text = "#define ACTIVE_VALUE 1\n#define RETIRED_VALUE 1\n#undef RETIRED_VALUE\n#if defined(\nPrint ACTIVE_VALUE\n#endif\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]), allowErrors: true });
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/directive-completion.bas" }, analysis, [{ uri: sourceUri, text }]);
    const names = model.visibleEntries(sourceUri, 3, "#if defined(".length).map((entry) => entry.name);
    assert.ok(names.includes("ACTIVE_VALUE"));
    assert.ok(!names.includes("RETIRED_VALUE"));
});

test("shared-header conditional completion intersects every compiler macro context", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-context.bas");
    const headerPath = path.resolve(__dirname, "integration/workspace/compiler-defines.bi");
    const text = [
        "#define SHARED_COMPLETION 1",
        "#define FIRST_ONLY_COMPLETION 1",
        "#include \"compiler-defines.bi\"",
        "#undef FIRST_ONLY_COMPLETION",
        "#define SECOND_ONLY_COMPLETION 1",
        "#include \"compiler-defines.bi\"",
        ""
    ].join("\n");
    const headerText = "#if defined(\n#endif\n";
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, text], [headerPath, headerText]]),
        allowErrors: true
    });
    assert.equal(analysis.preprocessorGraph.contexts.length, 2,
        "the same physical conditional should retain both include environments");
    const sourceUri = uri(filePath);
    const headerUri = uri(headerPath);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/shared-header-completion.bas" }, analysis, [
        { uri: sourceUri, text },
        { uri: headerUri, text: headerText }
    ]);
    const names = new Set(model.visibleEntries(headerUri, 0, "#if defined(".length).map((entry) => entry.name));

    assert.ok(names.has("SHARED_COMPLETION"), "macros visible at every include site should remain available");
    assert.ok(!names.has("FIRST_ONLY_COMPLETION"), "a macro removed before the later include must not leak in");
    assert.ok(!names.has("SECOND_ONLY_COMPLETION"), "a macro available at only one include site must not leak in");
});

test("unfinished conditional directives use the compiler environment after an include", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-context.bas");
    const headerPath = path.resolve(__dirname, "integration/workspace/compiler-defines.bi");
    for (const bom of ["", "\uFEFF"]) for (const newline of ["\n", "\r\n", "\r"]) {
        const text = ("#include once \"compiler-defines.bi\"\n#if defined(\nPrint 1\n#endif\n").replace(/\n/g, newline);
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, bom + text]]), allowErrors: true });
        assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
        assert.equal(analysis.protocolVersion, 14);
        assert.equal(analysis.preprocessorGraph.contexts.length, 1);
        const sourceUri = uri(filePath);
        const headerUri = uri(headerPath);
        const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/directive-include-completion.bas" }, analysis, [
            { uri: sourceUri, text: bom + text },
            { uri: headerUri, text: fs.readFileSync(headerPath, "utf8") }
        ]);
        assert.ok(model.visibleEntries(sourceUri, 1, "#if defined(".length).some((entry) => entry.name === "DECLARE_VALUE"));
    }
});

test("skipped conditional directives retain included compiler macro completion", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-context.bas");
    const headerPath = path.resolve(__dirname, "integration/workspace/compiler-defines.bi");
    const text = "#include once \"compiler-defines.bi\"\n#if 0\n#if defined(\n#endif\n#endif\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    assert.deepEqual(analysis.completion, { errorCount: 0, reachedEnd: true });
    assert.equal(analysis.preprocessorGraph.contexts.length, 2);
    const sourceUri = uri(filePath);
    const headerUri = uri(headerPath);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/skipped-directive-completion.bas" }, analysis, [
        { uri: sourceUri, text },
        { uri: headerUri, text: fs.readFileSync(headerPath, "utf8") }
    ]);
    assert.ok(model.visibleEntries(sourceUri, 2, "#if defined(".length).some((entry) => entry.name === "DECLARE_VALUE"));
});

test("skipped elseif directives retain included compiler macro completion", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-context.bas");
    const headerPath = path.resolve(__dirname, "integration/workspace/compiler-defines.bi");
    const text = "#include once \"compiler-defines.bi\"\n#if 0\n#if 1\n#elseifdef\n#endif\n#endif\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    assert.deepEqual(analysis.completion, { errorCount: 0, reachedEnd: true });
    assert.equal(analysis.preprocessorGraph.contexts.length, 3);
    const sourceUri = uri(filePath);
    const headerUri = uri(headerPath);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/skipped-elseif-completion.bas" }, analysis, [
        { uri: sourceUri, text },
        { uri: headerUri, text: fs.readFileSync(headerPath, "utf8") }
    ]);
    assert.ok(model.visibleEntries(sourceUri, 3, "#elseifdef".length).some((entry) => entry.name === "DECLARE_VALUE"));
});

test("unexpanded replacement identifiers retain deferred physical preprocessor records", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-preprocessor.bas");
    const text = "#define KNOWN_VALUE 1\n#define UNUSED_VALUE(dummy) KNOWN_VALUE\nPrint 1\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const deferred = analysis.preprocessorGraph.references.find((record) => record.role === "deferred" && record.name === "KNOWN_VALUE");
    assert.ok(deferred, "An unexpanded replacement identifier must remain visible to project safety checks.");
    assert.equal(deferred.symbol, 0, "Definition-time text must not claim an invocation-time macro identity.");
    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/deferred-macro.bas" }, analysis, [{ uri: sourceUri, text }]);
    const line = text.split("\n")[1], character = line.lastIndexOf("KNOWN_VALUE") + 1;
    assert.deepEqual(model.resolveAt(sourceUri, 1, character), [], "An unexpanded replacement identifier must remain unresolved.");
    assert.deepEqual(model.compilerDeferredMacroReferenceAt(sourceUri, { line: 1, character }), {
        name: "KNOWN_VALUE", outcome: "unexpanded"
    }, "the editor can explain why no target is available without guessing one");
});

test("unambiguous expanded replacement identifiers retain their compiler-selected macro target", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-preprocessor.bas");
    const text = "#define KNOWN_VALUE 1\n#define EXPAND_VALUE(dummy) KNOWN_VALUE\nPrint EXPAND_VALUE(0)\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/expanded-deferred-macro.bas" }, analysis, [{ uri: sourceUri, text }]);
    const line = text.split("\n")[1], character = line.lastIndexOf("KNOWN_VALUE") + 1;
    const known = model.preprocessor.entries.find((entry) => entry.name === "KNOWN_VALUE");
    assert.ok(known);
    assert.deepEqual(model.resolveAt(sourceUri, 1, character).map((entry) => entry.id), [known.id]);
    assert.equal(model.compilerDeferredMacroReferenceAt(sourceUri, { line: 1, character }), null,
        "a unique observed expansion should use its actual compiler-selected definition instead");
    assert.deepEqual(model.references(known, true).map((entry) => [entry.occurrence.line, entry.occurrence.startColumn]), [[0, 8], [1, 28]]);
});

test("replacement identifiers with multiple observed macro targets remain unresolved", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-preprocessor.bas");
    const text = "#define TARGET_VALUE 1\n#define EXPAND_TARGET(dummy) TARGET_VALUE\nPrint EXPAND_TARGET(0)\n#undef TARGET_VALUE\n#define TARGET_VALUE 2\nPrint EXPAND_TARGET(0)\n";
    const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, text]]) });
    const sourceUri = uri(filePath);
    const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/ambiguous-deferred-macro.bas" }, analysis, [{ uri: sourceUri, text }]);
    const line = text.split("\n")[1], character = line.lastIndexOf("TARGET_VALUE") + 1;
    assert.deepEqual(model.resolveAt(sourceUri, 1, character), []);
    assert.deepEqual(model.compilerDeferredMacroReferenceAt(sourceUri, { line: 1, character }), {
        name: "TARGET_VALUE", outcome: "ambiguous"
    }, "different observed expansions should explain the ambiguity without selecting a target");
});

test("native macro recovery preserves independent optional-parenthesis and variadic definitions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-preprocessor.bas");
    const text = "' café 🌍\n#macro ShowOne? (arg)\nPrint arg\n#endmacro\nShowOne 1\n#define BROKEN(dup, dup) dup\n#define SumRest(first, tail...) ((first) + (tail))\nPrint SumRest(1, 2)\nPrint missingValue +\n#define RECURSIVE_VALUE RECURSIVE_VALUE\nPrint RECURSIVE_VALUE\n";
    for (const bom of ["", "\uFEFF"]) {
        const analysis = await analyzeSavedModule({ compilerPath: process.env.FBC_EDITOR_EXECUTABLE, filePath, overlays: new Map([[filePath, bom + text]]), allowErrors: true });
        assert.equal(analysis.partial, true);
        assert.equal(analysis.completion.reachedEnd, true);
        const sourceUri = uri(filePath);
        const model = new CompilerSemanticModel({ toString: () => "freebasic-preprocessed:/macro-recovery.bas" }, analysis, [{ uri: sourceUri, text }]);
        const declarations = model.preprocessor.entries.filter((entry) => entry.declaration.type === "macro");
        assert.ok(!declarations.some((entry) => entry.name === "BROKEN"));
        const optional = declarations.find((entry) => entry.name === "ShowOne"), variadic = declarations.find((entry) => entry.name === "SumRest");
        assert.ok(optional && variadic);
        assert.equal(optional.preprocessorRecord.flags & 8, 0);
        assert.equal(variadic.preprocessorRecord.flags & 4, 4);
        assert.equal(variadic.declaration.parameters[1].label, "tail...");
        assert.equal(model.references(optional, true).length, 2);
        assert.equal(model.references(variadic, true).length, 2);
        const missing = model.getDocument(sourceUri).tokens.find((token) => token.name === "missingValue");
        assert.deepEqual(model.resolveAt(sourceUri, missing.line, missing.startColumn), []);
        assert.equal(model.expressionAt(sourceUri, { line: missing.line, character: missing.startColumn }), null);
        const available = model.visibleEntries(sourceUri, missing.line, missing.startColumn);
        assert.ok(available.some((entry) => entry.id === variadic.id));
        assert.ok(!available.some((entry) => entry.name === "RECURSIVE_VALUE"), "Later macro definitions must not leak into the failed line's context");
        const recursive = declarations.find((entry) => entry.name === "RECURSIVE_VALUE");
        assert.equal(model.references(recursive, true).length, 3, "The failed recursive invocation still retains its selected macro identity");
    }
});

/* end of compiler-macros.test.js */
