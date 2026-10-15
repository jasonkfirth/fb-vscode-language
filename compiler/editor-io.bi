''
'' Project: FreeBASIC editor bridge
'' File: editor-io.bi
'' Purpose: Redirect source reads to immutable editor buffers.
'' Responsibilities: read a bounded overlay manifest and normalize lookup paths.
'' Does not contain: source rewriting, include-path changes, or disk edits.
''

'' Included after solve_path() in fb.bas. The single compiler process owns
'' this immutable map. Logical filenames stay in env.inf; only OPEN/EXISTS
'' use the backing path, preserving __FILE__, relative includes, and diagnostics.
private function editorSourcePath( byval filename as zstring ptr ) as string
	static loaded as integer
	static count as integer
	static originals(0 to 4999) as string
	static backing(0 to 4999) as string
	'' Large preprocessed modules can exceed the editor trace budget. The
	'' expression sidecar fallback still needs immutable editor buffers, but
	'' deliberately runs without parser instrumentation.
	if( environ("FB_VSCODE_TRACE") <> "1" ) andalso (environ("FB_VSCODE_OVERLAY_ONLY") <> "1") then return *filename
	if( loaded = FALSE ) then
		loaded = TRUE
		dim manifest as string = environ("FB_VSCODE_OVERLAY")
		if( len(manifest) ) then
			dim overlay_channel as integer = freefile
			if( open(manifest, for input, as #overlay_channel) <> 0 ) then
				errReportEx(FB_ERRMSG_FILEACCESSERROR, manifest)
			else
				do until eof(overlay_channel)
					dim row as string
					line input #overlay_channel, row
					dim separator as integer = instr(row, chr(9))
					if( (count >= 5000) or (separator <= 1) or (separator >= len(row)) ) then
						errReportEx(FB_ERRMSG_FILEACCESSERROR, manifest)
						exit do
					end if
					originals(count) = left(row, separator - 1)
					backing(count) = mid(row, separator + 1)
					count += 1
				loop
				close #overlay_channel
			end if
		end if
	end if
	if( count = 0 ) then return *filename
	dim normalized as string = pathNormalizeHost(*filename)
	if( left(normalized, 1) <> "/" ) then normalized = hCurDir() + "/" + normalized
	if( solve_path(strptr(normalized)) = FALSE ) then return *filename
	'' solve_path shortens a zstring in place; discard the old string length.
	normalized = *strptr(normalized)
	for index as integer = 0 to count - 1
		if( normalized = originals(index) ) then return backing(index)
	next
	return *filename
end function

private function editorSourceExists( byval filename as zstring ptr ) as integer
	return hFileExists(editorSourcePath(filename))
end function

'' end of editor-io.bi
