<#
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tests/test-smoke.ps1

    Purpose:

        Provide a PowerShell entry point for the cross-platform smoke tests.

    Responsibilities:

        - preserve the existing PowerShell test command
        - run the canonical Node smoke-test suite
        - return the test process exit status

    This file intentionally does NOT contain:

        - duplicate JSON validation
        - grammar generation
        - source coverage logic
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$testPath = Join-Path $PSScriptRoot "smoke.test.js"
& node --test $testPath

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

<# end of test-smoke.ps1 #>
