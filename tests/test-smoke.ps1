Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-JsonFileIsValidUtf8NoBom {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $resolvedPath = (Resolve-Path $Path).Path
    $bytes = [System.IO.File]::ReadAllBytes($resolvedPath)

    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw "JSON file uses a UTF-8 BOM and must be saved without BOM: $Path"
    }

    Get-Content -Raw $resolvedPath | ConvertFrom-Json | Out-Null
}

Write-Host "Validating package metadata and JSON assets..."
foreach ($path in @(
    ".\package.json",
    ".\language-configuration.json",
    ".\snippets\freebasic.code-snippets",
    ".\syntaxes\source\freebasic.grammar-source.json"
)) {
    Assert-JsonFileIsValidUtf8NoBom -Path $path
}

Write-Host "Rebuilding generated grammar..."
& powershell.exe -ExecutionPolicy Bypass -File ".\tools\build-freebasic-grammar.ps1"

Write-Host "Validating generated grammar..."
Assert-JsonFileIsValidUtf8NoBom -Path ".\syntaxes\freebasic.tmLanguage.json"

Write-Host "Running grammar audit..."
& powershell.exe -ExecutionPolicy Bypass -File ".\tools\audit-freebasic-coverage.ps1"

Write-Host "Checking semantic module files exist..."
foreach ($path in @(
    ".\extension.js",
    ".\lib\grammar-data.js",
    ".\lib\freebasic-parser.js",
    ".\tests\parser.test.js"
)) {
    if (-not (Test-Path $path)) {
        throw "Missing expected file: $path"
    }
}

Write-Host "Smoke test completed successfully."
