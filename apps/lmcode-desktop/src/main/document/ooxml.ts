/**
 * Text extraction for OOXML documents: Word (`.docx`) and Excel (`.xlsx`).
 *
 * The extractors scan the XML parts instead of building a DOM. Office parts can
 * be tens of megabytes and the whole point is to flatten them into prompt text,
 * so a token-level scan is both smaller and faster than a real XML parser, and
 * it keeps working on the damaged markup real-world files occasionally carry.
 */

import * as path from 'node:path'
import { TextBudget } from './text-budget.js'
import type { ZipArchive } from './zip.js'

export interface ExtractedDocumentText {
  readonly content: string
  readonly truncated: boolean
}

const DOCX_DOCUMENT_PART = 'word/document.xml'
const XLSX_WORKBOOK_PART = 'xl/workbook.xml'
const XLSX_WORKBOOK_RELS_PART = 'xl/_rels/workbook.xml.rels'

/** Built-in Excel number formats that render as dates/times (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50,
  51, 52, 53, 54, 55, 56, 57, 58,
])
const BUILTIN_PERCENT_FORMAT_IDS = new Set([9, 10])

const XML_TOKENS = /<[^>]*>|[^<]+/g
const XML_ENTITY_PATTERN = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g

// ── Shared XML helpers ────────────────────────────────────────────────

interface ParsedTag {
  readonly name: string
  readonly closing: boolean
  readonly selfClosing: boolean
}

function parseTag(tag: string): ParsedTag {
  let body = tag.slice(1, tag.endsWith('>') ? -1 : undefined)
  const closing = body.startsWith('/')
  if (closing) body = body.slice(1)
  const selfClosing = body.endsWith('/')
  if (selfClosing) body = body.slice(0, -1)

  let end = body.length
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      end = index
      break
    }
  }
  return { name: body.slice(0, end).toLowerCase(), closing, selfClosing }
}

function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(
    XML_ENTITY_PATTERN,
    (match: string, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (hex !== undefined) return codePointToString(Number.parseInt(hex, 16))
      if (decimal !== undefined) return codePointToString(Number.parseInt(decimal, 10))
      switch (named) {
        case 'amp':
          return '&'
        case 'lt':
          return '<'
        case 'gt':
          return '>'
        case 'quot':
          return '"'
        case 'apos':
          return "'"
        default:
          return match
      }
    },
  )
}

function codePointToString(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return ''
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return ''
  return String.fromCodePoint(codePoint)
}

function readAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`[\\s]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`)
  const match = pattern.exec(tag)
  return match?.[1] ?? null
}

function normalizeExtractedText(raw: string): string {
  return raw
    .replaceAll('\u00a0', ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Word (.docx) ──────────────────────────────────────────────────────

export function extractDocxText(
  archive: ZipArchive,
  maxBytes: number,
): ExtractedDocumentText {
  const part = archive.read(DOCX_DOCUMENT_PART)
  if (part === null) throw new Error('DOCX 缺少 word/document.xml')

  const budget = new TextBudget(maxBytes)
  let capturingRun = false
  let firstCellInRow = true
  let firstParagraphInCell = false
  let paragraphPropertyDepth = 0

  const appendLineBreak = (): void => {
    const last = budget.lastChar
    if (last !== '' && last !== '\n') budget.append('\n')
  }

  for (const token of part.toString('utf8').match(XML_TOKENS) ?? []) {
    if (budget.isFull) break
    if (token.charCodeAt(0) === 0x3c) {
      const tag = parseTag(token)
      switch (tag.name) {
        case 'w:t':
          capturingRun = !tag.closing && !tag.selfClosing
          break
        case 'w:p':
          if (!tag.closing && !tag.selfClosing) {
            // The first paragraph of a table cell starts the cell content, so it
            // must not emit a line break; the cell separator handles placement.
            if (firstParagraphInCell) firstParagraphInCell = false
            else appendLineBreak()
          }
          break
        case 'w:tc':
          if (!tag.closing && !tag.selfClosing) {
            if (!firstCellInRow) budget.append(' | ')
            firstCellInRow = false
            firstParagraphInCell = true
          }
          break
        case 'w:tr':
          if (!tag.selfClosing) {
            // Rows start on their own line; `appendLineBreak` is idempotent so
            // the close tag after the last cell does not add a blank line.
            appendLineBreak()
            firstCellInRow = true
          }
          break
        case 'w:ppr':
          // `<w:pPr><w:tabs><w:tab …/></w:tabs></w:pPr>` declares tab stops —
          // those are not text and must not leak into the extracted content.
          if (tag.closing) paragraphPropertyDepth = Math.max(0, paragraphPropertyDepth - 1)
          else if (!tag.selfClosing) paragraphPropertyDepth += 1
          break
        case 'w:tab':
          if (!tag.closing && paragraphPropertyDepth === 0) budget.append('\t')
          break
        case 'w:br':
        case 'w:cr':
          if (!tag.closing) budget.append('\n')
          break
        default:
          break
      }
    } else if (capturingRun) {
      budget.append(decodeXmlEntities(token))
    }
  }

  return { content: normalizeExtractedText(budget.toString()), truncated: budget.isFull }
}

// ── Excel (.xlsx) ─────────────────────────────────────────────────────

interface WorkbookSheet {
  readonly name: string
  readonly relationshipId: string | null
}

interface CellStyles {
  readonly dateStyles: ReadonlySet<number>
  readonly percentStyles: ReadonlySet<number>
}

export function extractXlsxText(
  archive: ZipArchive,
  maxBytes: number,
): ExtractedDocumentText {
  const workbookPart = archive.read(XLSX_WORKBOOK_PART)
  if (workbookPart === null) throw new Error('XLSX 缺少 xl/workbook.xml')

  const workbookXml = workbookPart.toString('utf8')
  const sheets = parseWorkbookSheets(workbookXml)
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/i.test(workbookXml)
  const relationships = parseWorkbookRelationships(archive)
  const sharedStrings = parseSharedStrings(archive)
  const styles = parseCellStyles(archive)

  const budget = new TextBudget(maxBytes)
  let sheetIndex = 0
  for (const sheet of sheets) {
    if (budget.isFull) break
    budget.append(`## 工作表：${sheet.name}\n`)
    const target = resolveSheetPart(archive, relationships, sheet, sheetIndex)
    sheetIndex += 1
    if (target === null) continue
    const sheetXml = archive.read(target)
    if (sheetXml === null) continue
    appendSheetRows(budget, sheetXml.toString('utf8'), sharedStrings, styles, date1904)
    budget.append('\n')
  }

  return { content: normalizeExtractedText(budget.toString()), truncated: budget.isFull }
}

function resolveSheetPart(
  archive: ZipArchive,
  relationships: ReadonlyMap<string, string>,
  sheet: WorkbookSheet,
  sheetIndex: number,
): string | null {
  if (sheet.relationshipId !== null) {
    const target = relationships.get(sheet.relationshipId)
    if (target !== undefined && archive.has(target)) return target
  }
  const fallback = `xl/worksheets/sheet${sheetIndex + 1}.xml`
  return archive.has(fallback) ? fallback : null
}

function parseWorkbookSheets(xml: string): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = []
  for (const match of xml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = match[0]
    const name = readAttribute(tag, 'name')
    if (name === null) continue
    sheets.push({
      name: decodeXmlEntities(name),
      relationshipId: readAttribute(tag, 'r:id'),
    })
  }
  return sheets
}

function parseWorkbookRelationships(archive: ZipArchive): Map<string, string> {
  const relationships = new Map<string, string>()
  const part = archive.read(XLSX_WORKBOOK_RELS_PART)
  if (part === null) return relationships

  for (const match of part.toString('utf8').matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = match[0]
    const id = readAttribute(tag, 'Id')
    const target = readAttribute(tag, 'Target')
    const type = readAttribute(tag, 'Type')
    if (id === null || target === null) continue
    if (type !== null && !type.endsWith('/worksheet')) continue
    const decoded = decodeXmlEntities(target)
    relationships.set(
      id,
      decoded.startsWith('/')
        ? decoded.slice(1)
        : path.posix.normalize(path.posix.join('xl', decoded)),
    )
  }
  return relationships
}

function parseSharedStrings(archive: ZipArchive): string[] {
  const strings: string[] = []
  const part = archive.read('xl/sharedStrings.xml')
  if (part === null) return strings

  let capturing = false
  let inItem = false
  let phoneticDepth = 0
  let current = ''
  for (const token of part.toString('utf8').match(XML_TOKENS) ?? []) {
    if (token.charCodeAt(0) === 0x3c) {
      const tag = parseTag(token)
      switch (tag.name) {
        case 'si':
          if (tag.closing || tag.selfClosing) {
            strings.push(current)
            current = ''
            inItem = false
          } else {
            inItem = true
            current = ''
          }
          break
        case 'rph':
          if (tag.closing) phoneticDepth = Math.max(0, phoneticDepth - 1)
          else if (!tag.selfClosing) phoneticDepth += 1
          break
        case 't':
          capturing = inItem && phoneticDepth === 0 && !tag.closing && !tag.selfClosing
          break
        default:
          break
      }
    } else if (capturing) {
      current += decodeXmlEntities(token)
    }
  }
  return strings
}

function parseCellStyles(archive: ZipArchive): CellStyles {
  const dateStyles = new Set<number>()
  const percentStyles = new Set<number>()
  const part = archive.read('xl/styles.xml')
  if (part === null) return { dateStyles, percentStyles }

  const xml = part.toString('utf8')
  const customFormats = new Map<number, string>()
  for (const match of xml.matchAll(/<numFmt\b[^>]*\/?>/g)) {
    const id = Number.parseInt(readAttribute(match[0], 'numFmtId') ?? '', 10)
    const code = readAttribute(match[0], 'formatCode')
    if (!Number.isInteger(id) || code === null) continue
    customFormats.set(id, decodeXmlEntities(code))
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)
  if (cellXfs === null) return { dateStyles, percentStyles }

  let styleIndex = 0
  for (const match of (cellXfs[1] ?? '').matchAll(/<xf\b[^>]*\/?>/g)) {
    const id = Number.parseInt(readAttribute(match[0], 'numFmtId') ?? '0', 10)
    const classification = classifyNumberFormat(Number.isInteger(id) ? id : 0, customFormats)
    if (classification === 'date') dateStyles.add(styleIndex)
    else if (classification === 'percent') percentStyles.add(styleIndex)
    styleIndex += 1
  }
  return { dateStyles, percentStyles }
}

function classifyNumberFormat(
  numFmtId: number,
  customFormats: ReadonlyMap<number, string>,
): 'date' | 'percent' | 'plain' {
  if (BUILTIN_DATE_FORMAT_IDS.has(numFmtId)) return 'date'
  if (BUILTIN_PERCENT_FORMAT_IDS.has(numFmtId)) return 'percent'
  const code = customFormats.get(numFmtId)
  if (code === undefined) return 'plain'

  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
  if (stripped.includes('%')) return 'percent'
  return /[ymdhs]/i.test(stripped) ? 'date' : 'plain'
}

function appendSheetRows(
  budget: TextBudget,
  xml: string,
  sharedStrings: readonly string[],
  styles: CellStyles,
  date1904: boolean,
): void {
  let cells = new Map<number, string>()
  let maxColumn = -1
  let cursorColumn = -1
  let rowOpen = false

  let cellColumn = -1
  let cellStyleIndex = -1
  let cellType = ''
  let rawValue = ''
  let inlineText = ''
  let capturingValue = false
  let capturingInlineText = false
  let phoneticDepth = 0

  const flushRow = (): void => {
    if (!rowOpen) return
    rowOpen = false
    const values: string[] = []
    for (let index = 0; index <= maxColumn; index += 1) values.push(cells.get(index) ?? '')
    while (values.length > 0 && values[values.length - 1] === '') values.pop()
    budget.append(values.join('\t'))
    budget.append('\n')
    cells = new Map()
    maxColumn = -1
    cursorColumn = -1
  }

  const resetCell = (): void => {
    cellColumn = -1
    cellStyleIndex = -1
    cellType = ''
    rawValue = ''
    inlineText = ''
    capturingValue = false
    capturingInlineText = false
    phoneticDepth = 0
  }

  const settleCell = (column: number): void => {
    const raw = rawValue.trim()
    let value = ''
    switch (cellType) {
      case 's': {
        const index = Number.parseInt(raw, 10)
        value = Number.isInteger(index) ? sharedStrings[index] ?? '' : ''
        break
      }
      case 'inlinestr':
        value = inlineText
        break
      case 'str':
      case 'e':
      case 'd':
        value = rawValue
        break
      case 'b':
        value = raw === '' ? '' : raw === '1' ? 'TRUE' : 'FALSE'
        break
      default:
        if (raw !== '') {
          if (styles.dateStyles.has(cellStyleIndex)) {
            const serial = Number(raw)
            value =
              (Number.isFinite(serial) ? formatSerialDate(serial, date1904) : null) ??
              formatNumericValue(raw)
          } else if (styles.percentStyles.has(cellStyleIndex)) {
            value = formatPercentValue(raw)
          } else {
            value = formatNumericValue(raw)
          }
        } else if (inlineText !== '') {
          value = inlineText
        }
        break
    }
    resetCell()
    if (value === '') return
    cells.set(column, value)
    if (column > maxColumn) maxColumn = column
  }

  for (const token of xml.match(XML_TOKENS) ?? []) {
    if (budget.isFull) break
    if (token.charCodeAt(0) === 0x3c) {
      const tag = parseTag(token)
      switch (tag.name) {
        case 'row':
          if (tag.closing) flushRow()
          else if (!tag.selfClosing) {
            rowOpen = true
            cells = new Map()
            maxColumn = -1
            cursorColumn = -1
          }
          break
        case 'c':
          if (tag.closing || tag.selfClosing) {
            if (cellColumn >= 0) settleCell(cellColumn)
            else resetCell()
          } else {
            const reference = readAttribute(token, 'r')
            const parsedColumn = reference === null ? null : columnIndexFromReference(reference)
            cellColumn = parsedColumn ?? cursorColumn + 1
            cursorColumn = cellColumn
            const style = readAttribute(token, 's')
            const parsedStyle = Number.parseInt(style ?? '', 10)
            cellStyleIndex = Number.isInteger(parsedStyle) ? parsedStyle : -1
            cellType = (readAttribute(token, 't') ?? '').toLowerCase()
            rawValue = ''
            inlineText = ''
            capturingValue = false
            capturingInlineText = false
            phoneticDepth = 0
          }
          break
        case 'v':
          if (!tag.closing && !tag.selfClosing) {
            capturingValue = true
            rawValue = ''
          } else {
            capturingValue = false
          }
          break
        case 'rph':
          if (tag.closing) phoneticDepth = Math.max(0, phoneticDepth - 1)
          else if (!tag.selfClosing) phoneticDepth += 1
          break
        case 't':
          capturingInlineText = !tag.closing && !tag.selfClosing && phoneticDepth === 0
          break
        default:
          break
      }
    } else if (capturingValue) {
      rawValue += decodeXmlEntities(token)
    } else if (capturingInlineText) {
      inlineText += decodeXmlEntities(token)
    }
  }
  flushRow()
}

function columnIndexFromReference(reference: string): number | null {
  const match = /^([A-Za-z]+)/.exec(reference)
  const letters = match?.[1]
  if (letters === undefined) return null
  let index = 0
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 0x40)
  }
  return index - 1
}

function formatNumericValue(raw: string): string {
  const trimmed = raw.trim()
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return trimmed
  if (Number.isInteger(value)) {
    // Route long integers around IEEE-754 precision loss.
    return /^\d{16,}$/.test(trimmed) ? trimmed : String(value)
  }
  return String(Math.round(value * 1e10) / 1e10)
}

function formatPercentValue(raw: string): string {
  const value = Number(raw.trim())
  if (!Number.isFinite(value)) return raw.trim()
  return `${Math.round(value * 1e4) / 100}%`
}

function formatSerialDate(serial: number, date1904: boolean): string | null {
  const normalized = serial + (date1904 ? 1462 : 0)
  if (!Number.isFinite(normalized) || normalized < 0) return null

  const dayCount = Math.floor(normalized)
  const fraction = normalized - dayCount
  // Excel's 1900 calendar contains the non-existent 1900-02-29 (serial 60).
  const realDays = dayCount >= 61 ? dayCount - 1 : dayCount === 60 ? 59 : dayCount
  const date = new Date(Date.UTC(1899, 11, 31) + realDays * 86_400_000 + Math.round(fraction * 86_400_000))

  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  if (fraction === 0) return `${year}-${month}-${day}`

  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  const seconds = date.getUTCSeconds()
  const time = seconds === 0
    ? `${hours}:${minutes}`
    : `${hours}:${minutes}:${String(seconds).padStart(2, '0')}`
  return realDays === 0 ? time : `${year}-${month}-${day} ${time}`
}
