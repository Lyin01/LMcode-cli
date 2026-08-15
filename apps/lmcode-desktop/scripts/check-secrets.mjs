import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const EXCLUDED_DIRECTORIES = new Set([
  '.claude',
  '.git',
  '.playwright-mcp',
  '.tmp-codex-desktop-smoke',
  '.turbo',
  'coverage',
  'dist',
  'dist-current',
  'dist-good',
  'node_modules',
  'out',
  'release',
  'scratch',
  'tmp',
])
const SCANNED_EXTENSIONS = new Set([
  '.bat',
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.ps1',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
])

const SIGNATURES = [
  {
    name: 'private-key',
    pattern: /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/g,
  },
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    name: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    name: 'provider-secret',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    name: 'live-payment-key',
    pattern: /\b(?:rk|sk)_live_[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: 'hardcoded-credential',
    pattern: /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password)\b\s*[:=]\s*(['"`])[^'"`\r\n]{16,}\1/gi,
  },
]
const PLACEHOLDER_WORDS = /(?:dummy|example|fake|mock|placeholder|probe|redacted|refreshed|rotated|sample|stale|test|updated)/i
const REDACTION_FIXTURE_PATH = 'packages/agent-core/test/logging/formatter.test.ts'

async function sourceFiles(directory) {
  const files = []
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(target))
    } else if (
      entry.isFile() &&
      (SCANNED_EXTENSIONS.has(path.extname(entry.name)) || isEnvironmentFile(entry.name))
    ) {
      files.push(target)
    }
  }
  return files
}

function isEnvironmentFile(name) {
  const lower = name.toLowerCase()
  return lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example')
}

const findings = []
const files = await sourceFiles(ROOT)
for (const file of files) {
  const source = await fs.readFile(file, 'utf8')
  const relativeFile = path.relative(ROOT, file).replaceAll('\\', '/')
  for (const signature of SIGNATURES) {
    signature.pattern.lastIndex = 0
    for (const match of source.matchAll(signature.pattern)) {
      if (isAllowedFixture(relativeFile, signature.name, match[0])) continue
      const index = match.index ?? 0
      const line = source.slice(0, index).split(/\r?\n/).length
      findings.push({
        file: relativeFile,
        line,
        signature: signature.name,
      })
    }
  }
}

function isAllowedFixture(relativeFile, signatureName, matchedText) {
  if (relativeFile === REDACTION_FIXTURE_PATH) return true
  const placeholderCandidate = signatureName === 'hardcoded-credential'
    ? matchedText.match(/(['"`])([^'"`\r\n]+)\1\s*$/)?.[2] ?? ''
    : matchedText
  return PLACEHOLDER_WORDS.test(placeholderCandidate)
}

if (findings.length > 0) {
  console.error('Potential hardcoded secrets detected:')
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} (${finding.signature})`)
  }
  process.exitCode = 1
} else {
  console.log(`Secret scan passed (${files.length} source files).`)
}
