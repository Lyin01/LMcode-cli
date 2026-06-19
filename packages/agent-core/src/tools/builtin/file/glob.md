Find files (and optionally directories) by glob pattern, sorted by modification time (most recent first).

Good patterns:
- `*.ts` — files in the current directory matching an extension
- `src/**/*.ts` — recursive with a subdirectory anchor and extension
- `test_*.py` — files whose name starts with a literal prefix
- `*.{ts,tsx}` — brace expansion is supported and matches every alternative in one call (also `{src,test}/**/*.ts`)

Rejected patterns (no literal anchor — nothing bounds the result set):
- `**`, `**/*`, `*/*` — pure wildcards. Add an extension or subdirectory to give the walk a concrete target.
- Anything that starts with `**/` (e.g. `**/*.md`, `**/main/*.py`). The leading `**/` has no literal anchor in front of it. Anchor it with a top-level subdirectory like `src/**/*.md`. (Each brace alternative must also satisfy this — `{**/*.ts,src/*.ts}` is rejected.)

Large-directory warning — avoid recursing into dependency/build output even with an anchor:
- `node_modules/**/*.js`, `.venv/**/*.py`, `__pycache__/**`, `target/**` all match technically but
  typically produce thousands of results that truncate at the match cap and waste the caller context.
  Prefer specific subpaths like `node_modules/react/src/**/*.js`.