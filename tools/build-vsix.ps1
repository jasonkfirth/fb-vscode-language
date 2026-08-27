<#
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: build-vsix.ps1

    Purpose:

        Build an installable VSIX package for the extension
        without relying on a separate Node or vsce installation.

    Responsibilities:

        * read release metadata from package.json
        * stage the files needed by the shipped extension
        * generate the minimal VSIX manifest files
        * produce a versioned .vsix archive under dist/

    This file intentionally does NOT contain:

        * grammar regeneration
        * smoke-test coverage
        * marketplace publishing
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Escape-Xml {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Value
    )

    return [System.Security.SecurityElement]::Escape($Value)
}

function Write-Utf8NoBomFile {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path,

        [Parameter(Mandatory = $true)]
        [string] $Content
    )

    $utf8Encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8Encoding)
}

function Copy-ExtensionFile {
    param(
        [Parameter(Mandatory = $true)]
        [string] $SourcePath,

        [Parameter(Mandatory = $true)]
        [string] $DestinationPath
    )

    $textFileNames = @("LICENSE")
    $textExtensions = @(".json", ".code-snippets", ".js", ".md", ".xml", ".txt")
    $extension = [System.IO.Path]::GetExtension($SourcePath)
    $fileName = [System.IO.Path]::GetFileName($SourcePath)

    if ($textFileNames -contains $fileName -or $textExtensions -contains $extension) {
        $content = [System.IO.File]::ReadAllText($SourcePath)
        Write-Utf8NoBomFile -Path $DestinationPath -Content $content
        return
    }

    Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force
}

function Add-DirectoryToZipArchive {
    param(
        [Parameter(Mandatory = $true)]
        [string] $SourceDirectory,

        [Parameter(Mandatory = $true)]
        [string] $ArchivePath
    )

    $archive = [System.IO.Compression.ZipFile]::Open($ArchivePath, [System.IO.Compression.ZipArchiveMode]::Create)

    try {
        $files = Get-ChildItem -LiteralPath $SourceDirectory -Recurse -File

        foreach ($file in $files) {
            $relativePath = $file.FullName.Substring($SourceDirectory.Length).TrimStart('\', '/')
            $entryName = $relativePath -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Assert-VsixJsonEntryIsValidUtf8NoBom {
    param(
        [Parameter(Mandatory = $true)]
        [string] $ArchivePath,

        [Parameter(Mandatory = $true)]
        [string] $EntryPath
    )

    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)

    try {
        $entry = $archive.GetEntry($EntryPath)
        if (-not $entry) {
            throw ("VSIX is missing expected entry: {0}" -f $EntryPath)
        }

        $temporaryPath = Join-Path $env:TEMP ([System.IO.Path]::GetRandomFileName())

        try {
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $temporaryPath)

            $bytes = [System.IO.File]::ReadAllBytes($temporaryPath)
            if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
                throw ("VSIX JSON entry uses a UTF-8 BOM and must be saved without BOM: {0}" -f $EntryPath)
            }

            Get-Content -LiteralPath $temporaryPath -Raw | ConvertFrom-Json | Out-Null
        }
        finally {
            if (Test-Path -LiteralPath $temporaryPath) {
                Remove-Item -LiteralPath $temporaryPath -Force
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$packagePath = Join-Path $repoRoot "package.json"
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json

$distDirectory = Join-Path $repoRoot "dist"
$stagingRoot = Join-Path $distDirectory "vsix-stage"
$stagingExtensionRoot = Join-Path $stagingRoot "extension"
$vsixFileName = "{0}-{1}.vsix" -f $package.name, $package.version
$vsixPath = Join-Path $distDirectory $vsixFileName

$filesToPackage = @(
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "extension.js",
    "language-configuration.json",
    "assets/icon.png",
    "lib/grammar-data.js",
    "lib/freebasic-parser.js",
    "lib/compiler-diagnostics.js",
    "lib/compiler-service.js",
    "lib/editor-features.js",
    "lib/workspace-index.js",
    "snippets/freebasic.code-snippets",
    "syntaxes/freebasic.tmLanguage.json",
    "syntaxes/source/freebasic.grammar-source.json"
)

if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}

if (-not (Test-Path -LiteralPath $distDirectory)) {
    New-Item -ItemType Directory -Path $distDirectory | Out-Null
}

if (Test-Path -LiteralPath $vsixPath) {
    Remove-Item -LiteralPath $vsixPath -Force
}

New-Item -ItemType Directory -Path $stagingExtensionRoot | Out-Null

foreach ($relativePath in $filesToPackage) {
    $sourcePath = Join-Path $repoRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw ("Unable to package missing file: {0}" -f $relativePath)
    }

    $destinationPath = Join-Path $stagingExtensionRoot $relativePath
    $destinationDirectory = Split-Path -Parent $destinationPath
    if (-not (Test-Path -LiteralPath $destinationDirectory)) {
        New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    }

    Copy-ExtensionFile -SourcePath $sourcePath -DestinationPath $destinationPath
}

$manifestText = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(Escape-Xml $package.name)" Version="$(Escape-Xml $package.version)" Publisher="$(Escape-Xml $package.publisher)" />
    <DisplayName>$(Escape-Xml $package.displayName)</DisplayName>
    <Description xml:space="preserve">$(Escape-Xml $package.description)</Description>
    <Categories>$(Escape-Xml ($package.categories -join ","))</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(Escape-Xml $package.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" Version="[1.85.0,)" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/assets/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$contentTypesText = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="code-snippets" ContentType="application/json" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="xml" ContentType="text/xml" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>
"@

$relationshipsText = @"
<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="vsix" Type="http://schemas.microsoft.com/developer/vsx-schema/2011" Target="extension.vsixmanifest" />
</Relationships>
"@

Write-Utf8NoBomFile -Path (Join-Path $stagingRoot "extension.vsixmanifest") -Content $manifestText
Write-Utf8NoBomFile -Path (Join-Path $stagingRoot "[Content_Types].xml") -Content $contentTypesText

$relationshipsDirectory = Join-Path $stagingRoot "_rels"
if (-not (Test-Path -LiteralPath $relationshipsDirectory)) {
    New-Item -ItemType Directory -Path $relationshipsDirectory | Out-Null
}

Write-Utf8NoBomFile -Path (Join-Path $relationshipsDirectory ".rels") -Content $relationshipsText

Add-DirectoryToZipArchive -SourceDirectory $stagingRoot -ArchivePath $vsixPath
Assert-VsixJsonEntryIsValidUtf8NoBom -ArchivePath $vsixPath -EntryPath "extension/package.json"

Write-Host ("Built VSIX package: {0}" -f $vsixPath)

<# end of build-vsix.ps1 #>
