/*
    Project: FreeBASIC VS Code Language Extension
    ---------------------------------------------

    File: eslint.config.js

    Purpose:

        Apply strict correctness checks to maintained JavaScript files.

    Responsibilities:

        - use ESLint's recommended correctness rules
        - enforce strict equality and immutable declarations where possible
        - exclude generated compiler and editor test files

    This file intentionally does NOT contain:

        - formatting rules that rewrite the project's existing style
        - rules for generated bundles or downloaded VS Code builds
*/

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    {
        ignores: ["dist/**", "node_modules/**", ".vscode-test/**"]
    },
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: globals.node
        },
        rules: {
            ...js.configs.recommended.rules,
            eqeqeq: ["error", "always", { null: "ignore" }],
            "no-eval": "error",
            "no-implied-eval": "error",
            // NUL and control-byte checks are intentional in parsers and protocol readers.
            "no-control-regex": "off",
            "no-new-func": "error",
            "no-prototype-builtins": "error",
            "no-unsafe-finally": "error",
            "no-unsafe-optional-chaining": "error",
            "no-unused-vars": ["error", {
                argsIgnorePattern: "^_",
                caughtErrorsIgnorePattern: "^_",
                destructuredArrayIgnorePattern: "^_",
                varsIgnorePattern: "^_"
            }],
            "no-var": "error",
            "prefer-const": "error"
        }
    },
    {
        files: ["extension.js", "lib/**/*.js"],
        rules: {
            "no-console": ["error", { allow: ["error", "warn"] }]
        }
    },
    {
        files: ["tests/**/*.js", "tools/**/*.js"],
        rules: {
            // Test reports and command-line tools intentionally write to stdout.
            "no-console": "off"
        }
    },
    {
        files: ["tests/integration/**/*.js"],
        languageOptions: {
            globals: {
                vscode: "readonly"
            }
        }
    }
];

/* end of eslint.config.js */
