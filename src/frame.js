// 帧层：清洗输入、拆帧头（68 L L 68 C A AFN SEQ）、定位附加信息（PW/Tp）、校验 CS 与结束符。
// 依据规约第 5 章、6.1 节（design.md §2.1、§5.2）。
import { decodeField } from './decode.js';

// 规约表 6-1：应用层功能码
const AFN_NAMES = {
  0x00: '确认/否认', 0x02: '链路接口检测', 0x04: '写参数', 0x06: '安全认证', 0x0a: '读参数', 0x0c: '读当前数据',
  0x0d: '读历史数据', 0x0e: '读事件记录', 0x0f: '文件传输', 0x10: '中继转发', 0x12: '读任务数据', 0x13: '读告警数据',
  0x15: '用户自定义数据', 0x20: '终端请求主站数据',
};
// 规约表 5-2（PRM=0）、表 5-1（PRM=1）：链路层功能码，下标为 PRM
const FUNC_NAMES = [
  { 0: '确认：认可', 8: '响应：用户数据', 9: '响应：否认，无所召唤的数据', 11: '响应：链路状态' },
  { 1: '发送/确认：复位命令', 4: '发送/无回答：用户数据', 9: '请求/响应：链路测试', 10: '请求/响应：请求 1 级数据', 11: '请求/响应：请求 2 级数据' },
];
// 规约表 6-2：下标 = FIR*2 + FIN
const FRAME_KINDS = ['多帧：中间帧', '多帧：结束帧', '多帧：第 1 帧，有后续帧', '单帧'];
const MAX_L = 16383;
// 规约 6.1.8：Tp = 启动帧发送时标 DDhhmmss（4，低字节在前）+ 允许发送传输延时（BIN 1，分钟）
const TP_FIELD = { name: '时间标签Tp', enc: 'struct', desc: '时间标签 Tp（规约 6.1.8）', fields: [
  { name: '启动帧发送时标', bytes: 4, enc: 'time', fmt: 'DDhhmmss' },
  { name: '允许发送传输延时', bytes: 1, enc: 'bin', unit: '分钟' },
] };

const hexOf = (b) => b.toString(16).toUpperCase().padStart(2, '0');
// 规约 6.2.3、6.2.4：下行写参数、下行/上行安全认证带 PW
const needsPW = (dir, afn) => (dir === 0 && (afn === 0x04 || afn === 0x06)) || (dir === 1 && afn === 0x06);

function flagNode(name, off, value, desc) {
  return { name, offset: off, length: 1, raw: '', value: String(value), desc };
}

export function cleanHex(text) {
  const src = String(text ?? '').replace(/0x/gi, '  ');
  const bad = src.search(/[^0-9a-fA-F\s,;，；]/);
  if (bad >= 0) return { error: `第 ${bad + 1} 个字符「${src[bad]}」不是十六进制字符` };
  const s = src.replace(/[\s,;，；]/g, '');
  if (s.length % 2) return { error: `十六进制字符数为 ${s.length}，不是偶数` };
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return { bytes };
}

function describeCtrl(c, cv, fi) {
  fi.dir = cv >> 7;
  fi.prm = (cv >> 6) & 1;
  const d5 = (cv >> 5) & 1;
  const d4 = (cv >> 4) & 1;
  const func = cv & 0x0f;
  const funcName = FUNC_NAMES[fi.prm][func];
  c.children = [
    flagNode('D7传输方向位DIR', 6, fi.dir, fi.dir ? '上行：终端发出' : '下行：主站发出'),
    flagNode('D6启动标志位PRM', 6, fi.prm, fi.prm ? '来自启动站' : '来自从动站'),
    fi.dir
      ? flagNode('D5要求访问位ACD', 6, d5, d5 ? '终端有告警数据等待访问' : '终端无告警数据等待访问')
      : flagNode('D5帧计数位FCB', 6, d5, `FCB=${d5}`),
    fi.dir ? flagNode('D4保留', 6, d4, '保留') : flagNode('D4帧计数有效位FCV', 6, d4, d4 ? 'FCB 有效' : 'FCB 无效'),
    flagNode('D3~D0功能码', 6, func, funcName ? `${func}：${funcName}` : `${func}：规约备用`),
  ];
  if (!funcName) c.children[4].error = `PRM=${fi.prm} 时功能码 ${func} 为规约备用`;
  c.desc = `${fi.dir ? '上行' : '下行'}，${fi.prm ? '启动站' : '从动站'}，${funcName || '备用功能码'}`;
}

