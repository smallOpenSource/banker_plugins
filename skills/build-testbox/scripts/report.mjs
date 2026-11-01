// Cell states, reasons, hints, exit codes and the written results (results.json, summary.md) for build-testbox.
// The screen table and summary.md come from one function, so they hold the same rows.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATUSES = ["pass", "fail", "unverified", "unsupported"];

// Every reason a cell can end with. fail reasons are patterns (exit-<n>, http-<n>, page-error).
export const UNVERIFIED_REASONS = [
  "needs-playwright", "needs-browser", "needs-image", "needs-engine", "needs-network", "needs-tool",
  "needs-tart", "needs-vm", "tart-exec-unsupported", "host-deps", "launch-failed", "unknown-device", "timeout", "sandbox",
];
export const UNSUPPORTED_REASONS = ["apple-sla", "tart-needs-apple-silicon"];
export const FAIL_REASON = /^(exit-\d+|http-\d+|page-error)$/;

const SANDBOX_HINT = "권한 오류. Codex 는 컨테이너, 브라우저 실행을 sandbox_permissions: \"require_escalated\" 로 승인 요청한 뒤 다시 실행";

const HINTS = {
  "needs-playwright": () => "Playwright 패키지 없음. setup-playwright 스킬로 설치",
  "needs-browser": (c) => `브라우저 미설치. build-testbox setup --browsers ${c.browser || "<이름>"}`,
  "needs-image": (c) => (c.group === "browser"
    ? "Playwright 공식 이미지가 로컬에 없음. build-testbox setup --playwright-image"
    : `로컬 이미지 없음. build-testbox setup --images ${c.target}`),
  "needs-engine": () => "docker, podman 없음(또는 엔진에 연결 못 함)",
  "needs-network": () => "setup 원천에 닿지 못함",
  "needs-tool": () => "컨테이너 안 명령 없음(종료 127). 이미지에 도구를 넣거나 --cmd 를 바꿈",
  "needs-tart": () => "Tart 없음(Apple Silicon 의 macOS 13 이상, https://tart.run)",
  "needs-vm": () => "Tart VM 없음이나 꺼짐. tart clone 으로 받기(약 25GB) 뒤 tart run, --tart-vm <이름>",
  "tart-exec-unsupported": () => "이 Tart 판에 tart exec 없음. Tart 를 올림",
  "host-deps": () => "브라우저 실행에 필요한 OS 라이브러리 없음. --browser-in-container 사용",
  "launch-failed": () => "실행 실패. 로그 확인",
  "unknown-device": () => "이 Playwright 판에 없는 기기 이름",
  timeout: () => "시간 초과. --timeout 을 늘림",
  sandbox: () => SANDBOX_HINT,
  "apple-sla": () => "Apple SLA 상 macOS 는 Apple 하드웨어에서만. 비 Apple 호스트는 지원 안 함",
  "tart-needs-apple-silicon": () => "Tart 는 Apple Silicon(arm64) 전용. 이 macOS 는 Intel 이거나 가상 머신",
};

export function hintOf(cell) {
  const h = HINTS[cell.reason];
  if (h) return h(cell);
  return cell.status === "fail" ? "로그 확인" : "";
}

function countOf(cells) {
  const counts = { pass: 0, fail: 0, unverified: 0, unsupported: 0 };
  for (const c of cells) counts[c.status] += 1;
  return counts;
}

// 0 every requested cell passed, 1 a fail, 4 no fail but an unverified or unsupported cell.
export function exitCodeOf(cells) {
  const n = countOf(cells);
  if (n.fail) return 1;
  if (n.unverified || n.unsupported) return 4;
  return 0;
}

export const summaryLine = (n) => `pass ${n.pass}, fail ${n.fail}, unverified ${n.unverified}, unsupported ${n.unsupported}`;

const cellText = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function seconds(c) {
  const ms = Date.parse(c.endedAt) - Date.parse(c.startedAt);
  return Number.isFinite(ms) ? (ms / 1000).toFixed(1) : "";
}

export function tableLines(cells) {
  const lines = ["| 칸 | 상태 | 사유 | 초 | 안내 |", "|---|---|---|---|---|"];
  for (const c of cells) lines.push(`| ${cellText(c.id)} | ${c.status} | ${cellText(c.reason)} | ${seconds(c)} | ${cellText(c.hint)} |`);
  return lines;
}

// The text printed on screen and written to summary.md: summary line, notes, table.
export function renderSummary(results) {
  const lines = [summaryLine(results.counts), ""];
  for (const note of results.notes) lines.push(`- ${note}`);
  if (results.notes.length) lines.push("");
  return [...lines, ...tableLines(results.cells), ""].join("\n");
}

export function buildResults({ cells, notes, host, startedAt, out }) {
  const done = cells.map((c) => ({ ...c, hint: c.hint ?? hintOf(c) }));
  return {
    tool: "build-testbox",
    schema: 1,
    startedAt,
    endedAt: new Date().toISOString(),
    out,
    host,
    counts: countOf(done),
    exitCode: exitCodeOf(done),
    notes,
    cells: done,
  };
}

// Throws on a write failure; the caller turns that into exit 3.
export function writeResults(out, results) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(out, "summary.md"), renderSummary(results));
}

// A finished cell record. Times are ISO strings.
export function cellOf(base, status, reason, extra = {}) {
  const now = new Date().toISOString();
  return { startedAt: now, ...base, status, reason: reason || "", endedAt: extra.endedAt || base.endedAt || now, ...extra };
}
