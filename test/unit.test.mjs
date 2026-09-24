import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame } from '../src/frame.js';
import { parseUnits } from '../src/unit.js';
import { NEED_PRIVATE, SHOT, buildFrame, hexToBytes, findNode, loadCorpus } from './helpers.mjs';

const A = '99999901000000';
const units = (hex) => {
  const b = hexToBytes(hex);
  const fi = parseFrame(b);
  return { fi, ...parseUnits(b, fi) };
};
const corpus = () => loadCorpus().map((r) => r.hex);

test('DA：规约 Pn 与代码点号（R3.2）', () => {
  const da = findNode(units(SHOT).nodes, '信息体1/信息点标识DA');
  assert.equal(da.value, 'p72');
  assert.equal(da.desc, 'Pn=72（代码点号 71）');
});
test('DA：多点、p0、全部测量点、非法', () => {
  const da = (x) => findNode(units(buildFrame('44' + A + '0C60' + x + '00000100')).nodes, '信息体1/信息点标识DA');
  assert.equal(da('0301').value, 'p1,p2');
  assert.equal(da('0000').desc, 'p0：终端');
  assert.equal(da('FFFF').desc, '除终端外的全部测量点');
  assert.ok(da('0100').error);
});
test('AFN=04 上行：ERR 查附录 F（R3.5）', () => {
  const { nodes } = units(buildFrame('88' + A + '0460' + '0102' + '001100E0' + '04'));
  assert.equal(findNode(nodes, '信息体1/错误码ERR').desc, '04：无此数据项');
});
test('读请求：未收录 DI 不影响切分', () => {
  const { nodes } = units(buildFrame('44' + A + '0C60' + '0000FFFFFFE0' + '0000150080E1'));
  assert.equal(nodes.length, 2);
  assert.equal(findNode(nodes, '信息体1/数据标识编码DI').desc, 'E0FFFFFF：未收录（规约未定义）');
  assert.equal(findNode(nodes, '信息体2/数据标识编码DI').value, 'E1800015');
});
test('内容型未收录 DI：后续无法切分（R3.8）', () => {
  const { nodes } = units(buildFrame('88' + A + '0C60' + '0000FFFFFFE0' + '1234'));
  assert.equal(findNode(nodes, '信息体1/数据标识内容').desc, '未收录 DI，后续无法切分');
});
test('规约外数据：真实登录帧多出 7 字节（R5.4）', () => {
  const { nodes } = units('681900190068C99999990900000002760000001000E02001011200172407249F16');
  assert.equal(findNode(nodes, '信息体1/规约外数据').length, 7);
  assert.equal(findNode(nodes, '信息体1/[E0001000]*').children[0].value, '0120');
});
test('AFN=0D 上行：内容+时间按启发式分组（R3.7）', () => {
  const { nodes } = units(buildFrame('88' + A + '0D60' + '0101' + '00000100' + '12000000' + '202409220000' + '34000000' + '202409230000'));
  const u = findNode(nodes, '信息体1');
  assert.deepEqual(u.children.map((c) => (c.name.startsWith('[') ? '内容' : c.name)), ['信息点标识DA', '数据标识编码DI', '内容', '数据时间', '内容', '数据时间']);
  assert.equal(u.children[3].value, '2024-09-22 00:00');
  assert.match(u.children[4].note, /按启发式切分/);
});
test('AFN=12 上行：变长任务数据整体显示原始数据，不报错', { skip: NEED_PRIVATE }, () => {
  const { nodes } = units(corpus().find((h) => h.startsWith('688100810068C4')));
  const n = findNode(nodes, '信息体1/数据内容与数据时间');
  assert.match(n.desc, /变长/);
  assert.equal(n.error, undefined);
});
test('确认帧：结果值非法时停止，并标出后续数据', () => {
  const { nodes } = units(buildFrame('88' + A + '0060' + '0000000000E0' + '05' + 'AABBCC'));
  assert.match(findNode(nodes, '信息体1/确认否认').error, /非法/);
  assert.ok(findNode(nodes, '后续数据'));
});
test('剩 16 字节但能拆成已知信息体：继续拆（Review Focus 1）', () => {
  const { nodes, rest } = units(buildFrame('88' + A + '0C60' + '0102030500041000'.repeat(3)));
  assert.equal(nodes.length, 3);
  assert.equal(rest.length, 0);
});
test('剩 16 字节且拆不成已知信息体：留给 PW 推断（真实告警帧、真实读请求帧）', { skip: NEED_PRIVATE }, () => {
  for (const hex of [corpus().find((h) => h.includes('0000150000E2')), corpus().find((h) => h.startsWith('6882018201685B'))]) {
    assert.equal(units(hex).rest.length, 16);
  }
});
