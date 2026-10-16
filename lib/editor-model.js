/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/editor-model.js
    Purpose: Select a current editor model with the requested compiler facts.
    Responsibilities: share capability checks, bounded upgrade retries, and fallback.
    Does not contain: compiler execution, source resolution, or provider rendering.
*/

/* A late binding upgrade cannot substitute source inference for the missing
   compiler decision. Keep native-only acquisition separate from UI fallback. */
async function compilerEditorModel(index, document, token, needCompilerExpressionTypes = false, needSemanticBindings = false,
    needSemanticMacroBindings = false) {
    const needsBindings = needSemanticBindings || needSemanticMacroBindings;
    const version = document.version;
    const generation = index.compilerAnalysis?.generation;
    const requestModel = () => index.compilerAnalysis?.getModelForEditor?.(
        document, token, needCompilerExpressionTypes, needSemanticBindings, needSemanticMacroBindings
    );
    const usable = (model) => model &&
        !(needsBindings && model.semanticBindingsAvailable === false) &&
        !(needSemanticMacroBindings && model.semanticMacroBindingsAvailable === false) &&
        (!model.semanticSidecarOnly || needCompilerExpressionTypes ||
            needsBindings && model.semanticBindingsAvailable &&
            (!needSemanticMacroBindings || model.semanticMacroBindingsAvailable));
    let native = await requestModel();
    if (token?.isCancellationRequested || document.version !== version) return null;
    if (usable(native)) return native;
    let current = index.compilerAnalysis?.getModel?.(document.uri);
    if (usable(current)) return current;
    const weaker = current || native;
    if (needsBindings && (generation !== index.compilerAnalysis?.generation || weaker &&
        (weaker.semanticBindingsAvailable === false ||
            needSemanticMacroBindings && weaker.semanticMacroBindingsAvailable === false))) {
        /* An invalidated upgrade may leave its weaker predecessor cached.
           Join the successor once; do not query that predecessor merely
           because it already has native symbol identities. */
        native = await requestModel();
        if (token?.isCancellationRequested || document.version !== version) return null;
        if (usable(native)) return native;
        current = index.compilerAnalysis?.getModel?.(document.uri);
        if (usable(current)) return current;
    }
    return null;
}

async function editorModel(index, document, token, needCompilerExpressionTypes = false, needSemanticBindings = false,
    needSemanticMacroBindings = false) {
    const version = document.version;
    const model = await compilerEditorModel(index, document, token,
        needCompilerExpressionTypes, needSemanticBindings, needSemanticMacroBindings);
    if (token?.isCancellationRequested || document.version !== version) return null;
    if (model) return model;
    index.getParsedDocument(document);
    if (!await index.ensureInitialized(token)) return null;
    /* Native capability checks have already failed. A general workspace
       lookup would select the same rejected bridge snapshot again. */
    return token?.isCancellationRequested || document.version !== version
        ? null : index.getSemanticModel(document.uri, { sourceOnly: true });
}

module.exports = { compilerEditorModel, editorModel };

/* end of editor-model.js */
