#!/usr/bin/env python3
"""Regression tests for lineage.py — no external deps (stdlib unittest only).

Run with Python 3.7+:  python3.12 -m unittest test_lineage -v
Five suites map to the change-request defects (A/B/C/D/E/F). Inputs use RAW
`<...>` tags (as JSONL carries), NOT the display-escaped `&lt;` from the spec.
"""
import html
import io
import json
import os
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
