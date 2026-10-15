/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/compiler-diagnostic-sidecar.test.js

    Purpose:

        Verify the compiler-owned diagnostic transport and source ranges.

    Responsibilities:

        - reject incomplete, inconsistent, or malformed FBCDIA artifacts
        - merge structured points only with matching textual diagnostics
        - map UTF-16 source positions to bounded editor ranges
        - validate compiler-context spans used by focused Quick Fixes

    This file intentionally does NOT contain:

        - compiler execution
        - editor-host integration
        - source parsing or diagnostic guessing
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    attachStructuredDiagnosticData,
    compilerByRefFunctionResultAssignmentRange,
    compilerConstantConversionOverflowRange,
    compilerDiagnosticContextLabel,
    compilerDiagnosticGuidance,
    compilerDeclarationSuffixConflictRange,
    compilerForCounterWrapRange,
    compilerErrorResumeNextRange,
    compilerForNextCounterMismatchRange,
    compilerLineInputBufferCapacityRange,
    compilerRedundantNewAnyInitializerRange,
    compilerIgnoredDeclarationSuffixRange,
    compilerImplicitParameterPassingModeRange,
    compilerImplicitVariableAllocationRange,
    compilerMissingClosingQuoteRange,
    compilerMeaninglessNextVariableRange,
    compilerProcedureSignatureMismatchRange,
    decodeCompilerDiagnosticSidecar,
    forNextCounterIdentifiers,
    forNextCounterIdentifierRange,
    physicalDiagnosticRange,
    physicalPointMatchesDiagnosticText
} = require("../lib/compiler-diagnostic-sidecar");

test("simple constant-overflow declarations offer only a fitting wider integer type", () => {
    const source = "Dim narrowValue As Byte = 300\n";
    const pointCharacter = source.indexOf("300");
    assert.deepEqual(compilerConstantConversionOverflowRange(source, {
        severity: "warning",
        message: "Overflow in constant conversion",
        physicalPoint: { line: 0, character: pointCharacter }
    }), {
        line: 0,
        startCharacter: pointCharacter,
        endCharacter: pointCharacter + 3,
        typeStartCharacter: source.indexOf("Byte"),
        typeEndCharacter: source.indexOf("Byte") + "Byte".length,
        name: "narrowValue",
        sourceType: "Byte",
        widerType: "Short"
    });
    assert.equal(compilerConstantConversionOverflowRange("Dim value As Byte = 300 + 1\n", {
        severity: "warning", message: "Overflow in constant conversion", line: 0
    }), null, "computed expressions are not rewritten");
    assert.equal(compilerConstantConversionOverflowRange(
        "Dim value As Byte = 999999999999999999999999999999999999999999\n",
        { severity: "warning", message: "Overflow in constant conversion", line: 0 }
    ), null, "values with no supported wider integer type are not offered a rewrite");
});

test("FOR counter wrap warnings use the compiler point within the limit expression", () => {
    const source = [
        "Sub CounterWrapProbe()",
        "    For counter As UByte = 0 To 255",
        "    Next",
        "End Sub",
        ""
    ].join("\n");
    const line = source.split("\n")[1];
    const point = { line: 1, character: line.indexOf("255") };
    assert.deepEqual(compilerForCounterWrapRange(source, {
        severity: "warning",
        message: "FOR counter variable is unable to exceed limit value",
        physicalPoint: point
    }), {
        line: 1,
        startCharacter: point.character,
        endCharacter: point.character + 1
    });
    assert.equal(compilerForCounterWrapRange(source, {
        severity: "warning",
        message: "FOR counter variable is unable to exceed limit value",
        physicalPoint: { line: 2, character: 4 }
    }), null, "a point outside the warned FOR limit expression must not be projected");
});

test("BYREF-result equality warning identifies one bare function-call assignment target", () => {
    const source = [
        "Sub ByRefResultProbe()",
        "    GetReference(1) = 2",
        "End Sub",
        ""
    ].join("\n");
    const line = source.split("\n")[1];
    const diagnostic = {
        severity: "warning",
        message: "'=' parsed as equality operator in function argument, not assignment to BYREF function result",
        line: 1,
        physicalPoint: { line: 1, character: line.indexOf("= 2") + 2 }
    };
    const equals = line.indexOf("=");
    const callStart = line.indexOf("GetReference");
    const callEnd = line.indexOf(")") + 1;
    assert.deepEqual(compilerByRefFunctionResultAssignmentRange(source, diagnostic), {
        line: 1,
        startCharacter: equals,
        endCharacter: equals + 1,
        callStartCharacter: callStart,
        callEndCharacter: callEnd
    });
    assert.equal(compilerByRefFunctionResultAssignmentRange(
        source.replace("    GetReference(1) = 2", "    If GetReference(1) = 2 Then"),
        { ...diagnostic, physicalPoint: { line: 1, character: 26 } }
    ), null, "comparison-shaped IF conditions must not receive an assignment fix");
    assert.equal(compilerByRefFunctionResultAssignmentRange(
        source.replace("    GetReference(1) = 2", "    GetReference(1) = 2: GetReference(2) = 3"),
        diagnostic
    ), null, "multiple assignments on one line must remain ambiguous");
});

function diagnosticArtifact(overrides = {}) {
    const fields = {
        header: "FBCDIA\t1\t1.20.4",
        source: "SRC\t1\t/tmp/main.bas",
        module: "M\t1\t/tmp/main.bas\tlinux-x86_64",
        capability: "CAP\t1\tprocedure-signature-mismatches\tavailable",
        diagnostic: "DI\t1\t1\terror\t42\tunresolved-variable\t/tmp/main.bas\t1\tVariable%20not%20declared\t\t\t1\t1\t6",
        end: "END\t1\t1\t1\t1\t1\t0"
    };
    Object.assign(fields, overrides);
    return [fields.header, fields.source, fields.module, fields.capability, fields.diagnostic, fields.end].join("\n") + "\n";
}

