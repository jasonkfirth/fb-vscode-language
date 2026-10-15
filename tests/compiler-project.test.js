/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/compiler-project.test.js
    Purpose: Verify project-wide compiler validation and refusal boundaries.
    Responsibilities: test shared headers, build contexts, collisions, and races.
    Does not contain: saved source edits or a substitute FreeBASIC compiler.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { CompilerAnalysisService } = require("../lib/compiler-analysis-service");
const { CompilerProject, projectContexts } = require("../lib/compiler-project");
const { collectProjectEdits, generatedSymbolEdit } = require("../lib/compiler-project-bindings");
const { executeBoundedProcess } = require("../lib/compiler-diagnostics");
const supportsIntelInlineAssembly = ["ia32", "x64"].includes(process.arch);

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-project-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sources = {
        "api.bi": "#ifdef ALTERNATE\nType InputType As Double\n#else\nType InputType As Long\n#endif\nDeclare Function AdjustValue(ByVal value As InputType) As InputType\n",
        "implementation.bas": '#include "api.bi"\nFunction AdjustValue(ByVal value As InputType) As InputType\n Return value\nEnd Function\n',
        "caller.bas": '#include "api.bi"\nPrint AdjustValue(1)\n'
    };
    for (const [name, text] of Object.entries(sources)) fs.writeFileSync(path.join(root, name), text);
    const uri = (file) => ({ scheme: "file", fsPath: file, toString: () => `file://${file}` });
    const values = {
        "analysis.compilerPath": process.env.FBC_EDITOR_EXECUTABLE,
        "analysis.projectContexts": [{ name: "normal", modules: ["implementation.bas", "caller.bas"] }, { name: "alternate", modules: ["implementation.bas", "caller.bas"], arguments: ["-d", "ALTERNATE"] }]
    };
    const document = { uri: uri(path.join(root, "caller.bas")), languageId: "freebasic", getText: () => fs.readFileSync(path.join(root, "caller.bas"), "utf8") };
    const workspace = { isTrusted: true, textDocuments: [document], getWorkspaceFolder: () => ({ uri: uri(root) }), getConfiguration: () => ({ get: (name, fallback) => values[name] ?? fallback }) };
    const vscode = {
        workspace, Uri: {
            file: uri,
            from: (value) => ({ ...value, toString: () => `${value.scheme}:${value.path}?${value.query}` }),
            parse: (value) => ({ scheme: value.slice(0, value.indexOf(":")), fsPath: "", path: value.slice(value.indexOf(":") + 1), toString: () => value })
        },
        Range: class { constructor(line, start, endLine, end) { this.start = { line, character: start }; this.end = { line: endLine, character: end }; } },
        Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
        WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, newText) { this.edits.push({ uri, range, newText }); } },
        window: { showInformationMessage() {}, showWarningMessage() {} }
    };
    const index = { documents: new Map(), ensureInitialized: async () => true, notifyChange() {} };
    const service = new CompilerAnalysisService(vscode, index, { appendLine() {} });
    t.after(() => service.dispose());
    return { project: new CompilerProject(vscode, service), service, document, values, root, sources };
}

function alterConstructionObservationTarget(analysis, index = 0) {
    const observations = (analysis.semanticProperties || []).filter((property) =>
        property.domain === "symbol" && property.name.startsWith("construction-observation:") &&
        typeof property.value === "string" && property.value.split("\t").length === 6);
    const observation = observations[index < 0 ? observations.length + index : index];
    if (!observation || !Number.isSafeInteger(observation.identity)) return false;
    const fields = observation.value.split("\t");
    fields[0] = String(observation.identity);
    analysis.semanticProperties = analysis.semanticProperties.map((property) => property === observation
        ? { ...property, value: fields.join("\t") }
        : property);
    return true;
}

test("project refactoring requires explicit bounded configurations", () => {
    assert.throws(() => projectContexts({ get: (_name, fallback) => fallback }, process.cwd()), /disabled/);
    const get = (context) => ({ get: (name, fallback) => name === "analysis.projectContexts" ? [context] : fallback });
    assert.throws(() => projectContexts(get({ name: "bad", modules: ["*.bas"], arguments: ["-x", "output"] }), process.cwd()), /does not accept/);
    assert.throws(() => projectContexts(get({ name: "large", modules: Array(129).fill("main.bas") }), process.cwd()), /128/);
});

test("project references join exact compiler-bound sites across configured modules", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerPath = path.join(context.root, "shared.bi");
    const header = "Dim Shared projectReferenceValue As Long\n";
    const caller = '#include "shared.bi"\nSub Caller()\n    projectReferenceValue = 1\nEnd Sub\n';
    const other = '#include "shared.bi"\nSub Other()\n    Print projectReferenceValue\nEnd Sub\n';
    const otherPath = path.join(context.root, "other.bas");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, caller);
    fs.writeFileSync(otherPath, other);
    context.values["analysis.projectContexts"] = [{
        name: "references",
        modules: ["caller.bas", "other.bas"]
    }];
    context.values["analysis.activeContext"] = { name: "references", module: "caller.bas" };

    const selectedColumn = caller.split("\n")[2].indexOf("projectReferenceValue");
    const references = await context.project.references(
        context.document, { line: 2, character: selectedColumn }, true
    );
    const actual = references.map((reference) => [
        reference.uri.fsPath,
        reference.range.start.line,
        reference.range.start.character,
        reference.range.end.character
    ]).sort((first, second) => first[0].localeCompare(second[0]) || first[1] - second[1]);

    assert.deepEqual(actual, [
        [headerPath, 0, header.indexOf("projectReferenceValue"),
            header.indexOf("projectReferenceValue") + "projectReferenceValue".length],
        [context.document.uri.fsPath, 2, selectedColumn, selectedColumn + "projectReferenceValue".length],
        [otherPath, 2, other.split("\n")[2].indexOf("projectReferenceValue"),
            other.split("\n")[2].indexOf("projectReferenceValue") + "projectReferenceValue".length]
    ].sort((first, second) => first[0].localeCompare(second[0]) || first[1] - second[1]),
    "compiler-bound references should include the shared header and both configured modules");
    assert.equal(fs.readFileSync(headerPath, "utf8"), header);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), caller);
    assert.equal(fs.readFileSync(otherPath, "utf8"), other);
});

test("project references preserve the compiler-selected overload across modules", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerPath = path.join(context.root, "overloads.bi");
    const header = [
        "Declare Function projectPick Overload(ByVal value As Long) As Long",
        "Declare Function projectPick Overload(ByVal value As Double) As Long",
        ""
    ].join("\n");
    const caller = [
        '#include "overloads.bi"',
        "Function projectPick Overload(ByVal value As Long) As Long",
        "    Return value",
        "End Function",
        "Function projectPick Overload(ByVal value As Double) As Long",
        "    Return CLng(value)",
        "End Function",
        "Sub Caller()",
        "    Print projectPick(2.5)",
        "    Print projectPick(2)",
        "End Sub",
        ""
    ].join("\n");
    const other = [
        '#include "overloads.bi"',
        "Sub Other()",
        "    Print projectPick(2.5)",
        "End Sub",
        ""
    ].join("\n");
    const otherPath = path.join(context.root, "other.bas");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, caller);
    fs.writeFileSync(otherPath, other);
    context.values["analysis.projectContexts"] = [
        { name: "overload-references", modules: ["caller.bas", "other.bas"] },
        { name: "overload-references-x86", modules: ["caller.bas", "other.bas"], arguments: ["-arch", "386"] }
    ];
    context.values["analysis.activeContext"] = { name: "overload-references", module: "caller.bas" };

    const call = "projectPick(2.5)";
    const callColumn = caller.split("\n")[8].indexOf(call);
    const references = await context.project.references(
        context.document, { line: 8, character: callColumn }, true
    );
    const actual = references.map((reference) => [reference.uri.fsPath,
        reference.range.start.line, reference.range.start.character, reference.range.end.character])
        .sort((first, second) => first[0].localeCompare(second[0]) || first[1] - second[1] || first[2] - second[2]);
    const expected = [
        [headerPath, 1, header.split("\n")[1].indexOf("projectPick"),
            header.split("\n")[1].indexOf("projectPick") + "projectPick".length],
        [context.document.uri.fsPath, 4, caller.split("\n")[4].indexOf("projectPick"),
            caller.split("\n")[4].indexOf("projectPick") + "projectPick".length],
        [context.document.uri.fsPath, 8, callColumn, callColumn + "projectPick".length],
        [otherPath, 2, other.split("\n")[2].indexOf("projectPick"),
            other.split("\n")[2].indexOf("projectPick") + "projectPick".length]
    ].sort((first, second) => first[0].localeCompare(second[0]) || first[1] - second[1] || first[2] - second[2]);

    assert.deepEqual(actual, expected,
        "Find References should include only the Double overload's declaration, definition, and compiler-bound calls");
    assert.equal(fs.readFileSync(headerPath, "utf8"), header);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), caller);
    assert.equal(fs.readFileSync(otherPath, "utf8"), other);
});

test("stock FBC sidecar joins saved compiler-bound references across configured modules", { skip: !process.env.FBC_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerPath = path.join(context.root, "shared.bi");
    const header = "Dim Shared stockProjectReferenceValue As Long\n";
    const caller = '#include "shared.bi"\nSub Caller()\n    stockProjectReferenceValue = 1\nEnd Sub\n';
    const other = '#include "shared.bi"\nSub Other()\n    Print "é"; stockProjectReferenceValue\nEnd Sub\n';
    const otherPath = path.join(context.root, "other.bas");
    const unrelatedPath = path.join(context.root, "unrelated.bas");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, caller);
    fs.writeFileSync(otherPath, other);
    fs.writeFileSync(unrelatedPath, "Dim unrelatedValue As Long\n");
    context.service.vscode.workspace.textDocuments.push({
        uri: {
            scheme: "file",
            fsPath: unrelatedPath,
            toString: () => `file://${unrelatedPath}`
        },
        isDirty: true,
        getText: () => "Dim unrelatedValue As Long\nunrelatedValue = 2\n"
    });
    context.values["analysis.compilerPath"] = "";
    context.values["compiler.path"] = process.env.FBC_EXECUTABLE;
    context.values["analysis.projectContexts"] = [{
        name: "stock-references",
        modules: ["caller.bas", "other.bas"]
    }];
    context.values["analysis.activeContext"] = { name: "stock-references", module: "caller.bas" };

    const selectedColumn = caller.split("\n")[2].indexOf("stockProjectReferenceValue");
    const references = await context.project.references(
        context.document, { line: 2, character: selectedColumn }, true
    );
    const actual = references.map((reference) => [
        reference.uri.fsPath,
        reference.range.start.line,
        reference.range.start.character,
        reference.range.end.character
    ]).sort((first, second) => first[0].localeCompare(second[0]) || first[1] - second[1]);

    assert.deepEqual(actual, [
        [headerPath, 0, header.indexOf("stockProjectReferenceValue"),
            header.indexOf("stockProjectReferenceValue") + "stockProjectReferenceValue".length],
        [context.document.uri.fsPath, 2, selectedColumn, selectedColumn + "stockProjectReferenceValue".length],
        [otherPath, 2, other.split("\n")[2].indexOf("stockProjectReferenceValue"),
            other.split("\n")[2].indexOf("stockProjectReferenceValue") + "stockProjectReferenceValue".length]
    ].sort((first, second) => first[0].localeCompare(second[0]) || first[1] - second[1]),
    "stock sidecar references should include the shared declaration and configured modules");
    assert.equal(fs.readFileSync(headerPath, "utf8"), header);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), caller);
    assert.equal(fs.readFileSync(otherPath, "utf8"), other);
    assert.equal(fs.readFileSync(unrelatedPath, "utf8"), "Dim unrelatedValue As Long\n");
});

test("stock FBC project references join qualified conditional constant probes", { skip: !process.env.FBC_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerPath = path.join(context.root, "conditional.bi");
    const header = [
        "namespace ProjectConditionalNamespace",
        "    const ProjectConditionalValue = 1",
        "end namespace",
        ""
    ].join("\n");
    const caller = '#include "conditional.bi"\n#if defined(ProjectConditionalNamespace.ProjectConditionalValue)\nPrint 1\n#endif\n';
    const other = '#include "conditional.bi"\n#if defined(ProjectConditionalNamespace.ProjectConditionalValue)\nPrint 2\n#endif\n';
    const otherPath = path.join(context.root, "other.bas");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, caller);
    fs.writeFileSync(otherPath, other);
    context.values["analysis.compilerPath"] = "";
    context.values["compiler.path"] = process.env.FBC_EXECUTABLE;
    context.values["analysis.projectContexts"] = [{
        name: "conditional-references",
        modules: ["caller.bas", "other.bas"]
    }];
    context.values["analysis.activeContext"] = { name: "conditional-references", module: "caller.bas" };

    const selectedColumn = caller.split("\n")[1].lastIndexOf("ProjectConditionalValue");
    const references = await context.project.references(
        context.document, { line: 1, character: selectedColumn + 1 }, true
    );
    const actual = references.map((reference) => [
        reference.uri.fsPath,
        reference.range.start.line,
        reference.range.start.character,
        reference.range.end.character
    ]).sort((first, second) => first[0].localeCompare(second[0]) || first[1] - second[1]);

    assert.deepEqual(actual, [
        [headerPath, 1, header.split("\n")[1].indexOf("ProjectConditionalValue"),
            header.split("\n")[1].indexOf("ProjectConditionalValue") + "ProjectConditionalValue".length],
        [context.document.uri.fsPath, 1, selectedColumn, selectedColumn + "ProjectConditionalValue".length],
        [otherPath, 1, other.split("\n")[1].lastIndexOf("ProjectConditionalValue"),
            other.split("\n")[1].lastIndexOf("ProjectConditionalValue") + "ProjectConditionalValue".length]
    ].sort((first, second) => first[0].localeCompare(second[0]) || first[1] - second[1]),
    "project references should include the shared declaration and selected conditional probes in both modules");
    assert.equal(fs.readFileSync(headerPath, "utf8"), header);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), caller);
    assert.equal(fs.readFileSync(otherPath, "utf8"), other);
});

test("stock FBC project references include physical macro, conditional, and undef sites", { skip: !process.env.FBC_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerPath = path.join(context.root, "shared-macros.bi");
    const header = "#define ProjectSharedMacro 42\n";
    const caller = [
        '#include "shared-macros.bi"',
        "#ifdef ProjectSharedMacro",
        "Print ProjectSharedMacro",
        "#endif",
        ""
    ].join("\n");
    const other = [
        '#include "shared-macros.bi"',
        "#if defined(ProjectSharedMacro)",
        "Print ProjectSharedMacro",
        "#endif",
        "#undef ProjectSharedMacro",
        ""
    ].join("\n");
    const otherPath = path.join(context.root, "other.bas");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, caller);
    fs.writeFileSync(otherPath, other);
    context.values["analysis.compilerPath"] = "";
    context.values["compiler.path"] = process.env.FBC_EXECUTABLE;
    context.values["analysis.projectContexts"] = [{
        name: "macro-references",
        modules: ["caller.bas", "other.bas"]
    }];
    context.values["analysis.activeContext"] = { name: "macro-references", module: "caller.bas" };

    const selectedColumn = caller.split("\n")[2].indexOf("ProjectSharedMacro");
    const references = await context.project.references(
        context.document, { line: 1, character: selectedColumn + 1 }, true, null, true
    );
    const actual = references.map((reference) => [
        reference.uri.fsPath,
        reference.range.start.line,
        reference.range.start.character,
        reference.range.end.character
    ]).sort((first, second) => first[0].localeCompare(second[0]) || first[1] - second[1]);

    assert.deepEqual(actual, [
        [headerPath, 0, header.indexOf("ProjectSharedMacro"),
            header.indexOf("ProjectSharedMacro") + "ProjectSharedMacro".length],
        [context.document.uri.fsPath, 1, 7, 7 + "ProjectSharedMacro".length],
        [context.document.uri.fsPath, 2, selectedColumn, selectedColumn + "ProjectSharedMacro".length],
        [otherPath, 1, 12, 12 + "ProjectSharedMacro".length],
        [otherPath, 2, 6, 6 + "ProjectSharedMacro".length],
        [otherPath, 4, 7, 7 + "ProjectSharedMacro".length]
    ].sort((first, second) => first[0].localeCompare(second[0]) || first[1] - second[1]),
    "the project result should join the shared macro declaration and physical root invocations");
    assert.equal(fs.readFileSync(headerPath, "utf8"), header);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), caller);
    assert.equal(fs.readFileSync(otherPath, "utf8"), other);
});

test("stock FBC project macro references refuse nested unprojectable expansions", { skip: !process.env.FBC_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerPath = path.join(context.root, "shared-macros.bi");
    const header = "#define ProjectNestedMacro 42\n#define ProjectMacroWrapper ProjectNestedMacro\n";
    const caller = '#include "shared-macros.bi"\nPrint ProjectNestedMacro\n';
    const other = '#include "shared-macros.bi"\nPrint ProjectMacroWrapper\n';
    const otherPath = path.join(context.root, "other.bas");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, caller);
    fs.writeFileSync(otherPath, other);
    context.values["analysis.compilerPath"] = "";
    context.values["compiler.path"] = process.env.FBC_EXECUTABLE;
    context.values["analysis.projectContexts"] = [{
        name: "nested-macro-references",
        modules: ["caller.bas", "other.bas"]
    }];
    context.values["analysis.activeContext"] = { name: "nested-macro-references", module: "caller.bas" };

    const selectedColumn = caller.split("\n")[1].indexOf("ProjectNestedMacro");
    const references = await context.project.references(
        context.document, { line: 1, character: selectedColumn + 1 }, true, null, true
    );

    assert.equal(references, null,
        "the cross-module result must be withheld when a configured root uses the target through a nested macro expansion");
});

test("stock FBC project navigation separates prototypes and implementations across modules", { skip: !process.env.FBC_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    context.values["analysis.compilerPath"] = "";
    context.values["compiler.path"] = process.env.FBC_EXECUTABLE;
    context.values["analysis.activeContext"] = { name: "normal", module: "caller.bas" };

    const callColumn = context.sources["caller.bas"].split("\n")[1].indexOf("AdjustValue");
    const position = { line: 1, character: callColumn };
    const definitions = await context.project.navigation(context.document, position, "definition");
    const declarations = await context.project.navigation(context.document, position, "declaration");
    const implementations = await context.project.navigation(context.document, position, "implementation");
    const locations = (entries) => entries.map((entry) => [
        entry.uri.fsPath,
        entry.range.start.line,
        entry.range.start.character,
        entry.range.end.character
    ]);

    assert.deepEqual(locations(definitions), [[
        path.join(context.root, "implementation.bas"),
        1,
        "Function ".length,
        "Function AdjustValue".length
    ]], "Go to Definition should prefer the compiler-bound body");
    assert.deepEqual(locations(declarations), [[
        path.join(context.root, "api.bi"),
        5,
        context.sources["api.bi"].split("\n")[5].indexOf("AdjustValue"),
        context.sources["api.bi"].split("\n")[5].indexOf("AdjustValue") + "AdjustValue".length
    ]], "Go to Declaration should return the prototype in the shared header");
    assert.deepEqual(locations(implementations), [[
        path.join(context.root, "implementation.bas"),
        1,
        "Function ".length,
        "Function AdjustValue".length
    ]], "Go to Implementation should find the compiler-bound body in another configured module");
});

