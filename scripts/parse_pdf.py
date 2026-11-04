"""Local, geometry-aware extraction for native-text academic PDFs.

This is deliberately a conservative baseline, not an OCR or equation recognizer.
All reflowed text retains its PDF page/box and original extracted lines.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import statistics
import sys
import unicodedata

import pdfplumber
try:
    from scripts.parse_quality import audit_document, math_prose_suspicion
except ModuleNotFoundError:
    from parse_quality import audit_document, math_prose_suspicion

VERSION = "0.7.0"
MAX_PAGES = 200
ABBREVIATIONS = re.compile(
    r"\b(?:e\.g|i\.e|a\.k\.a|et\s+al|Fig|Figs|Eq|Eqs|Sec|Secs|Ref|Refs|"
    r"Dr|Prof|Mr|Mrs|Ms|vs|cf|No|Nos|Vol|pp|approx|resp|etc)\.", re.I
)
COMMON_HEADING = re.compile(
    r"^(?:abstract|introduction|related work|background|preliminaries|method(?:s|ology)?|"
    r"approach|experiments?|results?(?: and discussion)?|discussion|conclusions?|"
    r"limitations|references|acknowledg(?:e)?ments?|appendix(?:\s+[A-Z])?|supplementary material)$", re.I
)
NUMBERED_HEADING = re.compile(r"^(?:\d{1,2}(?:\.\d{1,2})*\.?|[IVXLCDM]+\.|[A-Z]\.)\s+[A-Z]")
CAPTION = re.compile(r"^(?:Fig(?:ure)?\.?|Table)\s*\d+[\s.:]", re.I)
KEEP_HYPHENS = {
    "self", "non", "state", "multi", "cross", "zero", "first", "second", "well",
    "pre", "post", "semi", "co", "task", "domain", "long", "short", "large",
    "small", "image", "context", "data", "model", "low", "high", "real", "end",
    "sequence", "position", "attention", "feed", "encoder", "decoder", "point",
    "dot", "single", "time", "fine", "fully", "machine", "open", "key", "value",
}
MATH_FONT = re.compile(r"CMMI|CMSY|CMEX|MSBM|MSAM|MTSYN|RMTMI|MTEX|(?:^|[+\-])Symbol|Math|STIX", re.I)
MATH_SYMBOL = re.compile(r"[∈∉∑∏√∞≤≥≠≈≡∝∂∇×÷±∩∪⊂⊆⊗⊙→↦α-ωΑ-Ω]")
MATH_FUNCTIONS = {"max", "min", "sin", "cos", "tan", "log", "exp", "lim", "relu", "softmax", "arg", "diag", "split", "concat", "mlp", "ln", "mra", "msa"}


def median(values, fallback=10.0):
    return statistics.median(values) if values else fallback


def normalize_text(text):
    return unicodedata.normalize("NFKC", text).replace("\u00ad", "").replace("\u0000", "")


def join_lines(lines):
    """Join typography's line wraps, retaining rawText separately on each block."""
    result = ""
    for line in lines:
        text = re.sub(r"\s+", " ", normalize_text(line)).strip()
        if not text:
            continue
        if result.endswith("-") and re.match(r"^[a-z]", text):
            ending = re.search(r"([A-Za-z]+)-$", result)
            prefix = ending.group(1).lower() if ending else ""
            first_token = text.split()[0]
            proper_compound = ending and ending.group(1)[0].isupper() and len(prefix) > 3
            if len(prefix) >= 2 and prefix not in KEEP_HYPHENS and not proper_compound and "-" not in first_token:
                result = result[:-1] + text
            else:
                result += text
        else:
            result = (result + " " + text).strip()
    return result


def split_sentences(text):
    """Protect abbreviations/initials/decimals before locating punctuation."""
    protected = ABBREVIATIONS.sub(lambda m: m.group().replace(".", "\uE000"), text)
    protected = re.sub(r"(?<=\d)\.(?=\d)", "\uE000", protected)
    protected = re.sub(r"\b[A-Z]\.(?=\s+[A-Z](?:\.|[a-z]))", lambda m: m.group().replace(".", "\uE000"), protected)
    protected = re.sub(r"\b(?:[A-Za-z]\.){2,}", lambda m: m.group().replace(".", "\uE000"), protected)
    chunks, start = [], 0
    for boundary in re.finditer(r"(?<=[.!?])([\"'”’)\]]*)\s+(?=[\"'“‘(\[]*[A-Za-z0-9⟦])", protected):
        end = boundary.start() + len(boundary.group(1))
        chunks.append(protected[start:end])
        start = boundary.end()
    chunks.append(protected[start:])
    return [chunk.replace("\uE000", ".").strip() for chunk in chunks if chunk.strip()]


def author_region(rows, body_size):
    """The first-page title/abstract boundary is stronger than font styling.

    Author superscripts and institution numbers are not independent prose.
    """
    abstracts = [r for r in rows if re.match(r"^Abstract(?:[.:\s]|$)", r["text"], re.I)]
    if not abstracts:
        return None
    abstract_top = min(r["top"] for r in abstracts)
    titles = [r for r in rows if r["bottom"] < abstract_top and r["size"] > body_size * 1.25 and len(re.sub(r"[^A-Za-z]", "", r["text"])) >= 8]
    if not titles:
        return None
    biggest = max(r["size"] for r in titles)
    title_end = max(r["bottom"] for r in titles if r["size"] >= biggest * .9)
    return (title_end + 1, abstract_top - 1) if abstract_top - title_end > body_size * 2 else None


def math_seed(word):
    if re.fullmatch(r"[·•⋅]+", word["text"].strip()):
        return False
    font = str(word.get("fontname", ""))
    italic_variable = re.search(r"Ital|Italic|Oblique", font, re.I) and re.fullmatch(r"[A-Za-z][′']*", word["text"])
    font_seed = bool(MATH_FONT.search(font))
    if re.search(r"STIX", font, re.I) and not re.search(r"STIX.*(?:Math|Symbol|Size[1-5]|NonUnicode|Integral|Variant)", font, re.I):
        # STIXTwoText and STIXGeneral are also ordinary text families; their
        # name alone cannot turn an entire prose paragraph into one equation.
        font_seed = False
    return bool(font_seed or MATH_SYMBOL.search(word["text"]) or italic_variable)


def math_support(word, body_size):
    text = word["text"].strip()
    local_size = word.get("_mathContextSize", body_size)
    return bool(re.fullmatch(r"[\d.(){}\[\]=+\-−⋅·×*/|<>≤≥′'!,]+", text) or text.lower() in MATH_FUNCTIONS or (word.get("size", body_size) < local_size * .82 and re.fullmatch(r"[A-Za-z0-9]{1,4}", text)))


def box_for_words(words):
    return (min(w["x0"] for w in words), min(w["top"] for w in words), max(w["x1"] for w in words), max(w["bottom"] for w in words))


def words_touch_math(a, b, body_size):
    """Connect a base and its scripts, without joining two prose baselines."""
    if a.get("_mathBaseline") is not None and b.get("_mathBaseline") is not None and a["_mathBaseline"] != b["_mathBaseline"]:
        return False
    body_size = min(a.get("_mathContextSize", body_size), b.get("_mathContextSize", body_size))
    xgap = max(a["x0"] - b["x1"], b["x0"] - a["x1"], 0)
    ygap = max(a["top"] - b["bottom"], b["top"] - a["bottom"], 0)
    center_gap = abs((a["top"] + a["bottom"] - b["top"] - b["bottom"]) / 2)
    both_base = min(float(a.get("size", body_size)), float(b.get("size", body_size))) > body_size * .83
    if both_base and center_gap > body_size * .72:
        return False
    if xgap > body_size * .72 or ygap > body_size * .6:
        return False
    return center_gap < body_size * 1.1


