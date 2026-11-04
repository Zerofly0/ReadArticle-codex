"""Read-only, standard-library audit and reproducible scratch parser QA.

Use --document FILE [--asset-dir DIR] for a fast audit without PDF parsing.
Use --batch --output-dir DIR --sample NAME=PDF [...] to create scratch previews.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import time
from urllib.parse import unquote, urlsplit

QUALITY_VERSION = "parse-quality-v1"
MATH_TOKEN = re.compile(r"⟦MATH_m\d+⟧")
FUNCTIONS = {"max", "min", "sin", "cos", "tan", "log", "exp", "lim", "relu", "softmax", "arg", "diag", "split", "concat", "mlp", "ln", "mra", "msa"}
PROSE_WORDS = {"the", "and", "for", "with", "from", "that", "this", "when", "where", "which", "use", "we", "our", "are", "is", "to", "of", "in", "as", "on", "be", "an"}


def math_prose_suspicion(text):
    """Reject clear prose capture, not symbolic length or a lone 'otherwise'."""
    words = [w.lower() for w in re.findall(r"[A-Za-z]{2,}", str(text)) if w.lower() not in FUNCTIONS]
    return len(words) >= 8 and len(set(words) & PROSE_WORDS) >= 4


def _box_values(box):
    try:
        return tuple(float(box[k]) for k in ("x0", "y0", "x1", "y1"))
    except (TypeError, ValueError, KeyError):
        return None


def _intersection(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))


def _area(box):
    return max(0, box[2]-box[0]) * max(0, box[3]-box[1])


def audit_document(document, asset_dir=None, initial_issues=None):
    """Return JSON quality evidence without modifying the document or files.

    Asset paths come from their actual URL, including revision prefixes. No
    image name is guessed from a math ID, and no network access is performed.
    """
    if not isinstance(document, dict):
        document = {}
    # Recompute structural/file checks each time. Only safety events that
    # happened during extraction need to survive a later read-only audit.
    event_codes = {"MATH_PROSE_REJECTED", "FIGURE_BODY_PRESERVED", "FIGURE_REGION_REJECTED", "ASSET_EXTRACTION_FAILED", "PAGE_TEXT_MISSING"}
    issues = [dict(i) for i in (initial_issues or []) if i.get("code") in event_codes]
    pages = {p.get("page"): p for p in document.get("pages", []) if isinstance(p, dict)}
    paragraphs = [p for p in document.get("paragraphs", []) if isinstance(p, dict)]
    figures = [a for a in document.get("assets", []) if isinstance(a, dict)]
    maths = [a for a in document.get("mathAssets", []) if isinstance(a, dict)]
    by_id = {p.get("id"): p for p in paragraphs if p.get("id")}
    root = Path(asset_dir).resolve() if asset_dir is not None else None

    def add(code, severity, page, message, paragraph=None, asset=None, fallback=None):
        issue = {"code": code, "severity": severity, "page": page, "message": message}
        if paragraph is not None:
            issue["paragraphId"] = paragraph.get("id")
        if asset is not None:
            issue["assetId"] = asset.get("id")
        if fallback:
            issue["fallback"] = fallback
        issues.append(issue)

    def check_box(box, page, paragraph=None, asset=None):
        values = _box_values(box)
        dimension = pages.get(page)
        valid = dimension is not None and values is not None and all(math.isfinite(v) for v in values)
        if valid:
            valid = values[0] < values[2] and values[1] < values[3] and values[0] >= -.6 and values[1] >= -.6 and values[2] <= float(dimension.get("width", 0))+.6 and values[3] <= float(dimension.get("height", 0))+.6
        if not valid:
            add("SOURCE_BOX_INVALID", "error", page, "源区域的页码或坐标无效，请查看原 PDF。", paragraph, asset, "original-page")
        return values if valid else None

    def check_file(asset):
        if root is None:
            return
        try:
            parsed = urlsplit(str(asset.get("url", "")))
            path = unquote(parsed.path)
            name = path.rsplit("/", 1)[-1]
            if parsed.scheme or parsed.netloc or "/assets/" not in path or not name or name in {".", ".."} or "\\" in name:
                raise ValueError("not a local asset")
            target = (root / name).resolve()
            target.relative_to(root)
            exists = target.is_file() and target.stat().st_size > 0
        except (OSError, ValueError):
            exists = False
        if not exists:
            add("ASSET_FILE_MISSING", "error", asset.get("page"), "资产 URL 对应的本地文件缺失或不可读，请查看原 PDF。", asset=asset, fallback="original-page")

    duplicates = Counter(p.get("id") for p in paragraphs if p.get("id"))
    tokens = Counter()
    owners = {}
    for paragraph in paragraphs:
        page = paragraph.get("page")
        if duplicates.get(paragraph.get("id"), 0) > 1:
            add("PARAGRAPH_ID_DUPLICATE", "error", page, "段落标识重复，引用可能指向错误内容。", paragraph, fallback="original-page")
        for box in paragraph.get("sourceBoxes", []):
            check_box(box, box.get("page", page), paragraph)
        current = MATH_TOKEN.findall(str(paragraph.get("text", "")))
        tokens.update(current)
        for token in current:
            owners.setdefault(token, paragraph)
        sentence_tokens = [t for sentence in paragraph.get("sentences", []) for t in MATH_TOKEN.findall(str(sentence.get("text", "")))]
        if current != sentence_tokens:
            add("MATH_SENTENCE_TOKEN_MISMATCH", "error", page, "段落与逐句文本中的公式标识或顺序不一致。", paragraph, fallback="original-page")

    math_by_token = {}
    for asset in maths:
        token = asset.get("token")
        math_by_token.setdefault(token, []).append(asset)
        page = asset.get("page")
        if not isinstance(token, str) or not MATH_TOKEN.fullmatch(token) or token != f"⟦MATH_{asset.get('id')}⟧":
            add("MATH_ASSET_ID_MISMATCH", "error", page, "公式资产的标识与占位符不对应。", asset=asset, fallback="original-page")
        box = check_box(asset.get("sourceBox"), page, asset=asset)
        if box and asset.get("display") == "inline" and box[3]-box[1] > float(asset.get("sourceFontSize") or 11)*2.8:
            add("MATH_INLINE_MULTILINE", "warning", page, "行内公式区域跨越多行，请与原页核对。", asset=asset, fallback="original-page")
        if math_prose_suspicion(asset.get("textHint", asset.get("rawText", ""))):
            add("MATH_PROSE_CAPTURE", "warning", page, "公式裁片疑似包含连续普通英文，请以原页核对。", asset=asset, fallback="original-page")
        if token not in tokens:
            add("MATH_ASSET_UNUSED", "info", page, "公式资产没有正文引用。", asset=asset)
        check_file(asset)
    for token, count in tokens.items():
        owner = owners[token]
        matches = math_by_token.get(token, [])
        if not matches:
            add("MATH_TOKEN_MISSING_ASSET", "error", owner.get("page"), f"公式标识 {token} 缺少对应资产。", owner, fallback="original-page")
        elif len(matches) > 1:
            add("MATH_TOKEN_DUPLICATE_ASSET", "error", owner.get("page"), f"公式标识 {token} 对应多个资产。", owner, matches[0], "original-page")
        if count > 1:
            add("MATH_TOKEN_REUSED", "warning", owner.get("page"), f"公式标识 {token} 在正文出现 {count} 次，请核对是否重复重排。", owner)

    valid_figures = []
    anchors = set()
    for asset in figures:
        page = asset.get("page")
        box = check_box(asset.get("sourceBox"), page, asset=asset)
        anchor = by_id.get(asset.get("afterParagraphId"))
        if asset.get("afterParagraphId") and anchor is None:
            add("FIGURE_ANCHOR_MISSING", "error", page, "图像引用了不存在的段落，位置无法可靠对应。", asset=asset, fallback="original-page")
        if anchor and anchor.get("kind") == "caption" and re.match(r"^Fig(?:ure)?\.?\s*\d", anchor.get("text", ""), re.I):
            anchors.add(anchor.get("id"))
            if anchor.get("page") != page:
                add("FIGURE_ANCHOR_PAGE_MISMATCH", "error", page, "图像与对应图注页码不一致。", anchor, asset, "original-page")
        else:
            add("FIGURE_WITHOUT_CAPTION", "warning", page, "图像没有可验证的 Fig 图注关联，请查看原页。", asset=asset, fallback="original-page")
        if asset.get("cropStatus") == "page-fallback":
            add("FIGURE_PAGE_FALLBACK", "warning", page, "该图未能可靠确定边界，已保留完整原页视图。", asset=asset, fallback="original-page")
        elif box:
            valid_figures.append((asset, box))
        check_file(asset)
    for paragraph in paragraphs:
        if paragraph.get("kind") == "caption" and re.match(r"^Fig(?:ure)?\.?\s*\d", paragraph.get("text", ""), re.I) and paragraph.get("id") not in anchors:
            add("FIGURE_CAPTION_UNLINKED", "warning", paragraph.get("page"), "图注没有对应的图像资产，请查看原页。", paragraph, fallback="original-page")
    for index, (asset, box) in enumerate(valid_figures):
        for other, other_box in valid_figures[index+1:]:
            if asset.get("page") == other.get("page") and _intersection(box, other_box) > min(_area(box), _area(other_box))*.08:
                add("FIGURE_OVERLAP", "warning", asset.get("page"), f"图像区域与 {other.get('id')} 明显重叠，可能混入另一幅图。", asset=asset, fallback="original-page")

    dual_pages = set(document.get("parser", {}).get("twoColumnPages", []))
    for paragraph in paragraphs:
        text = str(paragraph.get("text", ""))
        words = re.findall(r"[A-Za-z]{2,}", text)
        if paragraph.get("kind") != "paragraph":
            continue
        for source_box in paragraph.get("sourceBoxes", []):
            box = _box_values(source_box)
            page = source_box.get("page", paragraph.get("page"))
            if not box or page not in pages or not all(math.isfinite(v) for v in box):
                continue
            if len(words) >= 30 and len(re.findall(r"[.!?](?:\s|$)", text)) >= 2:
                for asset, image_box in valid_figures:
                    if asset.get("page") == page and _intersection(box, image_box) > _area(box)*.55:
                        add("FIGURE_BODY_OVERLAP", "warning", page, "图像裁切覆盖了保留的正文段落，请以原页确认边界。", paragraph, asset, "original-page")
            alphabet = [c for c in text if c.isalpha()]
            upper_ratio = sum(c.isupper() for c in alphabet)/max(1, len(alphabet))
            if page in dual_pages and box[2]-box[0] > float(pages[page].get("width", 0))*.72 and len(words) >= 50 and upper_ratio < .6 and not re.match(r"^(?:Abstract|Summary)\b", text, re.I):
                add("COLUMN_SPAN_REVIEW", "warning", page, "双栏页的长正文横跨栏沟；保留原文并建议按原页核对阅读顺序。", paragraph, fallback="original-page")

    unique = {}
    for issue in issues:
        page = issue.get("page")
        if page in pages and document.get("id"):
            issue.setdefault("sourceUrl", pages[page].get("url") or f"/api/documents/{document['id']}/pages/{page}.png")
        unique[json.dumps(issue, ensure_ascii=False, sort_keys=True)] = issue
    issues = sorted(unique.values(), key=lambda i: (i.get("page") if isinstance(i.get("page"), (int, float)) else 0, i.get("code", ""), str(i.get("paragraphId", "")), str(i.get("assetId", ""))))
    levels = Counter(i["severity"] for i in issues)
    degraded = sorted({i["page"] for i in issues if i.get("fallback") and isinstance(i.get("page"), int) and i["page"] in pages})
    return {"version": QUALITY_VERSION, "issues": issues, "summary": {
        "status": "degraded" if levels["error"] or degraded else "review" if levels["warning"] else "ok",
        "issueCount": len(issues), "errorCount": levels["error"], "warningCount": levels["warning"], "infoCount": levels["info"],
        "byCode": dict(sorted(Counter(i["code"] for i in issues).items())), "degradedPages": degraded,
        "paragraphs": len(paragraphs), "mathAssets": len(maths), "figures": len(figures)}}


def _inside(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def run_batch(samples, output_dir, workspace=None, parse_function=None):
    """Create independent evidence/report files; never update imported papers."""
    workspace = Path(workspace or Path(__file__).resolve().parents[1]).resolve()
    output = Path(output_dir).resolve()
    sources = [(name, Path(path).resolve()) for name, path in samples]
    if _inside(output, workspace / ".reader-data") or any(_inside(output, path.parent) for _, path in sources):
        raise ValueError("QA 输出目录不能位于 live .reader-data 或输入 PDF 所在目录内")
    if parse_function is None:
        try:
            from scripts.parse_pdf import parse_pdf
        except ModuleNotFoundError:
            from parse_pdf import parse_pdf
        parse_function = parse_pdf
    output.mkdir(parents=True, exist_ok=True)
    records, seen = [], set()
    for name, source in sources:
        slug = re.sub(r"[^a-z0-9_-]", "-", name.lower()).strip("-") or "sample"
        if slug in seen:
            raise ValueError("样本名称不能重复")
        seen.add(slug)
        record = {"name": name, "source": str(source), "status": "missing"}
        start = time.perf_counter()
        if source.is_file():
            record["sourceSha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
            try:
                target = output / slug
                target.mkdir(parents=True, exist_ok=True)
                doc = parse_function(source, f"qa-{slug}", source.name, target / "assets")
                doc["quality"] = audit_document(doc, target / "assets", doc.get("quality", {}).get("issues", []))
                (target / "document.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
                record.update(status="parsed", document=str(target / "document.json"), parser=doc.get("parser"), pageCount=doc.get("pageCount"), quality=doc["quality"])
            except Exception as exc:
                record.update(status="failed", error=f"{type(exc).__name__}: {exc}")
        record["elapsedSeconds"] = round(time.perf_counter()-start, 3)
        records.append(record)
    report = {"version": QUALITY_VERSION, "samples": records}
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# PDF 解析质量批量审计", "", "仅写独立预览；原 PDF 与 live 文档保持不变。", "", "| 样本 | 状态 | 页数 | 正文段 | 图 | 公式 | 错误 | 警告 |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for record in records:
        q = record.get("quality", {}).get("summary", {})
        lines.append(f"| {record['name']} | {record['status']} / {q.get('status', '—')} | {record.get('pageCount', '—')} | {q.get('paragraphs', '—')} | {q.get('figures', '—')} | {q.get('mathAssets', '—')} | {q.get('errorCount', '—')} | {q.get('warningCount', '—')} |")
    for record in records:
        lines.extend(["", f"## {record['name']}", "", f"来源：`{record['source']}`", "", f"SHA-256：`{record.get('sourceSha256', 'missing')}`", ""])
        if record.get("error"):
            lines.append(record["error"])
        for issue in record.get("quality", {}).get("issues", []):
            lines.append(f"- p{issue.get('page')} `{issue['code']}` ({issue['severity']}): {issue['message']} {issue.get('paragraphId', issue.get('assetId', ''))}")
    (output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--document")
    parser.add_argument("--asset-dir")
    parser.add_argument("--batch", action="store_true")
    parser.add_argument("--output-dir", default="output/parse-quality-qa")
    parser.add_argument("--sample", action="append", default=[], metavar="NAME=PDF")
    args = parser.parse_args()
    if args.document:
        document = json.loads(sys.stdin.read() if args.document == "-" else Path(args.document).read_text(encoding="utf-8"))
        print(json.dumps(audit_document(document, args.asset_dir, document.get("quality", {}).get("issues", [])), ensure_ascii=False))
        return
    if not args.batch:
        parser.error("使用 --document FILE 只读审计，或 --batch 创建独立预览")
    workspace = Path(__file__).resolve().parents[1]
    if not args.sample:
        parser.error("--batch 必须显式指定 --sample NAME=PDF；不会自动读取本地论文库")
    samples = []
    for sample in args.sample:
        if "=" not in sample or not all(part.strip() for part in sample.split("=", 1)):
            parser.error("--sample 格式为非空的 NAME=PDF")
        samples.append(tuple(sample.split("=", 1)))
    report = run_batch(samples, args.output_dir, workspace)
    print(json.dumps({"version": QUALITY_VERSION, "report": str(Path(args.output_dir).resolve() / "report.json"), "samples": [{"name": r["name"], "status": r["status"], "quality": r.get("quality", {}).get("summary")} for r in report["samples"]]}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc), "type": type(exc).__name__}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
