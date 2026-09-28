import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '../src/parser.js';
import { overviewOf } from '../src/overview.js';
import { SHOT, buildFrame, findNode, here } from './helpers.mjs';

const fi = { dir: 1, prm: 0, afn: 4, afnName: '写参数' };
const node = (name, value, error) => ({ name, value, ...(error ? { error } : {}) });
const unit = (di = 'E0001100', da = 'p9', result) => ({ name: '信息体1', di, children: [node('信息点标识DA', da), ...(result ? [result] : [])] });
const err = (value, error) => node('错误码ERR', value, error);
const ack = (value, error) => node('确认否认', value, error);
const frame = (afn, body = '', ctrl = '88') => buildFrame(ctrl + '99999901000000' + afn + '60' + body);

const results = [
  ['成功', [err('00')], '成功'],
  ['全部成功', [err('00'), err('00')], '成功'],
  ['失败', [err('03')], '失败：03 密码权限不足'],
  ['未知错误码', [err('FF')], '失败：FF 规约未定义错误码'],
  ['部分失败', [err('00'), err('02')], '失败 1/2 项：02 设置内容非法'],
  ['全失败', [err('03'), err('02')], '失败 2/2 项：03 密码权限不足'],
  ['缺失与成功', [err('00'), null], '结果不完整 1 项'],
  ['缺失与失败', [err('03'), null], '失败 1/2 项：03 密码权限不足，结果不完整 1 项'],
  ['截断', [err('', '数据不足')], '结果不完整 1 项'],
  ['带错零值', [err('00', '数据不足')], '结果不完整 1 项'],
];
for (const [name, codes, want] of results) test(`概览 ERR：${name}`, () => {
  assert.equal(overviewOf(fi, codes.map(c => unit(undefined, undefined, c))), `终端应答：对电能表遥控拉闸（测量点 9），${want}`);
});
const confirmations = [
  ['全部确认', [ack('00'), ack('00')], '确认'],
  ['全部否认', [ack('01'), ack('01')], '否认'],
  ['混合', [ack('00'), ack('01')], '确认/否认，否认 1 项'],
  ['非法', [ack('02')], '确认/否认，取值异常 1 项'],
  ['缺失', [null], '确认/否认，取值异常 1 项'],
  ['错误零值', [ack('00', '数据不足')], '确认/否认，取值异常 1 项'],
  ['否认和异常', [ack('01'), ack('02'), null], '确认/否认，否认 1 项，取值异常 2 项'],
];
for (const [name, flags, want] of confirmations) test(`概览 AFN00：${name}`, () => {
  assert.equal(overviewOf({ ...fi, dir: 0, afn: 0 }, flags.map(c => unit('E0000000', 'p9', c))), `主站${want}`);
});
test('AFN00 整帧确认不贡献数据项或对象，其他项正常保留', () => {
  assert.equal(overviewOf({ ...fi, afn: 0 }, [unit('E0000000', 'pALL', ack('00')), unit('E0001100', 'p9', ack('01'))]), '终端确认/否认：对电能表遥控拉闸（测量点 9），否认 1 项');
});
test('名称和对象顺序去重及超过三项截断', () => {
  const units = ['E0001100', 'E0001101', 'E0000140', 'E0000B01', 'E0001100'].map((di, i) => unit(di, `p${i + 9},p9`));
  assert.equal(overviewOf(fi, units), '终端应答：对电能表遥控拉闸、对电能表遥控合闸、终端复位等 4 项（测量点 9、10、11 等 5 个）');
});
test('终端、全部测量点、多点与非法 DA', () => {
  assert.equal(overviewOf(fi, ['p0', 'pALL', 'p9,p10', '非法', 'p0'].map(da => unit(undefined, da))), '终端应答：对电能表遥控拉闸（终端、全部测量点、测量点 9、10）');
  assert.equal(overviewOf(fi, [unit(undefined, '非法')]), '终端应答：对电能表遥控拉闸');
});
test('未知 DI 和集合名称', () => {
  assert.equal(overviewOf(fi, [unit('FFFFFFFF')]), '终端应答：DI FFFFFFFF（未收录）（测量点 9）');
  assert.equal(overviewOf(fi, [unit('E000010F')]), '终端应答：主站通信地址等数据项（集合）（测量点 9）');
});
for (const [di, name] of [['E0001000', '终端登录'], ['E0001001', '终端心跳'], ['E0001002', '终端退出登录']]) test(`链路专门用语：${name}`, () => {
  assert.equal(overviewOf({ ...fi, afn: 2 }, [unit(di)]), name);
  assert.equal(overviewOf({ ...fi, afn: 2, dir: 0 }, [unit(di)]), `主站链路接口检测：${name}（测量点 9）`);
});
test('测量点参数专门用语', () => assert.equal(overviewOf(fi, [unit('E080000F')]), '终端应答：测量点参数（测量点 9）'));
const actions = [
  [4, '下发', '应答', '应答'], [6, '安全认证', '返回安全认证', '请求安全认证'],
  [10, '读取参数', '返回参数', '返回参数'], [12, '抄读当前数据', '返回当前数据', '返回当前数据'],
  [13, '抄读历史数据', '返回历史数据', '返回历史数据'], [14, '读取事件记录', '返回事件记录', '上报事件记录'],
  [15, '文件传输', '返回文件传输', '返回文件传输'], [16, '中继转发', '返回中继结果', '返回中继结果'],
  [18, '读取任务数据', '返回任务数据', '上报任务数据'], [19, '读取告警', '返回告警', '上报告警'],
  [21, '下发自定义数据', '返回自定义数据', '上报自定义数据'], [32, '返回请求的数据', '请求主站数据', '请求主站数据'],
];
for (const [afn, down, up, active] of actions) test(`动作表 AFN=${afn.toString(16)} 与空信息体`, () => {
  for (const [dir, prm, action] of [[0, 1, down], [1, 0, up], [1, 1, active]]) assert.equal(overviewOf({ ...fi, dir, prm, afn }, []), `${dir ? '终端' : '主站'}${action}`);
});
test('空 AFN00、空链路、未知 AFN 和非信息体节点', () => {
  assert.equal(overviewOf({ ...fi, afn: 0 }, []), '终端确认/否认');
  assert.equal(overviewOf({ ...fi, afn: 2 }, []), '');
  assert.equal(overviewOf({ ...fi, afn: 255, afnName: '未知功能' }, []), '终端未知功能');
  assert.equal(overviewOf(fi, [{ ...unit(), name: '后续数据' }]), '终端应答');
});
test('ERR 上行覆盖动作，下行保留动作', () => {
  const units = [unit(undefined, undefined, err('00'))];
  assert.equal(overviewOf({ ...fi, afn: 15 }, units), '终端应答：对电能表遥控拉闸（测量点 9），成功');
  assert.equal(overviewOf({ ...fi, afn: 15, dir: 0 }, units), '主站文件传输：对电能表遥控拉闸（测量点 9），成功');
});
test('解析接入：拉闸、合闸、ERR 截断、完整和截断 DI', () => {
  assert.equal(parse(SHOT).overview, '主站下发：对电能表遥控拉闸（测量点 72）');
  assert.equal(parse(frame('04', '0102011100E000')).overview, '终端应答：对电能表遥控合闸（测量点 9），成功');
  const short = parse(frame('04', '0102001100E0'));
  assert.equal(short.overview, '终端应答：对电能表遥控拉闸（测量点 9），结果不完整 1 项');
  assert.equal(findNode(short.tree, '信息体1').di, 'E0001100');
  assert.equal(Object.hasOwn(findNode(parse(frame('04', '010200')).tree, '信息体1'), 'di'), false);
  assert.equal(parse(frame('02', '0000021000E0', 'C9')).overview, '终端退出登录');
  assert.equal(parse(frame('00', '0000000000E0000000000000E001', '08')).overview, '主站确认/否认，否认 1 项');
});
test('空输入、坏输入、致命帧、内部解析错误无概览', () => {
  for (const text of ['', '  ', 'GG', '68', { toString() { throw new Error('测试异常'); } }]) assert.equal(parse(text).overview, '');
  assert.equal(overviewOf({ ...fi, fatal: true }, [unit()]), '');
});
test('概览异常隔离：临时模块副本抛错，解析其他字段完全不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sgparser-overview-'));
  const brokenDir = mkdtempSync(join(tmpdir(), 'sgparser-broken-'));
  try {
    cpSync(join(here, '..', 'src'), dir, { recursive: true });
    writeFileSync(join(dir, 'overview.js'), "export function overviewOf() { throw new Error('概览测试异常'); }\n");
    const isolated = await import(pathToFileURL(join(dir, 'parser.js')).href);
    const normal = parse(SHOT);
    assert.deepEqual(isolated.parse(SHOT), { ...normal, overview: '' });
    // 单独覆盖解析入口自身的内部错误路径。
    writeFileSync(join(dir, 'frame.js'), readFileSync(join(dir, 'frame.js'), 'utf8').replace('export function cleanHex(text) {', "export function cleanHex(text) { throw new Error('解析测试异常');"));
    cpSync(dir, brokenDir, { recursive: true });
    const broken = await import(pathToFileURL(join(brokenDir, 'parser.js')).href);
    assert.equal(broken.parse(SHOT).overview, '');
    assert.equal(broken.parse(SHOT).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(brokenDir, { recursive: true, force: true });
  }
});