def protect_math(words, body_size, page_number, start_index=0, metadata_bounds=None, gutter=None, quality_issues=None):
    """Replace *detected source regions*, never reconstruct formula strings.

    Font information identifies the math variables, 2D adjacency includes their
    scripts/operators, and the PDF itself supplies every displayed pixel.
    """
    # A caption is ordinary prose at its own smaller font size. Comparing every
    # word to the full-page body size turns words such as 'and' into scripts and
    # can connect several caption lines into a single enormous formula crop.
    prose_words = [w for w in words if body_size * .48 <= w.get("size", body_size) <= body_size * 1.3 and not math_seed(w) and re.search(r"[A-Za-z]{2,}", w["text"])]
    references = sorted((w["top"] + w["bottom"]) / 2 for w in prose_words)
    baselines = []
    for center in references:
        if not baselines or center - baselines[-1][-1] > body_size * .32:
            baselines.append([center])
        else:
            baselines[-1].append(center)
    baseline_centers = [median(values) for values in baselines]
    if baseline_centers:
        for word in words:
            center = (word["top"] + word["bottom"]) / 2
            word["_mathBaseline"] = min(range(len(baseline_centers)), key=lambda i: abs(center - baseline_centers[i]))
            same_side = lambda w: not gutter or ((w["x0"] + w["x1"]) / 2 < gutter["x"]) == ((word["x0"] + word["x1"]) / 2 < gutter["x"])
            neighbors = [w for w in prose_words if same_side(w) and abs((w["top"] + w["bottom"]) / 2 - center) <= body_size * .48]
            word["_mathContextSize"] = median([w["size"] for w in neighbors], body_size)
    usable = [i for i, w in enumerate(words) if not metadata_bounds or not metadata_bounds[0] <= (w["top"] + w["bottom"]) / 2 <= metadata_bounds[1]]
    seeds = {i for i in usable if math_seed(words[i])}
    if not seeds:
        return words, []
    pool = {i for i in usable if i in seeds or math_support(words[i], body_size)}
    groups = []
    remaining = set(seeds)
    while remaining:
        first = min(remaining)
        group, frontier = {first}, [first]
        while frontier:
            current = frontier.pop()
            for other in list(pool - group):
                if words_touch_math(words[current], words[other], body_size):
                    group.add(other)
                    frontier.append(other)
        remaining -= group
        # A supporting numeral can connect otherwise separate seed components.
        hits = [old for old in groups if old & group]
        for old in hits:
            group |= old
            groups.remove(old)
        groups.append(group)
    # Components from separate seed walks can still share script/support words.
    changed = True
    while changed:
        changed = False
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                if groups[a] & groups[b]:
                    groups[a] |= groups.pop(b)
                    changed = True
                    break
            if changed:
                break
    # Very small primes/superscripts can be nearer the previous prose baseline
    # than their own base glyph. Reattach those tiny components geometrically;
    # never use them as a bridge between two full-size math baselines.
    for group in list(groups):
        if group not in groups or not all(words[i].get("size", body_size) < words[i].get("_mathContextSize", body_size) * .83 for i in group):
            continue
        box = box_for_words([words[i] for i in group])
        local_size = median([words[i].get("_mathContextSize", body_size) for i in group], body_size)
        if box[3] - box[1] > local_size * .95:
            # Inline fractions often use only small glyphs. Their numerator /
            # denominator may overlap the next line vertically, but the whole
            # 2D expression is not a stray prime to reattach across baselines.
            continue
        targets = []
        for other in groups:
            if other is group:
                continue
            ob = box_for_words([words[i] for i in other])
            xgap = max(box[0] - ob[2], ob[0] - box[2], 0)
            ygap = max(box[1] - ob[3], ob[1] - box[3], 0)
            if xgap < body_size * .7 and ygap < body_size * .5:
                targets.append((xgap + ygap * 1.5, other))
        if targets:
            target = min(targets, key=lambda item: item[0])[1]
            target |= group
            groups.remove(group)
    grouped = set().union(*groups)
    for i in usable:
        word = words[i]
        if i in grouped or word.get("size", body_size) >= word.get("_mathContextSize", body_size) * .83 or not math_support(word, body_size):
            continue
        targets = []
        for group in groups:
            distance = float("inf")
            for j in group:
                base = words[j]
                xgap = max(word["x0"] - base["x1"], base["x0"] - word["x1"], 0)
                ygap = max(word["top"] - base["bottom"], base["top"] - word["bottom"], 0)
                if xgap < body_size * .7 and ygap < body_size * .5:
                    distance = min(distance, xgap + ygap * 1.5)
            if math.isfinite(distance):
                targets.append((distance, group))
        if targets:
            min(targets, key=lambda item: item[0])[1].add(i)
            grouped.add(i)
    regions = []
    for group in groups:
        selected = [words[i] for i in group]
        box = box_for_words(selected)
        center = (box[0] + box[2]) / 2
        left, right = (0, gutter["x"]) if gutter and center < gutter["x"] else (gutter["x"], float("inf")) if gutter else (0, float("inf"))
        around = [w for i, w in enumerate(words) if i not in group and left <= (w["x0"] + w["x1"]) / 2 <= right and w["bottom"] > box[1] - body_size * .25 and w["top"] < box[3] + body_size * .25]
        prose = [w for w in around if not math_seed(w) and w["text"].lower() not in MATH_FUNCTIONS and re.search(r"[A-Za-z]{3,}", w["text"]) and w.get("size", body_size) >= w.get("_mathContextSize", body_size) * .83]
        display = "block" if not prose and box[2] - box[0] > body_size * 2.5 and sum(len(w["text"]) for w in selected) >= 3 else "inline"
        regions.append({"indices": set(group), "box": box, "display": display, "bounds": (left, right)})
    # Display equations may have separated sums/limits or large spaces before
    # the equation number. Enclose all math in that same display band.
    for region in regions:
        if region["display"] != "block":
            continue
        x0, top, x1, bottom = region["box"]
        for other in regions:
            if other is region or other["bounds"] != region["bounds"] or other["display"] != "block":
                continue
            ob = other["box"]
            if max(top - ob[3], ob[1] - bottom, 0) < body_size * .75 and abs((top + bottom - ob[1] - ob[3]) / 2) < body_size * 1.7:
                region["indices"] |= other["indices"]
        region["box"] = box_for_words([words[i] for i in region["indices"]])
    # Expanded display bands can overlap transitively. Union the entire
    # component; dropping an overlapping region would silently omit the extra
    # symbols on its final line while leaving its non-math words in the body.
    retained = []
    for region in regions:
        pending = dict(region, indices=set(region["indices"]))
        changed = True
        while changed:
            changed = False
            for old in list(retained):
                if pending["indices"] & old["indices"]:
                    pending["indices"] |= old["indices"]
                    if old["display"] == "block":
                        pending["display"] = "block"
                    retained.remove(old)
                    changed = True
        pending["box"] = box_for_words([words[i] for i in pending["indices"]])
        retained.append(pending)
    trusted = []
    for region in retained:
        selected_text = " ".join(words[i]["text"] for i in sorted(region["indices"]))
        if math_prose_suspicion(selected_text):
            if quality_issues is not None:
                quality_issues.append({"code": "MATH_PROSE_REJECTED", "severity": "warning", "page": page_number,
                                       "message": "数学候选区含连续普通英文，已拒绝转换并保留原始文字，请以原页核对。", "fallback": "original-page"})
            continue
        trusted.append(region)
    retained = trusted
    consumed = set().union(*(r["indices"] for r in retained)) if retained else set()
    replacements, assets = [], []
    for index, region in enumerate(sorted(retained, key=lambda r: (r["box"][1], r["box"][0])), start_index + 1):
        chosen = [words[i] for i in region["indices"]]
        x0, top, x1, bottom = region["box"]
        label = ""
        if region["display"] == "block":
            number_words = [i for i, w in enumerate(words) if i not in consumed and w["x0"] > x1 + body_size and w["x1"] < region["bounds"][1] and top - body_size < (w["top"] + w["bottom"]) / 2 < bottom + body_size * .5 and re.fullmatch(r"\(?\d+[a-z]?\)?", w["text"])]
            if number_words:
                number = max(number_words, key=lambda i: words[i]["x0"])
                label = " " + words[number]["text"]
                consumed.add(number)
        math_id = f"m{index:03d}"
        token = f"⟦MATH_{math_id}⟧"
        raw = " ".join(w["text"] for w in sorted(chosen, key=lambda w: (round(w["top"] / 4), w["x0"])))
        local_size = median([w.get("_mathContextSize", body_size) for w in chosen], body_size)
        bases = [w for w in chosen if w.get("size", body_size) >= local_size * .83]
        baseline_top = median([w["top"] for w in bases], top)
        source_box = {"page": page_number, "x0": round(x0, 2), "y0": round(top, 2), "x1": round(x1, 2), "y1": round(bottom, 2)}
        assets.append({"id": math_id, "token": token, "display": region["display"], "page": page_number,
                       "sourceBox": source_box, "sourceFontSize": round(local_size, 3), "alt": f"第 {page_number} 页原始数学表达式", "textHint": raw, "rawText": raw,
                       "_glyphBoxes": [(w["x0"], w["top"], w["x1"], w["bottom"]) for w in chosen],
                       "_maskBoxes": [(w["x0"], w["top"], w["x1"], w["bottom"]) for i, w in enumerate(words) if i not in region["indices"] and w["x0"] < x1 + 1 and w["x1"] > x0 - 1 and w["top"] < bottom + 1 and w["bottom"] > top - 1]})
        replacements.append({"text": token + label, "rawText": raw + label, "x0": x0, "x1": x1, "top": baseline_top,
                             "bottom": baseline_top + local_size, "size": local_size, "fontname": "SourceMathImage",
                             "upright": True, "_equation": region["display"] == "block", "_sourceBox": source_box})
    return [w for i, w in enumerate(words) if i not in consumed] + replacements, assets


