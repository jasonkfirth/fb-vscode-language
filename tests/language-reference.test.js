/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/language-reference.test.js

    Purpose:

        Verify useful offline reference content and its source reproducibility.

    Responsibilities:

        - validate overloads, parameter documentation, and public header APIs
        - verify that generated excerpts match the compiler checkout
        - preserve attribution and exact source revision links

    This file intentionally does NOT contain:

        - network requests
        - editor API mocks
        - file generation
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("node:child_process");
const reference = require("../data/language-reference.json");
const grammar = require("../syntaxes/source/freebasic.grammar-source.json");
const { getReferenceEntries, getReferenceMarkdown, getReferenceNames, getReferenceSignatures } = require("../lib/language-reference");
const { generateReference, referenceSourceRevision } = require("../tools/build-language-reference");
const { resolveFreeBasicRoot } = require("../tools/audit-freebasic-coverage");

test("manual signatures expose useful names, defaults, and parameter descriptions", () => {
    const mouse = getReferenceSignatures("GetMouse");
    assert.equal(mouse.length, 2);
    assert.equal(mouse[0].parameters[0].name, "x");
    assert.match(mouse[0].parameters[0].documentation, /coordinate/);
    assert.equal(mouse[0].parameters[2].optional, true);
    assert.equal(getReferenceSignatures("Sin")[0].parameters[0].typeName, "double");
    const mouseReference = getReferenceMarkdown("GetMouse");
    assert.match(mouseReference, /Parameters:\n\n- `x`: x coordinate value/);
    assert.equal(mouseReference.match(/`x`: x coordinate value/g)?.length, 1,
        "identical parameter descriptions across overloads should appear only once");
    assert.ok(getReferenceSignatures("String").length >= 2);
});

test("bundled API signatures identify their required header and namespace", () => {
    assert.ok(getReferenceNames().includes("GFX3SURFACELOAD"));
    const blit = getReferenceEntries("fb.Gfx3SurfaceBlit")[0];
    assert.equal(blit.header, "fbgfx3.bi");
    assert.equal(blit.namespace.toLowerCase(), "fb");
    assert.equal(blit.signatures[0].parameters.length, 10);
    assert.equal(getReferenceEntries("sfxlib.Echo")[0].header, "sfxlib_effects.bi");
    assert.match(getReferenceMarkdown("sfxlib.Echo"), /links the sfxlib runtime automatically/);
    const midiPlaying = getReferenceEntries("sfxlib.MidiPlaying")[0];
    assert.equal(midiPlaying.header, "sfxlib_raw.bi");
    assert.equal(midiPlaying.signatures[0].parameters.length, 0);
    assert.match(getReferenceMarkdown("sfxlib.MidiPlaying"), /links the sfxlib runtime automatically/);
    const eventType = getReferenceEntries("Event").find((entry) => entry.header);
    assert.equal(eventType.header, "fbgfx.bi");
    assert.equal(eventType.namespace.toLowerCase(), "fb");
    assert.match(getReferenceMarkdown("FB.DrawStringSize"), /links the selected graphics runtime automatically/);
    assert.match(getReferenceMarkdown("FB.Gfx3SurfaceLoad"), /selects and links gfxlib3/);
    assert.equal(getReferenceEntries("Unrelated.Sin").length, 0);
    assert.deepEqual(getReferenceEntries("Sin#"), getReferenceEntries("Sin"));
    assert.match(getReferenceMarkdown("Sin#"), /Returns the sine of an angle/);
    assert.deepEqual(getReferenceSignatures("Sin#"), getReferenceSignatures("Sin"));
    assert.match(getReferenceMarkdown("SFX"), /Sfx Stop Channel/);
    assert.match(getReferenceMarkdown("ScreenRes"), new RegExp(reference.sourceRevision));
    assert.match(getReferenceMarkdown("FB.DrawStringSize", { header: "fbgfx.bi" }), /Declared in fbgfx\.bi/);
    assert.equal(getReferenceMarkdown("FB.DrawStringSize", { header: "unrelated.bi" }), null);
    assert.equal(getReferenceMarkdown("nonexistent_symbol"), null);
});