test("editor-bridge project navigation finds an implementation outside the active module", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    context.values["analysis.activeContext"] = { name: "normal", module: "caller.bas" };

    const callColumn = context.sources["caller.bas"].split("\n")[1].indexOf("AdjustValue");
    const implementations = await context.project.navigation(
        context.document, { line: 1, character: callColumn }, "implementation"
    );

    assert.deepEqual(implementations.map((entry) => [
        entry.uri.fsPath,
        entry.range.start.line,
        entry.range.start.character,
        entry.range.end.character
    ]), [[
        path.join(context.root, "implementation.bas"),
        1,
        "Function ".length,
        "Function AdjustValue".length
    ]], "the bridge should find the compiler-bound body in another configured module");
});

test("project rename uses physical compiler bindings for conditional REM identifiers", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        '#lang "deprecated"',
        "#if 1",
        "Option NoKeyword REM",
        "#endif",
        "Sub RemRenameProbe()",
        "    Dim REM As Integer",
        "    REM = 1",
        "    Print REM",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    const sourceLines = source.split("\n");
    const lineOffsets = [0];
    for (const match of source.matchAll(/\n/g)) lineOffsets.push(match.index + 1);
    context.document.lineAt = (line) => ({ text: sourceLines[line] });
    context.document.offsetAt = (position) => lineOffsets[position.line] + position.character;
    context.values["analysis.projectContexts"] = [
        { name: "normal", modules: ["caller.bas"] },
        { name: "alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];
    const declarationLine = source.split("\n")[5];
    const position = { line: 5, character: declarationLine.indexOf("REM") + 1 };
    const edit = await context.project.rename(context.document, position, "renamedRemValue");

    assert.deepEqual(edit.edits.map((entry) => [entry.uri.fsPath,
        entry.range.start.line, entry.newText]), [
        [context.document.uri.fsPath, 5, "renamedRemValue"],
        [context.document.uri.fsPath, 6, "renamedRemValue"],
        [context.document.uri.fsPath, 7, "renamedRemValue"]
    ]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "project rename must return edits without modifying source files");
});

test("project rename follows a module-scope FBLite first-read variable", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        '#lang "fblite"',
        "Print implicitModuleValue",
        "Print implicitModuleValue",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    const sourceLines = source.split("\n");
    const lineOffsets = [0];
    for (const match of source.matchAll(/\n/g)) lineOffsets.push(match.index + 1);
    context.document.lineAt = (line) => ({ text: sourceLines[line] });
    context.document.offsetAt = (position) => lineOffsets[position.line] + position.character;
    context.values["analysis.projectContexts"] = [{
        name: "fblite-module-local",
        modules: ["caller.bas"],
        arguments: ["-lang", "fblite"]
    }, {
        name: "fblite-module-local-alternate",
        modules: ["caller.bas"],
        arguments: ["-lang", "fblite", "-d", "ALTERNATE"]
    }];
    context.values["analysis.activeContext"] = { name: "fblite-module-local", module: "caller.bas" };
    const firstReadColumn = sourceLines[1].indexOf("implicitModuleValue");

    const edit = await context.project.rename(context.document,
        { line: 1, character: firstReadColumn + 1 }, "renamedModuleValue");

    assert.deepEqual(edit.edits.map((entry) => [entry.uri.fsPath,
        entry.range.start.line, entry.newText]), [
        [context.document.uri.fsPath, 1, "renamedModuleValue"],
        [context.document.uri.fsPath, 2, "renamedModuleValue"]
    ]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "FBLite module-local rename should remain a validated preview without editing the source");
});

test("project rename validates an unsaved module-scope FBLite first-read variable", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const diskSource = fs.readFileSync(context.document.uri.fsPath);
    const overlay = [
        '#lang "fblite"',
        "Print implicitModuleValue",
        "Print implicitModuleValue",
        ""
    ].join("\n");
    const lines = overlay.split("\n");
    const lineOffsets = [0];
    for (const match of overlay.matchAll(/\n/g)) lineOffsets.push(match.index + 1);
    context.document.isDirty = true;
    context.document.version = 1;
    context.document.getText = () => overlay;
    context.document.lineAt = (line) => ({ text: lines[line] });
    context.document.offsetAt = (position) => lineOffsets[position.line] + position.character;
    context.values["analysis.projectContexts"] = [{
        name: "fblite-module-local",
        modules: ["caller.bas"],
        arguments: ["-lang", "fblite"]
    }, {
        name: "fblite-module-local-alternate",
        modules: ["caller.bas"],
        arguments: ["-lang", "fblite", "-d", "ALTERNATE"]
    }];
    context.values["analysis.activeContext"] = { name: "fblite-module-local", module: "caller.bas" };
    const firstReadColumn = lines[1].indexOf("implicitModuleValue");

    const edit = await context.project.rename(context.document,
        { line: 1, character: firstReadColumn + 1 }, "renamedModuleValue");

    assert.deepEqual(edit.edits.map((entry) => [entry.uri.fsPath,
        entry.range.start.line, entry.newText]), [
        [context.document.uri.fsPath, 1, "renamedModuleValue"],
        [context.document.uri.fsPath, 2, "renamedModuleValue"]
    ]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath).equals(diskSource), true,
        "unsaved module-local rename must validate the overlay without writing it to disk");
});

test("qualified compiler bindings audit the terminal source spelling", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-qualified-rename-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "module.bas");
    const uri = { scheme: "file", fsPath: file };
    const entry = { name: "ns.Target", compilerSymbolId: 1, uri, declaration: { line: 0, endColumn: 9 } };
    const declaration = (offset) => ({
        id: 1,
        kind: "declaration",
        name: "ns.Target",
        physical: { uri, occurrence: { name: "Target", kind: "identifier", offset, end: offset + 6, line: 0, startColumn: offset, endColumn: offset + 6 } }
    });
    const projectData = (bindings) => ({
        declarations: [entry], symbols: [], procedureIds: new Map(), dispatch: [],
        preprocessorReferences: [], nonRenameableProcedures: [], nonRenameableSymbols: [], bindings
    });
    const unit = {};
    const loadUnit = () => projectData([declaration(3)]);
    const key = `${file}:0:0`;

    const coveredSource = "ns.Target\n";
    fs.writeFileSync(file, coveredSource);
    const edits = collectProjectEdits([unit], key, "ns.Target", "RenamedTarget", new Map([[file, coveredSource]]), root, loadUnit, () => {});
    assert.equal(edits.get(file).get(3).newText, "RenamedTarget");

    const uncoveredSource = "ns.Target\nTarget\n";
    assert.throws(() => collectProjectEdits(
        [{}], key, "ns.Target", "RenamedTarget", new Map([[file, uncoveredSource]]), root, loadUnit, () => {}
    ), /not compiler-bound/);
});

test("generated symbol rename changes exactly one physical token-paste argument", () => {
    const uri = { scheme: "file", fsPath: "/workspace/caller.bas" };
    const argument = (name, outputStart, outputEnd, offset) => ({
        role: "argument", outputStart, outputEnd, uri,
        occurrence: { name, kind: "identifier", offset, end: offset + name.length }
    });
    const prefix = argument("my", 0, 2, 16);
    const suffix = argument("Value", 2, 7, 20);
    const binding = { name: "myValue", generatedParts: [prefix, suffix] };

    assert.deepEqual(generatedSymbolEdit(binding, "myValue", "otherValue"), [{
        physical: prefix, newText: "other"
    }]);
    assert.deepEqual(generatedSymbolEdit(binding, "myValue", "myItem"), [{
        physical: suffix, newText: "Item"
    }]);
    assert.equal(generatedSymbolEdit(binding, "myValue", "otherItem"), null,
        "Unanchored multi-argument renames with several minimum splits must remain ambiguous.");

    const repeated = argument("my", 0, 2, 30);
    const repeatedBinding = {
        name: "mymy",
        generatedParts: [repeated, { ...repeated, outputStart: 2, outputEnd: 4 }]
    };
    assert.deepEqual(generatedSymbolEdit(repeatedBinding, "mymy", "otherother"), [{
        physical: repeated, newText: "other"
    }], "Repeated output components from one source argument require one physical edit.");

    const anchoredPrefix = argument("my", 0, 2, 36);
    const anchoredSuffix = argument("Value", 6, 11, 42);
    const anchoredBinding = {
        name: "myNodeValue",
        generatedParts: [
            anchoredPrefix,
            { role: "definition", outputStart: 2, outputEnd: 6 },
            anchoredSuffix
        ]
    };
    assert.deepEqual(generatedSymbolEdit(anchoredBinding, "myNodeValue", "otherNodeItem"), [
        { physical: anchoredPrefix, newText: "other" },
        { physical: anchoredSuffix, newText: "Item" }
    ], "A fixed definition token can uniquely anchor edits to two physical arguments.");

    const ambiguousBinding = {
        name: "leftNodeRight",
        generatedParts: [
            argument("left", 0, 4, 50),
            { role: "definition", outputStart: 4, outputEnd: 8 },
            argument("Right", 8, 13, 60)
        ]
    };
    assert.equal(generatedSymbolEdit(ambiguousBinding, "leftNodeRight", "xNodeyNodez"), null,
        "Multiple valid placements of fixed replacement text must remain ambiguous.");
    assert.equal(generatedSymbolEdit(binding, "myValue", "x".repeat(129)), null,
        "Names beyond the compiler's bounded identifier size must not enter decomposition search.");

    assert.equal(generatedSymbolEdit({
        name: "myValue",
        generatedParts: [prefix, { role: "stringify", outputStart: 2, outputEnd: 7 }]
    }, "myValue", "otherValue"), null, "Transformed text is not an editable token component.");
});

test("project rename edits uniquely anchored components from multiple token-paste arguments", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "#define DECLARE_NAME(prefix, suffix) Dim prefix##Node##suffix As Long\nDECLARE_NAME(my, Value)\nPrint myNodeValue\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [
        { name: "multi-component", modules: ["caller.bas"] },
        { name: "multi-component-alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];
    context.values["analysis.activeContext"] = { name: "multi-component", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 2, character: 7 }, "otherNodeItem");
    assert.equal(edit.edits.length, 3);
    const argumentEdits = edit.edits.filter((entry) => entry.range.start.line === 1)
        .sort((left, right) => left.range.start.character - right.range.start.character);
    const reference = edit.edits.find((entry) => entry.range.start.line === 2);
    assert.deepEqual(argumentEdits.map((entry) => [
        source.split("\n")[1].slice(entry.range.start.character, entry.range.end.character),
        entry.newText
    ]), [["my", "other"], ["Value", "Item"]]);
    assert.equal(reference?.newText, "otherNodeItem");
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "multi-argument rename must remain a validated preview without writing source files");
});

test("conditional property-family matching keeps getter and setter identities separate", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-conditional-property-family-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "module.bas");
    const uri = { scheme: "file", fsPath: file };
    const source = "CurrentValue\nCurrentValue\nCurrentValue\n";
    const property = (id, line, propertyRole) => ({
        name: "CurrentValue", type: "property", propertyRole, qualifiedName: "Meter.CurrentValue",
        compilerSymbolId: id, uri, declaration: { line, endColumn: 12 }
    });
    const binding = (id, line) => ({
        id, kind: line < 2 ? "declaration" : "reference", name: "CurrentValue",
        physical: {
            uri,
            occurrence: {
                name: "CurrentValue", kind: "identifier", offset: line * 13, end: line * 13 + 12,
                line, startColumn: 0, endColumn: 12
            }
        }
    });
    const projectData = (entry, bindings) => ({
        declarations: [entry], symbols: [], procedureIds: new Map(), dispatch: [],
        preprocessorReferences: [], nonRenameableProcedures: [], nonRenameableSymbols: [], bindings
    });
    const unit = (name) => ({ job: { name } });
    const getter = unit("getter-context"), setter = unit("setter-context");
    const data = new Map([
        [getter, projectData(property(1, 0, "getter"), [binding(1, 0), binding(1, 2)])],
        [setter, projectData(property(2, 1, "setter"), [binding(2, 1), binding(2, 2)])]
    ]);

    assert.throws(() => collectProjectEdits(
        [getter, setter], `${file}:0:0`, "CurrentValue", "RenamedValue", new Map([[file, source]]), root, (value) => data.get(value), () => {}
    ), /binds to different declarations/);
});

test("rename target refreshes one worker model evicted by a preceding transaction", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-project-target-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filePath = path.join(root, "main.bas");
    fs.writeFileSync(filePath, "Dim nativeValue As Long\n");
    const uri = { scheme: "file", fsPath: filePath, toString: () => `file://${filePath}` };
    const entry = { name: "Qualified.nativeValue", compilerSymbolId: 17, uri, declaration: { line: 0, endColumn: 15 } };
    const occurrence = { name: "nativeValue", line: 0, startColumn: 4, endColumn: 15 };
    let model, refreshes = 0;
    const current = {
        remote: true,
        query: async () => {
            model = refreshed;
            return { entries: [], occurrence };
        }
    };
    const refreshed = {
        remote: true,
        query: async () => ({ entries: [entry], occurrence })
    };
    model = current;
    const configuration = {
        get(name, fallback) {
            if (name === "analysis.projectContexts") return [{ name: "main", modules: ["main.bas"] }];
            return fallback;
        }
    };
    const vscode = {
        Range: class { constructor(line, start, endLine, end) { this.start = { line, character: start }; this.end = { line: endLine, character: end }; } },
        workspace: {
            getConfiguration: () => configuration,
            getWorkspaceFolder: () => ({ uri: { fsPath: root } })
        }
    };
    const service = {
        contextFor: () => ({ signature: "native-target" }),
        getModel: () => model,
        check: async () => { refreshes++; return true; }
    };
    const project = new CompilerProject(vscode, service);
    const selected = await project.target({ uri }, { line: 0, character: 5 });
    assert.equal(selected.entry, entry);
    assert.equal(selected.occurrence, occurrence);
    assert.equal(refreshes, 1);
    const prepared = await project.prepare({ uri }, { line: 0, character: 5 });
    assert.equal(prepared.placeholder, "nativeValue");
});

test("real project rename joins shared prototypes and validates all configurations without saving", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const edit = await context.project.rename(context.document, { line: 1, character: 8 }, "ScaleValue");
    assert.equal(edit.edits.length, 3);
    assert.equal(new Set(edit.edits.map((entry) => path.basename(entry.uri.fsPath))).size, 3);
    assert.ok(edit.edits.every((entry) => entry.newText === "ScaleValue"));
    for (const [name, text] of Object.entries(context.sources)) assert.equal(fs.readFileSync(path.join(context.root, name), "utf8"), text);
});

test("project type rename preserves constructor relationships across twelve target ABI profiles", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type CrossTargetValue",
        "    marker As Long",
        "    Declare Constructor()",
        "End Type",
        "Constructor CrossTargetValue()",
        "    This.marker = 1",
        "End Constructor",
        "Dim item As CrossTargetValue = Type<CrossTargetValue>()",
        "Print item.marker",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [
        { name: "host-x86-32", modules: ["caller.bas"], arguments: ["-arch", "386"] },
        { name: "host-x86-64", modules: ["caller.bas"], arguments: ["-arch", "x86_64"] },
        { name: "target-armv7", modules: ["caller.bas"], arguments: ["-arch", "armv7-a"] },
        { name: "target-riscv32", modules: ["caller.bas"], arguments: ["-arch", "riscv32"] },
        { name: "target-riscv64", modules: ["caller.bas"], arguments: ["-arch", "riscv64"] },
        { name: "target-mips32", modules: ["caller.bas"], arguments: ["-arch", "mips32"] },
        { name: "target-mips32el", modules: ["caller.bas"], arguments: ["-arch", "mips32el"] },
        { name: "target-mips64", modules: ["caller.bas"], arguments: ["-arch", "mips64"] },
        { name: "target-mips64el", modules: ["caller.bas"], arguments: ["-arch", "mips64el"] },
        { name: "target-powerpc", modules: ["caller.bas"], arguments: ["-arch", "powerpc"] },
        { name: "target-powerpc64", modules: ["caller.bas"], arguments: ["-arch", "powerpc64"] },
        { name: "target-powerpc64le", modules: ["caller.bas"], arguments: ["-arch", "powerpc64le"] }
    ];
    context.values["analysis.activeContext"] = { name: "host-x86-64", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 0, character: 5 }, "RenamedCrossTargetValue");
    assert.ok(edit.edits.length >= 4, "The type declaration, constructor, and typed initializer uses must be joined.");
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedCrossTargetValue"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "Cross-target validation must produce a preview without writing either build context.");
});

test("native header typing and rename use the selected build while validating every project context", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const filePath = path.join(context.root, "api.bi");
    const text = context.sources["api.bi"] + "Function HeaderValue(ByVal headerInput As InputType) As InputType\n Return headerInput\nEnd Function\n";
    const header = { uri: context.service.vscode.Uri.file(filePath), languageId: "freebasic", getText: () => text };
    context.service.vscode.workspace.textDocuments = [header];
    const line = text.split("\n").indexOf(" Return headerInput");
    for (const [name, module, expected] of [["alternate", "caller.bas", "double"], ["normal", "implementation.bas", "long"]]) {
        context.values["analysis.activeContext"] = { name, module };
        assert.equal(context.service.getModel(header.uri), null);
        assert.equal(await context.service.check(header), true);
        const model = context.service.getModel(header.uri);
        assert.equal(model.partial, false);
        assert.equal((await model.expressionAt(header.uri, { line, character: 8 }, { line, character: 19 })).typeName.toLowerCase(), expected);
        const edit = await context.project.rename(header, { line: 5, character: 20 }, "ScaleValue");
        assert.equal(edit.edits.length, 3);
        assert.equal(new Set(edit.edits.map((entry) => entry.uri.fsPath)).size, 3);
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), context.sources["api.bi"]);
    context.values["analysis.activeContext"] = null;
    await assert.rejects(() => context.project.prepare(header, { line: 5, character: 20 }), /Select a translation unit/);
});

test("project rename uses physical ranges through continuations and repeated logical remapping", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const text = fs.readFileSync(path.join(__dirname, "integration/workspace/compiler-origins.bas"), "utf8");
    const original = context.document.getText();
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [{ name: "physical", modules: ["caller.bas"] }];
    const lines = text.split("\n");
    const edit = await context.project.rename(context.document, { line: lines.indexOf("Print originValue * 4"), character: 8 }, "physicalValue");
    assert.equal(edit.edits.length, [...text.matchAll(/\boriginValue\b/g)].length);
    assert.ok(edit.edits.every((entry) => entry.uri.fsPath === context.document.uri.fsPath));
    for (const entry of edit.edits) assert.equal(lines[entry.range.start.line].slice(entry.range.start.character, entry.range.end.character), "originValue");
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), original);
});

test("project rename ignores unrelated open buffers outside the declared build contexts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const unrelated = path.join(context.root, "unrelated.bas");
    const text = "Dim AdjustValue As Long\nDim ScaleValue As Double\n";
    context.service.vscode.workspace.textDocuments.push({ uri: context.service.vscode.Uri.file(unrelated), languageId: "freebasic", getText: () => text });
    const edit = await context.project.rename(context.document, { line: 1, character: 8 }, "ScaleValue");
    assert.equal(edit.edits.length, 3);
    assert.ok(edit.edits.every((entry) => entry.uri.fsPath !== unrelated));
    assert.equal(fs.existsSync(unrelated), false);
});

