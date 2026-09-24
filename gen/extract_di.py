# -*- coding: utf-8 -*-
"""
南网上行规约 DI 字典生成器（design.md §5.5–5.6）。
第一层 grid.build_grid() 从 PDF 表格线切出网格；本文件第二层解析成 DI 条目，再合并 overrides.json，
输出 src/di_dict.js（首行哨兵，勿手改）与 gen/review.tsv（待人工处理清单）。
用法：python extract_di.py --pdf <规约 PDF> [--check]
"""
import json
import re
import sys
from collections import Counter, OrderedDict, defaultdict


HEX2 = re.compile(r"^[0-9A-F]{2}$")
ELL = re.compile(r"^[…\.]{1,6},?$")
CJK = r"一-鿿（）：，、。；"
DI_ROLES = ("DI3", "DI2", "DI1", "DI0")

# 需要人工处理的标记；其余标记为信息性（规则可自动处理）
MANUAL_FLAGS = {"di_token_bad", "di_incomplete", "di_multi_varying", "bytes_mismatch", "bytes_sum_mismatch",
                "var_length", "bytes_unknown", "no_format", "name_missing", "name_not_interpolated",
                "cross_page_row", "ref_unresolved", "collection_mismatch", "struct_needs_manual",
                "attr_misaligned", "block_irregular_rate"}


def nospace(s):
    return re.sub(r"\s+", "", s or "")


def cjk_squeeze(s):
    s = re.sub(r"(?<=[%s])\s+(?=[%s])" % (CJK, CJK), "", s)
    s = re.sub(r"D\s*I\s*3\s*D\s*I\s*2\s*D\s*I\s*1\s*D\s*I\s*0", "DI3DI2DI1DI0", s)
    s = re.sub(r"=\s*((?:[0-9A-F]\s*){8})\s*H", lambda m: "=" + m.group(1).replace(" ", "") + "H", s)
    return s


# ---------------------------------------------------------------- PDF 页 → 文本行号


SPEC_LINES, FIRST_LINE = [], {}  # 仓库版不依赖 pdftotext 文本，source_line 一律为空


def find_source_line(page, toks):
    if not toks:
        return None
    start = FIRST_LINE.get(page)
    end = FIRST_LINE.get(page + 1, len(SPEC_LINES) + 1)
    if start is None:
        return None
    pats = [r"(?<![0-9A-Za-z])" + r"\s+".join(toks) + r"(?![0-9A-Za-z])"]
    if len(toks) == 4:
        pats.append(r"(?<![0-9A-Za-z])" + r"\s+".join(toks[:3]) + r"(?![0-9A-Za-z])")
    for pat in pats:
        rx = re.compile(pat)
        for i in range(start - 1, min(end, len(SPEC_LINES))):
            if rx.search(SPEC_LINES[i]):
                return i + 1
    return None


# ---------------------------------------------------------------- 表头 → 列角色
HEADER_RX = re.compile(r"DI[0-3]|数据标识编码|数据格式|字节数|编号|序号|数据内容|告警数|事件名称|数据标识名称")


def role_of(t):
    t = nospace(t)
    m = re.search(r"DI([0-3])", t)
    if m:
        return "DI" + m.group(1)
    for key, role in (("下行数据格式", "fmt_down"), ("上行数据格式", "fmt_up"), ("数据格式", "fmt")):
        if key in t:
            return role
    if "字节数" in t or ("字" in t and "节" in t):
        return "bytes"
    for key, role in (("单位", "unit"), ("读", "r"), ("写", "w"), ("序号", "seq"), ("编号", "code"),
                      ("名称", "name"), ("说明", "desc")):
        if key in t:
            return role
    if "数据内容" in t or "告警数" in t or "据内容" in t:
        return "content"
    return None


def cell_text(c):
    return "\n".join(l["text"] for l in c["lines"]) if c else ""


def detect_header(t):
    hdr = 0
    for r in t["rows"][:3]:
        joined = nospace("".join(cell_text(c) for c in r["cells"]))
        has_value = any(HEX2.match(nospace(cell_text(c))) for c in r["cells"] if c)
        has_body = any(re.search(r"DI3DI2DI1DI0|=|：", nospace(cell_text(c))) for c in r["cells"] if c)
        if HEADER_RX.search(joined) and not has_value and not has_body and not re.search(r"(ARD|ERD|FD)\d", joined):
            hdr += 1
        else:
            break
    if hdr == 0:
        return 0, None
    roles = []
    for ci in range(len(t["cols"])):
        txt = "".join(cell_text(t["rows"][k]["cells"][ci]) for k in range(hdr) if t["rows"][k]["cells"][ci])
        roles.append(role_of(txt))
    last_fmt, nc = None, 0
    for i, r in enumerate(roles):
        if r in ("fmt_down", "fmt_up"):
            last_fmt = r
        elif r == "bytes" and last_fmt:
            roles[i] = "bytes_" + last_fmt.split("_")[1]
        elif r == "content":
            nc += 1
            if nc > 1:
                roles[i] = "content2"
    return hdr, roles


# ---------------------------------------------------------------- 格式记号 → 推断字节数
def infer_bytes(fmt):
    f = (fmt or "").strip().rstrip(",，").strip()
    f = re.sub(r"(?<=[A-Za-z])\s+\d+$", "", f)                  # 'NNNN 1' -> 'NNNN'
    f = re.sub(r"^(cc|YYMMDDhhmmss)\d$", r"\1", f)            # 'cc1' / 'YYMMDDhhmmss1'
    if f in ("—", "-"):
        return 0
    if not f:
        return None
    if f in ("A5……A0", "A6A5A4A3A2A1"):
        return 6
    if "…" in f or "..." in f:
        return None
    if f.upper() in ("BIN", "BCD", "ASCII"):
        return None
    if f == "DI3DI2DI1DI0":
        return 4
    body = f.replace(".", "")
    if not re.fullmatch(r"[0-9A-Za-z]+", body) or len(body) % 2:
        return None
    return len(body) // 2


# ---------------------------------------------------------------- DI 解析与范围展开
def di_token_lines(cell):
    out = []
    if cell:
        for l in cell["lines"]:
            for tok in l["text"].split():
                out.append((tok, l["y"]))
    return out


def expand_tokens(toks):
    out, bad = [], []
    for i, (t, y) in enumerate(toks):
        if HEX2.match(t):
            out.append((int(t, 16), y, "x"))
        elif ELL.match(t):
            nxt = next((int(tt, 16) for tt, _ in toks[i + 1:] if HEX2.match(tt)), None)
            prev = out[-1][0] if out else None
            if prev is None or nxt is None or nxt <= prev:
                bad.append(t)
                continue
            for v in range(prev + 1, nxt):
                out.append((v, y, "g"))
        else:
            bad.append(t)
    return out, bad


def interp_name(before, after, v0, v1, v):
    pb, pa = re.split(r"(\d+)", before), re.split(r"(\d+)", after)
    if len(pb) == len(pa):
        for i in range(1, len(pb), 2):
            if pb[i] != pa[i] and pb[:i] == pa[:i] and pb[i + 1:] == pa[i + 1:]:
                n0, n1 = int(pb[i]), int(pa[i])
                if n1 - n0 == v1 - v0:
                    return "".join(pb[:i]) + str(n0 + (v - v0)) + "".join(pb[i + 1:]), "both"
    # 单侧模板（应对规约笔误，如 '第四象限' vs '第四限'）：用前一个名称中最后一个数字递增
    nums = [i for i in range(1, len(pb), 2)]
    if nums:
        i = nums[-1]
        n0 = int(pb[i])
        return "".join(pb[:i]) + str(n0 + (v - v0)) + "".join(pb[i + 1:]), "one_side"
    return None, None