test("FBCDIA validates its footer and retains compiler physical points", () => {
    const decoded = decodeCompilerDiagnosticSidecar(diagnosticArtifact(), { cwd: "/tmp", compilerExitCode: 1 });

    assert.equal(decoded.producer, "1.20.4");
    assert.deepEqual(decoded.diagnostics[0], {
        module: 1,
        severity: "error",
        code: 42,
        context: "unresolved-variable",
        filePath: "/tmp/main.bas",
        displayedLine: 1,
        message: "Variable not declared",
        detail: "",
        customText: "",
        physicalPoint: { line: 0, character: 6 }
    });
});

test("FBCDIA rejects incomplete totals, source mismatches, and exit disagreement", () => {
    assert.throws(() => decodeCompilerDiagnosticSidecar(diagnosticArtifact().replace("END\t1\t1\t1\t1\t1\t0", "END\t1\t1\t1\t0\t0\t0"), { cwd: "/tmp" }), /completion totals/);
    assert.throws(() => decodeCompilerDiagnosticSidecar(diagnosticArtifact().replace("/tmp/main.bas\t1\tVariable", "/tmp/other.bas\t1\tVariable"), { cwd: "/tmp" }), /unobserved source/);
    assert.throws(() => decodeCompilerDiagnosticSidecar(diagnosticArtifact(), { cwd: "/tmp", compilerExitCode: 0 }), /exit status/);
    assert.throws(() => decodeCompilerDiagnosticSidecar(diagnosticArtifact().replace("\t1\t1\t6\n", "\t0\t1\t6\n"), { cwd: "/tmp" }), /physical point/);
});

test("structured points enrich only one matching textual diagnostic", () => {
    const structured = decodeCompilerDiagnosticSidecar(diagnosticArtifact(), { cwd: "/tmp", compilerExitCode: 1 }).diagnostics;
    const textual = [{ filePath: "/tmp/main.bas", line: 0, severity: "error", code: 42, message: "Variable not declared" }];
    const [matched] = attachStructuredDiagnosticData(textual, structured);
    assert.deepEqual(matched.physicalPoint, { line: 0, character: 6 });
    assert.equal(matched.compilerContext, "unresolved-variable");

    const ambiguous = attachStructuredDiagnosticData(textual, [...structured, structured[0]]);
    assert.equal(ambiguous[0].physicalPoint, undefined, "ambiguous structured matches must keep the textual fallback");
});

test("physical diagnostic ranges respect source bounds and UTF-16 pairs", () => {
    assert.deepEqual(physicalDiagnosticRange("Print missingValue\n", { line: 0, character: 6 }), {
        line: 0, startCharacter: 6, endCharacter: 7
    });
    const text = 'Print "😀" + value';
    const start = text.indexOf("value");
    assert.deepEqual(physicalDiagnosticRange(text, { line: 0, character: start }), {
        line: 0, startCharacter: start, endCharacter: start + 1
    });
    assert.equal(physicalDiagnosticRange(text, { line: 3, character: 0 }), null);
    assert.equal(physicalDiagnosticRange(text, { line: 0, character: text.length + 1 }), null);
    assert.equal(physicalDiagnosticRange(text, { line: -1, character: 0 }), null);
});

test("physical points must identify a token named by the compiler diagnostic", () => {
    const unresolvedVariable = {
        message: "Variable not declared, missingValue",
        compilerDetail: "missingValue",
        physicalPoint: { line: 0, character: 6 }
    };
    assert.equal(physicalPointMatchesDiagnosticText("Print missingValue", unresolvedVariable), true);

    const parserPointOnAs = {
        message: "Expected identifier, found 'MissingType'",
        compilerDetail: "found 'MissingType'",
        physicalPoint: { line: 0, character: 17 }
    };
    assert.equal(physicalPointMatchesDiagnosticText("Dim invalidValue As MissingType", parserPointOnAs), false,
        "a valid compiler point on an unrelated token must not become a misleading squiggle");
});

test("compiler FOR/NEXT context exposes only the exact single counter identifier", () => {
    const source = "For outer = 1 To 2\n    Next inner ' FBC reports the mismatched counter here\n";
    const diagnostic = {
        compilerContext: "for-next-variable-mismatch",
        physicalPoint: { line: 1, character: 9 }
    };

    assert.equal(compilerDiagnosticContextLabel(diagnostic.compilerContext), "FOR/NEXT counter mismatch");
    assert.equal(compilerDiagnosticContextLabel("for-next-counter-binding"),
        "Optional NEXT counter name must refer to a declared variable");
    assert.deepEqual(forNextCounterIdentifierRange(source, 1), {
        line: 1, startCharacter: 9, endCharacter: 14, name: "inner"
    });
    assert.deepEqual(compilerForNextCounterMismatchRange(source, diagnostic), {
        line: 1, startCharacter: 9, endCharacter: 14, name: "inner"
    });
    assert.equal(compilerForNextCounterMismatchRange(source, {
        ...diagnostic,
        physicalPoint: { line: 1, character: 0 }
    }), null, "the compiler point must identify the counter itself");
    assert.equal(forNextCounterIdentifierRange("For i = 1 To 2\nNext i, j\n", 1), null,
        "multiple NEXT counters are ambiguous and do not receive this fix");
    const multiCounterSource = "For outer = 1 To 2\n    For inner = 1 To 2\n        Next inenr, outer\n";
    assert.deepEqual(compilerForNextCounterMismatchRange(multiCounterSource, {
        ...diagnostic,
        physicalPoint: { line: 2, character: 13 }
    }), { line: 2, startCharacter: 13, endCharacter: 18, name: "inenr" },
    "the exact compiler point identifies one editable counter in a comma-separated list");
    assert.deepEqual(forNextCounterIdentifiers("Next first, second ' retained note\n", 0), {
        line: 0,
        counters: [
            { line: 0, startCharacter: 5, endCharacter: 10, name: "first" },
            { line: 0, startCharacter: 12, endCharacter: 18, name: "second" }
        ],
        indentation: "",
        keyword: "Next",
        trailingText: " ' retained note"
    });
    assert.equal(compilerDiagnosticContextLabel("__proto__"), "", "unknown context names must not reach inherited object properties");
    assert.equal(compilerDiagnosticContextLabel("variable-case-collision"),
        "This variable name differs only by case from an existing declaration");
    assert.equal(compilerDiagnosticContextLabel("declaration-suffix-as-conflict"),
        "A type suffix and AS clause cannot both specify this declaration's type");
});

