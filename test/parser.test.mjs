import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { NEED_PRIVATE, SHOT, buildFrame, findNode, loadCases, loadCorpus } from './helpers.mjs';

const A = '99999901000000';
const anyError = (n) => Boolean(n && (n.error || (n.children || []).some(anyError)));

test('摘要行（R2.6）', () => {
  assert.equal(parse(SHOT).summary, '解析成功！主站请求：终端地址[999999000001]，主站地址[0]，帧序号[4]，单帧，写参数');
});
test('空输入：清空结果，不报错（R1.4）', () => {
  const r = parse('  \n');
  assert.deepEqual([r.ok, r.summary, r.tree, r.errors], [true, '', [], []]);
});
test('清洗错误进摘要（R1.3）', () => assert.equal(parse('68 2G').summary, '解析有误：第 5 个字符「G」不是十六进制字符'));
test('坏帧样例（fixtures/bad.json，R6）', () => {
  for (const c of loadCases('bad.json')) {
    const r = parse(c.text ?? c.hex);
    for (const p of c.errorPaths || []) {
      const target = p.endsWith('/*') ? findNode(r.tree, p.slice(0, -2)) : findNode(r.tree, p);
      assert.ok(anyError(target), `${c.name}：${p} 应标红`);
    }
    if (c.errorPaths || c.summaryIncludes) {
      assert.equal(r.ok, false, c.name);
      assert.ok(r.summary.startsWith('解析有误'), `${c.name}：${r.summary}`);
    }
    if (c.summaryIncludes) assert.ok(r.summary.includes(c.summaryIncludes), `${c.name}：${r.summary}`);
    assert.ok(Array.isArray(r.tree), c.name);
  }
});
test('PW 按长度推断：告警帧，PW 在 Tp 之前（R5.3）', { skip: NEED_PRIVATE }, () => {
  const r = parse(loadCorpus().find(({ hex }) => hex.includes('0000150000E2')).hex);
  assert.deepEqual(r.tree.map((n) => n.name).slice(-5), ['信息体1', '消息验证码PW', '时间标签Tp', '校验码CS', '结束符16H']);
  assert.equal(findNode(r.tree, '消息验证码PW').note, '规约未要求，按长度推断');
});
test('剩 16 字节但能拆成已知信息体：不推断 PW（Review Focus 1）', () => {
  const r = parse(buildFrame('88' + A + '0C60' + '0102030500041000'.repeat(3)));
  assert.equal(r.ok, true);
  assert.equal(findNode(r.tree, '消息验证码PW'), null);
  assert.ok(findNode(r.tree, '信息体3'));
});
test('随机字节不崩溃（R6.3）', () => {
  let seed = 20260924;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 1000; i++) {
    const len = Math.floor(rnd() * 80);
    const b = Array.from({ length: len }, () => Math.floor(rnd() * 256));
    if (i % 2 && len >= 6) {
      b[0] = 0x68;
      b[5] = 0x68;
      b[1] = b[3] = Math.max(0, len - 8);
      b[2] = b[4] = 0;
    }
    const r = parse(b.map((x) => x.toString(16).padStart(2, '0')).join(''));
    assert.ok(Array.isArray(r.tree) && Array.isArray(r.errors));
  }
});
test('分区：每个节点都带 section', () => {
  const r = parse(SHOT);
  const allowed = new Set(['head', 'ctrl', 'addr', 'app', 'unit', 'aux', 'tail']);
  const walk = (ns) => ns.forEach((n) => { assert.ok(allowed.has(n.section), n.name); walk(n.children || []); });
  walk(r.tree);
  assert.equal(findNode(r.tree, '信息体1').section, 'unit');
  assert.equal(findNode(r.tree, '消息验证码PW').section, 'aux');
});
test('长报文：626 字节的真实抄表应答解析 < 50ms（Review Focus 4）', { skip: NEED_PRIVATE }, () => {
  const big = loadCorpus().find(({ hex }) => hex.startsWith('687202')).hex;
  parse(big);
  const t0 = performance.now();
  const r = parse(big);
  assert.ok(performance.now() - t0 < 50);
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('现网验证：继电器变位告警的状态字按十六进制显示（0x0050 = 拉闸后 bit4、bit6 置 1）', () => {
  const r = parse(buildFrame('C4' + A + '1370' + '0102' + '3B0000E2' + '01' + '250113240926' + '5000'));
  const sw = findNode(r.tree, '信息体1/[E200003B]*/发生时数据/电表运行状态字 3');
  assert.equal(sw.value, '0050');
  assert.equal(sw.desc, '电表运行状态字 3：0050');
  assert.equal(findNode([sw], '电表运行状态字 3/D4 继电器状态').desc, '1：断');
  assert.equal(sw.children.find((c) => c.name.startsWith('D6 ')).desc, '1：断'); // 名称含「DL/T645」里的 /，不能走 findNode 路径
});
test('现网验证：测量点端口号 00~1E 为 485 端口 1~31，不再标「规约未定义取值」', () => {
  const para = '01' + '01' + '254800301166' + '01' + '01' + '00' + '00' + '01' + '04' + '000000000000' + '00' + '08' + '01' + '08' + '00' + '0100' + '0100';
  const r = parse(buildFrame('4A' + A + '0461' + '0101' + '0F0080E0' + para + '00'.repeat(16)));
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(findNode(r.tree, '信息体1/[E080000F]*/测量点端口号').desc, '测量点端口号：00（485 端口 1）');
  const r2 = parse(buildFrame('4A' + A + '0461' + '0101' + '0F0080E0' + para.replace(/^(.{40})00/, '$11E') + '00'.repeat(16)));
  assert.equal(findNode(r2.tree, '信息体1/[E080000F]*/测量点端口号').desc, '测量点端口号：1E（485 端口 31）');
});
