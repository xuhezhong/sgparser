# -*- coding: utf-8 -*-
"""一次性导入回归语料（design.md §5.6）。

用法：$PY gen/import_corpus.py --xls <报文查询.xls> --frame <terminal.frame>
输出：test/fixtures/private/corpus.txt（现网报文，不入库），每行「方向 hex」（0 下行 / 1 上行）。
只保留方向与 hex（不含 IP、时间）；按 hex 去重；剔除 AFN=06 安全认证帧；CS 不对的帧直接报错退出。
"""
import argparse
import pathlib
import sys

import xlrd

OUT = pathlib.Path(__file__).resolve().parent.parent / "test" / "fixtures" / "private" / "corpus.txt"


def frame_ok(f):
    if len(f) < 16 or f[0] != 0x68 or f[5] != 0x68 or f[-1] != 0x16:
        return False
    L = f[1] | f[2] << 8
    return L == (f[3] | f[4] << 8) and len(f) == L + 8 and sum(f[6:6 + L]) & 0xFF == f[6 + L]


def frames_in_blob(data):
    """terminal.frame 是「22222223 + 记录头 + 完整帧」的二进制记录，逐字节扫描出 CS 正确的帧。"""
    i, out = 0, []
    while i < len(data) - 8:
        if data[i] == 0x68 and data[i + 5] == 0x68:
            L = data[i + 1] | data[i + 2] << 8
            f = bytes(data[i:i + L + 8])
            if L >= 10 and frame_ok(f):
                out.append(f)
                i += L + 8
                continue
        i += 1
    return out


def from_xls(path):
    sh = xlrd.open_workbook(path).sheet_by_index(0)
    start = next(r for r in range(sh.nrows) if sh.cell_value(r, 5) == "报文内容") + 1
    rows = []
    for r in range(start, sh.nrows):
        f = bytes.fromhex(str(sh.cell_value(r, 5)).replace(" ", ""))
        if not frame_ok(f):
            sys.exit(f"xls 第 {r + 1} 行帧校验失败")
        d = 0 if str(sh.cell_value(r, 4)).startswith("1") else 1  # 导出表的「方向」列：1 = 主站 → 终端
        if d != f[6] >> 7:
            sys.exit(f"xls 第 {r + 1} 行方向列与 C.DIR 不一致")
        rows.append((d, f))
    return rows


def main():
    ap = argparse.ArgumentParser(description="导入回归语料")
    ap.add_argument("--xls", required=True)
    ap.add_argument("--frame", required=True)
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()
    rows = from_xls(a.xls) + [(f[6] >> 7, f) for f in frames_in_blob(pathlib.Path(a.frame).read_bytes())]
    seen, lines, skipped = set(), [], 0
    for d, f in rows:
        if f[14] == 0x06:
            skipped += 1
            continue
        h = f.hex().upper()
        if h not in seen:
            seen.add(h)
            lines.append(f"{d} {h}")
    pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(a.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"写入 {len(lines)} 条，剔除 AFN=06 {skipped} 条 → {a.out}")


if __name__ == "__main__":
    main()