test("ELSE-followed-by-IF warning explains nested versus chained conditionals", () => {
    const warning = {
        severity: "warning",
        message: "'IF' statement found directly after multi-line 'ELSE'"
    };
    assert.equal(compilerDiagnosticGuidance(warning),
        "This starts a nested IF. If you meant another branch of the same conditional, use ELSEIF.");
    assert.equal(compilerDiagnosticGuidance({ ...warning, severity: "error" }), "");
    assert.equal(compilerDiagnosticGuidance({ ...warning, message: "IF statement found after ELSE" }), "");

    const byRefWarning = {
        severity: "warning",
        message: "'=' parsed as equality operator in function argument, not assignment to BYREF function result"
    };
    assert.equal(compilerDiagnosticGuidance(byRefWarning),
        "If you intended to assign to the BYREF result, wrap the function call in parentheses: (function(arguments)) = value.");
    assert.equal(compilerDiagnosticGuidance({ ...byRefWarning, severity: "error" }), "");

    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Possible escape sequence found in 'C:\\newfolder'"
    }), "This string is not escape-processed. Prefix it with ! if you intended C-style escape sequences.");

});

test("command-line override warning explains option precedence", () => {
    const warning = { severity: "warning", message: "Command line option overrides directive" };
    assert.equal(compilerDiagnosticGuidance(warning),
        "The command-line option takes precedence over this source directive. Change the build configuration or remove the directive if you want a different setting.");
    assert.equal(compilerDiagnosticGuidance({ ...warning, severity: "error" }), "");
});

test("mixed object build warnings recommend consistent project settings", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Object files or libraries with mixed multithreading (-mt) options"
    }), "Linked objects or libraries use different -mt settings. Rebuild all dependencies with the same multithreading option before linking.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Object files or libraries with mixed language (-lang) options"
    }), "Linked objects or libraries use different -lang dialects. Rebuild all components with a consistent dialect before linking.");
});

test("BYREF temporary warning explains when the compiler passes a temporary", () => {
    const warning = {
        severity: "warning",
        message: "Suspicious address expression passed to BYREF parameter, at parameter 1 of CONSUME()"
    };
    assert.equal(compilerDiagnosticGuidance(warning),
        "FBC passes a temporary for this non-addressable expression. If the procedure should access the original variable, pass that variable directly; otherwise confirm the temporary is intentional.");
    assert.equal(compilerDiagnosticGuidance({ ...warning, severity: "error" }), "");
});

test("ANY PTR deletion warning explains why the allocation type must be preserved", () => {
    const warning = { severity: "warning", message: "Deleting ANY pointers is undefined" };
    assert.equal(compilerDiagnosticGuidance(warning),
        "FBC cannot determine the allocated type or required destructor through an ANY PTR. Preserve the actual pointer type and use the cleanup operation that matches the allocation.");
    assert.equal(compilerDiagnosticGuidance({ ...warning, severity: "error" }), "");
    assert.equal(compilerDiagnosticGuidance({ ...warning, message: "Delete Any Ptr is undefined" }), "");
});

test("pointer argument warnings distinguish address passing from value passing", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Passing scalar as pointer, at parameter 1 of TAKEPOINTER()"
    }), "This parameter expects an address, not the scalar value. If you intended to pass the variable's address, supply an appropriately typed pointer; otherwise check the parameter type.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Passing pointer to scalar, at parameter 1 of TAKESCALAR()"
    }), "This parameter expects a scalar value, not a pointer. If you intended to pass the pointed-to value, dereference the pointer; otherwise check the parameter type.");
    assert.equal(compilerDiagnosticGuidance({ severity: "error", message: "Passing scalar as pointer" }), "");
});

test("file pointer warning distinguishes the address from the pointed-to data", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Passing Pointer, at parameter 3 of PUT()"
    }), "This file operation transfers the pointer value (the address), not the memory it points to. To transfer the data, pass the pointed-to value instead; raw addresses are not portable between runs.");
    assert.equal(compilerDiagnosticGuidance({ severity: "error", message: "Passing Pointer" }), "");
});

test("raw UDT file warning explains non-portable pointer and managed fields", () => {
    const warning = {
        severity: "warning",
        message: "UDT with pointer, var-len string, or var-len array fields, at parameter 3 of PUT()"
    };
    assert.equal(compilerDiagnosticGuidance(warning),
        "Raw file transfer writes the UDT's in-memory representation, including pointer or runtime-managed fields, not the data they reference. Serialize those fields explicitly for portable records.");
    assert.equal(compilerDiagnosticGuidance({ ...warning, severity: "error" }), "");
});