test("project rename preserves compiler-consumed legacy type suffixes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const text = "Declare Function Measure%(ByVal value As Integer)\nFunction Measure%(ByVal value As Integer)\n Measure% = value\nEnd Function\nPrint Measure%(1)\n";
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [{ name: "suffix", modules: ["caller.bas"] }];
    for (const dialect of ["fblite", "qb"]) {
        context.service.invalidate();
        context.values["compiler.arguments"] = ["-lang", dialect];
        const prepared = await context.project.prepare(context.document, { line: 4, character: 8 });
        assert.equal(prepared.placeholder, "Measure");
        assert.equal(prepared.range.end.character, 13);
        const edit = await context.project.rename(context.document, { line: 4, character: 8 }, "LengthValue");
        assert.equal(edit.edits.length, 4);
        for (const entry of edit.edits) assert.equal(text.split("\n")[entry.range.end.line][entry.range.end.character], "%");
    }
});

test("project rename follows copied, duplicated, nested, and declaration macro arguments", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const text = "#define COPY(value) value\n#define TWICE(value) ((value) + (value))\n#define NESTED(value) COPY(TWICE(value))\n#define DECLARE_VALUE(name) Dim name As Double\n#define DIRECT sourceValue\nDim sourceValue As Double\nDECLARE_VALUE(createdValue)\nPrint COPY(sourceValue)\nPrint TWICE(sourceValue)\nPrint NESTED(sourceValue)\nPrint DIRECT\nPrint createdValue\n";
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [{ name: "macros", modules: ["caller.bas"] }];
    for (const [line, character, name, replacement] of [[9, 15, "sourceValue", "inputValue"], [6, 18, "createdValue", "declaredValue"]]) {
        const edit = await context.project.rename(context.document, { line, character }, replacement);
        assert.equal(edit.edits.length, [...text.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length);
        for (const entry of edit.edits) assert.equal(text.split("\n")[entry.range.start.line].slice(entry.range.start.character, entry.range.end.character), name);
    }
});

test("project rename follows a compiler-bound procedure reference in a continued replacement list", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const original = fs.readFileSync(context.document.uri.fsPath, "utf8");
    const text = [
        "Function SelectedProcedure(ByVal value As Long) As Long",
        "    Return value",
        "End Function",
        "#define CALL_SELECTED(value) _",
        "    SelectedProcedure(value)",
        "Print CALL_SELECTED(1)",
        "Print SelectedProcedure(2)",
        ""
    ].join("\n");
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [{ name: "macro-procedure", modules: ["caller.bas"] }];

    const declaration = text.split("\n")[0];
    const edit = await context.project.rename(context.document, {
        line: 0,
        character: declaration.indexOf("SelectedProcedure") + 2
    }, "RenamedProcedure");
    assert.equal(edit.edits.length, 3,
        "the declaration, direct call, and unambiguously bound replacement-list token should be included");
    assert.deepEqual(edit.edits.map((entry) => [entry.range.start.line, entry.newText]), [
        [0, "RenamedProcedure"],
        [4, "RenamedProcedure"],
        [6, "RenamedProcedure"]
    ]);
    for (const entry of edit.edits) {
        const line = text.split("\n")[entry.range.start.line];
        assert.equal(line.slice(entry.range.start.character, entry.range.end.character), "SelectedProcedure");
    }
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), original,
        "project rename should leave the saved module untouched");

    const unexpandedText = text.replace("Print CALL_SELECTED(1)\n", "");
    context.document.getText = () => unexpandedText;
    context.service.invalidate();
    await assert.rejects(context.project.rename(context.document, {
        line: 0,
        character: declaration.indexOf("SelectedProcedure") + 2
    }, "RenamedProcedure"), /unresolved macro replacement reference/);
});

test("project rename follows a symbol reference emitted by a macro callback body", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const original = fs.readFileSync(context.document.uri.fsPath, "utf8");
    const source = [
        "#macro USE_SHARED_VALUE()",
        "    Print macroValue",
        "#endmacro",
        "Dim macroValue As Long",
        "USE_SHARED_VALUE()",
        ""
    ].join("\n");
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [{ name: "macro-callback", modules: ["caller.bas"] }];

    const edit = await context.project.rename(context.document, { line: 3, character: 5 }, "renamedMacroValue");
    assert.deepEqual(edit.edits.map((entry) => entry.range.start.line).sort((first, second) => first - second), [1, 3]);
    assert.ok(edit.edits.every((entry) => entry.newText === "renamedMacroValue"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), original,
        "callback-body rename should preview edits without changing the saved source");
});

test("project rename follows a symbol passed through a macro callback across build contexts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const original = fs.readFileSync(context.document.uri.fsPath, "utf8");
    const source = [
        "#macro PRINT_VALUE(argument)",
        "    Print argument",
        "#endmacro",
        "#ifdef ALTERNATE",
        "Dim buildVariant As Double",
        "#else",
        "Dim buildVariant As Long",
        "#endif",
        "Dim sourceValue As Long",
        "PRINT_VALUE(sourceValue)",
        "PRINT_VALUE(sourceValue)",
        ""
    ].join("\n");
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [
        { name: "callback-normal", modules: ["caller.bas"] },
        { name: "callback-alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];

    const edit = await context.project.rename(context.document, { line: 8, character: 5 }, "renamedSourceValue");
    assert.deepEqual(edit.edits.map((entry) => entry.range.start.line).sort((first, second) => first - second), [8, 9, 10]);
    assert.ok(edit.edits.every((entry) => entry.newText === "renamedSourceValue"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), original,
        "callback argument rename should preview declaration and invocation edits only");
});

test("project macro rename follows a macro-expanded include operand", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const original = fs.readFileSync(context.document.uri.fsPath, "utf8");
    const includeText = "Dim includedValue As Long\n";
    const source = [
        '#define DECLARATIONS_HEADER "api.bi"',
        "#include DECLARATIONS_HEADER",
        "Print includedValue",
        ""
    ].join("\n");
    fs.writeFileSync(path.join(context.root, "api.bi"), includeText);
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [{ name: "macro-include", modules: ["caller.bas"] }];

    const edit = await context.project.rename(context.document, { line: 0, character: 12 }, "VALUE_HEADER");
    assert.deepEqual(edit.edits.map((entry) => entry.range.start.line).sort((first, second) => first - second), [0, 1]);
    assert.ok(edit.edits.every((entry) => entry.newText === "VALUE_HEADER"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), original,
        "macro include rename should preview both edits without writing the source");
});

test("macro rename validation detects stringification and altered provenance edges", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    context.values["analysis.projectContexts"] = [{ name: "macros", modules: ["caller.bas"] }];
    const text = "#define BOTH(value) Print value, #value\nDim dataValue As Long\nBOTH(dataValue)\n";
    context.document.getText = () => text;
    await assert.rejects(context.project.rename(context.document, { line: 2, character: 7 }, "nextValue"), /physical token origins/);
    const directive = "#macro BOTH(value)\nPrint value\n#inclib #value\n#endmacro\nDim dataValue As Long\nBOTH(dataValue)\n";
    context.document.getText = () => directive;
    context.service.invalidate();
    await assert.rejects(context.project.rename(context.document, { line: 5, character: 7 }, "nextValue"), /physical token origins/);
    context.document.getText = () => text.replace(", #value", "");
    context.service.invalidate();
    const analyze = context.service.analyze;
    // Fault injection uses the same transaction engine with an in-process analyzer.
    context.project.analyze = (options) => context.service.analyze(options);
    for (const mutate of [
        (result) => { result.macroGraph.nodes.find((node) => node.kind === "argument").parameter++; },
        (result) => { result.macroGraph.nodes.find((node) => node.kind === "source").sourceStart++; },
        (result) => { result.tokenOrigins.find((token) => token.sourceMap).sourceMap = 0; }
    ]) {
        context.service.analyze = async (options) => {
            const result = await analyze(options);
            if (options.overlays?.get(context.document.uri.fsPath)?.includes("nextValue")) mutate(result);
            return result;
        };
        await assert.rejects(context.project.rename(context.document, { line: 2, character: 7 }, "nextValue"), /physical token origins/);
    }
});

test("project rename accepts an unambiguous macro selected from replacement text", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const text = "#define KNOWN_VALUE 1\n#define EXPAND_VALUE(dummy) KNOWN_VALUE\nPrint EXPAND_VALUE(0)\n";
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [{ name: "replacement", modules: ["caller.bas"] }];
    const line = text.split("\n")[1];
    const edit = await context.project.rename(context.document, { line: 1, character: line.lastIndexOf("KNOWN_VALUE") + 1 }, "UPDATED_VALUE");
    assert.equal(edit.edits.length, 2);
    assert.deepEqual(edit.edits.map((entry) => [entry.range.start.line, entry.range.start.character]).sort((first, second) => first[0] - second[0]), [[0, 8], [1, 28]]);
    for (const entry of edit.edits) assert.equal(text.split("\n")[entry.range.start.line].slice(entry.range.start.character, entry.range.end.character), "KNOWN_VALUE");
});

test("project rename includes unexpanded deferred macro references", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const text = "#define KNOWN_VALUE 1\n#define UNUSED_VALUE(dummy) KNOWN_VALUE\n#undef KNOWN_VALUE\n#ifdef ALTERNATE\n#define KNOWN_VALUE 2\n#else\n#define KNOWN_VALUE 3\n#endif\nPrint 1\n";
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [
        { name: "deferred-normal", modules: ["caller.bas"] },
        { name: "deferred-alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];
    const edit = await context.project.rename(context.document, { line: 0, character: 9 }, "UPDATED_VALUE");
    assert.equal(edit.edits.length, 5);
    const locations = edit.edits.map((entry) => [entry.range.start.line, entry.range.start.character]);
    assert.deepEqual(locations.sort((first, second) => first[0] - second[0]), [[0, 8], [1, 28], [2, 7], [4, 8], [6, 8]]);
    for (const entry of edit.edits) {
        assert.equal(text.split("\n")[entry.range.start.line].slice(entry.range.start.character, entry.range.end.character), "KNOWN_VALUE");
        assert.equal(entry.newText, "UPDATED_VALUE");
    }
});

test("project rename rejects a deferred macro token bound to different declarations across builds", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const original = fs.readFileSync(context.document.uri.fsPath, "utf8");
    const text = [
        "#define READ_SHARED() sharedValue",
        "#ifdef ALTERNATE",
        "Dim sharedValue As Double",
        "#else",
        "Dim sharedValue As Long",
        "#endif",
        "Print READ_SHARED()",
        ""
    ].join("\n");
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [
        { name: "shared-normal", modules: ["caller.bas"] },
        { name: "shared-alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];

    const character = text.split("\n")[4].indexOf("sharedValue") + 1;
    await assert.rejects(
        context.project.rename(context.document, { line: 4, character }, "renamedValue"),
        /different declarations across configured builds/
    );
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), original,
        "an ambiguous replacement-list reference must not modify the saved module");
});

test("native macro rename covers parameters, guards, equivalent definitions, and name lifetimes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const text = fs.readFileSync(path.join(__dirname, "integration/workspace/compiler-preprocessor.bas"), "utf8");
    const saved = context.document.getText();
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [{ name: "preprocessor", modules: ["caller.bas"] }];
    const lines = text.split("\n");
    const cases = [
        ["Print SCALE_VALUE(inputValue)", "SCALE_VALUE", "MULTIPLY_VALUE", 5],
        ["#define SCALE_VALUE(value) ((value) * 2)", "value", "numberValue", 2],
        ["#define SCALE_VALUE(item) ((item) * 2)", "item", "otherValue", 2],
        ["#define SCALE_VALUE(item) ((item) * 2)", "item", "value", 2],
        ["#define STRING_VALUE(value) #value", "value", "stringArgument", 2],
        ["#define EMPTY_VALUE()", "EMPTY_VALUE", "EMPTY_REPLACEMENT", 2],
        ["#define CURRENT_STATE 1", "CURRENT_STATE", "UPDATED_STATE", 7],
        ["#define PREPROCESSOR_INCLUDED 1", "PREPROCESSOR_INCLUDED", "RENAMED_INCLUDE_GUARD", 2],
        ["    Const qualifiedValue As Long = 3", "qualifiedValue", "renamedQualifiedValue", 3]
    ];
    for (const [statement, name, replacement, count] of cases) {
        const line = lines.indexOf(statement);
        assert.ok(line >= 0, statement);
        const edits = await context.project.rename(context.document, { line, character: statement.indexOf(name) + 1 }, replacement);
        assert.equal(edits.edits.length, count, `${name} -> ${replacement}`);
        for (const edit of edits.edits) assert.equal(lines[edit.range.start.line].slice(edit.range.start.character, edit.range.end.character), name);
    }
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), saved);
});

test("macro rename joins a repeated shared header across configured modules and defines", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const header = "#ifndef MACRO_HEADER_INCLUDED\n#define MACRO_HEADER_INCLUDED 1\n#ifdef ALTERNATE\n#define FACTOR_VALUE 3\n#else\n#define FACTOR_VALUE 2\n#endif\n#define SCALE_SHARED(value) ((value) * FACTOR_VALUE)\n#endif\n";
    const module = '#include "macro-shared.bi"\n#include "macro-shared.bi"\nPrint SCALE_SHARED(4)\n';
    const headerPath = path.join(context.root, "macro-shared.bi");
    const implementation = path.join(context.root, "implementation.bas");
    context.document.getText = () => module;
    context.service.vscode.workspace.textDocuments.push(
        { uri: context.service.vscode.Uri.file(headerPath), languageId: "freebasic", getText: () => header },
        { uri: context.service.vscode.Uri.file(implementation), languageId: "freebasic", getText: () => module }
    );
    const edit = await context.project.rename(context.document, { line: 2, character: 8 }, "MULTIPLY_SHARED");
    assert.equal(edit.edits.length, 3);
    assert.deepEqual(new Set(edit.edits.map((entry) => entry.uri.fsPath)), new Set([headerPath, implementation, context.document.uri.fsPath]));
    assert.equal(fs.existsSync(headerPath), false);
});

test("macro rename validates #if value, #ifdef, and #elseifdef references", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const header = "#define PRIMARY_VALUE 1\n#ifdef PRIMARY_VALUE\nPrint 1\n#endif\n#if 0\n#elseifdef PRIMARY_VALUE\nPrint 2\n#endif\n#if PRIMARY_VALUE\nPrint 3\n#endif\n";
    const module = '#include "macro-queries.bi"\n';
    const headerPath = path.join(context.root, "macro-queries.bi");
    const implementation = path.join(context.root, "implementation.bas");
    const headerDocument = { uri: context.service.vscode.Uri.file(headerPath), languageId: "freebasic", getText: () => header };
    context.document.getText = () => module;
    context.service.vscode.workspace.textDocuments.push(
        headerDocument,
        { uri: context.service.vscode.Uri.file(implementation), languageId: "freebasic", getText: () => module }
    );
    context.values["analysis.activeContext"] = { name: "normal", module: "caller.bas" };
    const edit = await context.project.rename(headerDocument, { line: 0, character: 9 }, "RENAMED_VALUE");
    assert.equal(edit.edits.length, 4);
    assert.deepEqual(edit.edits.map((entry) => entry.range.start.line).sort((left, right) => left - right), [0, 1, 5, 8]);
    assert.ok(edit.edits.every((entry) => entry.uri.fsPath === headerPath && entry.newText === "RENAMED_VALUE"));
    for (const entry of edit.edits) {
        const source = header.split("\n")[entry.range.start.line];
        assert.equal(source.slice(entry.range.start.character, entry.range.end.character), "PRIMARY_VALUE");
    }
    assert.equal(fs.existsSync(headerPath), false);
});

test("macro rename validation rejects altered native query and parameter records", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const text = "#define IDENTITY(value) value\n#if defined(IDENTITY)\nPrint IDENTITY(1)\n#endif\n";
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [{ name: "macro", modules: ["caller.bas"] }];
    const analyze = context.service.analyze;
    // Fault injection uses the same transaction engine with an in-process analyzer.
    context.project.analyze = (options) => context.service.analyze(options);
    for (const mutate of [
        (result) => { result.preprocessorGraph.declarations[0].flags = 0; },
        (result) => { result.preprocessorGraph.parameters[0].ordinal = 1; },
        (result) => { result.preprocessorGraph.references.find((record) => record.role === "query").symbol = 0; },
        (result) => { result.preprocessorGraph.references[0].sourceMap = 0; }
    ]) {
        context.service.analyze = async (options) => {
            const result = await analyze(options);
            if (options.overlays?.get(context.document.uri.fsPath)?.includes("RENAMED_IDENTITY")) mutate(result);
            return result;
        };
        await assert.rejects(context.project.rename(context.document, { line: 2, character: 8 }, "RENAMED_IDENTITY"), /preprocessor bindings/);
    }
});

test("project rename covers namespace constants queried through defined", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const text = [
        "Namespace MacroQuery",
        "    Const qualifiedValue As Long = 3",
        "End Namespace",
        "#if defined(MacroQuery.qualifiedValue)",
        "Print MacroQuery.qualifiedValue",
        "#endif",
        ""
    ].join("\n");
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [{ name: "qualified-query", modules: ["caller.bas"] }];

    const edit = await context.project.rename(context.document, { line: 1, character: 16 }, "resolvedValue");
    assert.equal(edit.edits.length, 3);
    assert.deepEqual(edit.edits.map((entry) => [entry.range.start.line, entry.range.start.character]).sort((first, second) => first[0] - second[0]), [
        [1, 10], [3, 23], [4, 17]
    ]);
    for (const entry of edit.edits) {
        assert.equal(text.split("\n")[entry.range.start.line].slice(entry.range.start.character, entry.range.end.character), "qualifiedValue");
        assert.equal(entry.newText, "resolvedValue");
    }
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), context.sources["caller.bas"],
        "a validated project preview must leave the saved module unchanged");
});

test("macro parameter rename rejects capture even in an unused replacement list", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    context.document.getText = () => "#define UNUSED(value) value + captured\nPrint 1\n";
    context.values["analysis.projectContexts"] = [{ name: "macro", modules: ["caller.bas"] }];
    await assert.rejects(context.project.rename(context.document, { line: 0, character: 17 }, "captured"), /preprocessor bindings/);
});

test("macro parameter rename preserves token-pasted identifiers across build contexts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const savedSource = fs.readFileSync(context.document.uri.fsPath, "utf8");
    const source = "#define JOIN_NAME(prefix, suffix) prefix##suffix\nDim leftValue As Long\nPrint JOIN_NAME(left, Value)\n";
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [
        { name: "normal", modules: ["caller.bas"] },
        { name: "alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];

    const parameterOffset = source.split("\n")[0].indexOf("prefix");
    const edit = await context.project.rename(context.document, { line: 0, character: parameterOffset + 1 }, "stem");
    assert.equal(edit.edits.length, 2);
    assert.deepEqual(edit.edits.map((entry) => entry.range.start.character).sort((left, right) => left - right), [parameterOffset, source.split("\n")[0].lastIndexOf("prefix")]);
    for (const entry of edit.edits) {
        assert.equal(source.split("\n")[entry.range.start.line].slice(entry.range.start.character, entry.range.end.character), "prefix");
        assert.equal(entry.newText, "stem");
    }
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), savedSource,
        "a validated preview must leave the saved source unchanged");
});