def render_math_assets(page, entries, document_id, asset_dir):
    if not entries:
        return
    from PIL import Image, ImageDraw
    image = page.to_image(resolution=220, antialias=True).original.convert("RGB")
    sx, sy = image.width / page.width, image.height / page.height
    for entry in entries:
        box = entry["sourceBox"]
        target = f"math-{entry['id']}.png"
        rect = (max(0, math.floor((box["x0"] - .7) * sx)), max(0, math.floor((box["y0"] - .8) * sy)), min(image.width, math.ceil((box["x1"] + .7) * sx)), min(image.height, math.ceil((box["y1"] + .8) * sy)))
        crop = image.crop(rect)
        mask_boxes = entry.pop("_maskBoxes", [])
        glyph_boxes = entry.pop("_glyphBoxes", [])
        if mask_boxes:
            # Font boxes can overlap the previous prose line by a fraction of a
            # point. Remove only those unrelated text regions, protecting every
            # selected math glyph and retaining vector fraction/radical strokes.
            mask = Image.new("L", crop.size, 255)
            draw = ImageDraw.Draw(mask)
            for rectangles, fill in ((mask_boxes, 0), (glyph_boxes, 255)):
                for x0, y0, x1, y1 in rectangles:
                    draw.rectangle((math.floor(x0 * sx) - rect[0], math.floor(y0 * sy) - rect[1], math.ceil(x1 * sx) - rect[0], math.ceil(y1 * sy) - rect[1]), fill=fill)
            clean = Image.new("RGB", crop.size, "white")
            clean.paste(crop, (0, 0), mask)
            crop = clean
        crop.save(asset_dir / target, "PNG")
        entry["url"] = f"/api/documents/{document_id}/assets/{target}"
        entry["width"] = round(box["x1"] - box["x0"] + 1.4, 2)
        entry["height"] = round(box["y1"] - box["y0"] + 1.6, 2)


def consolidate_author_metadata(blocks, bounds, page, document_id, asset_dir):
    if not bounds:
        return blocks
    selected = [b for b in blocks if b["page"] == 1 and bounds[0] <= (b["sourceBoxes"][0]["y0"] + b["sourceBoxes"][0]["y1"]) / 2 <= bounds[1]]
    if not selected:
        return blocks
    boxes = [b["sourceBoxes"][0] for b in selected]
    box = {"page": 1, "x0": min(b["x0"] for b in boxes), "y0": min(b["y0"] for b in boxes), "x1": max(b["x1"] for b in boxes), "y1": max(b["y1"] for b in boxes)}
    # Use the actual author-region pixels as the preferred visual: superscripts,
    # corresponding-author symbols, diacritics and e-mail remain untouched.
    image = page.crop((max(0, box["x0"] - 2), max(0, box["y0"] - 2), min(page.width, box["x1"] + 2), min(page.height, box["y1"] + 2))).to_image(resolution=180, antialias=True).original
    image.save(asset_dir / "metadata-p1.png", "PNG")
    raw = "\n".join(b["rawText"] for b in sorted(selected, key=lambda b: b["sourceBoxes"][0]["y0"]))
    metadata = {"page": 1, "text": raw, "rawText": raw, "kind": "metadata", "sourceBoxes": [box],
                "sourceImageUrl": f"/api/documents/{document_id}/assets/metadata-p1.png", "_stream": "metadata", "_size": selected[0]["_size"]}
    start = min(blocks.index(b) for b in selected)
    kept = [b for b in blocks if b not in selected]
    kept.insert(start, metadata)
    return kept


def rows_from_words(words):
    """Geometric rows, without assuming the PDF's content-stream order."""
    # A decorative initial spans two or three lines but belongs to the first
    # word, not the line whose center happens to be nearest its own center.
    words = list(words)
    for index, initial in enumerate(words):
        if not re.fullmatch(r"[A-Z]", initial["text"]):
            continue
        candidates = [w for w in words if re.match(r"^[A-Za-z]{2,}", w["text"]) and .3 * initial["size"] < w["size"] < .65 * initial["size"] and 0 <= w["x0"] - initial["x1"] < w["size"] * .4 and abs(w["top"] - initial["top"]) < w["size"] * .5]
        if candidates:
            first = min(candidates, key=lambda w: (w["top"], w["x0"]))
            words[index] = dict(initial, top=first["top"], bottom=first["bottom"], size=first["size"], _dropcap=True, _sourceBox={"y0": initial["top"], "y1": initial["bottom"]})
    rows = []
    for word in sorted(words, key=lambda w: (float(w["top"]), float(w["x0"]))):
        size = float(word.get("size", word["bottom"] - word["top"]) or 10)
        center = (word["top"] + word["bottom"]) / 2
        target = None
        for row in reversed(rows[-5:]):
            if abs(center - row["center"]) <= max(2.8, min(size, row["size"]) * .45):
                target = row
                break
        if target is None:
            rows.append({"words": [word], "center": center, "size": size})
        else:
            target["words"].append(word)
            target["center"] = median([(w["top"] + w["bottom"]) / 2 for w in target["words"]])
            target["size"] = median([float(w.get("size", size)) for w in target["words"]])
    return [line_from_words(row["words"]) for row in rows]


def line_from_words(words):
    words = sorted(words, key=lambda w: float(w["x0"]))
    sizes = [float(w.get("size", w["bottom"] - w["top"]) or 10) for w in words for _ in range(max(1, len(w["text"])))]
    return {
        "words": words,
        "text": join_word_texts(words),
        "rawText": " ".join(w.get("rawText", w["text"]) for w in words).strip(),
        "x0": min(w["x0"] for w in words), "x1": max(w["x1"] for w in words),
        "top": min(w["top"] for w in words), "bottom": max(w["bottom"] for w in words),
        "sourceTop": min(w.get("_sourceBox", {}).get("y0", w["top"]) for w in words),
        "sourceBottom": max(w.get("_sourceBox", {}).get("y1", w["bottom"]) for w in words),
        "size": median(sizes),
        "bold": sum(len(w["text"]) for w in words if re.search(r"bold|black|heavy|semibold", str(w.get("fontname", "")), re.I)) > sum(len(w["text"]) for w in words) * .6,
    }


def join_word_texts(words):
    """A change of font inside one word is not a word boundary."""
    text = ""
    previous = None
    for word in words:
        current = word["text"]
        gap = word["x0"] - previous["x1"] if previous else 100
        tight = previous is not None and gap <= min(previous.get("size", 10), word.get("size", 10)) * .065
        attached = previous is not None and previous.get("_dropcap") or tight and text and (re.match(r"^[,.;:!?)}\]]", current) or text.endswith(("(", "[", "{")) or (text[-1].isalnum() and current[:1].isalnum()))
        text += ("" if not text or attached else " ") + current
        previous = word
    return text.strip()


