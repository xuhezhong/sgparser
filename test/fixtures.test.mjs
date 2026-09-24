import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrame, hexToBytes, loadCorpus, loadFixture, NEED_PRIVATE, SHOT } from './helpers.mjs';

test('语料：623 条，格式、方向、长度、CS 全部正确（R10.3）', { skip: NEED_PRIVATE }, () => {
  const rows = loadCorpus();
  assert.equal(rows.length, 623);
  for (const { dir, hex } of rows) {
    assert.match(hex, /^[0-9A-F]+$/);
    const b = hexToBytes(hex);
    const L = b[1] | (b[2] << 8);
    assert.equal(b.length, L + 8, hex);
    assert.equal(b[6] >> 7, dir, hex);
    assert.equal(b.subarray(6, 6 + L).reduce((s, x) => s + x, 0) & 0xff, b[6 + L], hex);
  }
});

test('语料：不含 AFN=06 安全认证帧、不含 IP（R10.4）', { skip: NEED_PRIVATE }, () => {
  for (const { hex } of loadCorpus()) assert.notEqual(hexToBytes(hex)[14], 0x06, hex);
  assert.doesNotMatch(loadFixture('private/corpus.txt'), /(\d{1,3}\.){3}\d{1,3}/);
});

test('helpers：buildFrame 自动补 L 与 CS', () => {
  assert.equal(buildFrame('4A9999990100000004648009001100E0010000000000030000007856341210' + '00'.repeat(16)), SHOT);
});
