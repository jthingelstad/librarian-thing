"""A link-family item's own link is its headline, however the item is laid out.

QA 2026-10-01 round 3 (ingest F10): only H3 heading links got
``link_role: "headline"``. A Briefly or Breadcrumbs list item that is just
its link, or a "{commentary} → **[Title](url)**" bold lead, was commentary
(688), so ``find_links link_role:"headline"`` and top_references dropped
them. An App pick's linked icon came before its H3, and the one row per
(issue, url) kept the icon's commentary role (32).
"""

import importlib.util
import unittest

from librarian_core import corpus as core
from librarian_core.paths import ARCHIVE_DIR, REPO

_spec = importlib.util.spec_from_file_location(
    "test_link_roles_gate", REPO / "pipeline" / "corpus" / "corpus_gate.py"
)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)


def roles(body):
    seen, earlier, out = set(), {}, []
    for section in core.split_issue_sections(body):
        for record in core.issue_body_links(section, skip_urls=seen, earlier=earlier):
            earlier[record["url"]] = record
            out.append(record)
    return {record["url"]: (record["link_role"], record["text"]) for record in out}


class LinkRoleTests(unittest.TestCase):
    def test_list_items_and_bold_leads_are_headlines(self):
        body = (
            "## Breadcrumbs 🍞\n\n"
            "- [Cybersecurity Tech Accord](https://cybertechaccord.org/)\n"
            "- [A bold one](https://b.test/) b.test\n"
            "- Python 3.7: [Introducing Data Classes](https://e.test/), see [also](https://f.test/)\n\n"
            "Jamie on why this matters, see [a source](https://c.test/). "
            "→ **[The real story](https://d.test/)**\n"
        )
        got = roles(body)
        self.assertEqual(got["https://cybertechaccord.org/"][0], "headline")
        self.assertEqual(got["https://b.test/"][0], "headline")
        self.assertEqual(got["https://c.test/"][0], "commentary")
        self.assertEqual(got["https://d.test/"][0], "headline")
        self.assertEqual(got["https://e.test/"][0], "headline")
        self.assertEqual(got["https://f.test/"][0], "commentary")

    def test_other_families_keep_their_roles(self):
        body = (
            "## Journal\n\n- [Out for a ride](https://www.thingelstad.com/2017/09/10/out.html)\n\n"
            "## Local\n\n- [A local story](https://local.test/)\n"
        )
        got = roles(body)
        self.assertEqual(got["https://www.thingelstad.com/2017/09/10/out.html"][0], "journal")
        self.assertEqual(got["https://local.test/"][0], "commentary")

    def test_app_icon_before_its_h3_takes_the_headline(self):
        app = "https://itunes.apple.com/us/app/better-by-ind-ie/id1080964978"
        body = (
            "## Highlighted iOS App 📱\n"
            f"[![image](https://assets.test/icon.jpg)]({app})\n"
            f"### [Better by Ind.ie]({app})\nby Ind.ie\n\nJamie on it.\n"
        )
        self.assertEqual(roles(body)[app], ("headline", "Better by Ind.ie"))

    def test_gate_flags_a_headline_shaped_commentary_row(self):
        text = "- Python 3.7: [Introducing Data Classes](https://a.test/)\n"
        corpus = {
            "issues": [
                {
                    "number": 50,
                    "sections": [{"section_family": "Briefly", "text": text}],
                    "links": [{"url": "https://a.test/", "link_role": "headline"}],
                }
            ]
        }
        self.assertEqual(gate.headline_shaped_commentary(corpus), [])
        corpus["issues"][0]["links"][0]["link_role"] = "commentary"
        self.assertEqual(gate.headline_shaped_commentary(corpus), ["WT50: https://a.test/"])
        corpus["issues"][0]["sections"][0]["section_family"] = "Journal"
        self.assertEqual(gate.headline_shaped_commentary(corpus), [])

    def test_real_archive(self):
        wt = core.build_corpus(ARCHIVE_DIR, include_issue_bodies=True)
        wt50 = [
            link
            for link in wt["links"]
            if link["issue_number"] == 50 and link["section"] == "Breadcrumbs 🍞"
        ]
        self.assertEqual(len(wt50), 12)
        self.assertEqual({link["link_role"] for link in wt50}, {"headline"})
        briefly = [link for link in wt["links"] if link.get("section_family") == "Briefly"]
        commentary = [link for link in briefly if link["link_role"] == "commentary"]
        self.assertLess(len(commentary) / len(briefly), 0.15)
        # App picks: 1 of 37 was headline before; the icon link led the row.
        app = [link for link in wt["links"] if link.get("section_family") == "App"]
        self.assertGreaterEqual(sum(link["link_role"] == "headline" for link in app), 33)
        # The gate's own oracle agrees.
        self.assertEqual(gate.headline_shaped_commentary(wt), [])


if __name__ == "__main__":
    unittest.main()
