#!/usr/bin/env bash

#
#   Project: FreeBASIC VS Code Language Extension
#   ---------------------------------------------
#
#   File: build-vsix.sh
#
#   Purpose:
#
#       Build an installable VSIX package on Linux or macOS without vsce.
#
#   Responsibilities:
#
#       * read release metadata from package.json
#       * stage the files needed by the shipped extension
#       * generate the minimal VSIX manifest files
#       * validate and atomically publish the archive under dist/
#
#   This file intentionally does NOT contain:
#
#       * grammar regeneration
#       * smoke-test coverage
#       * marketplace publishing
#

set -Eeuo pipefail

# -----------------------------------------------------------------------------
# Command and path validation
# -----------------------------------------------------------------------------

require_command() {
    local command_name="$1"

    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required packaging command is unavailable: $command_name" >&2
        exit 1
    fi
}

require_command "node"
require_command "zip"
require_command "unzip"

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_directory/.." && pwd -P)"
package_path="$repository_root/package.json"
distribution_directory="$repository_root/dist"

if [[ ! -f "$package_path" ]]; then
    echo "Unable to locate package metadata: $package_path" >&2
    exit 1
fi

package_identity="$(node -e '
    const fs = require("fs");
    const packagePath = process.argv[1];
    const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const safeComponent = /^[A-Za-z0-9._-]+$/;

    if (!safeComponent.test(packageData.name || "")) {
        throw new Error("package.json contains an unsafe or missing package name");
    }
    if (!safeComponent.test(packageData.version || "")) {
        throw new Error("package.json contains an unsafe or missing package version");
    }

    process.stdout.write(`${packageData.name}\t${packageData.version}`);
' "$package_path")"

IFS=$'\t' read -r package_name package_version <<< "$package_identity"

if [[ -z "$package_name" || -z "$package_version" ]]; then
    echo "package.json did not provide a package name and version" >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# Package contents
# -----------------------------------------------------------------------------

files_to_package=(
    "package.json"
    "README.md"
    "CHANGELOG.md"
    "LICENSE"
    "extension.js"
    "language-configuration.json"
    "assets/icon.png"
    "lib/grammar-data.js"
    "lib/freebasic-parser.js"
    "lib/freebasic-formatter.js"
    "lib/bracket-diagnostics.js"
    "lib/compiler-diagnostics.js"
    "lib/compiler-diagnostic-sidecar.js"
    "lib/compiler-constant-values.js"
    "lib/compiler-flow-analysis.js"
    "lib/compiler-string-context.js"
    "lib/compiler-process-supervisor.js"
    "lib/compiler-process-runner.js"
    "lib/compiler-service.js"
    "lib/compiler-analysis.js"
    "lib/compiler-recovery.js"
    "lib/compiler-symbols.js"
    "lib/compiler-expressions.js"
    "lib/compiler-scopes.js"
    "lib/compiler-inventory.js"
    "lib/compiler-origins.js"
    "lib/compiler-macros.js"
    "lib/compiler-preprocessor.js"
    "lib/compiler-preprocessor-model.js"
    "lib/compiler-project.js"
    "lib/compiler-project-bindings.js"
    "lib/compiler-project-transaction.js"
    "lib/compiler-contexts.js"
    "lib/compiler-worker.js"
    "lib/compiler-worker-runtime.js"
    "lib/compiler-worker-entry.js"
    "lib/compiler-model-store.js"
    "lib/compiler-path.js"
    "lib/compiler-model-queries.js"
    "lib/compiler-document-symbols.js"
    "lib/compiler-remote-model.js"
    "lib/semantic-token-data.js"
    "lib/bounded-text-map.js"
    "lib/compiler-analysis-service.js"
    "lib/compiler-compatibility.js"
    "lib/compiler-language-status.js"
    "lib/compiler-workspace-symbols.js"
    "lib/compiler-workspace-service.js"
    "lib/compiler-semantic-model.js"
    "lib/compiler-semantic-sidecar.js"
    "lib/compiler-semantic-transport.js"
    "lib/editor-model.js"
    "lib/editor-features.js"
    "lib/workspace-index.js"
    "lib/language-reference.js"
    "lib/semantic-model.js"
    "lib/semantic-features.js"
    "lib/include-paths.js"
    "data/language-reference.json"
    "docs/reference-attribution.md"
    "docs/compiler-bridge.md"
    "docs/compiler-grade-plan.md"
    "docs/fdl-1.2.txt"
    "snippets/freebasic.code-snippets"
    "syntaxes/freebasic.tmLanguage.json"
    "syntaxes/source/freebasic.grammar-source.json"
)

mkdir -p -- "$distribution_directory"

build_root="$(mktemp -d "$distribution_directory/.vsix-build.XXXXXX")"
staging_root="$build_root/stage"
staging_extension_root="$staging_root/extension"
temporary_vsix_path="$build_root/package.vsix"
vsix_file_name="$package_name-$package_version.vsix"
vsix_path="$distribution_directory/$vsix_file_name"

cleanup() {
    if [[ -n "${build_root:-}" && "$build_root" == "$distribution_directory"/.vsix-build.* ]]; then
        rm -rf -- "$build_root"
    fi
}

trap cleanup EXIT
mkdir -p -- "$staging_extension_root"

package_file_list="$(printf '%s\n' "${files_to_package[@]}")"