test("different pointer type warning advises checking compatibility before casting", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Passing different pointer types, at parameter 1 of TAKEWIDETEXT()"
    }), "The argument and parameter point to different types. Verify their representations; cast explicitly only when the conversion is genuinely compatible.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Passing different pointer types"
    }), "The argument and parameter point to different types. Verify their representations; cast explicitly only when the conversion is genuinely compatible.");
});

test("suspicious pointer assignment warning explains that pointed-to data is not converted", () => {
    assert.equal(compilerDiagnosticGuidance({ severity: "warning", message: "Suspicious pointer assignment" }),
        "This assignment preserves the address; it does not convert the pointed-to data. Confirm the destination pointer matches the object's actual type, or cast only for an intentional reinterpretation.");
    assert.equal(compilerDiagnosticGuidance({ severity: "error", message: "Suspicious pointer assignment" }), "");
});

test("mixed Boolean/numeric logic warning explains FBC's conversion", () => {
    const warning = {
        severity: "warning",
        message: "Suspicious logic operation, mixed boolean and non-boolean operands"
    };
    assert.equal(compilerDiagnosticGuidance(warning),
        "FBC converts the Boolean operand to an integer for this mixed operation. Use Boolean operands for logical conditions or consistently numeric operands for bitwise work, according to your intent.");
    assert.equal(compilerDiagnosticGuidance({ ...warning, severity: "error" }), "");
});

test("signedness warning explains negative values after unsigned conversion", () => {
    assert.equal(compilerDiagnosticGuidance({ severity: "warning", message: "Mixing signed/unsigned operands" }),
        "FBC may convert the signed value to unsigned; a negative operand can then behave like a large positive value. Convert both operands explicitly to a common signedness if that is intended.");
    assert.equal(compilerDiagnosticGuidance({ severity: "error", message: "Mixing signed/unsigned operands" }), "");
});

test("shift-count warning explains FBC's masking behavior", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Shift value greater than or equal to number of bits in data type"
    }), "FBC masks an out-of-range constant shift count to the low bits selected by the operand width. Check that this wraparound is intended; otherwise keep the count between zero and width minus one.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "error",
        message: "Shift value greater than or equal to number of bits in data type"
    }), "");
});

test("FOR limit warning explains possible counter wraparound", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "FOR counter variable is unable to exceed limit value"
    }), "FBC sees the limit at the counter type's boundary in this loop direction. The counter may wrap instead of passing the limit, so the loop may not terminate naturally; use a wider counter or reduce the limit.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "error",
        message: "FOR counter variable is unable to exceed limit value"
    }), "");
});

test("branch crossing warning explains skipped local initialization", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Branch crossing local variable definition, to label: INNER1, variable: I"
    }), "This branch skips a local variable's declaration or initialization. Restructure the jump or move initialization so every path initializes the variable before use.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "error",
        message: "Branch crossing local variable definition"
    }), "");
});

test("constant conversion overflow warning explains the representable range", () => {
    assert.equal(compilerDiagnosticGuidance({ severity: "warning", message: "Overflow in constant conversion" }),
        "This constant value or result is outside the target type's representable range. Use a wider type or adjust the value, and check literal suffixes if they affect the intended type.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Overflow in constant conversion, at parameter 1 (x) of F()"
    }), "The constant conversion for parameter 1 (x) of F() exceeds its representable range. Adjust the constant or widen the parameter type if the procedure contract allows.");
    assert.equal(compilerDiagnosticGuidance({ severity: "error", message: "Overflow in constant conversion" }), "");
    assert.equal(compilerDiagnosticGuidance({
        severity: "error",
        message: "Overflow in constant conversion, at parameter 1 (x) of F()"
    }), "");
});

test("oversized literal warning explains that the compiler truncated the value", () => {
    assert.equal(compilerDiagnosticGuidance({ severity: "warning", message: "Literal number too big, truncated" }),
        "FBC truncated this literal because its value exceeds the supported literal range. Use a representable literal or split the calculation; a wider destination type cannot restore bits already lost while parsing.");
    assert.equal(compilerDiagnosticGuidance({ severity: "error", message: "Literal number too big, truncated" }), "");
});

test("missing numeric digit warning explains incomplete literal prefixes", () => {
    assert.equal(compilerDiagnosticGuidance({ severity: "warning", message: "Expected digit" }),
        "This numeric literal is missing a required digit after a base prefix or exponent marker. Add a valid digit or remove the incomplete prefix or marker.");
    assert.equal(compilerDiagnosticGuidance({ severity: "error", message: "Expected digit" }), "");
});

test("implicit conversion warning names signedness and width as review points", () => {
    assert.equal(compilerDiagnosticGuidance({ severity: "warning", message: "Implicit conversion" }),
        "FBC converts this expression to fit its context. Check whether signedness and width are intentional; use an explicit cast or literal suffix when you need a specific representation.");
    assert.equal(compilerDiagnosticGuidance({ severity: "error", message: "Implicit conversion" }), "");
});

test("large stack warnings distinguish dynamic arrays from shared storage", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Variable too large for stack, consider making it SHARED"
    }), "This local needs more stack space than FBC considers safe. SHARED moves it to module-wide storage and changes its lifetime and visibility; use that only when shared state is intended.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Array too large for stack, consider making it var-len or SHARED"
    }), "This fixed-size array is too large for the stack. Consider a variable-length array if its size need not be fixed; SHARED instead moves storage to module scope and changes its lifetime and visibility.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "error",
        message: "Variable too large for stack, consider making it SHARED"
    }), "");
});

