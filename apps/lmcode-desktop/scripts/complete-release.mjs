/**
 * Finish a desktop release on GitHub, then verify what the public URLs serve.
 *
 * `electron-builder --publish always` cannot complete a release on this repo: it
 * creates the release, uploads the installer, then fails the updater-feed step
 * with `422 Published releases must have a valid tag`. The `latest.yml` left in
 * `release/` after such a failure belongs to the PREVIOUS version, so reusing it
 * would advertise an old installer to every auto-updating client. This script
 * derives the feed from the packaged artifact instead, uploads the three assets,
 * and checks the result end to end.
 *
 * Usage:
 *   node scripts/complete-release.mjs [--notes <file>] [--verify-only] [--dry-run]
 *   node scripts/complete-release.mjs --repo owner/name
 *
 * Without `--notes`, the `## <version>` section of README.md is used, which is
 * where the release narrative already lives.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGE_PATH = join(ROOT, 'package.json')
const BUILDER_CONFIG_PATH = join(ROOT, 'electron-builder.yml')
const README_PATH = join(ROOT, 'README.md')
const OUTPUT_DIR = join(ROOT, 'release')
const WINDOWS_SIGNATURE_TIMEOUT_MS = 60_000

/**
 * One `latest.yml`, in the shape electron-updater parses. Every value comes from
 * the artifact about to be uploaded, so the feed can never describe a different
 * build than the one users download.
 */
export function buildUpdaterFeed({ version, fileName, sha512, size, releaseDate }) {
  return (
    [
      `version: ${version}`,
      'files:',
      `  - url: ${fileName}`,
      `    sha512: ${sha512}`,
      `    size: ${size}`,
      `path: ${fileName}`,
      `sha512: ${sha512}`,
      `releaseDate: '${releaseDate}'`,
    ].join('\n') + '\n'
  )
}

/**
 * The `## <version>` section of a Markdown document, up to the next level-2
 * heading. Throws rather than publishing an empty release body.
 */
export function extractReleaseNotes(markdown, version) {
  const lines = markdown.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.trim() === `## ${version}`)
  if (start === -1) {
    throw new Error(`README has no "## ${version}" section to use as release notes`)
  }
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/u.test(line)) break
    body.push(line)
  }
  const notes = body.join('\n').trim()
  if (notes.length === 0) throw new Error(`the "## ${version}" section is empty`)
  return notes
}

/** Hex digest of a file, for the algorithm GitHub reports per asset. */
export async function fileDigest(filePath, algorithm) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

/** base64 SHA-512, the digest form `latest.yml` carries. */
async function fileSha512(filePath) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('base64')
}

function parseArguments(argv) {
  const options = { notes: undefined, verifyOnly: false, dryRun: false, repo: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--verify-only') options.verifyOnly = true
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--notes') options.notes = argv[(index += 1)]
    else if (flag === '--repo') options.repo = argv[(index += 1)]
    else throw new Error(`unknown argument: ${flag}`)
  }
  return options
}

/** Publish target, read from the same file electron-builder packages with. */
function readPublishTarget() {
  const config = readFileSync(BUILDER_CONFIG_PATH, 'utf8')
  const owner = /^\s*owner:\s*(\S+)\s*$/mu.exec(config)?.[1]
  const repo = /^\s*repo:\s*(\S+)\s*$/mu.exec(config)?.[1]
  if (owner === undefined || repo === undefined) {
    throw new Error(`no publish owner/repo in ${BUILDER_CONFIG_PATH}`)
  }
  return `${owner}/${repo}`
}

/**
 * OAuth token for the GitHub API. An explicit `GH_TOKEN` wins; otherwise the
 * token git already stores for this host is used, so nothing is kept here.
 */
function readToken() {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const stored = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const token = stored
    .split(/\r?\n/u)
    .find((line) => line.startsWith('password='))
    ?.slice('password='.length)
  if (token === undefined || token.length === 0) {
    throw new Error('no GitHub token: export GH_TOKEN or store a git credential for github.com')
  }
  return token
}

/** Gate before uploading: an unsigned installer must never reach users. */
function assertWindowsSignature(filePath) {
  if (process.platform !== 'win32') {
    console.log('signature check skipped (not Windows)')
    return
  }
  const script = `(Get-AuthenticodeSignature '${filePath.replaceAll("'", "''")}').Status`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: WINDOWS_SIGNATURE_TIMEOUT_MS,
  })
  const status = (result.stdout ?? '').trim()
  if (status !== 'Valid') {
    throw new Error(`installer is not signed (Get-AuthenticodeSignature -> "${status}")`)
  }
  console.log('signature: Valid')
}

