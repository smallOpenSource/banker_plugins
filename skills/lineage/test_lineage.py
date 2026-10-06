#!/usr/bin/env python3
"""Regression tests for lineage.py — no external deps (stdlib unittest only).

Run with Python 3.7+:  python3.12 -m unittest test_lineage -v
Five suites map to the change-request defects (A/B/C/D/E/F). Inputs use RAW
`<...>` tags (as JSONL carries), NOT the display-escaped `&lt;` from the spec.
"""
import contextlib
import hashlib
import html
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import pathlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lineage as L  # noqa: E402


def _turn(role, text, ts="2026-08-09T10:00:00Z", uuid="u", tools=None,
          session="s", parts=None):
    return {"role": role, "text": text, "ts": ts, "uuid": uuid,
            "tools": tools or {}, "line_no": 1,
            "parts": parts if parts is not None else ([text] if text else []),
            "session": session, "session_name": session}


def _parse(lines):
    """Feed JSONL dict-lines through parse_turns."""
    stream = io.StringIO("\n".join(json.dumps(o) for o in lines))
    return list(L.parse_turns(stream, session_id="s", session_name="s"))


def _rec(role, text, ts="2026-08-09T10:00:00Z", uuid=None):
    return {"type": role, "uuid": uuid or (role + text[:4]), "timestamp": ts,
            "message": {"role": role, "content": text}}


# ============================================================ Suite 1: classify/summary
class TestClassificationAndSummary(unittest.TestCase):
    # ---- R1: parse_turns seeds parts ----
    def test_parse_seeds_parts(self):
        turns = _parse([_rec("user", "hello")])
        self.assertEqual(len(turns), 1)
        self.assertIn("parts", turns[0])
        self.assertEqual(turns[0]["parts"], ["hello"])

    def test_parse_seeds_session(self):
        turns = _parse([_rec("assistant", "hi")])
        self.assertEqual(turns[0]["session"], "s")

    def test_parse_tool_only_has_empty_parts(self):
        rec = {"type": "assistant", "uuid": "a1", "timestamp": "t",
               "message": {"role": "assistant",
                           "content": [{"type": "tool_use", "name": "Bash"}]}}
        turns = _parse([rec])
        self.assertEqual(turns[0]["parts"], [])
        self.assertEqual(turns[0]["tools"], {"Bash": 1})

    # ---- R1/B-1: merge_assistant_runs from parse output — no KeyError ----
    def test_merge_no_keyerror_from_parse(self):
        recs = [
            {"type": "assistant", "uuid": "a1", "timestamp": "t",
             "message": {"role": "assistant",
                         "content": [{"type": "text", "text": "body"}]}},
            {"type": "assistant", "uuid": "a2", "timestamp": "t2",
             "message": {"role": "assistant",
                         "content": [{"type": "tool_use", "name": "Bash"},
                                     {"type": "tool_use", "name": "Read"}]}},
        ]
        turns = _parse(recs)
        merged = L.merge_assistant_runs(turns)  # must not raise
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["tools"], {"Bash": 1, "Read": 1})

    def test_merge_keeps_first_timestamp(self):
        turns = [_turn("assistant", "a", ts="2026-01-01T00:00:00Z", uuid="x"),
                 _turn("assistant", "b", ts="2026-01-01T05:00:00Z", uuid="y")]
        merged = L.merge_assistant_runs(turns)
        self.assertEqual(merged[0]["ts"], "2026-01-01T00:00:00Z")

    def test_merge_sums_tools(self):
        turns = [_turn("assistant", "", uuid="x", tools={"Bash": 2}),
                 _turn("assistant", "", uuid="y", tools={"Bash": 1, "Read": 3})]
        merged = L.merge_assistant_runs(turns)
        self.assertEqual(merged[0]["tools"], {"Bash": 3, "Read": 3})

    def test_merge_is_pure(self):
        turns = [_turn("assistant", "a", uuid="x", tools={"Bash": 1}),
                 _turn("assistant", "b", uuid="y", tools={"Bash": 1})]
        L.merge_assistant_runs(turns)
        L.merge_assistant_runs(turns)  # twice
        self.assertEqual(turns[0]["tools"], {"Bash": 1})  # input unmutated

    def test_merge_session_guard(self):
        turns = [_turn("assistant", "a", uuid="x", session="s1"),
                 _turn("assistant", "b", uuid="y", session="s2")]
        merged = L.merge_assistant_runs(turns)
        self.assertEqual(len(merged), 2)  # different sessions don't merge

    def test_merge_user_between_splits(self):
        turns = [_turn("assistant", "a", uuid="x"),
                 _turn("user", "q", uuid="u"),
                 _turn("assistant", "b", uuid="y")]
        merged = L.merge_assistant_runs(turns)
        self.assertEqual(len(merged), 3)

    def test_merge_parts_accumulate(self):
        turns = [_turn("assistant", "a", uuid="x"),
                 _turn("assistant", "b", uuid="y")]
        merged = L.merge_assistant_runs(turns)
        self.assertEqual(merged[0]["parts"], ["a", "b"])

    # ---- A-3: clean_user_text bidirectional ----
    def test_clean_bare_harness_command_dropped(self):
        self.assertEqual(L.clean_user_text("/copy"), "")
        self.assertEqual(L.clean_user_text("/compact"), "")

    def test_clean_bare_nonharness_command_kept(self):
        self.assertEqual(L.clean_user_text("/init"), "/init")
        self.assertEqual(L.clean_user_text("/add-dir"), "/add-dir")

    def test_clean_quoted_tag_question_survives(self):
        txt = "<system-reminder>ctx</system-reminder>\nwhy show <system-reminder>?"
        out = L.clean_user_text(txt)
        self.assertIn("why show", out)

    def test_clean_command_record_harness_dropped(self):
        txt = "<command-name>/copy</command-name><command-message>copy</command-message>"
        self.assertEqual(L.clean_user_text(txt), "")

    def test_clean_command_record_plugin_kept(self):
        txt = "<command-name>/banker:append_wiki</command-name>"
        self.assertEqual(L.clean_user_text(txt), "/banker:append_wiki")

    def test_clean_command_with_args(self):
        txt = ("<command-name>/model</command-name>"
               "<command-args>opus</command-args>")
        # /model is harness → dropped even with args
        self.assertEqual(L.clean_user_text(txt), "")

    def test_clean_plugin_command_with_args(self):
        txt = ("<command-name>/banker:all-in-one</command-name>"
               "<command-args>--critic=critic go</command-args>")
        self.assertEqual(L.clean_user_text(txt),
                         "/banker:all-in-one --critic=critic go")

    def test_clean_keep_trivia_preserves_command(self):
        self.assertEqual(L.clean_user_text("/copy", drop_harness=False), "/copy")

    def test_clean_orphan_open_dropped(self):
        # a truncated wrapper block (leading orphan open) → dropped (R7)
        self.assertEqual(L.clean_user_text("<system-reminder>partial only"), "")

    def test_clean_plain_message_untouched(self):
        self.assertEqual(L.clean_user_text("just a normal message"),
                         "just a normal message")

    def test_noise_open_re_defined(self):
        self.assertTrue(L._NOISE_OPEN_RE.match("<task-notification foo"))
        self.assertIsNone(L._NOISE_OPEN_RE.match("hello <task-notification>"))

    # ---- A-2: split_agent_message ----
    def test_agent_extract(self):
        who, body = L.split_agent_message('<agent-message from="planner">done</agent-message>')
        self.assertEqual(who, "planner")
        self.assertEqual(body, "done")

    def test_agent_teammate_id(self):
        who, body = L.split_agent_message('<teammate-message teammate_id="w2">ok</teammate-message>')
        self.assertEqual(who, "w2")

    def test_agent_idle_json_dropped(self):
        who, body = L.split_agent_message('<agent-message from="x">{"type":"idle"}</agent-message>')
        self.assertEqual(body, "")

    def test_agent_trailing_harness_note_excluded(self):
        who, body = L.split_agent_message(
            '<agent-message from="x">real report</agent-message>\n'
            'agentId: abc (use SendMessage...)')
        self.assertEqual(body, "real report")

    def test_agent_peer_lead_stripped(self):
        who, body = L.split_agent_message(
            'Another Claude session sent a message: <agent-message from="p">hi</agent-message>')
        self.assertEqual(who, "p")

    def test_user_quoting_agent_tag_not_reclassified(self):
        who, body = L.split_agent_message("I saw <agent-message> in the log")
        self.assertIsNone(who)

    # ---- B-2: summarize_turn ----
    def test_summary_single_short(self):
        t = _turn("assistant", "짧은 답변입니다.")
        self.assertIn("짧은", L.summarize_turn(t))

    def test_summary_intent_only_uses_tail(self):
        t = _turn("assistant", "확인합니다.",
                  parts=["확인합니다.",
                         "결과: 테스트 42개가 모두 통과했고 빌드도 정상입니다."])
        s = L.summarize_turn(t)
        self.assertIn("통과", s)

    def test_summary_head_plus_tail(self):
        t = _turn("assistant", "x",
                  parts=["먼저 파일을 분석했습니다. 세부 내용을 살펴봅니다.",
                         "최종적으로 세 곳을 수정하여 문제를 해결했습니다."])
        s = L.summarize_turn(t)
        self.assertTrue("…" in s or "해결" in s)

    def test_sent_split_decimal_guard(self):
        parts = [p for p in L._SENT_SPLIT.split("Spring 5.3 is out. Ready.") if p.strip()]
        self.assertEqual(len(parts), 2)

    def test_sent_split_date_guard(self):
        parts = [p for p in L._SENT_SPLIT.split("2024. 08. 31. 완료") if p.strip()]
        self.assertEqual(len(parts), 1)

    def test_sent_split_filename_guard(self):
        parts = [p for p in L._SENT_SPLIT.split("EOS.xlsx saved. Done.") if p.strip()]
        self.assertEqual(len(parts), 2)

    def test_tail_block_skips_table(self):
        blocks = ["real conclusion sentence here", "| a | b |\n|---|---|"]
        self.assertNotIn("|", L._tail_block(blocks))

    def test_naive_summary_empty(self):
        self.assertEqual(L.naive_summary(""), "(empty turn)")

    # ---- classify_turns ----
    def test_classify_skill_body_dropped(self):
        turns = [_turn("user", "Base directory for this skill: /x\n...body...")]
        self.assertEqual(len(L.classify_turns(turns)), 0)

    def test_classify_workflow_body_dropped(self):
        turns = [_turn("user", 'Run the "deep-research" workflow.\n...')]
        self.assertEqual(len(L.classify_turns(turns)), 0)

    def test_classify_compaction_becomes_mark(self):
        turns = [_turn("user", "This session is being continued from a previous conversation. Summary:")]
        out = L.classify_turns(turns)
        self.assertEqual(out[0]["role"], "mark")

    def test_classify_image_note_replaced(self):
        turns = [_turn("user", "[Image: original 3000x480, displayed at 2000x320. Multiply...")]
        out = L.classify_turns(turns)
        self.assertEqual(out[0]["text"], "🖼 이미지 첨부")

    def test_classify_hook_feedback_dropped_always(self):
        turns = [_turn("user", "Stop hook feedback: keep going")]
        self.assertEqual(len(L.classify_turns(turns, drop_trivia=False)), 0)

    def test_classify_interrupt_dropped_always(self):
        turns = [_turn("user", "[Request interrupted by user]")]
        self.assertEqual(len(L.classify_turns(turns, drop_trivia=False)), 0)

    def test_classify_agent_becomes_agent_role(self):
        turns = [_turn("user", '<agent-message from="p">report body here</agent-message>')]
        out = L.classify_turns(turns)
        self.assertEqual(out[0]["role"], "agent")
        self.assertEqual(out[0]["agent_from"], "p")

    def test_classify_assistant_passthrough(self):
        turns = [_turn("assistant", "answer")]
        out = L.classify_turns(turns)
        self.assertEqual(out[0]["role"], "assistant")

    def test_classify_keep_trivia_keeps_skill_body(self):
        turns = [_turn("user", "Base directory for this skill: /x")]
        self.assertEqual(len(L.classify_turns(turns, drop_trivia=False)), 1)


# ============================================================ Suite 2: markdown
class TestMarkdown(unittest.TestCase):
    def test_heading(self):
        self.assertIn("<h3>", L.render_markdown("# Title"))

    def test_heading_deep_clamped(self):
        # h1..h6 map to h3..h6 to avoid page-header clash
        self.assertIn("<h6>", L.render_markdown("###### deep"))

    def test_bullet_list(self):
        out = L.render_markdown("- one\n- two")
        self.assertIn("<ul>", out)
        self.assertEqual(out.count("<li>"), 2)

    def test_numbered_list(self):
        out = L.render_markdown("1. a\n2. b")
        self.assertIn("<ol>", out)

    def test_table(self):
        out = L.render_markdown("| h1 | h2 |\n|---|---|\n| a | b |")
        self.assertIn("<table>", out)
        self.assertIn("<th>", out)
        self.assertIn("<td>", out)

    def test_code_fence(self):
        out = L.render_markdown("```\ncode line\n```")
        self.assertIn("<pre><code>", out)

    def test_fence_length_not_closed_by_shorter(self):
        # ```` opened; ``` inside must NOT close it
        out = L.render_markdown("````\n```\nstill code\n````")
        self.assertEqual(out.count("<pre><code>"), 1)

    def test_blockquote(self):
        self.assertIn("<blockquote>", L.render_markdown("> quoted"))

    def test_blockquote_depth_cap(self):
        deep = ">" * 2000 + " x"
        out = L.render_markdown(deep)  # must not blow the stack
        self.assertIsInstance(out, str)

    def test_bold(self):
        self.assertIn("<strong>x</strong>", L.render_markdown("**x**"))

    def test_italic(self):
        self.assertIn("<em>x</em>", L.render_markdown("*x*"))

    def test_strikethrough(self):
        self.assertIn("<del>x</del>", L.render_markdown("~~x~~"))

    def test_inline_code(self):
        self.assertIn("<code>x</code>", L.render_markdown("`x`"))

    def test_link(self):
        out = L.render_markdown("[docs](https://example.com/a)")
        self.assertIn('href="https://example.com/a"', out)

    def test_table_after_prose_not_swallowed(self):
        out = L.render_markdown("intro line\n| a | b |\n|---|---|\n| 1 | 2 |")
        self.assertIn("<table>", out)
        self.assertIn("<p>", out)

    def test_paragraph_forced_consume_no_infinite_loop(self):
        # a line that looks blockish but no branch fully consumes must still advance
        out = L.render_markdown("plain\n\n\nmore")
        self.assertIn("<p>", out)

    def test_paragraph_br_join(self):
        out = L.render_markdown("line1\nline2")
        self.assertIn("<br>", out)

    def test_no_double_break_pre_wrap(self):
        # N5: paragraph lines joined with <br>, no literal newline within <p>
        out = L.render_markdown("aaa\nbbb")
        p = out[out.index("<p>"):out.index("</p>")]
        self.assertNotIn("\n", p)

    def test_hr(self):
        self.assertIn("<hr>", L.render_markdown("---"))

    def test_bold_ital_del_all_balanced(self):
        out = L.render_markdown("**b** and *i* and ~~d~~")
        for tag in ("strong", "em", "del"):
            self.assertEqual(out.count("<%s>" % tag), out.count("</%s>" % tag))


