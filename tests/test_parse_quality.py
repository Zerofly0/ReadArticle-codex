"""Pure fixtures and scratch files; no user paper, network or PDF generation."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts.parse_quality import audit_document, math_prose_suspicion, run_batch


def document():
    return {"id": "test", "pageCount": 1, "pages": [{"page": 1, "width": 612, "height": 792, "url": "/api/documents/test/pages/1.png"}],
            "parser": {"version": "test", "twoColumnPages": []}, "paragraphs": [{"id": "p1", "page": 1, "kind": "paragraph", "text": "An ordinary paragraph.", "rawText": "An ordinary paragraph.", "sentences": [{"id": "p1-s1", "text": "An ordinary paragraph."}], "sourceBoxes": [{"page": 1, "x0": 49, "y0": 100, "x1": 300, "y1": 120}]}], "mathAssets": [], "assets": []}


def add_math(doc):
    doc["paragraphs"][0]["text"] = doc["paragraphs"][0]["sentences"][0]["text"] = "The value is ⟦MATH_m001⟧."
    asset = {"id": "m001", "token": "⟦MATH_m001⟧", "page": 1, "display": "inline", "sourceFontSize": 10, "textHint": "X = Y", "url": "/api/documents/test/assets/r7d3-math-m001.png", "sourceBox": {"page": 1, "x0": 100, "y0": 100, "x1": 145, "y1": 110}}
    doc["mathAssets"].append(asset)
    return asset


class QualityTests(unittest.TestCase):
    def test_clean_document_audit_is_read_only_and_has_stable_contract(self):
        doc = document()
        before = copy.deepcopy(doc)
        quality = audit_document(doc)
        self.assertEqual(doc, before)
        self.assertEqual(quality["version"], "parse-quality-v1")
        self.assertEqual(quality["summary"]["status"], "ok")
        self.assertEqual(quality["summary"]["issueCount"], 0)
        self.assertEqual(quality["issues"], [])

    def test_missing_duplicate_math_and_sentence_token_order_are_hard_errors(self):
        doc = document()
        add_math(doc)
        doc["paragraphs"][0]["text"] += " Then ⟦MATH_m002⟧."
        doc["paragraphs"][0]["sentences"][0]["text"] = "Then ⟦MATH_m002⟧ followed by ⟦MATH_m001⟧."
        doc["mathAssets"].append(copy.deepcopy(doc["mathAssets"][0]))
        quality = audit_document(doc)
        codes = {i["code"] for i in quality["issues"]}
        self.assertTrue({"MATH_SENTENCE_TOKEN_MISMATCH", "MATH_TOKEN_MISSING_ASSET", "MATH_TOKEN_DUPLICATE_ASSET"} <= codes)
        issue = next(i for i in quality["issues"] if i["code"] == "MATH_TOKEN_MISSING_ASSET")
        self.assertEqual((issue["page"], issue["paragraphId"], issue["severity"]), (1, "p1", "error"))
        self.assertEqual(issue["sourceUrl"], "/api/documents/test/pages/1.png")
        self.assertEqual(quality["summary"]["degradedPages"], [1])

    def test_asset_filename_uses_url_revision_and_missing_file_is_detected(self):
        doc = document()
        asset = add_math(doc)
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "r7d3-math-m001.png"
            target.write_bytes(b"fixture image bytes")
            self.assertEqual(audit_document(doc, tmp)["summary"]["errorCount"], 0)
            target.unlink()
            quality = audit_document(doc, tmp)
            issue = next(i for i in quality["issues"] if i["code"] == "ASSET_FILE_MISSING")
            self.assertEqual(issue["assetId"], asset["id"])
        self.assertEqual(asset["url"], "/api/documents/test/assets/r7d3-math-m001.png")

    def test_nonfinite_or_out_of_bounds_geometry_is_reported(self):
        doc = document()
        asset = add_math(doc)
        asset["sourceBox"]["x0"] = float("nan")
        doc["paragraphs"][0]["sourceBoxes"][0]["x1"] = 700
        quality = audit_document(doc)
        self.assertEqual(quality["summary"]["byCode"]["SOURCE_BOX_INVALID"], 2)
        json.dumps(quality, allow_nan=False)

    def test_figure_anchor_overlap_and_missing_caption_are_explicit(self):
        doc = document()
        caption = {"id": "cap", "page": 1, "kind": "caption", "text": "Fig. 1. A diagram.", "sentences": [], "sourceBoxes": [{"page": 1, "x0": 49, "y0": 300, "x1": 300, "y1": 320}]}
        doc["paragraphs"].append(caption)
        doc["assets"] = [{"id": "f1", "page": 1, "afterParagraphId": "cap", "sourceBox": {"page": 1, "x0": 49, "y0": 140, "x1": 300, "y1": 290}}, {"id": "f2", "page": 1, "afterParagraphId": "missing", "sourceBox": {"page": 1, "x0": 100, "y0": 200, "x1": 310, "y1": 280}}]
        codes = {i["code"] for i in audit_document(doc)["issues"]}
        self.assertTrue({"FIGURE_ANCHOR_MISSING", "FIGURE_WITHOUT_CAPTION", "FIGURE_OVERLAP"} <= codes)
        self.assertNotIn("FIGURE_CAPTION_UNLINKED", codes)

    def test_page_fallback_is_marked_but_not_reported_as_interfigure_overlap(self):
        doc = document()
        doc["assets"] = [{"id": "page", "page": 1, "cropStatus": "page-fallback", "sourceBox": {"page": 1, "x0": 0, "y0": 0, "x1": 612, "y1": 792}}]
        quality = audit_document(doc)
        self.assertEqual(quality["summary"]["status"], "degraded")
        self.assertIn("FIGURE_PAGE_FALLBACK", quality["summary"]["byCode"])
        self.assertNotIn("FIGURE_BODY_OVERLAP", quality["summary"]["byCode"])

    def test_math_prose_guard_does_not_reject_a_long_function_expression(self):
        self.assertTrue(math_prose_suspicion("When we use the weights for our input and obtain the output"))
        self.assertFalse(math_prose_suspicion("MLP Concat X Y MRA MSA LN MLP Split X Y Z LN MRA"))
        doc = document()
        asset = add_math(doc)
        asset["textHint"] = "When we use the weights for our input and obtain the output"
        quality = audit_document(doc)
        self.assertIn("MATH_PROSE_CAPTURE", quality["summary"]["byCode"])
        self.assertEqual(quality["summary"]["errorCount"], 0)
        self.assertEqual(next(i for i in quality["issues"] if i["code"] == "MATH_PROSE_CAPTURE")["severity"], "warning")

    def test_valid_two_column_continuation_is_not_a_cross_column_box(self):
        doc = document()
        doc["parser"]["twoColumnPages"] = [1]
        p = doc["paragraphs"][0]
        p["text"] = p["sentences"][0]["text"] = "A body sentence with ordinary words. " * 15
        p["sourceBoxes"].append({"page": 1, "x0": 312, "y0": 100, "x1": 563, "y1": 140})
        self.assertNotIn("COLUMN_SPAN_REVIEW", audit_document(doc)["summary"]["byCode"])
        p["sourceBoxes"] = [{"page": 1, "x0": 49, "y0": 100, "x1": 563, "y1": 140}]
        self.assertIn("COLUMN_SPAN_REVIEW", audit_document(doc)["summary"]["byCode"])

    def test_reaudit_recomputes_structural_errors_but_keeps_safety_event(self):
        doc = document()
        initial = [{"code": "ASSET_FILE_MISSING", "severity": "error", "page": 1, "message": "obsolete"}, {"code": "MATH_PROSE_REJECTED", "severity": "warning", "page": 1, "message": "preserved", "fallback": "original-page"}]
        quality = audit_document(doc, initial_issues=initial)
        self.assertEqual([i["code"] for i in quality["issues"]], ["MATH_PROSE_REJECTED"])

    def test_document_cli_accepts_snapshot_stdin_without_writes(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "parse_quality.py"
        result = subprocess.run([sys.executable, "-X", "utf8", str(script), "--document", "-"], input=json.dumps(document()), text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout)["summary"]["status"], "ok")
        self.assertEqual(result.stderr, "")

    def test_batch_cli_requires_explicit_samples_without_reading_a_private_library(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "parse_quality.py"
        for args in (["--batch"], ["--batch", "--sample", "Missing="], ["--batch", "--sample", "=missing.pdf"]):
            with self.subTest(args=args), tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / "audit"
                result = subprocess.run([sys.executable, "-X", "utf8", str(script), *args, "--output-dir", str(output)], text=True, capture_output=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn("--sample", result.stderr)
                self.assertFalse(output.exists())

    def test_document_path_cli_does_not_rewrite_document_or_assets(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "parse_quality.py"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "document.json"
            path.write_text(json.dumps(document()), encoding="utf-8")
            before = path.read_bytes(), path.stat().st_mtime_ns
            result = subprocess.run([sys.executable, "-X", "utf8", str(script), "--document", str(path)], text=True, capture_output=True, check=True)
            self.assertEqual(json.loads(result.stdout)["summary"]["status"], "ok")
            self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before)
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["document.json"])

    def test_batch_writes_only_scratch_reports_and_continues_missing_sample(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            source_dir = workspace / "input"
            source_dir.mkdir()
            source = source_dir / "fixture.txt"
            source.write_text("source fixture", encoding="utf-8")
            calls = []
            def fake_parse(path, document_id, filename, asset_dir):
                calls.append((path, document_id))
                asset_dir.mkdir(parents=True, exist_ok=True)
                return document()
            output = workspace / "output" / "qa"
            report = run_batch([("Working", source), ("Missing", source_dir / "missing.txt")], output, workspace, fake_parse)
            self.assertEqual([r["status"] for r in report["samples"]], ["parsed", "missing"])
            self.assertEqual(len(calls), 1)
            self.assertTrue((output / "report.json").is_file())
            self.assertTrue((output / "report.md").is_file())
            self.assertTrue((output / "working" / "document.json").is_file())
            self.assertEqual(source.read_text(encoding="utf-8"), "source fixture")
            for target in (workspace / ".reader-data" / "qa", source_dir / "qa"):
                with self.assertRaises(ValueError):
                    run_batch([("Working", source)], target, workspace, fake_parse)
                self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