def bucket(items, anchors, tol=3.0):
    """把带 y 的 items 归到 y 不大于它（容差 tol）的最近 anchor；返回 {anchor_y: [items]}。"""
    ays = sorted(set(anchors))
    out = defaultdict(list)
    for it in items:
        cand = [a for a in ays if a <= it["y"] + tol]
        out[max(cand) if cand else ays[0]].append(it)
    return out


def aligned(lines, anchor_ys, tol=3.0, for_name=False, ell_ys=()):
    """lines 是否与 DI 值行逐行对齐。
    名称列：每个值行（允许缺 1 个，通常是 FF 块行）都有同高名称行，折行多出的行允许；
    属性列：每一行都贴着某个值行，且至少 2 个值行有对应行；
    共同约束：DI 列里 '…' 所在行，对应列也必须是 '…'（否则说明该列是整组共享的多行描述）。"""
    if len(lines) < 2 or len(anchor_ys) < 2:
        return False
    for ey in ell_ys:
        at = [l for l in lines if abs(l["y"] - ey) <= tol]
        if not at or not all(re.fullmatch(r"[…\.]+,?", nospace(l["text"])) for l in at):
            return False
    near = lambda y: any(abs(y - a) <= tol for a in anchor_ys)
    hit = [a for a in anchor_ys if any(abs(l["y"] - a) <= tol for l in lines)]
    if for_name:
        return len(hit) >= len(anchor_ys) - 1 and len(hit) >= 2
    return all(near(l["y"]) for l in lines) and len(hit) >= 2


def logical_lines(cell_lines, cell_x1):
    out = []
    for l in cell_lines:
        wrap = l.get("x1", 0) >= cell_x1 - 14
        if out and out[-1]["_wrap"]:
            out[-1]["text"] += l["text"]
            out[-1]["_wrap"] = wrap
            continue
        out.append({"y": l["y"], "text": l["text"], "_wrap": wrap})
    return out


def short_name(text):
    t = (text or "").strip()
    m = re.match(r"^(.+?)[：:，,。；]", t)
    if m and len(m.group(1)) >= 2:
        return m.group(1).strip()
    return t.rstrip("：:，,。；")


def struct_ref_of(text):
    m = re.search(r"(?:参见|见|参加)\s*([A-N]\.\d+(?:\.\d+)?)", nospace(text))
    return m.group(1) if m else None


# ---------------------------------------------------------------- 字段构造
def group_by_sum(fmt_lines, byte_lines):
    """按声明字节数顺序消费格式行，使每组推断字节之和等于声明值（如 NN.NNNN+YYMMDDhhmm=8）。"""
    i, groups = 0, []
    for b in byte_lines:
        bt = nospace(b["text"])
        if ELL.match(bt):
            if i < len(fmt_lines) and ELL.match(fmt_lines[i]["text"].strip()):
                groups.append((b, [fmt_lines[i]]))
                i += 1
                continue
            return None
        if not re.fullmatch(r"\d+", bt):
            return None
        n, acc, grp = int(bt), 0, []
        while i < len(fmt_lines) and acc < n:
            ib = infer_bytes(fmt_lines[i]["text"])
            if ib is None:
                return None
            acc += ib
            grp.append(fmt_lines[i])
            i += 1
        if acc != n:
            return None
        groups.append((b, grp))
    return groups if i == len(fmt_lines) else None