def detect_gutter(rows, width, height):
    """A stable unoccupied vertical strip across body rows suggests two columns."""
    body = [r for r in rows if height * .14 < r["top"] < height * .91 and len(r["text"]) > 20]
    if len(body) < 8:
        return None
    candidates = []
    for x in range(int(width * .39), int(width * .61) + 1):
        crossing = sum(any(w["x0"] < x + 1 and w["x1"] > x - 1 for w in r["words"]) for r in body)
        left = sum(any(w["x1"] < x - 12 for w in r["words"]) for r in body)
        right = sum(any(w["x0"] > x + 12 for w in r["words"]) for r in body)
        global_evidence = crossing / len(body) <= .2 and min(left, right) >= max(7, len(body) * .38)
        # Full-width figures/captions may occupy most of a page. A sustained
        # local band of actual prose on both sides is sufficient evidence even
        # when the full page is not predominantly two-column text.
        supporting = []
        for row in body:
            lhs = [w for w in row["words"] if w["x1"] <= x - 1]
            rhs = [w for w in row["words"] if w["x0"] >= x + 1]
            if not lhs or not rhs or any(w["x0"] < x + 1 and w["x1"] > x - 1 for w in row["words"]):
                continue
            if min(sum(len(re.sub(r"[^A-Za-z]", "", w["text"])) for w in side) for side in (lhs, rhs)) < 22:
                continue
            if min(max(w["x1"] for w in side) - min(w["x0"] for w in side) for side in (lhs, rhs)) < width * .25:
                continue
            supporting.append(row["top"])
        local_evidence = any(len([y for y in supporting if start <= y <= start + 125]) >= 8 for start in supporting)
        if global_evidence or local_evidence:
            candidates.append(x)
    runs = []
    for x in candidates:
        if runs and x == runs[-1][-1] + 1:
            runs[-1].append(x)
        else:
            runs.append([x])
    runs = [run for run in runs if len(run) >= max(9, width * .014)]
    if not runs:
        return None
    run = max(runs, key=lambda r: len(r) - abs(median(r) - width / 2) * .12)
    # Large diagrams can create an unusually wide whitespace valley on one
    # side of the real gutter. Prefer the page center *inside* that valley,
    # rather than shifting the split into the left column's caption text.
    split_x = min(max(width / 2, run[0] + 2), run[-1] - 2)
    separations = []
    for row in body:
        lhs = [w["x1"] for w in row["words"] if w["x1"] <= split_x]
        rhs = [w["x0"] for w in row["words"] if w["x0"] >= split_x]
        if lhs and rhs and not any(w["x0"] < split_x < w["x1"] for w in row["words"]):
            separations.append(min(rhs) - max(lhs))
    # Lower quantiles recover the true narrow gutter despite ragged final lines.
    separations.sort()
    gap = separations[len(separations) // 5] if separations else run[-1] - run[0] + 2
    return {"x": split_x, "left": run[0], "right": run[-1], "gap": gap}


def ordered_lines(rows, width, height):
    gutter = detect_gutter(rows, width, height)
    if gutter is None:
        return [dict(r, stream="single", columnRight=max(x["x1"] for x in rows)) for r in sorted(rows, key=lambda r: r["top"])], False
    x = gutter["x"]
    result, band = [], []
    band_index = 0
    full_caption = None

    def flush():
        nonlocal band_index
        if not band:
            return
        for side in ("left", "right"):
            # Independent columns can have different baselines or font sizes.
            # Regroup their words after splitting instead of retaining rows
            # formed by unrelated text on the opposite side of the page.
            ws = [w for row in band for w in row["words"] if ((w["x0"] + w["x1"]) / 2 < x) == (side == "left")]
            items = rows_from_words(ws)
            if items:
                right = max(line["x1"] for line in items)
                for item in sorted(items, key=lambda r: r["top"]):
                    result.append(dict(item, stream=f"{side}-{band_index}", columnRight=right))
        band.clear()
        band_index += 1

    for row in sorted(rows, key=lambda r: r["top"]):
        left = [w for w in row["words"] if w["x1"] <= x]
        right = [w for w in row["words"] if w["x0"] >= x]
        cross = any(w["x0"] < x < w["x1"] for w in row["words"])
        gap = min((w["x0"] for w in right), default=x + 100) - max((w["x1"] for w in left), default=x - 100)
        spanning = row["x0"] < x - 25 and row["x1"] > x + 25 and (cross or gap < max(2, min(gutter["gap"], width * .025) * .55))
        caption_tail = full_caption and (not left or not right) and 0 <= row["top"] - full_caption["bottom"] < row["size"] * .7 and abs(row["size"] - full_caption["size"]) < row["size"] * .12 and abs(row["x0"] - full_caption["x0"]) < row["size"]
        spanning = spanning or caption_tail
        if spanning:
            flush()
            result.append(dict(row, stream=f"full-{band_index}", columnRight=row["x1"]))
            # Consecutive full-width text lines must share a stream.
            full_caption = row if CAPTION.match(row["text"]) or full_caption and abs(row["size"] - full_caption["size"]) < row["size"] * .12 and row["top"] - full_caption["bottom"] < row["size"] * .7 else None
        else:
            band.append(row)
            full_caption = None
    flush()
    return result, True


def classify_line(line, body_size):
    text = line["text"].strip()
    if any(w.get("_equation") for w in line["words"]) and all(w.get("_equation") or re.fullmatch(r"[\d()\s,.;:]+", w["text"]) for w in line["words"]):
        return "equation"
    if CAPTION.match(text):
        body_reference = line["size"] >= body_size*.94 and re.match(r"^Fig(?:ure)?\.?\s*\d+[a-z]?[.:\s]*(?:\([^)]*\)\s*)?(?:(?:shows?|illustrates?|demonstrates?|compares?|reports?|is|are)\b|(?:First|Second|Third),)", text, re.I)
        if not body_reference:
            return "caption"
    short = len(text) < 175 and len(text.split()) < 24
    terminal = bool(re.search(r"[.!?;]$", text))
    numbered = bool(NUMBERED_HEADING.match(text)) and len(text.split()) < 18 and not terminal and line["size"] >= body_size * .97
    roman = bool(re.match(r"^[IVXLCDM]+\.\s+[A-Z][A-Z\s,–—:&-]+$", text))
    if re.match(r"^[A-Z]\.\s", text) and not roman:
        numbered = numbered and line["size"] > body_size * 1.06
    numbered = numbered or roman and line["size"] >= body_size * .74
    large_heading = line["size"] > body_size * 1.32 and not terminal and len(text.split()) <= 18
    if short and len(re.sub(r"[^A-Za-z]", "", text)) >= 3 and (COMMON_HEADING.fullmatch(text) or numbered or large_heading or (line["bold"] and line["size"] > body_size * 1.04 and not terminal and len(text.split()) <= 13)):
        return "heading"
    return "paragraph"


def paragraphs_from_lines(lines, page, body_size):
    blocks, current = [], []
    current_kind = "paragraph"

    def flush():
        if not current:
            return
        raw = "\n".join(r.get("rawText", r["text"]) for r in current)
        blocks.append({
            "page": page, "text": join_lines([r["text"] for r in current]), "rawText": raw,
            "kind": current_kind,
            "sourceBoxes": [{"page": page, "x0": round(min(r["x0"] for r in current), 2), "y0": round(min(r.get("sourceTop", r["top"]) for r in current), 2), "x1": round(max(r["x1"] for r in current), 2), "y1": round(max(r.get("sourceBottom", r["bottom"]) for r in current), 2)}],
            "_stream": current[0]["stream"], "_size": median([r["size"] for r in current]),
        })
        current.clear()

    for line in lines:
        kind = classify_line(line, body_size)
        new = False
        if current:
            prev = current[-1]
            gap = line["top"] - prev["bottom"]
            stream_changed = line["stream"] != prev["stream"]
            style_changed = abs(line["size"] - prev["size"]) > body_size * .16
            indent = line["x0"] - prev["x0"] > body_size * .7
            previous_short = prev["x1"] < prev["columnRight"] - body_size * 2.8
            previous_end = bool(re.search(r"[.!?:;][\"')\]]?$", prev["text"]))
            # All headings become standalone navigable blocks, except a wrapped
            # title sharing the same large type and stream.
            wrapped_heading = kind == current_kind == "heading" and not stream_changed and not style_changed and gap < body_size * .55 and not NUMBERED_HEADING.match(line["text"])
            new = stream_changed or gap > body_size * .64 or (kind == "heading" or current_kind == "heading") and not wrapped_heading
            new = new or (current_kind != "heading" and (style_changed or (indent and previous_end) or (previous_short and previous_end)))
            new = new or kind == "caption" and current_kind != "caption"
            new = new or kind == "equation" or current_kind == "equation"
            new = new or bool(re.match(r"^(?:[•●▪]|\(?\d+\))\s", line["text"]))
            new = new or previous_end and bool(re.match(r"^\[[0-9]+\]\s", line["text"]))
        if new:
            flush()
        if not current:
            current_kind = kind
        current.append(line)
    flush()
    return blocks


def margin_key(text):
    return re.sub(r"\d+", "#", re.sub(r"\s+", " ", text).strip().lower())


def margin_row_key(row):
    # Running page numbers can move from the far left to the far right on
    # alternating pages. Compare the header text, not those distant numerals.
    groups = [[]]
    for word in row["words"]:
        if groups[-1] and word["x0"] - groups[-1][-1]["x1"] > 35:
            groups.append([])
        groups[-1].append(word)
    return margin_key(join_word_texts(max(groups, key=lambda ws: sum(len(w["text"]) for w in ws))))


def repeated_margins(page_rows):
    seen = Counter()
    for rows, _, height in page_rows:
        keys = {margin_row_key(r) for r in rows if r["top"] < height * .085 or r["bottom"] > height * .935}
        seen.update(keys)
    threshold = max(2, math.ceil(len(page_rows) * .35))
    return {key for key, count in seen.items() if count >= threshold}


def first_page_publication(rows, width, height, body_size):
    """IEEE's first-page manuscript/affiliation note can fill half a column.

    Its explicit manuscript-history opening plus continuous smaller type is
    stronger evidence than a generic bottom-margin or institution keyword.
    """
    gutter = detect_gutter(rows, width, height)
    if not gutter:
        return rows, []
    all_words = [w for row in rows for w in row["words"]]
    removed, records = set(), []
    for is_left in (True, False):
        ws = [w for w in all_words if ((w["x0"] + w["x1"]) / 2 < gutter["x"]) == is_left]
        local_rows = rows_from_words(ws)
        starts = [i for i, r in enumerate(local_rows) if re.match(r"^Manuscript\s+received\b", r["text"], re.I) and r["top"] > height * .45 and r["size"] <= body_size * .88]
        if not starts:
            continue
        selected = []
        for row in local_rows[starts[0]:]:
            if row["size"] > body_size * .9 or row["top"] > height * .925 or selected and row["top"] - selected[-1]["bottom"] > body_size * 2:
                break
            selected.append(row)
            if re.match(r"^Digital Object Identifier\b", row["text"], re.I):
                break
        if selected:
            removed.update(id(w) for r in selected for w in r["words"])
            box = {"page": 1, "x0": round(min(r["x0"] for r in selected), 2), "y0": round(selected[0]["top"], 2), "x1": round(max(r["x1"] for r in selected), 2), "y1": round(selected[-1]["bottom"], 2)}
            records.append(peripheral_record("publication", join_lines([r["text"] for r in selected]), 1, [box]))
    return rows_from_words([w for w in all_words if id(w) not in removed]), records


def peripheral_record(kind, text, page_number, boxes):
    text = re.sub(r"\s+", " ", text).strip()
    if kind == "publication":
        text = re.sub(r"^\(cid:\d+\)\s*c\b", "©", text)
    digest = hashlib.sha256(json.dumps([kind, text, page_number, boxes], ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
    return {"id": f"peripheral-{digest}", "kind": kind, "text": text, "page": page_number, "sourceBoxes": boxes}


def classify_peripheral_block(block, page_height, page_width, body_size, rules, in_references=False):
    """Position and type/geometry must agree before prose leaves the body.

    A mention of 'supplementary' or a DOI *inside ordinary body text* is not
    enough. First-page publisher notices typically sit below a short rule and
    use smaller type; academic footnotes get the same preservation treatment.
    """
    if block["kind"] in {"metadata", "caption", "equation"}:
        return None
    if in_references:
        return None
    box = block["sourceBoxes"][0]
    y0 = box["y0"]
    size = block.get("_size", body_size)
    raw = re.sub(r"\s+", " ", block.get("rawText", block["text"])).strip()
    lower_page = y0 > page_height * .74
    small_type = size <= body_size * .94
    short_rule = any(
        abs(rule.get("bottom", rule["top"]) - rule["top"]) <= 1.5
        and page_width * .045 <= rule["x1"] - rule["x0"] <= page_width * .48
        and rule["top"] > page_height * .64
        and 0 <= y0 - rule["top"] <= body_size * 1.4
        and abs(box["x0"] - rule["x0"]) < body_size * 2.5
        for rule in rules
    )
    publisher = bool(re.search(
        r"under (?:an? )?exclusive licen[cs]e|copyright|©|personal use is permitted|ieee\.org/publications/rights|springer(?: nature)?|"
        r"the author\(s\)|all rights reserved|(?:LNCS|LNAI|LNC[SIN])\s*\d+|"
        r"supplementary information\s+the online version|"
        r"^https?://(?:dx\.)?doi\.org/10\.|\b(?:conference|proceedings)\b.*\b(?:19|20)\d{2}\b",
        raw, re.I
    ))
    if lower_page and small_type and publisher:
        return "publication"
    marked_note = block.get("isFootnote") and bool(re.match(r"^(?:[†‡*]|\d{1,2}(?:\s+|$))", raw))
    if lower_page and small_type and (short_rule or marked_note):
        return "footnote"
    return None


def join_continuations(blocks, page_dimensions):
    merged = []
    for block in blocks:
        if merged:
            # A floating figure/caption at the top of the next page does not
            # interrupt the prose paragraph continued below it.
            prev_index = len(merged) - 1
            while prev_index > 0 and (merged[prev_index]["kind"] == "caption" or merged[prev_index].get("isFootnote")):
                prev_index -= 1
            prev = merged[prev_index]
            skipped_caption = prev_index < len(merged) - 1
            pb, nb = prev["sourceBoxes"][-1], block["sourceBoxes"][0]
            same_page_columns = pb["page"] == nb["page"] and prev["_stream"].startswith("left-") and block["_stream"].startswith("right-") and prev["_stream"].split("-", 1)[1] == block["_stream"].split("-", 1)[1]
            next_page = nb["page"] == pb["page"] + 1
            height = page_dimensions[pb["page"] - 1][1]
            next_height = page_dimensions[nb["page"] - 1][1]
            continuation = bool(re.match(r"^[a-z(\[]", block["text"])) or prev["text"].endswith("-")
            continuation = continuation or bool(re.search(r"\b(?:a|an|the|of|to|in|for|and|or|with|as|by|from|than|that|which|on|is|are|was|were)$", prev["text"], re.I))
            can_join = prev["kind"] == block["kind"] == "paragraph" and not prev.get("isFootnote") and not block.get("isFootnote") and (same_page_columns or next_page)
            can_join = can_join and (same_page_columns or pb["y1"] > height * .72 and nb["y0"] < next_height * (.65 if skipped_caption else .3))
            can_join = can_join and continuation and not re.search(r"[.!?:;][\"')\]]?$", prev["text"])
            can_join = can_join and abs(prev["_size"] - block["_size"]) < 1.5
            if can_join:
                prev["text"] = join_lines([prev["text"], block["text"]])
                prev["rawText"] += "\n" + block["rawText"]
                prev["sourceBoxes"].extend(block["sourceBoxes"])
                prev["_stream"] = block["_stream"]
                continue
        merged.append(block)
    return merged


def render_page(input_path, output_path, page_number, resolution=120):
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(str(input_path)) as pdf:
        if page_number < 1 or page_number > len(pdf):
            raise ValueError("页码超出 PDF 范围")
        page = pdf[page_number - 1]
        bitmap = page.render(scale=resolution / 72)
        image = bitmap.to_pil()
        target = Path(output_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, format="PNG")
        bitmap.close()
        page.close()


def overlap_ratio(a, b):
    area = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return area / max(1, min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])))