test("optional parameter initializer warning explains declaration/definition consistency", () => {
    const warning = {
        severity: "warning",
        message: "Mismatching parameter initializer, at parameter 1 (count) of Process()"
    };
    assert.equal(compilerDiagnosticGuidance(warning),
        "The optional parameter's default differs between its declaration and definition. Keep them consistent so callers do not compile with a default that disagrees with the implementation.");
    assert.equal(compilerDiagnosticGuidance({ ...warning, severity: "error" }), "");
});

test("ignored suffix warnings explain that the suffix has no type effect", () => {
    const guidance = "FBC ignored this type suffix, so it does not control the value's type here. Remove it; use an AS clause when you need an explicit declaration type.";
    for (const message of ["Suffix ignored", "Suffix ignored in 'for%'", "Suffix ignored in 'value%'"]) {
        assert.equal(compilerDiagnosticGuidance({ severity: "warning", message }), guidance);
    }
    assert.equal(compilerDiagnosticGuidance({ severity: "error", message: "Suffix ignored in 'for%'" }), "");
});

test("discarded CONST warning explains the lost read-only guarantee", () => {
    const warning = {
        severity: "warning",
        message: "CONST qualifier discarded, at parameter 1 of MUTATE()"
    };
    assert.equal(compilerDiagnosticGuidance(warning),
        "Discarding CONST permits mutation through this alias. Preserve CONST when the underlying storage may be read-only; remove it only when you know the object is mutable.");
    assert.equal(compilerDiagnosticGuidance({ ...warning, severity: "error" }), "");
});

test("reserved global warning recommends avoiding backend symbol collisions", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Use of reserved global or backend symbol, symbol"
    }), "This global name is reserved by the compiler or target backend. Choose a project-specific name to avoid collisions in generated code.");
});

test("ambiguous LEN, SIZEOF, and TYPEOF warnings explain the chosen name kind", () => {
    const expected = "FBC resolved LEN as type 'MSG' instead of variable 'MSG'. Make the intended value expression unambiguous, such as indexing an array when appropriate, or rename one of the conflicting declarations.";
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Ambiguous len(), referring to type MSG, instead of variable MSG"
    }), expected);
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Ambiguous typeof(), referring to type MSG, instead of constant MSG"
    }), "FBC resolved TYPEOF as type 'MSG' instead of constant 'MSG'. Make the intended value expression unambiguous, such as indexing an array when appropriate, or rename one of the conflicting declarations.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Ambiguous len(), referring to variable FWD, instead of forward reference FWD"
    }), "FBC resolved LEN as variable 'FWD' instead of forward reference 'FWD'. Make the intended value expression unambiguous, such as indexing an array when appropriate, or rename one of the conflicting declarations.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "error",
        message: "Ambiguous len(), referring to type MSG, instead of variable MSG"
    }), "");
});

test("return method warning explains declaration and definition agreement", () => {
    const guidance = "The procedure signature and its declaration or function-pointer type disagree about returning by value or BYREF. Make their return methods match; callers depend on that contract.";
    const warning = { severity: "warning", message: "Return method mismatch" };
    assert.equal(compilerDiagnosticGuidance(warning), guidance);
    assert.equal(compilerDiagnosticGuidance({ ...warning, message: "Return method mismatch in function pointer" }), guidance);
    assert.equal(compilerDiagnosticGuidance({ ...warning, severity: "error" }), "");
});

test("function-pointer return type warning explains the signature mismatch", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Return type mismatch in function pointer"
    }), "The function pointer's result type does not match the target function's result. Make the declared pointer signature match before calling through it.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Return type mismatch"
    }), "");
});

test("function-pointer ABI warnings explain convention and arity mismatches", () => {
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Calling convention mismatch in function pointer"
    }), "The function pointer and target function use different calling conventions. Make them match; the convention determines how arguments and results cross the call boundary.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "warning",
        message: "Argument count mismatch in function pointer"
    }), "The function pointer and target function declare different parameter counts. Match their signatures before calling through the pointer.");
    assert.equal(compilerDiagnosticGuidance({
        severity: "error",
        message: "Calling convention mismatch in function pointer"
    }), "");
});

test("CPTR warning explains the pointer target and numeric-address caveat", () => {
    const warning = { severity: "warning", message: "Cast to non-pointer" };
    assert.equal(compilerDiagnosticGuidance(warning),
        "CPTR is normally for a pointer target. If you need a numeric address, choose an integer type that can hold the target's pointer width and keep the conversion explicit; otherwise use a pointer target type.");
    assert.equal(compilerDiagnosticGuidance({ ...warning, severity: "error" }), "");
});

test("FBC NEXT-variable warning identifies the exact redundant counter name", () => {
    const source = "For count = 1 To 2\nNext count\n";
    const diagnostic = {
        severity: "warning",
        message: "Variable following NEXT is meaningless, count",
        physicalPoint: { line: 1, character: 5 }
    };

    assert.deepEqual(compilerMeaninglessNextVariableRange(source, diagnostic), {
        line: 1, startCharacter: 5, endCharacter: 10, name: "count"
    });
    assert.equal(compilerMeaninglessNextVariableRange(source, {
        ...diagnostic,
        message: "Variable following NEXT is meaningless, other"
    }), null, "the diagnostic spelling must match the token after NEXT");
    assert.deepEqual(compilerMeaninglessNextVariableRange(source, {
        ...diagnostic,
        physicalPoint: undefined,
        line: 1
    }), { line: 1, startCharacter: 5, endCharacter: 10, name: "count" },
    "a unique compiler-named counter can be mapped when FBC supplies only the physical line");
    const multiCounterSource = "For outer = 1 To 2\n    For inner = 1 To 2\n    Next inner, outer\n";
    assert.deepEqual(compilerMeaninglessNextVariableRange(multiCounterSource, {
        ...diagnostic,
        message: "Variable following NEXT is meaningless, outer",
        physicalPoint: { line: 2, character: 16 }
    }), { line: 2, startCharacter: 16, endCharacter: 21, name: "outer" });
    assert.equal(compilerMeaninglessNextVariableRange("Next repeated, repeated\n", {
        ...diagnostic,
        message: "Variable following NEXT is meaningless, repeated",
        physicalPoint: undefined,
        line: 0
    }), null, "line-only matching must reject repeated compiler-reported names");
});

