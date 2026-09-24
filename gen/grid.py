# -*- coding: utf-8 -*-
"""
第一层：基于 PDF 矢量表格线（pdfminer.six）的网格抽取。
对每页：取字符(LTChar)与线段(LTLine/LTRect/LTCurve) → 按线段连通性拆成表格 →
用竖线定列、用"横跨该列的横线"定每列的行边界 → 以最细行切分得到 fine rows，
每个 fine row 每列取所在单元格（合并单元格会在多个 fine row 间共享同一 cell_id）。
由 extract_di.py 在内存中调用 build_grid()
"""
from pdfminer.pdfparser import PDFParser
from pdfminer.pdfdocument import PDFDocument
from pdfminer.pdfpage import PDFPage
from pdfminer.pdfinterp import PDFResourceManager, PDFPageInterpreter
from pdfminer.converter import PDFPageAggregator
from pdfminer.layout import LTChar, LTLine, LTRect, LTCurve, LTFigure, LTAnno

TOL = 2.0


def iter_layout(obj):
    for o in obj:
        if isinstance(o, LTFigure):
            yield from iter_layout(o)
        else:
            yield o


def segs_of(o, H):
    """把图元转成线段 (kind, x0, y0, x1, y1)，y 转为自上而下坐标。"""
    x0, y0, x1, y1 = o.bbox
    t0, t1 = H - y1, H - y0
    w, h = x1 - x0, t1 - t0
    out = []
    if w <= 2.5 and h > 3:
        out.append(("v", (x0 + x1) / 2, t0, (x0 + x1) / 2, t1))
    elif h <= 2.5 and w > 3:
        out.append(("h", x0, (t0 + t1) / 2, x1, (t0 + t1) / 2))
    elif isinstance(o, LTRect) and w > 3 and h > 3:
        out += [("h", x0, t0, x1, t0), ("h", x0, t1, x1, t1),
                ("v", x0, t0, x0, t1), ("v", x1, t0, x1, t1)]
    return out


def cluster(vals, tol=TOL):
    vals = sorted(vals)
    groups = []
    for v in vals:
        if groups and v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def touch(a, b):
    """两线段（含容差）是否相交/相接。"""
    ax0, ay0, ax1, ay1 = a[1], a[2], a[3], a[4]
    bx0, by0, bx1, by1 = b[1], b[2], b[3], b[4]
    return (min(ax0, ax1) - TOL <= max(bx0, bx1) and min(bx0, bx1) - TOL <= max(ax0, ax1)
            and min(ay0, ay1) - TOL <= max(by0, by1) and min(by0, by1) - TOL <= max(ay0, ay1))


def build_tables(segs):
    n = len(segs)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in range(n):
        for j in range(i + 1, n):
            if segs[i][0] != segs[j][0] and touch(segs[i], segs[j]):
                parent[find(i)] = find(j)
    comps = {}
    for i in range(n):
        comps.setdefault(find(i), []).append(segs[i])
    tables = []
    for comp in comps.values():
        hs = [s for s in comp if s[0] == "h"]
        vs = [s for s in comp if s[0] == "v"]
        if len(hs) >= 2 and len(vs) >= 2:
            tables.append((hs, vs))
    return tables


def char_lines(chars):
    """把一个单元格内的字符聚成文本行（按 y 聚类，行内按 x 排序，大间隙插空格）。"""
    if not chars:
        return []
    chars = sorted(chars, key=lambda c: (c["cy"], c["x0"]))
    rows = []
    for c in chars:
        if rows and abs(c["cy"] - rows[-1]["cy"]) <= 3.0:
            rows[-1]["cs"].append(c)
        else:
            rows.append({"cy": c["cy"], "cs": [c]})
    out = []
    for r in rows:
        cs = sorted(r["cs"], key=lambda c: c["x0"])
        s = ""
        prev = None
        for c in cs:
            if prev is not None and c["x0"] - prev["x1"] > 2.2:
                s += " "
            s += c["t"]
            prev = c
        out.append({"y": round(r["cy"], 1), "x": round(cs[0]["x0"], 1), "x1": round(cs[-1]["x1"], 1), "text": s.strip()})
    return [o for o in out if o["text"]]