def compose_pdf_matrix(a, b):
    """Apply PDF matrix a, then b (the cm operator's concatenation order)."""
    return (a[0]*b[0] + a[1]*b[2], a[0]*b[1] + a[1]*b[3],
            a[2]*b[0] + a[3]*b[2], a[2]*b[1] + a[3]*b[3],
            a[4]*b[0] + a[5]*b[2] + b[4], a[4]*b[1] + a[5]*b[3] + b[5])


def transformed_form_box(box, matrix, page_height):
    points = [(matrix[0]*x + matrix[2]*y + matrix[4], matrix[1]*x + matrix[3]*y + matrix[5]) for x in (float(box[0]), float(box[2])) for y in (float(box[1]), float(box[3]))]
    return (min(p[0] for p in points), page_height - max(p[1] for p in points), max(p[0] for p in points), page_height - min(p[1] for p in points))


def figure_form_regions(page):
    """Use visible Form envelopes, never un-clipped image object extents.

    A PDF can reuse a huge image behind many tiny clip windows. Its reported
    image bbox is not a visible figure bbox. A Form's enclosing BBox retains
    its subfigures, outlined text, legends and internal clipping as one unit.
    """
    identity = (1., 0., 0., 1., 0., 0.)
    try:
        from pypdf import PdfReader
        from pypdf.generic import ContentStream
        reader = getattr(page.pdf, "_figure_reader", None)
        if reader is None:
            reader = PdfReader(page.pdf.stream.name)
            page.pdf._figure_reader = reader
        source = reader.pages[page.page_number - 1]
        if source.rotation or list(source.cropbox) != [0, 0, page.width, page.height]:
            return []
        found, budget = [], [50000]

        def walk(stream, resources, matrix, depth, ancestors, inherited_clip=False):
            if depth > 5 or stream is None or budget[0] <= 0:
                return
            resources = resources.get_object() if hasattr(resources, "get_object") else resources
            stack, clipped = [], inherited_clip
            operations = stream.operations if hasattr(stream, "operations") else ContentStream(stream, reader).operations
            for operands, op in operations:
                budget[0] -= 1
                if budget[0] <= 0:
                    break
                if op == b"q":
                    stack.append((matrix, clipped))
                elif op == b"Q" and stack:
                    matrix, clipped = stack.pop()
                elif op == b"cm":
                    matrix = compose_pdf_matrix(tuple(float(v) for v in operands), matrix)
                elif op in (b"W", b"W*"):
                    clipped = True
                elif op == b"Do" and resources:
                    objects = resources.get("/XObject", {})
                    objects = objects.get_object() if hasattr(objects, "get_object") else objects
                    ref = objects.get(operands[0])
                    if ref is None:
                        continue
                    obj = ref.get_object()
                    if obj.get("/Subtype") != "/Form" or id(obj) in ancestors:
                        continue
                    local = compose_pdf_matrix(tuple(float(v) for v in obj.get("/Matrix", identity)), matrix)
                    if not clipped and obj.get("/BBox"):
                        box = transformed_form_box(obj["/BBox"], local, page.height)
                        w, h = box[2] - box[0], box[3] - box[1]
                        if w >= 55 and h >= 25 and w*h < page.width*page.height*.82 and min(box) >= -2 and box[2] <= page.width + 2 and box[3] <= page.height + 2:
                            found.append({"box": box, "depth": depth})
                    walk(obj, obj.get("/Resources", resources), local, depth + 1, ancestors | {id(obj)}, clipped)
        walk(source.get_contents(), source.get("/Resources", {}), identity, 0, set())
        return found
    except Exception:
        # Unsupported transforms/resources use the explicit layout/page fallback.
        return []