# ============================================================ Suite 3: injection/escape
class TestInjectionAndEscape(unittest.TestCase):
    def test_raw_html_escaped(self):
        out = L.render_markdown("<script>alert(1)</script>")
        self.assertNotIn("<script>", out)
        self.assertIn("&lt;script&gt;", out)

    def test_no_event_handler_attr(self):
        # the whole tag is escaped → inert text, no live <img>/attribute
        out = L.render_markdown('<img src=x onerror="alert(1)">')
        self.assertNotIn("<img", out)
        self.assertIn("&lt;img", out)

    def test_self_verify_flags_real_event_handler(self):
        # a genuine live handler (if it ever leaked) is caught via parser attrs
        errs = L.self_verify('<div onclick="x()">y</div>')
        self.assertTrue(any("event-handler" in e for e in errs))

    def test_link_only_https(self):
        out = L.render_markdown("[x](javascript:alert(1))")
        self.assertNotIn("<a ", out)  # non-http scheme not linked

    def test_link_http_ok(self):
        out = L.render_markdown("[x](http://example.com)")
        self.assertIn("<a ", out)

    def test_c2_url_with_stars_no_escape(self):
        # THE C-2 regression: ** inside a URL must not create a stray <strong>
        out = L._md_inline(html.escape("see [d](https://x.io/a**b) and **bold** end"))
        self.assertIn('href="https://x.io/a**b"', out)
        self.assertEqual(out.count("<strong>"), 1)
        self.assertEqual(out.count("</strong>"), 1)
        self.assertNotIn("<strong>", out[:out.index("</a>")])  # none inside href

    def test_c2_no_strong_inside_href(self):
        out = L.render_markdown("[a](https://x/**y**z) then **real**")
        a_seg = out[out.index("<a "):out.index("</a>")]
        self.assertNotIn("<strong>", a_seg)

    def test_sentinel_collision_guard(self):
        # N4: a literal NUL in input must not corrupt the stash round-trip
        out = L.render_markdown("before \x00 `code` after **b**")
        self.assertIn("<code>code</code>", out)
        self.assertIn("<strong>b</strong>", out)

    def test_code_span_content_escaped(self):
        out = L.render_markdown("`<b>raw</b>`")
        self.assertIn("<code>&lt;b&gt;raw&lt;/b&gt;</code>", out)

    def test_no_markdown_path_escapes(self):
        out = L.render_body("<i>x</i>", markdown=False)
        self.assertEqual(out, "&lt;i&gt;x&lt;/i&gt;")

    def test_control_chars_stripped(self):
        out = L.render_markdown("a\x07b")
        self.assertNotIn("\x07", out)


# ============================================================ Suite 4: trivia filter
class TestTriviaFilter(unittest.TestCase):
    def test_harness_cmd_set_has_copy_compact(self):
        self.assertIn("copy", L._HARNESS_CMDS)
        self.assertIn("compact", L._HARNESS_CMDS)

    def test_add_dir_not_harness(self):
        self.assertNotIn("add-dir", L._HARNESS_CMDS)

    def test_init_not_harness(self):
        self.assertNotIn("init", L._HARNESS_CMDS)

    def test_echo_drops_one_char_reply(self):
        turns = [_turn("user", "1이라고 말해", uuid="u"),
                 _turn("assistant", "1", uuid="a")]
        self.assertEqual(len(L.drop_echo_exchanges(turns)), 0)

    def test_echo_keeps_real_short_confirm(self):
        # "네, 맞습니다." is 8 chars > ECHO_REPLY(5) → kept
        turns = [_turn("user", "맞아?", uuid="u"),
                 _turn("assistant", "네, 맞습니다.", uuid="a")]
        self.assertEqual(len(L.drop_echo_exchanges(turns)), 2)

    def test_echo_keeps_long_question(self):
        turns = [_turn("user", "x" * 100, uuid="u"),
                 _turn("assistant", "1", uuid="a")]
        self.assertEqual(len(L.drop_echo_exchanges(turns)), 2)

    def test_echo_not_dropped_when_tools(self):
        turns = [_turn("user", "go", uuid="u"),
                 _turn("assistant", "ok", uuid="a", tools={"Bash": 1})]
        self.assertEqual(len(L.drop_echo_exchanges(turns)), 2)

    def test_echo_session_guard(self):
        turns = [_turn("user", "go", uuid="u", session="s1"),
                 _turn("assistant", "ok", uuid="a", session="s2")]
        self.assertEqual(len(L.drop_echo_exchanges(turns)), 2)

    def test_echo_drops_question_with_reply(self):
        # dropping a reply must also drop its question (no orphan)
        turns = [_turn("user", "hi", uuid="u"), _turn("assistant", "hi", uuid="a")]
        out = L.drop_echo_exchanges(turns)
        self.assertEqual(out, [])

    def test_sys_error_dropped_by_default(self):
        turns = [_turn("user", "Login expired. Please run /login")]
        self.assertEqual(len(L.classify_turns(turns, drop_trivia=True)), 0)

    def test_sys_error_kept_with_keep_trivia(self):
        turns = [_turn("user", "Login expired")]
        self.assertEqual(len(L.classify_turns(turns, drop_trivia=False)), 1)


# ============================================================ Suite 5: session/defaults/path
class TestSessionDefaultsPath(unittest.TestCase):
    # ---- D-2 path encoding (the demonstrated underscore bug) ----
    def test_encode_underscore(self):
        self.assertEqual(L.encode_cwd("/app/poc/build_plugin/banker_plugins"),
                         "-app-poc-build-plugin-banker-plugins")

    def test_encode_slash(self):
        self.assertEqual(L.encode_cwd("/a/b/c"), "-a-b-c")

    def test_encode_windows_path(self):
        self.assertEqual(L.encode_cwd(r"C:\proj\docs"), "C--proj-docs")

    def test_encode_dot(self):
        self.assertEqual(L.encode_cwd("/a/b.c/d"), "-a-b-c-d")

    def test_encode_no_separator_collapse(self):
        # consecutive separators each map to their own '-' (no collapsing)
        self.assertEqual(L.encode_cwd("/a//b"), "-a--b")

    # ---- D-3 UnicodeDecodeError isolation ----
    def test_bad_utf8_file_isolated(self):
        with tempfile.NamedTemporaryFile("wb", suffix=".jsonl", delete=False) as f:
            f.write(b'\xff\xfe not valid utf8')
            bad = f.name
        try:
            turns = L._load_turns_from(pathlib.Path(bad), False, "s", "s")
            self.assertEqual(turns, [])  # skipped, no crash
        finally:
            os.unlink(bad)

    # ---- D-1 all-sessions record-level sort (via merge/echo session guards) ----
    def test_record_level_chrono_order(self):
        turns = [_turn("user", "a", ts="2026-01-01T02:00:00Z", uuid="1", session="A"),
                 _turn("user", "b", ts="2026-01-01T01:00:00Z", uuid="2", session="B")]
        turns.sort(key=lambda t: t.get("ts") or "9999")
        self.assertEqual(turns[0]["uuid"], "2")  # earlier ts first, cross-session

    def test_fill_missing_ts(self):
        turns = [_turn("user", "a", ts="2026-01-01T01:00:00Z"),
                 _turn("user", "b", ts=None),
                 _turn("assistant", "c", ts="2026-01-01T02:00:00Z")]
        L.fill_missing_ts(turns)
        self.assertEqual(turns[1]["ts"], "2026-01-01T01:00:00Z")  # inherits predecessor

    # ---- defaults ----
    def test_default_collapsed(self):
        args = L.build_arg_parser().parse_args([])
        self.assertFalse(args.open_details)

    def test_default_markdown_on(self):
        args = L.build_arg_parser().parse_args([])
        self.assertTrue(args.markdown)

    def test_default_filter_on(self):
        args = L.build_arg_parser().parse_args([])
        self.assertTrue(args.drop_trivia)

    def test_open_flag(self):
        args = L.build_arg_parser().parse_args(["--open"])
        self.assertTrue(args.open_details)

    def test_no_markdown_flag(self):
        args = L.build_arg_parser().parse_args(["--no-markdown"])
        self.assertFalse(args.markdown)

    def test_keep_trivia_flag(self):
        args = L.build_arg_parser().parse_args(["--keep-trivia"])
        self.assertFalse(args.drop_trivia)

    def test_all_sessions_flag(self):
        args = L.build_arg_parser().parse_args(["--all-sessions"])
        self.assertTrue(args.all_sessions)

    # ---- F-1 self_verify void-aware ----
    def test_self_verify_clean_template(self):
        doc = (L.HTML_TEMPLATE.replace("{{TITLE}}", "t")
               .replace("{{HEADER_TITLE}}", "t").replace("{{DATE_RANGE}}", "d")
               .replace("{{TURNS}}", '<div class="row me"><div class="bubble">'
                        '<div class="plain">hi</div></div></div>'))
        self.assertEqual(L.self_verify(doc), [])

    def test_self_verify_void_no_false_positive(self):
        # <meta> and <br> are void — must not trigger misnest
        errs = L.self_verify("<div><br><p>x<br>y</p></div>")
        self.assertEqual(errs, [])

    def test_self_verify_detects_misnest(self):
        errs = L.self_verify("<div><strong>a<em>b</strong>c</em></div>")
        self.assertTrue(errs)

    def test_self_verify_detects_unclosed(self):
        errs = L.self_verify("<div><p>x</div>")
        self.assertTrue(errs)

    def test_self_verify_detects_placeholder(self):
        errs = L.self_verify("<title>{{TITLE}}</title>")
        self.assertTrue(any("placeholder" in e for e in errs))

    def test_self_verify_ignores_script_body(self):
        # inline JS like `top<a-8` must not be counted as an <a> tag
        doc = '<div><script>var x = top<a-8;</script></div>'
        errs = L.self_verify(doc)
        self.assertFalse(any("<a>" in e for e in errs))


# ============================================================ Integration: render + e2e
class TestRenderIntegration(unittest.TestCase):
    def _render(self, turns, **kw):
        rows, *_ = L.render_rows(turns, "s", None, "full", False, **kw)
        return "\n".join(rows)

    def test_tool_indicator_renders(self):
        # B-1: merged tool count must actually render
        t = _turn("assistant", "did work", tools={"Bash": 2, "Read": 1})
        out = self._render([t])
        self.assertIn("🔧 도구 3건", out)

    def test_user_short_bubble_plain(self):
        out = self._render([_turn("user", "short msg")])
        self.assertIn('class="plain"', out)

    def test_user_long_folded(self):
        out = self._render([_turn("user", "x" * 500)])
        self.assertIn("<details", out)

    def test_default_collapsed_no_open_attr(self):
        out = self._render([_turn("assistant", "a", tools={"Bash": 1})],
                           open_details=False)
        self.assertNotIn("<details open>", out)
        self.assertIn("<details>", out)

    def test_open_adds_attr(self):
        out = self._render([_turn("assistant", "a")], open_details=True)
        self.assertIn("<details open>", out)

    def test_agent_bubble_class(self):
        t = _turn("agent", "report")
        t["agent_from"] = "planner"
        out = self._render([t])
        self.assertIn("row bot agent", out)
        self.assertIn("planner", out)

    def test_summary_hidden_when_open_css(self):
        # E-1: the CSS that hides summary when open applies to BOTH speakers
        self.assertIn("details[open]>summary .sum{display:none}", L.HTML_TEMPLATE)

    def test_prewrap_on_block_elements(self):
        # C-3: pre-wrap bound to p/li/blockquote (not the bubble)
        self.assertIn(".detail p,.detail li,.detail blockquote{white-space:pre-wrap",
                      L.HTML_TEMPLATE)

    def test_keyboard_ecode_and_composing(self):
        # E-2: e.code priority + isComposing guard present
        self.assertIn("e.isComposing", L.HTML_TEMPLATE)
        self.assertIn("e.code", L.HTML_TEMPLATE)

    def test_overlay_aria_modal(self):
        # E-4: overlay with aria-modal + ? button
        self.assertIn('aria-modal="true"', L.HTML_TEMPLATE)
        self.assertIn('class="helpbtn"', L.HTML_TEMPLATE)

    def test_pill_classes_present(self):
        # E-3: distinct pill shapes for date/session/compaction
        for cls in ("pill-date", "pill-session", "pill-compact"):
            self.assertIn(cls, L.HTML_TEMPLATE)

    def test_full_pipeline_self_verify_clean(self):
        # e2e: build a doc through main()'s render path and self_verify it
        turns = [
            _turn("user", "질문입니다 **강조** 포함"),
            _turn("assistant", "## 답\n- 항목1\n- 항목2\n\n`code` and [link](https://x.io)",
                  tools={"Read": 1}),
        ]
        turns = L.merge_assistant_runs(turns)
        rows, *_ = L.render_rows(turns, "s", None, "full", False)
        doc = (L.HTML_TEMPLATE.replace("{{TITLE}}", "t")
               .replace("{{HEADER_TITLE}}", "t").replace("{{DATE_RANGE}}", "d")
               .replace("{{TURNS}}", "\n".join(rows)))
        self.assertEqual(L.self_verify(doc), [])

    def test_compaction_mark_renders_divider(self):
        out = self._render([_turn("mark", "compaction")])
        self.assertIn("pill-compact", out)


