import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDesktopPromptInput, readFileAttachment, TEXT_ATTACHMENT_LIMIT_BYTES } from '../src/main/file-attachment'
import { parseTextAttachmentPart, serializeTextAttachmentPart } from '../src/shared/file-types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function temporaryFile(name: string, content: string | Uint8Array): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lmcode-document-'))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, name)
  await fs.writeFile(filePath, content)
  return filePath
}

// ── fixtures ──────────────────────────────────────────────────────────

interface ZipFixtureEntry {
  readonly name: string
  readonly data: string | Uint8Array
  readonly store?: boolean
}

function buildZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const data =
      typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
    const name = Buffer.from(entry.name, 'utf8')
    const stored = entry.store === true
    const payload = stored ? data : deflateRawSync(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localChunks.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, name)

    offset += local.length + name.length + payload.length
  }

  const centralSize = centralChunks.reduce((total, chunk) => total + chunk.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...localChunks, ...centralChunks, end])
}

function xlsxFixture(): Buffer {
  return buildZip([
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0"?><workbook><sheets><sheet name="调拨明细" sheetId="1" r:id="rId1"/><sheet name="边界" sheetId="2" r:id="rId2"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    },
    {
      name: 'xl/sharedStrings.xml',
      data: '<sst><si><t>日期</t></si><si><r><t>调拨</t></r><r><t>单号</t></r></si><si><t xml:space="preserve">含 &amp; 转义 &lt;x&gt;</t></si></sst>',
      // Stored (method 0) exercises the uncompressed branch of the zip reader.
      store: true,
    },
    {
      name: 'xl/styles.xml',
      data: '<styleSheet><numFmts count="1"><numFmt numFmtId="165" formatCode="yyyy/m/d"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="165"/></cellXfs></styleSheet>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" s="1"><v>45566</v></c><c r="B2" s="2"><v>0.125</v></c><c r="C2" t="inlineStr"><is><t>行内文本</t></is></c></row><row r="3"><c r="A3" t="b"><v>1</v></c><c r="C3"><v>12.5</v></c></row></sheetData></worksheet>',
    },
    {
      name: 'xl/worksheets/sheet2.xml',
      data: '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>59</v></c><c r="B1" s="3"><v>61</v></c></row></sheetData></worksheet>',
    },
  ])
}

function docxFixture(): Buffer {
  return buildZip([
    {
      name: 'word/document.xml',
      data:
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>调拨申请</w:t></w:r><w:r><w:t xml:space="preserve"> 说明</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>第二段</w:t><w:tab/><w:t>制表</w:t></w:r></w:p>' +
        '<w:tbl>' +
        '<w:tr><w:tc><w:p><w:r><w:t>品名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>螺丝</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10</w:t></w:r></w:p></w:tc></w:tr>' +
        '</w:tbl>' +
        '<w:p><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>' +
        '</w:body></w:document>',
    },
  ])
}

function escapePdfText(text: string): string {
  return text.replace(/([\\()])/g, '\\$1')
}

interface PdfObjectStream {
  readonly stream: Buffer
}

/** Builds a small flate-compressed PDF with one text line per page. */
function buildPdfFixture(pageTexts: readonly string[]): Buffer {
  const pageCount = pageTexts.length
  const contentStart = 4
  const pageStart = contentStart + pageCount
  const objects = new Map<number, string | PdfObjectStream>()

  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  const kids = pageTexts.map((_, index) => `${pageStart + index} 0 R`).join(' ')
  objects.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`)
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  pageTexts.forEach((text, index) => {
    const ops = text.length === 0
      ? ''
      : `BT /F1 24 Tf 72 720 Td (${escapePdfText(text)}) Tj ET\n`
    objects.set(contentStart + index, { stream: deflateSync(Buffer.from(ops, 'latin1')) })
    objects.set(
      pageStart + index,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentStart + index} 0 R >>`,
    )
  })

  return serializePdf(objects.size, objects)
}

