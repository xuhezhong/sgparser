// 界面：输入 → parse → 摘要行 + hex 视图 + 可折叠树表；悬停行高亮对应字节（requirements R7）。唯一接触 DOM 的模块。
import { parse } from './parser.js';

const byId = (id) => document.getElementById(id);
const byteHex = (b) => b.toString(16).toUpperCase().padStart(2, '0');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderHex(res) {
  const sec = new Array(res.bytes.length).fill('none');
  const alt = new Array(res.bytes.length).fill(false);
  let unitNo = 0;
  for (const nd of res.tree) {
    if (nd.section === 'unit') unitNo++;
    for (let i = nd.offset; i < nd.offset + nd.length && i < sec.length; i++) {
      sec[i] = nd.section;
      alt[i] = nd.section === 'unit' && unitNo % 2 === 0;
    }
  }
  byId('hex').replaceChildren(...Array.from(res.bytes, (b, i) => {
    const s = el('span', `b s-${sec[i]}${alt[i] ? ' alt' : ''}`, byteHex(b));
    s.dataset.i = String(i);
    return s;
  }));
}

function hideKids(row) {
  for (const k of row.kids) {
    k.hidden = true;
    hideKids(k);
  }
}

function showKids(row) {
  for (const k of row.kids) {
    k.hidden = false;
    if (!k.collapsed) showKids(k);
  }
}

function renderTree(res) {
  const rows = [];
  const walk = (nodes, depth, parent) => {
    for (const nd of nodes) {
      const tr = el('tr', nd.error ? 'err' : '');
      tr.dataset.off = String(nd.offset);
      tr.dataset.len = String(nd.length);
      tr.kids = [];
      tr.collapsed = false;
      const hasKids = Boolean(nd.children && nd.children.length);
      const name = el('td', 'name');
      name.style.paddingLeft = `${depth * 16 + 4}px`;
      const tog = el('span', 'tog', hasKids ? '▾' : '');
      if (hasKids) {
        tog.addEventListener('click', () => {
          tr.collapsed = !tr.collapsed;
          tog.textContent = tr.collapsed ? '▸' : '▾';
          if (tr.collapsed) hideKids(tr);
          else showKids(tr);
        });
      }
      name.append(tog, document.createTextNode(`${nd.name}<${nd.length}>`));
      name.title = nd.name;
      const raw = el('td', 'raw', nd.raw);
      raw.title = nd.raw;
      const extra = [nd.note ? `〔${nd.note}〕` : '', nd.error && !(nd.desc || '').includes(nd.error) ? `【${nd.error}】` : ''];
      tr.append(name, raw, el('td', 'desc', [nd.desc, ...extra].filter(Boolean).join(' ')));
      if (parent) parent.kids.push(tr);
      rows.push(tr);
      if (hasKids) walk(nd.children, depth + 1, tr);
    }
  };
  walk(res.tree, 0, null);
  byId('tree').replaceChildren(...rows);
}

function highlight(off, len) {
  for (const s of byId('hex').children) {
    const i = Number(s.dataset.i);
    s.classList.toggle('hl', i >= off && i < off + len);
  }
}

function refresh() {
  const res = parse(byId('input').value);
  const sum = byId('summary');
  sum.textContent = res.summary;
  sum.className = res.ok ? 'summary' : 'summary bad';
  renderHex(res);
  renderTree(res);
}

function mount() {
  let timer = 0;
  byId('input').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  });
  byId('clear').addEventListener('click', () => {
    byId('input').value = '';
    refresh();
    byId('input').focus();
  });
  const tree = byId('tree');
  tree.addEventListener('mouseover', (e) => {
    const tr = e.target.closest('tr');
    if (tr) highlight(Number(tr.dataset.off), Number(tr.dataset.len));
  });
  tree.addEventListener('mouseleave', () => highlight(0, 0));
  refresh();
}

mount();
