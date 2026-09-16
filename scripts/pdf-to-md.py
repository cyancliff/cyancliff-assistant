#!/usr/bin/env python3
"""
pdf-to-md.py — 把文字版 PDF 转成可检索、可引用的 Markdown

    python scripts/pdf-to-md.py library/某论文.pdf
    python scripts/pdf-to-md.py library/某论文.pdf --out library/某论文.md

为什么要有这个脚本（而不是每次让模型现写一个）：

  资料编目与引用都指向 `library/<名字>.md:<行号>`。行号只有在转换**确定性**时才有意义，
  所以转换必须是一个固定程序，同一份 PDF 每次转出同样的结果。

不变量：**产出与原件同名同前缀。**
  `library/x.pdf` → `library/x.md`
  这样从任何一条引用都能推出原件路径，不用查表。

这个脚本**不保证忠实**。它是机械转换，会丢：
  - 双栏阅读顺序（块按坐标排序，栏间可能串）
  - 表格结构、公式排版
  - 老论文的字符编码错误（如 `ali` 实为 `all`）
它已经处理的：连字 ﬁ/ﬂ、span 之间的空格重建、行尾断词、页标记。
所以产出是**派生品**，引用是暂定的。原件必须留着。

只写 .md，不改原件，不碰网络。
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("需要 PyMuPDF：pip install pymupdf")

LIGATURES = {
    "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
    "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "ft", "\ufb06": "st",
}

# 小于这个字号的 span 是上下标和公式碎片（h_t 的 t、求和号等）。
# 单独丢掉会让公式变成 "ht−1" 这种，但留着会把正文切得七零八落。
TINY = 7.5


def normalize(text: str) -> str:
    for bad, good in LIGATURES.items():
        text = text.replace(bad, good)
    text = text.replace("&dquo;", '"').replace("&ldquo;", '"').replace("&rdquo;", '"')
    text = text.replace("\u00ad", "")
    # 换行符和各种不换行空格 → 普通空格。
    # 不这么做的话，`0.5\xa0表示` 和 `0.5 表示` 在引用核对时会被判成不同，
    # 而肉眼看不出差别 —— 那种假警报最耗时间。
    text = text.replace("\u00a0", " ").replace("\u3000", " ")
    text = re.sub(r"[\u2000-\u200b]", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def line_text(line: dict) -> tuple[str, float, str]:
    """重建一行的文字，并在 span 之间按需补空格。

    这是最容易出错的一步：PyMuPDF 会把一行切成大量小 span
    （引用编号、逗号各自成 span）。直接把 span 文本首尾相接，
    `English` + `to` + `-German` 就会粘成 `Englishto-German`。
    """
    out = ""
    prev_x1 = None
    max_size = 0.0
    fonts: Counter[str] = Counter()

    for sp in line.get("spans", []):
        t = sp["text"]
        if not t:
            continue
        x0, x1 = sp["bbox"][0], sp["bbox"][2]
        if sp["size"] < TINY:
            continue

        if out and prev_x1 is not None:
            gap = x0 - prev_x1
            # 结尾是字母/数字、下一个以字母/数字开头、且间隙够大 → 该有空格。
            # 阈值取字号的 15%，避免把 "English-to" 拆开。
            if (
                gap > sp["size"] * 0.15
                and out[-1] not in " \u2014-\u2013("
                and t[:1] not in " \u2014-\u2013),.;:?!%"
            ):
                out += " "

        out += t
        prev_x1 = x1
        max_size = max(max_size, sp["size"])
        font = sp["font"]
        fonts[font.replace("-Bold", "").replace("-Medi", "").replace("-Ital", "")] += 1

    return normalize(out), round(max_size, 1), fonts.most_common(1)[0][0] if fonts else ""


def join_block(lines: list[str]) -> str:
    """把 block 内的行拼成一段。

    行尾连字符**保留**，只去掉换行：

        "transduc-" + "tion"      → "transduc-tion"
        "English-"  + "to-German" → "English-to-German"   ← 关键：不被损坏

    为什么不去连字符：PDF 里行尾连字符混合了两种情况 ——
    真实断词（transduc-/tion）和本来就有连字符的复合词（English-/to-German）。
    **没有字典就分不清**，而猜错会把复合词粘成 `Englishto-German`，
    那是主动污染正文。保留连字符只是留下一个可见的断词痕迹，不损坏任何文本。

    代价：引用按"去空白"比对时，真实断词的词（`transduc-tion`）匹配不上
    原文的 `transduction`。这是已知取舍，见条目里记的保真度一栏。
    """
    out = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if not out:
            out = line
        elif out.endswith("-"):
            out = out + line          # 保留连字符，仅去掉换行
        else:
            out = out + " " + line
    return out


def page_blocks(page):
    return sorted(page.get_text("blocks"), key=lambda b: (round(b[1], 1), b[0]))


def convert(pdf_path: Path, out_path: Path) -> dict:
    doc = fitz.open(pdf_path)
    if doc.needs_pass:
        sys.exit(f"PDF 有密码，无法转换：{pdf_path}")

    # 先扫一遍全局，建立"正文长什么样"的基准：最常见的字号 + 最常见的基础字体名。
    size_counter: Counter[float] = Counter()
    font_counter: Counter[str] = Counter()
    for page in doc:
        for b in page.get_text("dict")["blocks"]:
            for line in b.get("lines", []):
                for sp in line.get("spans", []):
                    if sp["text"].strip() and sp["size"] >= TINY:
                        size_counter[round(sp["size"], 1)] += len(sp["text"])
                        base = re.sub(r"-(Bold|Medi|Ital|BoldItal)$", "", sp["font"])
                        font_counter[base] += len(sp["text"])

    body_size = size_counter.most_common(1)[0][0] if size_counter else 10.0
    body_font = font_counter.most_common(1)[0][0] if font_counter else ""

    parts = [
        "<!-- 由 scripts/pdf-to-md.py 自动生成，请勿手改 -->",
        f"<!-- 源文件: {pdf_path.name} -->",
        f"<!-- 转换: pymupdf {fitz.VersionBind} @ {date.today().isoformat()} -->",
        f"<!-- 页数: {doc.page_count}   正文基准: {body_size}pt {body_font} -->",
        "",
    ]

    headings = 0
    empty_pages = 0

    for pno in range(doc.page_count):
        page = doc[pno]
        if len(page.get_text("text").strip()) < 50:
            empty_pages += 1

        parts.append(f"<!-- page {pno + 1} -->")
        parts.append("")

        for b in page_blocks(page):
            dict_block = None
            for blk in page.get_text("dict")["blocks"]:
                if abs(blk["bbox"][1] - b[1]) < 0.5 and abs(blk["bbox"][0] - b[0]) < 0.5:
                    dict_block = blk
                    break
            if dict_block is None:
                continue

            rows, max_size, dominant_font = [], 0.0, ""
            for line in dict_block.get("lines", []):
                text, size, font = line_text(line)
                if text:
                    rows.append(text)
                    if size > max_size:
                        max_size, dominant_font = size, font
            if not rows:
                continue

            joined = join_block(rows)
            if not joined:
                continue

            # 标题判据：明显更大的字号，且不是正文那套字体。
            # 只看字号会把公式里的 h 也当成标题（同字号、不同字体族）。
            is_heading = (
                max_size >= body_size + 1.5
                and dominant_font
                and dominant_font != body_font
                and len(joined) <= 90
                and not joined.endswith((".", ",", ";"))
            )

            if is_heading:
                number = None
                try:
                    idx = [i for i, r in enumerate(rows) if re.match(r"^\d+(\.\d+)*$", r.strip())]
                    if idx:
                        number = rows.pop(idx[0]).strip()
                        joined = join_block(rows)
                except Exception:
                    pass
                title = f"{number} {joined}" if number else joined
                level = "##" if number else "#"
                parts.append(f"{level} {title}")
                headings += 1
            else:
                parts.append(joined)
            parts.append("")

    out_path.write_text("\n".join(parts).rstrip() + "\n", encoding="utf-8")

    return {
        "pages": doc.page_count,
        "chars": sum(len(p.get_text("text")) for p in doc),
        "empty_pages": empty_pages,
        "body": f"{body_size}pt {body_font}",
        "out_lines": len(out_path.read_text(encoding="utf-8").splitlines()),
        "headings": headings,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="文字版 PDF → Markdown（派生品，不保证忠实）")
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    if not args.pdf.is_file():
        sys.exit(f"找不到：{args.pdf}")
    out = args.out or args.pdf.with_suffix(".md")

    stats = convert(args.pdf, out)

    print(f"✓ {args.pdf.name} → {out.name}")
    print(f"  页数 {stats['pages']}   原文 {stats['chars']} 字符   md {stats['out_lines']} 行")
    print(f"  正文基准 {stats['body']}   检出标题 {stats['headings']}")
    if stats["empty_pages"]:
        print(f"  ⚠ {stats['empty_pages']} 页几乎没有文字 —— 可能是扫描件，引用不可靠")
    print()
    print("  这是派生品。请在条目文件里记录：")
    print(f"    转换: pymupdf {fitz.VersionBind} @ {date.today().isoformat()}")
    print("    保真度: （抽查后填写）")
    print("    可引用: 原文")
    print()
    print("  抽查四类最容易崩的地方，再决定可引用性：")
    print("    跨页段落 / 双栏版面 / 表格 / 公式行")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
