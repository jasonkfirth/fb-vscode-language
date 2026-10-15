/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/compiler-recovery.test.js
    Purpose: Validate conservative compiler-backed behavior after parser recovery.
    Responsibilities: cover recovered symbols and expression authority boundaries.
    Does not contain: compiler instrumentation or recovery heuristics.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { analyzeSavedModule, decodeCompilerSourceBuffer } = require("../lib/compiler-analysis");
const { CompilerSemanticModel } = require("../lib/compiler-semantic-model");

function uri(filePath) {
    return { fsPath: filePath, toString: () => `file://${filePath}` };
}

test("native recovery keeps a synthesized formal parameter type provisional", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const original = fs.readFileSync(filePath, "utf8");
    const text = [
        "Function Broken(ByVal item As ) As Long",
        "    Return item + 1",
        "End Function",
        "Print Broken(1)",
        "Dim stable As Double",
        "Print stable * 2",
        ""
    ].join("\n");
    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        overlays: new Map([[filePath, text]]),
        allowErrors: true,
        exportSemanticExpressions: true,
        requireSemanticModel: true
    });
    assert.deepEqual(analysis.completion, { errorCount: 1, reachedEnd: true });
    assert.equal(analysis.semanticModelRecovery, true);

    const parameter = analysis.scopeGraph.declarations.find((declaration) => declaration.name.toLowerCase() === "item");
    const procedure = analysis.scopeGraph.declarations.find((declaration) => declaration.name.toLowerCase() === "broken");
    assert.ok(parameter?.invalid);
    assert.ok(procedure?.invalid);
    assert.ok(analysis.recoverySymbols.includes(parameter.symbol));
    assert.ok(analysis.recoverySymbols.includes(procedure.symbol));
    assert.equal(analysis.symbolGraph.symbols.find((symbol) => symbol.id === parameter.symbol)?.typeName.toLowerCase(), "integer",
        "The parser's fallback type is retained only as provisional compiler recovery state.");

    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/synthesized-parameter-recovery.bas" },
        analysis,
        [{ uri: uri(filePath), text }]
    );
    const lines = text.split("\n");
    for (const [line, name] of [[0, "item"], [1, "item"]]) {
        assert.deepEqual(model.resolveAt(uri(filePath), line, lines[line].indexOf(name)), [],
            "A parser-synthesized parameter must not become a valid source binding.");
    }

    const bodyExpression = model.expressionAt(uri(filePath), { line: 1, character: 11 }, { line: 1, character: 19 });
    assert.equal(bodyExpression?.typeName.toLowerCase(), "integer");
    assert.equal(bodyExpression?.provisional, true);
    const recoveredCall = model.expressionAt(uri(filePath), { line: 3, character: 6 }, { line: 3, character: 15 });
    assert.equal(recoveredCall?.typeName.toLowerCase(), "integer");
    assert.equal(recoveredCall?.provisional, true);
    const independent = model.expressionAt(uri(filePath), { line: 5, character: 6 }, { line: 5, character: 16 });
    assert.equal(independent?.typeName.toLowerCase(), "double");
    assert.equal(independent?.provisional, false);
    assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("native recovery combines multiple parser repairs with nested-scope recovery", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async () => {
    const filePath = path.resolve(__dirname, "integration/workspace/compiler-expression-surface.bas");
    const original = fs.readFileSync(filePath, "utf8");
    const cases = [
        {
            label: "balanced scopes",
            source: [
                "Namespace RecoverySpace",
                "Function Broken(ByVal source As Double) As Double",
                "    Dim value As Double",
                "    Print value * 2",
                "    Print Cast(",
                "    Print value * 3",
                "    Print New (",
                "    Print value * 4",
                "    Return value",
                "End Function",
                "End Namespace",
                ""
            ].join("\n"),
            expectedScopeRecovery: false
        },
        {
            label: "unterminated nested scopes",
            source: [
                "Namespace RecoverySpace",
                "Function Broken(ByVal source As Double) As Double",
                "    Dim value As Double",
                "    Print value * 2",
                "    Print Cast(",
                "    Print value * 3",
                "    Print New (",
                "    Print value * 4",
                ""
            ].join("\n"),
            expectedScopeRecovery: true
        }
    ];

    for (const recoveryCase of cases) {
        const analysis = await analyzeSavedModule({
            compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
            filePath,
            overlays: new Map([[filePath, recoveryCase.source]]),
            allowErrors: true,
            exportSemanticExpressions: true,
            requireSemanticModel: true
        });
        assert.ok(analysis.completion.errorCount >= 2, recoveryCase.label);
        assert.equal(analysis.completion.reachedEnd, true, recoveryCase.label);
        assert.equal(analysis.semanticModelRecovery, true, recoveryCase.label);
        assert.ok(analysis.semanticExpressions.every((fact) => fact.recovery), recoveryCase.label);

        const sourceUri = uri(filePath);
        const traceModel = new CompilerSemanticModel(
            { toString: () => `freebasic-preprocessed:/recovery-trace-${recoveryCase.label}.bas` },
            analysis,
            [{ uri: sourceUri, text: recoveryCase.source }]
        );
        const sidecarModel = new CompilerSemanticModel(
            { toString: () => `freebasic-preprocessed:/recovery-sidecar-${recoveryCase.label}.bas` },
            { ...analysis, expressions: [], expressionGraph: { nodes: [] } },
            [{ uri: sourceUri, text: recoveryCase.source }]
        );
        const lines = recoveryCase.source.split("\n");
        const typedLine = lines.findIndex((line) => line.includes("Print value * 4"));
        const typedCharacter = lines[typedLine].indexOf("value * 4");
        const start = { line: typedLine, character: typedCharacter };
        const end = { line: typedLine, character: typedCharacter + "value * 4".length };
        const traceType = traceModel.expressionAt(sourceUri, start, end);
        const sidecarType = sidecarModel.expressionAt(sourceUri, start, end);

        assert.equal(traceType?.typeName.toLowerCase(), "double", recoveryCase.label);
        assert.equal(traceType?.provisional, recoveryCase.expectedScopeRecovery, recoveryCase.label);
        assert.equal(sidecarType?.typeName.toLowerCase(), "double", recoveryCase.label);
        assert.equal(sidecarType?.semanticSource, "compiler-sidecar-recovery", recoveryCase.label);
        assert.equal(sidecarType?.provisional, true, recoveryCase.label);

        for (const badText of ["Print Cast(", "Print New ("]) {
            const badLine = lines.findIndex((line) => line.trim() === badText);
            const badCharacter = lines[badLine].indexOf(badText) + "Print ".length;
            assert.equal(traceModel.expressionAt(sourceUri, { line: badLine, character: badCharacter }), null,
                `${recoveryCase.label}: trace must withhold ${badText}`);
            assert.equal(sidecarModel.expressionAt(sourceUri, { line: badLine, character: badCharacter }), null,
                `${recoveryCase.label}: sidecar must withhold ${badText}`);
        }

        assert.equal(fs.readFileSync(filePath, "utf8"), original, "Unsaved recovery analysis must not modify the fixture on disk.");
    }
});

