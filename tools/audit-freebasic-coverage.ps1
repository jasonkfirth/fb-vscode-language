<#
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tools/audit-freebasic-coverage.ps1

    Purpose:

        Provide a PowerShell entry point for the cross-platform Node coverage
        audit.

    Responsibilities:

        - preserve the existing PowerShell command-line interface
        - pass optional source-tree configuration to the canonical audit
        - return the audit process exit status

    This file intentionally does NOT contain:

        - a second coverage implementation
        - hard-coded platform paths
        - language vocabulary
#>

param(
    [string]$GrammarSourcePath = "syntaxes/source/freebasic.grammar-source.json",
    [string]$FreeBasicRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$auditPath = Join-Path $PSScriptRoot "audit-freebasic-coverage.js"
$auditArguments = @($auditPath, "--grammar-source", $GrammarSourcePath)

if ($FreeBasicRoot) {
    $auditArguments += @("--freebasic-root", $FreeBasicRoot)
}

& node @auditArguments

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

<# end of audit-freebasic-coverage.ps1 #>
