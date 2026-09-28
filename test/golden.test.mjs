import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { findNode, loadCases, loadFixture } from './helpers.mjs';

for (const c of loadCases('golden.json')) {
  test(`对标：${c.name}`, () => {
    const r = parse(c.hex);
    assert.equal(r.ok, c.ok, r.errors.join('\n'));
    if (c.overview !== undefined) assert.equal(r.overview, c.overview);
    if (c.summary) assert.equal(r.summary, c.summary);
    if (c.summaryIncludes) assert.ok(r.summary.includes(c.summaryIncludes), r.summary);
    for (const [path, want] of Object.entries(c.expect || {})) {
      const nd = findNode(r.tree, path);
      assert.ok(nd, `找不到节点 ${path}`);
      if (want.value !== undefined) assert.equal(nd.value, want.value, path);
      if (want.desc !== undefined) assert.equal(nd.desc, want.desc, path);
      if (want.descIncludes !== undefined) assert.ok(nd.desc.includes(want.descIncludes), `${path}：${nd.desc}`);
      if (want.length !== undefined) assert.equal(nd.length, want.length, path);
      if (want.noteIncludes !== undefined) assert.ok((nd.note || '').includes(want.noteIncludes), `${path}：${nd.note}`);
    }
  });
}

test('公开对标用例全部包含非空概览期望', () => {
  const cases = JSON.parse(loadFixture('golden.json'));
  assert.equal(cases.length, 26);
  assert.ok(cases.every(c => typeof c.overview === 'string' && c.overview.length > 0));
});