def figure_scope(caption, width, split=None):
    box = caption["sourceBoxes"][0]
    if split is None or box["x0"] < split - 2 and box["x1"] > split + 2:
        return (0, width)
    return (0, split) if (box["x0"] + box["x1"]) / 2 < split else (split, width)


def match_figure_forms(forms, captions, width, height, split=None, header_floor=0):
    """Match a caption to its complete layout region, not its text width."""
    planned = []
    for cap in captions:
        cb = cap["sourceBoxes"][0]
        left, right = figure_scope(cap, width, split)
        previous = [c["sourceBoxes"][0]["y1"] + 2 for c in captions if c is not cap and c["sourceBoxes"][0]["y1"] < cb["y0"] and max(left, figure_scope(c, width, split)[0]) < min(right, figure_scope(c, width, split)[1])]
        floor = max([header_floor] + previous)
        candidates = [f for f in forms if f["box"][0] >= left - 3 and f["box"][2] <= right + 3 and f["box"][1] >= floor and 0 <= cb["y0"] - f["box"][3] <= 45]
        if candidates:
            primary = max(candidates, key=lambda f: (f["box"][2] - f["box"][0]) * (f["box"][3] - f["box"][1]))
            box = primary["box"]
            # Separate sibling Forms may represent panels of one shared figure.
            siblings = [f["box"] for f in candidates if f.get("depth", 0) == primary.get("depth", 0) and min(box[3], f["box"][3]) - max(box[1], f["box"][1]) > min(box[3]-box[1], f["box"][3]-f["box"][1])*.5]
            box = (min(b[0] for b in siblings), min(b[1] for b in siblings), max(b[2] for b in siblings), max(b[3] for b in siblings))
            planned.append({"box": box, "caption": cap, "cropStatus": "form-boundary", "scope": (left, right), "floor": floor})
        else:
            planned.append({"box": None, "caption": cap, "cropStatus": "page-fallback", "scope": (left, right), "floor": floor})
    return planned


def fallback_figure_band(page, plan, paragraphs, tables, body_size):
    """Bound a non-Form figure by its column, previous prose and table grids."""
    cap = plan["caption"]
    cb = cap["sourceBoxes"][0]
    left, right = plan["scope"]
    barriers = [plan["floor"]]
    for p in paragraphs:
        if p is cap or p["kind"] == "caption":
            continue
        if p["kind"] not in {"heading", "metadata"} and not is_body_prose(p, body_size):
            continue
        for b in p["sourceBoxes"]:
            if b["page"] == page.page_number and b["y1"] < cb["y0"] and min(right, b["x1"]) - max(left, b["x0"]) > min(right-left, b["x1"]-b["x0"])*.5:
                barriers.append(b["y1"] + 3)
    barriers.extend(b[3] + 3 for b in tables if b[3] < cb["y0"] - 15 and min(right, b[2]) - max(left, b[0]) > min(right-left, b[2]-b[0])*.5)
    top, bottom = max(barriers), cb["y0"] - 2
    if bottom - top < 30:
        return None
    # Oversized/negative native boxes are evidence of unhandled clipping. Do
    # not turn them into standalone crops or infer a partial visible envelope.
    if any((s["x0"] < -2 or s["x1"] > page.width + 2 or s["bottom"]-s["top"] > page.height*.7) and s["top"] < bottom and s["bottom"] > top for s in page.images):
        return None
    drawings = list(page.curves) + list(page.rects) + list(page.lines) + list(page.images)
    if not any(s["x0"] >= left and s["x1"] <= right and s["top"] >= top and s["bottom"] <= bottom and (s["x1"]-s["x0"] > 25 or s["bottom"]-s["top"] > 25) for s in drawings):
        return None
    return (left, top, right, bottom)


def is_body_prose(paragraph, body_size):
    """A short ordinary sentence is still prose, not an expendable label."""
    text = paragraph.get("text", "")
    return paragraph.get("kind") == "paragraph" and paragraph.get("_size", body_size) >= body_size*.94 and (len(text) > 150 or len(re.findall(r"[A-Za-z]{2,}", text)) >= 5 and bool(re.search(r"[.!?](?:\s|$)", text)))


def figure_safety_conflicts(assets, paragraphs, dimensions, body_size):
    """Find hard geometric/body conflicts before any graphic labels are hidden."""
    conflicts = []
    valid = []
    for asset in assets:
        if asset.get("cropStatus") == "page-fallback":
            continue
        box = asset.get("sourceBox", {})
        page = asset.get("page")
        try:
            xy = tuple(float(box[k]) for k in ("x0", "y0", "x1", "y1"))
            width, height = dimensions[page-1]
            if not all(math.isfinite(v) for v in xy) or not (0 <= xy[0] < xy[2] <= width+.6 and 0 <= xy[1] < xy[3] <= height+.6):
                raise ValueError("invalid box")
        except (TypeError, ValueError, KeyError, IndexError):
            conflicts.append((asset, None, "FIGURE_REGION_REJECTED", "图像区域坐标无效，已改为完整原页视图。"))
            continue
        valid.append((asset, xy))
        for paragraph in paragraphs:
            if not is_body_prose(paragraph, body_size):
                continue
            for source in paragraph.get("sourceBoxes", []):
                if source.get("page") != page:
                    continue
                area = max(1, (source["x1"]-source["x0"])*(source["y1"]-source["y0"]))
                intersection = max(0, min(source["x1"], xy[2])-max(source["x0"], xy[0]))*max(0, min(source["y1"], xy[3])-max(source["y0"], xy[1]))
                if intersection/area > .55:
                    conflicts.append((asset, paragraph, "FIGURE_BODY_PRESERVED", "图像候选区覆盖普通正文，已保留正文并改为完整原页视图。"))
                    break
    for index, (asset, box) in enumerate(valid):
        for other, other_box in valid[index+1:]:
            if asset.get("page") == other.get("page") and overlap_ratio(box, other_box) > .08:
                for candidate in (asset, other):
                    conflicts.append((candidate, None, "FIGURE_REGION_REJECTED", "图像候选区与另一幅图明显重叠，已改为完整原页视图。"))
    return conflicts


def apply_figure_safety(assets, paragraphs, dimensions, body_size, pdf, document_id, asset_dir, quality_issues):
    rendered = {}
    for asset, paragraph, code, message in figure_safety_conflicts(assets, paragraphs, dimensions, body_size):
        page = asset["page"]
        issue = {"code": code, "severity": "warning", "page": page, "assetId": asset["id"], "message": message, "fallback": "original-page"}
        if paragraph:
            issue["paragraphId"] = paragraph["id"]
        quality_issues.append(issue)
        if asset.get("cropStatus") == "page-fallback":
            continue
        if page not in rendered:
            filename = f"figure-v{VERSION.replace('.', '')}-page-fallback-p{page}.jpg"
            pdf.pages[page-1].to_image(resolution=160, antialias=True).original.convert("RGB").save(asset_dir / filename, "JPEG", quality=92)
            rendered[page] = filename
        width, height = dimensions[page-1]
        asset["rejectedSourceBox"] = asset["sourceBox"]
        asset["sourceBox"] = {"page": page, "x0": 0, "y0": 0, "x1": width, "y1": height}
        asset["cropStatus"] = "page-fallback"
        asset["url"] = f"/api/documents/{document_id}/assets/{rendered[page]}"