test("LINE INPUT context explains how to resolve unknown destination capacity", () => {
    assert.equal(compilerDiagnosticContextLabel("line-input-unknown-buffer-capacity"),
        "LINE INPUT target has unknown buffer capacity; add a comma and maximum character count after the target");
});

test("FBC ANY-initializer warning maps only its exact vector NEW clause", () => {
    const line = "Dim values As AnyInitTarget Ptr = New AnyInitTarget[2] { Any }";
    const source = `Type AnyInitTarget\nEnd Type\n${line}\n`;
    const initializerStart = line.indexOf("{ Any }");
    const diagnostic = {
        severity: "warning",
        message: "The ANY initializer has no effect on UDT's with default constructors",
        physicalPoint: { line: 2, character: initializerStart }
    };

    assert.deepEqual(compilerRedundantNewAnyInitializerRange(source, diagnostic), {
        line: 2,
        startCharacter: initializerStart,
        endCharacter: initializerStart + "{ Any }".length,
        text: "{ Any }"
    });
    assert.equal(compilerRedundantNewAnyInitializerRange(source, {
        ...diagnostic,
        physicalPoint: { line: 2, character: initializerStart + 2 }
    }), null, "the compiler point must identify the opening brace, not the Any keyword");
    assert.equal(compilerRedundantNewAnyInitializerRange(source.replace("New AnyInitTarget[2]", "New AnyInitTarget"), diagnostic), null,
        "ANY clauses outside a vector NEW expression are not edited");
});

test("compiler LINE INPUT context highlights the capacity-unknown destination", () => {
    const source = "Dim buffer As ZString Ptr\nLine Input *buffer\n";
    const diagnostic = {
        compilerContext: "line-input-unknown-buffer-capacity",
        physicalPoint: { line: 1, character: 12 },
        sourceText: "Line Input *buffer"
    };

    assert.deepEqual(compilerLineInputBufferCapacityRange(source, diagnostic), {
        line: 1, startCharacter: 12, endCharacter: 18, name: "buffer"
    });
    assert.equal(compilerLineInputBufferCapacityRange(source, {
        ...diagnostic,
        physicalPoint: { line: 1, character: 5 }
    }), null, "a point on INPUT itself must not be mistaken for the destination");
});

test("FBC missing-quote warning maps only an unclosed literal on the reported line", () => {
    const source = "Print \"unterminated text   \n";
    const line = source.split("\n")[0];
    const warning = {
        severity: "warning",
        message: "Missing closing quote in literal string",
        physicalPoint: { line: 0, character: line.length }
    };
    assert.deepEqual(compilerMissingClosingQuoteRange(source, warning), {
        line: 0,
        startCharacter: line.indexOf("\""),
        endCharacter: line.length,
        insertionCharacter: line.length
    });
    assert.equal(compilerMissingClosingQuoteRange("Print \"closed\"\n", warning), null);
    assert.equal(compilerMissingClosingQuoteRange("' Print \"comment\n", warning), null);
    assert.equal(compilerMissingClosingQuoteRange("Print \"escaped \"\" quote\"\n", warning), null);
    const escapedWithOddTrailingSlash = "Print !\"unterminated" + "\\";
    assert.equal(compilerMissingClosingQuoteRange(escapedWithOddTrailingSlash, {
        ...warning,
        physicalPoint: { line: 0, character: escapedWithOddTrailingSlash.length }
    }), null, "the inserted quote must not be escaped by a trailing backslash");
    const unknownEscapeModeWithOddTrailingSlash = "Print \"unterminated" + "\\";
    assert.equal(compilerMissingClosingQuoteRange(unknownEscapeModeWithOddTrailingSlash, {
        ...warning,
        physicalPoint: { line: 0, character: unknownEscapeModeWithOddTrailingSlash.length }
    }), null, "an unknown OPTION ESCAPE state must not produce a closing quote that may be escaped");
    const ambiguousEscapeMode = 'Print "text \\" more';
    assert.equal(compilerMissingClosingQuoteRange(ambiguousEscapeMode, {
        ...warning,
        physicalPoint: { line: 0, character: ambiguousEscapeMode.length }
    }), null, "different quote boundaries under OPTION ESCAPE must not produce a possibly unsafe fix");
});

test("compiler procedure-signature context narrows only a matching declaration name", () => {
    const source = "Declare Function chooseResult() As Integer\nFunction chooseResult() As Double\n";
    const diagnostic = {
        compilerContext: "procedure-signature-mismatch",
        physicalPoint: { line: 1, character: 9 },
        sourceText: "Function chooseResult() As Double"
    };

    assert.equal(compilerDiagnosticContextLabel(diagnostic.compilerContext), "Procedure does not match its declaration");
    assert.deepEqual(compilerProcedureSignatureMismatchRange(source, diagnostic), {
        line: 1, startCharacter: 9, endCharacter: 21, name: "chooseResult"
    });
    assert.equal(compilerProcedureSignatureMismatchRange(source, {
        ...diagnostic,
        physicalPoint: { line: 1, character: 25 }
    }), null, "the compiler point must be the procedure name");
    assert.equal(compilerProcedureSignatureMismatchRange(source, {
        ...diagnostic,
        sourceText: "Function chooseResult() As Long"
    }), null, "stale physical source text must not narrow the diagnostic");
});