def process_page(layout, pno):
    H = layout.bbox[3]
    chars, segs = [], []
    for o in iter_layout(layout):
        if isinstance(o, LTChar):
            t = o.get_text()
            if t.strip() == "":
                continue
            x0, y0, x1, y1 = o.bbox
            chars.append({"t": t, "x0": x0, "x1": x1, "top": H - y1, "bot": H - y0,
                          "cx": (x0 + x1) / 2, "cy": H - (y0 + y1) / 2})
        elif isinstance(o, (LTLine, LTRect, LTCurve)):
            segs += segs_of(o, H)
    tables = []
    used = set()
    for hs, vs in build_tables(segs):
        xs = cluster([s[1] for s in vs])
        tx0, tx1 = min(min(s[1], s[3]) for s in hs), max(max(s[1], s[3]) for s in hs)
        ty0 = min(min(s[2], s[4]) for s in vs)
        ty1 = max(max(s[2], s[4]) for s in vs)
        if tx1 - tx0 < 100:
            continue
        xs = [x for x in xs if tx0 - TOL <= x <= tx1 + TOL]
        cols = [(xs[i], xs[i + 1]) for i in range(len(xs) - 1) if xs[i + 1] - xs[i] > 3]
        # 每列的行边界：横跨该列中心的横线
        col_bounds = []
        for (a, b) in cols:
            cx = (a + b) / 2
            ys = [s[2] for s in hs if min(s[1], s[3]) - TOL <= cx <= max(s[1], s[3]) + TOL]
            col_bounds.append(cluster(ys))
        # 兜底：表格竖线的上下端也作为行边界（个别表格底边横线缺失）
        for ys in col_bounds:
            for edge in (ty0, ty1):
                if all(abs(edge - y) > TOL for y in ys):
                    ys.append(edge)
            ys.sort()
        all_y = cluster([y for ys in col_bounds for y in ys])
        fine = [(all_y[i], all_y[i + 1]) for i in range(len(all_y) - 1) if all_y[i + 1] - all_y[i] > 3]
        # 单元格文本
        cell_text = {}
        rows = []
        for (fy0, fy1) in fine:
            mid = (fy0 + fy1) / 2
            row = []
            for ci, (a, b) in enumerate(cols):
                ys = col_bounds[ci]
                cy0 = max([y for y in ys if y <= mid + 0.1], default=None)
                cy1 = min([y for y in ys if y >= mid - 0.1], default=None)
                if cy0 is None or cy1 is None:
                    row.append(None)
                    continue
                key = (ci, round(cy0, 1))
                if key not in cell_text:
                    cs = [c for c in chars if a <= c["cx"] <= b and cy0 <= c["cy"] <= cy1]
                    for c in cs:
                        used.add(id(c))
                    cell_text[key] = char_lines(cs)
                row.append({"cell": f"{ci}@{round(cy0, 1)}", "y0": round(cy0, 1), "y1": round(cy1, 1), "x0": round(a, 1), "x1": round(b, 1),
                            "lines": cell_text[key]})
            rows.append({"y0": round(fy0, 1), "y1": round(fy1, 1), "cells": row})
        tables.append({"page": pno, "bbox": [round(tx0, 1), round(ty0, 1), round(tx1, 1), round(ty1, 1)],
                       "cols": [[round(a, 1), round(b, 1)] for a, b in cols], "rows": rows})
    # 表外文本（用于定位标题、章节号、注释）
    outside = char_lines([c for c in chars if id(c) not in used])
    tables.sort(key=lambda t: t["bbox"][1])
    return tables, outside


def build_grid(pdf, first=36, last=128):
    """返回每页的表格网格 [{page, printed, tables, outside}]。附录 A 起于 PDF 第 36 页，附录 M 止于第 128 页。"""
    rsrc = PDFResourceManager()
    dev = PDFPageAggregator(rsrc, laparams=None)
    interp = PDFPageInterpreter(rsrc, dev)
    result = []
    with open(pdf, "rb") as fp:
        for i, page in enumerate(PDFPage.get_pages(fp)):
            pno = i + 1
            if pno < first or pno > last:
                continue
            interp.process_page(page)
            tables, outside = process_page(dev.get_result(), pno)
            result.append({"page": pno, "printed": pno - 4, "tables": tables, "outside": outside})
    return result