VSIX_REPOSITORY_ROOT="$repository_root" \
VSIX_STAGING_ROOT="$staging_root" \
VSIX_FILE_LIST="$package_file_list" \
node <<'NODE'
/*
    The staging helper uses Node because package.json is already part of the
    extension toolchain. Keeping XML escaping and UTF-8 handling here avoids
    depending on locale-sensitive shell utilities.
*/

const fs = require("fs");
const path = require("path");

const repositoryRoot = process.env.VSIX_REPOSITORY_ROOT;
const stagingRoot = process.env.VSIX_STAGING_ROOT;
const stagingExtensionRoot = path.join(stagingRoot, "extension");
const filesToPackage = process.env.VSIX_FILE_LIST.split("\n").filter(Boolean);
const packagePath = path.join(repositoryRoot, "package.json");
const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const textFileNames = new Set(["LICENSE"]);
const textExtensions = new Set([".json", ".code-snippets", ".js", ".md", ".xml", ".txt"]);

function requireString(value, fieldName) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`package.json is missing required string: ${fieldName}`);
    }
    return value;
}

function escapeXml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

for (const relativePath of filesToPackage) {
    const sourcePath = path.join(repositoryRoot, relativePath);
    const destinationPath = path.join(stagingExtensionRoot, relativePath);

    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        throw new Error(`Unable to package missing file: ${relativePath}`);
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

    if (textFileNames.has(path.basename(sourcePath)) || textExtensions.has(path.extname(sourcePath))) {
        let text = fs.readFileSync(sourcePath, "utf8");
        if (text.charCodeAt(0) === 0xfeff) {
            text = text.slice(1);
        }
        fs.writeFileSync(destinationPath, text, "utf8");
    } else {
        fs.copyFileSync(sourcePath, destinationPath);
    }
}

const packageName = escapeXml(requireString(packageData.name, "name"));
const packageVersion = escapeXml(requireString(packageData.version, "version"));
const publisher = escapeXml(requireString(packageData.publisher, "publisher"));
const displayName = escapeXml(requireString(packageData.displayName, "displayName"));
const description = escapeXml(requireString(packageData.description, "description"));
const vscodeEngine = requireString(packageData.engines && packageData.engines.vscode, "engines.vscode");
const minimumEngineMatch = vscodeEngine.match(/\d+\.\d+\.\d+/);

if (!minimumEngineMatch) {
    throw new Error(`Unable to determine the minimum VS Code version from: ${vscodeEngine}`);
}

if (!Array.isArray(packageData.categories) || packageData.categories.length === 0) {
    throw new Error("package.json must declare at least one extension category");
}

const categories = escapeXml(packageData.categories.join(","));
const escapedEngine = escapeXml(vscodeEngine);
const minimumEngine = escapeXml(minimumEngineMatch[0]);

const manifestText = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${packageName}" Version="${packageVersion}" Publisher="${publisher}" />
    <DisplayName>${displayName}</DisplayName>
    <Description xml:space="preserve">${description}</Description>
    <Categories>${categories}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapedEngine}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" Version="[${minimumEngine},)" />
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
`;

const contentTypesText = `<?xml version="1.0" encoding="utf-8"?>
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
`;

const relationshipsText = `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="vsix" Type="http://schemas.microsoft.com/developer/vsx-schema/2011" Target="extension.vsixmanifest" />
</Relationships>
`;

fs.writeFileSync(path.join(stagingRoot, "extension.vsixmanifest"), manifestText, "utf8");
fs.writeFileSync(path.join(stagingRoot, "[Content_Types].xml"), contentTypesText, "utf8");
fs.mkdirSync(path.join(stagingRoot, "_rels"), { recursive: true });
fs.writeFileSync(path.join(stagingRoot, "_rels", ".rels"), relationshipsText, "utf8");
NODE

# -----------------------------------------------------------------------------
# Archive creation and validation
# -----------------------------------------------------------------------------

(
    cd -- "$staging_root"

    # Fixed timestamps and omitted host attributes make repeated Linux builds
    # byte-for-byte reproducible when their source files have not changed.
    find . -type f -exec touch -t 198001010000 {} +
    LC_ALL=C find . -type f -print | LC_ALL=C sort | sed 's#^\./##' | \
        zip -q -X "$temporary_vsix_path" -@
)

unzip -tq "$temporary_vsix_path" >/dev/null
unzip -Z1 "$temporary_vsix_path" > "$build_root/archive-entries.txt"

if grep -Eq '(^/|(^|/)\.\.(/|$)|\\)' "$build_root/archive-entries.txt"; then
    echo "VSIX contains an unsafe archive path" >&2
    exit 1
fi

required_entries=(
    "extension.vsixmanifest"
    "[Content_Types].xml"
    "_rels/.rels"
)

for relative_path in "${files_to_package[@]}"; do
    required_entries+=("extension/$relative_path")
done

for entry_path in "${required_entries[@]}"; do
    if ! grep -Fqx -- "$entry_path" "$build_root/archive-entries.txt"; then
        echo "VSIX is missing expected entry: $entry_path" >&2
        exit 1
    fi
done

unzip -p "$temporary_vsix_path" "extension/package.json" | node -e '
    const fs = require("fs");
    const bytes = fs.readFileSync(0);

    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        throw new Error("VSIX extension/package.json must use UTF-8 without a BOM");
    }

    JSON.parse(bytes.toString("utf8"));
'

mv -f -- "$temporary_vsix_path" "$vsix_path"
echo "Built VSIX package: $vsix_path"

# end of build-vsix.sh
