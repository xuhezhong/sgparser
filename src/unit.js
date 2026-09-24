// 信息体：按「AFN × 方向」规则拆 DA + DI + 内容/时间域（规约 6.2 节，design.md §5.3）。
import { decodeField } from './decode.js';
import { lookupDI, ERR_CODES } from './dict.js';

// DI 之后跟什么：[下行, 上行]
const AFN_RULES = {
  0x00: ['result', 'result'],
  0x02: ['content', 'content'],
  0x04: ['content', 'err'],
  0x06: ['content', 'content'],
  0x0a: ['none', 'content'],
  0x0c: ['none', 'content'],
  0x0d: ['range6+density', 'content+time6*'],
  0x0e: ['range6', 'content'],
  0x0f: ['content', 'errOrContent'],
  0x10: ['content', 'content'],
  0x12: ['range6+density', 'content+time5*'],
  0x13: ['range6', 'content'],
  0x15: ['content', 'content'],
  0x20: ['content', 'none'],
};
// 规约附录中出现过的 DI3，加上平台自有 DI 的前缀（10/11/F0/F2）；用于区分「未收录 DI」与「规约外数据」
const KNOWN_DI3 = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x1f, 0xe0, 0xe1, 0xe2, 0xe3, 0x10, 0x11, 0xf0, 0xf2]);
// 规约表 6-5：数据密度
const DENSITY = { '00': '终端历史数据存储密度', '01': '1 分钟', '02': '5 分钟', '03': '15 分钟', '04': '30 分钟', '05': '60 分钟', '06': '1 日', '07': '1 月', '08': '结算日' };
const TIME_DOMAIN6 = { bytes: 6, enc: 'time', fmt: 'YYYYMMDDhhmm', order: 'be' }; // 规约 6.1.6
const TIME_DOMAIN5 = { bytes: 5, enc: 'time', fmt: 'YYMMDDhhmm', order: 'be' }; // 附录 A.10.4，读任务应答实测

function diAt(bytes, off) {
  let s = '';
  for (let i = 3; i >= 0; i--) s += bytes[off + i].toString(16).toUpperCase().padStart(2, '0');
  return s;
}

function plausibleDA(a1, a2) {
  return (a1 === 0 && a2 === 0) || (a1 === 0xff && a2 === 0xff) || (a1 !== 0 && a2 >= 1 && a2 <= 0xfe);
}

function isKnownUnit(bytes, off, end) {
  return end - off >= 6 && lookupDI(diAt(bytes, off + 2)) !== null;
}

// design §5.3 规则 3、4：此处能否开始一个新的信息体
function unitStartsAt(bytes, off, end) {
  if (end - off < 6) return false;
  if (isKnownUnit(bytes, off, end)) return true;
  return KNOWN_DI3.has(bytes[off + 5]) && plausibleDA(bytes[off], bytes[off + 1]);
}

function hasError(node) {
  return Boolean(node.error) || (node.children || []).some(hasError);
}

function shortIn(node) {
  return (node.error || '').startsWith('数据不足') || (node.children || []).some(shortIn);
}

function rawRest(bytes, off, end, name, desc) {
  const nd = decodeField(bytes, off, { name, bytes: end - off, enc: 'hex', order: 'be' }, end);
  nd.desc = desc;
  return nd;
}

function daNode(bytes, off) {
  const nd = decodeField(bytes, off, { name: '信息点标识DA', bytes: 2, enc: 'hex', order: 'be' });
  const a1 = bytes[off];
  const a2 = bytes[off + 1];
  if (a1 === 0 && a2 === 0) {
    nd.value = 'p0';
    nd.desc = 'p0：终端';
  } else if (a1 === 0xff && a2 === 0xff) {
    nd.value = 'pALL';
    nd.desc = '除终端外的全部测量点';
  } else if (!plausibleDA(a1, a2)) {
    nd.error = nd.desc = `DA 非法（DA1=${nd.raw.slice(0, 2)}，DA2=${nd.raw.slice(3)}）`;
  } else {
    const pn = [];
    for (let b = 0; b < 8; b++) if (a1 & (1 << b)) pn.push(8 * (a2 - 1) + b + 1);
    nd.value = pn.map((p) => `p${p}`).join(',');
    nd.desc = `Pn=${pn.join(',')}（代码点号 ${pn.map((p) => p - 1).join(',')}）`;
  }
  return nd;
}

function errNode(bytes, off, end) {
  const nd = decodeField(bytes, off, { name: '错误码ERR', bytes: 1, enc: 'hex' }, end);
  if (!nd.error) nd.desc = `${nd.value}：${ERR_CODES[nd.value] ?? '规约未定义错误码'}`;
  return nd;
}

function fieldsFor(def, dir) {
  return (dir === 1 && def.up ? def.up : def.fields) || [];
}

function contentNode(bytes, off, end, def, dir) {
  return decodeField(bytes, off, { name: `[${def.di}]${def.name}`, enc: 'struct', fields: fieldsFor(def, dir), desc: `${def.name}｜${def.tier}｜${def.src}` }, end);
}

