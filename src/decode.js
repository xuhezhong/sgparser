// 字段解码：按 Field 定义把一段字节解成树节点（Node）。纯函数，不接触 DOM。
// 字节序（design.md §5.4，均已用真实报文核实）：
//   数值、地址、密码、BIN，以及数据内容里的时间字段：低字节在前，显示时倒序；
//   时间域（order:'be'，如起止时间、数据时间）与 ASCII：高位在前。

const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const TIME_TOKENS = /YYYY|YY|MM|DD|hh|HH|mm|ss|WW/g;

function rawOf(bytes, off, len) {
  return Array.from(bytes.subarray(off, off + len), hex2).join(' ');
}

// 按显示顺序（高位在左）取字节
function displayBytes(bytes, off, len, order) {
  const arr = Array.from(bytes.subarray(off, off + len));
  return order === 'be' ? arr : arr.reverse();
}

// 字段的固定字节数；含 'var' 或 repeat 时返回 null
function fixedLen(f) {
  if (f.enc === 'repeat') return null;
  if (f.enc === 'struct' && typeof f.bytes !== 'number') {
    let sum = 0;
    for (const c of f.fields || []) {
      const n = fixedLen(c);
      if (n === null) return null;
      sum += n;
    }
    return sum;
  }
  return typeof f.bytes === 'number' ? f.bytes : null;
}

function hasShortage(node) {
  return (node.error || '').startsWith('数据不足') || (node.children || []).some(hasShortage);
}

function bcdValue(d, f) {
  let s = d.map(hex2).join('');
  let neg = false;
  if (f.sign === 'msb') {
    const top = parseInt(s[0], 16);
    neg = (top & 8) !== 0;
    s = String(top & 7) + s.slice(1);
  }
  if (!/^\d*$/.test(s)) return { error: `非法 BCD：${d.map(hex2).join('')}` };
  if (f.dec !== undefined) {
    const intPart = s.slice(0, s.length - f.dec).replace(/^0+(?=\d)/, '') || '0';
    s = f.dec > 0 ? `${intPart}.${s.slice(s.length - f.dec)}` : intPart;
  }
  return { value: (neg ? '-' : '') + s };
}

function timeValue(d, fmt) {
  const v = {};
  let i = 0;
  for (const t of fmt.match(TIME_TOKENS) || []) {
    const n = t === 'YYYY' ? 2 : 1;
    const s = d.slice(i, i + n).map(hex2).join('');
    i += n;
    if (!/^\d+$/.test(s)) return { error: `非法 BCD 时间：${d.map(hex2).join('')}` };
    v[t === 'HH' ? 'hh' : t] = s;
  }
  const year = v.YYYY || (v.YY !== undefined ? `20${v.YY}` : '');
  let date = year;
  if (v.MM !== undefined) date = [year, v.MM, v.DD].filter((x) => x !== undefined && x !== '').join('-');
  else if (v.DD !== undefined) date = `${v.DD}日`;
  const time = [v.hh, v.mm, v.ss].filter((x) => x !== undefined).join(':');
  let out = [date, time].filter((x) => x).join(' ');
  if (v.WW !== undefined) out += ` 周${Number(v.WW)}`;
  return { value: out };
}

function bitNodes(v, bits, off, len) {
  return bits.map((b) => {
    const [hi, lo = hi] = String(b.bit).split('-').map(Number);
    const width = hi - lo + 1;
    const val = Math.floor(v / 2 ** lo) % 2 ** width;
    const shown = val.toString(2).padStart(width, '0');
    const meaning = b.values ? b.values[shown] : undefined;
    return { name: `D${b.bit} ${b.name}`, offset: off, length: len, raw: '', value: shown, desc: meaning === undefined ? shown : `${shown}：${meaning}` };
  });
}

// 8 字节通信地址：倒序后依次为 补位 2 + IP 4 + 端口 2（仓库样例 IP 查询应答实测）
function ipValue(d) {
  return `${d.slice(2, 6).join('.')}:${d[6] * 256 + d[7]}`;
}

