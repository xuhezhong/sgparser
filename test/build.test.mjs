import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { here } from './helpers.mjs';

const root = join(here, '..');
const out = join(root, 'dist', '南网报文解析.html');

test('构建产物：单文件、无外链、小于 1MB、脚本可编译（R8.1）', () => {
  execFileSync(process.execPath, [join(root, 'build.mjs')]);
  const html = readFileSync(out, 'utf8');
  assert.doesNotMatch(html, /https?:\/\/|<script src=/);
  assert.ok(statSync(out).size < 1024 * 1024);
  assert.ok(!html.includes('<!-- BUILD:SCRIPT -->'));
  const script = html.match(/<script>\n([\s\S]*)\n<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});

test('构建脚本：顶层重名报错、函数内同名不误报、不支持的 export 写法报错（评审 Minor 4）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sgparser-build-'));
  const files = ['decode.js', 'di_dict.js', 'dict.js', 'frame.js', 'unit.js', 'parser.js', 'ui.js'];
  mkdirSync(join(dir, 'src'));
  copyFileSync(join(root, 'build.mjs'), join(dir, 'build.mjs'));
  writeFileSync(join(dir, 'src', 'index.html'), '<!-- BUILD:SCRIPT -->');
  const build = (contents) => {
    files.forEach((f, i) => writeFileSync(join(dir, 'src', f), contents[f] ?? `const v${i} = ${i};\n`));
    return spawnSync(process.execPath, [join(dir, 'build.mjs')], { encoding: 'utf8' });
  };
  try {
    const nested = build({ 'dict.js': 'function a() {\n  const helper = 1;\n  return helper;\n}\n', 'unit.js': 'function b() {\n  const helper = 2;\n  return helper;\n}\n' });
    assert.equal(nested.status, 0, nested.stderr);
    const dup = build({ 'dict.js': 'function helper() {}\n', 'unit.js': 'function helper() {}\n' });
    assert.notEqual(dup.status, 0);
    assert.match(dup.stderr, /顶层名称重复：helper（dict\.js 与 unit\.js）/);
    const bad = build({ 'ui.js': 'export default 1;\n' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /构建不支持的 import\/export 写法/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
