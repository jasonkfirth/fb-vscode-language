param(
    [string]$GrammarSourcePath = "syntaxes/source/freebasic.grammar-source.json",
    [string]$FreeBasicRoot = "C:\msys64\home\admin\fbc-fbxl"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolvedGrammarSourcePath = Join-Path (Get-Location) $GrammarSourcePath
$grammarSource = Get-Content -Raw $resolvedGrammarSourcePath | ConvertFrom-Json

function Get-UpperWordsFromPattern {
    param(
        [string]$Pattern
    )

    [regex]::Matches($Pattern, "[A-Z_][A-Z0-9_]*") |
        ForEach-Object { $_.Value.ToUpperInvariant() }
}

$coveredCompilerKeywords = @(
    $grammarSource.operatorKeywords
    $grammarSource.types
    $grammarSource.typeModifiers
    $grammarSource.constants
    $grammarSource.intrinsicFunctions
    $grammarSource.runtimeFunctions
    $grammarSource.graphicsFunctions
    $grammarSource.keywords
)

foreach ($pattern in $grammarSource.compoundPatterns) {
    $coveredCompilerKeywords += Get-UpperWordsFromPattern $pattern.match
}

$coveredCompilerKeywords = $coveredCompilerKeywords | Sort-Object -Unique

$compilerKeywordPath = Join-Path $FreeBasicRoot "src\compiler\symb-keyword.bas"
$compilerKeywords = Select-String -Path $compilerKeywordPath -Pattern '@\"([^\"]+)\"' |
    ForEach-Object { $_.Matches[0].Groups[1].Value.ToUpperInvariant() } |
    Sort-Object -Unique

$missingCompilerKeywords = @($compilerKeywords |
    Where-Object {
        ($_ -notin $coveredCompilerKeywords) -and
        ($_ -notin @("REM"))
    })

$rtlPaths = Get-ChildItem (Join-Path $FreeBasicRoot "src\compiler") -Filter "rtl-*.bas" |
    Select-Object -ExpandProperty FullName

$rtlNames = foreach ($path in $rtlPaths) {
    Select-String -Path $path -Pattern '@\"([A-Za-z_][A-Za-z0-9_]*)\"' |
        ForEach-Object { $_.Matches[0].Groups[1].Value.ToUpperInvariant() }
}

$rtlExclusions = @(
    "A",
    "B",
    "E",
    "F",
    "G",
    "R",
    "T",
    "X",
    "Y",
    "MAJOR",
    "MINOR",
    "PATCH_LEVEL",
    "_MCOUNT",
    "_MONSTARTUP",
    "_SETJMP",
    "__DIVDI3",
    "__UDIVDI3",
    "__MODDI3",
    "__UMODDI3",
    "__FIXUNSDFDI",
    "MCOUNT",
    "SETJMP",
    "FB_ASSERT",
    "FB_ASSERTWARN",
    "FB_CVD",
    "FB_CVDFROMLONGINT",
    "FB_CVLFROMS",
    "FB_CVLONGINT",
    "FB_CVLONGINTFROMD",
    "FB_CVS",
    "FB_CVSFROML",
    "FB_CVSHORT",
    "FB_FIXDOUBLE",
    "FB_FIXSINGLE",
    "FB_FRACD",
    "FB_FRACF",
    "FB_LEFTSELF",
    "FB_SGNDOUBLE",
    "FB_SGNI",
    "FB_SGNL",
    "FB_SGNSINGLE",
    "FB_THREADCALL",
    "FB_VAL",
    "FB_VALINT",
    "FB_VALLNG",
    "FB_VALUINT",
    "FB_VALULNG",
    "FB_WSTRVAL",
    "FB_WSTRVALBOOL",
    "FB_WSTRVALINT",
    "FB_WSTRVALLNG",
    "FB_WSTRVALUINT",
    "FB_WSTRVALULNG",
    "__MAIN",
    "__FB_MIN_VERSION__"
)

$missingRtlNames = @($rtlNames |
    Sort-Object -Unique |
    Where-Object {
        ($_ -notin $rtlExclusions) -and
        ($_ -notin $coveredCompilerKeywords)
    })

Write-Host "Missing compiler keyword coverage:"
if ($missingCompilerKeywords.Count -eq 0) {
    Write-Host "  none"
} else {
    $missingCompilerKeywords | ForEach-Object { Write-Host "  $_" }
}

Write-Host ""
Write-Host "Missing RTL name coverage:"
if ($missingRtlNames.Count -eq 0) {
    Write-Host "  none"
} else {
    $missingRtlNames | ForEach-Object { Write-Host "  $_" }
}