def extract_assets(page, paragraphs, document_id, asset_dir, peripheral_blocks=None):
    captions = [p for p in paragraphs if p["page"] == page.page_number and p["kind"] == "caption" and re.match(r"^Fig", p["text"], re.I)]
    if not captions and not any(im["x1"]-im["x0"] >= 55 and im["bottom"]-im["top"] >= 30 for im in page.images):
        return []
    words = page.extract_words(x_tolerance=1, x_tolerance_ratio=.13, extra_attrs=["fontname", "size"])
    rows = rows_from_words([w for w in words if w.get("upright", True)])
    gutter = detect_gutter(rows, page.width, page.height)
    header_floor = max((b["sourceBoxes"][0]["y1"] + 3 for b in (peripheral_blocks or []) if b["page"] == page.page_number and b["kind"] == "header"), default=0)
    plans = match_figure_forms(figure_form_regions(page), captions, page.width, page.height, gutter["x"] if gutter else None, header_floor)
    tables = None
    body_size = median([p.get("_size", 10) for p in paragraphs if p["page"] == page.page_number and p["kind"] == "paragraph"], 10)
    for plan in plans:
        if plan["box"] is not None:
            continue
        if tables is None:
            try:
                tables = [t.bbox for t in page.find_tables() if t.bbox[2]-t.bbox[0] > 70 and t.bbox[3]-t.bbox[1] > 20]
            except Exception:
                tables = []
        plan["box"] = fallback_figure_band(page, plan, paragraphs, tables, body_size)
        if plan["box"]:
            plan["cropStatus"] = "layout-band"
    if not plans:
        # An uncaptioned raster is retained as a clearly marked original page,
        # rather than a set of arbitrary PDF image-object fragments.
        plans = [{"box": None, "caption": None, "cropStatus": "page-fallback"}]
    image = page.to_image(resolution=190, antialias=True).original.convert("RGB")
    scale_x, scale_y = image.width / page.width, image.height / page.height
    assets = []
    for i, plan in enumerate(sorted(plans[:16], key=lambda p: p["caption"]["sourceBoxes"][0]["y0"] if p["caption"] else 0)):
        cap, box = plan["caption"], plan["box"]
        if box is None:
            box = (0, 0, page.width, page.height)
            rectangle = (0, 0, image.width, image.height)
        else:
            x0, top, x1, bottom = box
            padding = 2 if plan["cropStatus"] == "form-boundary" else 0
            rectangle = (max(0, math.floor((x0-padding)*scale_x)), max(0, math.floor((top-padding)*scale_y)), min(image.width, math.ceil((x1+padding)*scale_x)), min(image.height, math.ceil((bottom+padding)*scale_y)))
            if plan["cropStatus"] == "layout-band":
                # Trim only the outer white margin; keep all labels and panels
                # rendered inside the safe page/column region.
                ink = image.crop(rectangle).convert("L").point(lambda v: 255 if v < 245 else 0).getbbox()
                if ink:
                    rectangle = (max(rectangle[0], rectangle[0]+ink[0]-5), max(rectangle[1], rectangle[1]+ink[1]-5), min(rectangle[2], rectangle[0]+ink[2]+5), min(rectangle[3], rectangle[1]+ink[3]+5))
                else:
                    plan["cropStatus"] = "page-fallback"
                    rectangle = (0, 0, image.width, image.height)
        source_box = {"page": page.page_number, "x0": round(rectangle[0]/scale_x, 3), "y0": round(rectangle[1]/scale_y, 3), "x1": round(rectangle[2]/scale_x, 3), "y1": round(rectangle[3]/scale_y, 3)}
        crop_hash = hashlib.sha256(json.dumps([source_box, plan["cropStatus"]], sort_keys=True).encode()).hexdigest()[:7]
        filename = f"figure-v{VERSION.replace('.', '')}-p{page.page_number}-{i+1}-{crop_hash}.jpg"
        image.crop(rectangle).save(asset_dir / filename, "JPEG", quality=92)
        assets.append({"id": f"asset-p{page.page_number}-{i+1}", "page": page.page_number, "url": f"/api/documents/{document_id}/assets/{filename}",
                       "caption": cap["text"] if cap else f"第 {page.page_number} 页原页视图", "afterParagraphId": cap["id"] if cap else None,
                       "cropStatus": plan["cropStatus"], "sourceBox": source_box})
    return assets