test("compiler error-resume-next context spans only the rejected ON ERROR form", () => {
    const source = "    On Local Error Resume Next ' unsupported Visual Basic syntax\n";
    const diagnostic = {
        compilerContext: "error-resume-next-syntax",
        physicalPoint: { line: 0, character: 4 },
        sourceText: "On Local Error Resume Next"
    };

    assert.equal(compilerDiagnosticContextLabel(diagnostic.compilerContext), "ON ERROR RESUME NEXT is unsupported by FreeBASIC");
    assert.deepEqual(compilerErrorResumeNextRange(source, diagnostic), {
        line: 0, startCharacter: 4, endCharacter: 30
    });
    assert.equal(compilerErrorResumeNextRange(source, {
        ...diagnostic,
        physicalPoint: { line: 0, character: 0 }
    }), null, "the compiler point must start at ON");
});

test("compiler suffix-AS context validates one suffixed variable in a DIM AS list", () => {
    const source = "Dim AS Integer firstValue, secondValue$\n";
    const startCharacter = source.indexOf("secondValue");
    const diagnostic = {
        compilerContext: "declaration-suffix-as-conflict",
        physicalPoint: { line: 0, character: startCharacter },
        message: "Syntax error, secondValue"
    };

    assert.deepEqual(compilerDeclarationSuffixConflictRange(source, diagnostic), {
        line: 0,
        startCharacter,
        endCharacter: startCharacter + "secondValue$".length,
        suffixStartCharacter: startCharacter + "secondValue".length,
        name: "secondValue$",
        suffix: "$"
    });
    assert.equal(compilerDeclarationSuffixConflictRange(source, {
        ...diagnostic,
        message: "Syntax error, anotherName"
    }), null, "the source token must agree with FBC's diagnostic name");
    assert.equal(compilerDeclarationSuffixConflictRange("Dim value$ As String\n", {
        ...diagnostic,
        physicalPoint: { line: 0, character: 4 }
    }), null, "a suffix outside a common DIM AS list must not receive this fix");
});

test("FBC ignored-suffix warning narrows exact AS-typed declaration targets", () => {
    const source = "Dim value% As Integer\n";
    const diagnostic = {
        severity: "warning",
        message: "Suffix ignored",
        compilerDetail: "in 'value%'",
        sourceText: "value%",
        physicalPoint: { line: 0, character: 0 }
    };

    assert.deepEqual(compilerIgnoredDeclarationSuffixRange(source, diagnostic), {
        line: 0, startCharacter: 4, endCharacter: 10, suffixStartCharacter: 9,
        name: "value%", suffix: "%", hasExplicitAsType: true
    });
    assert.deepEqual(compilerIgnoredDeclarationSuffixRange("Dim value% As Integer, other As Integer\n", diagnostic), {
        line: 0, startCharacter: 4, endCharacter: 10, suffixStartCharacter: 9,
        name: "value%", suffix: "%", hasExplicitAsType: true
    }, "FBC's exact reported spelling can identify one declaration in a multi-declarator DIM");
    assert.equal(compilerIgnoredDeclarationSuffixRange(
        "Dim value% As Integer, value% As Integer\n", diagnostic), null,
    "a repeated suffix spelling on one line must remain ambiguous");

    const arraySource = "Dim arrayValue%(2) As Integer\n";
    const arrayWarning = {
        ...diagnostic,
        sourceText: "arrayValue%",
        compilerDetail: "in 'arrayValue%'"
    };
    const arrayStart = arraySource.indexOf("arrayValue%");
    assert.deepEqual(compilerIgnoredDeclarationSuffixRange(arraySource, arrayWarning), {
        line: 0,
        startCharacter: arrayStart,
        endCharacter: arrayStart + "arrayValue%".length,
        suffixStartCharacter: arrayStart + "arrayValue".length,
        name: "arrayValue%",
        suffix: "%",
        hasExplicitAsType: true
    });
    assert.deepEqual(compilerIgnoredDeclarationSuffixRange(
        "Dim arrayValue%(2) As Integer, other As Integer\n", arrayWarning), {
        line: 0,
        startCharacter: 4,
        endCharacter: 15,
        suffixStartCharacter: 14,
        name: "arrayValue%",
        suffix: "%",
        hasExplicitAsType: true
    }, "the exact compiler-named array declarator can be edited within a multi-declarator DIM");

    const parameterSource = "Sub Consume(value% As Integer, otherValue As String)\nEnd Sub\n";
    const parameterWarning = {
        ...diagnostic,
        sourceText: "value%",
        compilerDetail: "in 'value%'"
    };
    const parameterStart = parameterSource.indexOf("value%");
    assert.deepEqual(compilerIgnoredDeclarationSuffixRange(parameterSource, parameterWarning), {
        line: 0,
        startCharacter: parameterStart,
        endCharacter: parameterStart + "value%".length,
        suffixStartCharacter: parameterStart + "value".length,
        name: "value%",
        suffix: "%",
        hasExplicitAsType: true
    });

    const repeatedParameter = "Sub One(value% As Integer): Sub Two(value% As Integer)\n";
    assert.equal(compilerIgnoredDeclarationSuffixRange(repeatedParameter, parameterWarning), null,
        "same-line repeated parameter spellings must not guess which suffix the compiler warned about");
    assert.equal(compilerIgnoredDeclarationSuffixRange("Sub Consume(value%)\nEnd Sub\n", parameterWarning), null,
        "a parameter without an explicit AS type should not receive the ignored-suffix fix");

    const continuedParameterLine = "    ByVal continuedValue% As Integer, _";
    const continuedParameterSource = [
        "Sub ContinuedConsume( _",
        continuedParameterLine,
        "    otherValue As String _",
        ")",
        "End Sub"
    ].join("\n");
    const continuedParameterStart = continuedParameterLine.indexOf("continuedValue%");
    assert.deepEqual(compilerIgnoredDeclarationSuffixRange(continuedParameterSource, {
        ...diagnostic,
        sourceText: "continuedValue%",
        compilerDetail: "in 'continuedValue%'",
        physicalPoint: { line: 1, character: continuedParameterStart }
    }), {
        line: 1,
        startCharacter: continuedParameterStart,
        endCharacter: continuedParameterStart + "continuedValue%".length,
        suffixStartCharacter: continuedParameterStart + "continuedValue".length,
        name: "continuedValue%",
        suffix: "%",
        hasExplicitAsType: true
    });

    const constantSource = "Const constantValue% As Integer = 1\n";
    const constantWarning = {
        ...diagnostic,
        sourceText: "constantValue%",
        compilerDetail: "in 'constantValue%'"
    };
    const constantStart = constantSource.indexOf("constantValue%");
    assert.deepEqual(compilerIgnoredDeclarationSuffixRange(constantSource, constantWarning), {
        line: 0,
        startCharacter: constantStart,
        endCharacter: constantStart + "constantValue%".length,
        suffixStartCharacter: constantStart + "constantValue".length,
        name: "constantValue%",
        suffix: "%",
        hasExplicitAsType: true
    });

    const functionSource = "Function functionValue%() As Integer\nEnd Function\n";
    const functionWarning = {
        ...diagnostic,
        sourceText: "functionValue%",
        compilerDetail: "in 'functionValue%'"
    };
    const functionStart = functionSource.indexOf("functionValue%");
    assert.deepEqual(compilerIgnoredDeclarationSuffixRange(functionSource, functionWarning), {
        line: 0,
        startCharacter: functionStart,
        endCharacter: functionStart + "functionValue%".length,
        suffixStartCharacter: functionStart + "functionValue".length,
        name: "functionValue%",
        suffix: "%",
        hasExplicitAsType: true
    });
    assert.equal(compilerIgnoredDeclarationSuffixRange(
        "Function repeatedValue%() As Integer: Function repeatedValue%() As Integer\n",
        functionWarning), null,
    "same-line repeated procedure names must not guess which suffix the compiler warned about");

    const ignoredKeywordSource = "Sub SuffixKeywordProbe()\n    Let% value = 1\nEnd Sub\n";
    const ignoredKeywordWarning = {
        severity: "warning",
        message: "Suffix ignored",
        sourceText: "Let%",
        compilerDetail: "in 'Let%'",
        physicalPoint: { line: 1, character: 4 }
    };
    assert.deepEqual(compilerIgnoredDeclarationSuffixRange(ignoredKeywordSource, ignoredKeywordWarning), {
        line: 1,
        startCharacter: 4,
        endCharacter: 8,
        suffixStartCharacter: 7,
        name: "Let%",
        suffix: "%",
        hasExplicitAsType: false
    });
    assert.equal(compilerIgnoredDeclarationSuffixRange(
        "Sub SuffixKeywordProbe()\n    Let% value = Let%\nEnd Sub\n", ignoredKeywordWarning), null,
    "a repeated ignored token on one line must remain ambiguous");
});

