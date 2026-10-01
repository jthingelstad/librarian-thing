"""describe_media.py --retry-errors: fetch the image locally, convert what the
API won't take inline, and record a precise error for what still fails.

Plan docs/PLAN-2026-10-01-qa-followups.md, plan 4 step 2.
"""

from __future__ import annotations

import base64
import importlib.util
import io
import unittest
import unittest.mock

import requests
from librarian_core.paths import REPO
from PIL import Image

spec = importlib.util.spec_from_file_location(
    "test_describe_media_module", REPO / "pipeline" / "corpus" / "describe_media.py"
)
describe_media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(describe_media)


def _image(fmt: str, size=(40, 30), mode="RGB") -> bytes:
    out = io.BytesIO()
    Image.new(mode, size, "red").save(out, format=fmt)
    return out.getvalue()


def _response(status: int, content: bytes = b"") -> unittest.mock.Mock:
    return unittest.mock.Mock(status_code=status, content=content)


class PrepareTest(unittest.TestCase):
    def test_small_jpeg_passes_through_untouched(self):
        data = _image("JPEG")
        self.assertEqual(describe_media.prepare(data), ("image/jpeg", data))

    def test_oversized_png_with_alpha_becomes_a_bounded_jpeg(self):
        media_type, data = describe_media.prepare(_image("PNG", (3000, 1000), "RGBA"))
        self.assertEqual(media_type, "image/jpeg")
        image = Image.open(io.BytesIO(data))
        self.assertEqual(image.format, "JPEG")
        self.assertEqual(max(image.size), describe_media.MAX_EDGE)

    def test_tiff_and_webp_are_converted(self):
        for fmt in ("TIFF", "WEBP"):
            media_type, data = describe_media.prepare(_image(fmt))
            self.assertEqual(media_type, "image/jpeg", fmt)
            self.assertEqual(Image.open(io.BytesIO(data)).format, "JPEG", fmt)

    def test_an_error_page_is_a_decode_error(self):
        with self.assertRaises(describe_media.ImageFailure) as caught:
            describe_media.prepare(b"<html>Not an image</html>")
        self.assertEqual(caught.exception.code, "decode_error")


class FetchTest(unittest.TestCase):
    def test_http_is_tried_over_https_first(self):
        with unittest.mock.patch.object(
            describe_media.requests, "get", return_value=_response(200, b"img")
        ) as get:
            self.assertEqual(describe_media.fetch("http://files.thingelstad.com/a.png"), b"img")
        self.assertEqual(get.call_args_list[0].args[0], "https://files.thingelstad.com/a.png")
        self.assertEqual(get.call_count, 1)

    def test_http_falls_back_when_https_fails(self):
        replies = [requests.ConnectionError("no tls"), _response(200, b"img")]
        with unittest.mock.patch.object(describe_media.requests, "get", side_effect=replies):
            self.assertEqual(describe_media.fetch("http://example.com/a.png"), b"img")

    def test_status_is_the_error_code(self):
        with unittest.mock.patch.object(
            describe_media.requests, "get", return_value=_response(404)
        ):
            with self.assertRaises(describe_media.ImageFailure) as caught:
                describe_media.fetch("https://www.thingelstad.com/gone.jpg")
        self.assertEqual(caught.exception.code, "fetch_404")

    def test_unreachable_host_is_fetch_error(self):
        with unittest.mock.patch.object(
            describe_media.requests, "get", side_effect=requests.Timeout("slow")
        ):
            with self.assertRaises(describe_media.ImageFailure) as caught:
                describe_media.fetch("https://blotcdn.com/a.jpg")
        self.assertEqual(caught.exception.code, "fetch_error")


class SourceTest(unittest.TestCase):
    def test_inline_source_is_base64_of_the_prepared_image(self):
        data = _image("PNG")
        with unittest.mock.patch.object(describe_media, "fetch", return_value=data):
            source = describe_media.inline_source("https://files.thingelstad.com/a.png")
        self.assertEqual(source["type"], "base64")
        self.assertEqual(source["media_type"], "image/png")
        self.assertEqual(base64.b64decode(source["data"]), data)

    def test_retry_mode_takes_hosts_the_url_pass_skips(self):
        self.assertFalse(describe_media.allowed("http://files.thingelstad.com/a.png"))
        self.assertFalse(describe_media.allowed("https://pbs.twimg.com/media/x.jpg"))
        self.assertTrue(describe_media.fetchable("http://files.thingelstad.com/a.png"))
        self.assertTrue(describe_media.fetchable("https://pbs.twimg.com/media/x.jpg"))
        self.assertFalse(describe_media.fetchable("data:image/png;base64,AAAA"))


if __name__ == "__main__":
    unittest.main()


class CollectUrlsTest(unittest.TestCase):
    def test_blog_video_posters_are_collected_like_images(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            post = Path(tmp) / "2025" / "post.md"
            post.parent.mkdir()
            post.write_text(
                '<img src="https://www.thingelstad.com/uploads/2025/a.jpg" alt="">\n'
                '<video src="https://www.thingelstad.com/uploads/2025/v.mov" '
                'poster="https://www.thingelstad.com/uploads/2025/still.png"></video>\n'
                '<video src="https://www.thingelstad.com/uploads/2025/w.mov" poster=""></video>\n'
            )
            with (
                unittest.mock.patch.object(describe_media, "BLOG_POSTS", Path(tmp)),
                unittest.mock.patch.object(describe_media, "build_corpus", lambda: {"media": []}),
            ):
                urls = describe_media.collect_urls(keep=describe_media.fetchable)
        self.assertEqual(
            urls,
            [
                "https://www.thingelstad.com/uploads/2025/a.jpg",
                "https://www.thingelstad.com/uploads/2025/still.png",
            ],
        )
