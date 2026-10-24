/**
 * DSH session logs are append-only JSONL compressed as a CONCATENATION of
 * independent zstd frames (one per append). Node's zstd helper stops after the
 * first frame, so this module walks the zstd frame format itself and
 * decompresses each frame independently.
 *
 * Frame layout (RFC 8878): magic(4) | frame header descriptor(1) | optional
 * window descriptor | optional dictionary id | optional content size | blocks
 * (3-byte headers + payload) | optional 4-byte checksum.
 */
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = 0xfd2fb528; // little-endian bytes 28 B5 2F FD
const DICT_ID_SIZE = [0, 1, 2, 4];

/** Size of the zstd frame starting at `offset`, or -1 when it cannot be parsed. */
export function frameSize(buffer, offset = 0) {
  if (offset + 4 > buffer.length || buffer.readUInt32LE(offset) !== MAGIC) return -1;
  let p = offset + 4;
  if (p >= buffer.length) return -1;
  const descriptor = buffer[p++];
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictIdFlag = descriptor & 3;

  if (!singleSegment) p += 1; // window descriptor
  p += DICT_ID_SIZE[dictIdFlag];
  p += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
  if (p > buffer.length) return -1;

  for (;;) {
    if (p + 3 > buffer.length) return -1;
    const header = buffer.readUIntLE(p, 3);
    p += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    if (type === 3) return -1; // reserved block type
    p += type === 1 ? 1 : size; // RLE block stores a single byte
    if (p > buffer.length) return -1;
    if (last) break;
  }
  if (checksum === 1) p += 4;
  return p <= buffer.length ? p - offset : -1;
}

/** True when the buffer looks like a concatenation of zstd frames. */
export function isZstd(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === MAGIC;
}

/**
 * Decompress every zstd frame in `buffer`, in order.
 * @returns {{text: string, frames: number, skipped: number}}
 */
export function decompressZstdFrames(buffer) {
  let offset = 0;
  let frames = 0;
  let skipped = 0;
  const parts = [];
  while (offset < buffer.length) {
    if (!isZstd(buffer.subarray(offset))) {
      // Trailing padding or a corrupt tail: skip one byte and retry rather than
      // failing the whole session.
      skipped += 1;
      offset += 1;
      continue;
    }
    const size = frameSize(buffer, offset);
    if (size <= 0) {
      skipped += 1;
      offset += 1;
      continue;
    }
    const frame = buffer.subarray(offset, offset + size);
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'));
      frames += 1;
    } catch {
      skipped += 1;
    }
    offset += size;
  }
  return { text: parts.join(''), frames, skipped };
}
