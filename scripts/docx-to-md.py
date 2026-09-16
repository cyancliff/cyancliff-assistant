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

## 会丢什么

  - 图片（只留图注文字，如 `图3-1 面向心智测评的…`）
  - 表格结构（13 个表格会被压成文本，列对齐丢失）
  - 公式排版（上下标大概率丢）
  - 页眉页脚、批注、修订痕迹

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


def convert(src: Path, out: Path, rules: list[dict]) -> dict:
    with zipfile.ZipFile(src) as z:
        xml = z.read("word/document.xml").decode("utf-8")

    body = ET.fromstring(xml).find(f"{W}body")
    if body is None:
        sys.exit(f"读不出 word/document.xml 的 body：{src}")

    hits: dict[str, int] = {}
    parts = [
        "<!-- 由 scripts/docx-to-md.py 自动生成，请勿手改 -->",
        f"<!-- 源文件: {src.name} -->",
        f"<!-- 转换: python-docx-xml @ {date.today().isoformat()} -->",
    ]
    if rules:
        parts.append(f"<!-- 已脱敏: {', '.join(r['name'] for r in rules)} -->")
    parts.append("")

    headings = captions = tables = 0

    for p in body.iter(f"{W}p"):
        style = para_style(p)
        if style in STYLE_SKIP:
            continue

        text = para_text(p)
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

        # 表格：单独抽成一段，标注丢了多少结构
        for tbl in p.iter(f"{W}tbl"):
            tables += 1

    table_count = len(list(body.iter(f"{W}tbl")))
    if table_count:
        parts.append(f"<!-- 本文档含 {table_count} 个表格，结构未保留 -->")

    out.write_text("\n".join(parts).rstrip() + "\n", encoding="utf-8")

    return {
        "out_lines": len(out.read_text(encoding="utf-8").splitlines()),
        "headings": headings,
        "captions": captions,
        "tables": table_count,
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
    print(f"  md {stats['out_lines']} 行   标题 {stats['headings']}   图注/表注 {stats['captions']}")
    print(f"  原始文档含 {stats['tables']} 个表格、{stats['drawings']} 张图 —— **结构未保留**")

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
    print("    保真度: 表格结构未保留、图片只留图注、公式上下标可能丢失")
    print("    可引用: 原文（正文）／仅页码（表格、公式）")
    print()
    print("  用完请把脱敏规则文件从 data/ 里删掉或留在本地：")
    print("    它记录了被脱敏的原值，**不要提交**。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
