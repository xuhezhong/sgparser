import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { lookupDI, ERR_CODES } from '../src/dict.js';
import { here } from './helpers.mjs';

const DICT_FILE = join(here, '..', 'src', 'di_dict.js');
// 探针阶段对照 PDF 页面图片逐条核对过的 32 条（specs/南网报文解析GUI/probe/sample.py）；null 表示变长
const SAMPLES = [
  ['E0000369', '普通任务号[69]', null], ['E0000396', '普通任务号[96]', null], ['E0000458', '中继任务号[58]', null],
  ['E0000A0F', '485 端口定义[0F]', 5], ['E0000C19', '输入开关状态[19]', 1], ['00012700', '(当前)正向有功费率 39 电能', 4],
  ['00012E00', '(当前)正向有功费率 46 电能', 4], ['00072300', '(当前) 第三象限无功费率35 电能', 4],
  ['01010A00', '(当前)正向有功费率 10 最大需量及发生时间', 8], ['01041200', '(当前)组合无功 2 费率 18 最大需量及发生时间', 8],
  ['E1000013', '(本日) C 相电压合格率统计数据', 27], ['0506071B', '日冻结第三象限无功费率 27 电能', 4],
  ['05060A0E', '日冻结反向有功费率 14 最大需量及发生时间', 8], ['05060A26', '日冻结反向有功费率 38 最大需量及发生时间', 8],
  ['E1009211', 'C 相电压 17 次谐波含量平均值', 2], ['00041701', '月冻结组合无功 2 费率 23 电能', 4],
  ['01400001', '月冻结 C 相组合无功 2 最大需量及发生时间', 8], ['E100C603', 'C 相电流 3 次谐波含量最大值', 2],
  ['E100C604', 'C 相电流 4 次谐波含量最大值', 2], ['06100601', '正向有功总电能', 4],
  ['E000010B', '0：非压缩 1：压缩，BIN 编码', 1], ['E0010173', '终端公钥注册响应信息', 80],
  ['E0000701', '运算量编号（01~FDH）[01]', 30], ['E0000C30', '输出开关轮次[30]', 1], ['E0800004', '电能表类型', 1],
  ['E080020B', '电压长闪限值', 2], ['00900200', '（当前）剩余金额', 4], ['E1004017', '(本月)零序电流极值统计数据', 14],
  ['E1009000', '日 A 相电压总谐波含有量平均值', 2], ['E2000009', 'C相TA二次侧短路', 91],
  ['E200004D', '表端钮盒开启告警', 58], ['E2010011', '表端钮盒开启记录', 28],
];

test('字典：32 条抽查与规约原文一致（R4.1）', () => {
  for (const [di, name, bytes] of SAMPLES) {
    const d = lookupDI(di);
    assert.ok(d, di);
    assert.equal(d.name, name, di);
    assert.equal(d.bytes, bytes === null ? 'var' : bytes, di);
  }
});
test('字典：集合与数据块', () => {
  assert.equal(lookupDI('E080000F').bytes, 29);
  assert.deepEqual(lookupDI('0201FF00').fields.map((f) => f.name), ['A 相电压', 'B 相电压', 'C 相电压', 'AB 线电压', 'BC 线电压', 'CA 线电压', 'A/AB 相基波电压', 'B 相基波电压', 'C/CA 相基波电压']);
  assert.equal(lookupDI('0001FF00').fields[1].enc, 'repeat');
});
test('字典：区间模板与告警结构', () => {
  assert.equal(lookupDI('00010400').name, '(当前)正向有功费率 4 电能');
  const alarm = lookupDI('E2000015');
  assert.equal(alarm.bytes, 91);
  assert.deepEqual(alarm.fields.map((f) => f.name), ['告警状态', '告警发生时间', '发生时数据']);
});
test('字典：未知 DI、大小写、错误码', () => {
  assert.equal(lookupDI('ABCDEF01'), null);
  assert.equal(lookupDI('e1800015').di, 'E1800015');
  assert.equal(ERR_CODES['04'], '无此数据项');
});
test('字典文件：首行哨兵、体积不超过 600KB（R9.1）', () => {
  assert.ok(readFileSync(DICT_FILE, 'utf8').startsWith('// 自动生成，勿手改'));
  assert.ok(statSync(DICT_FILE).size <= 600 * 1024);
});

// requirements R4.2 精校清单、R4.3 平台 DI
const PRECISE = ['E0000000', 'E0001000', 'E0001001', 'E0001002', 'E0000140', 'E0000100', 'E0000101', 'E0000102', 'E0000B01',
  'E0001100', 'E0001101', 'E080000F', 'E0800000', 'E0800001', 'E0800002', 'E0800003', 'E0800004', 'E0800005', 'E0800006',
  'E0800007', 'E0800008', 'E0800009', 'E080000A', 'E080000B', 'E080000C', 'E080000D', 'E1800015', '00010000', '00020000',
  '00010400', '00013F00', '00020100', '05060100', '05060200', '05060101', '0506023F', '04000503', 'E3010001', 'E3010002',
  'E2000009', 'E200000B', 'E200000E', 'E2000013', 'E2000014', 'E2000015', 'E200002E', 'E2000030', 'E200003B', 'E200003C'];
const PLATFORM = ['10010000', '10000390', 'F0001100', 'F0001101', 'F200003B', '11010000'];

test('精校清单（R4.2）与平台 DI（R4.3）', () => {
  for (const di of PRECISE) assert.equal(lookupDI(di)?.tier, '精校', di);
  for (const di of PLATFORM) {
    assert.equal(lookupDI(di)?.tier, '平台', di);
    assert.match(lookupDI(di).src, /^平台代码/, di);
  }
  assert.equal(lookupDI('E080000F').fields.length, 17);
  assert.equal(lookupDI('0506023F').name, '日冻结反向有功费率 63 电能');
});
