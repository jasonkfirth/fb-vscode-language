/*
    Project: FreeBASIC VS Code Language Extension
    File: tests/integration/harness/extension.js
    Purpose: Provide a neutral development-extension slot for package tests.
    Responsibilities: satisfy the VS Code test launcher without shadowing the installed VSIX.
    Does not contain: language providers, package behavior, or test assertions.
*/

function activate() {}
function deactivate() {}

module.exports = { activate, deactivate };

/* end of extension.js */