test("project rename maps a token-pasted label to one unique macro argument across contexts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "#define DECLARE_LABEL(prefix) prefix##Label:\nDECLARE_LABEL(my)\nGoto myLabel\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [
        { name: "pasted-label", modules: ["caller.bas"], arguments: ["-lang", "qb"] },
        { name: "pasted-label-alternate", modules: ["caller.bas"], arguments: ["-lang", "qb"] }
    ];
    context.values["analysis.activeContext"] = { name: "pasted-label", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 2, character: 6 }, "otherLabel");
    assert.equal(edit.edits.length, 2);
    const argument = edit.edits.find((entry) => entry.range.start.line === 1);
    const reference = edit.edits.find((entry) => entry.range.start.line === 2);
    assert.equal(source.split("\n")[1].slice(argument.range.start.character, argument.range.end.character), "my");
    assert.equal(argument.newText, "other");
    assert.equal(source.split("\n")[2].slice(reference.range.start.character, reference.range.end.character), "myLabel");
    assert.equal(reference.newText, "otherLabel");
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("project rename maps a token-pasted variable to one unique macro argument across contexts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "#define DECLARE_VALUE(prefix) Dim prefix##Value As Long\nDECLARE_VALUE(my)\nPrint myValue\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [
        { name: "pasted-variable", modules: ["caller.bas"] },
        { name: "pasted-variable-alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];
    context.values["analysis.activeContext"] = { name: "pasted-variable", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 2, character: 7 }, "otherValue");
    assert.equal(edit.edits.length, 2);
    const argument = edit.edits.find((entry) => entry.range.start.line === 1);
    const reference = edit.edits.find((entry) => entry.range.start.line === 2);
    assert.equal(source.split("\n")[1].slice(argument.range.start.character, argument.range.end.character), "my");
    assert.equal(argument.newText, "other");
    assert.equal(source.split("\n")[2].slice(reference.range.start.character, reference.range.end.character), "myValue");
    assert.equal(reference.newText, "otherValue");
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "a validated project preview must leave the saved source unchanged");
});

test("project rename edits one macro argument for a token-pasted reference to a physical symbol", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "#define JOIN_NAME(first, second) first##second\nDim sourceValue As Long\nPrint sourceValue\nPrint JOIN_NAME(source, Value)\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [
        { name: "pasted-reference", modules: ["caller.bas"] },
        { name: "pasted-reference-alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];
    context.values["analysis.activeContext"] = { name: "pasted-reference", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 2, character: 7 }, "inputValue");
    assert.equal(edit.edits.length, 3);
    const argument = edit.edits.find((entry) => entry.range.start.line === 3);
    const declaration = edit.edits.find((entry) => entry.range.start.line === 1);
    const reference = edit.edits.find((entry) => entry.range.start.line === 2);
    assert.ok(argument);
    assert.equal(source.split("\n")[3].slice(argument.range.start.character, argument.range.end.character), "source");
    assert.equal(argument.newText, "input");
    assert.ok(declaration);
    assert.equal(declaration.newText, "inputValue");
    assert.ok(reference);
    assert.equal(reference.newText, "inputValue");
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "a validated project preview must leave the saved source untouched");

    await assert.rejects(
        context.project.rename(context.document, { line: 2, character: 7 }, "otherItem"),
        /generated or unmapped text/
    );
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "an ambiguous pasted-reference rename must not write source files");
});

test("project rename maps a token-pasted procedure to one unique macro argument across contexts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "#macro DECLARE_FUNCTION(prefix)\nFunction prefix##Value() As Long\n Return 1\nEnd Function\n#endmacro\nDECLARE_FUNCTION(my)\nPrint myValue()\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [
        { name: "pasted-procedure", modules: ["caller.bas"] },
        { name: "pasted-procedure-alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];
    context.values["analysis.activeContext"] = { name: "pasted-procedure", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 6, character: 9 }, "otherValue");
    assert.equal(edit.edits.length, 2);
    const argument = edit.edits.find((entry) => entry.range.start.line === 5);
    const reference = edit.edits.find((entry) => entry.range.start.line === 6);
    assert.equal(source.split("\n")[5].slice(argument.range.start.character, argument.range.end.character), "my");
    assert.equal(argument.newText, "other");
    assert.equal(source.split("\n")[6].slice(reference.range.start.character, reference.range.end.character), "myValue");
    assert.equal(reference.newText, "otherValue");
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("project rename maps a token-pasted user type to one unique macro argument across contexts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "#macro DECLARE_TYPE(prefix)\nType prefix##Type\n value As Long\nEnd Type\n#endmacro\nDECLARE_TYPE(my)\nDim item As myType\nPrint item.value\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [
        { name: "pasted-type", modules: ["caller.bas"] },
        { name: "pasted-type-alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];
    context.values["analysis.activeContext"] = { name: "pasted-type", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 6, character: 14 }, "otherType");
    assert.equal(edit.edits.length, 2);
    const argument = edit.edits.find((entry) => entry.range.start.line === 5);
    const reference = edit.edits.find((entry) => entry.range.start.line === 6);
    assert.equal(source.split("\n")[5].slice(argument.range.start.character, argument.range.end.character), "my");
    assert.equal(argument.newText, "other");
    assert.equal(source.split("\n")[6].slice(reference.range.start.character, reference.range.end.character), "myType");
    assert.equal(reference.newText, "otherType");
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("project rename maps a token-pasted namespace through compiler namespace inputs", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerPath = path.join(context.root, "shared-namespace.bi");
    const otherPath = path.join(context.root, "other.bas");
    const header = [
        "#macro DECLARE_NAMESPACE(prefix)",
        "Namespace prefix##Scope",
        "    Const memberValue As Long = 1",
        "End Namespace",
        "#endmacro",
        "DECLARE_NAMESPACE(my)",
        ""
    ].join("\n");
    const source = '#include "shared-namespace.bi"\nUsing myScope\nPrint myScope.memberValue\n';
    const otherSource = source;
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, source);
    fs.writeFileSync(otherPath, otherSource);
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [{ name: "pasted-namespace", modules: ["caller.bas", "other.bas"] }];
    let observedNamespaceInput = false;
    const analyze = context.service.analyze;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        observedNamespaceInput ||= result.semanticNamespaceDeclarations?.some((fact) =>
            fact.filePath === headerPath && !fact.anonymous) === true;
        return result;
    };

    const edit = await context.project.rename(context.document, { line: 1, character: 7 }, "otherScope");
    assert.ok(observedNamespaceInput,
        "the native semantic model should confirm this macro-generated opening was named, not anonymous");
    assert.equal(edit.edits.length, 5);
    assert.deepEqual(edit.edits.map((entry) => [path.basename(entry.uri.fsPath), entry.range.start.line, entry.newText]).sort(), [
        ["caller.bas", 1, "otherScope"], ["caller.bas", 2, "otherScope"],
        ["other.bas", 1, "otherScope"], ["other.bas", 2, "otherScope"],
        ["shared-namespace.bi", 5, "other"]
    ]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "token-pasted namespace rename must remain a preview without writing source");
    assert.equal(fs.readFileSync(otherPath, "utf8"), otherSource);
    assert.equal(fs.readFileSync(headerPath, "utf8"), header);
});

test("project rename joins a token-pasted namespace across conditional definitions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "#ifdef ALTERNATE",
        "#macro DECLARE_SCOPE(prefix)",
        "Namespace prefix##Scope",
        "Const SelectedValue As Long = 2",
        "End Namespace",
        "#endmacro",
        "#else",
        "#macro DECLARE_SCOPE(prefix)",
        "Namespace prefix##Scope",
        "Const SelectedValue As Long = 1",
        "End Namespace",
        "#endmacro",
        "#endif",
        "DECLARE_SCOPE(my)",
        "Using myScope",
        "Print myScope.SelectedValue",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [
        { name: "pasted-namespace-normal", modules: ["caller.bas"] },
        { name: "pasted-namespace-alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];
    context.values["analysis.activeContext"] = { name: "pasted-namespace-normal", module: "caller.bas" };
    const observedContexts = new Set();
    const analyze = context.service.analyze;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const variant = options.compilerArguments.includes("ALTERNATE") ? "alternate" : "normal";
        if (result.semanticNamespaceDeclarations?.some((fact) =>
            fact.filePath === context.document.uri.fsPath && !fact.anonymous)) observedContexts.add(variant);
        return result;
    };

    const edit = await context.project.rename(context.document, { line: 14, character: 7 }, "otherScope");
    assert.deepEqual([...observedContexts].sort(), ["alternate", "normal"],
        "the compiler should identify the named namespace in both selected definitions");
    assert.deepEqual(edit.edits.map((entry) => [entry.range.start.line, entry.newText]).sort((a, b) => a[0] - b[0]), [
        [13, "other"], [14, "otherScope"], [15, "otherScope"]
    ]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "conditional namespace rename must remain a non-mutating preview");
});

test("project rename refuses one macro argument that names different namespaces across contexts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "#ifdef ALTERNATE",
        "#macro DECLARE_SCOPE(prefix)",
        "Namespace prefix##Alternate",
        "Const SelectedValue As Long = 2",
        "End Namespace",
        "#endmacro",
        "#else",
        "#macro DECLARE_SCOPE(prefix)",
        "Namespace prefix##Primary",
        "Const SelectedValue As Long = 1",
        "End Namespace",
        "#endmacro",
        "#endif",
        "DECLARE_SCOPE(my)",
        "#ifdef ALTERNATE",
        "Using myAlternate",
        "Print myAlternate.SelectedValue",
        "#else",
        "Using myPrimary",
        "Print myPrimary.SelectedValue",
        "#endif",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [
        { name: "different-namespaces-normal", modules: ["caller.bas"] },
        { name: "different-namespaces-alternate", modules: ["caller.bas"], arguments: ["-d", "ALTERNATE"] }
    ];
    context.values["analysis.activeContext"] = { name: "different-namespaces-normal", module: "caller.bas" };

    await assert.rejects(
        context.project.rename(context.document, { line: 18, character: 7 }, "otherPrimary"),
        /compiler|generated|bound|changed/i
    );
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "an ambiguous cross-context generated namespace rename must not modify source");
});

test("project namespace rename preserves a written external alias", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        'Namespace ExternalScope Alias "ExternalAlias"',
        "    Const aliasValue As Long = 1",
        "End Namespace",
        "Using ExternalScope",
        "Print ExternalScope.aliasValue",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [{ name: "namespace-alias", modules: ["caller.bas"] }];

    const edit = await context.project.rename(context.document, { line: 0, character: 12 }, "RenamedScope");
    assert.equal(edit.edits.length, 3);
    assert.deepEqual(edit.edits.map((entry) => [entry.range.start.line, entry.newText]).sort((a, b) => a[0] - b[0]), [
        [0, "RenamedScope"], [3, "RenamedScope"], [4, "RenamedScope"]
    ]);
    assert.ok(!edit.edits.some((entry) => entry.newText.includes("ExternalAlias")),
        "the compiler-written external namespace alias is not the renamed source identifier");
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "namespace alias rename remains a preview without modifying the source");
});

test("project rename joins a token-pasted user type from one shared header across modules", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const header = "#macro DECLARE_TYPE(prefix)\nType prefix##Type\n value As Long\nEnd Type\n#endmacro\nDECLARE_TYPE(my)\n";
    const source = '#include "shared-type.bi"\nDim item As myType\nPrint item.value\n';
    const otherSource = '#include "shared-type.bi"\nDim otherItem As myType\nPrint otherItem.value\n';
    const headerPath = path.join(context.root, "shared-type.bi");
    const otherPath = path.join(context.root, "other.bas");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, source);
    fs.writeFileSync(otherPath, otherSource);
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [{ name: "shared-pasted-type", modules: ["caller.bas", "other.bas"] }];
    context.values["analysis.activeContext"] = { name: "shared-pasted-type", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 1, character: 14 }, "otherType");
    assert.equal(edit.edits.length, 3);
    const argument = edit.edits.find((entry) => entry.uri.fsPath === headerPath);
    const callerReference = edit.edits.find((entry) => entry.uri.fsPath === context.document.uri.fsPath);
    const otherReference = edit.edits.find((entry) => entry.uri.fsPath === otherPath);
    assert.equal(header.split("\n")[5].slice(argument.range.start.character, argument.range.end.character), "my");
    assert.equal(argument.newText, "other");
    assert.equal(source.split("\n")[1].slice(callerReference.range.start.character, callerReference.range.end.character), "myType");
    assert.equal(otherSource.split("\n")[1].slice(otherReference.range.start.character, otherReference.range.end.character), "myType");
    assert.equal(callerReference.newText, "otherType");
    assert.equal(otherReference.newText, "otherType");
    assert.equal(fs.readFileSync(headerPath, "utf8"), header);
    assert.equal(fs.readFileSync(otherPath, "utf8"), otherSource);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("project rename edits one changed argument in a multiargument pasted variable", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "#define DECLARE_VALUE(prefix, suffix) Dim prefix##suffix As Long\nDECLARE_VALUE(my, Value)\nPrint myValue\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "ambiguous-pasted-variable", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "ambiguous-pasted-variable", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 2, character: 7 }, "otherValue");
    assert.equal(edit.edits.length, 2);
    const argument = edit.edits.find((entry) => entry.range.start.line === 1);
    const reference = edit.edits.find((entry) => entry.range.start.line === 2);
    assert.equal(source.split("\n")[1].slice(argument.range.start.character, argument.range.end.character), "my");
    assert.equal(argument.newText, "other");
    assert.equal(source.split("\n")[2].slice(reference.range.start.character, reference.range.end.character), "myValue");
    assert.equal(reference.newText, "otherValue");
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("project rename refuses a pasted name requiring multiple argument edits", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "#define DECLARE_VALUE(prefix, suffix) Dim prefix##suffix As Long\nDECLARE_VALUE(my, Value)\nPrint myValue\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "multiple-pasted-arguments", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "multiple-pasted-arguments", module: "caller.bas" };

    await assert.rejects(
        context.project.rename(context.document, { line: 2, character: 7 }, "otherItem"),
        /generated or unmapped text/
    );
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("project rename joins token-pasted labels generated by a shared header across modules", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const header = "#define DECLARE_LABEL(prefix) prefix##Label:\nDECLARE_LABEL(my)\n";
    const source = 'Sub callerProc()\n#include "shared-label.bi"\nGoto myLabel\nEnd Sub\n';
    const otherSource = 'Sub otherProc()\n#include "shared-label.bi"\nGoto myLabel\nEnd Sub\n';
    const headerPath = path.join(context.root, "shared-label.bi");
    const otherPath = path.join(context.root, "other.bas");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, source);
    fs.writeFileSync(otherPath, otherSource);
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [{
        name: "shared-pasted-label",
        modules: ["caller.bas", "other.bas"],
        arguments: ["-lang", "qb"]
    }];
    context.values["analysis.activeContext"] = { name: "shared-pasted-label", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 2, character: 6 }, "otherLabel");
    assert.equal(edit.edits.length, 3);
    assert.deepEqual(edit.edits.map((entry) => [path.basename(entry.uri.fsPath), entry.range.start.line, entry.newText]).sort(), [
        ["caller.bas", 2, "otherLabel"],
        ["other.bas", 2, "otherLabel"],
        ["shared-label.bi", 1, "other"]
    ]);
    assert.equal(fs.readFileSync(headerPath, "utf8"), header,
        "validated rename returns a preview without changing the shared declaration source");
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
    assert.equal(fs.readFileSync(otherPath, "utf8"), otherSource);
});

test("project rename keeps same-spelled macro labels separate when their declarations are physical", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const header = "#define DECLARE_LABEL(prefix) prefix##Label:\n";
    const source = 'Sub callerProc()\n#include "shared-label.bi"\nDECLARE_LABEL(my)\nGoto myLabel\nEnd Sub\n';
    const otherSource = 'Sub otherProc()\n#include "shared-label.bi"\nDECLARE_LABEL(my)\nGoto myLabel\nEnd Sub\n';
    const headerPath = path.join(context.root, "shared-label.bi");
    const otherPath = path.join(context.root, "other.bas");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, source);
    fs.writeFileSync(otherPath, otherSource);
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [{
        name: "independent-pasted-labels",
        modules: ["caller.bas", "other.bas"],
        arguments: ["-lang", "qb"]
    }];
    context.values["analysis.activeContext"] = { name: "independent-pasted-labels", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 3, character: 6 }, "otherLabel");
    assert.equal(edit.edits.length, 2);
    assert.ok(edit.edits.every((entry) => entry.uri.fsPath === context.document.uri.fsPath));
    assert.deepEqual(edit.edits.map((entry) => [entry.range.start.line, entry.newText]).sort((left, right) => left[0] - right[0]), [
        [2, "other"],
        [3, "otherLabel"]
    ]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
    assert.equal(fs.readFileSync(otherPath, "utf8"), otherSource,
        "a same-spelled label generated from a different invocation must remain outside the rename family");
});

