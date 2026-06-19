Apply several exact string replacements to a single file in one atomic call.

- Use this instead of multiple `Edit` calls when you need to make several changes to the SAME file — it collapses N round-trips into one and is applied atomically.
- `edits` is an ordered list; each edit applies to the result of the previous one, so a later edit may match text an earlier edit produced.
- Atomic: every edit is validated and applied in memory first. If ANY edit fails (its `old_string` is missing, or matches more than once without `replace_all`), nothing is written and the file is left unchanged — the error names which edit failed.
- Each edit follows the same rules as `Edit`: copy `old_string` from the Read output view without the line-number prefix; `old_string` must occur exactly once unless `replace_all` is set; `old_string` and `new_string` must differ.
- Use `Write` (not MultiEdit) to create a new file or completely overwrite one. Use a single `Edit` when there is only one change. For independent edits across DIFFERENT files, issue parallel `Edit`/`MultiEdit` calls instead.
- Line endings follow the same convention as `Read`/`Edit`: pure CRLF files are shown with LF and written back as CRLF; mixed or lone carriage returns appear as `\r` and need exact escapes.
- Pass `anchor` (from the latest Read status block) to verify the file has not changed since it was read before applying any edit.