function parseUnit(bytes, off, end, kind, fi, idx) {
  const unit = { name: `信息体${idx}`, offset: off, length: 0, raw: '', value: '', desc: '', children: [] };
  let p = off;
  let stop = false;
  const push = (nd) => {
    unit.children.push(nd);
    p += nd.length;
    if (shortIn(nd)) stop = true;
  };
  if (end - off < 6) {
    const nd = rawRest(bytes, off, end, '信息体数据', '');
    nd.error = nd.desc = `剩余 ${end - off} 字节，不足 DA+DI 的 6 字节`;
    push(nd);
    unit.length = p - off;
    return { unit, stop: true };
  }
  push(daNode(bytes, p));
  const di = diAt(bytes, p);
  const def = lookupDI(di);
  const diNode = decodeField(bytes, p, { name: '数据标识编码DI', bytes: 4, enc: 'hex' });
  diNode.desc = def ? `${di}：${def.name}` : `${di}：未收录（规约未定义）`;
  push(diNode);
  unit.desc = def ? def.name : `DI ${di}（未收录）`;

  if (kind === 'result') {
    const nd = decodeField(bytes, p, { name: '确认否认', bytes: 1, enc: 'hex', enum: { '00': '确认', '01': '否认' } }, end);
    if (!nd.error && nd.value !== '00' && nd.value !== '01') nd.error = `取值 ${nd.value} 非法，应为 00 或 01`;
    push(nd);
    if (nd.error) stop = true;
  } else if (kind === 'err' || (kind === 'errOrContent' && !(def && def.up))) {
    push(errNode(bytes, p, end));
  } else if (kind === 'errOrContent') {
    push(contentNode(bytes, p, end, def, 1));
  } else if (kind === 'range6' || kind === 'range6+density') {
    push(decodeField(bytes, p, { ...TIME_DOMAIN6, name: '数据起始时间' }, end));
    if (!stop) push(decodeField(bytes, p, { ...TIME_DOMAIN6, name: '数据结束时间' }, end));
    if (!stop && kind === 'range6+density') push(decodeField(bytes, p, { name: '数据密度', bytes: 1, enc: 'hex', enum: DENSITY }, end));
  } else if (kind === 'content') {
    if (!def) {
      push(rawRest(bytes, p, end, '数据标识内容', '未收录 DI，后续无法切分'));
      stop = true;
    } else if (fieldsFor(def, fi.dir).length) push(contentNode(bytes, p, end, def, fi.dir));
  } else if (kind === 'content+time6*' || kind === 'content+time5*') {
    const tf = kind === 'content+time6*' ? TIME_DOMAIN6 : TIME_DOMAIN5;
    if (!def || typeof def.bytes !== 'number') {
      push(rawRest(bytes, p, end, '数据内容与数据时间', def ? '内容为变长结构（本期不做字段级解析），整体显示原始数据' : '未收录 DI，后续无法切分'));
      stop = true;
    } else {
      let group = 0;
      do {
        group++;
        const c = contentNode(bytes, p, end, def, fi.dir);
        if (group > 1) c.note = '按启发式切分：视为同一信息体的下一个时间点';
        push(c);
        if (!stop) push(decodeField(bytes, p, { ...tf, name: '数据时间' }, end));
      } while (!stop && end - p >= def.bytes + tf.bytes && !isKnownUnit(bytes, p, end) && !(end - p === 16 && !fi.pw));
    }
  }
  unit.length = p - off;
  return { unit, stop };
}

// design §5.3 规则 2 的补充判别：剩余字节能否恰好拆成一串已知且无错误的信息体
function cleanUnitsAt(bytes, off, end, kind, fi) {
  let p = off;
  while (p < end) {
    if (!isKnownUnit(bytes, p, end)) return false;
    const { unit, stop } = parseUnit(bytes, p, end, kind, { ...fi, pw: true }, 0);
    if (stop || hasError(unit)) return false;
    p += unit.length;
  }
  return true;
}

export function parseUnits(bytes, fi) {
  const nodes = [];
  const end = fi.unitEnd;
  let off = fi.unitStart;
  const rule = AFN_RULES[fi.afn];
  if (off < end && !rule) {
    nodes.push(rawRest(bytes, off, end, '信息体区', 'AFN 规约未定义，无法拆分信息体'));
    return { nodes, rest: { offset: end, length: 0 } };
  }
  const kind = rule ? rule[fi.dir] : 'none';
  while (off < end) {
    const r = end - off;
    if (nodes.length) {
      // 规则 2：剩 16 字节且拆不成已知信息体 → 交给 parser 推断为 PW
      if (r === 16 && !fi.pw && !cleanUnitsAt(bytes, off, end, kind, fi)) break;
      // 规则 5：规约外数据，挂到上一个信息体
      if (!unitStartsAt(bytes, off, end)) {
        const last = nodes[nodes.length - 1];
        last.children.push(rawRest(bytes, off, end, '规约外数据', `规约外数据 ${r} 字节：按规约拆完后剩余，含义未知`));
        last.length += r;
        off = end;
        break;
      }
    }
    const { unit, stop } = parseUnit(bytes, off, end, kind, fi, nodes.length + 1);
    nodes.push(unit);
    off += unit.length;
    if (stop) {
      if (off < end) {
        nodes.push(rawRest(bytes, off, end, '后续数据', '前面的字段出错或长度不定，后续数据未解析'));
        off = end;
      }
      break;
    }
  }
  return { nodes, rest: { offset: off, length: end - off } };
}