test("project rename rejects a token-pasted label when its argument is also stringified", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "#define DECLARE_LABEL(prefix) prefix##Label: Print #prefix\nDECLARE_LABEL(my)\nGoto myLabel\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "stringified-label", modules: ["caller.bas"], arguments: ["-lang", "qb"] }];
    context.values["analysis.activeContext"] = { name: "stringified-label", module: "caller.bas" };

    await assert.rejects(
        context.project.rename(context.document, { line: 2, character: 6 }, "otherLabel"),
        /changed native expression relationships/
    );
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("project rename edits one changed argument in a multiargument pasted label", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "#define DECLARE_LABEL(prefix, suffix) prefix##suffix:\nDECLARE_LABEL(my, Label)\nGoto myLabel\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "ambiguous-label", modules: ["caller.bas"], arguments: ["-lang", "qb"] }];
    context.values["analysis.activeContext"] = { name: "ambiguous-label", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 2, character: 6 }, "otherLabel");
    assert.equal(edit.edits.length, 2);
    assert.deepEqual(edit.edits.map((entry) => [entry.range.start.line, entry.newText]).sort((left, right) => left[0] - right[0]), [
        [1, "other"],
        [2, "otherLabel"]
    ]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("native project rename covers multiline variadic macro declarations and parameter slots", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const text = "#macro EMIT_VALUES(prefix, values...)\nPrint prefix; values\n#endmacro\nEMIT_VALUES(1, 2, 3)\n";
    context.document.getText = () => text;
    context.values["analysis.projectContexts"] = [{ name: "multiline-macro", modules: ["caller.bas"] }];
    const cases = [
        [{ line: 0, character: 8 }, "WRITE_VALUES", 2, "EMIT_VALUES"],
        [{ line: 0, character: 21 }, "headValue", 2, "prefix"],
        [{ line: 0, character: 30 }, "tailValues", 2, "values"]
    ];
    for (const [position, replacement, count, oldName] of cases) {
        context.service.invalidate();
        const edit = await context.project.rename(context.document, position, replacement);
        assert.equal(edit.edits.length, count, replacement);
        for (const entry of edit.edits) {
            const source = text.split("\n")[entry.range.start.line];
            assert.equal(source.slice(entry.range.start.character, entry.range.end.character), oldName);
        }
    }
});

test("native project rename covers variables, parameters, fields, constants, types, namespaces, and labels", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = fs.readFileSync(path.join(__dirname, "integration/workspace/compiler-symbols.bas"), "utf8");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "symbols", modules: ["caller.bas"] }];
    const lines = source.split("\n");
    const cases = [
        ["Namespace Catalog", "Catalog", "RenamedCatalog", 7],
        ["    Type Record", "Record", "RenamedRecord", 2],
        ["    Type RecordAlias As Record", "RecordAlias", "RenamedAlias", 4],
        ["    Const Factor = 2", "Factor", "RenamedFactor", 2],
        ["    Enum Choice", "Choice", "RenamedChoice", 1],
        ["        One = 1", "One", "RenamedOne", 2],
        ["Function Catalog.ReadValue(ByRef actual As Catalog.RecordAlias) As Double", "actual", "renamedArgument", 3],
        ["    Dim value As Double = actual.value", "value", "outerValue", 2],
        ["        Dim value As Long = Catalog.One", "value", "innerValue", 2],
        ["        value As Double", "value", "fieldValue", 3],
        ["Dim recordValue As Catalog.RecordAlias", "recordValue", "otherRecord", 3],
        ["complete:", "complete", "finished", 2]
    ];
    for (const [statement, name, replacement, count] of cases) {
        const line = lines.indexOf(statement);
        assert.ok(line >= 0, statement);
        const edit = await context.project.rename(context.document, { line, character: statement.indexOf(name) + 1 }, replacement);
        assert.equal(edit.edits.length, count, `${name} -> ${replacement}`);
        assert.ok(edit.edits.every((entry) => entry.newText === replacement));
    }
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("project rename preserves compiler-created legacy implicit variable scopes", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        '#lang "deprecated"',
        "DefInt a-z",
        "legacyGlobal = 1",
        "legacyGlobal = legacyGlobal + 1",
        "Sub ReadLegacyValue()",
        "    Print legacyReadFirst",
        "    legacyReadFirst = 2",
        "    legacyLocal = 1",
        "    Print legacyLocal",
        "    legacyLocal = legacyLocal + 1",
        "End Sub",
        "ReadLegacyValue()",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "deprecated", modules: ["caller.bas"], arguments: ["-lang", "deprecated"] }];

    const global = await context.project.rename(context.document, { line: 2, character: 2 }, "renamedLegacyGlobal");
    assert.deepEqual(global.edits.map((entry) => entry.range.start.line).sort((first, second) => first - second), [2, 3, 3]);
    assert.ok(global.edits.every((entry) => entry.newText === "renamedLegacyGlobal"));
    context.service.invalidate();
    const firstRead = await context.project.rename(context.document, { line: 5, character: 12 }, "renamedLegacyRead");
    assert.deepEqual(firstRead.edits.map((entry) => entry.range.start.line).sort((first, second) => first - second), [5, 6]);
    assert.ok(firstRead.edits.every((entry) => entry.newText === "renamedLegacyRead"));
    context.service.invalidate();
    const local = await context.project.rename(context.document, { line: 7, character: 6 }, "renamedLegacyLocal");
    assert.deepEqual(local.edits.map((entry) => entry.range.start.line).sort((first, second) => first - second), [7, 8, 9, 9]);
    assert.ok(local.edits.every((entry) => entry.newText === "renamedLegacyLocal"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "compiler-validated implicit-variable renames must remain previews");
});

test("project rename covers a compiler-created FOR AS counter", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Sub countValues()",
        "    For counter As Long = 0 To 2",
        "        Print counter",
        "    Next counter",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "for-counter", modules: ["caller.bas"] }];

    const edit = await context.project.rename(context.document, { line: 1, character: 8 }, "loopIndex");
    assert.deepEqual(edit.edits.map((entry) => entry.range.start.line).sort((first, second) => first - second), [1, 2, 3]);
    assert.ok(edit.edits.every((entry) => entry.newText === "loopIndex"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "the loop-counter rename should be a compiler-validated preview");
});

test("project rename follows compiler-selected property getters and setters", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerSource = [
        "Type Meter",
        "    storedValue As Long",
        "    Declare Property CurrentValue() As Long",
        "    Declare Property CurrentValue(ByVal newValue As Long)",
        "    Declare Property ValueAt(ByVal index As Long) As Long",
        "End Type",
        ""
    ].join("\n");
    const implementationSource = [
        '#include "api.bi"',
        "Property Meter.CurrentValue() As Long",
        "    Return storedValue",
        "End Property",
        "Property Meter.CurrentValue(ByVal newValue As Long)",
        "    storedValue = newValue",
        "End Property",
        "Property Meter.ValueAt(ByVal index As Long) As Long",
        "    Return storedValue + index",
        "End Property",
        ""
    ].join("\n");
    const callerSource = [
        '#include "api.bi"',
        "Dim currentMeter As Meter",
        "Print currentMeter.CurrentValue",
        "currentMeter.CurrentValue = 4",
        "Print currentMeter.ValueAt(2)",
        ""
    ].join("\n");
    const headerPath = path.join(context.root, "api.bi");
    const implementationPath = path.join(context.root, "implementation.bas");
    fs.writeFileSync(headerPath, headerSource);
    fs.writeFileSync(implementationPath, implementationSource);
    fs.writeFileSync(context.document.uri.fsPath, callerSource);
    const implementationDocument = {
        uri: context.service.vscode.Uri.file(implementationPath),
        languageId: "freebasic",
        getText: () => fs.readFileSync(implementationPath, "utf8")
    };
    context.service.vscode.workspace.textDocuments.push(implementationDocument);
    context.values["analysis.projectContexts"] = [{ name: "property", modules: ["implementation.bas", "caller.bas"] }];

    const lines = implementationSource.split("\n");
    const getter = await context.project.rename(implementationDocument, {
        line: 1,
        character: lines[1].indexOf("CurrentValue") + 1
    }, "ReadValue");
    assert.deepEqual(getter.edits.map((entry) => [path.basename(entry.uri.fsPath), entry.range.start.line, entry.newText]).sort(), [
        ["api.bi", 2, "ReadValue"], ["caller.bas", 2, "ReadValue"], ["implementation.bas", 1, "ReadValue"]
    ]);

    const setter = await context.project.rename(implementationDocument, {
        line: 4,
        character: lines[4].indexOf("CurrentValue") + 1
    }, "WriteValue");
    assert.deepEqual(setter.edits.map((entry) => [path.basename(entry.uri.fsPath), entry.range.start.line, entry.newText]).sort(), [
        ["api.bi", 3, "WriteValue"], ["caller.bas", 3, "WriteValue"], ["implementation.bas", 4, "WriteValue"]
    ]);

    const indexedGetter = await context.project.rename(implementationDocument, {
        line: 7,
        character: lines[7].indexOf("ValueAt") + 1
    }, "ReadAt");
    assert.deepEqual(indexedGetter.edits.map((entry) => [path.basename(entry.uri.fsPath), entry.range.start.line, entry.newText]).sort(), [
        ["api.bi", 4, "ReadAt"], ["caller.bas", 4, "ReadAt"], ["implementation.bas", 7, "ReadAt"]
    ]);
    assert.equal(fs.readFileSync(headerPath, "utf8"), headerSource);
    assert.equal(fs.readFileSync(implementationPath, "utf8"), implementationSource);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), callerSource);
});

test("project rename joins conditional property accessors through shared references", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const sources = {
        "api.bi": [
            "Type Meter",
            "    storedValue As Long",
            "#ifdef ALTERNATE",
            "    Declare Property CurrentValue() As Double",
            "    Declare Property CurrentValue(ByVal newValue As Double)",
            "#else",
            "    Declare Property CurrentValue() As Long",
            "    Declare Property CurrentValue(ByVal newValue As Long)",
            "#endif",
            "End Type",
            ""
        ].join("\n"),
        "implementation.bas": [
            '#include "api.bi"',
            "#ifdef ALTERNATE",
            "Property Meter.CurrentValue() As Double",
            "    Return 2.5",
            "End Property",
            "Property Meter.CurrentValue(ByVal newValue As Double)",
            "    storedValue = CLng(newValue)",
            "End Property",
            "#else",
            "Property Meter.CurrentValue() As Long",
            "    Return 2",
            "End Property",
            "Property Meter.CurrentValue(ByVal newValue As Long)",
            "    storedValue = newValue",
            "End Property",
            "#endif",
            ""
        ].join("\n"),
        "caller.bas": [
            '#include "api.bi"',
            "Dim currentMeter As Meter",
            "Print currentMeter.CurrentValue",
            "currentMeter.CurrentValue = 2",
            ""
        ].join("\n")
    };
    for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(context.root, name), source);
    context.document.getText = () => sources["caller.bas"];
    context.values["analysis.activeContext"] = { name: "normal", module: "caller.bas" };
    assert.equal(await context.service.check(context.document), true);
    const snapshot = [...context.service.snapshots.values()].find((entry) => entry.sources.some((source) => source.uri.fsPath === context.document.uri.fsPath));
    assert.equal(snapshot?.model.partial, false, JSON.stringify(snapshot?.diagnostics));
    const locations = (edit) => edit.edits.map((entry) => [path.basename(entry.uri.fsPath), entry.range.start.line])
        .sort(([leftFile, leftLine], [rightFile, rightLine]) => leftFile.localeCompare(rightFile) || leftLine - rightLine);

    const getter = await context.project.rename(context.document, { line: 2, character: 24 }, "ReadingValue");
    assert.deepEqual(locations(getter), [
        ["api.bi", 3], ["api.bi", 6], ["caller.bas", 2],
        ["implementation.bas", 2], ["implementation.bas", 9]
    ]);
    assert.ok(getter.edits.every((entry) => entry.newText === "ReadingValue"));

    const setter = await context.project.rename(context.document, { line: 3, character: 24 }, "WriteValue");
    assert.deepEqual(locations(setter), [
        ["api.bi", 4], ["api.bi", 7], ["caller.bas", 3],
        ["implementation.bas", 5], ["implementation.bas", 12]
    ]);
    assert.ok(setter.edits.every((entry) => entry.newText === "WriteValue"));

    context.values["analysis.activeContext"] = { name: "alternate", module: "caller.bas" };
    const alternateGetter = await context.project.rename(context.document, { line: 2, character: 24 }, "ReadAlternate");
    assert.deepEqual(locations(alternateGetter), [
        ["api.bi", 3], ["api.bi", 6], ["caller.bas", 2],
        ["implementation.bas", 2], ["implementation.bas", 9]
    ]);
    for (const [name, source] of Object.entries(sources)) {
        assert.equal(fs.readFileSync(path.join(context.root, name), "utf8"), source);
    }
});

test("namespace rename includes USING imports across modules and build contexts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const sources = {
        "api.bi": "Namespace SharedScope\nConst SharedFactor = 7\nEnd Namespace\n",
        "implementation.bas": '#include "api.bi"\nUsing SharedScope\nFunction AdjustValue() As Long\n Return SharedFactor\nEnd Function\n',
        "caller.bas": '#include "api.bi"\nUsing SharedScope\nPrint SharedFactor\n'
    };
    for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(context.root, name), source);

    const source = sources["caller.bas"];
    context.document.getText = () => source;
    const edit = await context.project.rename(context.document, { line: 1, character: 7 }, "CommonScope");
    assert.equal(edit.edits.length, 3);
    assert.deepEqual(new Set(edit.edits.map((entry) => path.basename(entry.uri.fsPath))), new Set(["api.bi", "caller.bas", "implementation.bas"]));
    assert.ok(edit.edits.every((entry) => entry.newText === "CommonScope"));
    for (const [name, text] of Object.entries(sources)) {
        assert.equal(fs.readFileSync(path.join(context.root, name), "utf8"), text,
            "validated rename returns edits without changing any project source");
    }
});

test("project rename follows nested WITH member references across modules and build contexts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const sources = {
        "api.bi": "Type InnerRecord\n    storedValue As Long\nEnd Type\nType OuterRecord\n    child As InnerRecord\nEnd Type\n",
        "implementation.bas": '#include "api.bi"\n',
        "caller.bas": '#include "api.bi"\nDim recordValue As OuterRecord\nWith recordValue\n    With .child\n        Print .storedValue\n    End With\nEnd With\nPrint recordValue.child.storedValue\n'
    };
    for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(context.root, name), source);

    const source = sources["caller.bas"];
    const line = source.split("\n")[4];
    const edit = await context.project.rename(
        context.document,
        { line: 4, character: line.indexOf(".storedValue") + 3 },
        "amountValue"
    );
    assert.equal(edit.edits.length, 3);
    assert.deepEqual(new Set(edit.edits.map((entry) => path.basename(entry.uri.fsPath))), new Set(["api.bi", "caller.bas"]));
    assert.ok(edit.edits.every((entry) => entry.newText === "amountValue"));
    assert.equal(fs.readFileSync(path.join(context.root, "api.bi"), "utf8"), sources["api.bi"],
        "rename returns a preview and does not write the shared header");
    assert.equal(fs.readFileSync(path.join(context.root, "caller.bas"), "utf8"), source,
        "rename returns a preview and does not write nested WITH references");
});

test("project rename includes compiler-resolved inline assembly procedure references", { skip: !process.env.FBC_EDITOR_EXECUTABLE || !supportsIntelInlineAssembly }, async (t) => {
    const context = fixture(t);
    const source = [
        "Sub semantic_asm_target()",
        "End Sub",
        "Const As Integer semantic_asm_constant = 7",
        "Sub semantic_asm_probe()",
        "    Dim As Integer semantic_asm_value",
        "    asm mov eax, semantic_asm_value",
        "    asm call semantic_asm_target",
        "semantic_asm_label:",
        "    asm jmp semantic_asm_label",
        "    asm mov eax, semantic_asm_constant",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "inline-asm", modules: ["caller.bas"] }];
    const lines = source.split("\n");
    const cases = [
        [0, "semantic_asm_target", "asmRenamed", [0, 6]],
        [2, "semantic_asm_constant", "renamedConstant", [2, 9]],
        [4, "semantic_asm_value", "renamedValue", [4, 5]],
        [7, "semantic_asm_label", "renamedLabel", [7, 8]]
    ];
    for (const [line, name, replacement, expectedLines] of cases) {
        const character = lines[line].indexOf(name);
        assert.ok(character >= 0, name);
        const edit = await context.project.rename(context.document, { line, character: character + 1 }, replacement);
        assert.equal(edit.edits.length, expectedLines.length, `${name} should cover its declaration and ASM reference`);
        assert.deepEqual(edit.edits.map((entry) => [entry.range.start.line, entry.newText]).sort((a, b) => a[0] - b[0]),
            expectedLines.map((expectedLine) => [expectedLine, replacement]));
    }
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "compiler-validated rename returns a preview without changing the source");
});

test("numeric label rename validates branches and numeric RESTORE references", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "Option Gosub\n&H10 Print 1\n&H20 Print 2\nGosub &H10\nReturn &H20\nOn 1 Goto &H10, &H20\nOn 2 Gosub &H10, &H20\nIf 1 Then &H10 Else &H20\nerrorHandler:\nOn Error Goto errorHandler\ndataMarker:\nData 1\nRestore dataMarker\n&H40 Data 3\nRestore &H40\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "numeric-label", modules: ["caller.bas"], arguments: ["-lang", "qb"] }];
    context.values["analysis.activeContext"] = { name: "numeric-label", module: "caller.bas" };
    const edit = await context.project.rename(context.document, { line: 1, character: 0 }, "&H30");
    assert.equal(edit.edits.length, 5);
    assert.ok(edit.edits.every((entry) => entry.newText === "&H30"));
    context.service.invalidate();
    const named = await context.project.rename(context.document, { line: 1, character: 0 }, "finished");
    assert.equal(named.edits.length, 5);
    const branch = named.edits.find((entry) => entry.range.start.line === 7 && entry.range.start.character === 10);
    assert.equal(branch?.newText, "Goto finished");
    assert.ok(named.edits.filter((entry) => entry !== branch).every((entry) => entry.newText === "finished" || entry.newText === "finished:"));
    context.service.invalidate();
    const alternate = await context.project.rename(context.document, { line: 2, character: 0 }, "alternate");
    assert.equal(alternate.edits.length, 5);
    const alternateBranch = alternate.edits.find((entry) => entry.range.start.line === 7 && entry.range.start.character === 20);
    assert.equal(alternateBranch?.newText, "Goto alternate");
    assert.ok(alternate.edits.filter((entry) => entry !== alternateBranch).every((entry) => entry.newText === "alternate" || entry.newText === "alternate:"));
    context.service.invalidate();
    await assert.rejects(context.project.rename(context.document, { line: 1, character: 0 }, "finished%"), /numeric label/i);
    const errorHandler = await context.project.rename(context.document, { line: 8, character: 1 }, "handledError");
    assert.equal(errorHandler.edits.length, 2);
    assert.ok(errorHandler.edits.every((entry) => entry.newText === "handledError"));
    context.service.invalidate();
    const dataMarker = await context.project.rename(context.document, { line: 10, character: 1 }, "restoredData");
    assert.equal(dataMarker.edits.length, 2);
    assert.ok(dataMarker.edits.every((entry) => entry.newText === "restoredData"));
    context.service.invalidate();
    const numericDataMarker = await context.project.rename(context.document, { line: 13, character: 0 }, "restoredNumericData");
    assert.equal(numericDataMarker.edits.length, 2);
    assert.equal(numericDataMarker.edits.find((entry) => entry.range.start.line === 13)?.newText, "restoredNumericData:");
    assert.equal(numericDataMarker.edits.find((entry) => entry.range.start.line === 14)?.newText, "restoredNumericData");
    const colonTerminated = "&H10: Print 1\nGoto &H10\n";
    fs.writeFileSync(context.document.uri.fsPath, colonTerminated);
    context.service.invalidate();
    const existingColon = await context.project.rename(context.document, { line: 0, character: 0 }, "finished");
    assert.equal(existingColon.edits.length, 2);
    assert.equal(existingColon.edits.find((entry) => entry.range.start.line === 0)?.newText, "finished");
    assert.equal(existingColon.edits.find((entry) => entry.range.start.line === 1)?.newText, "finished");
    fs.writeFileSync(context.document.uri.fsPath, source);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("named label rename validates every compiler-bound branch and RESTORE reference", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Option Gosub",
        "firstTarget:",
        "Print 1",
        "secondTarget:",
        "Print 2",
        "Goto firstTarget",
        "Gosub firstTarget",
        "Return secondTarget",
        "On 1 Goto firstTarget, secondTarget",
        "On 2 Gosub firstTarget, secondTarget",
        "If 1 Then Goto firstTarget Else Goto secondTarget",
        "errorHandler:",
        "On Error Goto errorHandler",
        "dataMarker:",
        "Data 1",
        "Restore dataMarker",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "named-labels", modules: ["caller.bas"], arguments: ["-lang", "qb"] }];
    context.values["analysis.activeContext"] = { name: "named-labels", module: "caller.bas" };

    const first = await context.project.rename(context.document, { line: 1, character: 1 }, "renamedFirst");
    assert.deepEqual(first.edits.map((entry) => entry.range.start.line).sort((left, right) => left - right), [1, 5, 6, 8, 9, 10]);
    assert.ok(first.edits.every((entry) => entry.newText === "renamedFirst"));
    context.service.invalidate();

    const second = await context.project.rename(context.document, { line: 3, character: 1 }, "renamedSecond");
    assert.deepEqual(second.edits.map((entry) => entry.range.start.line).sort((left, right) => left - right), [3, 7, 8, 9, 10]);
    assert.ok(second.edits.every((entry) => entry.newText === "renamedSecond"));
    context.service.invalidate();

    const errorHandler = await context.project.rename(context.document, { line: 11, character: 1 }, "handledError");
    assert.deepEqual(errorHandler.edits.map((entry) => entry.range.start.line).sort((left, right) => left - right), [11, 12]);
    context.service.invalidate();

    const dataMarker = await context.project.rename(context.document, { line: 13, character: 1 }, "restoredData");
    assert.deepEqual(dataMarker.edits.map((entry) => entry.range.start.line).sort((left, right) => left - right), [13, 15]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "compiler-validated label renames return previews without changing the source");
});

