import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHex, parseFrame } from '../src/frame.js';
import { SHOT, buildFrame, hexToBytes, findNode } from './helpers.mjs';

const fr = (hex) => parseFrame(hexToBytes(hex));
const A = '99999901000000';
const G2 = '681100110068889999990200000004612005011100E000D116';

test('清洗：容忍空格、逗号、分号、换行、0x 与小写（R1.2）', () => {
  assert.deepEqual(Array.from(cleanHex('68 2f,00;0x2F\n00').bytes), [0x68, 0x2f, 0x00, 0x2f, 0x00]);
});
test('清洗：非法字符指出位置、奇数长度报错、空串返回空（R1.3、R1.4）', () => {
  assert.equal(cleanHex('68 2G').error, '第 5 个字符「G」不是十六进制字符');
  assert.equal(cleanHex('68 2').error, '十六进制字符数为 3，不是偶数');
  assert.equal(cleanHex('').bytes.length, 0);
});
test('清洗：整行日志粘贴时指出第一个非法字符（Review Focus 2）', () => {
  assert.equal(cleanHex('ConcentratorLink receive data : 6811').error, '第 2 个字符「o」不是十六进制字符');
});
test('帧层：截图帧逐段拆分（R2）', () => {
  const fi = fr(SHOT);
  assert.deepEqual(fi.nodes.map((n) => n.name), ['起始符68H', '长度L', '长度L', '起始符68H', '控制域C', '地址域A', '功能码AFN', '帧序列域SEQ', '校验码CS', '结束符16H']);
  assert.equal(fi.dir, 0);
  assert.equal(fi.prm, 1);
  assert.equal(fi.afn, 0x04);
  assert.equal(fi.cid, '999999000001');
  assert.equal(fi.a3, 0);
  assert.equal(fi.frameKind, '单帧');
  assert.equal(fi.afnName, '写参数');
  assert.equal(findNode(fi.nodes, '控制域C/D3~D0功能码').desc, '10：请求/响应：请求 1 级数据');
  assert.equal(findNode(fi.nodes, '地址域A/省地市区县码A1').desc, '省地市区县码：999999');
  assert.equal(findNode(fi.nodes, '帧序列域SEQ').desc, '单帧，帧内序号=4');
  assert.equal(findNode(fi.nodes, '校验码CS').desc, '校验码正确');
  assert.equal(fi.unitStart, 16);
  assert.equal(fi.unitEnd, 37);
  assert.equal(fi.pw.offset, 37);
  assert.equal(fi.pw.length, 16);
  assert.equal(fi.tp, undefined);
});
test('帧层：两个 L 不一致、CS 错误、结束符错误（R2.5、R6.1）', () => {
  assert.match(findNode(fr(SHOT.slice(0, 6) + '2E' + SHOT.slice(8)).nodes, '长度L#2').error, /不一致/);
  assert.equal(findNode(fr(SHOT.slice(0, -4) + '2116').nodes, '校验码CS').error, '校验码错误：报文 21，计算应为 20');
  assert.equal(findNode(fr(SHOT.slice(0, -2) + '17').nodes, '结束符16H').error, '应为 16，实际 17');
});
test('帧层：报文不完整时不定位 PW，信息体区到末尾（R6.2）', () => {
  const fi = fr(SHOT.slice(0, 60));
  assert.match(findNode(fi.nodes, '长度L').error, /报文不完整/);
  assert.equal(fi.unitEnd, 30);
  assert.equal(fi.pw, undefined);
});
test('帧层：帧头都不完整时 fatal', () => {
  const fi = fr('681100');
  assert.equal(fi.fatal, true);
  assert.match(fi.nodes[fi.nodes.length - 1].error, /数据不足/);
});
test('帧层：两帧首尾相连时，第二帧整体标为多余数据（Review Focus 3）', () => {
  const x = findNode(fr(G2 + G2).nodes, '多余数据');
  assert.equal(x.error, '帧结束后多出 25 字节');
  assert.equal(x.offset, 25);
});
test('附加信息：复位帧带 PW 和 Tp（R5.1、R5.2）', () => {
  const fi = fr(buildFrame('41' + A + '04F1' + '0000400100E0' + '02' + '00'.repeat(16) + '0942171305'));
  assert.equal(findNode([fi.tp], '时间标签Tp/启动帧发送时标').value, '13日 17:42:09');
  assert.equal(findNode([fi.tp], '时间标签Tp/允许发送传输延时').desc, '允许发送传输延时：5 分钟');
  assert.equal(fi.pw.offset + 16, fi.tp.offset);
  assert.equal(fi.unitEnd, fi.pw.offset);
});
test('控制域：上行 ACD 与备用功能码', () => {
  assert.equal(findNode(fr(buildFrame('A8' + A + '0C60')).nodes, '控制域C/D5要求访问位ACD').value, '1');
  assert.match(findNode(fr(buildFrame('42' + A + '0C60')).nodes, '控制域C/D3~D0功能码').error, /备用/);
});
test('地址域：广播地址', () => {
  assert.match(findNode(fr(buildFrame('4A' + '999999FFFFFF00' + '0C60')).nodes, '地址域A/终端地址A2').desc, /系统广播地址/);
});
