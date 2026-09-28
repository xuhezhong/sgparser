// 报文概览：只读取帧信息和解析树，不重新解析字节（design-v2.md §5.3）。
import { lookupDI, ERR_CODES } from './dict.js';

const ovActions = {
  0x04: ['下发', '应答', '应答'],
  0x06: ['安全认证', '返回安全认证', '请求安全认证'],
  0x0a: ['读取参数', '返回参数', '返回参数'],
  0x0c: ['抄读当前数据', '返回当前数据', '返回当前数据'],
  0x0d: ['抄读历史数据', '返回历史数据', '返回历史数据'],
  0x0e: ['读取事件记录', '返回事件记录', '上报事件记录'],
  0x0f: ['文件传输', '返回文件传输', '返回文件传输'],
  0x10: ['中继转发', '返回中继结果', '返回中继结果'],
  0x12: ['读取任务数据', '返回任务数据', '上报任务数据'],
  0x13: ['读取告警', '返回告警', '上报告警'],
  0x15: ['下发自定义数据', '返回自定义数据', '上报自定义数据'],
  0x20: ['返回请求的数据', '请求主站数据', '请求主站数据'],
};
const ovNames = { E0001000: '终端登录', E0001001: '终端心跳', E0001002: '终端退出登录', E080000F: '测量点参数' };

function ovChild(unit, name) {
  return (unit.children || []).find(n => n.name === name);
}

function ovName(di) {
  if (ovNames[di]) return ovNames[di];
  const def = lookupDI(di);
  if (!def) return `DI ${di}（未收录）`;
  if (/^以上数据(项)?集合$/.test(def.name)) {
    const first = lookupDI(di.slice(0, 7) + '0');
    if (first) return `${first.name}等数据项（集合）`;
  }
  return def.name;
}

function ovObjects(units) {
  const points = new Set();
  for (const unit of units) {
    const da = ovChild(unit, '信息点标识DA');
    if (!da || da.error) continue;
    for (const p of String(da.value).split(',')) {
      if (p === 'p0' || p === 'pALL' || /^p[1-9]\d*$/.test(p)) points.add(p);
    }
  }
  const numbers = [...points].filter(p => p !== 'p0' && p !== 'pALL').map(p => p.slice(1));
  const parts = [];
  let addedNumbers = false;
  for (const p of points) {
    if (p === 'p0') parts.push('终端');
    else if (p === 'pALL') parts.push('全部测量点');
    else if (!addedNumbers) {
      parts.push(`测量点 ${numbers.slice(0, 3).join('、')}${numbers.length > 3 ? ` 等 ${numbers.length} 个` : ''}`);
      addedNumbers = true;
    }
  }
  return parts.join('、');
}

export function overviewOf(fi, unitNodes) {
  if (fi.fatal) return '';
  const units = unitNodes.filter(n => n.name.startsWith('信息体'));
  const dataUnits = units.filter(n => n.di && !(fi.afn === 0 && n.di === 'E0000000'));
  const names = [...new Set(dataUnits.map(n => ovName(n.di)))];
  const data = names.slice(0, 3).join('、') + (names.length > 3 ? `等 ${names.length} 项` : '');
  if (fi.afn === 2 && fi.dir === 1) return data;
  const role = fi.dir === 0 ? '主站' : '终端';
  let action = fi.afn === 2 ? '链路接口检测' : (ovActions[fi.afn]?.[fi.dir === 0 ? 0 : fi.prm ? 2 : 1] ?? fi.afnName);
  const results = [];
  if (fi.afn === 0) {
    let yes = 0;
    let no = 0;
    let abnormal = 0;
    for (const unit of units) {
      const flag = ovChild(unit, '确认否认');
      if (!flag || flag.error || !['00', '01'].includes(flag.value)) abnormal++;
      else if (flag.value === '00') yes++;
      else no++;
    }
    action = units.length && yes === units.length ? '确认' : units.length && no === units.length ? '否认' : '确认/否认';
    if (action === '确认/否认' && no) results.push(`否认 ${no} 项`);
    if (abnormal) results.push(`取值异常 ${abnormal} 项`);
  }
  const codes = units.map(n => ovChild(n, '错误码ERR'));
  if (codes.some(Boolean)) {
    if (fi.dir === 1) action = '应答';
    const complete = n => n && !n.error && /^[0-9A-F]{2}$/.test(n.value);
    const missing = codes.filter(n => !complete(n)).length;
    const failed = codes.filter(n => complete(n) && n.value !== '00');
    if (!missing && !failed.length) results.push('成功');
    if (failed.length) {
      const code = failed[0].value;
      results.push(`${units.length === 1 ? '失败' : `失败 ${failed.length}/${units.length} 项`}：${code} ${ERR_CODES[code] ?? '规约未定义错误码'}`);
    }
    if (missing) results.push(`结果不完整 ${missing} 项`);
  }
  const objects = ovObjects(dataUnits);
  return role + action + (data ? `：${data}${objects ? `（${objects}）` : ''}` : '') + (results.length ? `，${results.join('，')}` : '');
}