test("named local error labels validate ON LOCAL ERROR GOTO references", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "Sub localErrorHandler()\n    On Local Error Goto recoverHere\n    Exit Sub\nrecoverHere:\n    Print 1\nEnd Sub\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "local-error", modules: ["caller.bas"] }];

    const edit = await context.project.rename(context.document, { line: 3, character: 1 }, "handleError");
    assert.equal(edit.edits.length, 2);
    assert.deepEqual(edit.edits.map((entry) => entry.range.start.line).sort((left, right) => left - right), [1, 3]);
    assert.ok(edit.edits.every((entry) => entry.newText === "handleError"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("project rename joins one physical label declared in a shared header across modules", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerPath = path.join(context.root, "shared-label.bi");
    const otherPath = path.join(context.root, "other.bas");
    const header = "sharedTarget:\n    Print 1\n";
    const source = '#include "shared-label.bi"\n';
    const caller = `Option Gosub\nSub callerProc()\n${source}` +
        "    Goto sharedTarget\n    On 1 Goto sharedTarget\n    On 2 Gosub sharedTarget\n" +
        "    If 1 Then Goto sharedTarget Else Goto sharedTarget\nEnd Sub\n";
    const other = `Option Gosub\nSub otherProc()\n${source}    Gosub sharedTarget\n    Return sharedTarget\nEnd Sub\n`;
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, caller);
    fs.writeFileSync(otherPath, other);
    context.document.getText = () => caller;
    context.values["analysis.projectContexts"] = [{
        name: "shared-physical-label",
        modules: ["caller.bas", "other.bas"],
        arguments: ["-lang", "qb"]
    }];
    context.values["analysis.activeContext"] = { name: "shared-physical-label", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 3, character: 10 }, "renamedTarget");
    assert.equal(edit.edits.length, 8);
    assert.deepEqual(edit.edits.map((entry) => [path.basename(entry.uri.fsPath), entry.range.start.line, entry.newText]).sort(), [
        ["caller.bas", 3, "renamedTarget"], ["caller.bas", 4, "renamedTarget"],
        ["caller.bas", 5, "renamedTarget"], ["caller.bas", 6, "renamedTarget"],
        ["caller.bas", 6, "renamedTarget"], ["other.bas", 3, "renamedTarget"],
        ["other.bas", 4, "renamedTarget"], ["shared-label.bi", 0, "renamedTarget"]
    ]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), caller);
    assert.equal(fs.readFileSync(otherPath, "utf8"), other);
    assert.equal(fs.readFileSync(headerPath, "utf8"), header,
        "shared physical label rename must return a preview without writing any source");
});

test("project rename joins repeated physical label-header expansions only through their shared edit", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerPath = path.join(context.root, "local-label.bi");
    const header = "sharedLocalTarget:\n    Print 1\n";
    const source = [
        "Option Gosub",
        "Sub firstProcedure()",
        '#include "local-label.bi"',
        "    Goto sharedLocalTarget",
        "End Sub",
        "Sub secondProcedure()",
        '#include "local-label.bi"',
        "    Gosub sharedLocalTarget",
        "    Return sharedLocalTarget",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [{
        name: "repeated-physical-label",
        modules: ["caller.bas"],
        arguments: ["-lang", "qb"]
    }];
    context.values["analysis.activeContext"] = { name: "repeated-physical-label", module: "caller.bas" };

    const edit = await context.project.rename(context.document, { line: 3, character: 10 }, "renamedLocalTarget");
    assert.equal(edit.edits.length, 4);
    assert.deepEqual(edit.edits.map((entry) => [path.basename(entry.uri.fsPath), entry.range.start.line, entry.newText]).sort(), [
        ["caller.bas", 3, "renamedLocalTarget"], ["caller.bas", 7, "renamedLocalTarget"],
        ["caller.bas", 8, "renamedLocalTarget"], ["local-label.bi", 0, "renamedLocalTarget"]
    ]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
    assert.equal(fs.readFileSync(headerPath, "utf8"), header,
        "repeated header label rename must preserve both procedure scopes without writing source");
});

test("project rename joins a shared DATA label to RESTORE references across modules", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const headerPath = path.join(context.root, "shared-data.bi");
    const otherPath = path.join(context.root, "other.bas");
    const header = "sharedData:\nData 1\n";
    const source = '#include "shared-data.bi"\nRestore sharedData\n';
    const other = source;
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, source);
    fs.writeFileSync(otherPath, other);
    context.document.getText = () => source;
    context.values["analysis.projectContexts"] = [{
        name: "shared-data-label",
        modules: ["caller.bas", "other.bas"]
    }];

    const edit = await context.project.rename(context.document, { line: 1, character: 9 }, "renamedData");
    assert.equal(edit.edits.length, 3);
    assert.deepEqual(edit.edits.map((entry) => [path.basename(entry.uri.fsPath), entry.range.start.line, entry.newText]).sort(), [
        ["caller.bas", 1, "renamedData"], ["other.bas", 1, "renamedData"],
        ["shared-data.bi", 0, "renamedData"]
    ]);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
    assert.equal(fs.readFileSync(otherPath, "utf8"), other);
    assert.equal(fs.readFileSync(headerPath, "utf8"), header,
        "shared DATA/RESTORE rename must remain a preview without source writes");
});

test("native project rename joins shared type, field, and external variable declarations across modules", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const sources = {
        "api.bi": "Type Box\n amount As Long\nEnd Type\nExtern sharedCount As Long\nDeclare Function Bump(ByRef item As Box) As Long\n",
        "implementation.bas": '#include "api.bi"\nDim Shared sharedCount As Long\nFunction Bump(ByRef item As Box) As Long\n sharedCount += 1\n Return item.amount + sharedCount\nEnd Function\n',
        "caller.bas": '#include "api.bi"\nDim item As Box\nPrint Bump(item), item.amount, sharedCount\n'
    };
    for (const [name, text] of Object.entries(sources)) fs.writeFileSync(path.join(context.root, name), text);
    for (const [line, character, replacement, count] of [[1, 13, "Container", 4], [2, 24, "quantity", 3], [2, 34, "counter", 5]]) {
        const edit = await context.project.rename(context.document, { line, character }, replacement);
        assert.equal(edit.edits.length, count, replacement);
        assert.equal(new Set(edit.edits.map((entry) => path.basename(entry.uri.fsPath))).size, 3);
    }
    for (const [name, text] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(context.root, name), "utf8"), text);
});

test("native project rename preserves implicit constructor and destructor relationships", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const sources = {
        "api.bi": [
            "Type Parcel",
            "    marker As Long",
        "    Declare Constructor()",
        "    Declare Constructor(ByRef source As Parcel)",
        "    Declare Constructor(ByVal value As Long)",
        "    Declare Destructor()",
        "End Type",
        "Type ParcelContainer",
        "    defaultParcel As Parcel",
        "    convertedParcel As Parcel = 7",
        "End Type",
        ""
        ].join("\n"),
        "implementation.bas": [
            '#include "api.bi"',
            "Constructor Parcel()",
            "End Constructor",
            "Constructor Parcel(ByRef source As Parcel)",
            "    This.marker = source.marker",
            "End Constructor",
        "Constructor Parcel(ByVal value As Long)",
        "    This.marker = value",
        "End Constructor",
        "Destructor Parcel()",
        "    This.marker = 0",
        "End Destructor",
            ""
        ].join("\n"),
        "caller.bas": [
            '#include "api.bi"',
            "Function optionalParcel(ByVal value As Parcel = 9) As Long",
            "    Return value.marker",
            "End Function",
            "Sub constructParcels()",
            "    Dim As Parcel original",
            "    Dim As Parcel copy = original",
            "    Dim As Parcel converted = 12",
            "    Dim As Parcel Ptr allocation = New Parcel(12)",
            "    Dim As Parcel Ptr allocationArray = New Parcel[2]",
            "    Dim As Parcel Ptr allocationDefault = New Parcel",
            "End Sub",
            "#define createMacroParcel() Dim As Parcel generatedParcel",
            "Sub constructFromMacro()",
            "    createMacroParcel()",
            "End Sub",
            ""
        ].join("\n")
    };
    for (const [name, text] of Object.entries(sources)) fs.writeFileSync(path.join(context.root, name), text);
    context.values["analysis.projectContexts"] = [
        { name: "constructors-x86-64", modules: ["implementation.bas", "caller.bas"], arguments: ["-lang", "fb", "-arch", "x86_64"] },
        { name: "constructors-x86-32", modules: ["implementation.bas", "caller.bas"], arguments: ["-lang", "fb", "-arch", "386"] }
    ];
    context.values["analysis.activeContext"] = { name: "constructors-x86-64", module: "caller.bas" };

    const analyze = context.service.analyze;
    context.project.analyze = (options) => context.service.analyze(options);
    const rejectChangedSelection = async (kind) => {
        let alteredCalls = 0;
        context.service.analyze = async (options) => {
            const result = await analyze(options);
            const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("Shipment"));
            const selectedCall = result.semanticImplicitCalls.find((call) => call.kind === kind);
            if (renamedSource && selectedCall) {
                alteredCalls++;
                result.semanticImplicitCalls = result.semanticImplicitCalls.map((call) => call === selectedCall
                    ? { ...call, targetSignature: `${call.targetSignature}|changed` }
                    : call);
            }
            return result;
        };
        await assert.rejects(context.project.rename(context.document, { line: 5, character: 12 }, "Shipment"), /compiler-selected implicit calls/);
        assert.ok(alteredCalls > 0, `the validation pass must compare the selected ${kind} signature`);
    };

    for (const kind of ["default-constructor", "initializer-constructor", "destructor-call", "new-constructor"]) {
        await rejectChangedSelection(kind);
    }

    let alteredUnanchoredCalls = 0;
    let observedUnanchoredCalls = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const selected = result.semanticImplicitCalls.find((call) =>
            call.kind === "default-constructor" && call.physical === false);
        if (!selected) return result;
        observedUnanchoredCalls++;
        const renamedSource = [...(options.overlays?.values() || [])]
            .some((text) => text.includes("Shipment"));
        if (renamedSource) {
            alteredUnanchoredCalls++;
            result.semanticImplicitCalls = result.semanticImplicitCalls.map((call) => call === selected
                ? { ...call, targetSignature: `${call.targetSignature}|changed` }
                : call);
        }
        return result;
    };
    await assert.rejects(context.project.rename(context.document, { line: 5, character: 12 }, "Shipment"),
        /unanchored compiler-selected implicit calls/);
    assert.ok(alteredUnanchoredCalls > 0,
        "the validation pass must compare an implicit relationship without an editable source range");
    assert.ok(observedUnanchoredCalls > 0,
        "the configured project must contain a macro-generated constructor selection");

    let alteredConstructionObservations = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("Shipment"));
        if (renamedSource) {
            result.semanticProperties = result.semanticProperties.map((property) => {
                if (alteredConstructionObservations || property.domain !== "symbol" ||
                    !property.name.startsWith("construction-observation:")) return property;
                const fields = property.value.split("\t");
                fields[0] = String(Number(fields[0]) + 1);
                alteredConstructionObservations++;
                return { ...property, value: fields.join("\t") };
            });
        }
        return result;
    };
    await assert.rejects(context.project.rename(context.document, { line: 5, character: 12 }, "Shipment"),
        /compiler implicit and temporary construction observations/);
    assert.ok(alteredConstructionObservations > 0,
        "the validation pass must compare native constructor selections retained before lowering");

    context.service.analyze = analyze;
    context.project.analyze = null;
    context.service.invalidate();

    const edit = await context.project.rename(context.document, { line: 5, character: 12 }, "Shipment");
    assert.equal(edit.edits.length, 20);
    assert.ok(edit.edits.every((entry) => entry.newText === "Shipment"));
    const macroDefinitionLine = sources["caller.bas"].split("\n").findIndex((line) => line.includes("#define createMacroParcel"));
    assert.ok(edit.edits.some((entry) => path.basename(entry.uri.fsPath) === "caller.bas" &&
        entry.range.start.line === macroDefinitionLine),
    "the physical type spelling in the macro replacement list must be renamed");
    for (const [name, text] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(context.root, name), "utf8"), text);
});

test("project type rename validates compiler-selected temporary destructors", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type TemporaryCleanupTarget",
        "    marker As Long",
        "    Declare Constructor()",
        "    Declare Destructor()",
        "End Type",
        "Constructor TemporaryCleanupTarget()",
        "    This.marker = 1",
        "End Constructor",
        "Destructor TemporaryCleanupTarget()",
        "    This.marker = 0",
        "End Destructor",
        "Function makeTemporary() As TemporaryCleanupTarget",
        "    Return TemporaryCleanupTarget()",
        "End Function",
        "Sub evaluateTemporaryCleanup()",
        "    Print (Type<TemporaryCleanupTarget>()).marker",
        "    Dim As Integer choose = 1",
        "    Dim As Integer nested = 1 + IIf(choose, makeTemporary(), makeTemporary()).marker",
        "    If (Type<TemporaryCleanupTarget>()).marker = 123 Then",
        "    End If",
        "    If (makeTemporary()).marker = 123 Then",
        "    End If",
        "    With Type<TemporaryCleanupTarget>()",
        "        .marker = 789",
        "    End With",
        "    Dim As TemporaryCleanupTarget assignmentTarget",
        "    assignmentTarget = Type<TemporaryCleanupTarget>()",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "temporary-cleanup", modules: ["caller.bas"] }];

    const analyze = context.service.analyze;
    let alteredTemporaryDestructors = 0;
    let observedTemporaryDestructors = 0;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("RenamedTemporaryCleanup"));
        const temporaryDestructors = result.semanticImplicitCalls.filter((call) => call.kind === "temporary-destructor");
        observedTemporaryDestructors = Math.max(observedTemporaryDestructors, temporaryDestructors.length);
        if (renamedSource && temporaryDestructors.length) {
            alteredTemporaryDestructors += temporaryDestructors.length;
            const selected = new Set(temporaryDestructors);
            result.semanticImplicitCalls = result.semanticImplicitCalls.map((call) => selected.has(call)
                ? { ...call, targetSignature: `${call.targetSignature}|changed` }
                : call);
        }
        return result;
    };
    await assert.rejects(
        context.project.rename(context.document, { line: 0, character: 6 }, "RenamedTemporaryCleanup"),
        /compiler-selected implicit calls/
    );
    assert.ok(observedTemporaryDestructors >= 6,
        "the fixture must exercise multiple compiler-generated expression cleanup sites");
    assert.ok(alteredTemporaryDestructors >= 6,
        "the rename validation pass must compare every selected temporary destructor");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, { line: 0, character: 6 }, "RenamedTemporaryCleanup");
    assert.equal(edit.edits.length, source.match(/TemporaryCleanupTarget/g).length,
        "the validated rename must cover declarations and every spelling used by the cleanup expressions");
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedTemporaryCleanup"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "the validated type rename must leave its temporary-expression source unchanged");
});

test("project type and typedef renames validate RETURN constructor names from a shared header in every module", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const header = [
        "Type SharedReturnTarget",
        "    marker As Long",
        "    Declare Constructor()",
        "End Type",
        "Constructor SharedReturnTarget()",
        "End Constructor",
        "Type SharedReturnAlias As SharedReturnTarget",
        "Function makeSharedReturn() As SharedReturnTarget",
        "    Return SharedReturnTarget()",
        "End Function",
        "Function makeSharedAliasReturn() As SharedReturnTarget",
        "    Return SharedReturnAlias()",
        "End Function",
        ""
    ].join("\n");
    const source = [
        '#include "shared-return.bi"',
        "Dim As SharedReturnTarget callerValue",
        "Function returnAliasFromCaller() As SharedReturnTarget",
        "    Return SharedReturnAlias()",
        "End Function",
        "Print callerValue.marker",
        ""
    ].join("\n");
    const otherSource = [
        '#include "shared-return.bi"',
        "Dim As SharedReturnTarget otherValue",
        "Function returnAliasFromOther() As SharedReturnTarget",
        "    Return SharedReturnAlias()",
        "End Function",
        "Print otherValue.marker",
        ""
    ].join("\n");
    const headerPath = path.join(context.root, "shared-return.bi");
    const otherPath = path.join(context.root, "other.bas");
    fs.writeFileSync(headerPath, header);
    fs.writeFileSync(context.document.uri.fsPath, source);
    fs.writeFileSync(otherPath, otherSource);
    context.values["analysis.projectContexts"] = [{ name: "shared-return", modules: ["caller.bas", "other.bas"] }];
    context.values["analysis.activeContext"] = { name: "shared-return", module: "caller.bas" };

    const sourceLine = source.split("\n")[1];
    const edit = await context.project.rename(context.document,
        { line: 1, character: sourceLine.indexOf("SharedReturnTarget") + 1 }, "RenamedSharedReturnTarget");
    const expectedOccurrences = [header, source, otherSource]
        .reduce((count, text) => count + (text.match(/SharedReturnTarget/g) || []).length, 0);
    assert.equal(edit.edits.length, expectedOccurrences,
        "the shared UDT and constructor spellings should be edited once after both module validations");
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedSharedReturnTarget"));

    const aliasLine = source.split("\n")[3];
    const aliasEdit = await context.project.rename(context.document,
        { line: 3, character: aliasLine.indexOf("SharedReturnAlias") + 1 }, "RenamedSharedReturnAlias");
    const expectedAliasOccurrences = [header, source, otherSource]
        .reduce((count, text) => count + (text.match(/SharedReturnAlias/g) || []).length, 0);
    assert.equal(aliasEdit.edits.length, expectedAliasOccurrences,
        "the typedef declaration and constructor-expression spellings should join across both modules");
    assert.ok(aliasEdit.edits.every((entry) => entry.newText === "RenamedSharedReturnAlias"));
    assert.equal(fs.readFileSync(headerPath, "utf8"), header);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
    assert.equal(fs.readFileSync(otherPath, "utf8"), otherSource);
});

test("project type rename validates compiler-selected argument constructors", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type ArgumentTarget",
        "    marker As Long",
        "    Declare Destructor()",
        "    Declare Constructor(ByVal value As Long)",
        "End Type",
        "Destructor ArgumentTarget()",
        "End Destructor",
        "Constructor ArgumentTarget(ByVal value As Long)",
        "    This.marker = value",
        "End Constructor",
        "Declare Sub consumeArgument(ByVal item As ArgumentTarget)",
        "Sub invokeArgumentConversion()",
        "    consumeArgument(13)",
        "End Sub",
        "Sub consumeArgument(ByVal item As ArgumentTarget)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "argument-constructor", modules: ["caller.bas"] }];

    const analyze = context.service.analyze;
    let alteredConstructionObservations = 0;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("RenamedArgument"));
        if (renamedSource && alterConstructionObservationTarget(result)) {
            alteredConstructionObservations++;
        }
        return result;
    };
    await assert.rejects(context.project.rename(context.document, { line: 0, character: 8 }, "RenamedArgument"),
        /compiler implicit and temporary construction observations/);
    assert.ok(alteredConstructionObservations > 0,
        "the validation pass must compare FBC's counted constructor selection after the type rename");
    context.service.analyze = analyze;
    context.project.analyze = null;

    const edit = await context.project.rename(context.document, { line: 0, character: 8 }, "RenamedArgument");
    assert.equal(edit.edits.length, [...source.matchAll(/\bArgumentTarget\b/g)].length);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedArgument"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "compiler-validated type rename returns a preview without modifying the source");
});