/** `--notes <file>` wins; otherwise the README section for this version. */
function resolveNotes(options, version) {
  if (options.notes !== undefined) return readFileSync(options.notes, 'utf8').trim()
  return extractReleaseNotes(readFileSync(README_PATH, 'utf8'), version)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const version = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version
  const tag = `v${version}`
  const repo = options.repo ?? readPublishTarget()
  const token = readToken()
  const installerName = `LMCODE-Setup-${version}.exe`
  const installerPath = join(OUTPUT_DIR, installerName)

  const api = async (path, init = {}) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...init.headers,
      },
    })

  /** Uploads `filePath`, replacing an asset of the same name from a past attempt. */
  const uploadAsset = async (releaseId, filePath) => {
    const name = basename(filePath)
    const size = statSync(filePath).size
    const listing = await api(`/repos/${repo}/releases/${releaseId}/assets?per_page=100`)
    const assets = await listing.json()
    const existing = Array.isArray(assets) ? assets.find((asset) => asset.name === name) : undefined
    if (existing !== undefined) {
      await api(`/repos/${repo}/releases/assets/${existing.id}`, { method: 'DELETE' })
      console.log(`replaced existing asset ${name}`)
    }
    if (options.dryRun) {
      console.log(`would upload ${name} (${size} bytes)`)
      return
    }
    const upload = await fetch(
      `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(size),
        },
        body: createReadStream(filePath),
        duplex: 'half',
      },
    )
    if (!upload.ok) {
      const detail = (await upload.text()).replaceAll(token, '***')
      throw new Error(`upload ${name} failed: ${upload.status} ${detail}`)
    }
    console.log(`uploaded ${name} (${size} bytes)`)
  }

  const findRelease = async () => {
    const response = await api(`/repos/${repo}/releases/tags/${tag}`)
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`release lookup failed: ${response.status}`)
    return response.json()
  }

  const createRelease = async (notes) => {
    const response = await api(`/repos/${repo}/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: `LMCODE Desktop v${version}`,
        body: notes,
        draft: false,
        prerelease: false,
      }),
    })
    if (!response.ok) {
      throw new Error(`release create failed: ${response.status} ${await response.text()}`)
    }
    const created = await response.json()
    console.log(`created release ${tag} (id ${created.id})`)
    return created
  }

  if (!existsSync(installerPath)) {
    throw new Error(
      `${installerPath} is missing — run \`pnpm run verify:release\` and \`npx electron-builder --win --publish never --config.forceCodeSigning=true\` first`,
    )
  }

  const size = statSync(installerPath).size
  const sha512 = await fileSha512(installerPath)

  // Always regenerate: a feed left behind by a previous release would point
  // auto-updating clients at the wrong installer.
  const feedPath = join(OUTPUT_DIR, 'latest.yml')
  writeFileSync(
    feedPath,
    buildUpdaterFeed({
      version,
      fileName: installerName,
      sha512,
      size,
      releaseDate: new Date().toISOString(),
    }),
    'utf8',
  )
  console.log(`wrote ${feedPath} (version ${version}, ${size} bytes)`)

  assertWindowsSignature(installerPath)

  let current = await findRelease()
  if (current === undefined) {
    if (options.dryRun || options.verifyOnly) {
      throw new Error(`release ${tag} does not exist yet; run without --dry-run to create it`)
    }
    current = await createRelease(resolveNotes(options, version))
  } else {
    console.log(`release ${tag} exists (id ${current.id}, ${current.assets.length} assets)`)
  }

  if (!options.verifyOnly && !options.dryRun) {
    await uploadAsset(current.id, installerPath)
    await uploadAsset(current.id, `${installerPath}.blockmap`)
    await uploadAsset(current.id, feedPath)

    const patch = await api(`/repos/${repo}/releases/${current.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `LMCODE Desktop v${version}`,
        body: resolveNotes(options, version),
      }),
    })
    if (!patch.ok) throw new Error(`release patch failed: ${patch.status}`)
    console.log('release title and notes updated')
  }

  // Verification reads the public URLs, not the API objects, so a broken
  // download path is caught here rather than by the first updating client.
  const published = await (await api(`/repos/${repo}/releases/tags/${tag}`)).json()
  const expected = ['latest.yml', installerName, `${installerName}.blockmap`]
  const missing = expected.filter(
    (name) => !published.assets.some((asset) => asset.name === name && asset.state === 'uploaded'),
  )
  if (missing.length > 0) throw new Error(`missing assets on ${tag}: ${missing.join(', ')}`)

  const localSha256 = await fileDigest(installerPath, 'sha256')
  const uploaded = published.assets.find((asset) => asset.name === installerName)
  if (uploaded.digest !== `sha256:${localSha256}`) {
    throw new Error(
      `uploaded installer differs from the local artifact (${uploaded.digest} != sha256:${localSha256})`,
    )
  }

  const publicFeed = await fetch(`https://github.com/${repo}/releases/latest/download/latest.yml`).then(
    (response) => response.text(),
  )
  if (!publicFeed.includes(`version: ${version}`)) {
    throw new Error(`public latest.yml does not advertise ${version}`)
  }
  if (!publicFeed.includes(sha512)) {
    throw new Error('public latest.yml carries a different installer digest')
  }

  const latestTag = (await (await api(`/repos/${repo}/releases/latest`)).json()).tag_name
  console.log(`\nverified ${repo} ${tag}`)
  console.log(`  assets:      ${expected.join(', ')}`)
  console.log(`  download:    sha256:${localSha256.slice(0, 16)}… (matches the local artifact)`)
  console.log(`  feed:        version ${version}, digest matches`)
  console.log(`  releases/latest: ${latestTag}`)
  if (latestTag !== tag) throw new Error(`releases/latest points at ${latestTag}, not ${tag}`)
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename

if (invokedDirectly) {
  await main()
}