/** Identity-H Type0 font with a ToUnicode CMap — the common Chinese PDF shape. */
function cidPdfFixture(): Buffer {
  const cmap =
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    '1 beginbfchar\n<4F60> <4F60>\nendbfchar\n' +
    '1 beginbfrange\n<4E00> <4E01> [<4E00> <4E01>]\nendbfrange\n' +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend'
  const ops = 'BT /F1 24 Tf 72 720 Td <4F604E004E01> Tj ET\n'
  const objects = new Map<number, string | PdfObjectStream>()
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  objects.set(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  objects.set(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  )
  objects.set(4, { stream: deflateSync(Buffer.from(ops, 'latin1')) })
  objects.set(
    5,
    '<< /Type /Font /Subtype /Type0 /BaseFont /Fake /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
  )
  objects.set(
    6,
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fake /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 >>',
  )
  objects.set(7, { stream: Buffer.from(cmap, 'latin1') })
  objects.set(
    8,
    '<< /Type /FontDescriptor /FontName /Fake /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0 /CapHeight 1000 /StemV 80 >>',
  )
  return serializePdf(objects.size, objects)
}

function serializePdf(
  count: number,
  objects: ReadonlyMap<number, string | PdfObjectStream>,
): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  const push = (chunk: Buffer | string): void => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1')
    parts.push(buffer)
    offset += buffer.length
  }

  push('%PDF-1.4\n')
  const offsets: number[] = []
  for (let number = 1; number <= count; number += 1) {
    const value = objects.get(number)
    if (value === undefined) throw new Error(`missing pdf object ${number}`)
    offsets.push(offset)
    if (typeof value === 'string') {
      push(`${number} 0 obj\n${value}\nendobj\n`)
    } else {
      push(`${number} 0 obj\n<< /Length ${value.stream.length} /Filter /FlateDecode >>\nstream\n`)
      push(value.stream)
      push('\nendstream\nendobj\n')
    }
  }

  const xrefOffset = offset
  let xref = `xref\n0 ${count + 1}\n0000000000 65535 f \n`
  for (const objectOffset of offsets) {
    xref += `${String(objectOffset).padStart(10, '0')} 00000 n \n`
  }
  push(xref)
  push(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  return Buffer.concat(parts)
}

function largeXlsxFixture(): Buffer {
  const rows: string[] = []
  for (let index = 1; index <= 6000; index += 1) {
    rows.push(
      `<row r="${index}"><c r="A${index}"><v>${index}</v></c>` +
        `<c r="B${index}" t="inlineStr"><is><t>这是一段用于测试截断的文字内容${index}</t></is></c></row>`,
    )
  }
  return buildZip([
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0"?><workbook><sheets><sheet name="大表" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`,
    },
  ])
}

// ── tests ─────────────────────────────────────────────────────────────