test("project type rename validates constructors selected through forwarded macro arguments", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "#define FORWARD_ARGUMENT(value) consumeArgument(value)",
        "Type ArgumentSource",
        "    marker As Long",
        "End Type",
        "Type ArgumentTarget",
        "    marker As Long",
        "    Declare Destructor()",
        "    Declare Constructor(ByRef value As ArgumentSource)",
        "End Type",
        "Destructor ArgumentTarget()",
        "End Destructor",
        "Constructor ArgumentTarget(ByRef value As ArgumentSource)",
        "    This.marker = value.marker",
        "End Constructor",
        "Declare Sub consumeArgument(ByVal item As ArgumentTarget)",
        "Sub invokeArgumentConversion()",
        "    Dim As ArgumentSource sourceItem",
        "    consumeArgument(sourceItem)",
        "    FORWARD_ARGUMENT(sourceItem)",
        "End Sub",
        "Sub consumeArgument(ByVal item As ArgumentTarget)",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [
        { name: "argument-macro", modules: ["caller.bas"], arguments: ["-lang", "fb"] },
        { name: "argument-macro-x86", modules: ["caller.bas"], arguments: ["-lang", "fb", "-arch", "386"] }
    ];
    context.values["analysis.activeContext"] = { name: "argument-macro", module: "caller.bas" };

    const analyze = context.service.analyze;
    let alteredConstructionObservations = 0;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])]
            .some((text) => text.includes("RenamedArgumentSource"));
        if (renamedSource && alterConstructionObservationTarget(result, -1)) {
            alteredConstructionObservations++;
        }
        return result;
    };
    await assert.rejects(context.project.rename(context.document, { line: 1, character: 8 }, "RenamedArgumentSource"),
        /compiler implicit and temporary construction observations/);
    assert.ok(alteredConstructionObservations > 0,
        "validation must compare FBC's constructor observation after forwarded macro argument expansion");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, { line: 1, character: 8 }, "RenamedArgumentSource");
    assert.equal(edit.edits.length, 4,
        "rename should cover the type declaration, constructor signatures, and source variable declaration");
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedArgumentSource"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "compiler-validated macro-argument type rename returns a preview without modifying the source");
});

test("project type rename validates scope-exit destructor selections", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type ScopeExitParcel",
        "    marker As Long",
        "    Declare Destructor()",
        "End Type",
        "Destructor ScopeExitParcel()",
        "    This.marker = 0",
        "End Destructor",
        "Sub cleanupScopeExitParcel()",
        "    Dim As ScopeExitParcel item",
        "    Exit Sub",
        "End Sub",
        "Sub cleanupExitFor()",
        "    For index As Long = 1 To 2",
        "        Scope",
        "            Dim As ScopeExitParcel forItem",
        "            Exit For",
        "        End Scope",
        "    Next",
        "End Sub",
        "Sub cleanupContinueDo()",
        "    Do",
        "        Scope",
        "            Dim As ScopeExitParcel continueDoItem",
        "            Continue Do",
        "        End Scope",
        "    Loop",
        "End Sub",
        "Sub cleanupExitDo()",
        "    Do",
        "        Scope",
        "            Dim As ScopeExitParcel exitDoItem",
        "            Exit Do",
        "        End Scope",
        "    Loop",
        "End Sub",
        "Sub cleanupContinueWhile()",
        "    Dim index As Long",
        "    While index < 2",
        "        Scope",
        "            Dim As ScopeExitParcel continueWhileItem",
        "            index += 1",
        "            Continue While",
        "        End Scope",
        "    Wend",
        "End Sub",
        "Sub cleanupExitWhile()",
        "    While True",
        "        Scope",
        "            Dim As ScopeExitParcel exitWhileItem",
        "            Exit While",
        "        End Scope",
        "    Wend",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "scope-exit-destructor", modules: ["caller.bas"] }];

    const analyze = context.service.analyze;
    let alteredScopeExitCalls = 0;
    let observedScopeExitCalls = 0;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("RenamedScopeExitParcel"));
        const scopeExitCalls = result.semanticImplicitCalls.filter((call) => call.kind === "scope-exit-destructor");
        observedScopeExitCalls = Math.max(observedScopeExitCalls, scopeExitCalls.length);
        if (renamedSource && scopeExitCalls.length) {
            alteredScopeExitCalls += scopeExitCalls.length;
            result.semanticImplicitCalls = result.semanticImplicitCalls.map((call) =>
                call.kind === "scope-exit-destructor"
                    ? { ...call, targetSignature: `${call.targetSignature}|changed` }
                    : call);
        }
        return result;
    };
    await assert.rejects(
        context.project.rename(context.document, { line: 0, character: 10 }, "RenamedScopeExitParcel"),
        /compiler-selected implicit calls/
    );
    assert.ok(observedScopeExitCalls >= 6,
        "the fixture must cover procedure and loop EXIT/CONTINUE cleanup edges");
    assert.ok(alteredScopeExitCalls >= observedScopeExitCalls,
        "the rename validation pass must compare every compiler-selected cleanup edge after the UDT rename");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, { line: 0, character: 10 }, "RenamedScopeExitParcel");
    assert.ok(edit.edits.length >= 3);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedScopeExitParcel"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "compiler-validated type rename returns a preview without changing the source");
});

test("project type rename validates scalar and vector DELETE destructor selections", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type DeleteRenameTarget",
        "    marker As Long",
        "    Declare Destructor()",
        "End Type",
        "Destructor DeleteRenameTarget()",
        "    This.marker = 0",
        "End Destructor",
        "Sub disposeDeleteRenameTarget()",
        "    Dim As DeleteRenameTarget Ptr item = New DeleteRenameTarget",
        "    Delete item",
        "    Dim As DeleteRenameTarget Ptr items = New DeleteRenameTarget[2]",
        "    Delete[] items",
        "End Sub",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "delete-destructor", modules: ["caller.bas"] }];

    const analyze = context.service.analyze;
    let alteredDeleteCalls = 0;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("RenamedDeleteTarget"));
        const deleteCalls = result.semanticImplicitCalls.filter((call) => call.kind === "delete-destructor");
        if (renamedSource && deleteCalls.length) {
            alteredDeleteCalls++;
            result.semanticImplicitCalls = result.semanticImplicitCalls.map((call) => call === deleteCalls[0]
                ? { ...call, targetSignature: `${call.targetSignature}|changed` }
                : call);
        }
        return result;
    };
    await assert.rejects(
        context.project.rename(context.document, { line: 0, character: 10 }, "RenamedDeleteTarget"),
        /compiler-selected implicit calls/
    );
    assert.ok(alteredDeleteCalls > 0,
        "the rename validation pass must compare the destructor selected by DELETE after the UDT rename");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, { line: 0, character: 10 }, "RenamedDeleteTarget");
    assert.ok(edit.edits.length >= 4);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedDeleteTarget"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "compiler-validated type rename returns a preview without changing the source");
});

test("project type rename validates constructors selected for UDT return expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type ReturnRenameTarget",
        "    marker As Long",
        "    Declare Constructor(ByVal value As Long)",
        "End Type",
        "Constructor ReturnRenameTarget(ByVal value As Long)",
        "    This.marker = value",
        "End Constructor",
        "Function makeReturnRenameTarget() As ReturnRenameTarget",
        "    Return 42",
        "End Function",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "return-constructor", modules: ["caller.bas"] }];

    const analyze = context.service.analyze;
    let alteredReturnCalls = 0;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("RenamedReturnTarget"));
        const returnCall = result.semanticImplicitCalls.find((call) => call.kind === "return-constructor");
        if (renamedSource && returnCall) {
            alteredReturnCalls++;
            result.semanticImplicitCalls = result.semanticImplicitCalls.map((call) => call === returnCall
                ? { ...call, targetSignature: `${call.targetSignature}|changed` }
                : call);
        }
        return result;
    };
    await assert.rejects(
        context.project.rename(context.document, { line: 0, character: 10 }, "RenamedReturnTarget"),
        /compiler-selected implicit calls/
    );
    assert.ok(alteredReturnCalls > 0,
        "project validation must compare the constructor selected for the return value after type rename");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, { line: 0, character: 10 }, "RenamedReturnTarget");
    assert.ok(edit.edits.length >= 3);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedReturnTarget"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "compiler-validated type rename returns a preview without changing the source");
});

test("project rename rejects omitted branch coverage and new-name capture", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    fs.appendFileSync(context.document.uri.fsPath, "#ifdef ALTERNATE\nPrint AdjustValue(2)\n#endif\n");
    context.values["analysis.projectContexts"] = context.values["analysis.projectContexts"].slice(0, 1);
    await assert.rejects(context.project.rename(context.document, { line: 1, character: 8 }, "ScaleValue"), /not compiler-bound/);
    context.values["analysis.projectContexts"].push({ name: "alternate", modules: ["implementation.bas", "caller.bas"], arguments: ["-d", "ALTERNATE"] });
    await assert.rejects(context.project.rename(context.document, { line: 1, character: 8 }, "InputType"), /already occurs/);
});

test("project type rename validates accepted header policies and namespace import recipients", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "#Pragma Once",
        "#Inclib \"fixture\"",
        "Namespace RenamePolicyScope",
        "    Type RenamePolicyType",
        "        value As Long",
        "    End Type",
        "End Namespace",
        "Using RenamePolicyScope",
        "Dim policyValue As RenamePolicyType",
        "Print policyValue.value",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "header-policy-rename", modules: ["caller.bas"] }];
    const analyze = context.service.analyze;
    let alteredRecipients = 0;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("RenamedPolicyType"));
        if (renamedSource && result.semanticNamespaceImportRecipients.length) {
            alteredRecipients++;
            result.semanticNamespaceImportRecipients = result.semanticNamespaceImportRecipients.map((fact) =>
                ({ ...fact, recipient: fact.recipient + 100000 }));
        }
        return result;
    };
    await assert.rejects(
        context.project.rename(context.document, { line: 3, character: 15 }, "RenamedPolicyType"),
        /compiler source and namespace policy inputs/
    );
    assert.ok(alteredRecipients > 0,
        "the project transaction must compare compiler-selected namespace import recipients after edits");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, { line: 3, character: 15 }, "RenamedPolicyType");
    assert.ok(edit.edits.length >= 2);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedPolicyType"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "accepted header policy validation must retain the preview-only rename contract");
});

test("project rename rejects changed compiler SELECT CASE lowering facts", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Dim selector As Integer",
        "Dim caseValue As Integer",
        "Select Case selector",
        "Case caseValue",
        "    Print caseValue",
        "End Select",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "select-case-rename", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "select-case-rename", module: "caller.bas" };

    const analyze = context.service.analyze;
    let changedReceipts = 0;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("renamedCaseValue"));
        if (!renamedSource) return result;
        const comparison = result.semanticProperties.find((property) => property.name.startsWith("select-case-comparison:"));
        if (!comparison) return result;
        const fields = comparison.value.split("\t");
        assert.ok(["jump", "fallthrough"].includes(fields[2]), "the compiler must provide a branch disposition");
        fields[2] = fields[2] === "jump" ? "fallthrough" : "jump";
        comparison.value = fields.join("\t");
        changedReceipts++;
        return result;
    };

    await assert.rejects(
        context.project.rename(context.document, { line: 3, character: source.split("\n")[3].indexOf("caseValue") + 2 }, "renamedCaseValue"),
        /compiler SELECT CASE lowering inputs/
    );
    assert.ok(changedReceipts > 0,
        "the transaction must compare the compiler-selected branch disposition after edits");

    context.service.analyze = analyze;
    context.project.analyze = async (options) => {
        const result = await analyze(options);
        if ([...(options.overlays?.values() || [])].some((text) => text.includes("renamedCaseValue"))) {
            result.semanticProperties.reverse();
        }
        return result;
    };
    const edit = await context.project.rename(
        context.document,
        { line: 3, character: source.split("\n")[3].indexOf("caseValue") + 2 },
        "renamedCaseValue"
    );
    context.project.analyze = null;
    assert.equal(edit.edits.length, 3);
    assert.ok(edit.edits.every((entry) => entry.newText === "renamedCaseValue"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "SELECT CASE validation must still return a preview without writing source");
});

test("project type rename validates compiler procedure ABI and declaration typing inputs", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type ManagedAlias As String",
        "Declare Sub ManagedParameter(ByRef value As ManagedAlias)",
        "Type RenameTarget",
        "    member As Long",
        "End Type",
        "Dim item As RenameTarget",
        "Print item.member",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "abi-policy-rename", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "abi-policy-rename", module: "caller.bas" };

    const analyze = context.service.analyze;
    let changedReceipts = 0;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("RenamedTarget"));
        if (!renamedSource) return result;
        const receipt = result.semanticAbiPolicyInputs?.[0];
        if (!receipt) return result;
        receipt.managedString = !receipt.managedString;
        changedReceipts++;
        return result;
    };

    const lines = source.split("\n");
    await assert.rejects(
        context.project.rename(context.document, { line: 2, character: lines[2].indexOf("RenameTarget") + 1 }, "RenamedTarget"),
        /compiler procedure ABI policy inputs/
    );
    assert.ok(changedReceipts > 0,
        "post-rename validation must include compiler-selected ABI policy inputs");

    let changedDeclarationInputs = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("RenamedTarget"));
        if (!renamedSource) return result;
        const input = result.semanticProcedureDeclarationInputs?.find((fact) => fact.kind === "typing");
        if (!input) return result;
        input.role = input.role === "prototype" ? "definition" : "prototype";
        changedDeclarationInputs++;
        return result;
    };
    await assert.rejects(
        context.project.rename(context.document, { line: 2, character: lines[2].indexOf("RenameTarget") + 1 }, "RenamedTarget"),
        /compiler procedure declaration typing inputs/
    );
    assert.ok(changedDeclarationInputs > 0,
        "post-rename validation must compare compiler-owned procedure header forms");

    let changedFormalTypes = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("RenamedTarget"));
        if (!renamedSource) return result;
        const input = result.semanticProcedureDeclarationInputs?.find((fact) => fact.kind === "formal-written-type");
        if (!input) return result;
        input.writtenType = input.writtenType === "as" ? "suffix" : "as";
        changedFormalTypes++;
        return result;
    };
    await assert.rejects(
        context.project.rename(context.document, { line: 2, character: lines[2].indexOf("RenameTarget") + 1 }, "RenamedTarget"),
        /compiler procedure declaration typing inputs/
    );
    assert.ok(changedFormalTypes > 0,
        "post-rename validation must compare compiler-selected formal type spelling");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(
        context.document,
        { line: 2, character: lines[2].indexOf("RenameTarget") + 1 },
        "RenamedTarget"
    );
    assert.equal(edit.edits.length, 2);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedTarget"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "ABI policy validation must preserve the preview-only rename contract");
});

test("project type rename validates compiler linkage and callback convention inputs", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type RenameLinkageTarget",
        "    value As Long",
        "End Type",
        "Declare Sub CallbackSink Alias \"callback_sink\" (ByVal callback As Function() As Long)",
        "Dim item As RenameLinkageTarget",
        "Print item.value",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "procedure-linkage-rename", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "procedure-linkage-rename", module: "caller.bas" };

    const analyze = context.service.analyze;
    context.project.analyze = (options) => context.service.analyze(options);
    let changedLinkage = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        if (![...(options.overlays?.values() || [])].some((text) => text.includes("RenamedLinkageTarget"))) return result;
        const input = result.semanticProcedureLinkageInputs?.find((entry) =>
            entry.filePath === context.document.uri.fsPath && entry.role === "prototype");
        if (!input) return result;
        input.hasAlias = !input.hasAlias;
        changedLinkage++;
        return result;
    };

    const targetPosition = { line: 0, character: source.split("\n")[0].indexOf("RenameLinkageTarget") + 1 };
    await assert.rejects(
        context.project.rename(context.document, targetPosition, "RenamedLinkageTarget"),
        /compiler procedure linkage and callback inputs/
    );
    assert.ok(changedLinkage > 0,
        "post-rename validation must compare compiler-selected external alias inputs");

    let changedCallback = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        if (![...(options.overlays?.values() || [])].some((text) => text.includes("RenamedLinkageTarget"))) return result;
        const input = result.semanticCallbackConventionInputs?.find((entry) =>
            entry.filePath === context.document.uri.fsPath);
        if (!input) return result;
        input.explicit = !input.explicit;
        changedCallback++;
        return result;
    };
    await assert.rejects(
        context.project.rename(context.document, targetPosition, "RenamedLinkageTarget"),
        /compiler procedure linkage and callback inputs/
    );
    assert.ok(changedCallback > 0,
        "post-rename validation must compare compiler-selected callback conventions");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, targetPosition, "RenamedLinkageTarget");
    assert.equal(edit.edits.length, 2);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedLinkageTarget"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "procedure linkage validation must preserve preview-only refactoring");
});

test("project enum rename validates original member order and initializer inputs", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Enum RenameState Explicit",
        "    First = 2",
        "    Second",
        "End Enum",
        "Const currentState As RenameState = RenameState.First",
        "Print currentState",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "enum-input-rename", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "enum-input-rename", module: "caller.bas" };

    const analyze = context.service.analyze;
    context.project.analyze = (options) => context.service.analyze(options);
    let changedInitializer = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        if (![...(options.overlays?.values() || [])].some((text) => text.includes("RenamedState"))) return result;
        const input = result.semanticEnumElementInputs?.find((entry) =>
            entry.filePath === context.document.uri.fsPath && entry.explicit);
        if (!input) return result;
        input.explicit = false;
        changedInitializer++;
        return result;
    };

    const header = source.split("\n")[0];
    const target = { line: 0, character: header.indexOf("RenameState") + 1 };
    await assert.rejects(
        context.project.rename(context.document, target, "RenamedState"),
        /compiler enum declaration and member inputs/
    );
    assert.ok(changedInitializer > 0,
        "post-rename validation must compare original enum initializer choices");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, target, "RenamedState");
    assert.ok(edit.edits.length >= 3);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedState"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "enum input validation must preserve preview-only refactoring");
});