test("FBC implicit-parameter-mode warning maps only its compiler-bound parameter token", () => {
    const source = "Sub Consume(value As Integer)\nEnd Sub\n";
    const startCharacter = source.indexOf("value");
    const warning = {
        severity: "warning",
        message: "No explicit BYREF or BYVAL, at parameter 1 (value) of Consume()",
        sourceText: "",
        physicalPoint: { line: 0, character: startCharacter }
    };

    assert.deepEqual(compilerImplicitParameterPassingModeRange(source, warning), {
        line: 0,
        startCharacter,
        endCharacter: startCharacter + "value".length,
        name: "value"
    });
    assert.equal(compilerImplicitParameterPassingModeRange(source, {
        ...warning,
        message: "No explicit BYREF or BYVAL, at parameter 1 (other) of Consume()"
    }), null, "the physical token must agree with FBC's named parameter");
    assert.equal(compilerImplicitParameterPassingModeRange(source, {
        ...warning,
        physicalPoint: { line: 0, character: 0 }
    }), null, "a point on the procedure keyword must not be reinterpreted as a parameter range");
});

test("FBC implicit-allocation warning maps a unique compiler-named variable token", () => {
    const source = "#lang \"deprecated\"\nSub Probe()\n    Print implicitValue\nEnd Sub\n";
    const line = 2;
    const startCharacter = source.split("\n")[line].indexOf("implicitValue");
    const warning = {
        severity: "warning",
        message: "Implicit variable allocation,",
        sourceText: "",
        compilerDetail: "implicitValue",
        physicalPoint: { line, character: 4 }
    };

    assert.deepEqual(compilerImplicitVariableAllocationRange(source, warning), {
        line,
        startCharacter,
        endCharacter: startCharacter + "implicitValue".length,
        name: "implicitValue"
    });
    assert.equal(compilerImplicitVariableAllocationRange(source.replace(
        "Print implicitValue", "Print implicitValue + implicitValue"
    ), warning), null, "multiple same-line matches must not be guessed");
    assert.equal(compilerImplicitVariableAllocationRange(source.replace(
        "Print implicitValue", 'Print "implicitValue"'
    ), warning), null, "string contents are not editable variable occurrences");
});

/* end of tests/compiler-diagnostic-sidecar.test.js */