describe('document attachments', () => {
  it('extracts an xlsx workbook into per-sheet TSV text', async () => {
    const filePath = await temporaryFile('9-14调拨明细.xlsx', xlsxFixture())

    const preview = await readFileAttachment(filePath)

    expect(preview.kind).toBe('text')
    if (preview.kind !== 'text') throw new Error('expected a text preview')
    expect(preview.name).toBe('9-14调拨明细.xlsx')
    expect(preview.sourceFormat).toBe('xlsx')
    expect(preview.content).toBe(
      [
        '## 工作表：调拨明细',
        '日期\t调拨单号\t含 & 转义 <x>',
        '2024-10-01\t12.5%\t行内文本',
        'TRUE\t\t12.5',
        '',
        '## 工作表：边界',
        '1900-02-28\t1900-03-01',
      ].join('\n'),
    )
  })

  it('extracts docx paragraphs, tabs and table rows', async () => {
    const filePath = await temporaryFile('调拨申请.docx', docxFixture())

    const preview = await readFileAttachment(filePath)

    expect(preview.kind).toBe('text')
    if (preview.kind !== 'text') throw new Error('expected a text preview')
    expect(preview.sourceFormat).toBe('docx')
    expect(preview.content).toBe('调拨申请 说明\n第二段\t制表\n品名 | 数量\n螺丝 | 10')
  })

  it('extracts pdf text page by page', async () => {
    const filePath = await temporaryFile(
      'invoice.pdf',
      buildPdfFixture(['Invoice 2024-09-14', 'Total 123.45 CNY']),
    )

    const preview = await readFileAttachment(filePath)

    expect(preview.kind).toBe('text')
    if (preview.kind !== 'text') throw new Error('expected a text preview')
    expect(preview.sourceFormat).toBe('pdf')
    expect(preview.content).toBe(
      '## 第 1 页\nInvoice 2024-09-14\n\n## 第 2 页\nTotal 123.45 CNY',
    )
  })

  it('maps Identity-H CID text through the font ToUnicode CMap', async () => {
    const filePath = await temporaryFile('中文.pdf', cidPdfFixture())

    const preview = await readFileAttachment(filePath)
    if (preview.kind !== 'text') throw new Error('expected a text preview')

    expect(preview.content).toBe('## 第 1 页\n你一丁')
  })

  it('caps extracted text at the text attachment budget', async () => {
    const filePath = await temporaryFile('大表.xlsx', largeXlsxFixture())

    const preview = await readFileAttachment(filePath)
    if (preview.kind !== 'text') throw new Error('expected a text preview')

    expect(preview.truncated).toBe(true)
    expect(Buffer.byteLength(preview.content, 'utf8')).toBeLessThanOrEqual(
      TEXT_ATTACHMENT_LIMIT_BYTES,
    )
    expect(preview.content.startsWith('## 工作表：大表')).toBe(true)
  })

  it('rejects legacy binary office files with a save-as hint', async () => {
    const oleMagic = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    const filePath = await temporaryFile('旧文件.doc', oleMagic)

    await expect(readFileAttachment(filePath)).rejects.toThrow('另存为')
  })

  it('rejects documents whose bytes contradict the extension', async () => {
    const pdfPath = await temporaryFile('fake.pdf', 'plain text, not a pdf')
    const xlsxPath = await temporaryFile('fake.xlsx', 'plain text, not a zip')

    await expect(readFileAttachment(pdfPath)).rejects.toThrow('文件内容与扩展名不一致')
    await expect(readFileAttachment(xlsxPath)).rejects.toThrow('文件内容与扩展名不一致')
  })

  it('reports unreadable containers and scanned pdfs instead of empty attachments', async () => {
    const brokenPath = await temporaryFile(
      'broken.xlsx',
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]),
    )
    const notOfficePath = await temporaryFile(
      'not-office.docx',
      buildZip([{ name: 'readme.txt', data: 'hello' }]),
    )
    const scannedPath = await temporaryFile('scan.pdf', buildPdfFixture(['']))

    await expect(readFileAttachment(brokenPath)).rejects.toThrow('无法解析该文档')
    await expect(readFileAttachment(notOfficePath)).rejects.toThrow('无法解析该文档')
    await expect(readFileAttachment(scannedPath)).rejects.toThrow('未包含可提取的文字')
  })

  it('rejects documents above the document size limit', async () => {
    // A sparse file keeps the fixture cheap: valid ZIP magic, 32 MiB + 1 end.
    const filePath = await temporaryFile('sparse.xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    await fs.truncate(filePath, 32 * 1024 * 1024 + 1)

    await expect(readFileAttachment(filePath)).rejects.toThrow('超过 32 MB')
  })

  it('carries the source format into the serialized prompt part', async () => {
    const filePath = await temporaryFile('调拨申请.docx', docxFixture())

    const parts = await buildDesktopPromptInput({
      text: '帮我看看这个文件',
      attachments: [{ source: 'path', kind: 'text', filePath }],
    })

    expect(parts).toHaveLength(2)
    const attachmentPart = parts[1]
    if (attachmentPart?.type !== 'text') throw new Error('expected a text attachment part')
    const parsed = parseTextAttachmentPart(attachmentPart.text)
    expect(parsed?.metadata.sourceFormat).toBe('docx')
    expect(parsed?.content).toBe('调拨申请 说明\n第二段\t制表\n品名 | 数量\n螺丝 | 10')

    const roundTripped = parseTextAttachmentPart(
      serializeTextAttachmentPart({
        kind: 'text',
        name: 'plain.txt',
        content: 'hello',
        sizeBytes: 5,
        truncated: false,
      }),
    )
    expect(roundTripped?.metadata.sourceFormat).toBeUndefined()
  })
})