test("opt-in compiler intrinsics expose their manual forms and required header", () => {
    for (const [name, expectedLabels] of [
        ["Serialize", ["Serialize(value)", "Serialize(array())"]],
        ["Deserialize", ["Deserialize(payload, destination)", "Deserialize(payload, array())"]]
    ]) {
        const entry = getReferenceEntries(name).find((candidate) => candidate.header === "fbserialize.bi");
        assert.ok(entry, `${name} should be included even though it is not a grammar keyword`);
        assert.deepEqual(entry.signatures.map((signature) => signature.label), expectedLabels);
        assert.match(getReferenceMarkdown(name), /Requires `#include once "fbserialize\.bi"`/);
        assert.match(getReferenceMarkdown(name), new RegExp(reference.sourceRevision));
    }
    assert.match(getReferenceSignatures("Serialize")[0].parameters[0].documentation, /supported variable/);
    assert.match(getReferenceSignatures("Deserialize")[0].parameters[1].documentation, /writable supported variable/);
    assert.match(getReferenceMarkdown("Serialize"), /does not perform file or network I\/O/i);
    assert.match(getReferenceMarkdown("Serialize"), /rejected at compilation/i);
    assert.match(getReferenceMarkdown("Deserialize"), /original destination remains unchanged/i);
    assert.match(getReferenceSignatures("Serialize")[0].documentation, /does not perform file or network I\/O/i);
});

test("reference provenance ignores compiler-only commits but follows its actual inputs", (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fb-reference-revision-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    const git = (...args) => execFileSync("git", ["-C", directory,
        "-c", "user.name=Reference Fixture", "-c", "user.email=reference@example.invalid",
        "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${path.join(directory, "empty-hooks")}`,
        ...args], { encoding: "utf8", env: environment, timeout: 5000, maxBuffer: 65536 }).trim();
    git("init", "-q");
    fs.mkdirSync(path.join(directory, "doc/manual/cache"), { recursive: true });
    fs.mkdirSync(path.join(directory, "src/compiler"), { recursive: true });
    const page = path.join(directory, "doc/manual/cache/KeyPgExample.wakka");
    fs.writeFileSync(page, "Reference input\n");
    git("add", ".");
    git("commit", "-qm", "Reference inputs");
    const first = git("rev-parse", "HEAD");
    assert.equal(referenceSourceRevision(directory), first);
    fs.writeFileSync(path.join(directory, "src/compiler/private.bas"), "'' Unrelated compiler input\n");
    git("add", ".");
    git("commit", "-qm", "Compiler only");
    assert.notEqual(git("rev-parse", "HEAD"), first);
    assert.equal(referenceSourceRevision(directory), first);
    fs.writeFileSync(page, "Changed reference input\n");
    git("add", ".");
    git("commit", "-qm", "Update reference input");
    assert.equal(referenceSourceRevision(directory), git("rev-parse", "HEAD"));
});

test("offline reference is reproducible from the configured 1.20.5 source", () => {
    const root = resolveFreeBasicRoot(process.env.FREEBASIC_ROOT || "");
    const generated = generateReference(root, grammar);
    /* A stale commit stamp should not dump every reference entry into TAP. */
    assert.equal(reference.sourceRevision, generated.sourceRevision, "Regenerate the reference after its manual/header inputs change.");
    assert.deepEqual(reference, generated);
    assert.equal(reference.sourceVersion, grammar.sourceVersion);
    assert.ok(Object.keys(reference.entries).length > 550);
    assert.equal(fs.readFileSync(path.join(__dirname, "../docs/fdl-1.2.txt"), "utf8").replace(/\r\n/g, "\n"), fs.readFileSync(path.join(root, "doc/fdl-1.2.txt"), "utf8").replace(/\r\n/g, "\n"));
});

/* end of tests/language-reference.test.js */
