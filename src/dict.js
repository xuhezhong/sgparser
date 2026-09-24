// 字典查询：精确匹配 → 区间模板 → 结构展开（design.md §5.5）。di_dict.js 为生成物，勿手改。
import { DICT } from './di_dict.js';

// 附录 F 表 F.1：出错否定代码
export const ERR_CODES = {
  '00': '正确', '01': '中继命令没有返回', '02': '设置内容非法', '03': '密码权限不足',
  '04': '无此数据项', '05': '命令时间失效', '06': '目标地址不存在', '07': '校验失败',
};

const diCache = new Map();

function rangeValue(r, di) {
  const i = r.pos * 2;
  if (di.slice(0, i) !== r.base.slice(0, i) || di.slice(i + 2) !== r.base.slice(i + 2)) return null;
  const v = parseInt(di.slice(i, i + 2), 16);
  const ok = r.list ? r.list.includes(v) : v >= r.lo && v <= r.hi;
  return ok ? v : null;
}

function rangeName(r, v) {
  const h = v.toString(16).toUpperCase().padStart(2, '0');
  if (r.names && r.names[h] !== undefined) return r.names[h];
  const n = v - (r.offset || 0);
  return r.tpl.replace('{n}', String(n)).replace('{h}', n.toString(16).toUpperCase().padStart(2, '0'));
}

function resolveDef(def) {
  if (!def.struct) return def;
  const s = DICT.structs[def.struct];
  const bytes = typeof def.bytes === 'number' ? def.bytes : s && typeof s.bytes === 'number' ? s.bytes : 'var';
  return { ...def, fields: s ? s.fields : [], bytes };
}

export function lookupDI(di) {
  const key = String(di).toUpperCase();
  if (diCache.has(key)) return diCache.get(key);
  let def = null;
  if (DICT.items[key]) def = { di: key, ...DICT.items[key] };
  else {
    for (const r of DICT.ranges) {
      const v = rangeValue(r, key);
      if (v !== null) {
        def = { di: key, ...r.def, name: rangeName(r, v) };
        break;
      }
    }
  }
  if (def) def = resolveDef(def);
  diCache.set(key, def);
  return def;
}
