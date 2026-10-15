/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/compiler-recovery.js
    Purpose: Identify native facts that rely on a recovered declaration.
    Responsibilities: follow symbol ownership, native types, and type layouts.
    Does not contain: parser recovery, source-range invalidation, or type inference.
*/

function recoveryDependentSymbols(symbolGraph, scopeGraph) {
    const symbols = new Map(symbolGraph.symbols.map((symbol) => [symbol.id, symbol]));
    const canonicalIds = new Map(symbolGraph.canonicalIds);
    const shapes = new Map(scopeGraph.shapes.map((shape) => [shape.symbol, shape]));
    const recovered = new Set();
    const canonical = (id) => canonicalIds.get(id) || id;
    const mark = (id) => {
        if (!id) return false;
        id = canonical(id);
        if (!symbols.has(id) || recovered.has(id)) return false;
        recovered.add(id);
        return true;
    };

    /* A declaration retracted by parser recovery cannot safely establish a
       type, owner, or callable identity for later source. An unclosed scope
       has the same uncertainty even if its opening declaration was accepted. */
    for (const declaration of scopeGraph.declarations) if (declaration.invalid) mark(declaration.symbol);
    for (const scope of scopeGraph.scopes) if (scope.recovered) mark(scope.symbol);
    for (const id of symbolGraph.invalidDispatch || []) mark(id);

    /* Native metadata makes type and ownership dependencies explicit. Follow
       that graph to a fixed point instead of treating every fact after an
       error as uncertain. This preserves independent post-error statements
       while preventing a damaged UDT or procedure from lending authority to
       a later variable, member access, or implicit call. */
    let changed = true;
    while (changed) {
        changed = false;
        for (const symbol of symbols.values()) {
            const shape = shapes.get(symbol.id) || shapes.get(canonical(symbol.id));
            const dependencies = [symbol.subtype, symbol.owner, symbol.namespace, shape?.base, shape?.anonymousParent];
            if (dependencies.some((id) => id && recovered.has(canonical(id)))) changed = mark(symbol.id) || changed;
        }
    }
    return [...recovered].sort((left, right) => left - right);
}

module.exports = { recoveryDependentSymbols };

/* end of compiler-recovery.js */
