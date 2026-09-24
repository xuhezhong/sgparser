// 解析入口：清洗 → 帧层 → 信息体 → 附加信息（PW 推断）→ 分区、错误汇总、摘要（design.md §5.2）。任何输入都不抛异常。
import { cleanHex, parseFrame } from './frame.js';
import { parseUnits } from './unit.js';
import { decodeField } from './decode.js';

// 顶层节点 → hex 视图分区；未列出的（信息体、规约外数据、后续数据等）归入 unit
const SECTION_OF = {
  '起始符68H': 'head', '长度L': 'head', '控制域C': 'ctrl', '地址域A': 'addr', '功能码AFN': 'app', '帧序列域SEQ': 'app',
  '消息验证码PW': 'aux', '时间标签Tp': 'aux', '校验码CS': 'tail', '结束符16H': 'tail', '多余数据': 'tail',
};
const EMPTY = new Uint8Array(0);

export function parse(text) {
  try {
    return runParse(text);
  } catch (e) {
    const msg = `内部错误：${e && e.message ? e.message : String(e)}`;
    return { ok: false, summary: `解析有误：${msg}`, bytes: EMPTY, tree: [], errors: [msg] };
  }
}

function runParse(text) {
  const cleaned = cleanHex(text);
  if (cleaned.error) return { ok: false, summary: `解析有误：${cleaned.error}`, bytes: EMPTY, tree: [], errors: [cleaned.error] };
  const bytes = cleaned.bytes;
  if (!bytes.length) return { ok: true, summary: '', bytes, tree: [], errors: [] };
  const fi = parseFrame(bytes);
  const units = fi.fatal ? { nodes: [], rest: { offset: 0, length: 0 } } : parseUnits(bytes, fi);
  const aux = [];
  if (units.rest.length === 16) {
    const pw = decodeField(bytes, units.rest.offset, { name: '消息验证码PW', bytes: 16, enc: 'hex', order: 'be' });
    pw.desc = '消息认证码 PW';
    pw.note = '规约未要求，按长度推断';
    aux.push(pw);
  }
  if (fi.pw) aux.push(fi.pw);
  if (fi.tp) aux.push(fi.tp);
  const k = fi.nodes.findIndex((nd) => nd.name === '帧序列域SEQ');
  const tree = k < 0 ? fi.nodes : [...fi.nodes.slice(0, k + 1), ...units.nodes, ...aux, ...fi.nodes.slice(k + 1)];
  for (const nd of tree) setSection(nd, SECTION_OF[nd.name] || 'unit');
  const errors = [];
  collectErrors(tree, '', errors);
  return { ok: errors.length === 0, summary: summarize(fi, errors), bytes, tree, errors };
}

function setSection(node, section) {
  node.section = section;
  for (const c of node.children || []) setSection(c, section);
}

function collectErrors(nodes, path, out) {
  for (const nd of nodes) {
    const p = path ? `${path}/${nd.name}` : nd.name;
    if (nd.error) out.push(`${p}：${nd.error}`);
    if (nd.children) collectErrors(nd.children, p, out);
  }
}

function roleOf(fi) {
  if (fi.dir === 0) return fi.prm ? '主站请求' : '主站应答';
  if (!fi.prm) return '终端应答';
  if (fi.afn === 0x02) return '终端链路检测';
  if (fi.afn === 0x12 || fi.afn === 0x13) return '终端主动上报';
  return '终端请求';
}

function summarize(fi, errors) {
  const head = errors.length ? `解析有误（${errors.length} 处）！` : '解析成功！';
  if (fi.fatal) return `${head}报文不完整，帧头无法拆分`;
  return `${head}${roleOf(fi)}：终端地址[${fi.cid}]，主站地址[${fi.a3}]，帧序号[${fi.seq & 0x0f}]，${fi.frameKind}，${fi.afnName}`;
}
