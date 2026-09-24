import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeField } from '../src/decode.js';
import { hexToBytes } from './helpers.mjs';

const dec = (hex, field, end) => decodeField(hexToBytes(hex), 0, { name: '字段', ...field }, end);

test('BCD：低字节在前，带小数位与单位', () => {
  assert.equal(dec('12000000', { bytes: 4, enc: 'bcd', dec: 2 }).value, '0.12');
  assert.equal(dec('73050000', { bytes: 4, enc: 'bcd', dec: 2, unit: 'kWh' }).desc, '字段：5.73 kWh');
});
test('BCD：地址类不去前导零', () => assert.equal(dec('010000000000', { bytes: 6, enc: 'bcd' }).value, '000000000001'));
test('BCD：最高位为符号位', () => assert.equal(dec('291080', { bytes: 3, enc: 'bcd', dec: 4, sign: 'msb' }).value, '-0.1029'));
test('BCD：非法数字报错', () => assert.match(dec('1A', { bytes: 1, enc: 'bcd' }).error, /非法 BCD/));
test('HEX：低字节在前显示（密码、操作者代码）', () => {
  assert.equal(dec('03000000', { bytes: 4, enc: 'hex' }).value, '00000003');
  assert.equal(dec('78563412', { bytes: 4, enc: 'hex' }).value, '12345678');
});
test('BIN 与位定义', () => {
  const nd = dec('1000', { bytes: 2, enc: 'bin', bits: [
    { bit: '4', name: '继电器状态', values: { 0: '通', 1: '断' } },
    { bit: '2-1', name: '供电方式', values: { '00': '主电源', '01': '辅助电源', '10': '电池供电' } },
  ] });
  assert.equal(nd.value, '0010'); // 带位定义的 BIN 按十六进制显示，避免 0x0050 被显示成「80」而误读
  assert.equal(nd.children[0].name, 'D4 继电器状态');
  assert.equal(nd.children[0].desc, '1：断');
  assert.equal(nd.children[1].desc, '00：主电源');
});
test('时间：数据内容里的时间低字节在前', () => assert.equal(dec('094217130824', { bytes: 6, enc: 'time', fmt: 'YYMMDDhhmmss' }).value, '2024-08-13 17:42:09'));
test('时间：时间域高位在前（6 字节与 5 字节）', () => {
  assert.equal(dec('202407111045', { bytes: 6, enc: 'time', fmt: 'YYYYMMDDhhmm', order: 'be' }).value, '2024-07-11 10:45');
  assert.equal(dec('2407111045', { bytes: 5, enc: 'time', fmt: 'YYMMDDhhmm', order: 'be' }).value, '2024-07-11 10:45');
});
test('时间：Tp 日时分秒、版本日期', () => {
  assert.equal(dec('08021724', { bytes: 4, enc: 'time', fmt: 'DDhhmmss' }).value, '24日 17:02:08');
  assert.equal(dec('190723', { bytes: 3, enc: 'time', fmt: 'YYMMDD' }).value, '2023-07-19');
});
test('ASCII：高字节在前，去掉末尾 00', () => assert.equal(dec('4E616E5700', { bytes: 5, enc: 'ascii' }).value, 'NanW'));
test('IP：8 字节通信地址', () => assert.equal(dec('FC1F0A0200C00000', { bytes: 8, enc: 'ip' }).value, '192.0.2.10:8188'));
test('枚举：命中与未定义取值', () => {
  assert.equal(dec('04', { bytes: 1, enc: 'hex', enum: { '04': '集中器' } }).desc, '字段：04（集中器）');
  assert.equal(dec('F100', { bytes: 2, enc: 'hex', enum: { '0001': '普通文件' } }).desc, '字段：00F1（规约未定义取值）');
});
test('全 FF 视为无效，不算错误（Review Focus 5）', () => {
  const nd = dec('FFFFFFFF', { bytes: 4, enc: 'bcd', dec: 2 });
  assert.equal(nd.error, undefined);
  assert.equal(nd.desc, '字段：无效（全 FF）');
});
test('字节不足', () => assert.equal(dec('1200', { bytes: 4, enc: 'bcd' }).error, '数据不足，期望 4 字节，实际 2 字节'));
test('结构：var 字段扣掉其后的固定字段', () => {
  const nd = dec('0000030041424312AB', { enc: 'struct', fields: [
    { name: '段号', bytes: 2, enc: 'bin' }, { name: '段长', bytes: 2, enc: 'bin' },
    { name: '内容', bytes: 'var', enc: 'hex', order: 'be' }, { name: '校验', bytes: 2, enc: 'hex' },
  ] });
  assert.deepEqual(nd.children.map((c) => c.value), ['0', '3', '414243', 'AB12']);
  assert.equal(nd.length, 9);
});
test('结构：repeat 按个数字段展开', () => {
  const nd = dec('02' + '12000000' + '34000000' + '56000000', { enc: 'struct', fields: [
    { name: '费率数', bytes: 1, enc: 'bcd' },
    { name: '电能', enc: 'repeat', repeat: { count: '费率数', plus: 1, item: { bytes: 4, enc: 'bcd', dec: 2, unit: 'kWh' }, label: ['总', '费率{i}'] } },
  ] });
  assert.deepEqual(nd.children[1].children.map((c) => `${c.name}=${c.value}`), ['总=0.12', '费率1=0.34', '费率2=0.56']);
});
test('结构：子字段不足时在子字段上报错', () => {
  const nd = dec('0102', { enc: 'struct', fields: [{ name: 'a', bytes: 1, enc: 'hex' }, { name: 'b', bytes: 2, enc: 'hex' }] });
  assert.equal(nd.children[1].error, '数据不足，期望 2 字节，实际 1 字节');
});
test('HEX 字段全 FF 不判无效：DA、控制字节等场景下 FF 本身有含义（评审 Minor 2）', () => {
  const nd = dec('FFFF', { bytes: 2, enc: 'hex' });
  assert.equal(nd.value, 'FFFF');
  assert.equal(nd.desc, '字段：FFFF');
});