function describeAddr(a, bytes, fi) {
  const rev = (off) => Array.from(bytes.subarray(off, off + 3)).reverse().map(hexOf).join('');
  const [a1, a2, a3] = a.children;
  const a2v = bytes[10] | (bytes[11] << 8) | (bytes[12] << 16);
  fi.cid = rev(7) + rev(10);
  fi.a3 = bytes[13];
  a.value = fi.cid;
  a.desc = `集中器ID(cid)：${fi.cid}`;
  if (!a1.error) a1.desc = `省地市区县码：${rev(7)}`;
  a2.desc = `终端地址：${a2v}（${rev(10)}H）${a2v === 0 ? '，无效地址' : a2v === 0xffffff ? '，系统广播地址' : ''}`;
  a3.desc = `主站地址 MSA=${fi.a3}`;
}

function describeSeq(seq, sv, fi) {
  fi.seq = sv;
  const tpv = sv >> 7;
  const fir = (sv >> 6) & 1;
  const fin = (sv >> 5) & 1;
  const con = (sv >> 4) & 1;
  fi.frameKind = FRAME_KINDS[fir * 2 + fin];
  seq.children = [
    flagNode('D7帧时间标签有效位TpV', 15, tpv, tpv ? '帧末尾带时间标签 Tp' : '帧末尾无时间标签 Tp'),
    flagNode('D6首帧标志FIR', 15, fir, fir ? '报文的第一帧' : '不是报文的第一帧'),
    flagNode('D5末帧标志FIN', 15, fin, fin ? '报文的最后一帧' : '不是报文的最后一帧'),
    flagNode('D4请求确认标志CON', 15, con, con ? '需要对该帧报文进行确认' : '不需要确认'),
    flagNode('D3~D0帧内序号', 15, sv & 0x0f, `帧内序号=${sv & 0x0f}`),
  ];
  seq.desc = `${fi.frameKind}，帧内序号=${sv & 0x0f}`;
}

function tailNodes(bytes, L) {
  const out = [];
  const cs = decodeField(bytes, 6 + L, { name: '校验码CS', bytes: 1, enc: 'hex' });
  const calc = bytes.subarray(6, 6 + L).reduce((s, b) => s + b, 0) & 0xff;
  if (calc === bytes[6 + L]) cs.desc = '校验码正确';
  else cs.error = cs.desc = `校验码错误：报文 ${cs.raw}，计算应为 ${hexOf(calc)}`;
  const e = decodeField(bytes, 7 + L, { name: '结束符16H', bytes: 1, enc: 'hex' });
  if (bytes[7 + L] === 0x16) e.desc = '结束符';
  else e.error = e.desc = `应为 16，实际 ${e.raw}`;
  out.push(cs, e);
  if (bytes.length > L + 8) {
    const x = decodeField(bytes, L + 8, { name: '多余数据', bytes: bytes.length - L - 8, enc: 'hex', order: 'be' });
    x.error = x.desc = `帧结束后多出 ${x.length} 字节`;
    out.push(x);
  }
  return out;
}

