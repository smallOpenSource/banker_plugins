/**
 * templates: the folders init-dir manages, the purpose of each, and the template files a newly made folder gets.
 *
 * The template sources live in ../templates/<folder>/. A few are renamed on the way out: gitignore becomes
 * .gitignore (a real .gitignore in the skill would apply to the skill folder itself and is dropped by npm).
 * .cmd files are written with CRLF line ends, .sh files with LF and mode 0755. Files are created with "wx", so
 * an existing file is never overwritten.
 */
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The managed folders, in the order they are listed. */
export const FOLDERS = ["logs", "scripts", "work", "mockup", "tests", "docs", "KB"];

/** One line per folder: what it is for and the rule to keep. */
export const PURPOSES = {
  logs: "서비스 로그. 표준 출력은 `<이름>.out.log`, 표준 오류는 `<이름>.err.log` 로 나눠 저장. 100MB 마다 로테이션, 스트림마다 현재 파일 포함 최대 7개",
  scripts:
    "서비스 관리 스크립트. `./scripts/start.sh`, `./scripts/stop.sh`, `./scripts/status.sh`, `./scripts/restart.sh` 로 실행(Windows 는 같은 이름의 `.cmd`). 실행할 명령은 `scripts/service.conf` 의 `command=`",
  work: "사용자와 상호작용하는 작업공간. 사용자가 코딩 에이전트에게 전달할 파일을 여기에 둠. 비밀값 금지",
  mockup: "목업 파일을 관리하는 공간",
  tests:
    "단위 시험(`tests/unit/`)과 통합 시험(`tests/integration/`) 스크립트. `./tests/run.sh`(Windows `tests\\run.cmd`)가 스위트마다 한 줄로 결과를 간결하게 출력. 스위트 명령은 `tests/tests.conf`",
  docs: "문서를 관리하는 영역. evidence와 ADR도 포함하여 보관한다.",
  KB: "knowledge base. OMC 나 OMX 위키 밖에서 사용자가 알고 있어야 할 내용을 보관하는 2차 위키. 색인은 `KB/README.md`",
};

const TEMPLATE_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const SCRIPT_NAMES = ["start", "stop", "status", "restart"];

// What each folder gets: a source path under templates/<folder>/, or { to, from } to rename, or { to } for an
// empty file.
const FILES = {
  logs: ["README.md", { from: "gitignore", to: ".gitignore" }],
  scripts: [...SCRIPT_NAMES.map((n) => `${n}.sh`), ...SCRIPT_NAMES.map((n) => `${n}.cmd`), "service.conf", "lib/service.mjs", "README.md"],
  work: ["README.md"],
  mockup: ["README.md"],
  tests: ["run.sh", "run.cmd", "run.mjs", "tests.conf", "README.md", { to: "unit/.gitkeep" }, { to: "integration/.gitkeep" }],
  docs: ["README.md", { to: "evidence/.gitkeep" }, { to: "adr/.gitkeep" }],
  KB: ["README.md"],
};

const crlf = (text) => text.replace(/\r?\n/g, "\r\n");
const lf = (text) => text.replace(/\r\n/g, "\n");

// The bytes a target file gets, line ends set by its kind.
function contentOf(folder, spec) {
  if (spec.from === undefined) return Buffer.alloc(0);
  const text = readFileSync(join(TEMPLATE_DIR, folder, ...spec.from.split("/")), "utf8");
  return Buffer.from(spec.to.endsWith(".cmd") ? crlf(text) : lf(text), "utf8");
}

/** The template files of folder: [{ rel, data, mode }], rel relative to the project root with "/" separators. */
export function templateFiles(folder) {
  const specs = FILES[folder];
  if (!specs) throw new Error(`unknown folder: ${folder}`);
  return specs.map((s) => {
    const spec = typeof s === "string" ? { from: s, to: s } : s;
    return { rel: `${folder}/${spec.to}`, data: contentOf(folder, spec), mode: spec.to.endsWith(".sh") ? 0o755 : 0o644 };
  });
}

/**
 * Writes the template files of folder into dest (by default root/folder), never over an existing file. Returns the
 * rel paths written. opts.failAt=<rel> makes it throw right after writing that file (a failure midway, for tests).
 */
export function writeTemplates(root, folder, dest = join(root, folder), opts = {}) {
  const written = [];
  for (const f of templateFiles(folder)) {
    const path = join(dest, ...f.rel.split("/").slice(1));
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "wx", f.mode);
    try {
      writeFileSync(fd, f.data);
    } finally {
      closeSync(fd);
    }
    if (process.platform !== "win32") chmodSync(path, f.mode);
    written.push(f.rel);
    if (opts.failAt === f.rel) throw new Error(`주입한 실패: ${f.rel}`);
  }
  return written;
}

/** The summary lines for the folders present, in FOLDERS order. */
export function summaryLines(present) {
  return FOLDERS.filter((f) => present.includes(f)).map((f) => `- \`${f}/\`: ${PURPOSES[f]}`);
}

/** The instructions-file block body: the same bytes for the same folders present. */
export function blockBody(present) {
  return [
    "## 프로젝트 폴더 (banker init-dir)",
    "",
    "이 프로젝트의 관리 폴더와 목적. 해당하는 파일은 그 폴더에 둔다. 이 블록은 init-dir 이 다시 쓴다(직접 고치지 않음).",
    "",
    ...summaryLines(present),
  ].join("\n");
}
