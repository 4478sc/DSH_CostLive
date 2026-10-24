import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { decompressZstdFrames, frameSize, isZstd } from '../src/zstd.mjs';

test('decompresses concatenated zstd frames written by append-only logging', () => {
  const first = zstdCompressSync(Buffer.from('{"type":"session"}\n'));
  const second = zstdCompressSync(Buffer.from('{"type":"turn/start"}\n'));
  const buffer = Buffer.concat([first, second]);
  assert.equal(isZstd(buffer), true);
  assert.equal(frameSize(buffer, 0), first.length);
  const result = decompressZstdFrames(buffer);
  assert.equal(result.frames, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.text, '{"type":"session"}\n{"type":"turn/start"}\n');
});

test('accepts plain JSONL when the log is not compressed', () => {
  const result = decompressZstdFrames(Buffer.from('{"type":"session"}\n'));
  const text = result.text;
  assert.equal(text, '');
});
