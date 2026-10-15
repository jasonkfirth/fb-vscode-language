<#
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: test-unit.ps1

    Purpose:

        Run the JavaScript unit tests for parser, editor, workspace,
        grammar-data, and compiler-diagnostic helpers.

    Responsibilities:

        * prefer a normal Node.js installation when available
        * fall back to VS Code's bundled Electron runtime in Node mode
        * execute every unit test entry point with a consistent interface

    This file intentionally does NOT contain:

        * smoke-test coverage
        * grammar regeneration
        * package publishing logic
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-NodeCommand {
    $testArguments = @(
        "--test",
        ".\tests\bracket-diagnostics.test.js",
        ".\tests\compiler-diagnostic-sidecar.test.js",
        ".\tests\parser.test.js",
        ".\tests\compiler-diagnostics.test.js",
        ".\tests\editor-features.test.js",
        ".\tests\workspace-index.test.js",
        ".\tests\semantic-model.test.js",
        ".\tests\compiler-audit-options.test.js",
        ".\tests\language-reference.test.js",
        ".\tests\compiler-analysis.test.js",
        ".\tests\compiler-recovery.test.js",
        ".\tests\compiler-analysis-service.test.js",
        ".\tests\compiler-project.test.js",
        ".\tests\compiler-macros.test.js",
        ".\tests\compiler-preprocessor.test.js",
        ".\tests\compiler-worker.test.js",
        ".\tests\compiler-model-worker.test.js",
        ".\tests\compiler-project-worker.test.js"
    )

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        return @{
            FilePath = $nodeCommand.Source
            Arguments = $testArguments
            Description = "system Node.js"
        }
    }

    $codeCommand = Get-Command code -ErrorAction SilentlyContinue
    if (-not $codeCommand) {
        throw "Unable to find either 'node' or the VS Code 'code' launcher."
    }

    $commandPath = $codeCommand.Source
    $commandFileName = [System.IO.Path]::GetFileName($commandPath)

    if ($commandFileName -ieq "Code.exe") {
        $resolvedCodeExePath = $commandPath
    }
    else {
        $codeExePath = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($commandPath), "..", "Code.exe")
        $resolvedCodeExePath = [System.IO.Path]::GetFullPath($codeExePath)
    }

    if (-not (Test-Path -LiteralPath $resolvedCodeExePath)) {
        throw "Unable to locate VS Code's Code.exe for bundled Node-mode execution."
    }

    return @{
        FilePath = $resolvedCodeExePath
        Arguments = $testArguments
        Description = "VS Code bundled runtime"
        NodeMode = $true
    }
}

$nodeRuntime = Get-NodeCommand

Write-Host ("Running unit tests with {0}" -f $nodeRuntime.Description)

if ($nodeRuntime.ContainsKey("NodeMode")) {
    $env:ELECTRON_RUN_AS_NODE = "1"
}

try {
    & $nodeRuntime.FilePath @($nodeRuntime.Arguments)
    $exitCodeVariable = Get-Variable LASTEXITCODE -ErrorAction SilentlyContinue
    $exitCode = 0

    if ($exitCodeVariable) {
        $exitCode = [int] $exitCodeVariable.Value
    }

    if ($exitCode -ne 0) {
        throw ("Unit tests failed with exit code {0}" -f $exitCode)
    }
}
finally {
    if ($nodeRuntime.ContainsKey("NodeMode")) {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
}

Write-Host "Unit tests completed successfully."

<# end of test-unit.ps1 #>