function expandRepeat(f, siblings) {
  const ref = siblings.find((k) => k.name === f.repeat.count);
  const n = ref ? parseInt(ref.value, 10) + (f.repeat.plus || 0) : 0;
  const label = f.repeat.label || `${f.name}[{i}]`;
  const fields = [];
  for (let i = 0; i < (Number.isFinite(n) ? n : 0); i++) {
    const name = Array.isArray(label) ? (i === 0 ? label[0] : label[1]) : label;
    fields.push({ ...f.repeat.item, name: name.replace('{i}', String(i)) });
  }
  return { name: f.name, enc: 'struct', fields };
}

function decodeStruct(bytes, off, f, end) {
  const fields = f.fields || [];
  const kids = [];
  let p = off;
  for (let i = 0; i < fields.length; i++) {
    const c = fields[i].enc === 'repeat' ? expandRepeat(fields[i], kids) : fields[i];
    let cEnd = end;
    if (fixedLen(c) === null) {
      const after = fields.slice(i + 1).map(fixedLen);
      if (after.every((n) => n !== null)) cEnd = end - after.reduce((s, n) => s + n, 0);
    }
    const k = decodeField(bytes, p, c, cEnd);
    kids.push(k);
    p += k.length;
    if (hasShortage(k)) break;
  }
  return { name: f.name, offset: off, length: p - off, raw: rawOf(bytes, off, p - off), value: '', desc: f.desc || '', children: kids };
}

export function decodeField(bytes, off, f, end = bytes.length) {
  if (f.enc === 'struct') return decodeStruct(bytes, off, f, end);
  const avail = Math.max(0, end - off);
  const len = f.bytes === 'var' ? avail : f.bytes;
  const take = Math.min(len, avail);
  const node = { name: f.name, offset: off, length: take, raw: rawOf(bytes, off, take), value: '', desc: '' };
  if (len > avail) {
    node.error = `数据不足，期望 ${len} 字节，实际 ${avail} 字节`;
    node.desc = `${f.name}：${node.error}`;
    return node;
  }
  if (len === 0) return node;
  const d = displayBytes(bytes, off, len, f.enc === 'ascii' ? 'be' : f.order);
  // 全 FF 视为无效（附录 A 导语）；hex 编码不套用：DA、控制字节、PW 等处 FF 本身有含义（如 FFFF 表示全部测量点）
  if (f.enc !== 'hex' && d.every((b) => b === 0xff)) {
    node.value = 'FF'.repeat(len);
    node.desc = `${f.name}：无效（全 FF）`;
    return node;
  }
  let r;
  if (f.enc === 'bcd') r = bcdValue(d, f);
  else if (f.enc === 'bin') {
    let v = 0;
    for (const b of d) v = v * 256 + b;
    // 带位定义的状态字按十六进制显示：0x0050 若显示成十进制「80」，容易被误读为 0x80（现网验证发现）
    r = { value: f.bits ? d.map(hex2).join('') : f.dec ? (v / 10 ** f.dec).toFixed(f.dec) : String(v) };
    if (f.bits) node.children = bitNodes(v, f.bits, off, len);
  } else if (f.enc === 'ascii') r = { value: String.fromCharCode(...d.filter((b) => b !== 0).map((b) => (b >= 0x20 && b < 0x7f ? b : 0x2e))) };
  else if (f.enc === 'time') r = timeValue(d, f.fmt || '');
  else if (f.enc === 'ip' && len === 8) r = { value: ipValue(d) };
  else r = { value: d.map(hex2).join('') };
  if (r.error) {
    node.error = r.error;
    node.desc = `${f.name}：${r.error}`;
    return node;
  }
  node.value = r.value;
  const extra = f.enum ? `（${f.enum[d.map(hex2).join('')] ?? '规约未定义取值'}）` : '';
  node.desc = `${f.name}：${r.value}${f.unit ? ` ${f.unit}` : ''}${extra}`;
  return node;
}