def parse_pdf(input_path, document_id, filename, asset_dir):
    warnings = ["当前使用版面启发式重排。复杂公式、表格和特殊版式请结合原 PDF 核对；公式不自动重建为 LaTeX。"]
    asset_dir = Path(asset_dir)
    asset_dir.mkdir(parents=True, exist_ok=True)
    paragraphs, sections, assets, dimensions, math_assets, peripheral_blocks = [], [], [], [], [], []
    quality_issues = []
    with pdfplumber.open(str(input_path), unicode_norm="NFKC") as pdf:
        count = len(pdf.pages)
        if count < 1 or count > MAX_PAGES:
            raise ValueError(f"请导入 1–{MAX_PAGES} 页的 PDF，当前为 {count} 页")
        page_rows, blank_pages = [], []
        for page in pdf.pages:
            # Academic PDFs commonly omit actual space characters: infer them
            # from a font-relative gap, rather than a fixed large tolerance.
            # Sideways arXiv stamps must not become lines interspersed in prose.
            words = page.dedupe_chars(tolerance=1).extract_words(x_tolerance=1, x_tolerance_ratio=.13, y_tolerance=3, keep_blank_chars=False, use_text_flow=False, extra_attrs=["fontname", "size"])
            words = [w for w in words if w.get("upright", True) and str(w.get("text", "")).strip() and float(w["bottom"]) > float(w["top"])]
            rows = rows_from_words(words)
            if sum(len(r["text"]) for r in rows) < 30:
                blank_pages.append(page.page_number)
            page_rows.append((rows, page.width, page.height))
            dimensions.append((page.width, page.height))
            # The lightweight word rows are enough for ordering. Drop the much
            # larger cached character layout before parsing subsequent pages.
            page.close()
        if len(blank_pages) == count:
            raise ValueError("此 PDF 没有可可靠提取的文字层，可能是扫描件。当前版本支持电子版 PDF；扫描件需要 OCR。")
        margins = repeated_margins(page_rows)
        two_column = []
        in_references = False
        body_sizes = [r["size"] for rows, _, height in page_rows for r in rows if height * .12 < r["top"] < height * .9 and len(r["text"]) > 55]
        body_size = median(body_sizes)
        for page_number, (rows, width, height) in enumerate(page_rows, 1):
            cleaned = []
            for row in rows:
                in_margin = row["top"] < height * .085 or row["bottom"] > height * .935
                page_num = bool(re.fullmatch(r"[\s\-–—]*\d{1,4}[\s\-–—]*", row["text"]))
                if in_margin and (margin_row_key(row) in margins or page_num):
                    peripheral_blocks.append(peripheral_record("header" if row["top"] < height * .5 else "footer", row.get("rawText", row["text"]), page_number, [{"page": page_number, "x0": round(row["x0"], 2), "y0": round(row["top"], 2), "x1": round(row["x1"], 2), "y1": round(row["bottom"], 2)}]))
                    continue
                if row["x1"] - row["x0"] < 3:
                    continue
                cleaned.append(row)
            if not cleaned:
                continue
            if page_number == 1:
                cleaned, publication_notes = first_page_publication(cleaned, width, height, body_size)
                peripheral_blocks.extend(publication_notes)
            metadata_bounds = author_region(cleaned, body_size) if page_number == 1 else None
            original_words = [w for row in cleaned for w in row["words"]]
            protected_words, page_math = protect_math(original_words, body_size, page_number, len(math_assets), metadata_bounds, detect_gutter(cleaned, width, height), quality_issues)
            math_assets.extend(page_math)
            if page_math:
                render_math_assets(pdf.pages[page_number - 1], page_math, document_id, asset_dir)
            protected_rows = rows_from_words(protected_words)
            lines, two = ordered_lines(protected_rows, width, height)
            if two:
                two_column.append(page_number)
            page_blocks = paragraphs_from_lines(lines, page_number, body_size)
            if metadata_bounds:
                page_blocks = consolidate_author_metadata(page_blocks, metadata_bounds, pdf.pages[0], document_id, asset_dir)
            for block in page_blocks:
                if block["_size"] < body_size * .92 and block["sourceBoxes"][0]["y0"] > height * .8:
                    block["isFootnote"] = True
                    block["kind"] = "paragraph"
            rules = list(pdf.pages[page_number - 1].lines)
            body_blocks = []
            for block in page_blocks:
                if block["kind"] == "heading":
                    in_references = bool(re.fullmatch(r"(?:\d+\.?\s+|[IVXLCDM]+\.\s+)?references", block["text"], re.I))
                peripheral_kind = classify_peripheral_block(block, height, width, body_size, rules, in_references)
                if peripheral_kind:
                    peripheral_blocks.append(peripheral_record(peripheral_kind, block.get("rawText", block["text"]), page_number, block["sourceBoxes"]))
                else:
                    body_blocks.append(block)
            page_blocks = body_blocks
            paragraphs.extend(page_blocks)
        paragraphs = [p for p in paragraphs if p["text"].strip()]
        if not paragraphs:
            raise ValueError("未能提取有效正文。请查看 PDF 是否有文字层或使用其他电子版文件。")
        current_section = "section-0"
        sections.append({"id": current_section, "title": "论文开头"})
        title_candidates = [p for p in paragraphs[:16] if p["kind"] == "heading" and p["page"] == 1 and p["_size"] > body_size * 1.3 and not COMMON_HEADING.fullmatch(p["text"])]
        title = max(title_candidates, key=lambda p: p["_size"])["text"] if title_candidates else str(pdf.metadata.get("Title") or "").strip()
        if not title or title.lower() in {"untitled", "microsoft word", "document"} or len(title) > 350:
            title = Path(filename).stem
        for paragraph in paragraphs:
            digest = hashlib.sha256(json.dumps({"page": paragraph["page"], "text": paragraph["text"], "sourceBoxes": paragraph["sourceBoxes"]}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
            paragraph["id"] = f"p-{digest}"
            if paragraph["kind"] == "heading" and paragraph not in title_candidates:
                current_section = f"section-{len(sections)}"
                sections.append({"id": current_section, "title": paragraph["text"], "paragraphId": paragraph["id"]})
            paragraph["sectionId"] = current_section
            texts = [paragraph["text"]] if paragraph["kind"] in {"metadata", "equation"} else split_sentences(paragraph["text"])
            paragraph["sentences"] = [{"id": f"{paragraph['id']}-s{j+1}", "text": text} for j, text in enumerate(texts)]
            paragraph["translation"] = None
        for page in pdf.pages:
            if not page.images and not any(p["page"] == page.page_number and p["kind"] == "caption" for p in paragraphs):
                continue
            try:
                assets.extend(extract_assets(page, paragraphs, document_id, asset_dir, peripheral_blocks))
            except Exception as exc:
                warnings.append(f"第 {page.page_number} 页的图像未能提取，请查看原 PDF（{type(exc).__name__}）。")
                quality_issues.append({"code": "ASSET_EXTRACTION_FAILED", "severity": "warning", "page": page.page_number, "message": f"图像提取失败（{type(exc).__name__}），原 PDF 保留，请按原页阅读。", "fallback": "original-page"})
        apply_figure_safety(assets, paragraphs, dimensions, body_size, pdf, document_id, asset_dir, quality_issues)
        # The figure image already retains its embedded labels. Do not repeat
        # those labels as broken body paragraphs or mistaken table-of-contents
        # entries (particularly common for vector attention visualizations).
        def is_graphic_label(paragraph):
            if paragraph["kind"] == "caption" or is_body_prose(paragraph, body_size):
                return False
            for box in paragraph["sourceBoxes"]:
                covered = False
                for asset in assets:
                    if asset.get("cropStatus") == "page-fallback":
                        continue
                    region = asset["sourceBox"]
                    area = max(1, (box["x1"] - box["x0"]) * (box["y1"] - box["y0"]))
                    intersection = max(0, min(box["x1"], region["x1"]) - max(box["x0"], region["x0"])) * max(0, min(box["y1"], region["y1"]) - max(box["y0"], region["y0"]))
                    if region["page"] == box["page"] and intersection / area > .8:
                        covered = True
                        break
                if not covered:
                    return False
            return True
        paragraphs = [p for p in paragraphs if not is_graphic_label(p)]
        paragraphs = join_continuations(paragraphs, dimensions)
        sections = [{"id": "section-0", "title": "论文开头"}]
        current_section = "section-0"
        for paragraph in paragraphs:
            if paragraph["kind"] == "heading" and paragraph not in title_candidates:
                current_section = f"section-{len(sections)}"
                sections.append({"id": current_section, "title": paragraph["text"], "paragraphId": paragraph["id"]})
            paragraph["sectionId"] = current_section
            texts = [paragraph["text"]] if paragraph["kind"] in {"metadata", "equation"} else split_sentences(paragraph["text"])
            paragraph["sentences"] = [{"id": f"{paragraph['id']}-s{j+1}", "text": text} for j, text in enumerate(texts)]
            paragraph["sourceHash"] = hashlib.sha256(json.dumps({"rawText": paragraph["rawText"], "sourceBoxes": paragraph["sourceBoxes"]}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        for paragraph in paragraphs:
            paragraph.pop("_stream", None)
            paragraph.pop("_size", None)
        if blank_pages:
            warnings.append(f"以下页没有足够的可提取文字，可能含扫描图像：{', '.join(map(str, blank_pages))}。请在原 PDF 中查看。")
            quality_issues.extend({"code": "PAGE_TEXT_MISSING", "severity": "warning", "page": page, "message": "本页没有足够的可提取文字，未伪造 OCR 内容，请按原页阅读。", "fallback": "original-page"} for page in blank_pages)
        if two_column:
            warnings.append(f"检测并按双栏阅读顺序处理 {len(two_column)} 页；如发现错序，请切换原 PDF 核对。")
        used_tokens = {token for p in paragraphs for token in re.findall(r"⟦MATH_m\d+⟧", p["text"])}
        math_assets = [asset for asset in math_assets if asset["token"] in used_tokens]
        peripheral_blocks.sort(key=lambda b: (b["page"], b["sourceBoxes"][0]["y0"], b["sourceBoxes"][0]["x0"]))
        combined_peripheral = []
        for block in peripheral_blocks:
            previous = combined_peripheral[-1] if combined_peripheral else None
            if previous and block["page"] == previous["page"] and block["kind"] == previous["kind"] == "footnote" and re.fullmatch(r"[\d†‡*]+", previous["text"]) and block["sourceBoxes"][0]["y0"] - previous["sourceBoxes"][-1]["y1"] < body_size * .7:
                previous["text"] += " " + block["text"]
                previous["sourceBoxes"].extend(block["sourceBoxes"])
            else:
                combined_peripheral.append(block)
        peripheral_blocks = combined_peripheral
        if math_assets:
            warnings.append("检测到的数学表达式保留为原 PDF 区域图像，避免上下标与符号在重排时失真；未识别的特殊数学排版仍可查看原页。")
        document = {"id": document_id, "title": title, "filename": filename, "pageCount": count,
                "sections": sections, "paragraphs": paragraphs, "assets": assets, "mathAssets": math_assets, "peripheralBlocks": peripheral_blocks,
                "pages": [{"page": i + 1, "width": w, "height": h, "url": f"/api/documents/{document_id}/pages/{i+1}.png"} for i, (w, h) in enumerate(dimensions)],
                "warnings": warnings, "parser": {"name": "pdfplumber-layout", "version": VERSION, "twoColumnPages": two_column},
                "progress": None}
        document["quality"] = audit_document(document, asset_dir, quality_issues)
        return document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--id")
    parser.add_argument("--filename")
    parser.add_argument("--asset-dir")
    parser.add_argument("--render-page", type=int)
    args = parser.parse_args()
    try:
        if args.render_page:
            render_page(args.input, args.output, args.render_page)
            print(json.dumps({"ok": True, "page": args.render_page}))
            return
        if not args.id or not args.asset_dir:
            parser.error("解析模式需要 --id 和 --asset-dir")
        result = parse_pdf(args.input, args.id, args.filename or Path(args.input).name, args.asset_dir)
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        temporary.replace(target)
        print(json.dumps({"ok": True, "paragraphs": len(result["paragraphs"]), "pages": result["pageCount"], "assets": len(result["assets"])}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc), "type": type(exc).__name__}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
