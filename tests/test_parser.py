"""Geometry/linguistic regressions; fixtures do not require generating a PDF."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("parse_pdf", Path(__file__).resolve().parents[1] / "scripts" / "parse_pdf.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def word(text, x0, top, width=45, size=10):
    return {"text": text, "x0": x0, "x1": x0 + width, "top": top, "bottom": top + size, "size": size, "fontname": "Times-Roman"}


class ParserTests(unittest.TestCase):
    def test_two_inline_fractions_on_adjacent_lines_keep_their_own_sentence_positions(self):
        italic = "Times-Italic"
        words = [word("resulting in", 20, 102.3, 33), word("windows.", 82, 102.3, 35),
                 dict(word("H", 62, 100, 5.5, 7.57), fontname=italic), dict(word("W", 68.5, 100, 6.3, 7.57), fontname=italic),
                 dict(word("M", 64, 108.5, 6.3, 7.57), fontname=italic), word("2", 71, 107.8, 3, 5.98),
                 word("with shift of", 20, 115.8, 33), word("pixels.", 115, 115.8, 28),
                 dict(word("⌊", 61, 114.5, 4.4), fontname="MTSYN"), dict(word("M", 67.1, 113.5, 6.3, 7.57), fontname=italic), word("2", 68.4, 121.3, 3.8, 7.57), dict(word("⌋", 75.2, 114.5, 4.4), fontname="MTSYN"),
                 dict(word("×", 82, 114.5, 7.8), fontname="MTSYN"), dict(word("⌊", 92.3, 114.5, 4.4), fontname="MTSYN"), dict(word("M", 98.4, 113.5, 6.3, 7.57), fontname=italic), word("2", 99.7, 121.3, 3.8, 7.57), dict(word("⌋", 106.5, 114.5, 4.4), fontname="MTSYN")]
        protected, assets = p.protect_math(words, 10, 5)
        self.assertEqual(len(assets), 2)
        self.assertTrue(all(a["display"] == "inline" for a in assets))
        self.assertIn("H", assets[0]["textHint"])
        self.assertNotIn("⌊", assets[0]["textHint"])
        self.assertNotIn("H", assets[1]["textHint"])
        self.assertIn("⌊", assets[1]["textHint"])
        rows = p.rows_from_words(protected)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["text"], "resulting in ⟦MATH_m001⟧ windows.")
        self.assertEqual(rows[1]["text"], "with shift of ⟦MATH_m002⟧ pixels.")

    def test_body_figure_references_do_not_create_fake_figure_assets(self):
        for text in ("Fig. 4. First, the situation is reversed with residual learning.", "Fig. 6 (middle) shows the behaviors of ResNets.", "Fig. 7 shows that ResNets have generally smaller responses."):
            row = p.line_from_words([word(text, 49, 200, 251, 10)])
            self.assertEqual(p.classify_line(row, 10), "paragraph")
        caption = p.line_from_words([word("Fig. 4. Training and validation curves on ImageNet.", 49, 200, 251, 9)])
        self.assertEqual(p.classify_line(caption, 10), "caption")

    def test_small_uncaptioned_publisher_logo_is_not_a_fullpage_figure(self):
        page = SimpleNamespace(page_number=1, width=440, height=666, images=[{"x0": 386, "x1": 417, "top": 21, "bottom": 52}])
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(p.extract_assets(page, [], "test", Path(tmp)), [])
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_stix_text_family_does_not_replace_ordinary_sentence_with_math(self):
        for font in ("STIXTwoText-Regular", "STIXGeneral-Regular", "ABCDEF+STIXGeneral-Italic"):
            with self.subTest(font=font):
                words = [dict(word(text, 30+i*50, 100, 45), fontname=font) for i, text in enumerate(["The", "method", "restores", "frames."])]
                protected, assets = p.protect_math(words, 10, 1)
                self.assertEqual(assets, [])
                self.assertEqual([w["text"] for w in protected], ["The", "method", "restores", "frames."])
        self.assertTrue(p.math_seed(dict(word("∈", 30, 100), fontname="STIXGeneral-Regular")))
        self.assertTrue(p.math_seed(dict(word("X", 30, 100), fontname="STIXGeneral-Italic")))

    def test_math_candidate_with_clear_prose_is_rejected_without_losing_words(self):
        texts = "When we use the method for the input we obtain the result".split()
        words = [dict(word(text, 30+i*40, 100, 39), fontname="Math-Regular") for i, text in enumerate(texts)]
        issues = []
        protected, assets = p.protect_math(words, 10, 1, quality_issues=issues)
        self.assertEqual(assets, [])
        self.assertEqual([w["text"] for w in protected], texts)
        self.assertEqual(issues[0]["code"], "MATH_PROSE_REJECTED")
        self.assertEqual(issues[0]["fallback"], "original-page")

    def test_short_normal_sentence_is_a_figure_boundary_not_a_disposable_label(self):
        body = {"id": "p-body", "kind": "paragraph", "text": "We evaluate our method on the standard validation dataset.", "_size": 10, "sourceBoxes": [{"page": 1, "x0": 49, "y0": 200, "x1": 300, "y1": 220}]}
        caption = {"text": "Fig. 1. Results.", "sourceBoxes": [{"page": 1, "x0": 49, "y0": 400, "x1": 300, "y1": 410}]}
        page = SimpleNamespace(page_number=1, width=612, height=792, images=[], curves=[{"x0": 110, "x1": 250, "top": 280, "bottom": 380}], rects=[], lines=[])
        box = p.fallback_figure_band(page, {"caption": caption, "scope": (0, 306), "floor": 41}, [body], [], 10)
        self.assertEqual(box, (0, 223, 306, 398))
        unsafe = {"id": "fig", "page": 1, "sourceBox": {"page": 1, "x0": 0, "y0": 41, "x1": 306, "y1": 398}, "cropStatus": "layout-band"}
        conflicts = p.figure_safety_conflicts([unsafe], [body], [(612, 792)], 10)
        self.assertEqual(conflicts[0][1]["id"], "p-body")
        self.assertEqual(conflicts[0][2], "FIGURE_BODY_PRESERVED")

    def test_unsafe_figure_degrades_to_original_page_and_keeps_source_text(self):
        from PIL import Image
        body = {"id": "p-body", "kind": "paragraph", "text": "We evaluate our method on the standard validation dataset.", "rawText": "original unchanged", "_size": 10, "sourceBoxes": [{"page": 1, "x0": 49, "y0": 200, "x1": 300, "y1": 220}]}
        asset = {"id": "fig", "page": 1, "sourceBox": {"page": 1, "x0": 0, "y0": 41, "x1": 306, "y1": 398}, "cropStatus": "layout-band", "afterParagraphId": "caption"}
        page = SimpleNamespace(to_image=lambda **kwargs: SimpleNamespace(original=Image.new("RGB", (612, 792), "white")))
        issues = []
        with tempfile.TemporaryDirectory() as tmp:
            p.apply_figure_safety([asset], [body], [(612, 792)], 10, SimpleNamespace(pages=[page]), "test", Path(tmp), issues)
            self.assertEqual(asset["cropStatus"], "page-fallback")
            self.assertEqual(asset["sourceBox"], {"page": 1, "x0": 0, "y0": 0, "x1": 612, "y1": 792})
            self.assertEqual(asset["afterParagraphId"], "caption")
            self.assertEqual(asset["rejectedSourceBox"]["y0"], 41)
            self.assertTrue(list(Path(tmp).glob("figure-*-page-fallback-p1.jpg")))
        self.assertEqual(body["rawText"], "original unchanged")
        self.assertEqual(body["text"], "We evaluate our method on the standard validation dataset.")
        self.assertEqual(issues[0]["paragraphId"], "p-body")

    def test_nested_form_inherits_outer_explicit_clip_until_graphics_restore(self):
        class Stream(dict):
            def __init__(self, values=None, operations=()):
                super().__init__(values or {})
                self.operations = operations
            def get_object(self):
                return self
        for clip_operator in (b"W", b"W*"):
            with self.subTest(clip_operator=clip_operator):
                child = Stream({"/Subtype": "/Form", "/BBox": [0, 0, 100, 100]})
                outer = Stream({"/Subtype": "/Form", "/BBox": [0, 0, 612, 792], "/Resources": {"/XObject": {"/Child": child}}}, [([], b"q"), ([], b"Q"), (["/Child"], b"Do")])
                safe = Stream({"/Subtype": "/Form", "/BBox": [200, 0, 300, 100]})
                source = Stream({"/Resources": {"/XObject": {"/Outer": outer, "/Safe": safe}}}, [([], b"q"), ([], clip_operator), ([], b"n"), (["/Outer"], b"Do"), ([], b"Q"), (["/Safe"], b"Do")])
                source.rotation = 0
                source.cropbox = [0, 0, 612, 792]
                source.get_contents = lambda: source
                page = SimpleNamespace(page_number=1, width=612, height=792, pdf=SimpleNamespace(_figure_reader=SimpleNamespace(pages=[source])))
                self.assertEqual(p.figure_form_regions(page), [{"box": (200, 692, 300, 792), "depth": 0}])

    def test_form_dependency_failure_returns_layout_fallback_evidence(self):
        with patch.dict("sys.modules", {"pypdf": None}):
            self.assertEqual(p.figure_form_regions(SimpleNamespace()), [])

    def test_pdf_form_box_obeys_nested_scale_translation_and_rotation(self):
        matrix = p.compose_pdf_matrix((2, 0, 0, 3, 5, 7), (1, 0, 0, 1, 100, 200))
        self.assertEqual(p.transformed_form_box((0, 0, 10, 20), matrix, 792), (105, 525, 125, 585))
        self.assertEqual(p.transformed_form_box((0, 0, 10, 20), (0, 1, -1, 0, 100, 200), 792), (80, 582, 100, 592))

    def test_short_centered_caption_matches_fullwidth_form_not_table_above(self):
        caption = {"id": "fig9", "text": "Fig. 9. Comparison.", "sourceBoxes": [{"page": 9, "x0": 210, "y0": 479.53, "x1": 402, "y1": 487.56}]}
        forms = [{"box": (90, 185, 530, 220), "depth": 0}, {"box": (58.346, 228.612, 553.646, 471.891), "depth": 0}]
        plan = p.match_figure_forms(forms, [caption], 612, 792, 306, 41)[0]
        self.assertEqual(plan["box"], forms[1]["box"])
        self.assertEqual(plan["cropStatus"], "form-boundary")
        self.assertEqual(plan["scope"], (0, 612))

    def test_two_figures_share_page_without_overlapping_or_absorbing_other_column(self):
        captions = [
            {"id": "fig5", "text": "Fig. 5. Comparison.", "sourceBoxes": [{"page": 7, "x0": 191, "y0": 304.48, "x1": 420, "y1": 313.46}]},
            {"id": "fig6", "text": "Fig. 6. Attention maps.", "sourceBoxes": [{"page": 7, "x0": 312, "y0": 443.5, "x1": 563, "y1": 478.37}]},
        ]
        forms = [{"box": (58.337, 54.067, 553.655, 297.788), "depth": 0}, {"box": (319.828, 325.814, 555.177, 438.794), "depth": 0}, {"box": (49, 325, 300, 435), "depth": 0}]
        plans = p.match_figure_forms(forms, captions, 612, 792, 306, 41)
        self.assertEqual([r["box"] for r in plans], [forms[0]["box"], forms[1]["box"]])
        self.assertEqual(p.overlap_ratio(plans[0]["box"], plans[1]["box"]), 0)
        self.assertEqual([r["caption"]["id"] for r in plans], ["fig5", "fig6"])

    def test_figure_form_preserves_labels_outside_individual_drawing_extents(self):
        caption = {"text": "Fig. 4. Warping.", "sourceBoxes": [{"page": 5, "x0": 49, "y0": 195.02, "x1": 300, "y1": 250.85}]}
        form = {"box": (90.918, 54.067, 258.06, 192.034), "depth": 0}
        plan = p.match_figure_forms([form], [caption], 612, 792, 306, 41)[0]
        self.assertEqual(plan["box"], form["box"])
        self.assertLess(plan["box"][0], 100)  # X-labels, well left of the 130pt drawing.
        self.assertGreater(plan["box"][2], 255)  # Frame axis is not reduced to shape bounds.

    def test_fallback_band_stops_at_table_and_ignores_adjacent_column_prose(self):
        caption = {"text": "Fig. 7. PSNR.", "sourceBoxes": [{"page": 8, "x0": 49, "y0": 445, "x1": 300, "y1": 462}]}
        plan = {"caption": caption, "scope": (0, 306), "floor": 41}
        other_column = {"kind": "paragraph", "text": "Body prose " * 30, "_size": 10, "sourceBoxes": [{"page": 8, "x0": 312, "y0": 261, "x1": 563, "y1": 438}]}
        page = SimpleNamespace(page_number=8, width=612, height=792, images=[], curves=[{"x0": 110, "x1": 250, "top": 207, "bottom": 410}], rects=[], lines=[])
        box = p.fallback_figure_band(page, plan, [other_column], [(58, 165, 290, 190)], 10)
        self.assertEqual(box, (0, 193, 306, 443))

    def test_clipped_native_image_fragments_return_one_explicit_page_fallback(self):
        from PIL import Image
        caption = {"id": "fig9", "page": 9, "kind": "caption", "text": "Fig. 9. Comparison.", "sourceBoxes": [{"page": 9, "x0": 210, "y0": 479, "x1": 402, "y1": 488}]}
        images = [{"x0": -800, "x1": 900, "top": -100, "bottom": 610}, {"x0": -200, "x1": 730, "top": 150, "bottom": 607}]
        page = SimpleNamespace(page_number=9, width=612, height=792, images=images, curves=[], rects=[], lines=[], pdf=SimpleNamespace(), extract_words=lambda **kwargs: [], find_tables=lambda: [], to_image=lambda **kwargs: SimpleNamespace(original=Image.new("RGB", (612, 792), "white")))
        with tempfile.TemporaryDirectory() as tmp:
            assets = p.extract_assets(page, [caption], "test", Path(tmp))
            self.assertEqual(len(assets), 1)
            self.assertEqual(assets[0]["cropStatus"], "page-fallback")
            self.assertEqual(assets[0]["afterParagraphId"], "fig9")
            self.assertEqual(assets[0]["caption"], caption["text"])
            self.assertEqual(assets[0]["sourceBox"], {"page": 9, "x0": 0, "y0": 0, "x1": 612, "y1": 792})
            self.assertEqual(len(list(Path(tmp).glob("figure-*.jpg"))), 1)

    def test_narrow_journal_gutter_keeps_columns_and_smallcaps_heading(self):
        words = []
        for i in range(16):
            words.extend([word("Left column paragraph content", 49, 150 + i * 12, 251), word("Right column paragraph content", 311.9, 150 + i * 12, 251)])
        words.extend([word("I.", 135, 400, 7), word("I", 147, 400, 3.3), word("NTRODUCTION", 150.8, 401.6, 62, 8), word("Right column continues", 311.9, 397, 251)])
        lines, two = p.ordered_lines(p.rows_from_words(words), 612, 792)
        self.assertTrue(two)
        self.assertTrue(all("Right column" not in row["text"] for row in lines if row["stream"].startswith("left")))
        heading = next(row for row in lines if row["text"].startswith("I."))
        self.assertEqual(heading["text"], "I. INTRODUCTION")
        self.assertEqual(p.classify_line(heading, 10), "heading")

    def test_local_double_columns_below_fullwidth_figure_captions(self):
        words = []
        for i in range(28):
            words.extend([word("Full width caption describes the figure", 49, 160 + i * 9, 240, 8), word("across the entire page with source details", 291, 160 + i * 9, 272, 8)])
        for i in range(12):
            words.extend([word("Left column actual prose content", 49, 520 + i * 12, 251), word("Right column actual prose content", 311.9, 520 + i * 12, 251)])
        lines, two = p.ordered_lines(p.rows_from_words(words), 612, 792)
        self.assertTrue(two)
        body = [r for r in lines if r["top"] >= 520]
        self.assertEqual(len(body), 24)
        self.assertTrue(all(r["text"].startswith("Left") for r in body[:12]))

    def test_fullwidth_caption_retains_short_final_line(self):
        words = []
        for i in range(12):
            words.extend([word("Left column actual prose content", 49, 520 + i * 12, 251), word("Right column actual prose content", 311.9, 520 + i * 12, 251)])
        words.extend([word("Fig. 3. Full width caption", 49, 450, 260, 8), word("continues across the page", 312, 450, 251, 8), word("information fusion among different frames.", 49, 459, 155, 8)])
        lines, _ = p.ordered_lines(p.rows_from_words(words), 612, 792)
        blocks = p.paragraphs_from_lines(lines, 4, 10)
        caption = next(b for b in blocks if b["kind"] == "caption")
        self.assertTrue(caption["text"].endswith("information fusion among different frames."))

    def test_small_caption_prose_is_not_absorbed_into_multiline_math(self):
        words = []
        for top in [100, 109, 118]:
            words.extend([word("When", 30, top, 20, 8), word("and", 55, top, 14, 8), word("use", 74, top, 13, 8), dict(word("A", 100, top, 5, 8), fontname="CMMI8"), word("=", 107, top, 5, 8), word("1", 114, top, 4, 8), word("for", 123, top, 12, 8), word("attention", 140, top, 35, 8)])
        protected, assets = p.protect_math(words, 10, 4)
        self.assertEqual(len(assets), 3)
        self.assertTrue(all(a["display"] == "inline" for a in assets))
        self.assertTrue(all(a["sourceFontSize"] == 8 for a in assets))
        self.assertTrue(all(a["sourceBox"]["y1"] - a["sourceBox"]["y0"] < 12 for a in assets))
        self.assertEqual(sum(w["text"] in {"When", "and", "use", "for"} for w in protected), 12)
        self.assertTrue(all(w["size"] == 8 for w in protected if w["text"].startswith("⟦MATH_")))

    def test_tiny_smallcaps_table_caption_is_ordinary_prose(self):
        words = [word("THE", 30, 100, 15, 6.38), word("MODEL", 50, 100, 24, 6.38), word("FOR", 80, 100, 15, 6.38), dict(word("×", 100, 100, 5, 7.97), fontname="MTSYN"), word("2", 107, 100, 4, 6.38), word("TIME", 116, 100, 20, 6.38)]
        protected, assets = p.protect_math(words, 10, 10)
        self.assertTrue(assets)
        self.assertTrue(all(not any(t in a["textHint"].split() for t in ["THE", "MODEL", "FOR", "TIME"]) for a in assets))
        self.assertTrue(any(w["text"] == "THE" for w in protected))

    def test_aligned_times_font_equations_keep_all_rows_and_number(self):
        words = []
        for i in range(5):
            top = 100 + i * 15
            words.extend([dict(word("X", 50, top, 6), fontname="Times-Italic"), dict(word("=", 60, top, 8), fontname="MTSYN"), word("MLP", 72, top, 20), word("(", 93, top, 4), dict(word("Z" if i == 4 else "Y", 99, top, 6), fontname="Times-Italic"), word(")", 108, top, 4)])
        words.append(word("(6)", 270, 160, 13))
        protected, assets = p.protect_math(words, 10, 4)
        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]["display"], "block")
        self.assertIn("Z", assets[0]["textHint"])
        self.assertEqual(assets[0]["sourceBox"]["y1"], 170)
        self.assertEqual(len(protected), 1)
        self.assertTrue(protected[0]["text"].endswith(" (6)"))

    def test_display_equation_does_not_take_inline_variables_from_prose_above(self):
        words = [word("Next", 20, 100, 20), word("we", 45, 100, 12), word("warp", 61, 100, 21), dict(word("X", 90, 100, 6), fontname="Times-Italic"), word("again", 101, 100, 25)]
        words.extend([dict(word("Y", 70, 115, 6), fontname="Times-Italic"), dict(word("=", 80, 115, 8), fontname="MTSYN"), word("MLP", 92, 115, 20), word("(", 113, 115, 4), dict(word("Z", 119, 115, 6), fontname="Times-Italic"), word(")", 128, 115, 4)])
        protected, assets = p.protect_math(words, 10, 5)
        self.assertEqual({a["display"] for a in assets}, {"inline", "block"})
        block = next(a for a in assets if a["display"] == "block")
        self.assertGreaterEqual(block["sourceBox"]["y0"], 115)
        self.assertTrue(any(w["text"].startswith("⟦MATH_") and not w["_equation"] for w in protected))

    def test_drop_initial_attaches_to_the_first_line_and_keeps_source_extent(self):
        words = [word("V", 49, 432, 21, 29), word("IDEO", 71, 434, 24), word("restoration", 100, 434, 60), word("frames", 71, 446, 30)]
        rows = p.rows_from_words(words)
        self.assertEqual(rows[0]["text"], "VIDEO restoration")
        self.assertEqual(rows[0]["sourceBottom"], 461)
        self.assertEqual(rows[1]["text"], "frames")

    def test_reference_section_keeps_springer_citation_continuations(self):
        block = {"kind": "paragraph", "text": "consistent transformer for video denoising, in Proc. Eur. Conf. Comput. Vis. Cham, Switzerland: Springer, 2022, pp. 481–496.", "_size": 8, "sourceBoxes": [{"page": 11, "x0": 49, "y0": 650, "x1": 300, "y1": 675}]}
        self.assertIsNone(p.classify_peripheral_block(block, 792, 612, 10, [], in_references=True))

    def test_ieee_manuscript_region_is_separate_without_a_rule(self):
        words = []
        for i in range(12):
            words.extend([word("Left column actual prose content", 49, 150 + i * 12, 251), word("Right column actual prose content", 311.9, 150 + i * 12, 251)])
        words.extend([word("Manuscript received 19 October 2022", 49, 467, 251, 8), word("Authors are with the university", 49, 476, 251, 8), word("Digital Object Identifier 10.1109/example", 49, 485, 251, 8), word("Right column body continues", 311.9, 467, 251)])
        kept, notes = p.first_page_publication(p.rows_from_words(words), 612, 792, 10)
        self.assertEqual(len(notes), 1)
        self.assertIn("Authors are with", notes[0]["text"])
        self.assertFalse(any("Manuscript received" in r["text"] for r in kept))
        self.assertTrue(any("Right column body continues" in r["text"] for r in kept))

    def test_supplementary_mention_in_body_is_not_a_publisher_notice(self):
        block = {"kind": "paragraph", "text": "Supplementary Information provides the details of our model.", "rawText": "Supplementary Information provides the details of our model.", "_size": 10, "sourceBoxes": [{"page": 1, "x0": 50, "y0": 300, "x1": 390, "y1": 325}]}
        self.assertIsNone(p.classify_peripheral_block(block, 666, 440, 10, []))
        block["sourceBoxes"][0].update(y0=570, y1=595)
        self.assertIsNone(p.classify_peripheral_block(block, 666, 440, 10, []))

    def test_lower_small_publisher_notice_is_preserved_separately(self):
        block = {"kind": "paragraph", "text": "Supplementary Information The online version contains supplementary material available at https://doi.org/10.1234/example.", "_size": 9, "sourceBoxes": [{"page": 1, "x0": 50, "y0": 579, "x1": 390, "y1": 599}]}
        self.assertEqual(p.classify_peripheral_block(block, 666, 440, 10, []), "publication")
        record = p.peripheral_record("publication", block["text"], 1, block["sourceBoxes"])
        self.assertIn("doi.org/10.1234", record["text"])
        self.assertEqual(record["page"], 1)

    def test_separator_plus_lower_small_type_identifies_academic_footnote(self):
        block = {"kind": "paragraph", "text": "Y. Jiang—This work was performed while Yifan Jiang worked at Google.", "_size": 9, "sourceBoxes": [{"page": 1, "x0": 53.58, "y0": 547, "x1": 350, "y1": 556}]}
        rules = [{"x0": 53.58, "x1": 110.28, "top": 543.62, "bottom": 543.62}]
        self.assertEqual(p.classify_peripheral_block(block, 666, 440, 10, rules), "footnote")
        block["_size"] = 10
        self.assertIsNone(p.classify_peripheral_block(block, 666, 440, 10, rules))

    def test_small_type_reference_continuation_is_not_a_footnote(self):
        block = {"kind": "paragraph", "text": "residual learning of deep CNN for image denoising. IEEE Trans. Image Process. 26, 3142–3155 (2017)", "_size": 9, "isFootnote": True, "sourceBoxes": [{"page": 17, "x0": 53.58, "y0": 560.67, "x1": 399.32, "y1": 602.51}]}
        self.assertIsNone(p.classify_peripheral_block(block, 666, 440, 10, []))

    def test_font_changes_inside_a_word_do_not_insert_spaces(self):
        words = [word("Malle", 50, 100, 20), word("able", 70, 100, 16), word("Convolution", 90, 100, 45)]
        self.assertEqual(p.line_from_words(words)["text"], "Malleable Convolution")

    def test_math_tokens_are_not_split_or_mutated_by_sentence_segmentation(self):
        self.assertEqual(p.split_sentences("We use ⟦MATH_m001⟧. ⟦MATH_m002⟧ is the output."), ["We use ⟦MATH_m001⟧.", "⟦MATH_m002⟧ is the output."])

    def test_author_region_covers_names_affiliations_and_superscripts(self):
        rows = [p.line_from_words([word("Paper title", 50, 40, 200, 18)]), p.line_from_words([word("Author", 50, 100, 200)]), p.line_from_words([word("University", 50, 130, 200)]), p.line_from_words([word("Abstract. A method", 50, 160, 200)])]
        bounds = p.author_region(rows, 10)
        self.assertTrue(bounds[0] < 100 < 130 < bounds[1])

    def test_inline_math_on_adjacent_prose_lines_stays_separate(self):
        words = [word("weights", 20, 100, 32), dict(word("W", 60, 100, 8), fontname="CMMI10"), dict(word("R", 74, 100, 8), fontname="MSBM10"), dict(word("K", 86, 97, 5, 7), fontname="CMMI7"), word("2", 91, 95, 3, 5), word("tensor", 20, 112, 32), dict(word("X", 60, 112, 8), fontname="CMMI10"), dict(word("R", 74, 112, 8), fontname="MSBM10"), dict(word("C", 86, 109, 5, 7), fontname="CMMI7")]
        protected, assets = p.protect_math(words, 10, 1)
        self.assertEqual(len(assets), 2)
        self.assertEqual({a["display"] for a in assets}, {"inline"})
        self.assertFalse(any(w["text"] == "2" for w in protected))
        self.assertLess(assets[0]["sourceBox"]["y1"], assets[1]["sourceBox"]["y0"] + 5)

    def test_abbreviations_and_decimals_do_not_split_sentences(self):
        text = "As shown in Fig. 2, the score is 1.25, e.g. on images. We follow Smith et al. in this setting. This is the last sentence."
        self.assertEqual(p.split_sentences(text), ["As shown in Fig. 2, the score is 1.25, e.g. on images.", "We follow Smith et al. in this setting.", "This is the last sentence."])

    def test_dehyphenation_preserves_known_compounds(self):
        self.assertEqual(p.join_lines(["Our repre-", "sentation is image-", "based."]), "Our representation is image-based.")
        self.assertEqual(p.join_lines(["English-", "to-German and sequence-", "aligned models"]), "English-to-German and sequence-aligned models")
        self.assertEqual(p.join_lines(["in-", "stead, we obtain re-", "sults"]), "instead, we obtain results")
        self.assertEqual(p.join_lines(["In-", "stead of the old approach"]), "Instead of the old approach")

    def test_sentence_final_quotation_marks_stay_with_the_sentence(self):
        self.assertEqual(p.split_sentences('We call this "alignment." This works.'), ['We call this "alignment."', 'This works.'])

    def test_superscript_footnote_marker_stays_with_its_line(self):
        words = [word("Author", 50, 100, 40), word("*", 91, 98.7, 3, size=7)]
        rows = p.rows_from_words(words)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["text"], "Author *")

    def test_large_license_sentence_is_not_a_section_heading(self):
        row = p.line_from_words([word("Provided proper attribution is provided.", 50, 50, 200, size=12)])
        self.assertEqual(p.classify_line(row, 10), "paragraph")

    def test_reference_authors_and_small_footnotes_are_not_headings(self):
        reference = p.line_from_words([word("R. R. Salakhutdinov. Improving neural networks", 50, 100, 210, size=10)])
        footnote = p.line_from_words([word("3 We have experimented with more training iterations", 50, 700, 210, size=8)])
        self.assertEqual(p.classify_line(reference, 10), "paragraph")
        self.assertEqual(p.classify_line(footnote, 10), "paragraph")

    def test_reference_citation_at_wrapped_line_does_not_make_new_paragraph(self):
        rows = p.rows_from_words([word("We present experiments on ImageNet", 60, 100, 200), word("[36] to evaluate our method.", 50, 112, 190)])
        lines = [dict(row, stream="single", columnRight=270) for row in rows]
        blocks = p.paragraphs_from_lines(lines, 1, 10)
        self.assertEqual(len(blocks), 1)
        self.assertIn("ImageNet [36]", blocks[0]["text"])

    def test_two_columns_read_entire_left_before_right(self):
        words = []
        for i in range(16):
            top = 150 + 14 * i
            words.extend([word("Left", 50, top), word("paragraphcontent", 104, top, 140), word("Right", 330, top), word("paragraphcontent", 382, top, 145)])
        rows = p.rows_from_words(words)
        lines, two = p.ordered_lines(rows, 600, 800)
        self.assertTrue(two)
        self.assertEqual(len(lines), 32)
        self.assertTrue(all(line["text"].startswith("Left") for line in lines[:16]))
        self.assertTrue(all(line["text"].startswith("Right") for line in lines[16:]))

    def test_single_column_with_normal_word_gaps_is_not_split(self):
        words = []
        for i in range(15):
            for j in range(11):
                words.append(word("content", 45 + j * 46 + i % 3 * 2, 150 + i * 14, 42))
        _, two = p.ordered_lines(p.rows_from_words(words), 600, 800)
        self.assertFalse(two)

    def test_wide_diagram_whitespace_does_not_absorb_right_column_into_caption(self):
        words = []
        for i in range(16):
            words.extend([word("Diagram", 50, 150 + i * 14, 180), word("Right paragraph prose", 309, 150 + i * 14, 235)])
        words.extend([word("Figure 3. Left column caption", 50, 500, 237), word("Right paragraph continues", 309, 500, 235)])
        lines, two = p.ordered_lines(p.rows_from_words(words), 595, 792)
        self.assertTrue(two)
        caption = next(row for row in lines if row["text"].startswith("Figure 3"))
        self.assertNotIn("Right paragraph", caption["text"])

    def test_cross_page_merge_retains_both_source_boxes(self):
        blocks = [
            {"page": 1, "kind": "paragraph", "text": "We demonstrate the", "rawText": "We demonstrate the", "sourceBoxes": [{"page": 1, "x0": 50, "x1": 280, "y0": 680, "y1": 740}], "_stream": "right-0", "_size": 10},
            {"page": 2, "kind": "paragraph", "text": "effect on a new dataset.", "rawText": "effect on a new dataset.", "sourceBoxes": [{"page": 2, "x0": 50, "x1": 280, "y0": 50, "y1": 100}], "_stream": "left-0", "_size": 10},
        ]
        result = p.join_continuations(blocks, [(600, 800), (600, 800)])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["text"], "We demonstrate the effect on a new dataset.")
        self.assertEqual(len(result[0]["sourceBoxes"]), 2)

    def test_same_band_column_continuation_survives_large_first_page_footnote(self):
        blocks = [
            {"page": 1, "kind": "paragraph", "text": "VIDEO restoration has", "rawText": "VIDEO restoration has", "sourceBoxes": [{"page": 1, "x0": 49, "x1": 300, "y0": 434, "y1": 461}], "_stream": "left-1", "_size": 10},
            {"page": 1, "kind": "caption", "text": "Fig. 1. The comparison.", "rawText": "Fig. 1. The comparison.", "sourceBoxes": [{"page": 1, "x0": 312, "x1": 563, "y0": 235, "y1": 288}], "_stream": "right-1", "_size": 8},
            {"page": 1, "kind": "paragraph", "text": "attracted much attention.", "rawText": "attracted much attention.", "sourceBoxes": [{"page": 1, "x0": 312, "x1": 563, "y0": 298, "y1": 356}], "_stream": "right-1", "_size": 10},
        ]
        result = p.join_continuations(blocks, [(612, 792)])
        self.assertEqual(result[0]["text"], "VIDEO restoration has attracted much attention.")
        self.assertEqual(len(result[0]["sourceBoxes"]), 2)

    def test_margin_repeat_preserves_unique_first_page_author_info(self):
        header = p.line_from_words([word("Journal header 2024", 50, 20, 200)])
        author = p.line_from_words([word("Unique author", 50, 45, 200)])
        result = p.repeated_margins([([header, author], 600, 800), ([header], 600, 800), ([header], 600, 800)])
        self.assertIn("journal header #", result)
        self.assertNotIn("unique author", result)

    def test_floating_caption_does_not_interrupt_cross_page_prose(self):
        blocks = [
            {"page": 1, "kind": "paragraph", "text": "The output is a weighted sum", "rawText": "The output is a weighted sum", "sourceBoxes": [{"page": 1, "x0": 50, "x1": 280, "y0": 680, "y1": 740}], "_stream": "single", "_size": 10},
            {"page": 2, "kind": "caption", "text": "Figure 1: An example.", "rawText": "Figure 1: An example.", "sourceBoxes": [{"page": 2, "x0": 50, "x1": 280, "y0": 270, "y1": 290}], "_stream": "single", "_size": 10},
            {"page": 2, "kind": "paragraph", "text": "of the values.", "rawText": "of the values.", "sourceBoxes": [{"page": 2, "x0": 50, "x1": 280, "y0": 310, "y1": 340}], "_stream": "single", "_size": 10},
        ]
        result = p.join_continuations(blocks, [(600, 800), (600, 800)])
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["text"], "The output is a weighted sum of the values.")
        self.assertEqual(result[1]["kind"], "caption")


if __name__ == "__main__":
    unittest.main()
