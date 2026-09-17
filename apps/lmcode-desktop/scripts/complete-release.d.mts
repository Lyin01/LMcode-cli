/**
 * Types for the release-completion helper. The implementation is plain ESM so
 * that `node scripts/complete-release.mjs` runs it directly; this declaration
 * exists so tests can import the pure parts.
 */

export interface UpdaterFeedInput {
  readonly version: string
  readonly fileName: string
  readonly sha512: string
  readonly size: number
  readonly releaseDate: string
}

/** One `latest.yml` in the shape electron-updater parses. */
export declare function buildUpdaterFeed(input: UpdaterFeedInput): string

/** The `## <version>` section of a Markdown document, up to the next `## `. */
export declare function extractReleaseNotes(markdown: string, version: string): string

/** Hex digest of a file, for the algorithm GitHub reports per asset. */
export declare function fileDigest(filePath: string, algorithm: string): Promise<string>

export interface ReleaseOptions {
  readonly notes: string | undefined
  readonly verifyOnly: boolean
  readonly dryRun: boolean
  readonly repo: string | undefined
}

/** Parses CLI arguments; a bare `--` from `pnpm run <script> -- <flags>` is ignored. */
export declare function parseArguments(argv: readonly string[]): ReleaseOptions
