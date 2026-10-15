# FreeBASIC editor reference

The generated `data/language-reference.json` contains short descriptions,
syntax forms, and parameter descriptions adapted from the FreeBASIC Manual
by the FreeBASIC documentation contributors. Those excerpts are distributed
under the GNU Free Documentation License, version 1.2, with no invariant
sections or cover texts identified by the source manual. The complete license
is in [fdl-1.2.txt](fdl-1.2.txt).

The original manual is available at <https://www.freebasic.net/wiki/>. The
1.20.4 source used for this edition is maintained at
<https://github.com/jasonkfirth/fbc>. Each reference entry names its source
file. Public API declarations also come from the headers identified there.

History: the FreeBASIC Language extension contributors generated this editor
edition in 2026. It removes wiki markup, selects short reference sections,
and represents callable signatures and parameter information as JSON. The
JSON is the editable, transparent form of the excerpts. Rebuild it with
`npm run build:reference` using the matching FreeBASIC source checkout.

The extension's own source code remains under its MIT license. The original
documentation authors do not endorse the extension or these adaptations.

<!-- end of reference-attribution.md -->