export function parseFrame(bytes) {
  const n = bytes.length;
  const nodes = [];
  const fi = { nodes, dir: 0, prm: 0, afn: -1, seq: 0, unitStart: 16, unitEnd: 16, fatal: false, cid: '', a3: 0, frameKind: '', afnName: '' };
  // 依次拆帧头；某一段字节不足即判为 fatal，不再往下拆（R6.2）
  const step = (off, f) => {
    if (fi.fatal) return null;
    const nd = decodeField(bytes, off, f);
    nodes.push(nd);
    const short = (x) => (x.error || '').startsWith('数据不足');
    if (short(nd) || (nd.children || []).some(short)) {
      fi.fatal = true;
      return null;
    }
    return nd;
  };
  const s1 = step(0, { name: '起始符68H', bytes: 1, enc: 'hex' });
  const l1 = step(1, { name: '长度L', bytes: 2, enc: 'bin' });
  const l2 = step(3, { name: '长度L', bytes: 2, enc: 'bin' });
  const s2 = step(5, { name: '起始符68H', bytes: 1, enc: 'hex' });
  const c = step(6, { name: '控制域C', bytes: 1, enc: 'hex' });
  const a = step(7, { name: '地址域A', enc: 'struct', fields: [
    { name: '省地市区县码A1', bytes: 3, enc: 'bcd' },
    { name: '终端地址A2', bytes: 3, enc: 'bin' },
    { name: '主站地址A3', bytes: 1, enc: 'bin' },
  ] });
  const afn = step(14, { name: '功能码AFN', bytes: 1, enc: 'hex' });
  const seq = step(15, { name: '帧序列域SEQ', bytes: 1, enc: 'hex' });

  const L = n >= 3 ? bytes[1] | (bytes[2] << 8) : 0;
  if (s1 && bytes[0] !== 0x68) s1.error = `应为 68，实际 ${s1.raw}`;
  if (l1) {
    l1.desc = `用户数据长度 L=${L}，整帧应为 ${L + 8} 字节`;
    if (L > MAX_L) l1.error = `L=${L} 超过规约上限 ${MAX_L}`;
    else if (L < 10) l1.error = `L=${L} 小于最小长度 10（C + A + AFN + SEQ）`;
    else if (n < L + 8) l1.error = `整帧应为 ${L + 8} 字节，实际 ${n} 字节（报文不完整）`;
  }
  if (l2) {
    const L2 = bytes[3] | (bytes[4] << 8);
    l2.desc = `用户数据长度 L=${L2}`;
    if (L2 !== L) l2.error = `两个长度 L 不一致（${L} ≠ ${L2}）`;
  }
  if (s2 && bytes[5] !== 0x68) s2.error = `应为 68，实际 ${s2.raw}`;
  if (c) describeCtrl(c, bytes[6], fi);
  if (a) describeAddr(a, bytes, fi);
  if (afn) {
    fi.afn = bytes[14];
    fi.afnName = AFN_NAMES[fi.afn] || '规约未定义';
    afn.desc = fi.afnName;
  }
  if (seq) describeSeq(seq, bytes[15], fi);
  if (fi.fatal) return fi;

  // 帧尾与附加信息：只有整帧完整时才定位；Tp 在最后，PW 紧挨在 Tp 之前（规约图 6-1）
  const complete = L >= 10 && L <= MAX_L && n >= L + 8;
  let auxEnd = complete ? 6 + L : n;
  if (complete) {
    nodes.push(...tailNodes(bytes, L));
    if (fi.seq >> 7) {
      if (auxEnd - 5 >= 16) {
        fi.tp = decodeField(bytes, auxEnd - 5, TP_FIELD, auxEnd);
        auxEnd -= 5;
      } else seq.children[0].error = '帧长度不足以容纳 Tp';
    }
    if (needsPW(fi.dir, fi.afn)) {
      if (auxEnd - 16 >= 16) {
        fi.pw = decodeField(bytes, auxEnd - 16, { name: '消息验证码PW', bytes: 16, enc: 'hex', order: 'be' }, auxEnd);
        fi.pw.desc = '消息认证码 PW（规约 6.1.7）';
        auxEnd -= 16;
      } else afn.error = '帧长度不足以容纳 PW';
    }
  }
  fi.unitEnd = Math.max(16, auxEnd);
  return fi;
}