test("project type rename validates compiler declaration typing groups", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type RenameDeclaredType",
        "    value As Long",
        "End Type",
        "Dim item As RenameDeclaredType",
        "Print item.value",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "declaration-type-rename", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "declaration-type-rename", module: "caller.bas" };

    const analyze = context.service.analyze;
    context.project.analyze = (options) => context.service.analyze(options);
    let changedInputs = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        if (![...(options.overlays?.values() || [])].some((text) => text.includes("RenamedDeclaredType"))) return result;
        const group = result.semanticDeclarationTypingGroups?.find((entry) =>
            entry.statement.filePath === context.document.uri.fsPath && entry.kind === "dim");
        const input = group?.inputs.find((entry) => entry.writtenType === "as");
        if (!input) return result;
        input.writtenType = "suffix";
        changedInputs++;
        return result;
    };

    const header = source.split("\n")[0];
    const target = { line: 0, character: header.indexOf("RenameDeclaredType") + 1 };
    await assert.rejects(
        context.project.rename(context.document, target, "RenamedDeclaredType"),
        /compiler declaration typing inputs/
    );
    assert.ok(changedInputs > 0,
        "post-rename validation must compare compiler-selected declaration type forms");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, target, "RenamedDeclaredType");
    assert.equal(edit.edits.length, 2);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedDeclaredType"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "declaration typing validation must preserve preview-only refactoring");
});

test("project type rename validates compiler repeated declaration choices", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type RenameRepeatedTarget",
        "    value As Long",
        "End Type",
        "Extern repeatedValue As Long",
        "Extern repeatedValue As Long",
        "Dim item As RenameRepeatedTarget",
        "Print item.value",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "declaration-repetition-rename", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "declaration-repetition-rename", module: "caller.bas" };

    const analyze = context.service.analyze;
    context.project.analyze = (options) => context.service.analyze(options);
    let changedInputs = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        if (![...(options.overlays?.values() || [])].some((text) => text.includes("RenamedRepeatedTarget"))) return result;
        const input = result.semanticDeclarationRepetitionInputs?.find((entry) =>
            entry.filePath === context.document.uri.fsPath && entry.kind === "extern" && entry.repeated);
        if (!input) return result;
        input.repeated = false;
        changedInputs++;
        return result;
    };

    const header = source.split("\n")[0];
    const target = { line: 0, character: header.indexOf("RenameRepeatedTarget") + 1 };
    await assert.rejects(
        context.project.rename(context.document, target, "RenamedRepeatedTarget"),
        /compiler declaration repetition inputs/
    );
    assert.ok(changedInputs > 0,
        "post-rename validation must compare compiler-selected repeated declarations");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, target, "RenamedRepeatedTarget");
    assert.equal(edit.edits.length, 2);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedRepeatedTarget"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "declaration repetition validation must preserve preview-only refactoring");
});

test("project type rename validates compiler scalar String declaration inputs", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type RenameScalarStringTarget",
        "    value As Long",
        "End Type",
        "Dim label As String = \"original\"",
        "Dim item As RenameScalarStringTarget",
        "Print item.value",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "scalar-string-rename", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "scalar-string-rename", module: "caller.bas" };

    const analyze = context.service.analyze;
    context.project.analyze = (options) => context.service.analyze(options);
    let changedInputs = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        if (![...(options.overlays?.values() || [])].some((text) => text.includes("RenamedScalarStringTarget"))) return result;
        const input = result.semanticScalarStringDeclarationInputs?.find((entry) =>
            entry.filePath === context.document.uri.fsPath && entry.kind === "dim" && entry.hasInitializer);
        if (!input) return result;
        input.hasInitializer = false;
        changedInputs++;
        return result;
    };

    const header = source.split("\n")[0];
    const target = { line: 0, character: header.indexOf("RenameScalarStringTarget") + 1 };
    await assert.rejects(
        context.project.rename(context.document, target, "RenamedScalarStringTarget"),
        /compiler scalar String declaration inputs/
    );
    assert.ok(changedInputs > 0,
        "post-rename validation must compare compiler-selected scalar String initialization");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, target, "RenamedScalarStringTarget");
    assert.equal(edit.edits.length, 2);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedScalarStringTarget"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "scalar String declaration validation must preserve preview-only refactoring");
});

test("project type rename validates compiler-selected array storage inputs", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type RenameArrayStorageTarget",
        "    values(0 To 3) As Long",
        "End Type",
        "Dim item As RenameArrayStorageTarget",
        "Print UBound(item.values)",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "array-storage-rename", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "array-storage-rename", module: "caller.bas" };

    const analyze = context.service.analyze;
    context.project.analyze = (options) => context.service.analyze(options);
    let changedInputs = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        if (![...(options.overlays?.values() || [])].some((text) => text.includes("RenamedArrayStorageTarget"))) return result;
        const input = result.semanticArrayStorageInputs?.find((entry) =>
            entry.filePath === context.document.uri.fsPath && entry.kind === "field");
        if (!input) return result;
        input.kind = "variable";
        changedInputs++;
        return result;
    };

    const header = source.split("\n")[0];
    const target = { line: 0, character: header.indexOf("RenameArrayStorageTarget") + 1 };
    await assert.rejects(
        context.project.rename(context.document, target, "RenamedArrayStorageTarget"),
        /compiler array storage inputs/
    );
    assert.ok(changedInputs > 0,
        "post-rename validation must compare compiler-selected array storage kind");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(context.document, target, "RenamedArrayStorageTarget");
    assert.equal(edit.edits.length, 2);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedArrayStorageTarget"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "array storage validation must preserve preview-only refactoring");
});

test("project type rename rejects changed compiler aggregate access sections", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = [
        "Type RenameAccessRecord",
        "    public:",
        "    visibleValue As Long",
        "    private:",
        "    hiddenValue As Long",
        "End Type",
        "Dim item As RenameAccessRecord",
        "Print item.visibleValue",
        ""
    ].join("\n");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "aggregate-access-rename", modules: ["caller.bas"] }];
    context.values["analysis.activeContext"] = { name: "aggregate-access-rename", module: "caller.bas" };

    const analyze = context.service.analyze;
    let changedSections = 0;
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        const renamedSource = [...(options.overlays?.values() || [])].some((text) => text.includes("RenamedAccessRecord"));
        if (!renamedSource) return result;
        const section = result.semanticAggregateAccessInputs?.flatMap((group) => group.sections)
            .find((entry) => entry.visibility === "private" || entry.visibility === "public");
        if (!section) return result;
        section.visibility = section.visibility === "private" ? "public" : "private";
        changedSections++;
        return result;
    };

    const lines = source.split("\n");
    await assert.rejects(
        context.project.rename(context.document, { line: 0, character: lines[0].indexOf("RenameAccessRecord") + 1 }, "RenamedAccessRecord"),
        /compiler aggregate access sections/
    );
    assert.ok(changedSections > 0,
        "post-rename validation must compare compiler-selected aggregate access sections");

    context.service.analyze = analyze;
    context.project.analyze = null;
    const edit = await context.project.rename(
        context.document,
        { line: 0, character: lines[0].indexOf("RenameAccessRecord") + 1 },
        "RenamedAccessRecord"
    );
    assert.equal(edit.edits.length, 2);
    assert.ok(edit.edits.every((entry) => entry.newText === "RenamedAccessRecord"));
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source,
        "aggregate access validation must return a preview without modifying source");
});

test("project rename never selects targets from provisional recovery bindings", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const original = context.document.getText();
    context.document.getText = () => original + "Print 1 +\n";
    assert.equal(await context.service.check(context.document, false), true);
    assert.equal(context.service.getModel(context.document.uri).partial, true);
    await assert.rejects(context.project.rename(context.document, { line: 1, character: 8 }, "ScaleValue"), /provisional recovery bindings/);
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), original);
});

test("project rename rejects edits racing native validation", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const analyze = context.service.analyze;
    // Fault injection uses the same transaction engine with an in-process analyzer.
    context.project.analyze = (options) => context.service.analyze(options);
    let executions = 0;
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        if (++executions === 5) fs.appendFileSync(path.join(context.root, "implementation.bas"), "' concurrent edit\n");
        return result;
    };
    await assert.rejects(context.project.rename(context.document, { line: 1, character: 8 }, "ScaleValue"), /source changed/);
});

test("worker rename rejects editor and context changes before publishing its preview", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const worker = context.service.analysisWorker;
    const project = worker.project.bind(worker);
    const original = context.document.getText();
    for (const change of [
        () => { context.document.getText = () => original + "' unsaved concurrent edit\n"; },
        () => { context.values["analysis.projectContexts"][0].arguments = ["-d", "CONTEXT_CHANGED"]; },
        () => context.service.invalidate()
    ]) {
        context.document.getText = () => original;
        delete context.values["analysis.projectContexts"][0].arguments;
        context.service.invalidate();
        worker.project = async (options) => { const reply = await project(options); change(); return reply; };
        await assert.rejects(context.project.rename(context.document, { line: 1, character: 8 }, "ScaleValue"), /changed|cancelled/);
        assert.equal(worker.projects.size, 0);
    }
});

test("worker rename rejects edits while final freshness verification is returning", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const worker = context.service.analysisWorker;
    const verify = worker.verifyProject.bind(worker);
    const original = context.document.getText();
    worker.verifyProject = async (...args) => {
        const result = await verify(...args);
        context.document.getText = () => original + "' changed after verification\n";
        return result;
    };
    await assert.rejects(context.project.rename(context.document, { line: 1, character: 8 }, "ScaleValue"), /buffers changed/);
    assert.equal(worker.projects.size, 0);
});

test("project rename validates a virtual root with no declared overrides", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    fs.writeFileSync(context.document.uri.fsPath, "Type BaseType Extends Object\n Declare Virtual Sub AdjustValue()\nEnd Type\nSub BaseType.AdjustValue()\nEnd Sub\nDim instance As BaseType\ninstance.AdjustValue()\n");
    context.values["analysis.projectContexts"] = [{ name: "virtual", modules: ["caller.bas"] }];
    const edit = await context.project.rename(context.document, { line: 6, character: 12 }, "ScaleValue");
    assert.equal(edit.edits.length, 3);
});

test("project rename joins virtual families across modules and conditional inheritance without merging overloads", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const sources = {
        "api.bi": "Type BaseType Extends Object\n Declare Virtual Function AdjustValue Overload(ByVal value As Long) As Long\n Declare Function AdjustValue Overload(ByVal value As Double) As Long\nEnd Type\nType DerivedType Extends BaseType\n Declare Virtual Function AdjustValue Overload(ByVal value As Long) As Long Override\nEnd Type\n#ifdef ALTERNATE\nType LeafType Extends DerivedType\n Declare Function AdjustValue(ByVal value As Long) As Long Override\nEnd Type\n#else\nType LeafType As DerivedType\n#endif\n",
        "implementation.bas": '#include "api.bi"\nFunction BaseType.AdjustValue(ByVal value As Long) As Long\n Return 1\nEnd Function\nFunction BaseType.AdjustValue(ByVal value As Double) As Long\n Return 2\nEnd Function\nFunction DerivedType.AdjustValue(ByVal value As Long) As Long\n Return 3\nEnd Function\n#ifdef ALTERNATE\nFunction LeafType.AdjustValue(ByVal value As Long) As Long\n Return 4\nEnd Function\n#endif\n',
        "caller.bas": '#include "api.bi"\nDim instance As LeafType\nDim ByRef baseView As BaseType = instance\nDim ByRef derivedView As DerivedType = instance\nPrint baseView.AdjustValue(1)\nPrint derivedView.AdjustValue(1)\nPrint instance.AdjustValue(1)\nPrint baseView.AdjustValue(2.0)\n'
    };
    for (const [name, text] of Object.entries(sources)) fs.writeFileSync(path.join(context.root, name), text);
    let previous;
    for (const line of [4, 5, 6]) {
        const edit = await context.project.rename(context.document, { line, character: sources["caller.bas"].split("\n")[line].indexOf("AdjustValue") + 1 }, "ScaleValue");
        assert.equal(edit.edits.length, 9);
        const anchors = edit.edits.map((entry) => `${entry.uri.fsPath}:${entry.range.start.line}:${entry.range.start.character}`).sort();
        if (previous) assert.deepEqual(anchors, previous);
        previous = anchors;
    }
    const overload = await context.project.rename(context.document, { line: 7, character: 20 }, "ScaleReal");
    assert.equal(overload.edits.length, 3);
    for (const [name, text] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(context.root, name), "utf8"), text);
});

test("project validation compares virtual slots and retains external ABI restrictions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = "Type BaseType Extends Object\n Declare Virtual Sub AdjustValue()\nEnd Type\nSub BaseType.AdjustValue()\nEnd Sub\nDim instance As BaseType\ninstance.AdjustValue()\n";
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "virtual", modules: ["caller.bas"] }];
    const analyze = context.service.analyze;
    // Fault injection uses the same transaction engine with an in-process analyzer.
    context.project.analyze = (options) => context.service.analyze(options);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        if (options.overlays?.get(context.document.uri.fsPath)?.includes("ScaleValue")) result.symbolGraph.dispatch.find((method) => method.slot).slot++;
        return result;
    };
    await assert.rejects(context.project.rename(context.document, { line: 6, character: 12 }, "ScaleValue"), /virtual dispatch relationships/);
    context.service.analyze = async (options) => {
        const result = await analyze(options);
        if (options.overlays?.get(context.document.uri.fsPath)?.includes("ScaleValue")) result.expressionGraph.nodes[0].options++;
        return result;
    };
    await assert.rejects(context.project.rename(context.document, { line: 6, character: 12 }, "ScaleValue"), /native expression relationships/);
    for (const mutate of [
        (result) => { result.scopeGraph.scopes[0].kind = "namespace"; },
        (result) => { result.scopeGraph.shapes[0].dimensions++; },
        (result) => { result.scopeGraph.declarations[0].prototype = !result.scopeGraph.declarations[0].prototype; }
    ]) {
        context.service.analyze = async (options) => {
            const result = await analyze(options);
            if (options.overlays?.get(context.document.uri.fsPath)?.includes("ScaleValue")) mutate(result);
            return result;
        };
        await assert.rejects(context.project.rename(context.document, { line: 6, character: 12 }, "ScaleValue"), /native scopes, declarations, or type shapes/);
    }
    for (const mutate of [
        (result) => { result.tokenOrigins[0].sourceStart++; },
        (result) => { result.tokenOrigins[0].sourceEnd++; },
        (result) => { result.tokenOrigins[0].kind = "generated"; },
        (result) => { result.tokenOrigins.pop(); }
    ]) {
        context.service.analyze = async (options) => {
            const result = await analyze(options);
            if (options.overlays?.get(context.document.uri.fsPath)?.includes("ScaleValue")) mutate(result);
            return result;
        };
        await assert.rejects(context.project.rename(context.document, { line: 6, character: 12 }, "ScaleValue"), /physical token origins/);
    }
    context.service.analyze = analyze;
    fs.writeFileSync(context.document.uri.fsPath, 'Declare Sub AdjustValue Alias "external_name"()\nAdjustValue()\n');
    context.service.invalidate();
    await assert.rejects(context.project.rename(context.document, { line: 1, character: 2 }, "ScaleValue"), /external ABI/);
});

test("compiled address and virtual dispatch behavior is unchanged by validated rename", { skip: !process.env.FBC_EDITOR_EXECUTABLE || !process.env.FBC_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    context.values["analysis.projectContexts"] = [{ name: "runtime", modules: ["caller.bas"] }];
    for (const [fixtureName, statement, name, replacement] of [
        ["compiler-dispatch.bas", "Print instance.Choose(1)", "Choose", "SelectValue"],
        ["compiler-reference-forms.bas", "    Function Pick Overload(ByVal value As Long) As Long", "Pick", "PickInteger"]
    ]) {
        const source = fs.readFileSync(path.join(__dirname, "integration/workspace", fixtureName), "utf8");
        fs.writeFileSync(context.document.uri.fsPath, source);
        context.service.invalidate();
        const lines = source.split("\n");
        const edit = await context.project.rename(context.document, { line: lines.indexOf(statement), character: statement.indexOf(name) + 1 }, replacement);
        const offsets = [0];
        for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
        let renamed = source;
        const replacements = edit.edits.map((entry) => ({ offset: offsets[entry.range.start.line] + entry.range.start.character, end: offsets[entry.range.end.line] + entry.range.end.character, text: entry.newText }));
        for (const change of replacements.sort((left, right) => right.offset - left.offset)) renamed = renamed.slice(0, change.offset) + change.text + renamed.slice(change.end);
        const outputs = [];
        for (const [name, text] of [["before", source], ["after", renamed]]) {
            const filePath = path.join(context.root, `${name}.bas`);
            const executable = path.join(context.root, name);
            fs.writeFileSync(filePath, text);
            const compiled = await executeBoundedProcess({ command: process.env.FBC_EXECUTABLE, arguments: ["-x", executable, filePath], cwd: context.root, timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
            assert.equal(compiled.exitCode, 0, compiled.stdout + compiled.stderr);
            const executed = await executeBoundedProcess({ command: executable, arguments: [], cwd: context.root, timeoutMs: 5000, maxOutputBytes: 1024 * 1024 });
            assert.equal(executed.exitCode, 0, executed.stderr);
            outputs.push(executed.stdout);
        }
        assert.equal(outputs[1], outputs[0], fixtureName);
        assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
    }
});

test("project rename includes address-taking across build configurations", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    fs.appendFileSync(context.document.uri.fsPath, "Dim callback As Function(ByVal value As InputType) As InputType = @AdjustValue\n");
    const edit = await context.project.rename(context.document, { line: 1, character: 8 }, "ScaleValue");
    assert.equal(edit.edits.length, 4);
    assert.equal(new Set(edit.edits.map((entry) => path.basename(entry.uri.fsPath))).size, 3);
});

test("project rename follows namespace imports and selected overloads in address and result expressions", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = fs.readFileSync(path.join(__dirname, "integration/workspace/compiler-reference-forms.bas"), "utf8");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "references", modules: ["caller.bas"] }];
    const lines = source.split("\n");
    for (const [statement, name, replacement, count] of [
        ["Namespace Functions", "Functions", "Library", 5],
        ["    Namespace Nested", "Nested", "Constants", 2],
        ["    Function Pick Overload(ByVal value As Long) As Long", "Pick", "PickInteger", 5],
        ["    Function Pick Overload(ByVal value As Double) As Double", "Pick", "PickReal", 4]
    ]) {
        const edit = await context.project.rename(context.document, { line: lines.indexOf(statement), character: statement.indexOf(name) + 1 }, replacement);
        assert.equal(edit.edits.length, count, replacement);
        assert.ok(edit.edits.every((entry) => entry.newText === replacement));
    }
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

test("project rename follows forward type replacements without merging typedef names", { skip: !process.env.FBC_EDITOR_EXECUTABLE }, async (t) => {
    const context = fixture(t);
    const source = fs.readFileSync(path.join(__dirname, "integration/workspace/compiler-forward-types.bas"), "utf8");
    fs.writeFileSync(context.document.uri.fsPath, source);
    context.values["analysis.projectContexts"] = [{ name: "forward", modules: ["caller.bas"] }];
    const lines = source.split("\n");
    for (const [statement, name, replacement, count] of [
        ["Type Node", "Node", "Item", 3],
        ["Type Link As Node", "Link", "NodeAlias", 4],
        ["Type Element As Long", "Element", "ElementType", 2],
        ["Type Opaque As Opaque", "Opaque", "OpaqueHandle", 3],
        ["Type As Element Ptr FirstPointer, SecondPointer", "FirstPointer", "ElementPointer", 2],
        ["    value As Long", "value", "payload", 3]
    ]) {
        const edit = await context.project.rename(context.document, { line: lines.indexOf(statement), character: statement.indexOf(name) + 1 }, replacement);
        assert.equal(edit.edits.length, count, replacement);
    }
    assert.equal(fs.readFileSync(context.document.uri.fsPath, "utf8"), source);
});

/* end of compiler-project.test.js */