test("native recovery withholds incomplete namespace inputs in a broken unsaved header", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-namespace-header-recovery-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "main.bas");
    const headerPath = path.join(directory, "namespace-recovery.bi");
    const rootText = [
        "Dim stableBefore As Double",
        "Print stableBefore * 2",
        '#include "namespace-recovery.bi"',
        "Dim stableAfter As Double",
        "Print stableAfter * 2",
        ""
    ].join("\n");
    const savedHeader = "Namespace SavedNamespace\nEnd Namespace\n";
    const headerText = [
        "Namespace TargetScope",
        "    Const targetValue As Long = 1",
        "End Namespace",
        "Namespace RecoveryScope",
        "    Using TargetScope",
        "    Dim brokenValue As Long =",
        "End Namespace",
        ""
    ].join("\n");
    fs.writeFileSync(filePath, rootText);
    fs.writeFileSync(headerPath, savedHeader);

    const analysis = await analyzeSavedModule({
        compilerPath: process.env.FBC_EDITOR_EXECUTABLE,
        filePath,
        compilerArguments: ["-i", directory],
        overlays: new Map([[filePath, rootText], [headerPath, headerText]]),
        allowErrors: true,
        exportSemanticBindings: true,
        requireSemanticModel: true
    });
    assert.equal(analysis.partial, true);
    assert.equal(analysis.completion.reachedEnd, true);
    assert.ok(analysis.dependencies.includes(headerPath));
    assert.ok(analysis.errorPositions.some((error) => error.sourceFile === headerPath));
    assert.equal(analysis.semanticNamespaceImportRecipients.length, 0,
        "an incomplete full sidecar must not leak a partial namespace import receipt");
    assert.ok(!analysis.semanticCapabilities.some((capability) =>
        capability.feature === "namespace-import-recipient-inputs" && capability.coverage === "available"),
    "the incomplete model must not claim complete namespace import coverage");

    const rootUri = uri(filePath);
    const headerUri = uri(headerPath);
    const overlays = new Map([[filePath, rootText], [headerPath, headerText]]);
    const sources = analysis.dependencies.filter((file) => fs.existsSync(file)).map((file) => ({
        uri: uri(file),
        text: overlays.has(file) ? overlays.get(file) : decodeCompilerSourceBuffer(fs.readFileSync(file), file).replace(/^\uFEFF/, "")
    }));
    const model = new CompilerSemanticModel(
        { toString: () => "freebasic-preprocessed:/namespace-header-recovery.bas" },
        analysis,
        sources
    );
    const expressionAt = (text, document, line, expression) => {
        const character = text.split("\n")[line].indexOf(expression);
        assert.ok(character >= 0, expression);
        return model.expressionAt(document, { line, character }, { line, character: character + expression.length });
    };
    const before = expressionAt(rootText, rootUri, 1, "stableBefore * 2");
    assert.equal(before?.typeName.toLowerCase(), "double");
    assert.equal(before?.provisional, false);
    const after = expressionAt(rootText, rootUri, 4, "stableAfter * 2");
    assert.equal(after?.typeName.toLowerCase(), "double");
    assert.equal(after?.provisional, false,
        "a closed accepted namespace before a later bad declaration must not taint the independent root expression");
    assert.equal(fs.readFileSync(filePath, "utf8"), rootText);
    assert.equal(fs.readFileSync(headerPath, "utf8"), savedHeader,
        "broken unsaved namespace analysis must not write either source file");
});

/* end of tests/compiler-recovery.test.js */
