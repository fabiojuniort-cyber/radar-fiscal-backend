/**
 * Minimal, dependency-free ZIP reader for evidence packages (stored or deflated entries, no ZIP64, no encryption).
 * Every entry is decompressed from the archive bytes themselves and its CRC-32 is checked; directory traversal names
 * (absolute, "..", backslashes) are refused. Used so that ingestion proves which bytes came from WHICH archive file.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {}
export function readZipEntries(zip: Uint8Array): Map<string, Uint8Array> {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('end of central directory not found');
  const count = b.readUInt16LE(eocd + 10); const cdOffset = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 is not supported');
  const out = new Map<string, Uint8Array>(); let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new ZipError('bad central directory entry');
    const flags = b.readUInt16LE(p + 8); const method = b.readUInt16LE(p + 10); const crc = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20); const usize = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28); const xlen = b.readUInt16LE(p + 30); const clen = b.readUInt16LE(p + 32); const local = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString((flags & 0x800) ? 'utf8' : 'latin1');
    p += 46 + nlen + xlen + clen;
    if (flags & 0x1) throw new ZipError(`${name}: encrypted entries are not supported`);
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new ZipError(`${name}: unsafe entry name`);
    if (name.endsWith('/')) continue;
    if (b.readUInt32LE(local) !== 0x04034b50) throw new ZipError(`${name}: bad local header`);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : (() => { throw new ZipError(`${name}: compression method ${method} not supported`); })();
    if (data.length !== usize || crc32(data) !== crc) throw new ZipError(`${name}: size or CRC-32 mismatch`);
    if (out.has(name)) throw new ZipError(`${name}: duplicated entry`);
    out.set(name, new Uint8Array(data));
  }
  return out;
}
