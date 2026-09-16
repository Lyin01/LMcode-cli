/**
 * Document attachments (Excel / Word / PDF) become text before they reach a
 * model prompt: the SDK prompt parts are text/image/video only, and extracting
 * the readable content is what lets the agent answer questions about a dragged
 * or pasted workbook. This module owns format detection and the shared limits;
 * the actual parsers live in `ooxml.ts` and `pdf.ts`.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { DocumentSourceFormat } from '../../shared/file-types.js'
import { extractDocxText, extractXlsxText, type ExtractedDocumentText } from './ooxml.js'
import { extractPdfText } from './pdf.js'
import { openZipArchive } from './zip.js'

export type { DocumentSourceFormat } from '../../shared/file-types.js'

export const DOCUMENT_ATTACHMENT_LIMIT_BYTES = 32 * 1024 * 1024

const DOCX_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.dotm'])
const XLSX_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xltx', '.xltm'])
const PDF_EXTENSIONS = new Set(['.pdf'])
/** Legacy binary Office formats: OLE containers the extractors cannot read. */
const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls', '.ppt', '.dot', '.xlt', '.pot', '.pps'])

const ZIP_LOCAL_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const ZIP_EMPTY_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1')

export type DocumentDetection =
  | { readonly kind: 'document'; readonly format: DocumentSourceFormat }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'mismatch' }
  | null

function startsWith(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix)
}

function looksLikeZip(header: Buffer): boolean {
  return startsWith(header, ZIP_LOCAL_MAGIC) || startsWith(header, ZIP_EMPTY_MAGIC)
}

/** Detects attachable document types from the file extension plus magic bytes. */
export function detectDocumentFormat(fileName: string, header: Buffer): DocumentDetection {
  const extension = path.extname(fileName).toLowerCase()

  if (LEGACY_OFFICE_EXTENSIONS.has(extension)) return { kind: 'legacy' }
  if (PDF_EXTENSIONS.has(extension)) {
    return startsWith(header, PDF_MAGIC)
      ? { kind: 'document', format: 'pdf' }
      : { kind: 'mismatch' }
  }
  if (DOCX_EXTENSIONS.has(extension) || XLSX_EXTENSIONS.has(extension)) {
    if (!looksLikeZip(header)) return { kind: 'mismatch' }
    return {
      kind: 'document',
      format: DOCX_EXTENSIONS.has(extension) ? 'docx' : 'xlsx',
    }
  }
  return null
}

/**
 * Picks the extractor from the archive contents so a renamed workbook still
 * lands on the xlsx path; falls back to the extension-derived format.
 */
function resolveOoxmlPart(
  archive: ReturnType<typeof openZipArchive>,
  format: DocumentSourceFormat,
): DocumentSourceFormat {
  if (format === 'docx') {
    if (archive.has('word/document.xml')) return 'docx'
    if (archive.has('xl/workbook.xml')) return 'xlsx'
    throw new Error('无法解析该文档（未找到 Word 正文或 Excel 工作簿结构）')
  }
  if (archive.has('xl/workbook.xml')) return 'xlsx'
  if (archive.has('word/document.xml')) return 'docx'
  throw new Error('无法解析该文档（未找到 Excel 工作簿或 Word 正文结构）')
}

export async function extractDocumentText(
  filePath: string,
  format: DocumentSourceFormat,
  maxBytes: number,
): Promise<ExtractedDocumentText> {
  const stat = await fs.stat(filePath)
  if (stat.size > DOCUMENT_ATTACHMENT_LIMIT_BYTES) {
    throw new Error(`文档超过 ${DOCUMENT_ATTACHMENT_LIMIT_BYTES / (1024 * 1024)} MB 限制`)
  }
  const buffer = await fs.readFile(filePath)

  if (format === 'pdf') {
    const result = await extractPdfText(buffer, maxBytes)
    if (!result.hasText) {
      throw new Error('该 PDF 未包含可提取的文字（可能是扫描件）')
    }
    return { content: result.content, truncated: result.truncated }
  }

  let archive: ReturnType<typeof openZipArchive>
  try {
    archive = openZipArchive(buffer)
  } catch {
    throw new Error('无法解析该文档（文件可能已损坏）')
  }

  const resolved = resolveOoxmlPart(archive, format)
  const result =
    resolved === 'docx'
      ? extractDocxText(archive, maxBytes)
      : extractXlsxText(archive, maxBytes)
  if (result.content.length === 0) {
    throw new Error('未能从该文档中提取到文字内容')
  }
  return result
}
