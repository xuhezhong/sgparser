import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { NEED_PRIVATE, findNode, hexToBytes, loadCorpus } from './helpers.mjs';

// 真实语料中允许出现的未收录 DI；出现新的必须先查清原因，再决定补字典还是加白名单
const UNKNOWN_DI_WHITELIST = ['13200400', '00132000']; // 均来自下面 C=88 AFN=00 异常帧的错位内容
// 设备侧异常帧：内容本身不合规约，工具标红是正确行为；逐条固定帧头前缀与期望的首个错误位置
const KNOWN_ABNORMAL = {
  '68E300E30068C4': '时间标签Tp/启动帧发送时标', // E2000009 告警：ARD2 后混入抄表应答残留，TpV=1 但帧尾 5 字节不是合法 Tp
  '68C500C50068C4': '时间标签Tp/启动帧发送时标', // E2000015 告警：同上
  '684A014A016888': '信息体4/确认否认', // AFN=00 却携带抄表应答内容
};

function walk(nodes, fn) {
  for (const n of nodes) {
    fn(n);
    if (n.children) walk(n.children, fn);
  }
}

test('真实语料整批回归（R10.3）', { skip: NEED_PRIVATE }, () => {
  const s = { total: 0, failed: [], abnormal: 0, csErrors: 0, alarms: 0, alarmsTp: 0, alarmsOk: 0, unknown: new Map() };
  for (const { hex } of loadCorpus()) {
    s.total++;
    const r = parse(hex);
    const expected = KNOWN_ABNORMAL[hex.slice(0, 14)];
    if (expected) {
      s.abnormal++;
      assert.equal(r.ok, false, hex.slice(0, 14));
      assert.ok(r.errors[0].startsWith(`${expected}：`), `${hex.slice(0, 14)}：${r.errors[0]}`);
    } else if (!r.ok) s.failed.push(`${hex.slice(0, 48)}… ${r.errors[0]}`);
    if (findNode(r.tree, '校验码CS')?.error) s.csErrors++;
    walk(r.tree, (n) => {
      if (n.name === '数据标识编码DI' && n.desc.includes('未收录')) s.unknown.set(n.value, (s.unknown.get(n.value) || 0) + 1);
    });
    const b = hexToBytes(hex);
    if (b[14] === 0x13 && b[6] >> 7 === 1) {
      s.alarms++;
      const hasTp = b[15] >> 7 === 1;
      if (hasTp) s.alarmsTp++;
      const auxOk = !hasTp || Boolean(findNode(r.tree, '消息验证码PW') && findNode(r.tree, '时间标签Tp'));
      if (r.ok && findNode(r.tree, '信息体1/[E2*') && auxOk) s.alarmsOk++;
    }
  }
  console.log('回归统计', { 总数: s.total, 有错误: s.failed.length, 已知异常帧: s.abnormal, CS错误: s.csErrors, 告警: s.alarms, 带Tp告警: s.alarmsTp, 告警正确: s.alarmsOk, 未收录DI: Object.fromEntries(s.unknown) });
  assert.equal(s.total, 623);
  assert.equal(s.abnormal, Object.keys(KNOWN_ABNORMAL).length);
  assert.equal(s.csErrors, 0);
  assert.deepEqual(s.failed, []);
  assert.equal(s.alarmsTp, 540);
  assert.equal(s.alarmsOk, s.alarms - 2); // 两条已知异常告警帧按预期标红，其余全部正确
  assert.deepEqual([...s.unknown.keys()].filter((k) => !UNKNOWN_DI_WHITELIST.includes(k)), []);
});