def period_fields(lines):
    """范围行共用格式且格式列写成 'A, B, A, B, …' 时，取一个周期 [A, B]。"""
    norm = [l["text"].rstrip(",，").strip() for l in lines]
    if "…" in norm:
        norm = norm[:norm.index("…")]
    for p in range(1, len(norm) // 2 + 1):
        if norm[:p] == norm[p:2 * p]:
            return lines[:p]
    return None


def expand_numbered(fields, fmt_lines, name_lines):
    """把 '…' 两侧带序号的字段展开成定长：序号取自格式记号尾数（cc2 / NNNN 2）或同高名称行里的数字。
    例：MM, NNNN 1, NNNN 2, …, NNNN 8 → 1+8×2=17 字节；cc2, NNNN 2, …, cc8, NNNN 8 → 周期 2。"""
    idx = [i for i, f in enumerate(fields) if f["fmt"] in ("…", "…,")]
    if len(idx) != 1 or len(fields) != len(fmt_lines):
        return None
    k = idx[0]

    def num_of(i):
        t = fmt_lines[i]["text"].strip().rstrip(",，").strip()
        if t != "DI3DI2DI1DI0":
            m = re.search(r"[A-Za-z]\s*(\d+)$", t)
            if m:
                return int(m.group(1))
        for l in name_lines:
            if abs(l["y"] - fmt_lines[i]["y"]) <= 3:
                m = re.search(r"(\d+)\D*$", l["text"])
                if m:
                    return int(m.group(1))
        return None
    if k == 0 or k == len(fields) - 1:
        return None
    a, b = num_of(k - 1), num_of(k + 1)
    if a is None or b is None or b <= a:
        return None
    p = 0
    for j in range(k - 1, -1, -1):
        if num_of(j) == a:
            p += 1
        else:
            break
    tmpl = fields[k - p:k]
    out = list(fields[:k])
    for n in range(a + 1, b):
        for f in tmpl:
            g = dict(f)
            g["fmt"] = re.sub(r"(?<=[A-Za-z])(\s*)\d+$", r"\g<1>" + str(n), f["fmt"])
            g["expanded"] = True
            out.append(g)
    return out + fields[k + 1:]


def build_fields(fmt_lines, byte_lines, name_llines, name_lines=None):
    """格式行按 y 归入字节行（一个字节行可对应多行格式，如 '次数+累计时间' 共 6 字节）。"""
    fields, flags = [], []
    if not fmt_lines:
        bt = nospace("".join(b["text"] for b in byte_lines))
        return fields, (int(bt) if re.fullmatch(r"\d+", bt) else None), flags
    groups = group_by_sum(fmt_lines, byte_lines) if len(byte_lines) > 1 else None
    if groups is None:
        if len(byte_lines) <= 1:
            groups = [(byte_lines[0] if byte_lines else None, fmt_lines)]
        else:
            bk = bucket(fmt_lines, [b["y"] for b in byte_lines])
            groups = [(b, bk.get(b["y"], [])) for b in byte_lines]
    total, unknown = 0, False
    for b, fls in groups:
        btxt = nospace(b["text"]) if b else ""
        for f in fls:
            fmt = f["text"].rstrip(",，").strip()
            fields.append({"fmt": fmt, "bytes": None, "bytes_inferred": infer_bytes(fmt)})
        grp = fields[len(fields) - len(fls):]
        if re.fullmatch(r"\d+", btxt):
            n = int(btxt)
            total += n
            if len(grp) == 1:
                grp[0]["bytes"] = n
            inf = [g["bytes_inferred"] for g in grp]
            if grp and all(i is not None for i in inf) and sum(inf) != n:
                flags.append(f"bytes_mismatch:{'+'.join(g['fmt'] for g in grp)}={n}(推断{sum(inf)})")
            if len(grp) > 1 and all(i is not None for i in inf):
                for g in grp:
                    g["bytes"] = g["bytes_inferred"]
        else:
            unknown = True
    for f in fields:
        tok = re.sub(r"\s*\d+$", "", f["fmt"]).strip()
        if not tok or tok in ("…",):
            continue
        for L in name_llines:
            m = re.match(r"^\s*" + re.escape(tok) + r"\s*\d*\s*[：:]\s*(.+)$", L["text"])
            if m:
                f["label"] = m.group(1).strip()
                break
    btxt_all = nospace("".join(b["text"] for b in byte_lines))
    exp = expand_numbered(fields, fmt_lines, name_lines or [])
    if exp is not None:
        fields = exp
        flags.append("numbered_ellipsis_rule")
        if all(isinstance(f.get("bytes") or f.get("bytes_inferred"), int) for f in fields):
            return fields, sum((f.get("bytes") or f.get("bytes_inferred")) for f in fields), flags
    if "变" in btxt_all:
        return fields, "var", flags
    if any(f["fmt"] in ("…", "…,") for f in fields) or "…" in btxt_all:
        return fields, "var", flags
    if unknown:
        return fields, (btxt_all or None), flags
    return fields, total, flags


def rate_block(fields):
    """费率数据块：NN(费率数 m) + (m+1)×item。"""
    if len(fields) >= 3 and fields[0]["fmt"] == "NN" and any(f["fmt"] == "…" for f in fields):
        k = next(i for i, f in enumerate(fields) if f["fmt"] == "…")
        item = fields[1:k]
        if item and all(f.get("bytes_inferred") for f in item):
            return {"count": "费率数+1", "count_field": {"fmt": "NN", "bytes": 1},
                    "item": [{"fmt": f["fmt"], "bytes": f["bytes_inferred"]} for f in item],
                    "item_bytes": sum(f["bytes_inferred"] for f in item)}
    return None


# ---------------------------------------------------------------- 主流程
def extract(grid):
    entries, rows_out, structs = [], [], OrderedDict()
    state = {"appendix": None, "section": None, "title": None, "caption": None, "dir": None}
    last_hdr = None          # (cols, roles, page, appendix) 用于无表头续表
    last_group = None
    for pg in grid:
        page = pg["page"]
        events = [(l["y"], 0, "text", l) for l in pg["outside"]] + \
                 [(t["bbox"][1], 1, "table", t) for t in pg["tables"]]
        events.sort(key=lambda e: (e[0], e[1]))
        for _, _, kind, obj in events:
            if kind == "text":
                update_state(state, obj["text"].strip())
                continue
            t = obj
            hdr, roles = detect_header(t)
            if roles is None:
                ok = last_hdr and last_hdr[2] in (page, page - 1) and last_hdr[3] == state["appendix"] and \
                    len(last_hdr[0]) == len(t["cols"]) and \
                    all(abs((a[1] - a[0]) - (b[1] - b[0])) < 4 for a, b in zip(last_hdr[0], t["cols"]))
                if not ok:
                    last_group = None
                    continue
                roles = last_hdr[1]
                last_hdr = (t["cols"], roles, page, state["appendix"])
            else:
                compatible = last_hdr and last_hdr[2] in (page, page - 1) and len(last_hdr[0]) == len(t["cols"]) and \
                    all(abs((a[1] - a[0]) - (b[1] - b[0])) < 4 for a, b in zip(last_hdr[0], t["cols"]))
                if not (set(DI_ROLES) <= set(roles)) and compatible and set(DI_ROLES) <= set(last_hdr[1]):
                    roles = last_hdr[1]
                last_hdr = (t["cols"], roles, page, state["appendix"])
            data_rows = t["rows"][hdr:]
            ctx = dict(appendix=state["appendix"], section=state["section"], title=state["title"],
                       caption=state["caption"], page=page, printed=page - 4)
            rset = set(r for r in roles if r)
            if set(DI_ROLES) <= rset and ({"fmt", "fmt_down"} & rset):
                last_group = parse_di_table(roles, data_rows, ctx, entries, rows_out, last_group)
            elif set(DI_ROLES) <= rset:
                parse_index_table(roles, data_rows, ctx, entries, rows_out)
                last_group = None
            elif "code" in rset or ("content" in rset and "fmt" in rset):
                parse_content_table(roles, data_rows, ctx, structs, state)
                last_group = None
            else:
                last_group = None
    post_process(entries, structs)
    stats = make_stats(entries, rows_out, structs)
    for e in entries:
        e.pop("_gid", None)
        if e.get("range_generated"):
            e.pop("desc", None)          # 范围展开项的说明与范围首项相同，省略以减小体积
    return entries, structs, stats


def update_state(state, s):
    m = re.match(r"^附录\s*([A-N])$", s)
    if m:
        state.update(appendix=m.group(1), section=m.group(1), title=None, caption=None)
        return
    m = re.match(r"^([A-N])\s*\.\s*(\d+(?:\.\d+)*)\s*(\S.{0,18})$", s)
    if m and "，" not in s and "参见" not in s:
        state.update(appendix=m.group(1), section=f"{m.group(1)}.{m.group(2)}", title=nospace(m.group(3)),
                     caption=None, dir=None)
        return
    m = re.match(r"^表\s*([A-N]\s*\.?\s*[\d.]+)\s*(.*)$", s)
    if m:
        state["caption"] = "表 " + nospace(m.group(1)) + " " + nospace(m.group(2))
        return
    if "下行数据格式" in s:
        state["dir"] = "down"
    elif "上行数据格式" in s:
        state["dir"] = "up"


def column_cells(rows, roles, role):
    if role not in roles:
        return []
    ci = roles.index(role)
    seen, out = set(), []
    for r in rows:
        c = r["cells"][ci]
        if c and c["cell"] not in seen:
            seen.add(c["cell"])
            out.append(c)
    return out


def col_lines(rows, roles, role):
    out = []
    for c in column_cells(rows, roles, role):
        out += [dict(l) for l in c["lines"]]
    return out


def parse_di_table(roles, data_rows, ctx, entries, rows_out, last_group):
    di_idx = [roles.index(k) for k in DI_ROLES]
    groups = []
    for r in data_rows:
        key = tuple(r["cells"][i]["cell"] if r["cells"][i] else None for i in di_idx)
        if not any(nospace(cell_text(r["cells"][i])) for i in di_idx):
            if groups:
                groups[-1]["rows"].append(r)
                groups[-1]["cont"] = True
            elif last_group is not None:
                last_group["rows"].append(r)
                last_group["cont_page"] = True
                for e in [e for e in entries if e.get("_gid") == id(last_group)]:
                    entries.remove(e)
                rows_out[:] = [x for x in rows_out if x.get("_gid") != id(last_group)]
                emit_group(last_group, roles, entries, rows_out)
            continue
        if groups and groups[-1]["key"] == key:
            groups[-1]["rows"].append(r)
        else:
            groups.append({"key": key, "rows": [r], "ctx": ctx})
    for g in groups:
        emit_group(g, roles, entries, rows_out)
    return groups[-1] if groups else last_group


def emit_group(g, roles, entries, rows_out):
    rows, ctx = g["rows"], g["ctx"]
    di_idx = [roles.index(k) for k in DI_ROLES]
    flags = []
    parts = []
    for i in di_idx:
        toks = di_token_lines(rows[0]["cells"][i])
        vals, bad = expand_tokens(toks)
        if bad:
            flags.append("di_token_bad:" + "/".join(bad))
        parts.append({"toks": toks, "vals": vals})
    varying = [k for k, p in enumerate(parts) if len(p["vals"]) > 1]
    if any(len(p["vals"]) == 0 for p in parts):
        flags.append("di_incomplete")
    if len(varying) > 1:
        flags.append("di_multi_varying")
    k = varying[0] if len(varying) == 1 else 3
    di_list = []
    if not any(len(p["vals"]) == 0 for p in parts) and len(varying) <= 1:
        for v, y, how in parts[k]["vals"]:
            b4 = [p["vals"][0][0] for p in parts]
            b4[k] = v
            di_list.append(("".join(f"{b:02X}" for b in b4), v, y, how))
    anchor_ys = sorted(set(y for _, y in parts[k]["toks"])) if parts[k]["toks"] else []
    ell_ys = sorted(set(y for t, y in parts[k]["toks"] if ELL.match(t)))
    base_toks = [p["toks"][0][0] for p in parts if p["toks"]]
    src = find_source_line(ctx["page"], base_toks)

    name_role = "name" if "name" in roles else ("desc" if "desc" in roles else None)
    name_cells = column_cells(rows, roles, name_role) if name_role else []
    nlines = [dict(l) for c in name_cells for l in c["lines"]]
    cell_x1 = name_cells[0]["x1"] if name_cells else 0
    llines = logical_lines(nlines, cell_x1)
    full_desc = "\n".join(L["text"] for L in llines)
    fmt_role = "fmt" if "fmt" in roles else "fmt_down"
    byte_role = "bytes" if "bytes" in roles else "bytes_down"
    attr = {a: col_lines(rows, roles, a) for a in (fmt_role, byte_role, "unit", "r", "w")}
    multi = len(di_list) > 1
    # 每个属性列：与 DI 值行对齐则逐 DI 取值，否则整组共享
    per_di = {a: (multi and aligned(ls, anchor_ys, ell_ys=ell_ys)) for a, ls in attr.items()}
    name_aligned = multi and aligned(nlines, anchor_ys, for_name=True, ell_ys=ell_ys)
    if multi and not name_aligned:
        flags.append("name_shared")

    def lines_for(a, y):
        if not per_di[a]:
            return attr[a]
        return bucket(attr[a], anchor_ys).get(y, [])

    name_bucket = bucket(nlines, anchor_ys) if name_aligned else {}
    name_x = {}
    for d, v, y, how in di_list:
        if how == "x" and name_aligned:
            name_x[d] = "".join(l["text"] for l in name_bucket.get(y, []))
    # 生成 DI 条目
    group_entries = []
    for idx, (d, v, y, how) in enumerate(di_list):
        fl = list(flags)
        e = OrderedDict()
        e["di"] = d
        # 名称
        if not multi:
            e["name"] = short_name(llines[0]["text"]) if llines else ""
            if re.fullmatch(r"[0-9A-F]{2}", e["name"]) and ctx.get("title"):
                e["name"] = ctx["title"]
                fl.append("name_from_section")
        elif name_aligned and how == "x":
            e["name"] = name_x.get(d, "").strip()
        elif name_aligned:
            prev = max(((dd, vv) for dd, vv, yy, hh in di_list[:idx] if hh == "x"), key=lambda t: t[1], default=None)
            nxt = next(((dd, vv) for dd, vv, yy, hh in di_list[idx:] if hh == "x"), None)
            nm, mode = (None, None)
            if prev and nxt:
                nm, mode = interp_name(name_x.get(prev[0], ""), name_x.get(nxt[0], ""), prev[1], nxt[1], v)
            if nm:
                e["name"] = nm
                fl.append("name_interpolated" if mode == "both" else "name_interpolated_one_side")
            else:
                e["name"] = f"{short_name(name_x.get(prev[0], '') if prev else '')}[{v:02X}]"
                fl.append("name_not_interpolated")
        else:
            base = short_name(llines[0]["text"]) if llines else ""
            e["name"] = f"{base}[{v:02X}]"
        if not e["name"].strip("[]0123456789ABCDEF"):
            fl.append("name_missing")
        # 格式/字节
        yy = y
        if how == "g" and any(per_di.values()):
            # 省略号生成值：取紧邻的显式值所在行（省略号行通常是 '…'）
            prevx = max((yy2 for dd, vv, yy2, hh in di_list[:idx] if hh == "x"), default=y)
            yy = prevx
        fmt_l, byte_l = lines_for(fmt_role, yy), lines_for(byte_role, yy)
        if multi and not per_di[fmt_role] and len(fmt_l) > 1 and len(byte_l) <= 1:
            pf = period_fields(fmt_l)
            if pf:
                fmt_l = pf
                fl.append("fmt_period_rule")
        fields, total, bflags = build_fields(fmt_l, byte_l, llines, nlines)
        fl += bflags
        e["format"] = ", ".join(f["fmt"] for f in fields)
        e["bytes"] = total
        e["unit"] = " ".join(dict.fromkeys(l["text"] for l in lines_for("unit", yy)))
        if "r" in roles:
            e["rw"] = ("r" if any("*" in l["text"] for l in lines_for("r", yy)) else "") + \
                      ("w" if any("*" in l["text"] for l in lines_for("w", yy)) else "")
        else:
            e["rw"] = None
        e["appendix"], e["section"], e["table"] = ctx["appendix"], ctx["section"], ctx["caption"]
        e["pdf_page"], e["printed_page"], e["source_line"] = ctx["page"], ctx["printed"], src
        e["desc"] = full_desc
        if len(fields) > 1 or any(f.get("label") for f in fields):
            e["fields"] = fields
        if "fmt_up" in roles:
            e["name"] = e["name"] or ctx.get("title") or ""
            e["fields_down"] = [{"label": l["text"]} for l in attr[fmt_role]]
            e["fields_up"] = list(OrderedDict((l["text"], {"label": l["text"]})
                                              for l in col_lines(rows, roles, "fmt_up")).values())
            ub = col_lines(rows, roles, "bytes_up")
            e["bytes_up"] = ub[0]["text"] if ub else None
            e["format"] = "struct:H.1"
            fl = [x for x in fl if x != "name_missing"]
        if multi:
            e["range_base"] = "".join(base_toks)
            e["range_generated"] = (how == "g")
        sref = struct_ref_of(full_desc)
        if sref and sref not in ("C.5.1",):
            e["struct_ref"] = sref
        mcol = re.search(r"%s\s*表示\s*([0-9A-F]{2})\s*[~～]\s*([0-9A-F]{2})\s*集合" % d[6:8], nospace(full_desc))
        rb = rate_block(fields)
        if multi and mcol:
            e["kind"] = "collection"
            lo, hi = int(mcol.group(1), 16), int(mcol.group(2), 16)
            e["collection_of"] = [d[:6] + f"{x:02X}" for x in range(lo, hi + 1)]
            if isinstance(total, int):
                e["bytes"] = total * len(e["collection_of"])
            fl.append("collection_by_desc_rule")
        if e.get("kind") == "collection":
            pass
        elif re.search(r"以上数据(项)?集合", full_desc) and not fields:
            e["kind"] = "collection"
        elif rb:
            e["kind"] = "rate_block"
            e["rate_block"] = rb
        elif d[4:6] == "FF" or d[6:8] == "FF" or "数据块" in e["name"]:
            e["kind"] = "block"
        else:
            e["kind"] = "item"
        if e["kind"] == "rate_block":
            fl = [x for x in fl if x != "var_length"]
            fl.append("rate_block_rule")
        if total == "var" and e["kind"] != "rate_block":
            fl.append("var_length")
        elif total is None and fields:
            fl.append("bytes_unknown")
        if not fields and e["kind"] == "item" and not e.get("fields_down"):
            if e.get("struct_ref"):
                fl.append("format_from_struct")
                e["format"] = "struct:" + e["struct_ref"]
            elif total is None:
                fl.append("no_format")
        if e.get("struct_ref") and total == "var":
            fl = [x for x in fl if x != "var_length"]
            fl.append("format_from_struct")
        if g.get("cont_page"):
            fl.append("cross_page_row")
        if src is None:
            fl.append("source_line_not_found")
        misal = [a for a in (fmt_role, byte_role) if multi and attr[a] and not per_di[a] and len(attr[a]) > 1
                 and len(attr[a]) != len(anchor_ys) and not fields and total != "var" and not e.get("struct_ref")]
        if misal:
            fl.append("attr_misaligned")
        e["flags"] = sorted(set(fl))
        e["_gid"] = id(g)
        group_entries.append(e)
    # 块：成员字节数求和（'01…09,FF' 这种同行列举的块）
    members = [x for x in group_entries if x["kind"] == "item"]
    for e in group_entries:
        if e["kind"] == "block" and members and len(group_entries) > 1:
            bs = [m["bytes"] for m in members]
            if any("费率" in m["name"] for m in members):
                e["flags"] = sorted(set(e["flags"]) | {"block_irregular_rate"})
                e["bytes"] = "var"
                e["format"] = "rate_block?"
            elif all(isinstance(b, int) for b in bs):
                e["bytes"] = sum(bs)
                e["block_of"] = [m["di"] for m in members]
                fm = [m["format"] for m in members]
                e["format"] = f"{len(members)}×{fm[0]}" if len(set(fm)) == 1 else "block"
                e["flags"] = sorted(set(x for x in e["flags"] if x not in ("var_length", "bytes_unknown", "no_format"))
                                    | {"block_sum_rule"})
    for e in group_entries:
        if not e["format"] and "同上" in e["desc"]:
            prev = next((x for x in reversed(entries) if x["format"] and x["appendix"] == e["appendix"]), None)
            if prev:
                for key in ("format", "bytes", "unit", "fields"):
                    if key in prev:
                        e[key] = prev[key]
                e["same_as"] = prev["di"]
                e["flags"] = sorted(set(x for x in e["flags"] if x != "no_format") | {"same_as_prev_rule"})
        e["needs_manual"] = any(x.split(":")[0] in MANUAL_FLAGS for x in e["flags"])
        entries.append(e)
    rows_out.append({"appendix": ctx["appendix"], "page": ctx["page"], "base": "".join(base_toks),
                     "n": len(group_entries), "needs_manual": any(e["needs_manual"] for e in group_entries),
                     "_gid": id(g)})


def parse_index_table(roles, data_rows, ctx, entries, rows_out):
    di_idx = [roles.index(k) for k in DI_ROLES]
    for r in data_rows:
        toks = [nospace(cell_text(r["cells"][i])) for i in di_idx]
        if not all(HEX2.match(x) for x in toks):
            continue
        d = "".join(toks)
        name = nospace(cell_text(r["cells"][roles.index("name")])) if "name" in roles else ""
        desc = nospace(cell_text(r["cells"][roles.index("desc")])) if "desc" in roles else ""
        m = re.search(r"(ARD|ERD|FD)\d+", desc)
        kind = {"E2": "alarm", "E3": "file"}.get(d[:2], "other")
        if d.startswith("E201"):
            kind = "event"
        if d.endswith("FF"):
            kind = "query"
        e = OrderedDict(di=d, name=name, format=None, bytes=None, unit="", rw=None,
                        appendix=ctx["appendix"], section=ctx["section"], table=ctx["caption"],
                        pdf_page=ctx["page"], printed_page=ctx["printed"],
                        source_line=find_source_line(ctx["page"], toks), desc=desc,
                        struct_ref=m.group(0) if m else None, kind=kind)
        fl = []
        if not m and kind != "query":
            fl.append("ref_unresolved")
        e["flags"] = fl
        e["needs_manual"] = bool(fl)
        entries.append(e)
        rows_out.append({"appendix": ctx["appendix"], "page": ctx["page"], "base": d, "n": 1,
                         "needs_manual": bool(fl)})


def parse_content_table(roles, data_rows, ctx, structs, state):
    """D.2(ARD) / E.2(ERD) / G.2(FD) / A.9.2 / A.10.x 等无 DI 的复合结构表，逐行收集。"""
    code_i = roles.index("code") if "code" in roles else None
    cur = None
    for r in data_rows:
        if code_i is not None:
            code = nospace(cell_text(r["cells"][code_i]))
            if code:
                cur = code if code != "FD3" else f"FD3_{state.get('dir') or 'down'}"
            elif cur is None:
                cur = state.get("last_code")      # 跨页续表：编号列为空，沿用上一页最后的编号
            if cur is None:
                continue
            state["last_code"] = cur
        else:
            cur = ctx["section"]
        s = structs.setdefault(cur, {"section": ctx["section"], "table": ctx["caption"],
                                     "printed_page": ctx["printed"], "rows": [], "_seen": set()})
        items = []
        for ci, role in enumerate(roles):
            if role in (None, "code"):
                continue
            c = r["cells"][ci]
            if not c or c["cell"] + role in s["_seen"]:
                continue
            s["_seen"].add(c["cell"] + role)
            for l in c["lines"]:
                items.append((l["y"], role, l["text"]))
        items.sort()
        merged = []
        for y, role, txt in items:
            if merged and abs(merged[-1]["y"] - y) <= 3.0:
                merged[-1]["cols"].setdefault(role, []).append(txt)
            else:
                merged.append({"y": y, "cols": {role: [txt]}})
        for m in merged:
            s["rows"].append({k: " ".join(v) for k, v in m["cols"].items()})


def parse_ard_erd(rows):
    fields, group, flags, pending = [], None, [], None
    for row in rows:
        order = ["content", "DI3", "fmt", "bytes", "content2", "desc"]
        s = cjk_squeeze(" | ".join(row[k] for k in sorted(row, key=lambda k: order.index(k) if k in order else 9)))
        if not s.strip():
            continue
        mg = re.match(r"^(发生时数据|发生前数据|发生后数据)[：:]\s*\|?\s*(.*)$", s)
        if mg:
            group = mg.group(1)
            if mg.group(2).strip():
                pending = mg.group(2).strip(" |")
            continue
        m = re.search(r"DI3DI2DI1DI0\s*(\d+)?\s*=\s*([0-9A-F]{8})\s*H", s)
        if m:
            label = s[m.end():].strip(" |）)")
            if not label:
                label = re.sub(r"[（(]?\s*DI3DI2DI1DI0.*$", "", s).strip(" |")
            label = re.sub(r"[（(]\s*$", "", label)
            if pending:
                label = pending + label
                pending = None
                flags.append("label_row_shift")
            fields.append({"group": group, "ref": m.group(2), "label": label or None})
            continue
        if s.startswith("告警状态"):
            fields.append({"group": None, "label": "告警状态", "fmt": "NN", "bytes": 1})
            continue
        m = re.search(r"(YYMMDDhhmmssms|YYMMDDhhmmss)", s)
        if m:
            fields.append({"group": group, "label": re.sub(r"[（(].*$", "", s).strip(" |"),
                           "fmt": m.group(1), "bytes": 6 if m.group(1) == "YYMMDDhhmmss" else None})
            if m.group(1) != "YYMMDDhhmmss":
                flags.append("time_ms_bytes_unknown")
            continue
        if s.strip(" |") == "不带参数":
            continue
        mf = re.match(r"^((?:NN|MM|A6A5A4A3A2A1|NNN\.N|NNNNNN)[A-Za-z0-9.]*)\s*,?\s*(?:\|\s*(.*))?$", s.strip())
        if mf and infer_bytes(mf.group(1)) is not None:
            fields.append({"group": group, "label": (mf.group(2) or "").strip() or None, "fmt": mf.group(1),
                           "bytes": infer_bytes(mf.group(1))})
            continue
        if s.strip(" |") in ("发生次数",):
            group = s.strip(" |")
            continue
        if fields and fields[-1].get("ref") and not fields[-1].get("label"):
            fields[-1]["label"] = s.strip(" |")
            flags.append("label_row_shift")
            continue
        fields.append({"group": group, "label": s.strip(" |"), "fmt": None, "bytes": None})
    # 名称行先于引用行出现（垂直居中错位）：纯标签 + 紧随的无标签引用 → 合并
    out = []
    for f in fields:
        if f.get("ref") and not f.get("label") and out and not out[-1].get("ref") and out[-1].get("fmt") is None \
                and out[-1].get("bytes") is None and out[-1].get("label"):
            f["label"] = out.pop()["label"]
            flags.append("label_row_shift")
        out.append(f)
    return out, flags


def post_process(entries, structs):
    by_di = {}
    for e in entries:
        if e["di"] in by_di:
            same = all(by_di[e["di"]].get(k) == e.get(k) for k in ("name", "format", "bytes"))
            e["flags"] = sorted(set(e["flags"]) | {"duplicate_di_same" if same else "duplicate_di_conflict"})
            if not same:
                e["needs_manual"] = True
        else:
            by_di[e["di"]] = e
    # 集合项
    for i, e in enumerate(entries):
        if e.get("kind") != "collection":
            continue
        pref, members = e["di"][:6], []
        for x in entries[:i]:
            if x["di"][:6] != pref or x.get("section") != e.get("section"):
                continue
            if x.get("kind") == "collection":
                members = []
            elif x.get("kind") == "item":
                members.append(x)
        e["collection_of"] = [m["di"] for m in members]
        e["format"] = "collection"
        bs = [m["bytes"] for m in members]
        if members and all(isinstance(b, int) for b in bs):
            ssum = sum(bs)
            if e["bytes"] in (None, ""):
                e["bytes"] = ssum
                e["flags"].append("collection_sum_rule")
            elif e["bytes"] != ssum:
                e["flags"].append(f"collection_mismatch:{ssum}!={e['bytes']}")
        elif e["bytes"] in (None, ""):
            e["flags"].append("bytes_unknown")
        e["flags"] = sorted(set(x for x in e["flags"] if x != "no_format"))
        e["needs_manual"] = any(x.split(":")[0] in MANUAL_FLAGS for x in e["flags"])
    # 复合结构
    for key, s in structs.items():
        s.pop("_seen", None)
        rows = s.pop("rows")
        if key.startswith(("ARD", "ERD")):
            fields, flags = parse_ard_erd(rows)
        else:
            fields, flags = [], []
            for row in rows:
                f = {"label": row.get("content") or row.get("content2") or row.get("desc"),
                     "fmt": row.get("fmt"), "bytes": row.get("bytes"), "note": row.get("desc")}
                if f["bytes"] and re.fullmatch(r"\d+", nospace(f["bytes"])):
                    f["bytes"] = int(nospace(f["bytes"]))
                fields.append(f)
        unresolved = []
        for f in fields:
            if f.get("ref"):
                ref = by_di.get(f["ref"])
                if ref:
                    f["fmt"], f["bytes"], f["ref_name"] = ref["format"], ref["bytes"], ref["name"]
                    if not isinstance(ref["bytes"], int):
                        unresolved.append(f["ref"] + "(字节数未定)")
                else:
                    unresolved.append(f["ref"])
            elif key.startswith(("ARD", "ERD")) and f.get("bytes") is None:
                unresolved.append("?" + (f.get("label") or "")[:14])
        norm = lambda t: re.sub(r"\(当前\)|（当前）|\s|能$", "", t or "").replace("象限", "限")
        kept = []
        for i, f in enumerate(fields):
            if not f.get("ref") and f.get("bytes") is None and f.get("label"):
                near = [g for g in fields[max(0, i - 2):i + 3] if g.get("ref_name")]
                if any(norm(f["label"]) == norm(g["ref_name"]) for g in near):
                    flags.append("label_row_shift")
                    continue
            kept.append(f)
        fields = kept
        unresolved = [u for u in unresolved if not (u.startswith("?") and not any(
            (f.get("label") or "")[:14] == u[1:] for f in fields if not f.get("ref") and f.get("bytes") is None))]
        s["fields"] = fields
        s["raw_rows"] = rows
        s["flags"] = flags + ([f"unresolved:{'；'.join(unresolved)}"] if unresolved else [])
        bs = [f.get("bytes") for f in fields]
        s["bytes"] = sum(bs) if bs and all(isinstance(b, int) for b in bs) else None
    for e in entries:
        ref = e.get("struct_ref")
        if not ref or not ref.startswith(("ARD", "ERD", "FD")):
            continue
        s = structs.get(ref) or structs.get(ref + "_down")
        if s:
            e["format"] = "struct:" + ref
            e["bytes"] = s.get("bytes") if s.get("bytes") is not None else "struct"
            if any(f.startswith(("unresolved", "time_ms")) for f in s["flags"]):
                e["flags"] = sorted(set(e["flags"]) | {"struct_needs_manual"})
        else:
            e["flags"] = sorted(set(e["flags"]) | {"ref_unresolved"})
        e["needs_manual"] = any(x.split(":")[0] in MANUAL_FLAGS for x in e["flags"])


def make_stats(entries, rows_out, structs):
    st = OrderedDict()
    by_app = defaultdict(list)
    for e in entries:
        by_app[e["appendix"]].append(e)
    rows_by_app = defaultdict(list)
    for r in rows_out:
        rows_by_app[r["appendix"]].append(r)
    for app in sorted(by_app):
        es = by_app[app]
        complete = [e for e in es if e["name"] and e["format"] and isinstance(e["bytes"], int) and not e["needs_manual"]]
        st[app] = OrderedDict(
            table_rows=len(rows_by_app[app]),
            table_rows_needs_manual=sum(1 for r in rows_by_app[app] if r["needs_manual"]),
            di_entries=len(es), range_generated=sum(1 for e in es if e.get("range_generated")),
            complete=len(complete), needs_manual=sum(1 for e in es if e["needs_manual"]))
    fc = Counter()
    for e in entries:
        for f in set(x.split(":")[0] for x in e["flags"]):
            fc[f] += 1
    st["flags"] = dict(fc.most_common())
    st["total_entries"] = len(entries)
    st["total_needs_manual"] = sum(1 for e in entries if e["needs_manual"])
    st["total_table_rows"] = len(rows_out)
    st["total_table_rows_needs_manual"] = sum(1 for r in rows_out if r["needs_manual"])
    st["structs"] = {k: {"fields": len(v["fields"]), "bytes": v.get("bytes"), "flags": v["flags"]}
                     for k, v in structs.items()}
    for r in rows_out:
        r.pop("_gid", None)
    return st


def review_rows(entries):
    """需人工处理的条目（按表格行聚合），供 review_text() 输出。"""
    seen, rows = set(), []
    for e in entries:
        if not e["needs_manual"]:
            continue
        key = e.get("range_base") or e["di"]
        if key in seen:
            continue
        seen.add(key)
        rows.append((key, bool(e.get("range_base")), e["appendix"], e["printed_page"],
                     ",".join(x for x in e["flags"] if x.split(":")[0] in MANUAL_FLAGS), e["name"], e["format"], e["bytes"]))
    return rows


# ============================================================ 仓库版新增：转换、压缩、合并 overrides、输出
import argparse
import pathlib

sys.dont_write_bytecode = True  # 不在仓库里留下 __pycache__
import grid as grid_mod  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
DICT_JS = HERE.parent / "src" / "di_dict.js"
REVIEW = HERE / "review.tsv"
OVERRIDES = HERE / "overrides.json"
SENTINEL = "// 自动生成，勿手改｜来源：Q/CSG1209022-2019 + gen/overrides.json｜生成器：gen/extract_di.py"

TIME_RX = re.compile(r"^(YYYY|YY|MM|DD|hh|HH|mm|ss|WW)+$")
NUM_RX = re.compile(r"^(0?S)?[NX]+(\.[NX]+)?$")
BLOCK_RX = re.compile(r"^(\d+)×(.+)$")
IMPLIED_SIGN = {"NN.NNNN", "NNN.NNN", "N.NNN"}  # 附录 C.2 注 1、注 2：功率/需量、电流、功率因数最高位为符号位


def fmt_to_field(fmt, nbytes, name, unit="", hint="", appendix=""):
    """规约「数据格式」记号 → 运行时 Field（design §5.4）。hint 为字段名或说明，用于识别 BIN、ASCII。"""
    tok = (fmt or "").replace(" ", "")
    f = {"name": name or "数据", "bytes": nbytes}
    if unit:
        f["unit"] = unit
    if nbytes == 0:
        return {**f, "enc": "hex"}
    if "ASCII" in hint:
        return {**f, "enc": "ascii", "order": "be"}
    if tok == "BIN" or "BIN" in hint:
        return {**f, "enc": "bin"}
    tok = {"MDDhhmm": "MMDDhhmm", "MMDDHHmm": "MMDDhhmm"}.get(tok, tok)  # 规约笔误、大小写不一
    if TIME_RX.match(tok):
        return {**f, "enc": "time", "fmt": tok}
    if NUM_RX.match(tok):
        body = tok.split("S")[-1] if "S" in tok else tok
        out = {**f, "enc": "bcd"}
        if "." in body:
            out["dec"] = len(body.split(".")[1])
        if "S" in tok or (appendix == "C" and body.replace("X", "N") in IMPLIED_SIGN):
            out["sign"] = "msb"
        return out
    if re.match(r"^A\d……A\d$", tok) or ("地址" in (name or "") and nbytes == 6):
        return {**f, "enc": "bcd"}
    return {**f, "enc": "hex"}


def block_fields(e, by_di):
    """「9×NNN.N」这类数据块：按成员 DI（FF 所在字节换成 01…）取名称。"""
    m = BLOCK_RX.match(e["format"].replace(" ", ""))
    n, fmt = int(m.group(1)), m.group(2)
    k = next((i for i in range(4) if e["di"][2 * i:2 * i + 2] == "FF"), None)
    members = []
    if k is not None:
        i = 2 * k
        members = sorted((x for x in by_di.values()
                          if x["di"][:i] == e["di"][:i] and x["di"][i + 2:] == e["di"][i + 2:] and x["di"][i:i + 2] != "FF"),
                         key=lambda x: x["di"])
    names = [x["name"] for x in members[:n]] if len(members) >= n else [f"{e['name']}[{j + 1}]" for j in range(n)]
    per = e["bytes"] // n if isinstance(e["bytes"], int) else "var"
    return [fmt_to_field(fmt, per, nm, e.get("unit") or "", "", e["appendix"]) for nm in names]


def entry_def(e, by_di, name=None):
    nb = e["bytes"] if isinstance(e["bytes"], int) else "var"
    d = {"name": name or e["name"], "tier": "自动", "src": f"{e.get('section') or e['appendix']} 印{e['printed_page']}",
         "rw": e.get("rw") or "", "bytes": nb}
    if e.get("struct_ref"):
        d["struct"] = e["struct_ref"]
        return d
    fmt = (e.get("format") or "").replace(" ", "")
    fields = e.get("fields") or []
    ftoks = [(x.get("fmt") or "").replace(" ", "") for x in fields]
    if nb == 0:
        d["fields"] = []
    elif BLOCK_RX.match(fmt):
        d["fields"] = block_fields(e, by_di)
    elif len(fields) > 2 and ftoks[0] == "NN" and any(ELL.match(t) for t in ftoks):
        item = fmt_to_field(ftoks[1], fields[1].get("bytes") or 4, "", e.get("unit") or "", "", e["appendix"])
        d["fields"] = [{"name": "费率数", "bytes": 1, "enc": "bcd"},
                       {"name": d["name"], "enc": "repeat",
                        "repeat": {"count": "费率数", "plus": 1, "item": item, "label": ["总", "费率{i}"]}}]
        d["bytes"] = "var"
    elif len(fields) > 1:
        d["fields"] = [fmt_to_field(x.get("fmt"), x["bytes"] if isinstance(x.get("bytes"), int) else "var",
                                    x.get("name") or f"字段{i + 1}", "", x.get("name") or "", e["appendix"])
                       for i, x in enumerate(fields)]
    else:
        d["fields"] = [fmt_to_field(fmt, nb, "数据", e.get("unit") or "", e.get("desc") or "", e["appendix"])]
    return d


def render_name(tpl, n):
    return tpl.replace("{n}", str(n)).replace("{h}", f"{n:02X}")


def name_template(es, pos):
    """为区间名称找模板（{n} 十进制 / {h} 两位十六进制）；模板覆盖不到的放进 names。"""
    vals = [(x, int(x["di"][2 * pos:2 * pos + 2], 16)) for x in es]
    best = None
    for key, render in (("{n}", str), ("{h}", lambda v: f"{v:02X}")):
        for offset in (0, 1):
            tpls = Counter()
            for x, v in vals:
                rx = re.compile(rf"(?<![0-9A-Za-z]){re.escape(render(v - offset))}(?![0-9A-Za-z])")
                if rx.search(x["name"]):
                    tpls[rx.sub(key, x["name"], count=1)] += 1
            if tpls:
                tpl, hits = tpls.most_common(1)[0]
                if best is None or hits > best[2]:
                    best = (tpl, offset, hits)
    all_names = {f"{v:02X}": x["name"] for x, v in vals}
    if best is None:
        return None, 0, all_names
    names = {f"{v:02X}": x["name"] for x, v in vals if render_name(best[0], v - best[1]) != x["name"]}
    if len(names) > len(es) // 2:
        return None, 0, all_names
    return best[0], best[1], names


def compact(entries, by_di):
    """区间展开条目 → 区间模板；其余 → 单条 items。区间内格式不一致时退回逐条。"""
    groups = OrderedDict()
    for e in entries:
        if e.get("range_base"):
            groups.setdefault(e["range_base"], []).append(e)
    items = OrderedDict((e["di"], entry_def(e, by_di)) for e in entries if not e.get("range_base") and e["di"] not in groups)
    ranges = []
    for base, es in groups.items():
        if base in by_di and all(x["di"] != base for x in es):
            es = [by_di[base]] + es
        pos = next((i for i in range(4) if len({x["di"][2 * i:2 * i + 2] for x in es}) > 1), None)
        if pos is not None:  # FF 数据块成员格式不同，单独成条，不拖累整个区间
            for x in [x for x in es if x["di"][2 * pos:2 * pos + 2] == "FF"]:
                items[x["di"]] = entry_def(x, by_di)
            es = [x for x in es if x["di"][2 * pos:2 * pos + 2] != "FF"]
        sigs = {json.dumps({k: v for k, v in entry_def(x, by_di, name="-").items() if k != "src"}, ensure_ascii=False, sort_keys=True)
                for x in es}  # 出处页码不参与比较，跨页的区间仍可合并
        if pos is None or not es or len(sigs) > 1:
            for x in es:
                items[x["di"]] = entry_def(x, by_di)
            continue
        vals = sorted(int(x["di"][2 * pos:2 * pos + 2], 16) for x in es)
        tpl, offset, names = name_template(es, pos)
        r = {"base": base, "pos": pos}
        if vals == list(range(vals[0], vals[-1] + 1)):
            r.update(lo=vals[0], hi=vals[-1])
        else:
            r["list"] = vals
        if tpl:
            r.update(tpl=tpl, offset=offset)
        if names:
            r["names"] = names
        r["def"] = {k: v for k, v in entry_def(es[0], by_di).items() if k != "name"}
        ranges.append(r)
    return items, ranges


def range_value(r, di):
    i = r["pos"] * 2
    if di[:i] != r["base"][:i] or di[i + 2:] != r["base"][i + 2:]:
        return None
    v = int(di[i:i + 2], 16)
    ok = v in r["list"] if "list" in r else r["lo"] <= v <= r["hi"]
    return v if ok else None


def find_def(di, items, ranges):
    if di in items:
        return items[di]
    return next((r["def"] for r in ranges if range_value(r, di) is not None), None)


def range_hit(di, ranges):
    for r in ranges:
        v = range_value(r, di)
        if v is not None:
            return r, v
    return None, None


def range_name(r, v):
    names = r.get("names", {})
    return names.get(f"{v:02X}") or render_name(r["tpl"], v - r.get("offset", 0))


def struct_fields(st, items, ranges, by_di):
    """ARD/ERD/FD 等复合结构 → Field 列表；同一 group 的字段收进一个子结构；引用 DI 时沿用其（已合并 overrides 的）字段定义。"""
    out, cur = [], None
    for x in st["fields"]:
        label = x.get("label") or "数据"
        fmt = (x.get("fmt") or "").replace(" ", "")
        nb = x["bytes"] if isinstance(x.get("bytes"), int) else "var"
        ref = x.get("ref")
        d = find_def(ref, items, ranges) if ref else None
        if ref and BLOCK_RX.match(fmt) and ref in by_di:
            f = {"name": label, "enc": "struct", "fields": block_fields(by_di[ref], by_di)}
        elif d and len(d.get("fields") or []) == 1:
            f = {**d["fields"][0], "name": label}
        else:
            f = fmt_to_field(fmt, nb, label, "", label, "")
        if x.get("group"):
            if cur is None or cur["name"] != x["group"]:
                cur = {"name": x["group"], "enc": "struct", "fields": []}
                out.append(cur)
            cur["fields"].append(f)
        else:
            cur = None
            out.append(f)
    return out


def need_why(obj, where):
    if not obj.get("why"):
        sys.exit(f"overrides.json：{where} 缺少 why")


def patch_fields(fields, patch):
    """按字段名递归合并补丁 {"字段名": {属性…}}"""
    for f in fields:
        if f.get("name") in patch:
            f.update(patch[f["name"]])
        if f.get("fields"):
            patch_fields(f["fields"], patch)


def apply_item_overrides(items, ranges, ov):
    # 先为「只存在于区间里」的补丁 DI 继承区间定义和名称（必须在区间补丁替换自动区间之前做）
    seeds = {}
    for di in ov.get("items", {}):
        if di not in items:
            r, v = range_hit(di, ranges)
            if r:
                seeds[di] = {**json.loads(json.dumps(r["def"])), "name": range_name(r, v)}
    for d in ov.get("drop", []):
        need_why(d, f"drop {d.get('di')}")
        items.pop(d["di"], None)
    for r in ov.get("ranges", []):
        need_why(r, f"ranges {r.get('base')}")
        r = {k: v for k, v in r.items() if k != "why"}
        for di in [k for k in items if range_value(r, k) is not None]:
            items.pop(di)  # 区间补丁接管其覆盖的单条定义
        ranges[:] = [x for x in ranges if not (x["base"] == r["base"] and x["pos"] == r["pos"])]
        ranges.insert(0, r)
    for di, p in ov.get("items", {}).items():
        need_why(p, f"items {di}")
        cur = dict(items.get(di) or seeds.get(di) or {})
        for k, v in p.items():
            if k in ("why", "patch", "fieldsFrom"):
                continue
            if v is None:
                cur.pop(k, None)  # 值为 null 表示删除该键（如去掉生成结果里的 struct 引用）
            else:
                cur[k] = v
        if p.get("patch"):
            patch_fields(cur.get("fields", []), p["patch"])
        items[di] = cur
    for di, p in ov.get("items", {}).items():
        if p.get("fieldsFrom"):
            items[di]["fields"] = [f for src in p["fieldsFrom"] for f in json.loads(json.dumps(items[src]["fields"]))]


def apply_struct_overrides(structs, ov):
    for name, p in ov.get("structs", {}).items():
        need_why(p, f"structs {name}")
        s = structs.setdefault(name, {"bytes": None, "fields": []})
        if p.get("fields"):
            s["fields"] = p["fields"]
        if p.get("patch"):
            patch_fields(s["fields"], p["patch"])


def field_len(f, structs):
    if f.get("enc") == "struct":
        parts = [field_len(x, structs) for x in f.get("fields") or []]
        return None if None in parts else sum(parts)
    return f["bytes"] if isinstance(f.get("bytes"), int) else None


def validate(items, ranges, structs):
    """精校、平台条目：字段字节数之和必须等于 bytes；它们引用的结构也要自洽。"""
    errs = [f"{di}：缺少 name" for di, d in items.items() if not d.get("name")]
    defs = list(items.items()) + [(f"{r['base']}(区间)", r["def"]) for r in ranges]
    for di, d in defs:
        if d.get("tier") not in ("精校", "平台"):
            continue
        fs = structs[d["struct"]]["fields"] if d.get("struct") else d.get("fields", [])
        parts = [field_len(f, structs) for f in fs]
        if isinstance(d.get("bytes"), int) and None not in parts and sum(parts) != d["bytes"]:
            errs.append(f"{di}：字段字节数之和 {sum(parts)} ≠ bytes {d['bytes']}")
    return errs


def review_text(entries, ov):
    handled = set(ov.get("items", {})) | {d["di"] for d in ov.get("drop", [])} | \
              {r["base"] for r in ov.get("ranges", [])} | set(ov.get("structs", {}))
    lines = ["di(或范围首项)\t附录\t印刷页\t标记\t名称\t格式\t字节\t已处理"]
    for key, is_range, appendix, page, flags, name, fmt, nbytes in review_rows(entries):
        lines.append(f"{key}{'(范围)' if is_range else ''}\t{appendix}\t{page}\t{flags}\t{name}\t{fmt}\t{nbytes}\t"
                     f"{'是' if key in handled else '否'}")
    return "\n".join(lines) + "\n"


def build(pdf, ov):
    pages = json.loads(json.dumps(grid_mod.build_grid(pdf)))  # 与探针一致：经 JSON 往返，元组统一为列表
    entries, structs_raw, stats = extract(pages)
    by_di = {e["di"]: e for e in entries}
    items, ranges = compact(entries, by_di)
    apply_item_overrides(items, ranges, ov)
    structs = OrderedDict((k, {"bytes": v.get("bytes"), "fields": struct_fields(v, items, ranges, by_di)})
                          for k, v in structs_raw.items())
    apply_struct_overrides(structs, ov)
    errs = validate(items, ranges, structs)
    if errs:
        sys.exit("校验失败：\n" + "\n".join(errs))
    precise = sum(1 for d in items.values() if d.get("tier") == "精校") + \
        sum(1 for r in ranges if r["def"].get("tier") == "精校")
    meta = {"spec": "Q/CSG1209022-2019", "generatedBy": "gen/extract_di.py",
            "stats": {"expanded": len(entries), "items": len(items), "ranges": len(ranges), "structs": len(structs),
                      "precise": precise}}
    dct = {"meta": meta, "items": items, "ranges": ranges, "structs": structs}
    js = SENTINEL + "\nexport const DICT = " + json.dumps(dct, ensure_ascii=False, separators=(",", ":")) + ";\n"
    return js, review_text(entries, ov)


def cli():
    ap = argparse.ArgumentParser(description="从规约 PDF 生成 src/di_dict.js 与 gen/review.tsv")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--check", action="store_true", help="只比较不写文件；与仓库中的文件不一致时退出码为 1")
    a = ap.parse_args()
    ov = json.loads(OVERRIDES.read_text(encoding="utf-8"))
    js, review = build(a.pdf, ov)
    if a.check:
        same = DICT_JS.read_text(encoding="utf-8") == js and REVIEW.read_text(encoding="utf-8") == review
        print("一致" if same else "不一致：请重新生成并提交")
        sys.exit(0 if same else 1)
    DICT_JS.write_text(js, encoding="utf-8")
    REVIEW.write_text(review, encoding="utf-8")
    print(f"写入 {DICT_JS}（{len(js.encode('utf-8')) // 1024} KB）与 {REVIEW}")


if __name__ == "__main__":
    cli()
