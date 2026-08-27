<#
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: tools/build-freebasic-grammar.ps1

    Purpose:

        Provide a PowerShell entry point for the cross-platform Node grammar
        generator.

    Responsibilities:

        - preserve the existing PowerShell command-line interface
        - pass source and output paths to the canonical generator
        - return the generator's process exit status

    This file intentionally does NOT contain:

        - a second grammar implementation
        - language vocabulary
        - generated grammar data
#>

param(
    [string]$SourcePath = "syntaxes/source/freebasic.grammar-source.json",
    [string]$OutputPath = "syntaxes/freebasic.tmLanguage.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$generatorPath = Join-Path $PSScriptRoot "build-freebasic-grammar.js"
& node $generatorPath --source $SourcePath --output $OutputPath

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

<# end of build-freebasic-grammar.ps1 #>