// 这些用例经过真实帧拆解，防止只有伪造节点测试通过。
test('真实帧：ERR 失败、部分失败、失败与缺失并存', () => {
  const cases = [
    ['0102001100E003', '失败：03 密码权限不足'],
    ['0102001100E0FF', '失败：FF 规约未定义错误码'],
    ['0102001100E0000102001100E002', '失败 1/2 项：02 设置内容非法'],
    ['0102001100E0030102001100E0', '失败 1/2 项：03 密码权限不足，结果不完整 1 项'],
    ['0102001100E0000102001100E0', '结果不完整 1 项'],
  ];
  for (const [body, want] of cases) assert.equal(parse(frame('04', body)).overview, `终端应答：对电能表遥控拉闸（测量点 9），${want}`);
});
test('真实帧：AFN00 否认、异常、混合及缺失', () => {
  const cases = [
    ['0000000000E001', '否认'],
    ['0000000000E002', '确认/否认，取值异常 1 项'],
    ['0000000000E0000000000000E0010000000000E002', '确认/否认，否认 1 项，取值异常 1 项'],
    ['0000000000E0010000000000E0', '确认/否认，否认 1 项，取值异常 1 项'],
  ];
  for (const [body, want] of cases) assert.equal(parse(frame('00', body, '08')).overview, `主站${want}`);
});
test('真实帧：多 DI 多测量点、集合、未知 DI、空信息体', () => {
  assert.equal(parse(frame('0A', '0F02001100E00102011100E00102400100E00102010B00E00102001100E0', '4A')).overview,
    '主站读取参数：对电能表遥控拉闸、对电能表遥控合闸、终端复位等 4 项（测量点 9、10、11 等 4 个）');
  assert.equal(parse(frame('0A', '00000F0100E0FFFF0F0100E0', '4A')).overview, '主站读取参数：主站通信地址等数据项（集合）（终端、全部测量点）');
  assert.equal(parse(frame('0A', '0102FFFFFFFF', '4A')).overview, '主站读取参数：DI FFFFFFFF（未收录）（测量点 9）');
  assert.equal(parse(frame('0A', '', '4A')).overview, '主站读取参数');
  assert.equal(parse(frame('00', '', '08')).overview, '主站确认/否认');
  assert.equal(parse(frame('02', '', 'C9')).overview, '');
});
