param(
    [string]$SourcePath = "syntaxes/source/freebasic.grammar-source.json",
    [string]$OutputPath = "syntaxes/freebasic.tmLanguage.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Utf8NoBomFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $utf8Encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8Encoding)
}

function Convert-WordsToRegex {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Words
    )

    $uniqueWords = $Words |
        Where-Object { $_ -and $_.Trim().Length -gt 0 } |
        Sort-Object -Unique

    if ($uniqueWords.Count -eq 0) {
        return "(?!)"
    }

    $escapedWords = foreach ($word in $uniqueWords) {
        [regex]::Escape($word)
    }

    return "(?i)\b(?:{0})\b" -f ($escapedWords -join "|")
}

function Convert-ConstantWordsToRegex {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Words
    )

    $uniqueWords = $Words |
        Where-Object { $_ -and $_.Trim().Length -gt 0 } |
        Sort-Object -Unique

    if ($uniqueWords.Count -eq 0) {
        return "(?!)"
    }

    $escapedWords = foreach ($word in $uniqueWords) {
        [regex]::Escape($word)
    }

    return "(?i)(?<![A-Za-z0-9_\.])(?:{0})(?![A-Za-z0-9_])" -f ($escapedWords -join "|")
}

function Convert-Captures {
    param(
        [Parameter(Mandatory = $true)]
        $CaptureMap
    )

    $captures = [ordered]@{}

    foreach ($entry in $CaptureMap.PSObject.Properties) {
        $captures[$entry.Name] = [ordered]@{
            name = [string]$entry.Value
        }
    }

    return $captures
}

$resolvedSourcePath = Join-Path (Get-Location) $SourcePath
$resolvedOutputPath = Join-Path (Get-Location) $OutputPath

$source = Get-Content -Raw $resolvedSourcePath | ConvertFrom-Json

$compoundPatterns = @()
foreach ($pattern in $source.compoundPatterns) {
    $compoundPatterns += [ordered]@{
        name = $pattern.name
        match = $pattern.match
        captures = Convert-Captures $pattern.captures
    }
}

$grammar = [ordered]@{
    '$schema' = "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json"
    name = "FreeBASIC"
    scopeName = "source.freebasic"
    patterns = @(
        [ordered]@{ include = "#comments" },
        [ordered]@{ include = "#strings" },
        [ordered]@{ include = "#preprocessor" },
        [ordered]@{ include = "#numbers" },
        [ordered]@{ include = "#labels" },
        [ordered]@{ include = "#compoundKeywords" },
        [ordered]@{ include = "#operators" },
        [ordered]@{ include = "#types" },
        [ordered]@{ include = "#constants" },
        [ordered]@{ include = "#functions" },
        [ordered]@{ include = "#keywords" }
    )
    repository = [ordered]@{
        comments = [ordered]@{
            patterns = @(
                [ordered]@{
                    name = "comment.line.apostrophe.freebasic"
                    match = "'[^\n]*"
                },
                [ordered]@{
                    name = "comment.line.rem.freebasic"
                    match = "(?i)\bREM\b[^\n]*"
                },
                [ordered]@{
                    name = "comment.block.freebasic"
                    begin = "/'"
                    end = "'/"
                }
            )
        }
        strings = [ordered]@{
            patterns = @(
                [ordered]@{
                    name = "string.quoted.double.freebasic"
                    match = '([!$]?)(")(?:(?:"")|[^"\r\n])*(")'
                    captures = [ordered]@{
                        "1" = [ordered]@{ name = "storage.modifier.freebasic" }
                        "2" = [ordered]@{ name = "punctuation.definition.string.begin.freebasic" }
                        "3" = [ordered]@{ name = "punctuation.definition.string.end.freebasic" }
                    }
                }
            )
        }
        preprocessor = [ordered]@{
            patterns = @(
                [ordered]@{
                    name = "meta.preprocessor.freebasic"
                    match = '(?i)^\s*#(?:{0})\b.*$' -f (($source.preprocessorDirectives | Sort-Object -Unique) -join "|")
                }
            )
        }
        numbers = [ordered]@{
            patterns = @(
                [ordered]@{
                    name = "constant.numeric.freebasic"
                    match = '(?i)\b(?:&H[0-9A-F]+|&B[01]+|&O[0-7]+|\d+(?:\.\d+)?(?:[ED][+-]?\d+)?)\b'
                }
            )
        }
        labels = [ordered]@{
            patterns = @(
                [ordered]@{
                    name = "meta.label.freebasic"
                    match = '(?i)^\s*([A-Z_][A-Z0-9_]*|\d+)(\s*:)'
                    captures = [ordered]@{
                        "1" = [ordered]@{ name = "entity.name.label.freebasic" }
                        "2" = [ordered]@{ name = "punctuation.separator.label.freebasic" }
                    }
                }
            )
        }
        compoundKeywords = [ordered]@{
            patterns = $compoundPatterns
        }
        operators = [ordered]@{
            patterns = @(
                [ordered]@{
                    name = "keyword.operator.word.freebasic"
                    match = Convert-WordsToRegex $source.operatorKeywords
                }
            )
        }
        types = [ordered]@{
            patterns = @(
                [ordered]@{
                    name = "storage.type.freebasic"
                    match = Convert-WordsToRegex $source.types
                },
                [ordered]@{
                    name = "storage.modifier.freebasic"
                    match = Convert-WordsToRegex $source.typeModifiers
                }
            )
        }
        constants = [ordered]@{
            patterns = @(
                [ordered]@{
                    name = "constant.language.freebasic"
                    match = "{0}|__(?:[A-Z0-9_]+)__" -f (Convert-WordsToRegex $source.constants)
                },
                [ordered]@{
                    name = "constant.other.freebasic"
                    match = Convert-ConstantWordsToRegex $source.symbolicConstants
                }
            )
        }
        functions = [ordered]@{
            patterns = @(
                [ordered]@{
                    name = "support.function.freebasic"
                    match = Convert-WordsToRegex $source.intrinsicFunctions
                },
                [ordered]@{
                    name = "support.function.freebasic"
                    match = Convert-WordsToRegex $source.runtimeFunctions
                },
                [ordered]@{
                    name = "support.function.freebasic"
                    match = Convert-WordsToRegex $source.graphicsFunctions
                }
            )
        }
        keywords = [ordered]@{
            patterns = @(
                [ordered]@{
                    name = "keyword.control.freebasic"
                    match = Convert-WordsToRegex $source.keywords
                }
            )
        }
    }
}

$outputJson = $grammar | ConvertTo-Json -Depth 100
Write-Utf8NoBomFile -Path $resolvedOutputPath -Content ($outputJson + [Environment]::NewLine)

Write-Host "Generated $OutputPath from $SourcePath"
