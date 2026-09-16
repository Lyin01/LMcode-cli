/**
 * Minimal, read-only ZIP container access for OOXML documents (docx / xlsx).
 *
 * Office files are ordinary ZIP archives and the desktop app only pulls a
 * handful of well-known XML parts out of them. That does not justify a zip
 * dependency or unpacking anything to disk, so this module walks the central
 * directory itself and inflates entries on demand via `node:zlib`.
 */

import * as zlib from 'node:zlib'

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const ZIP64_SENTINEL = 0xffffffff
const MAX_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024

interface DirectoryEntry {
  readonly method: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
}

export interface ZipArchive {
  readonly names: readonly string[]
  has(name: string): boolean
  /** Returns (and inflates) one entry, or `null` when the archive has no such part. */
  read(name: string): Buffer | null
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset
  }
  throw new Error('ZIP 结尾记录缺失')
}

function readDirectory(buffer: Buffer, offset: number): Map<string, DirectoryEntry> {
  const totalEntries = buffer.readUInt16LE(offset + 10)
  const directorySize = buffer.readUInt32LE(offset + 12)
  let cursor = buffer.readUInt32LE(offset + 16)
  if (cursor === ZIP64_SENTINEL || directorySize === ZIP64_SENTINEL) {
    throw new Error('不支持 ZIP64 归档')
  }

  const entries = new Map<string, DirectoryEntry>()
  for (let index = 0; index < totalEntries && cursor + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) break
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue
    if ((flags & 0x1) !== 0) throw new Error('加密的 ZIP 条目不受支持')
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      throw new Error('不支持 ZIP64 归档')
    }
    entries.set(name, { method, compressedSize, uncompressedSize, localHeaderOffset })
  }

  if (entries.size === 0) throw new Error('ZIP 归档为空或已损坏')
  return entries
}

export function openZipArchive(buffer: Buffer): ZipArchive {
  if (buffer.length < 22) throw new Error('ZIP 归档过小')
  const entries = readDirectory(buffer, findEndOfCentralDirectory(buffer))

  const read = (name: string): Buffer | null => {
    const entry = entries.get(name)
    if (entry === undefined) return null
    if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error('ZIP 条目解压后过大')
    }

    const local = entry.localHeaderOffset
    if (
      local + 30 > buffer.length ||
      buffer.readUInt32LE(local) !== LOCAL_FILE_HEADER_SIGNATURE
    ) {
      throw new Error('ZIP 本地文件头无效')
    }
    const nameLength = buffer.readUInt16LE(local + 26)
    const extraLength = buffer.readUInt16LE(local + 28)
    const start = local + 30 + nameLength + extraLength
    const end = start + entry.compressedSize
    if (end > buffer.length) throw new Error('ZIP 条目数据越界')
    const raw = buffer.subarray(start, end)

    if (entry.method === 0) return raw
    if (entry.method === 8) {
      return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED_BYTES })
    }
    throw new Error('不支持的 ZIP 压缩方式')
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
  }
}