# ============================================================ Range filters (e2e via main)
class TestRangeFiltersE2E(unittest.TestCase):
    def _run(self, records, extra_args):
        d = tempfile.mkdtemp()
        jf = os.path.join(d, "s.jsonl")
        with open(jf, "w", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
        rc = L.main(["--session", jf, "--output", os.path.join(d, "out.html"),
                     "--skip-reviewer"] + extra_args)
        htmls = [p for p in os.listdir(d) if p.startswith("out") and p.endswith(".html")]
        text = ""
        if htmls:
            with open(os.path.join(d, htmls[0]), encoding="utf-8") as f:
                text = f.read()
        return rc, text

    def test_to_date_inclusive_end_day(self):
        # THE --to regression: a bare end date must include the whole end day
        recs = [_rec("user", "day8msg", ts="2026-08-08T10:00:00Z", uuid="u8"),
                _rec("user", "day9msg", ts="2026-08-09T10:00:00Z", uuid="u9")]
        rc, text = self._run(recs, ["--to", "2026-08-09"])
        self.assertEqual(rc, 0)
        self.assertIn("day9msg", text)   # end day INCLUDED (was silently dropped)
        self.assertIn("day8msg", text)

    def test_to_date_excludes_next_day(self):
        recs = [_rec("user", "day9msg", ts="2026-08-09T10:00:00Z", uuid="u9"),
                _rec("user", "day10msg", ts="2026-08-10T10:00:00Z", uuid="u10")]
        rc, text = self._run(recs, ["--to", "2026-08-09"])
        self.assertIn("day9msg", text)
        self.assertNotIn("day10msg", text)

    def test_from_date_inclusive_start_day(self):
        recs = [_rec("user", "day8msg", ts="2026-08-08T10:00:00Z", uuid="u8"),
                _rec("user", "day9msg", ts="2026-08-09T10:00:00Z", uuid="u9")]
        rc, text = self._run(recs, ["--from", "2026-08-09"])
        self.assertIn("day9msg", text)
        self.assertNotIn("day8msg", text)

    def test_last_n(self):
        recs = [_rec("user", "msg%d" % i, ts="2026-08-09T10:0%d:00Z" % i, uuid="u%d" % i)
                for i in range(5)]
        rc, text = self._run(recs, ["--last", "2"])
        self.assertIn("msg4", text)
        self.assertNotIn("msg0", text)

    def test_turns_range_1indexed(self):
        recs = [_rec("user", "msg%d" % i, ts="2026-08-09T10:0%d:00Z" % i, uuid="u%d" % i)
                for i in range(5)]
        rc, text = self._run(recs, ["--turns", "2-3"])
        self.assertIn("msg1", text)      # turn 2 == msg1 (1-indexed)
        self.assertNotIn("msg0", text)   # turn 1 excluded
        self.assertNotIn("msg4", text)   # turn 5 excluded

    def test_last_zero_no_crash(self):
        recs = [_rec("user", "only", ts="2026-08-09T10:00:00Z", uuid="u")]
        rc, text = self._run(recs, ["--last", "0"])
        self.assertEqual(rc, 0)          # --last 0 must not crash



# ============================================================ LLM review mode (emit -> decisions -> apply)
class _ReviewCase(unittest.TestCase):
    """A session file, a pack path and a private summary cache for the review tests."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.jf = os.path.join(self.d, "s.jsonl")
        self.pack = os.path.join(self.d, "review.json")
        self.cache = tempfile.mkdtemp()
        self._cache_base = L.CACHE_BASE
        L.CACHE_BASE = pathlib.Path(self.cache)

    def tearDown(self):
        L.CACHE_BASE = self._cache_base
        shutil.rmtree(self.d, ignore_errors=True)
        shutil.rmtree(self.cache, ignore_errors=True)

    def _write(self, records):
        with open(self.jf, "w", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

    def _asst(self, text, uuid, ts="2026-08-09T10:00:01Z", tools=None):
        content = [{"type": "text", "text": text}] if text else []
        for name in (tools or []):
            content.append({"type": "tool_use", "name": name, "input": {}})
        return {"type": "assistant", "uuid": uuid, "timestamp": ts,
                "message": {"role": "assistant", "content": content}}

    def _emit(self, extra=()):
        rc = L.main(["--session", self.jf, "--emit-review", self.pack] + list(extra))
        with open(self.pack, encoding="utf-8") as f:
            return rc, json.load(f)

    def _apply(self, decisions=None, extra=()):
        args = ["--apply-review", self.pack, "--output", os.path.join(self.d, "out.html"), "--skip-reviewer"]
        if decisions is not None:
            dec = os.path.join(self.d, "dec-%d.json" % len(os.listdir(self.d)))
            with open(dec, "w", encoding="utf-8") as f:
                json.dump(decisions, f, ensure_ascii=False)
            args += ["--decisions", dec]
        rc = L.main(args + list(extra))
        htmls = [p for p in os.listdir(self.d) if p.startswith("out") and p.endswith(".html")]
        text = ""
        if htmls:
            with open(os.path.join(self.d, htmls[0]), encoding="utf-8") as f:
                text = f.read()
        return rc, text

    def _records(self):
        return [
            _rec("user", "배포 스크립트를 고쳐 주세요", ts="2026-08-09T10:00:00Z", uuid="u1"),
            self._asst("먼저 스크립트를 읽겠습니다.\n\n고친 결과 배포가 끝까지 통과합니다.", "a1", tools=["Read"]),
            _rec("user", "ok", ts="2026-08-09T10:01:00Z", uuid="u2"),
            self._asst("ok", "a2", ts="2026-08-09T10:01:01Z"),
            _rec("user", "토큰은 AKIA" "IOSFODNN7EXAMPLE 입니다", ts="2026-08-09T10:02:00Z", uuid="u3"),
            self._asst("", "a3", ts="2026-08-09T10:02:01Z", tools=["Bash"]),
        ]



class TestLlmReview(_ReviewCase):
    """The default /lineage flow: the script packs the turns for the session's model to
    review (--emit-review), the model writes keep/summary decisions, the script renders
    from them (--apply-review). --rulebase is the one-pass rule-only run."""

    def test_emit_packs_every_turn_with_the_rule_decision_and_an_empty_llm_slot(self):
        self._write(self._records())
        rc, pack = self._emit()
        self.assertEqual(rc, 0)
        self.assertEqual(pack["schema"], "lineage-review/1")
        ids = [t["id"] for t in pack["turns"]]
        self.assertEqual(ids, ["u1", "a1", "u2", "a2", "u3", "a3"])
        by = {t["id"]: t for t in pack["turns"]}
        self.assertTrue(by["a1"]["rule"]["keep"])
        self.assertEqual(by["a1"]["llm"], {"keep": None, "summary": None})
        self.assertEqual(by["a1"]["tools"], {"Read": 1})
        # judgement calls the rules made are offered back, not hidden
        self.assertEqual((by["u2"]["rule"]["keep"], by["u2"]["rule"]["why"]), (False, "echo"))
        self.assertEqual((by["a2"]["rule"]["keep"], by["a2"]["rule"]["why"]), (False, "echo"))
        self.assertEqual((by["a3"]["rule"]["keep"], by["a3"]["rule"]["why"]), (False, "tool-only"))
        self.assertTrue(by["a1"]["rule"]["summary"])

    def test_emit_writes_no_plain_secret_and_keeps_the_pack_private(self):
        self._write(self._records())
        self._emit()
        with open(self.pack, encoding="utf-8") as f:
            raw = f.read()
        self.assertNotIn("AKIA" "IOSFODNN7EXAMPLE", raw)
        if os.name == "posix":
            self.assertEqual(os.stat(self.pack).st_mode & 0o777, 0o600)

    def test_emit_previews_long_text_for_the_reviewer(self):
        long = "가" * 3000 + "결론 문장입니다."
        self._write([_rec("user", "길게 설명해 주세요", uuid="u1"), self._asst(long, "a1")])
        _, pack = self._emit()
        a1 = pack["turns"][1]
        self.assertTrue(a1["clipped"])
        self.assertLess(len(a1["preview"]), len(a1["text"]))
        self.assertTrue(a1["preview"].endswith("결론 문장입니다."), "the preview keeps the tail, where conclusions sit")

    def test_apply_without_decisions_renders_what_the_rules_decided(self):
        self._write(self._records())
        self._emit()
        rc, text = self._apply()
        self.assertEqual(rc, 0)
        self.assertIn("배포 스크립트를 고쳐 주세요", text)
        self.assertNotIn(">ok<", text, "the echo exchange stays out")

    def test_apply_uses_the_reviewers_summary_and_keep_decisions(self):
        self._write(self._records())
        self._emit()
        rc, text = self._apply([
            {"id": "a1", "keep": True, "summary": "배포 스크립트 수정 완료, 끝까지 통과"},
            {"id": "u3", "keep": False},
            {"id": "u2", "keep": True},
            {"id": "a2", "keep": True, "summary": "확인 응답"},
        ])
        self.assertEqual(rc, 0)
        self.assertIn("배포 스크립트 수정 완료, 끝까지 통과", text)
        self.assertNotIn("토큰은", text, "a turn the reviewer dropped is gone")
        self.assertIn("확인 응답", text, "a turn the rules dropped can be restored")

    def test_apply_cuts_long_summaries_and_redacts_them(self):
        self._write(self._records())
        self._emit()
        rc, text = self._apply([{"id": "a1", "keep": True, "summary": "AKIA" "IOSFODNN7EXAMPLE " + "요약" * 100}])
        self.assertEqual(rc, 0)
        self.assertNotIn("AKIA" "IOSFODNN7EXAMPLE", text)
        sums = [s for s in text.split('<span class="sum">')[1:] if s.startswith("[REDACTED") or "요약요약" in s]
        self.assertTrue(sums)
        self.assertLessEqual(len(html.unescape(sums[0].split("</span>")[0])), 120)

    def test_apply_refuses_a_bad_pack_or_bad_decisions(self):
        self._write(self._records())
        self._emit()
        with open(self.pack, "w", encoding="utf-8") as f:
            f.write('{"schema": "something-else", "turns": []}')
        self.assertEqual(self._apply()[0], 2)
        self._emit()
        self.assertEqual(self._apply([{"id": "a1", "keep": "yes"}])[0], 2)
        self.assertEqual(self._apply([{"id": "a1", "summary": 3}])[0], 2)
        self.assertEqual(self._apply({"not": "a list"})[0], 2)

    def test_apply_warns_about_unknown_ids_and_goes_on(self):
        self._write(self._records())
        self._emit()
        err = io.StringIO()
        old = sys.stderr
        sys.stderr = err
        try:
            rc, text = self._apply([{"id": "nope", "keep": False}])
        finally:
            sys.stderr = old
        self.assertEqual(rc, 0)
        self.assertIn("nope", err.getvalue())
        self.assertIn("배포 스크립트를 고쳐 주세요", text)

    def test_reviewed_summaries_are_cached_and_prefilled_next_time(self):
        self._write(self._records())
        self._emit()
        self._apply([{"id": "a1", "keep": True, "summary": "배포 수정 완료"}])
        _, pack = self._emit()
        a1 = [t for t in pack["turns"] if t["id"] == "a1"][0]
        self.assertEqual(a1["llm"]["summary"], "배포 수정 완료")
        self.assertTrue(a1["llm"]["cached"])

    def test_emit_respects_the_selection_flags(self):
        recs = [_rec("user", "msg%d" % i, ts="2026-08-09T10:0%d:00Z" % i, uuid="u%d" % i) for i in range(5)]
        self._write(recs)
        _, pack = self._emit(["--last", "2"])
        self.assertEqual([t["id"] for t in pack["turns"]], ["u3", "u4"])

    def test_rulebase_is_the_one_pass_run(self):
        self._write(self._records())
        a = L.main(["--session", self.jf, "--output", os.path.join(self.d, "plain.html"), "--skip-reviewer"])
        b = L.main(["--session", self.jf, "--output", os.path.join(self.d, "rule.html"), "--skip-reviewer", "--rulebase"])
        self.assertEqual((a, b), (0, 0))

        def read(prefix):
            name = [p for p in os.listdir(self.d) if p.startswith(prefix)][0]
            with open(os.path.join(self.d, name), encoding="utf-8") as f:
                return f.read()
        self.assertEqual(read("plain"), read("rule"))


class TestLlmReviewParts(_ReviewCase):
    """The pack's part files (one reviewer's share each), the decisions files beside
    them, and the flags that cannot go together."""

    def _long_session(self, n):
        recs = []
        for i in range(n):
            recs.append(_rec("user", "질문 %d 입니다" % i, ts="2026-08-09T10:%02d:00Z" % i, uuid="u%d" % i))
            recs.append(self._asst("답변 %d 입니다. 결과는 통과입니다." % i, "a%d" % i,
                                   ts="2026-08-09T10:%02d:01Z" % i))
        return recs

    def _parts(self):
        return sorted(p for p in os.listdir(self.d)
                      if p.startswith("review.part-") and not p.endswith(".decisions.json"))

    def test_emit_splits_the_pack_into_parts_without_the_full_text(self):
        self._write(self._long_session(30))
        rc, pack = self._emit()
        self.assertEqual(rc, 0)
        self.assertEqual(len(pack["turns"]), 60)
        self.assertEqual(self._parts(), ["review.part-1.json", "review.part-2.json"])
        with open(os.path.join(self.d, "review.part-2.json"), encoding="utf-8") as f:
            part = json.load(f)
        self.assertEqual(part["schema"], "lineage-review-part/1")
        self.assertEqual((part["part"], part["of"]), (2, 2))
        self.assertEqual(part["decisions"], "review.part-2.decisions.json")
        self.assertEqual(len(part["turns"]), 30, "60 turns split evenly, not 40 + 20")
        self.assertNotIn("text", part["turns"][0], "a reviewer reads the preview")
        self.assertEqual([p["ids"][0] for p in pack["parts"]], ["u0", "u15"])
        if os.name == "posix":
            self.assertEqual(os.stat(os.path.join(self.d, "review.part-1.json")).st_mode & 0o777, 0o600)

    def test_apply_picks_up_the_decisions_written_beside_the_parts(self):
        self._write(self._records())
        self._emit()
        with open(os.path.join(self.d, "review.part-1.decisions.json"), "w", encoding="utf-8") as f:
            json.dump([{"id": "a1", "keep": True, "summary": "파트 결정 요약"}], f, ensure_ascii=False)
        rc, text = self._apply()
        self.assertEqual(rc, 0)
        self.assertIn("파트 결정 요약", text)

    def test_a_new_emit_clears_the_last_runs_parts_and_decisions(self):
        self._write(self._long_session(30))
        self._emit()
        stale = os.path.join(self.d, "review.part-2.decisions.json")
        with open(stale, "w", encoding="utf-8") as f:
            json.dump([{"id": "a25", "keep": False}], f)
        self._write(self._records())
        self._emit()
        self.assertEqual(self._parts(), ["review.part-1.json"])
        self.assertFalse(os.path.exists(stale), "an old decisions file must not reach the new pack")

    def test_apply_names_every_part_with_undecided_turns(self):
        self._write(self._long_session(30))
        self._emit()
        with open(os.path.join(self.d, "review.part-1.decisions.json"), "w", encoding="utf-8") as f:
            json.dump([{"id": "a0", "keep": True}], f)
        err = io.StringIO()
        old = sys.stderr
        sys.stderr = err
        try:
            rc, _ = self._apply()
        finally:
            sys.stderr = old
        self.assertEqual(rc, 0)
        self.assertIn("part 1: 29/30 turns undecided", err.getvalue(), "a partial answer is not silent")
        self.assertIn("part 2: 30/30 turns undecided", err.getvalue())

    def test_a_broken_decisions_file_beside_a_part_stops_the_run(self):
        self._write(self._records())
        self._emit()
        with open(os.path.join(self.d, "review.part-1.decisions.json"), "w", encoding="utf-8") as f:
            f.write("not json")
        self.assertEqual(self._apply()[0], 2)

    def test_review_flags_that_cannot_go_together(self):
        self._write(self._records())
        for argv in (["--emit-review", self.pack, "--apply-review", self.pack],
                     ["--rulebase", "--emit-review", self.pack],
                     ["--decisions", "x.json"]):
            self.assertEqual(L.main(["--session", self.jf] + argv), 2, argv)

    def test_last_counts_the_turns_the_rules_keep_and_carries_the_dropped_between(self):
        self._write(self._records())
        _, pack = self._emit(["--last", "2"])
        # the rules keep u1, a1, u3; the last two of those are a1 and u3, so the echo
        # pair between them comes along, and the tool-only turn after the end too
        self.assertEqual([t["id"] for t in pack["turns"]], ["a1", "u2", "a2", "u3", "a3"])

    def test_reviewed_keep_decisions_are_cached_too(self):
        self._write(self._records())
        self._emit()
        self._apply([{"id": "u2", "keep": True}])
        _, pack = self._emit()
        u2 = [t for t in pack["turns"] if t["id"] == "u2"][0]
        self.assertEqual(u2["llm"], {"keep": True, "summary": None, "cached": True})

    def test_a_turn_the_reviewer_left_to_the_rules_counts_as_reviewed_next_time(self):
        self._write(self._records())
        self._emit()
        self._apply([{"id": "a1", "keep": None, "summary": None}])
        err = io.StringIO()
        old = sys.stderr
        sys.stderr = err
        try:
            _, pack = self._emit()
        finally:
            sys.stderr = old
        a1 = [t for t in pack["turns"] if t["id"] == "a1"][0]
        self.assertEqual(a1["llm"], {"keep": None, "summary": None, "cached": True})
        self.assertIn("to review: 5)", err.getvalue(), "the five turns nobody reviewed")

    def test_a_failed_quality_gate_caches_nothing(self):
        self._write(self._records())
        self._emit()
        verdict = os.path.join(self.d, "verdict.json")
        with open(verdict, "w", encoding="utf-8") as f:
            json.dump([{"idx": 0, "recoverable": False, "reason": "vague"}], f)
        dec = os.path.join(self.d, "dec.json")
        with open(dec, "w", encoding="utf-8") as f:
            json.dump([{"id": "a1", "keep": True, "summary": "모호한 요약"}], f, ensure_ascii=False)
        rc = L.main(["--apply-review", self.pack, "--decisions", dec,
                     "--output", os.path.join(self.d, "out.html"),
                     "--reviewer-output", verdict, "--reviewer-timeout", "1"])
        self.assertEqual(rc, 2)
        _, pack = self._emit()
        a1 = [t for t in pack["turns"] if t["id"] == "a1"][0]
        self.assertEqual(a1["llm"], {"keep": None, "summary": None})

    def test_a_summary_for_a_short_user_turn_is_ignored(self):
        self._write(self._records())
        self._emit()
        rc, text = self._apply([{"id": "u1", "keep": True, "summary": "사용자 요약"}])
        self.assertEqual(rc, 0)
        self.assertNotIn("사용자 요약", text)
        self.assertIn("배포 스크립트를 고쳐 주세요", text)

    def test_a_long_user_turn_takes_the_reviewers_summary(self):
        long_ask = "배경 설명입니다. " * 60 + "요청: 배포를 고쳐 주세요."
        self._write([_rec("user", long_ask, uuid="u1"), self._asst("고쳤습니다.", "a1")])
        _, pack = self._emit()
        self.assertTrue(pack["turns"][0]["rule"]["summary"])
        rc, text = self._apply([{"id": "u1", "keep": True, "summary": "배포 수정 요청"}])
        self.assertEqual(rc, 0)
        self.assertIn('<span class="sum">배포 수정 요청</span>', text)


class TestLlmReviewSources(_ReviewCase):
    """The pack across input sources: stdin transcripts and --all-sessions."""

    def test_stdin_turns_with_the_same_text_get_distinct_ids(self):
        recs = [_rec("user", "같은 질문입니다", ts="2026-08-09T10:00:00Z"),
                self._asst("첫 번째 답변을 드립니다.", "x1", ts="2026-08-09T10:00:01Z"),
                _rec("user", "같은 질문입니다", ts="2026-08-09T10:01:00Z"),
                self._asst("두 번째 답변을 드립니다.", "x2", ts="2026-08-09T10:01:01Z")]
        old = sys.stdin
        sys.stdin = io.StringIO("".join(json.dumps(r) + "\n" for r in recs))
        try:
            rc = L.main(["--from-transcript", "-", "--emit-review", self.pack])
        finally:
            sys.stdin = old
        self.assertEqual(rc, 0)
        with open(self.pack, encoding="utf-8") as f:
            ids = [x["id"] for x in json.load(f)["turns"]]
        self.assertEqual(len(ids), len(set(ids)), ids)
        users = [i for i in ids if i.endswith("#2")]
        self.assertEqual(len(users), 1, "the repeated question gets the #2 id")
        rc, text = self._apply([{"id": users[0], "keep": False}])
        self.assertEqual(rc, 0)
        self.assertEqual(text.count("같은 질문입니다"), 1, "only the decided twin is dropped")

    def test_all_sessions_keeps_each_turns_session_for_the_dividers(self):
        a = os.path.join(self.d, "aaaa1111.jsonl")
        b = os.path.join(self.d, "bbbb2222.jsonl")
        for path, recs in ((a, [_rec("user", "첫 세션 질문", ts="2026-08-09T09:00:00Z", uuid="ua"),
                                self._asst("첫 세션 답변입니다.", "aa", ts="2026-08-09T09:00:01Z")]),
                           (b, [_rec("user", "둘째 세션 질문", ts="2026-08-09T11:00:00Z", uuid="ub"),
                                self._asst("둘째 세션 답변입니다.", "ab", ts="2026-08-09T11:00:01Z")])):
            with open(path, "w", encoding="utf-8") as f:
                for r in recs:
                    f.write(json.dumps(r) + "\n")
        saved = L.project_jsonl_files
        L.project_jsonl_files = lambda: [pathlib.Path(a), pathlib.Path(b)]
        try:
            rc = L.main(["--all-sessions", "--emit-review", self.pack])
        finally:
            L.project_jsonl_files = saved
        self.assertEqual(rc, 0)
        with open(self.pack, encoding="utf-8") as f:
            pack = json.load(f)
        self.assertTrue(pack["all_sessions"])
        self.assertEqual([x["session"] for x in pack["turns"]],
                         ["aaaa1111", "aaaa1111", "bbbb2222", "bbbb2222"])
        rc, text = self._apply()
        self.assertEqual(rc, 0)
        self.assertEqual(text.count('class="pill pill-session"'), 2, "one divider per session")



def _random_run(seed, n=48):
    """`n` letters and digits that look random (entropy above lineage's 4.5 floor), made at
    run time so this file holds no secret-like string for a scanner to flag."""
    import random
    import string
    rng = random.Random(seed)
    return "".join(rng.choice(string.ascii_letters + string.digits) for _ in range(n))


def _quiet(fn, *a, **kw):
    """Run fn with stderr captured; returns (result, stderr text)."""
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        result = fn(*a, **kw)
    return result, err.getvalue()


class TestLlmReviewHardening(_ReviewCase):
    """The review flow's edges: what reaches a reviewer, what the cache keys on, which
    flags survive the two runs, and what is left on disk."""

    def _part(self, k=1):
        with open(os.path.join(self.d, "review.part-%d.json" % k), encoding="utf-8") as f:
            return json.load(f)

    def test_a_cached_rule_summary_is_redacted_again_with_this_runs_keywords(self):
        self._write([_rec("user", "점검해 주세요", uuid="u1"),
                     self._asst("PROJECTX 배포 점검 결과를 정리했습니다.", "a1")])
        _quiet(L.main, ["--session", self.jf, "--output", os.path.join(self.d, "r.html"),
                        "--skip-reviewer", "--rulebase"])          # fills the summary cache
        rc, pack = _quiet(self._emit, ["--redact-extra", "projectx"])[0]
        self.assertEqual(rc, 0)
        files = [self.pack, os.path.join(self.d, "review.part-1.json")]
        for path in files:
            with open(path, encoding="utf-8") as f:
                self.assertNotIn("PROJECTX", f.read().upper(), path)
        self.assertEqual(pack["redactions"].get("custom"), 1, "counted once, as `custom`")
        self.assertFalse([k for k in pack["redactions"] if ":" in k and k.startswith("custom")],
                         "the keyword itself is not a key in the pack")

    def test_a_cached_reviewer_summary_is_redacted_again_with_this_runs_keywords(self):
        # the keyword given at emit and left out at apply (a WARN): the reviewer's summary is
        # cached with it, and the next emit hides it again in the part a reviewer reads (the
        # pack keeps the cached summary as the page would; the page redacts it at apply)
        self._write([_rec("user", "점검해 주세요", uuid="u1"),
                     self._asst("배포 점검 결과를 정리했습니다.", "a1")])
        self.assertEqual(_quiet(self._emit, ["--redact-extra", "projectx"])[0][0], 0)
        tid = [x["id"] for x in self._part()["turns"] if x["role"] == "assistant"][0]
        (rc, _), err = _quiet(self._apply, [{"id": tid, "keep": None, "summary": "PROJECTX 배포 점검을 마쳤다"}])
        self.assertEqual(rc, 0, err)
        self.assertEqual(_quiet(self._emit, ["--redact-extra", "projectx"])[0][0], 0)
        llm = [x["llm"] for x in self._part()["turns"] if x["id"] == tid][0]
        self.assertTrue(llm.get("cached"), llm)
        self.assertIn("[REDACTED]", llm["summary"])
        with open(os.path.join(self.d, "review.part-1.json"), encoding="utf-8") as f:
            self.assertNotIn("PROJECTX", f.read().upper(), "the part file a reviewer reads")

    def test_stdin_twins_keep_their_own_decisions_across_runs(self):
        recs = [_rec("user", "같은 질문입니다", ts="2026-08-09T10:00:00Z"),
                self._asst("첫 번째 답변을 드립니다.", "x1", ts="2026-08-09T10:00:01Z"),
                _rec("user", "같은 질문입니다", ts="2026-08-09T10:01:00Z"),
                self._asst("두 번째 답변을 드립니다.", "x2", ts="2026-08-09T10:01:01Z")]
        feed = "".join(json.dumps(r) + "\n" for r in recs)

        def emit():
            old = sys.stdin
            sys.stdin = io.StringIO(feed)
            try:
                _quiet(L.main, ["--from-transcript", "-", "--emit-review", self.pack])
            finally:
                sys.stdin = old
            with open(self.pack, encoding="utf-8") as f:
                return json.load(f)
        pack = emit()
        twin = [x["id"] for x in pack["turns"] if x["id"].endswith("#2")][0]
        first = twin[:-2]
        rc, text = _quiet(self._apply, [{"id": first, "keep": None}, {"id": twin, "keep": False}])[0]
        self.assertEqual((rc, text.count("같은 질문입니다")), (0, 1))
        again = {x["id"]: x["llm"] for x in emit()["turns"]}
        self.assertEqual(again[twin], {"keep": False, "summary": None, "cached": True})
        self.assertEqual(again[first], {"keep": None, "summary": None, "cached": True})
        rc, text = _quiet(self._apply)[0]
        self.assertEqual((rc, text.count("같은 질문입니다")), (0, 1), "the second run renders the same page")

    def test_gate_flags_given_at_emit_hold_at_apply(self):
        self._write(self._records())
        verdict = os.path.join(self.d, "verdict.json")
        with open(verdict, "w", encoding="utf-8") as f:
            json.dump([{"idx": 0, "recoverable": False, "reason": "vague"}], f)
        _quiet(self._emit, ["--reviewer-output", verdict, "--reviewer-timeout", "1"])
        rc = _quiet(L.main, ["--apply-review", self.pack, "--output", os.path.join(self.d, "out.html")])[0]
        self.assertEqual(rc, 2, "the gate given at --emit-review is enforced at --apply-review")
        _quiet(self._emit, ["--skip-reviewer"])
        rc, err = _quiet(L.main, ["--apply-review", self.pack, "--output", os.path.join(self.d, "second.html")])
        self.assertEqual(rc, 0)
        self.assertIn("--skip-reviewer", err)
        self.assertFalse([p for p in os.listdir(self.d) if p.startswith(".second")], "no gate samples")

    def test_purge_cache_and_empty_pack_paths_do_not_go_with_the_review_flow(self):
        self._write(self._records())
        for argv in (["--purge-cache", "--emit-review", self.pack],
                     ["--purge-cache", "--apply-review", self.pack],
                     ["--emit-review", ""], ["--apply-review", ""]):
            self.assertEqual(_quiet(L.main, ["--session", self.jf] + argv)[0], 2, argv)

    def test_parts_are_split_evenly(self):
        self.assertEqual([len(g) for g in L._split_even(list(range(41)), 40)], [21, 20])
        self.assertEqual([len(g) for g in L._split_even(list(range(80)), 40)], [40, 40])
        self.assertEqual([len(g) for g in L._split_even(list(range(81)), 40)], [27, 27, 27])
        self.assertEqual(L._split_even([], 40), [])

    def test_a_reviewer_reads_fully_redacted_text_even_in_mask_mode(self):
        ant = "sk-" + "ant-api03-" + "b" * 24
        self._write([_rec("user", "키 확인", uuid="u1"),
                     self._asst("키는 AKIA" "IOSFODNN7EXAMPLE 와 %s 입니다." % ant, "a1")])
        _quiet(self._emit, ["--redact-mode", "mask"])
        raw = json.dumps(self._part(), ensure_ascii=False)
        self.assertNotIn("AKIA****", raw, "mask mode keeps 4+4 characters; a reviewer gets none")
        self.assertNotIn("MPLE", raw)
        self.assertNotIn("sk-ant-", raw, "reviewer-only patterns apply to the part file")
        with open(self.pack, encoding="utf-8") as f:
            self.assertIn("AKIA****", f.read(), "the page keeps --redact-mode mask")

    def test_the_rulebase_page_hides_reviewer_only_keys(self):
        ant = "sk-" + "ant-api03-" + "b" * 24
        self._write([_rec("user", "키 확인", uuid="u1"), self._asst("키는 %s 입니다." % ant, "a1")])
        out = os.path.join(self.d, "r.html")
        _quiet(L.main, ["--session", self.jf, "--output", out, "--skip-reviewer", "--rulebase"])
        name = [p for p in os.listdir(self.d) if p.startswith("r_")][0]
        with open(os.path.join(self.d, name), encoding="utf-8") as f:
            self.assertNotIn(ant, f.read(), "3.0.2: every page runs the reviewer patterns")

    def test_decisions_wrapped_in_a_code_fence_are_read(self):
        self._write(self._records())
        _quiet(self._emit)
        with open(os.path.join(self.d, "review.part-1.decisions.json"), "w", encoding="utf-8") as f:
            f.write('```json\n[{"id": "a1", "keep": true, "summary": "펜스 안의 요약"}]\n```\n')
        rc, text = _quiet(self._apply)[0]
        self.assertEqual(rc, 0)
        self.assertIn("펜스 안의 요약", text)

    def test_decision_files_beside_the_pack_are_made_private(self):
        self._write(self._records())
        _rc, pack = _quiet(self._emit)[0]
        dec = os.path.join(self.d, "review.part-1.decisions.json")
        with open(dec, "w", encoding="utf-8") as f:
            f.write("[]")
        os.chmod(dec, 0o664)
        L._decision_files(pathlib.Path(self.pack), pack, [])
        if os.name == "posix":
            self.assertEqual(os.stat(dec).st_mode & 0o777, 0o600)

    def test_a_good_render_removes_the_review_files_and_a_failed_gate_keeps_them(self):
        self._write(self._records())
        _quiet(self._emit)
        dec = os.path.join(self.d, "review.part-1.decisions.json")
        with open(dec, "w", encoding="utf-8") as f:
            json.dump([{"id": "a1", "keep": True}], f)
        self._gate_first()
        rc, err = self._gate_apply(self._verdict(False))
        self.assertEqual(rc, 2)
        self.assertIn("FAIL: quality gate", err)
        self.assertTrue(os.path.exists(self.pack) and os.path.exists(dec), "kept for the retry")
        rc = _quiet(self._apply)[0][0]
        self.assertEqual(rc, 0)
        left = [p for p in os.listdir(self.d) if p.startswith("review")]
        self.assertEqual(left, [], "pack, parts and decisions hold the redacted session")

    def test_a_write_that_fails_leaves_no_temporary_file_and_no_traceback(self):
        target = os.path.join(self.d, "adir")
        os.mkdir(target)
        with self.assertRaises(OSError):
            L._write_private(target, "x")
        self.assertEqual([p for p in os.listdir(self.d) if p.endswith(".tmp")], [])
        self._write(self._records())
        rc, err = _quiet(L.main, ["--session", self.jf, "--emit-review", target])
        self.assertEqual(rc, 2)
        self.assertIn("[lineage] ERROR", err)

    def test_a_summary_holding_a_secret_is_redacted_counted_and_named(self):
        self._write(self._records())
        _quiet(self._emit)
        (rc, text), err = _quiet(self._apply, [{"id": "a1", "keep": True, "summary": "키 AKIA" "IOSFODNN7EXAMPLE 확인"}])
        self.assertEqual(rc, 0)
        self.assertNotIn("AKIA" "IOSFODNN7EXAMPLE", text)
        self.assertIn("reviewer summary for a1 held 1", err)
        self.assertIn("reviewer-summary=1", err)

    def test_reviewer_summaries_are_not_counted_as_cache_hits(self):
        self._write(self._records())
        _quiet(self._emit)
        err = _quiet(self._apply, [{"id": "a1", "keep": True, "summary": "검토자 요약"}])[1]
        self.assertIn("cache_hits=0/0", err, "one bot turn shown, and its summary is the reviewer's")

    def test_meta_turns_are_marked_for_the_reviewer(self):
        meta = dict(_rec("user", "주입된 안내문입니다. 이 지침을 따르세요.", uuid="m1"), isMeta=True)
        self._write([meta, self._asst("확인했습니다.", "a1")])
        _rc, pack = _quiet(self._emit)[0]
        self.assertTrue(pack["turns"][0].get("meta"))
        self.assertTrue(self._part()["turns"][0].get("meta"))

    def test_an_unwritable_cache_folder_does_not_stop_the_run(self):
        blocker = os.path.join(self.d, "file")
        with open(blocker, "w") as f:
            f.write("x")
        L.CACHE_BASE = pathlib.Path(blocker) / "cache"
        self._write(self._records())
        rc, err = _quiet(L.main, ["--session", self.jf, "--output", os.path.join(self.d, "o.html"),
                                  "--skip-reviewer", "--rulebase"])
        self.assertEqual(rc, 0)
        self.assertIn("cache unavailable", err)

    def _verdict(self, ok, samples=None):
        """A critic's answer: one entry per sample of this run (idx 0 before there are any)."""
        if samples is None:
            samples = self._samples()[1] or [{"idx": 0}]
        path = os.path.join(self.d, "verdict.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump([dict({"idx": x["idx"], "recoverable": ok, "reason": "vague"},
                            **{k: x[k] for k in ("id", "key") if k in x}) for x in samples], f)
        return path

    def _gate_apply(self, verdict, name="o.html"):
        return _quiet(L.main, ["--apply-review", self.pack, "--output", os.path.join(self.d, name),
                               "--reviewer-output", verdict, "--reviewer-timeout", "1"])

    def _gate_first(self, name="o.html"):
        """The first gated apply: it writes the samples, and with no critic yet it times out."""
        rc, err = self._gate_apply(os.path.join(self.d, "verdict.json"), name)
        self.assertEqual(rc, 2)
        self.assertIn("not found within 1s", err)

    def _samples(self):
        names = [p for p in os.listdir(self.d) if p.endswith("reviewer-input.json")]
        if not names:
            return None, None
        with open(os.path.join(self.d, names[0]), encoding="utf-8") as f:
            return os.path.join(self.d, names[0]), json.load(f)

    def test_gate_samples_in_the_reviewed_flow_name_their_turn(self):
        long = "도입 문장입니다. " * 300 + "결론: 배포가 통과합니다."
        self._write([_rec("user", "고쳐 주세요", uuid="u1"), self._asst(long, "a1")])
        _quiet(self._emit)
        self._gate_first()
        path, got = self._samples()
        self.assertEqual(got[0]["id"], "a1")
        self.assertTrue(got[0]["original_detail"].endswith("결론: 배포가 통과합니다."), "the tail the reviewer saw")
        if os.name == "posix":
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_the_reviewed_flow_samples_only_for_a_gate_it_enforces(self):
        self._write(self._records())
        _quiet(self._emit)
        rc, err = _quiet(L.main, ["--apply-review", self.pack, "--output", os.path.join(self.d, "o.html")])
        self.assertEqual(rc, 0)
        self.assertEqual(self._samples(), (None, None), "no critic is waiting: nothing is left in work/")
        self.assertNotIn("oh-my-claudecode:critic", err)
        self.assertNotIn("reviewer samples", err)

    def test_a_read_verdict_is_set_aside_so_a_rerun_waits_for_a_fresh_one(self):
        self._write(self._records())
        _quiet(self._emit)
        self._gate_first()
        verdict = self._verdict(False)            # the critic's answer to those samples
        rc, err = self._gate_apply(verdict)
        self.assertEqual(rc, 2)
        self.assertIn("FAIL: quality gate", err)
        self.assertFalse(os.path.exists(verdict))
        self.assertTrue(os.path.exists(verdict + ".used"))
        rc, err = self._gate_apply(verdict)
        self.assertEqual(rc, 2)
        self.assertIn("not found within 1s", err, "the old FAIL is not read again")
        _, first = self._samples()
        self.assertEqual(self._gate_apply(self._verdict(True), "p.html")[0], 0)
        self.assertEqual(self._samples(), (None, None), "a PASS removes the samples")
        self.assertEqual(len(first), 1)
        used = os.path.join(self.d, "verdict.json.used")
        with open(used, encoding="utf-8") as f:
            self.assertTrue(all(v["recoverable"] is True for v in json.load(f)), "the later verdict takes the earlier one's place")
        self.assertFalse(os.path.exists(used + ".1"), "verdicts do not pile up as .used.1, .used.2")

    def test_gate_samples_are_the_same_on_a_rerun(self):
        recs = [_rec("user", "질문 %d" % k, ts="2026-08-09T10:%02d:00Z" % k, uuid="u%d" % k) for k in range(8)]
        recs = [r for k, u in enumerate(recs) for r in (u, self._asst("답변 %d 입니다." % k, "a%d" % k,
                                                                      ts="2026-08-09T10:%02d:01Z" % k))]
        self._write(recs)
        _quiet(self._emit)
        picks = []
        for _ in range(2):
            self._gate_apply(self._verdict(False))
            picks.append([s["id"] for s in self._samples()[1]])
        self.assertEqual(picks[0], picks[1])

    def test_gate_samples_are_redacted_as_the_reviewer_read_them(self):
        ant = "sk-" + "ant-api03-" + "Q" * 30
        self._write([_rec("user", "키 확인", uuid="u1"),
                     self._asst("키는 AKIA" "IOSFODNN7EXAMPLE 와 %s 입니다." % ant, "a1")])
        _quiet(self._emit, ["--redact-mode", "mask"])
        self._gate_apply(self._verdict(False))
        raw = json.dumps(self._samples()[1], ensure_ascii=False)
        for bit in ("sk-ant-", "AKIA****", "MPLE"):
            self.assertNotIn(bit, raw)

    def test_keep_trivia_and_keep_tool_only_outrank_a_reviewers_false(self):
        skill = dict(_rec("user", "Base directory for this skill: /x\n\n# 안내문", uuid="m1"), isMeta=True)
        self._write([skill, self._asst("안내를 읽었습니다.", "a1"),
                     self._asst("", "a2", ts="2026-08-09T10:00:05Z", tools=["Bash"])])
        rc, pack = _quiet(self._emit, ["--keep-trivia", "--keep-tool-only"])[0]
        self.assertTrue(pack["keep_trivia"] and pack["keep_tool_only"])
        self.assertTrue(self._part()["keep_trivia"], "the reviewer is told")
        ids = [x["id"] for x in pack["turns"]]
        (rc, text), err = _quiet(self._apply, [{"id": i, "keep": False} for i in ids])
        self.assertEqual(rc, 0)
        self.assertIn("Base directory for this skill", text)
        self.assertIn("as --keep-trivia or --keep-tool-only asked", err)

    def test_keep_tool_only_alone_keeps_only_tool_only_turns(self):
        self._write([_rec("user", "점검해 주세요", uuid="u1"), self._asst("점검 결과를 정리했습니다.", "a1"),
                     _rec("user", "다음 단계도 해 주세요", ts="2026-08-09T10:00:04Z", uuid="u2"),
                     self._asst("", "a2", ts="2026-08-09T10:00:05Z", tools=["Bash"])])
        _quiet(self._emit, ["--keep-tool-only"])
        rc, text = _quiet(self._apply, [{"id": "a1", "keep": False}, {"id": "a2", "keep": False}])[0]
        self.assertEqual(rc, 0)
        self.assertNotIn("점검 결과를 정리했습니다", text, "the reviewer still drops other turns")
        self.assertIn("Bash×1", text)

    def test_wrapped_decisions_are_read_past_other_brackets(self):
        good = '[{"id": "a1", "keep": true, "summary": "둘러싼 답의 요약"}]'
        for text in ("Note turn a1 had [REDACTED:entropy] values.\n```json\n%s\n```" % good,
                     "%s\n\n### Critical Files\n- [part-1](work/.lineage-review.part-1.json)" % good):
            self.assertEqual(L._decisions_text(text)[0]["summary"], "둘러싼 답의 요약")
        example = 'Format: [{"id": "<turn id>", "keep": null}]\n\n' + good
        self.assertEqual(L._decisions_text(example)[0]["id"], "a1", "the example quoted first loses")
        self.assertEqual(L._decisions_text("All cached, nothing to change:\n```json\n[]\n```"), [])
        with self.assertRaises(ValueError):
            L._decisions_text("no list here [1, 2]")

    def test_a_reviewer_timeout_given_at_apply_beats_the_packs_even_at_its_default(self):
        args = L.build_arg_parser().parse_args(["--reviewer-timeout", "60"])
        L._gate_from_pack(args, {"gate": {"reviewer_timeout": 3}})
        self.assertEqual(args.reviewer_timeout, 60)
        args = L.build_arg_parser().parse_args([])
        L._gate_from_pack(args, {"gate": {"reviewer_timeout": 3}})
        self.assertEqual(args.reviewer_timeout, 3)

    def test_real_looking_keys_are_hidden_whole_from_a_reviewer(self):
        seg, tail = _random_run(11), _random_run(12, 30)
        self.assertGreaterEqual(L.shannon_entropy(seg), 4.5, "a run the entropy rule would cut")
        ant = "sk-" + "ant-api03-" + "Zq2_" + seg + "-" + tail + "AA"
        text = ("키 " + ant + " 와 sk-" + "proj-" + seg
                + " , DB postgres://admin:" + "Hunter22" + "@db.local/app 와 redis://:"
                + "R3disPassw0rd" + "@cache:6379/0 와 Authorization: Bear" + "er " + seg
                + " , 비밀번호: " + "한글비번1234")
        red = L.review_redact(text)[0]
        self.assertFalse([k for k in range(len(ant) - 7) if ant[k:k + 8] in red], red)
        for bit in (seg[:8], seg[-8:], "Hunter22", "R3disPassw0rd", "한글비번1234"):
            self.assertNotIn(bit, red)

    def test_reviewer_patterns_take_linear_time_on_long_runs(self):
        # the reviewer patterns alone: the page's redaction (detect-secrets, when installed)
        # is no part of this claim and takes its own time
        import time
        text = ("a." * 30000 + " " + "key" * 20000 + " " + "a-" * 30000 + " " + "token" * 12000
                + " x://u:" + "a" * 200000 + " " + "-u a" * 30000 + " " + "authorization: basic " * 10000
                + " -u\n" + "=" * 50000 + " --user" + "=" * 50000 + " -u " + "1" * 50000
                + " " + '-u"' * 30000 + " " + '"-u", "' * 20000 + " " + 'authorization", ' * 20000
                + " " + " -abcdefu" * 20000 + " " + 'authorization"]' * 20000)
        start = time.monotonic()
        for _, pat in L.REVIEW_SECRET_PATTERNS:
            pat.sub("[R]", text)
        self.assertLess(time.monotonic() - start, 5)

    def test_a_rule_summary_cut_through_a_secret_leaves_no_half_for_the_reviewer(self):
        token = "gh" + "p_" + "Q8z" * 12          # cut at 58 characters, no pattern matches the half
        lead = "가" * 36 + " " + token + " 입니다"
        self._write([_rec("user", "정리해 주세요", uuid="u1"),
                     self._asst(lead + "\n\n" + "중간 설명입니다. " * 40 + "\n\n끝으로 확인했습니다.", "a1")])
        _quiet(self._emit)
        raw = json.dumps(self._part(), ensure_ascii=False)
        self.assertNotIn("ghp_", raw)
        self.assertNotIn("Q8zQ8z", raw)

    def test_stdin_twins_keep_their_ids_when_the_range_changes(self):
        recs = []
        for k in range(3):
            recs += [_rec("user", "같은 질문입니다", ts="2026-08-09T10:0%d:00Z" % k),
                     self._asst("답변 %d 입니다." % k, "x%d" % k, ts="2026-08-09T10:0%d:01Z" % k)]
        feed = "".join(json.dumps(r) + "\n" for r in recs)

        def ids(extra):
            old = sys.stdin
            sys.stdin = io.StringIO(feed)
            try:
                _quiet(L.main, ["--from-transcript", "-", "--emit-review", self.pack] + extra)
            finally:
                sys.stdin = old
            with open(self.pack, encoding="utf-8") as f:
                return [x["id"] for x in json.load(f)["turns"] if x["role"] == "user"]
        every = ids([])
        self.assertEqual(ids(["--last", "2"]), every[-1:], "the last twin keeps #3")

    def test_a_crafted_turn_id_cannot_place_a_cache_file_outside_the_cache(self):
        out_dir = os.path.join(self.d, "escape")
        os.mkdir(out_dir)
        evil = "../" * 12 + out_dir.lstrip("/") + "/evil"
        self._write([_rec("user", "질문", uuid="u1"), self._asst("답변을 정리했습니다.", evil)])
        _quiet(L.main, ["--session", self.jf, "--output", os.path.join(self.d, "o.html"),
                        "--skip-reviewer", "--rulebase"])
        self.assertEqual(os.listdir(out_dir), [])

    def test_a_cache_that_cannot_keep_decisions_says_so_once(self):
        for k in ("_no_llm_cache", "_no_llm_cache_write"):
            setattr(L._warn_once, k, False)
        self._write(self._records())
        _quiet(self._emit)
        blocker = os.path.join(self.d, "file")
        with open(blocker, "w") as f:
            f.write("x")
        L.CACHE_BASE = pathlib.Path(blocker) / "cache"
        (rc, _), err = _quiet(self._apply, [{"id": "a1", "keep": True, "summary": "요약"}])
        self.assertEqual(rc, 0)
        self.assertEqual(err.count("reviewer decisions not cached"), 1)
        self.assertIn("decisions cached before still apply", err)

    def test_tool_names_and_cached_summaries_in_a_part_are_redacted_for_the_reviewer(self):
        self._write([_rec("user", "점검", uuid="u1"),
                     self._asst("점검했습니다.", "a1", tools=["mcp__projectx_db__query"])])
        _quiet(self._emit, ["--redact-extra", "projectx", "--redact-mode", "mask"])
        _quiet(self._apply, [{"id": "a1", "keep": True, "summary": "키 AKIA" "IOSFODNN7EXAMPLE 확인"}],
               ["--redact-extra", "projectx"])
        _quiet(self._emit, ["--redact-extra", "projectx", "--redact-mode", "mask"])
        raw = json.dumps(self._part(), ensure_ascii=False)
        self.assertNotIn("projectx", raw.lower())
        self.assertNotIn("AKIA****", raw)

    def test_a_cached_reviewer_summary_leaves_no_part_of_a_key_for_the_next_reviewer(self):
        seg = _random_run(21)
        ant = "sk-" + "ant-api03-" + seg + "-" + _random_run(22, 20) + "AA"
        self._write([_rec("user", "점검", uuid="u1"), self._asst("점검했습니다.", "a1")])
        _quiet(self._emit, ["--redact-mode", "mask"])
        _quiet(self._apply, [{"id": "a1", "keep": True,
                              "summary": "키 AKIA" "IOSFODNN7EXAMPLE 와 " + ant + " 확인"}])
        _quiet(self._emit, ["--redact-mode", "mask"])
        raw = json.dumps(self._part(), ensure_ascii=False)
        for bit in ("AKIA****", "MPLE", "sk-ant-", seg[:8], seg[-8:]):
            self.assertNotIn(bit, raw)

    def test_a_decision_made_under_a_keep_flag_is_not_reused_without_it(self):
        self._write(self._records())
        _rc, pack = _quiet(self._emit, ["--keep-trivia"])[0]
        # as the guideline says for keep_trivia: every keep is null
        _quiet(self._apply, [{"id": x["id"], "keep": None, "summary": None} for x in pack["turns"]])
        (_rc, pack), err = _quiet(self._emit)
        self.assertEqual([x["id"] for x in pack["turns"] if x["llm"].get("cached")], [])
        self.assertNotIn("(to review: 0)", err)

    def test_a_decision_is_not_reused_when_the_rules_call_the_turn_differently(self):
        a = os.path.join(self.d, "aaaa1111.jsonl")
        b = os.path.join(self.d, "bbbb2222.jsonl")
        for path, recs in ((a, [_rec("user", "prod 에 배포해", ts="2026-08-09T10:00:00Z", uuid="ua"),
                                self._asst("네", "aa", ts="2026-08-09T10:00:30Z")]),
                           (b, [_rec("user", "다른 세션의 질문입니다", ts="2026-08-09T10:00:10Z", uuid="ub"),
                                self._asst("다른 세션의 답변입니다.", "ab", ts="2026-08-09T10:00:15Z")])):
            with open(path, "w", encoding="utf-8") as f:
                f.writelines(json.dumps(r) + "\n" for r in recs)
        saved = L.project_jsonl_files
        L.project_jsonl_files = lambda: [pathlib.Path(a), pathlib.Path(b)]
        try:
            _quiet(L.main, ["--all-sessions", "--emit-review", self.pack])
        finally:
            L.project_jsonl_files = saved

        def ua():
            with open(self.pack, encoding="utf-8") as f:
                return [x for x in json.load(f)["turns"] if x["id"] == "ua"][0]
        self.assertTrue(ua()["rule"]["keep"], "another session's turn sits between: no echo")
        _quiet(self._apply, [{"id": "ua", "keep": None, "summary": None}])
        _quiet(L.main, ["--session", a, "--emit-review", self.pack])
        self.assertEqual(ua()["rule"]["why"], "echo")
        self.assertFalse(ua()["llm"].get("cached"), "that null deferred to a rule that kept the turn")

    def test_keep_trivia_alone_counts_only_the_turns_it_keeps(self):
        self._write([_rec("user", "점검해 주세요", uuid="u1"), self._asst("점검 결과를 정리했습니다.", "a1"),
                     _rec("user", "다음 단계도 해 주세요", ts="2026-08-09T10:00:04Z", uuid="u2"),
                     self._asst("", "a2", ts="2026-08-09T10:00:05Z", tools=["Bash"])])
        _quiet(self._emit, ["--keep-trivia"])
        (rc, text), err = _quiet(self._apply, [{"id": i, "keep": False} for i in ("u1", "a1", "u2", "a2")])
        self.assertEqual(rc, 0)
        self.assertNotIn("Bash×1", text, "a tool-only turn stays only with --keep-tool-only")
        self.assertIn("note: 3 turn(s)", err)

    def test_gate_samples_take_the_rule_summary_cut_from_redacted_text(self):
        token = "gh" + "p_" + "Q8z" * 12          # cut at 58 characters, no pattern matches the half
        cred = "postgres://admin:" + "Hunter22secretpw" + "@db.local/app"
        body = "\n\n" + "중간 설명입니다. " * 40 + "\n\n끝으로 확인했습니다."
        self._write([_rec("user", "정리해 주세요", uuid="u1"),
                     self._asst("가" * 36 + " " + token + " 입니다" + body, "a1"),
                     _rec("user", "하나 더 정리해 주세요", ts="2026-08-09T10:01:00Z", uuid="u2"),
                     self._asst("가" * 30 + " " + cred + " 입니다" + body, "a2", ts="2026-08-09T10:01:01Z")])
        _quiet(self._emit)
        self._gate_first()
        raw = json.dumps(self._samples()[1], ensure_ascii=False)
        for bit in ("ghp_", "Q8zQ8z", "Hunter22"):
            self.assertNotIn(bit, raw)

    def test_a_verdict_from_before_the_samples_is_not_read(self):
        self._write(self._records())
        _quiet(self._emit)
        verdict = self._verdict(True)             # left by a --rulebase gate, say
        rc, err = self._gate_apply(verdict)
        self.assertEqual(rc, 2)
        self.assertIn("predates these samples", err)
        self.assertIn("not found within 1s", err)
        self.assertTrue(os.path.exists(verdict + ".used"))

    def test_a_verdict_written_after_a_timeout_is_read_by_the_rerun(self):
        self._write(self._records())
        _quiet(self._emit)
        self._gate_first()
        rc, err = self._gate_apply(self._verdict(True), "p.html")
        self.assertEqual(rc, 0, err)
        self.assertNotIn("predates", err)

    def test_a_folder_or_a_non_verdict_at_the_verdict_path_stays_in_place(self):
        self._write(self._records())
        _quiet(self._emit)
        folder = os.path.join(self.d, "notes")
        os.mkdir(folder)
        other = os.path.join(self.d, "package.json")
        with open(other, "w", encoding="utf-8") as f:
            f.write('{"name": "x"}')
        data = os.path.join(self.d, "data.json")
        with open(data, "w", encoding="utf-8") as f:
            f.write("[1, 2, 3]")                  # a list, but no verdict
        for order in ((folder, other, data), (data, other, folder)):
            for path in order:
                samples = self._samples()[0]
                if samples:
                    os.remove(samples)            # new samples each time: the path that moves files
                rc, err = self._gate_apply(path)
                self.assertEqual(rc, 2)
                self.assertTrue(os.path.exists(path) and not os.path.exists(path + ".used"), path)
                self.assertIn("is not a verdict list", err)
                self.assertNotIn("reviewer samples", err, "nothing for a critic before the path is fixed")
                self.assertNotIn("next:", err, "and no instruction to write over that path")
        with open(other, encoding="utf-8") as f:
            self.assertEqual(f.read(), '{"name": "x"}')
        with open(data, encoding="utf-8") as f:
            self.assertEqual(f.read(), "[1, 2, 3]")

    def test_a_refused_verdict_path_leaves_the_file_whole_through_a_pass_on_another(self):
        self._write(self._records())
        _quiet(self._emit)
        other = os.path.join(self.d, "package.json")
        with open(other, "w", encoding="utf-8") as f:
            f.write('{"name": "x"}')
        self.assertEqual(self._gate_apply(other)[0], 2)
        self._gate_first()                        # another path: samples, then no verdict yet
        self.assertEqual(self._gate_apply(self._verdict(True), "p.html")[0], 0)
        with open(other, encoding="utf-8") as f:
            self.assertEqual(f.read(), '{"name": "x"}')

    def test_the_reviewed_flow_stops_when_it_cannot_write_its_samples(self):
        self._write(self._records())
        _quiet(self._emit)
        os.mkdir(os.path.join(self.d, "review.reviewer-input.json"))
        rc, err = self._gate_apply(os.path.join(self.d, "verdict.json"))
        self.assertEqual(rc, 2)
        self.assertIn("cannot write the gate samples", err)
        self.assertNotIn("not found within", err, "no wait for a verdict nobody can give")

    def test_a_read_verdict_never_replaces_a_used_file_that_is_not_one(self):
        self._write(self._records())
        _quiet(self._emit)
        self._gate_first()
        kept = os.path.join(self.d, "verdict.json.used")
        with open(kept, "w", encoding="utf-8") as f:
            f.write("older user file")
        rc, err = self._gate_apply(self._verdict(True), "p.html")
        self.assertEqual(rc, 0, err)
        with open(kept, encoding="utf-8") as f:
            self.assertEqual(f.read(), "older user file")
        self.assertTrue(os.path.exists(kept + ".1"), "the verdict went to the first free name")

    def test_a_used_list_with_one_verdict_like_entry_among_other_data_is_kept(self):
        # a verdict to read only needs one entry with an idx; one to write over must be all verdict
        self._write(self._records())
        _quiet(self._emit)
        self._gate_first()
        kept = os.path.join(self.d, "verdict.json.used")
        mine = json.dumps([{"idx": 7, "note": "mine"}, "keep me"])
        with open(kept, "w", encoding="utf-8") as f:
            f.write(mine)
        rc, err = self._gate_apply(self._verdict(True), "p.html")
        self.assertEqual(rc, 0, err)
        with open(kept, encoding="utf-8") as f:
            self.assertEqual(f.read(), mine)
        self.assertTrue(os.path.exists(kept + ".1"), "the verdict went to the first free name")

    def test_a_verdict_must_answer_each_sample_of_this_run(self):
        recs = []
        for k in range(3):
            recs += [_rec("user", "%d번 작업을 해 주세요" % k, ts="2026-08-09T10:0%d:00Z" % k, uuid="u%d" % k),
                     self._asst("%d번 작업을 마쳤고 검사가 통과합니다." % k, "a%d" % k, ts="2026-08-09T10:0%d:01Z" % k)]
        self._write(recs)
        _quiet(self._emit)
        self._gate_first()
        _, samples = self._samples()
        self.assertGreater(len(samples), 1, "the case needs two samples or more")
        rc, err = self._gate_apply(self._verdict(True, samples[:1]))
        self.assertEqual(rc, 2)
        self.assertIn("does not answer", err)
        self.assertNotIn("PASS: quality gate", err)
        for bad in ([dict(x, id="another-turn") if x["idx"] == 0 else x for x in samples],
                    [dict(x, key="000000000000") if x["idx"] == 0 else x for x in samples],
                    samples + samples[:1], samples + [dict(samples[0], idx=99)],
                    [{"idx": x["idx"], "id": x["id"]} for x in samples]):
            rc, err = self._gate_apply(self._verdict(True, bad))
            self.assertEqual(rc, 2, "another turn, another content, a repeat, an unknown idx or no key")
            self.assertIn("does not answer", err)
        rc, err = self._gate_apply(self._verdict(False, samples[:1]))
        self.assertEqual(rc, 2, "a verdict that names only the samples it fails")
        self.assertIn("not recoverable in it: idx=0: vague", err, "its reasons show beside the coverage error")
        self.assertEqual(self._gate_apply(self._verdict(True), "p.html")[0], 0)

    def test_a_verdict_on_the_samples_before_a_fix_does_not_pass(self):
        recs = []
        for k in range(3):
            recs += [_rec("user", "%d번 작업을 해 주세요" % k, ts="2026-08-09T10:0%d:00Z" % k, uuid="u%d" % k),
                     self._asst("%d번 작업을 마쳤고 검사가 통과합니다." % k, "a%d" % k, ts="2026-08-09T10:0%d:01Z" % k)]
        self._write(recs)
        _quiet(self._emit)
        self._gate_first()
        _, before = self._samples()
        dec = os.path.join(self.d, "review.part-1.decisions.json")
        with open(dec, "w", encoding="utf-8") as f:
            json.dump([{"id": "a0", "keep": True, "summary": "고친 요약"}], f, ensure_ascii=False)
        self._gate_first()                        # the fix changes a sample's content, not its turn
        _, after = self._samples()
        self.assertEqual([x["id"] for x in before], [x["id"] for x in after])
        self.assertNotEqual([x["key"] for x in before], [x["key"] for x in after])
        rc, err = self._gate_apply(self._verdict(True, before))
        self.assertEqual(rc, 2)
        self.assertIn("does not answer", err)

    def test_each_reviewer_pattern_hides_a_shape_it_names(self):
        # names and values assembled at run time, so a secret scanner reading this file sees no pair
        cases = dict([
            ("AnthropicKey", "sk-" + "ant-" + "abcd" * 6),
            ("OpenAIKey", "sk-" + "proj-" + "abcd" * 6),
            ("GoogleKey", "AI" + "za" + "abcde" * 7),
            ("HexKey", "deploy_key_" + "x" * 60 + "=" + "0123456789abcdef" * 3),
            ("Pass" + "wordBare", "pw" + "d=" + "abc123xyz"),
            ("Url" + "Cred" + "ential", "mongodb+srv://" + "app:" + "p@ss" + "word1@db.example.com/x"),
            ("Bearer", "Authorization: Bear" + "er " + "abcd" * 5),
            ("BasicAuth", "Authorization: Bas" + "ic " + "YWRtaW46" + "SHVudGVyMjI="),
            ("CurlUser", "curl -u admin:" + "Hunter22pw https://x"),
        ])
        self.assertEqual(sorted(cases), sorted(n for n, _ in L.REVIEW_SECRET_PATTERNS))
        for name, text in cases.items():
            red = L.review_redact(text)[0]
            self.assertIn("[REDACTED:%s]" % name, red, text)
        for bit in ("abcdabcd", "0123456789abcdef", "abc123xyz", "p@ss", "YWRtaW46", "Hunter22"):
            self.assertNotIn(bit, L.review_redact(" ".join(cases.values()))[0])
        basic = "Bas" + "ic YWRtaW46SHVudGVyMjI="
        for shape in ("curl -uadmin:" + "Hunter22pw https://x", "curl --user=admin:" + "pw123456 x",
                      "com.example.platform.internal.svc.jdbc+postgresql://admin:" + "Hunter22pw@db/app",
                      'headers = {"Authorization": "' + basic + '"}',
                      "fetch(u, {headers: {Authorization: '" + basic + "'}})",
                      'headers["Authorization"] = "' + basic + '"', "headers['Authorization'] = '" + basic + "'",
                      'xhr.setRequestHeader("Authorization", "' + basic + '")',
                      '{"name": "Authorization", "value": "' + basic + '"}', '"Authorization" => "' + basic + '"',
                      'proxy_set_header Authorization "' + basic + '";',
                      "curl -su admin:" + "Hunter22pw https://x", "curl -vu admin:" + "Hunter22pw https://x",
                      '["curl", "-u", "admin:' + 'Hunter22pw", url]', "subprocess.run(['curl', '--user=admin:" + "Hunter22pw', url])",
                      "curl -u :" + "Hunter22pw https://x", "curl -u 1000:1000:" + "Hunter22pw https://x"):
            self.assertNotIn("Hunter22", L.review_redact(shape)[0], shape)
            self.assertNotIn("YWRtaW46", L.review_redact(shape)[0], shape)
        stripe = "curl https://api.example.com/v1/charges -u sk" + "_test_" + "Q8z" * 8 + ": -d amount=1"
        self.assertNotIn("Q8zQ8z", L.review_redact(stripe)[0], "a key given as the user, the password left empty")
        for keep in ("see the basic configuration guide", "sort -u a.txt", "git log -u",
                     "docker run -u 1000:1000 app", "rsync -u host:/srv/app .", "`docker run -u 1000:1000`",
                     "date -u +%H:%M:%S", 'date -u "+%H:%M:%S"', "docker run -u $(id -u):$(id -g) img",
                     'docker run -u "1000:1000" img', 'mktemp -u "${TMPDIR:-/tmp}/x"', "docker run -u ${UID}:${GID} img",
                     "sudo -u postgres psql", "ping6 -u ::1", "rsync -avu host:/srv/app .", "link -out:Program.exe a.obj",
                     "Authorization, Basic authentication and tokens are covered below"):
            self.assertEqual(L.review_redact(keep)[0], keep)

    def test_curl_user_hides_quoted_templated_and_odd_users(self):
        # 3.0.0 hid each of these; a user may be a template, quoted apart from the password,
        # start with + or %, or sit in inline code or parentheses
        pw = "Hunter22" + "pw"
        c = "cu" + "rl"                         # assembled, so a secret scanner reading this file sees no command
        key = "sk" + "_test_" + "Q8z" * 8
        for shape in (c + ' -u "${API_USER}:' + pw + '" https://x', c + " -u ${API_USER}:" + pw + " https://x",
                      c + " -u %API_USER%:" + pw + " https://x", c + " -u %40admin:" + pw + " https://x",
                      c + " -u {svc}:" + pw + " https://x", c + " -u '{user}:" + pw + "' https://x",
                      c + " -u +bot:" + pw + " https://x", c + " -u +15551234567:" + pw + " https://x",
                      c + ' -u "admin":"' + pw + '" https://x', c + " -u 'admin':'" + pw + "' https://x",
                      c + ' --user "admin":"' + pw + '" https://x', c + " --user='admin':'" + pw + "' https://x",
                      c + ' -u "admin:' + pw + '" https://x', c + " -u '':" + pw + " https://x",
                      c + " -4u admin:" + pw + " https://x", c + " -u 1000:1000-" + pw + " https://x",
                      c + " -u $(whoami):" + pw + " https://x", c + " -u `whoami`:" + pw + " https://x",
                      c + " -u $(id -u):" + pw + " https://x", c + " -u o'brien:" + pw + " https://x",
                      "pass `-u admin:" + pw + "` to it", "(-u admin:" + pw + ")",
                      c + ' -u "${USER}:${PASS:-' + pw + '}" https://x', c + ' -u "${CREDS:-admin:' + pw + '}" https://x',
                      c + ' -u "${USER:-admin}:' + pw + '" https://x',
                      '["' + c + '", "-u", "${API_USER}:' + pw + '", url]', '["' + c + '", "-4u", "admin:' + pw + '", url]'):
            self.assertNotIn("Hunter22", L.review_redact(shape)[0], shape)
        for shape in (c + " -u '" + key + ":' https://x", "use `-u " + key + ":` here", c + ' -u "${API_KEY:-' + key + '}" https://x'):
            self.assertNotIn("Q8zQ8z", L.review_redact(shape)[0], shape)

    def test_curl_user_hides_escaped_and_doubled_quotes(self):
        # 3.0.0 hid these: a command inside a quoted string (ssh, compose, package.json), ANSI-C,
        # cmd and PowerShell quoting, and quotes that change between the user and the password
        pw = "Hunter22" + "pw"
        c = "cu" + "rl"
        q = '"'
        bs = chr(92)
        for shape in ("ssh host " + q + c + " -u " + bs + q + "admin:" + pw + bs + q + " http://localhost:9200" + q,
                      '["CMD-SHELL", "' + c + ' -s -u ' + bs + q + "elastic:" + pw + bs + q + ' http://localhost:9200"]',
                      '{"scripts": {"x": "' + c + ' -u ' + bs + q + "admin:" + pw + bs + q + ' https://x"}}',
                      c + " -u " + bs * 3 + q + "admin:" + pw + bs * 3 + q + " https://x",
                      c + " -u $'admin:" + pw + "' https://x", c + " -u ^" + q + "admin:" + pw + "^" + q + " https://x",
                      c + ".exe -u `" + q + "admin:" + pw + "`" + q + " https://x",
                      c + ' -u "$USER"' + "':" + pw + "' https://x", c + " -u 'admin'" + '":' + pw + '" https://x',
                      c + " -u +%40admin:" + pw + " https://x",
                      # bash's '\'' inside single quotes (set -x prints it), Python's shlex.quote, a user
                      # joined to a variable, JSON wrapped three times, CSV and YAML doubled quotes
                      "bash -c '" + c + " -s -u '" + bs + "''admin:" + pw + "'" + bs + "'' https://x'",
                      "sh -c '" + c + " -s -u '" + q + "'" + q + "'admin:" + pw + "'" + q + "'" + q + "' https://x'",
                      c + ' -s -u "$USER"@corp.com:' + pw + " https://x",
                      c + " -u " + bs * 7 + q + "admin:" + pw + bs * 7 + q + " https://x",
                      c + " -u 'admin'" + '"":' + pw + '"" https://x', c + ' -u "admin"' + "'':" + pw + "'' https://x"):
            self.assertNotIn("Hunter22", L.review_redact(shape)[0], shape)

    def test_curl_user_hides_users_joined_to_a_reference_by_a_dash(self):
        # 3.0.0 hid these: a user that joins a variable, a command substitution or a quoted part
        # with a -, and a user that starts with a - after quotes, alone or in JSON and bash -c
        import shlex
        pw = "Hunter22" + "pw"
        c = "cu" + "rl"
        for cmd in (c + ' -u "${ENV}"-deployer:' + pw + " https://x", c + ' -u "$USER"-bot:' + pw + " https://x",
                    c + ' -u "$(whoami)"-ci:' + pw + " https://x", c + " -u `hostname`-agent:" + pw + " https://x",
                    c + " -u '$USER'-bot:" + pw + " https://x", c + " -u '-admin:" + pw + "' https://x",
                    c + " -u" + chr(9) + '"-admin:' + pw + '" https://x'):
            for shape in (cmd, json.dumps(cmd), "bash -c " + shlex.quote(cmd),
                          "sh -c " + shlex.quote("bash -c " + shlex.quote(cmd))):
                self.assertNotIn("Hunter22", L.review_redact(shape)[0], shape)

    def test_curl_user_keeps_ids_references_and_dates(self):
        for keep in ("docker run -u $UID:$GID img", 'docker run -u "$USER:$PASS" img', "set -u %USER%:%PASS% x",
                     'docker run -u "${UID}:${GID}" img', "docker run -u $(id -un):$(id -gn) img",
                     "(docker run -u 1000:1000)", "use `-u 1000:1000` here", '["docker", "run", "-u", "1000:1000", "img"]',
                     'subprocess.run(["date", "-u", "+%H:%M:%S"])', "date -u '+%Y-%m-%dT%H:%M:%SZ'",
                     'mktemp -u "${TMPDIR:-/tmp}/x.XXXX")', 'ssh host "docker run -u ' + chr(92) + '"1000:1000' + chr(92) + '" img"',
                     'ssh host "docker run -u ' + chr(92) + '"$UID:$GID' + chr(92) + '" img"', "date -u +%-H:%M:%S",
                     'cmd /c "docker run -u ^"1000:1000^" img"', "bash -c 'docker run -u '" + chr(92) + "''1000:1000'" + chr(92) + "'' img'",
                     "bash -c 'docker run -u $(id -u):$(id -g) img'", 'date -u +"%H:%M:%S"'):
            self.assertEqual(L.review_redact(keep)[0], keep)

    def test_curl_user_takes_linear_time_on_runs_of_its_pieces(self):
        import time
        pat = dict(L.REVIEW_SECRET_PATTERNS)["CurlUser"]
        bs = chr(92)
        pieces = ("(-u", "`-u", "'-u", "(-u(", "`-u`", "-u${a:(", " -u ${a:", " -u $(", "'-uo'b", " -4u ",
                  " -u):$(", "(-u$(a", "'-u", '"-u", "', " -u %a%:", " -u 1:1", "(-u a`",
                  " -u " + bs + '"', '"-u' + bs + '"', " -u ^" + '"', " -u $'", " -u " + bs * 3 + "'", '"-u""', " -u a" + bs + '"',
                  " -ua$" + '"', "'-u'" + bs + "''", " -u '" + '"' + "'" + '"', '"-u"a', " -u " + bs * 8 + '"', "`-u`a",
                  '"-a', ' -u "-a', '"-a"-u', "(-xu ", '"--user"',
                  '"-xu","a', '"--user","a', "'-xu','a", "'--user','a", '"-u","', '","-u',
                  bs + '"-u' + bs + '",' + bs + '"')
        for piece in pieces:
            start = time.monotonic()
            pat.sub("[R]", piece * 40000)
            self.assertLess(time.monotonic() - start, 2, repr(piece))

    def test_a_quote_of_the_parts_turns_is_not_read_as_decisions(self):
        answer = [{"id": "a%d" % k, "keep": True, "summary": "요약 %d" % k} for k in range(2)]
        quote = [{"id": "a%d" % k, "n": k, "role": "assistant", "preview": "본문",
                  "rule": {"keep": True}, "llm": {"keep": None, "summary": None}} for k in range(4)]
        text = json.dumps(answer, ensure_ascii=False) + "\n\nTurns I reviewed:\n" + json.dumps(quote)
        self.assertEqual(L._decisions_text(text), answer)
        path = os.path.join(self.d, "quote.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(quote, f)
        got, err = _quiet(L._load_decisions, [pathlib.Path(path)])
        self.assertIsNone(got)
        self.assertIn("a turn of the part file", err)

    def test_answers_with_extra_keys_are_read_as_decisions(self):
        self._write(self._records())
        _quiet(self._emit)
        for extra in ({"n": 1}, {"role": "assistant"}, {"meta": True}):
            _quiet(self._emit)                    # a rendered pack is removed: one per apply
            (rc, text), err = _quiet(self._apply, [dict({"id": "a1", "keep": True, "summary": "덧붙인 키가 있는 답"}, **extra)])
            self.assertEqual(rc, 0, err)
            self.assertIn("덧붙인 키가 있는 답", text)

    def test_a_deeply_nested_answer_is_a_broken_decisions_file(self):
        self._write(self._records())
        _quiet(self._emit)
        import time
        dec = os.path.join(self.d, "review.part-1.decisions.json")
        with open(dec, "w", encoding="utf-8") as f:
            f.write("Here is my answer: " + "[" * 100000)
        start = time.monotonic()
        rc, err = _quiet(L.main, ["--apply-review", self.pack, "--output", os.path.join(self.d, "o.html"), "--skip-reviewer"])
        self.assertEqual(rc, 2)
        self.assertIn("cannot read decisions", err)
        self.assertLess(time.monotonic() - start, 5, "a run of brackets is tried once, not at each one")
        # deep enough that no Python's json parses it whole (3.12 reads 1,200 levels, 3.11 does not)
        self.assertEqual(L._decisions_text("[" * 100000 + "]" * 100000), [], "nested empty lists hold an empty one")

    def test_the_page_name_is_fixed_when_the_pack_is_written(self):
        self._write(self._records())
        rc, pack = _quiet(L.main, ["--session", self.jf, "--emit-review", self.pack])[0], None
        with open(self.pack, encoding="utf-8") as f:
            pack = json.load(f)
        self.assertRegex(pack["output"], r"_\d{6}\+\d{4}\.html$", "reruns of the gate write one page")

    def test_a_decisions_file_of_nulls_is_read_with_a_warn(self):
        self._write(self._records())
        _quiet(self._emit)
        (rc, _), err = _quiet(self._apply, [{"id": "a1", "keep": None, "summary": None}])
        self.assertEqual(rc, 0)
        self.assertIn("decisions are null", err)

    def test_a_summary_cached_unredacted_is_hidden_when_a_part_is_written(self):
        self._write([_rec("user", "점검", uuid="u1"), self._asst("점검했습니다.", "a1")])
        _quiet(self._emit)
        clean = L._clean_summary
        L._clean_summary = lambda s, extra, mode: (s, 0)     # a cache an older lineage wrote
        try:
            _quiet(self._apply, [{"id": "a1", "keep": True, "summary": "키 AKIA" "IOSFODNN7EXAMPLE 확인"}])
        finally:
            L._clean_summary = clean
        _quiet(self._emit)
        raw = json.dumps(self._part(), ensure_ascii=False)
        self.assertIn('"cached": true', raw)
        self.assertNotIn("IOSFODNN7", raw)


# ============================================================ 2.x output, pinned
def _g_rec(role, text, ts, uuid):
    return {"type": role, "uuid": uuid, "timestamp": ts, "message": {"role": role, "content": text}}


def _g_asst(text, uuid, ts, tools=()):
    content = [{"type": "text", "text": text}] if text else []
    content += [{"type": "tool_use", "name": n, "input": {}} for n in tools]
    return {"type": "assistant", "uuid": uuid, "timestamp": ts,
            "message": {"role": "assistant", "content": content}}


_GOLDEN_MD = ("먼저 스크립트를 읽겠습니다.\n\n## 결과\n\n- 첫째 수정\n- 둘째 수정\n\n| 항목 | 값 |\n|---|---|\n"
              "| 통과 | 12 |\n\n```bash\nnode scripts/smoke-test.js\n```\n\n**고친 결과** 배포가 끝까지 통과합니다. "
              "키는 AKIA" "IOSFODNN7EXAMPLE 입니다.")
_GOLDEN_RECORDS = [
    _g_rec("user", "배포 스크립트를 고쳐 주세요", "2026-08-09T10:00:00Z", "g1"),
    _g_asst(_GOLDEN_MD, "g2", "2026-08-09T10:00:05Z", ["Read", "Edit"]),
    _g_rec("user", "ok", "2026-08-09T10:01:00Z", "g3"),
    _g_asst("ok", "g4", "2026-08-09T10:01:01Z"),
    _g_rec("user", "배경 설명입니다. " * 60 + "요청: 롤백도 넣어 주세요.", "2026-08-09T10:02:00Z", "g5"),
    _g_asst("", "g6", "2026-08-09T10:02:01Z", ["Bash"]),
    _g_asst("롤백 단계를 넣었고 테스트가 통과합니다.", "g7", "2026-08-09T10:02:30Z"),
    _g_rec("user", "/copy", "2026-08-09T10:03:00Z", "g8"),
]
# sha256 of the HTML lineage 2.0.0 (the last release before the reviewed flow) wrote for
# _GOLDEN_RECORDS, per flag set. A change here means --rulebase no longer behaves as 2.x;
# update a value only when that is the intent.
_GOLDEN_2X = {
    (): "6c49e1dac908dd5d8ddf969fa2817d8596704126d559037c8ac0a0bf44fb38d1",  # pragma: allowlist secret
    ("--open", "--no-markdown"): "5388c8c294e1ff748f37529c6f23caf47311a8892cff4cc8b7724bee07d6161a",  # pragma: allowlist secret
    ("--keep-trivia", "--keep-tool-only"): "b58abd7b02102c263fccf0c353f21fa2e0763870681ed65a035bda2c9a00b17e",  # pragma: allowlist secret
    ("--redact-mode", "mask"): "2abc87b671c96b5c0610649c94599dd3a8857393b31f5e0422f15ae57038b28a",  # pragma: allowlist secret
}


class TestLlmReviewGateReruns(_ReviewCase):
    """The gate's second run, the paths it carries over, and answers that are not what they
    should be. The gate helpers are TestLlmReviewHardening's, borrowed rather than inherited
    so its tests do not run twice."""

    _verdict = TestLlmReviewHardening._verdict
    _gate_apply = TestLlmReviewHardening._gate_apply
    _gate_first = TestLlmReviewHardening._gate_first
    _samples = TestLlmReviewHardening._samples

    def test_a_written_list_with_no_idx_sends_the_session_back_to_the_critic(self):
        # step 8: a critic answer with no verdict entry, written as it came; writing that list
        # again fails the same way, so the session is told to have the samples judged again
        self._write(self._records())
        _quiet(self._emit)
        self._gate_first()
        path = os.path.join(self.d, "verdict.json")
        for body in ("[]", '[{"recoverable": true}]'):
            with open(path, "w", encoding="utf-8") as f:
                f.write(body)
            rc, err = self._gate_apply(path)
            self.assertEqual(rc, 2)
            self.assertIn("no entry names idx", err)
            self.assertIn("judge the samples again", err)
            self.assertNotIn("write it again as a bare JSON array", err)
        with open(path, "w", encoding="utf-8") as f:
            f.write("Here is my verdict: [")
        rc, err = self._gate_apply(path)
        self.assertEqual(rc, 2)
        self.assertIn("write it again as a bare JSON array", err, "step 7: a broken file is written again")

    def test_an_output_given_at_apply_keeps_the_packs_stamp(self):
        # a critic takes minutes: the gate's two runs fall in different minutes, and an --output
        # given at apply would take each run's own stamp, leaving the page from before the gate
        self._write(self._records())
        _quiet(self._emit)
        with open(self.pack, encoding="utf-8") as f:
            pack = json.load(f)
        pack["output"] = os.path.join(self.d, "page_260101+0000.html")
        with open(self.pack, "w", encoding="utf-8") as f:
            json.dump(pack, f, ensure_ascii=False)
        self._gate_first("mine.html")
        self.assertEqual(self._gate_apply(self._verdict(True), "mine.html")[0], 0)
        self.assertEqual(sorted(p for p in os.listdir(self.d) if p.endswith(".html")), ["mine_260101+0000.html"])

    def test_a_rerun_without_the_gate_path_does_not_pass_over_its_samples(self):
        self._write(self._records())
        _quiet(self._emit)                        # step 1 gave no --reviewer-output
        self._gate_first()                        # step 4 did: its samples wait beside the pack
        verdict = self._verdict(False)
        out = os.path.join(self.d, "o.html")
        rc, err = _quiet(L.main, ["--apply-review", self.pack, "--output", out])
        self.assertEqual(rc, 2, "the FAIL verdict is not passed over in silence")
        self.assertIn("left by a gated run", err)
        self.assertTrue(os.path.exists(verdict))
        self.assertEqual(_quiet(L.main, ["--apply-review", self.pack, "--output", out, "--skip-reviewer"])[0], 0)

    def test_a_new_pack_removes_an_earlier_gates_samples(self):
        self._write(self._records())
        _quiet(self._emit)
        self._gate_first()
        self.assertIsNotNone(self._samples()[0])
        _quiet(self._emit)
        self.assertEqual(self._samples(), (None, None))

    def test_a_non_verdict_reviewer_output_is_refused_at_emit(self):
        self._write(self._records())
        user_file = os.path.join(self.d, "package.json")
        body = '{"name": "app", "version": "1.0.0"}\n'
        with open(user_file, "w", encoding="utf-8") as f:
            f.write(body)
        rc, err = _quiet(L.main, ["--session", self.jf, "--emit-review", self.pack, "--reviewer-output", user_file])
        self.assertEqual(rc, 2, "stopped before any reviewer runs")
        self.assertIn("is not a verdict list", err)
        self.assertNotIn("write it again", err, "nothing leads the session to write over the user's file")
        self.assertEqual([p for p in os.listdir(self.d) if p.startswith("review")], [])
        with open(user_file, encoding="utf-8") as f:
            self.assertEqual(f.read(), body)

    def test_the_reviewed_flow_does_not_wait_unless_asked(self):
        import time
        self._write(self._records())
        verdict = os.path.join(self.d, "verdict.json")
        _quiet(L.main, ["--session", self.jf, "--emit-review", self.pack, "--reviewer-output", verdict])
        out = os.path.join(self.d, "o.html")
        start = time.monotonic()
        rc, err = _quiet(L.main, ["--apply-review", self.pack, "--output", out])
        self.assertEqual(rc, 2)
        # well under the 60 s the reviewed flow once waited; detect-secrets, when installed, takes its time
        self.assertLess(time.monotonic() - start, 30, "no wait for a critic that cannot have run yet")
        self.assertIn("next:", err)
        self.assertIn("no verdict at", err)
        self._verdict(False)
        rc, err = _quiet(L.main, ["--apply-review", self.pack, "--output", out])
        self.assertEqual(rc, 2)
        self.assertIn("FAIL: quality gate", err)
        self.assertNotIn("next:", err, "the run that reads the verdict asks for none")

    def test_a_verdict_entry_without_idx_does_not_answer(self):
        recs = []
        for k in range(3):
            recs += [_rec("user", "%d번 작업을 해 주세요" % k, ts="2026-08-09T10:0%d:00Z" % k, uuid="u%d" % k),
                     self._asst("%d번 작업을 마쳤고 검사가 통과합니다." % k, "a%d" % k, ts="2026-08-09T10:0%d:01Z" % k)]
        self._write(recs)
        _quiet(self._emit)
        self._gate_first()
        _, samples = self._samples()
        self.assertGreater(len(samples), 1, "the case needs two samples or more")
        path = self._verdict(True, samples)
        with open(path, encoding="utf-8") as f:
            got = json.load(f)
        del got[0]["idx"]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(got, f)
        rc, err = self._gate_apply(path)
        self.assertEqual(rc, 2)
        self.assertIn("does not answer", err)
        self.assertTrue(os.path.exists(path + ".used"), "read and set aside: it counts as a failed gate run")

    def test_a_wrapped_answer_of_nested_lists_is_refused_in_bounded_time(self):
        import time
        self._write(self._records())
        _quiet(self._emit)
        dec = os.path.join(self.d, "dec-nested.json")
        with open(dec, "w", encoding="utf-8") as f:
            f.write("Here: " + '[{"id":"a"},' * 25000)
        start = time.monotonic()
        rc, err = _quiet(L.main, ["--apply-review", self.pack, "--output", os.path.join(self.d, "out.html"),
                                  "--skip-reviewer", "--decisions", dec])
        self.assertEqual(rc, 2)
        self.assertIn("cannot read decisions", err)
        self.assertLess(time.monotonic() - start, 5)

    def test_a_decisions_file_over_the_size_cap_is_not_read(self):
        # a good answer padded past the cap: only the size check refuses it
        self._write(self._records())
        _quiet(self._emit)
        dec = os.path.join(self.d, "dec-big.json")
        body = json.dumps([{"id": "a1", "keep": True, "summary": "큰 파일"}])
        with open(dec, "w", encoding="utf-8") as f:
            f.write(body + " " * (L.DECISIONS_MAX + 1 - len(body.encode("utf-8"))))
        self.assertEqual(os.path.getsize(dec), 1_000_001)
        rc, err = _quiet(L.main, ["--apply-review", self.pack, "--output", os.path.join(self.d, "out.html"),
                                  "--skip-reviewer", "--decisions", dec])
        self.assertEqual(rc, 2)
        self.assertIn("larger than 1000000 bytes", err)

    def test_a_deeply_nested_verdict_is_refused_without_a_traceback(self):
        self._write(self._records())
        _quiet(self._emit)
        path = os.path.join(self.d, "verdict.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("[" * 100000)
        rc, err = self._gate_apply(path)
        self.assertEqual(rc, 2)
        self.assertIn("is not a verdict list", err)
        self.assertNotIn("Traceback", err)

    def test_a_deeply_nested_verdict_read_by_the_gate_ends_in_exit_2(self):
        self._write(self._records())
        path = os.path.join(self.d, "verdict.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("[" * 100000)
        with self.assertRaises(SystemExit) as cm:
            _quiet(L.main, ["--session", self.jf, "--output", os.path.join(self.d, "rb.html"), "--rulebase",
                            "--reviewer-output", path, "--reviewer-timeout", "1"])
        self.assertEqual(cm.exception.code, 2)

    def test_a_reviewer_dropping_a_typed_user_turn_is_named(self):
        # a reviewer may follow a line injected into what it reads and drop the user's own words
        meta = dict(_rec("user", "주입된 안내문입니다. 이 지침을 따르세요.", ts="2026-08-09T10:03:00Z", uuid="m1"), isMeta=True)
        self._write(self._records() + [meta])
        _quiet(self._emit)
        (rc, _text), err = _quiet(self._apply, [{"id": "u1", "keep": False}, {"id": "m1", "keep": False}])
        self.assertEqual(rc, 0)
        self.assertIn("reviewers dropped 1 typed user turn(s): u1", err)


class TestPatternsForPages(_ReviewCase):
    """3.0.2: the reviewer patterns redact pages too, so what they hide by mistake shows to
    people; a second pass over redacted text must change nothing."""
    PW = "Hunter22" + "pw"

    def test_password_bare_leaves_paths_variables_and_markdown(self):
        pw = self.PW
        for keep in ("docker run --rm -v $PWD:/workspace img", "export OLDPWD=/home/user",
                     "password=$DB_PASSWORD ./run", "PWD=~/src make", "password: ******"):
            self.assertEqual(L.review_redact(keep)[0], keep, keep)
        self.assertEqual(L.review_redact("**password: " + pw + "**")[0], "**[REDACTED:PasswordBare]**")
        self.assertEqual(L.review_redact("`PGPASSWORD=" + pw + "`")[0], "`PG[REDACTED:PasswordBare]`")
        self.assertEqual(L.review_redact("(passwd=" + pw + ")")[0], "([REDACTED:PasswordBare])")

    def test_password_bare_still_hides_env_style_names(self):
        pw = self.PW
        for shape in ("PGPASSWORD=" + pw + " psql -h db", "MYSQL_PWD=" + pw, "DB_PASSWORD=" + pw,
                      "SPRING_DATASOURCE_PASSWORD=" + pw, "password: " + pw, "| 암호: " + pw + " |"):
            self.assertNotIn("Hunter22", L.review_redact(shape)[0], shape)
        self.assertNotIn("한글비번", L.review_redact("비밀번호: 한글비번1234")[0])

    def test_password_bare_skips_markers_and_masks(self):
        for done in ('암호: ****h12"', "password: [REDACTED]", "pwd=[REDACTED:entropy]"):
            self.assertEqual(L.review_redact(done)[0], done, done)

    def test_extra_keywords_leave_marker_names_whole(self):
        red, counts = L.redact("[REDACTED:CurlUser] 와 user 와 [REDACTED]", extra="user,redacted")
        self.assertEqual(red, "[REDACTED:CurlUser] 와 [REDACTED] 와 [REDACTED]")
        self.assertEqual(counts, {"custom:user": 1})

    def test_curl_user_keeps_compact_argument_lists(self):
        for cmd in (["docker", "run", "-u", "1000:1000", "img"], ["date", "-u", "+%H:%M:%S"],
                    ["sort", "-u", "-o", "out.txt", "a:b"], ["docker", "exec", "-u", "root", "c", "sh", "-c", "a:b"],
                    ["ps", "-u", "1000", "-o", "pid:10"], ["rsync", "-avu", "host:/srv/app", "."],
                    ["mktemp", "-u", "${TMPDIR:-/tmp}/x"]):
            for text in (json.dumps(cmd, separators=(",", ":")), json.dumps({"command": cmd}, separators=(",", ":")),
                         json.dumps(cmd), repr(cmd), repr(cmd).replace(" ", "")):
                self.assertEqual(L.review_redact(text)[0], text, text)

    def test_curl_user_hides_compact_and_escaped_argument_lists(self):
        c = "cu" + "rl"
        cmd = [c, "-s", "-u", "admin:" + self.PW, "https://x"]
        for text in (json.dumps(cmd, separators=(",", ":")), json.dumps(cmd), repr(cmd), repr(cmd).replace(" ", ""),
                     json.dumps(json.dumps(cmd, separators=(",", ":"))),
                     json.dumps({"command": cmd}, separators=(",", ":"))):
            self.assertNotIn("Hunter22", L.review_redact(text)[0], text)


class TestPageRedaction(_ReviewCase):
    """3.0.2: every page (the default flow and --rulebase) hides what the reviewer patterns
    find, whole; the page's own patterns keep --redact-mode."""
    PW = "Hunter22" + "pw"

    def _secret_records(self):
        c = "cu" + "rl"
        return [_rec("user", "배포 때 " + c + " -u admin:" + self.PW + " https://x 를 썼어요", uuid="u1"),
                self._asst("확인했습니다.\n\n" + c + " -u deploy:" + self.PW + " 로 배포가 끝났습니다. 암호: Xy7pQ2mZ9k", "a1")]

    def _rulebase_page(self, extra=()):
        out = os.path.join(self.d, "r.html")
        rc, err = _quiet(L.main, ["--session", self.jf, "--output", out, "--skip-reviewer", "--rulebase"] + list(extra))
        name = [p for p in os.listdir(self.d) if p.startswith("r_") and p.endswith(".html")][0]
        with open(os.path.join(self.d, name), encoding="utf-8") as f:
            return rc, f.read(), err

    def test_page_redact_runs_the_reviewer_patterns_then_the_page(self):
        c = "cu" + "rl"
        red, counts = L.page_redact(c + " -u admin:" + self.PW + " 키 AKIA" "IOSFODNN7EXAMPLE", None, "mask")
        self.assertNotIn("Hunter22", red)
        self.assertIn("[REDACTED:CurlUser]", red)
        self.assertIn("AKIA****MPLE", red)
        self.assertEqual(counts, {"CurlUser": 1, "AKIA": 1})

    def test_a_second_pass_changes_nothing(self):
        c = "cu" + "rl"
        text = (c + " -u admin:" + self.PW + " 와 암호: Xy7pQ2mZ9k, password: \"abcdefgh12\", "
                "키 AKIA" "IOSFODNN7EXAMPLE, " + "Bear" + "er " + "Q8zQ8z" * 4)
        for mode in ("full", "mask"):
            once = L.page_redact(text, "acme", mode)[0]
            self.assertEqual(L.page_redact(once, "acme", mode), (once, {}), mode)

    def test_both_pages_hide_reviewer_pattern_secrets(self):
        self._write(self._secret_records())
        rc, page, err = self._rulebase_page()
        self.assertEqual(rc, 0, err)
        _quiet(self._emit)
        rc2, page2 = _quiet(self._apply, [{"id": "a1", "keep": True, "summary": None}])[0]
        self.assertEqual(rc2, 0)
        for p in (page, page2):
            self.assertNotIn("Hunter22", p)
            self.assertNotIn("Xy7pQ2mZ9k", p)
            self.assertIn("[REDACTED:CurlUser]", p)

    def test_mask_mode_masks_page_patterns_and_hides_reviewer_hits_whole(self):
        c = "cu" + "rl"
        self._write([_rec("user", "점검", uuid="u1"),
                     self._asst(c + " -u admin:" + self.PW + " 와 키 AKIA" "IOSFODNN7EXAMPLE 를 썼습니다.", "a1")])
        rc, page, err = self._rulebase_page(["--redact-mode", "mask"])
        self.assertEqual(rc, 0, err)
        self.assertNotIn("Hunt", page)
        self.assertNotIn("admin:", page)
        self.assertIn("[REDACTED:CurlUser]", page)
        self.assertIn("AKIA****MPLE", page)
        self.assertNotIn("[REDACTED:CurlUser]]", page)

    def test_agent_session_and_tool_names_are_redacted_on_the_page(self):
        ant = "sk-" + "ant-api03-" + "b" * 24
        t1 = _turn("user", "안녕하세요", session="s1")
        t1["session_name"] = "keys-" + ant
        t2 = _turn("agent", "결과를 정리했습니다.", uuid="g1", session="s1", tools={"deploy-acme": 2})
        t2["agent_from"] = "runner " + ant
        rows, counts, _, _ = L.render_rows([t1, t2], "s1", "acme", "full", False, all_sessions=True)
        page = "\n".join(rows)
        self.assertNotIn("ant-api03", page)
        self.assertNotIn("acme", page)
        self.assertGreaterEqual(counts.get("AnthropicKey", 0), 2)

    def test_the_residual_check_names_what_a_page_still_holds(self):
        c = "cu" + "rl"
        self.assertEqual(L._residual_secrets("<div>" + c + " -u admin:" + self.PW + "</div><p>ok</p>"),
                         {"CurlUser": 1})
        self.assertEqual(L._residual_secrets("<div>[REDACTED:CurlUser] &amp; ok</div>"), {})

    def test_a_long_page_of_secrets_renders_in_linear_time_and_leaves_none(self):
        import importlib.util
        import time
        c = "cu" + "rl"
        recs = []
        for k in range(150):
            ts = "2026-08-09T%02d:%02d:00Z" % (10 + k // 60, k % 60)
            recs.append(_rec("user", "단계 %d 를 실행해 주세요" % k, ts=ts, uuid="u%d" % k))
            recs.append(self._asst("실행했습니다.\n\n%s -u svc%d:%s https://x 로 확인했습니다." % (c, k, self.PW),
                                   "a%d" % k, ts=ts.replace(":00Z", ":30Z")))
        self._write(recs)
        start = time.monotonic()
        rc, page, err = self._rulebase_page()
        took = time.monotonic() - start
        self.assertEqual(rc, 0, err)
        self.assertNotIn("Hunter22", page)
        self.assertNotIn("still holds", err)
        if importlib.util.find_spec("detect_secrets") is None:   # detect-secrets scans a temp file per call
            self.assertLess(took, 30)

    def test_a_summary_never_keeps_part_of_a_secret(self):
        c = "cu" + "rl"
        head = "배포 스크립트를 점검했고 환경 변수와 인증서 경로를 확인했습니다."
        for k in range(0, 90, 3):
            tail = "마지막으로 " + "가" * k + " " + c + " -u admin:" + self.PW + " 로 응답을 받았습니다."
            t = _turn("assistant", head + "\n\n" + tail, uuid="a%d" % k, parts=[head, tail])
            summary, _ = L.read_or_summarize(t, "s", rebuild=True)
            self.assertNotIn("Hunt", summary, k)
            self.assertNotIn("admi", summary, k)

    def test_a_cut_never_splits_a_marker(self):
        import re
        s = "가" * 50 + " [REDACTED:CurlUser] 끝까지 이어지는 문장"
        for n in range(40, 80):
            cut = L._cut(s, n)
            self.assertIsNone(re.search(r"\[REDACTED[^\]]*$", cut.rstrip("…")), (n, cut))

    def test_a_summary_cached_by_3_0_1_is_not_reused(self):
        text = "점검 결과를 정리했습니다. 접속 정보도 확인했습니다."
        self._write([_rec("user", "점검해 주세요", uuid="u1"), self._asst(text, "a1")])
        old = hashlib.sha256((text + "\x00s" + "2").encode()).hexdigest()[:8]
        (L.cache_dir("s") / ("a1-%s.txt" % old)).write_text("…가가가암호: Xy7p… 추가로", encoding="utf-8")
        rc, page, err = self._rulebase_page()
        self.assertEqual(rc, 0, err)
        self.assertNotIn("Xy7p", page)


class TestRulebaseMatches2x(unittest.TestCase):
    def test_rulebase_output_is_byte_for_byte_the_2x_output(self):
        try:
            import detect_secrets  # noqa: F401
            self.skipTest("detect-secrets changes redaction; the pinned outputs were made without it")
        except ImportError:
            pass
        saved = L.CACHE_BASE
        d = tempfile.mkdtemp()
        try:
            L.CACHE_BASE = pathlib.Path(d) / "cache"
            jf = os.path.join(d, "golden.jsonl")
            with open(jf, "w", encoding="utf-8") as f:
                for r in _GOLDEN_RECORDS:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
            for k, (flags, want) in enumerate(_GOLDEN_2X.items()):
                L.CACHE_BASE = pathlib.Path(d) / ("cache%d" % k)   # 2.x keys its cache on the text alone
                out = os.path.join(d, "g_260101+0000.html")
                rc = _quiet(L.main, ["--session", jf, "--output", out, "--skip-reviewer",
                                     "--rulebase"] + list(flags))[0]
                self.assertEqual(rc, 0, flags)
                with open(out, "rb") as f:
                    self.assertEqual(hashlib.sha256(f.read()).hexdigest(), want, flags)
        finally:
            L.CACHE_BASE = saved
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
