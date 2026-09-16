#!/usr/bin/env python3
"""
docx-to-md.py — 把 Word 文稿转成可检索、可引用的 Markdown

    python scripts/docx-to-md.py "某论文.docx"
    python scripts/docx-to-md.py "某论文.docx" --redact library/某论文.redact.json

为什么要有这个脚本：

  编目和引用都指向 `<名字>.md:<行号>`，所以转换必须确定性、可重复。
  docx 是 zip + XML，Python 标准库就能读，不需要装任何东西。

不变量：**产出与原件同名同前缀**（扩展名换成 .md）。

## 脱敏

论文的封面和声明页会带学号、姓名这类不该被随手引用的信息。
`--redact` 指向一个 JSON 文件，形如：

    {
      "patterns": [
        {"name": "学号", "regex": "20\\d{6,8}", "replace": "【已脱敏:学号】"}
      ]
    }

脱敏发生在**写文件之前**，所以产出里根本不存在原值。
报告会列出每条规则命中几次 —— 命中 0 次要警惕：可能原文变了，规则失效了。

## 表格

`<w:tbl>` 会渲染成真正的 Markdown 表格（表头取第一行）。
`gridSpan`（横向合并）按跨列数补出空列 —— 这会让某些列错位，
**列名与数值的对应关系要抽查**，别默认它对。

## 会丢什么

  - 图片（只留图注这类文字，图片本身不保留）
  - 公式排版（上下标大概率丢）
  - 页眉页脚、批注、修订痕迹
  - 纵向合并（vMerge）只保留第一个格子的值，续格是空的

所以产出是**派生品**。原件必须留着。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# 样式名 → 标题层级。这份映射是按常见 Word 论文模板写的（章用 "1"，节用 "2"，小节用 "3"）。
# 换模板要重新核对，**不要以为它通用**。
STYLE_HEADING = {
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "Heading1": 1, "Heading2": 2, "Heading3": 3,
}
STYLE_SKIP = {"TOC1", "TOC2", "TOC3", "TOC4", "TOC5"}
STYLE_CAPTION = {"af9"}          # 图注 / 表注
NUMBERED_HEADING = re.compile(r"^(\d+(?:\.\d+)*)\s+\S")


def para_style(p) -> str:
    pPr = p.find(f"{W}pPr")
    if pPr is None:
        return ""
    st = pPr.find(f"{W}pStyle")
    return st.get(f"{W}val", "") if st is not None else ""


def para_text(p) -> str:
    """段落文字。用 iter 会重复计入嵌套表格里的文字，这里按 run 取。"""
    parts = []
    for r in p.iter(f"{W}r"):
        for t in r.iter(f"{W}t"):
            parts.append(t.text or "")
        for br in r.iter(f"{W}br"):
            parts.append(" ")
    text = "".join(parts)
    # 不换行空格 → 普通空格。Word 里很常见，而它会让引用核对产生
    # 肉眼看不出的假差异（`0.5\xa0表示` vs `0.5 表示`）。
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    text = re.sub(r"[\u2000-\u200b]", " ", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def redact(text: str, rules: list[dict], counter: dict) -> str:
    for rule in rules:
        pat = rule["regex"]
        n = len(re.findall(pat, text))
        if n:
            counter[rule["name"]] = counter.get(rule["name"], 0) + n
            text = re.sub(pat, rule.get("replace", "【已脱敏】"), text)
    return text


# ── 表格 ──────────────────────────────────────────────────────

def build_parent_map(body):
    """parent map，用来判断一个段落是不是在表格单元格里。"""
    parents = {}
    for parent in body.iter():
        for child in parent:
            parents[child] = parent
    return parents


def is_in_table(el, parents) -> bool:
    cur = parents.get(el)
    while cur is not None:
        if cur.tag == f"{W}tbl":
            return True
        cur = parents.get(cur)
    return False


def cell_text(tc) -> str:
    """单元格文字。段落之间用空格接，换行会让 Markdown 表格垮掉。"""
    chunks = []
    for p in tc.iter(f"{W}p"):
        t = "".join(x.text or "" for x in p.iter(f"{W}t")).strip()
        if t:
            chunks.append(t)
    return " ".join(chunks).replace("|", "\\|").strip()


def table_plain(tbl) -> list[list[str]]:
    """表格 → 二维数组，按 gridSpan 补齐被横向合并的格子。"""
    grid = []
    for tr in tbl.findall(f"{W}tr"):
        row = []
        for tc in tr.findall(f"{W}tc"):
            span = 1
            tcPr = tc.find(f"{W}tcPr")
            if tcPr is not None:
                gs = tcPr.find(f"{W}gridSpan")
                if gs is not None:
                    try:
                        span = max(1, int(gs.get(f"{W}val", "1")))
                    except ValueError:
                        span = 1
            row.append(cell_text(tc))
            row.extend([""] * (span - 1))
        grid.append(row)
    return grid


def render_table(grid: list[list[str]], index: int) -> list[str]:
    """渲染成 Markdown 表格。

    表头取第一行 —— 论文里的三线表基本都这样。行宽不一致时补空格，
    因为 Markdown 表格对列数敏感，缺列会把后面的行错位。
    """
    width = max((len(r) for r in grid), default=0)
    if width == 0:
        return []
    norm = [r + [""] * (width - len(r)) for r in grid]

    out = [f"<!-- 表 {index} -->", ""]
    out.append("| " + " | ".join(norm[0]) + " |")
    out.append("|" + "---|" * width)
    for row in norm[1:]:
        out.append("| " + " | ".join(row) + " |")
    out.append("")
    return out


def convert(src: Path, out: Path, rules: list[dict]) -> dict:
    with zipfile.ZipFile(src) as z:
        xml = z.read("word/document.xml").decode("utf-8")

    root = ET.fromstring(xml)
    body = root.find(f"{W}body")
    if body is None:
        sys.exit(f"读不出 word/document.xml 的 body：{src}")

    parents = build_parent_map(body)

    hits: dict[str, int] = {}
    parts = [
        "<!-- 由 scripts/docx-to-md.py 自动生成，请勿手改 -->",
        f"<!-- 源文件: {src.name} -->",
        f"<!-- 转换: python-docx-xml @ {date.today().isoformat()} -->",
    ]
    if rules:
        parts.append(f"<!-- 已脱敏: {', '.join(r['name'] for r in rules)} -->")
    parts.append("")

    headings = captions = 0
    tables = 0

    # 按文档顺序走 body 的直接子元素。表格在 body 这一层，
    # 段落可能在表格单元格里 —— 后者由 render_table 一并处理。
    for el in body:
        tag = el.tag

        if tag == f"{W}tbl":
            grid = table_plain(el)
            if any(any(c for c in r) for r in grid):
                tables += 1
                parts.extend(render_table(grid, tables))
            continue

        if tag != f"{W}p":
            continue
        if is_in_table(el, parents):
            continue

        style = para_style(el)
        if style in STYLE_SKIP:
            continue

        text = para_text(el)
        if not text:
            continue
        text = redact(text, rules, hits)

        m = NUMBERED_HEADING.match(text)
        level = STYLE_HEADING.get(style)
        if m and len(text) <= 60:
            level = m.group(1).count(".") + 1
        elif level is None and len(text) <= 40 and re.match(r"^(摘\s*要|ABSTRACT|参考文献|致\s*谢)$", text):
            level = 1

        if level:
            parts.append(f"{'#' * min(level, 6)} {text}")
            headings += 1
        elif style in STYLE_CAPTION:
            parts.append(f"> {text}")
            captions += 1
        else:
            parts.append(text)
        parts.append("")

    out.write_text("\n".join(parts).rstrip() + "\n", encoding="utf-8")

    return {
        "out_lines": len(out.read_text(encoding="utf-8").splitlines()),
        "headings": headings,
        "captions": captions,
        "tables": tables,
        "drawings": len(list(body.iter(f"{W}drawing"))),
        "hits": hits,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="docx → Markdown（派生品，不保证忠实）")
    ap.add_argument("docx", type=Path)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--redact", type=Path, default=None,
                    help="脱敏规则 JSON，见本文件顶部说明")
    args = ap.parse_args()

    if not args.docx.is_file():
        sys.exit(f"找不到：{args.docx}")

    rules = []
    if args.redact:
        if not args.redact.is_file():
            sys.exit(f"找不到脱敏规则：{args.redact}")
        rules = json.loads(args.redact.read_text(encoding="utf-8"))["patterns"]

    out = args.out or args.docx.with_suffix(".md")
    stats = convert(args.docx, out, rules)

    print(f"✓ {args.docx.name} → {out.name}")
    print(f"  md {stats['out_lines']} 行   标题 {stats['headings']}   表格 {stats['tables']}")
    print(f"  图片 {stats['drawings']} 张 —— 只留图注文字，图片本身不保留")
    if stats["tables"]:
        print("  表格已渲染成 Markdown。注意 gridSpan（横向合并）会补出空列，")
        print("  列名与数值的对应关系要抽查；行数统计以 md 为准。")

    if rules:
        print()
        print("  脱敏命中：")
        for rule in rules:
            n = stats["hits"].get(rule["name"], 0)
            flag = "" if n else "   ⚠ 命中 0 次 —— 规则可能已失效，核对原文"
            print(f"    {rule['name']}: {n} 处{flag}")

    print()
    print("  这是派生品。请在条目文件里记录：")
    print(f"    转换: python-docx-xml @ {date.today().isoformat()}")
    print("    保真度: 表格已渲染（gridSpan 会补空列）、图片只留图注、公式上下标可能丢失")
    print("    可引用: 原文（正文、表格）／公式需回原件核对")
    print()
    print("  用完请把脱敏规则文件从 data/ 里删掉或留在本地：")
    print("    它记录了被脱敏的原值，**不要提交**。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
