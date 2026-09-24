// 测试辅助：按路径取节点、读取语料、构造帧
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));

// 旧工具截图中的遥控拉闸下行帧（requirements R10.2）
export const SHOT = '682F002F00684A9999990100000004648009001100E0010000000000030000007856341210' + '00'.repeat(16) + '2016';

export function hexToBytes(hex) {
  const s = hex.replace(/\s+/g, '');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// 由「控制域 C 到应用层末尾」的 hex 构造整帧：补上 68 L L 68 和 CS 16
export function buildFrame(userHex) {
  const body = hexToBytes(userHex);
  const h = (b) => b.toString(16).toUpperCase().padStart(2, '0');
  const L = body.length;
  const cs = body.reduce((s, b) => s + b, 0) & 0xff;
  return ['68', h(L & 0xff), h(L >> 8), h(L & 0xff), h(L >> 8), '68', ...Array.from(body, h), h(cs), '16'].join('');
}

// 按「节点名/子节点名」取节点：「名#2」取同名第 2 个；「前缀*」按前缀匹配
export function findNode(tree, path) {
  let nodes = tree;
  let node = null;
  for (const seg of path.split('/')) {
    const m = seg.match(/^(.*?)(?:#(\d+))?$/);
    const name = m[1];
    const nth = m[2] ? Number(m[2]) : 1;
    const hit = (n) => (name.endsWith('*') ? n.name.startsWith(name.slice(0, -1)) : n.name === name);
    node = (nodes || []).filter(hit)[nth - 1];
    if (!node) return null;
    nodes = node.children;
  }
  return node;
}

export function loadFixture(name) {
  return readFileSync(join(here, 'fixtures', name), 'utf8');
}

// 现网报文（回归语料、真实报文用例）只放本地 fixtures/private/，不入库；没有时相关用例跳过
const privatePath = (name) => join(here, 'fixtures', 'private', name);
export const NEED_PRIVATE = !existsSync(privatePath('corpus.txt')) && '需要本地现网语料 test/fixtures/private/（不入库）';

// 公开用例 + 本地现网用例（有则追加）
export function loadCases(name) {
  const cases = JSON.parse(loadFixture(name));
  return existsSync(privatePath(name)) ? cases.concat(JSON.parse(readFileSync(privatePath(name), 'utf8'))) : cases;
}

export function loadCorpus() {
  return loadFixture('private/corpus.txt').split('\n').filter(Boolean).map((line) => {
    const [dir, hex] = line.split(' ');
    return { dir: Number(dir), hex };
  });
}
