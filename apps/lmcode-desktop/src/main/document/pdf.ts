/**
 * PDF text extraction on top of a vendored `pdfjs-dist` runtime.
 *
 * pdf.js is the only dependency that reliably handles real-world PDFs
 * (compressed object streams, CID fonts, predefined CMaps, ToUnicode maps), so
 * the desktop build vendors its `legacy/build` bundle under `out/vendor/pdfjs`
 * and this module loads it lazily. Tests and development fall back to the copy
 * inside `node_modules`.
 */

import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TextBudget } from './text-budget.js'
import type { ExtractedDocumentText } from './ooxml.js'

interface PdfTextItem {
  readonly str?: unknown
  readonly hasEOL?: unknown
}

interface PdfPage {
  getTextContent(): Promise<{ readonly items: readonly PdfTextItem[] }>
  cleanup(): void
}

interface PdfDocument {
  readonly numPages: number
  getPage(index: number): Promise<PdfPage>
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>
  destroy(): Promise<void>
}

interface PdfjsModule {
  getDocument(params: Record<string, unknown>): PdfLoadingTask
}

interface PdfjsRuntime {
  readonly moduleEntry: string
  readonly cmaps: string
  readonly standardFonts: string
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))

function findVendoredRuntime(): PdfjsRuntime | null {
  const candidates = [
    // Built layout: out/main/index.js → out/vendor/pdfjs.
    path.resolve(moduleDirectory, '../vendor/pdfjs'),
    // Source layout (vitest): src/main/document → <app>/out/vendor/pdfjs.
    path.resolve(moduleDirectory, '../../../out/vendor/pdfjs'),
  ]
  for (const directory of candidates) {
    const moduleEntry = path.join(directory, 'pdf.min.mjs')
    if (!fs.existsSync(moduleEntry)) continue
    return {
      moduleEntry,
      cmaps: path.join(directory, 'cmaps'),
      standardFonts: path.join(directory, 'standard_fonts'),
    }
  }
  return null
}

function findInstalledRuntime(): PdfjsRuntime | null {
  try {
    const requireFromHere = createRequire(import.meta.url)
    const packageDirectory = path.dirname(requireFromHere.resolve('pdfjs-dist/package.json'))
    const moduleEntry = path.join(packageDirectory, 'legacy/build/pdf.min.mjs')
    if (!fs.existsSync(moduleEntry)) return null
    return {
      moduleEntry,
      cmaps: path.join(packageDirectory, 'cmaps'),
      standardFonts: path.join(packageDirectory, 'standard_fonts'),
    }
  } catch {
    return null
  }
}

let cached: { readonly pdfjs: PdfjsModule; readonly runtime: PdfjsRuntime } | null = null

async function loadPdfjs(): Promise<{ readonly pdfjs: PdfjsModule; readonly runtime: PdfjsRuntime }> {
  if (cached !== null) return cached
  const runtime = findVendoredRuntime() ?? findInstalledRuntime()
  if (runtime === null) throw new Error('PDF 解析组件不可用')
  const pdfjs = (await import(pathToFileURL(runtime.moduleEntry).href)) as PdfjsModule
  cached = { pdfjs, runtime }
  return cached
}

function cleanPageText(raw: string): string {
  return raw
    .replaceAll('\u00a0', ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function extractPdfText(
  data: Buffer,
  maxBytes: number,
): Promise<ExtractedDocumentText & { readonly pageCount: number; readonly hasText: boolean }> {
  const { pdfjs, runtime } = await loadPdfjs()
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    // pdf.js insists on a trailing slash in the factory URLs; `/` also works
    // for filesystem reads on Windows.
    cMapUrl: `${runtime.cmaps}/`,
    cMapPacked: true,
    standardFontDataUrl: `${runtime.standardFonts}/`,
    verbosity: 0,
  })

  const budget = new TextBudget(maxBytes)
  let pageCount = 0
  let hasText = false
  try {
    const document = await task.promise
    pageCount = document.numPages
    for (let index = 1; index <= document.numPages; index += 1) {
      if (budget.isFull) break
      const page = await document.getPage(index)
      try {
        const textContent = await page.getTextContent()
        const text = collectPageText(textContent.items)
        if (text.length === 0) continue
        hasText = true
        budget.append(`## 第 ${index} 页\n`)
        budget.append(text)
        budget.append('\n\n')
      } finally {
        page.cleanup()
      }
    }
  } finally {
    await task.destroy().catch(() => undefined)
  }

  return {
    content: budget.toString().trim(),
    truncated: budget.isFull,
    pageCount,
    hasText,
  }
}

function collectPageText(items: readonly PdfTextItem[]): string {
  const parts: string[] = []
  for (const item of items) {
    if (typeof item.str === 'string' && item.str.length > 0) parts.push(item.str)
    if (item.hasEOL === true) parts.push('\n')
  }
  return cleanPageText(parts.join(''))
}
