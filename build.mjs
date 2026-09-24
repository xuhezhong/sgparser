// 构建：把 src 下的 ES module 按固定顺序内联成单个离线 HTML（design.md §5.8）
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const ORDER = ['decode.js', 'di_dict.js', 'dict.js', 'frame.js', 'unit.js', 'parser.js', 'ui.js'];
const IMPORT_LINE = /^import \{[^}]*\} from '\.\/[a-z_]+\.js';\s*$/;
const DECL = /^(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
const out = join(root, 'dist', '南网报文解析.html');

const seen = new Map();
const parts = ORDER.map((file) => {
  const src = readFileSync(join(root, 'src', file), 'utf8');
  const body = src
    .split('\n')
    .filter((line) => !IMPORT_LINE.test(line))
    .map((line) => line.replace(/^export (?=(?:async\s+)?(?:function|const|let|class)\b)/, ''))
    .join('\n');
  if (/^\s*(?:import|export)\b/m.test(body)) throw new Error(`${file}：存在构建不支持的 import/export 写法`);
  for (const m of body.matchAll(DECL)) {
    if (seen.has(m[1])) throw new Error(`顶层名称重复：${m[1]}（${seen.get(m[1])} 与 ${file}）`);
    seen.set(m[1], file);
  }
  return `// ---- ${file} ----\n${body}`;
});
const code = `(() => {\n'use strict';\n${parts.join('\n')}\n})();`.replace(/<\/script/gi, '<\\/script');
new vm.Script(code, { filename: 'bundle.js' }); // 编译检查：语法错误在这里报出
const tpl = readFileSync(join(root, 'src', 'index.html'), 'utf8');
if (!tpl.includes('<!-- BUILD:SCRIPT -->')) throw new Error('index.html 缺少 <!-- BUILD:SCRIPT --> 占位');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, tpl.replace('<!-- BUILD:SCRIPT -->', () => `<script>\n${code}\n</script>`));
process.stdout.write(`已生成 ${out}（${Math.round(statSync(out).size / 1024)} KB）\n`);
