#!/usr/bin/env node
/*
 * ralph-qa 검증자 프리플라이트 프로브 — 외부 검증 좌석이 "실제로 앉을 수 있는가"를 0토큰으로 판정한다.
 *
 * 의존성 0. 전역 fetch 를 쓰지 않고 node:http / node:https 를 직접 쓴다. 근거 둘:
 *  (1) 전역 fetch 는 Node 17.5 플래그·18.0 기본이라 package.json engines(node>=16.7)에서 미보장이다.
 *  (2) 저장소 선례 — hooks/update-checkin.mjs:18-19 가 이미 node:http + node:https 를 직접 import 한다.
 *
 * 이 프로브는 GET 만 낸다. 모델 호출(POST /chat/completions·/responses)은 어떤 경로에서도 하지 않는다.
 *
 * ── 유효성 사다리 (원문의 거처는 이 주석과 계획서다. SKILL.md 에는 출력 필드 표만 둔다) ────────────
 *
 * T0   존재    PATH 스캔으로 codex / gemini 를 찾는다 (Windows 는 PATHEXT 고려, 셸을 띄우지 않는다).
 * T0-b 전송    command -v curl                    → transport:"curl"
 *              없으면 python3 버전 프로브(>=3.6)  → transport:"python3"  (urllib 폴백)
 *              둘 다 없으면                       → transport:"none"
 *                → 외부 API 좌석 valid:false, reason:"no-transport"
 *              ※ 프로브 자신은 transport 를 쓰지 않는다 — Node 의 node:http 로 직접 낸다.
 *                transport 는 SKILL.md 산문이 지시하는 외부 좌석의 실제 검증 호출이 나갈 경로이며,
 *                프로브는 그것을 탐지해서 보고할 뿐 사용하지 않는다.
 * T1   해석    ~/.codex/config.toml 의 model_provider → [model_providers.X] 의 base_url / env_key.
 *              없으면 RALPH_QA_BASE_URL / OPENAI_BASE_URL, 그것도 없는데 API 키 env 만 유효하면
 *              표준 OpenAI 기본 base URL(상수). 키 env 마저 비어 있으면 여기서 무효.
 *              "키는 유효한데 base_url 을 안 적어 뒀다"가 이 경로의 통상 케이스이고, 그걸
 *              미구성으로 처리하면 유효한 크리덴셜을 환경 탓으로 버리게 된다.
 *              TOML 파서를 설치하지 않는다 — 필요한 두 필드만 줄 단위로 뽑는다(의존성 0).
 *              codex login status / auth.json 은 유효성 근거로 쓰지 않는다 — 실측상 거짓 음성이고
 *              (Not logged in 이라 답하면서 codex 는 정상 동작한다) exit code 로도 갈리지 않는다.
 * T2   생존    GET {base_url}/models  (Authorization: Bearer → 401·403 이면 api-key 헤더로 재시도)
 *              2xx=유효 / 401·403=dead-credential / 404=route-missing /
 *              그 외 4xx·5xx=http-error / ECONNREFUSED=unreachable / 하드 타임아웃=timeout
 *              재시도는 base_url 이 **명시 설정**(codex provider config·base URL env)에서 온 경우에만
 *              허용한다. 기본 엔드포인트로 내려간 경우엔 한 번만 보낸다 — 아래 [기본 엔드포인트] 참조.
 * T3   계열    2xx 응답의 data[].id 를 계열 분류 → 저자 계열을 제외한 후보만 채택.
 *              계열 분류표는 상수다 — env override 를 두지 않는다. 분류표는 파라미터가 아니라
 *              자기승인을 막는 안전 장치 본체이고, env 하나로 claude-* 를 claude 가 아니게
 *              만들 수 있으면 코드로 승격시킨 방어를 환경변수로 되돌리는 셈이다.
 *              미분류 id 는 fail-closed 로 제외하고 개수를 unclassified 에 남긴다.
 *              분류 가능한 id 가 0 → unclassifiable-catalog / 후보가 0 → no-independent-model
 * T4   강등    착석 후(1회 이상 판정을 낸 뒤)의 인증실패·쿼터·레이트리밋은 좌석 상실이며
 *              실행을 INCONCLUSIVE 로 종결시킨다. 착석 전 무효(T2·T3)는 좌석이 애초에 없는 것이라
 *              상실이 아니다. T4 는 프로브가 아니라 저자 런타임이 루프 중에 판정한다.
 *
 * ── gemini 사다리 — 좌석이 둘이고 서로 독립이다 ─────────────────────────────────────────────
 *
 * 요구가 문장 두 개로 갈라져 있다: "gemini CLI 가 설치돼 있고 유효하면 쓴다"와 "gemini 모델을
 * 쓸 수 있는 정보(크리덴셜)가 유효하면 curl·python 으로 쓴다". 그래서 좌석도 둘이고, CLI 부재가
 * 크리덴셜 경로를 가리면 안 된다. 가리면 환경이 유효한 키를 줬는데도 "환경 탓에 모델 축이 안
 * 덮였다"(cli-absent)고 보고하게 되는데, 그게 이 스킬이 막겠다고 선언한 허위 커버리지다.
 *
 * [CLI 좌석] observed.cli.gemini · observed.external.gemini
 * G0 존재   PATH 스캔으로 gemini 를 찾는다 (Windows 는 PATHEXT 고려).
 * G1 인증   gemini 는 OpenAI 호환이 아니고 자체 인증을 쓴다 — T1(codex provider)·T2(OpenAI 호환
 *           GET /models)로는 판정할 수 없다. 인증 후보 env 이름을 상수 목록으로 확인한다.
 *           전부 부재 → valid:false, reason:"gemini-no-auth"
 * G2 생존   T2 에 대응하는 0토큰 프리플라이트가 gemini CLI 에 있는지 이 머신에서 확인할 수 없었다.
 *           → 프로브는 G2 를 수행하지 않고 cli.gemini.liveChecked=false 로 남긴다.
 *             "확인했는데 통과"가 아니라 "확인하지 않았다"를 출력에 적는다.
 *             아래 GA2 는 CLI 가 아니라 API 를 재는 것이라 G2 를 대신하지 않는다.
 * G3 전송   gemini -p "<프롬프트>" (비대화형 1회 호출). G2 가 없으므로 이 좌석은
 *           "첫 검증 호출이 곧 프로브"인 좌석이다 — 이 파일이 아니라 SKILL.md 산문이 낸다.
 *           첫 호출이 실패하면 착석 전 무효(= 좌석 없음)이고 좌석 상실이 아니다.
 *
 * [크리덴셜 좌석] observed.geminiApi · observed.external.geminiApi
 * GA1 인증  G1 과 같은 env 목록을 본다. CLI 존재 여부는 보지 않는다 — 별개 좌석이다.
 * GA2 생존  모델 목록 GET {base}/v1beta/models?key=<KEY> — T2 와 동등한 0토큰 판정이다.
 *           2xx=유효 / 401·403=dead-credential / 404=route-missing / 그 외·refused·timeout=무효.
 *           추론 호출(POST)은 어느 경로에서도 내지 않는다.
 *           base 는 상수 기본값 + RALPH_QA_GEMINI_BASE_URL override 한 쌍이다.
 *           인증이 쿼리스트링에 실리므로 출력에는 redactUrl 로 search 를 떼어 낸 base 만 적는다.
 * GA3 전송  실제 검증 호출은 T0-b 의 transport 로 나간다(요청 형태는 OpenAI 호환이 아니다) —
 *           이 파일이 아니라 SKILL.md 산문이 낸다. transport 가 none 이면 좌석 무효.
 * GA4 강등  T4 와 같다.
 *
 * 비대칭은 그래도 남는다: 두 좌석 다 OpenAI 호환 카탈로그가 아니라 계열 필터(T3)를 못 돌린다.
 * 저자 계열 배제는 "엔드포인트·CLI 가 애초에 다른 벤더"라는 사실에 의존한다(저자 계열은 claude·gpt).
 * 이 머신에 gemini CLI 가 없어 G2·G3 은 한 번도 실행된 적이 없다(미검증). GA2 는 스텁 서버로 검증했다.
 *
 * ── 송신 게이트 두 개 ───────────────────────────────────────────────────────────────────────
 *
 * [--external=off]  HTTP 를 한 건도 내지 않는다. 정적 탐지(PATH 스캔·config 파싱·env 이름 확인)에서
 *   멈추고 T2·GA2 를 건너뛴다. 이 플래그가 좌석 계산에서만 소비되면 SKILL.md 가 지시하는
 *   "프로브(관측): 미실행" 이 거짓 보고가 된다 — 실제로는 키가 벤더 호스트로 나간 뒤이기 때문이다.
 *   미실행은 관측 필드에 명시한다: probed:false · status:null · live:null · reason:"external-off".
 *   status:null 을 홀로 두지 않는 이유는 "안 했다"와 "했는데 실패했다"가 같은 모양이 되기 때문이다.
 *
 * [기본 엔드포인트]  base_url 을 못 찾았을 때 키 env 이름이 지목하는 표준 벤더 호스트로 내려가는
 *   경로는 편의지만 무고지로 두면 위험하다: OPENAI_API_KEY 가 OpenAI 가 아닌 프로바이더(게이트웨이·
 *   프록시·사설 서버)의 키를 담는 구성이 흔하고, 그런 환경의 base URL 은 앱 설정에 있지 env 에 없다.
 *   그대로 두면 남의 프로바이더 키가 이름만 같은 벤더로 나간다. 그래서 셋을 건다.
 *     (1) RALPH_QA_NO_DEFAULT_ENDPOINT 가 설정되면 내려가지 않는다 → 미구성(not-configured) 미착석.
 *     (2) 기본 엔드포인트일 때는 401·403 대체 헤더 재시도를 하지 않는다 — 키를 두 번 보내지 않는다.
 *     (3) 내려간 사실은 source(default:*)와 notes 양쪽에 항상 남는다.
 *
 * ── 출력 ────────────────────────────────────────────────────────────────────────────────────
 * 최상위 키는 정확히 observed · declared · notes 셋이다.
 *   observed = 프로브가 직접 측정한 것 (probeMs·httpRequests·transport·cli·api·geminiApi·external·
 *              candidates·unclassified)
 *              probeMs 는 HTTP 를 한 건이라도 낸 실행에만 숫자가 있다(안 냈으면 null). 잰 것이 없는데
 *              작은 수를 적으면 "쟀는데 빨랐다"로 읽힌다. 실제로 낸 요청 수는 httpRequests 가 담는다.
 *   declared = 프로브가 플래그 값을 되받아 적는 것 (authorFamily*·seats·externalAbsentReason)
 * 프로브는 서브에이전트를 띄우지 않으므로 seats.backbone 을 관측할 수 없다. 두 블록을 섞으면
 * "필터가 호출됐다는 가시적 흔적"이 검증 불가한 선언값에 희석된다.
 *
 * 키 값은 stdout/stderr 어디에도 내지 않는다. 키 이름(keyEnv)만 낸다.
 *
 * 사용: node verifier-probe.mjs --json [--author-family <v>] [--external auto|off] [--agents N]
 * env:  RALPH_QA_PROBE_TIMEOUT_MS(하드 타임아웃) · RALPH_QA_NO_DEFAULT_ENDPOINT(기본 엔드포인트 차단)
 *       RALPH_QA_BASE_URL·OPENAI_BASE_URL·RALPH_QA_GEMINI_BASE_URL(명시 base URL)
 */
import { accessSync, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 상수 안전 장치 ────────────────────────────────────────────────────────────────────────────
// 계열 분류표. 이건 "하드코딩 0" 규칙의 적용 대상이 아니다 — 호출에 쓰이는 엔드포인트·키·기본
// 모델 ID 가 아니라 자기승인을 막는 안전 장치 본체이므로 상수로 고정한다. env override 없음.
// 첫 매치가 이긴다.
const FAMILY_RULES = [
  ['claude', [/claude/, /anthropic/]],
  ['gemini', [/gemini/, /gemma/, /palm/, /bison/, /(^|[-._/])google/]],
  ['llama', [/llama/]],
  ['mistral', [/mistral/, /mixtral/, /codestral/, /ministral/, /magistral/, /pixtral/, /devstral/]],
  ['deepseek', [/deepseek/]],
  ['qwen', [/qwen/, /qwq/]],
  ['grok', [/grok/, /(^|[-._/])xai/]],
  ['cohere', [/cohere/, /command-r/, /(^|[-._/])aya[-._0-9]/]],
  ['phi', [/(^|[-._/])phi[-._0-9]/]],
  ['nova', [/(^|[-._/])(nova|titan)[-._0-9]/]],
  ['gpt', [/(^|[-._/])gpt/, /openai/, /(^|[-._/])o[1-9](\b|[-._])/, /davinci/, /babbage/, /codex/]],
];

// 저자 런타임 → 계열. 런타임을 특정하지 못하면 두 계열을 모두 배제한다(fail-closed).
const AUTHOR_RUNTIME_FAMILY = { claude: 'claude', codex: 'gpt' };
const AUTHOR_CAPABLE_FAMILIES = ['claude', 'gpt'];

// gemini 인증 후보 env 이름. 키 값이 아니라 탐지 대상의 이름이며, 계열 분류표와 같은 범주의
// 상수 안전 장치라 "하드코딩 0" 규칙의 적용 대상 밖이다.
const GEMINI_AUTH_ENVS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_CLOUD_API_KEY'];
const GEMINI_HOME_DIR = '.gemini';

// base URL 기본값은 파라미터다 — 상수 기본값과 env override 를 한 쌍으로 둔다. 계열 분류표와 달리
// 이건 안전 장치가 아니라 "어디에 물어보는가"라서, 다른 게이트웨이·프록시를 쓰는 환경이 자기 값을
// 넣을 수 있어야 한다. 기본값이 없으면 "키는 유효한데 주소를 안 적었다"가 미구성으로 처리된다.
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const GEMINI_BASE_URL_ENV = 'RALPH_QA_GEMINI_BASE_URL';
const GEMINI_MODELS_PATH = '/v1beta/models';
const GEMINI_KEY_PARAM = 'key'; // 인증이 헤더가 아니라 쿼리스트링에 실린다(벤더 규격).

// 저자 런타임 탐지용 env 이름(값은 읽지 않고 존재만 본다).
const CLAUDE_RUNTIME_ENVS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PLUGIN_ROOT'];
const CODEX_RUNTIME_ENVS = ['CODEX_HOME', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_MANAGED_BY_NPM'];

// T1 폴백 env 이름(값은 base_url / 키 문자열이며 출력에는 이름만 나간다).
const BASE_URL_ENVS = ['RALPH_QA_BASE_URL', 'OPENAI_BASE_URL'];
const API_KEY_ENVS = ['RALPH_QA_API_KEY', 'OPENAI_API_KEY'];

// 기본 벤더 엔드포인트 폴백 옵트아웃. 설정돼 있으면 base URL 을 명시 설정에서만 받는다.
const NO_DEFAULT_ENDPOINT_ENV = 'RALPH_QA_NO_DEFAULT_ENDPOINT';
const noDefaultEndpoint = (env) => Boolean(String(env[NO_DEFAULT_ENDPOINT_ENV] || '').trim());

// 명시 설정에서 온 base URL 인가. codex provider config(codex:*)와 base URL env(env:*)만 명시다 —
// 기본 엔드포인트(default:*)는 저자가 지목한 적 없는 목적지라 키를 두 번 보내지 않는다.
const isExplicitSource = (source) => /^(codex|env):/.test(String(source || ''));

// 외부 좌석 0 의 사유 토큰 — 닫힌 정의역이다. gemini-call-failed 는 G3(첫 검증 호출)에서만
// 발생하므로 이 프로브가 내는 값이 아니다. 저자 런타임이 그 호출을 낸 뒤 보고에 적는다.
const ABSENT_REASONS = [
  'author-off',
  'probe-unseated status=<code>',
  'no-independent-model',
  'unclassifiable-catalog',
  'no-transport',
  'cli-absent',
  'gemini-call-failed',
  // 목적지는 있는데 키 env 가 비어 프로브를 아예 내지 못했다. 프로브가 안 돈 이상 probe-unseated 가
  // 아니고, 키가 없는 것은 실제로 환경 사실이므로 환경 계열이다.
  'no-credential',
  // 저자가 RALPH_QA_NO_DEFAULT_ENDPOINT 로 기본 벤더 엔드포인트 하강을 껐고, 그래서 좌석이 못 섰다.
  // cli-absent 로 흘리면 안 된다 — 그 토큰은 "환경이 경로를 안 줬다"는 뜻이라 보고에서
  // APPROVE(모델축 미커버 — 환경)로 매핑되는데, 여기서 원인은 환경이 아니라 저자 설정이다.
  'default-endpoint-off',
];

const DEFAULT_TIMEOUT_MS = 5000;
const CANDIDATES_PER_FAMILY = 3;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PY_VERSION_PROBE = 'import sys,urllib.request; sys.exit(0 if sys.version_info[:2]>=(3,6) else 1)';

// ── 인자 ─────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { json: false, authorFamily: null, external: 'auto', agents: 3, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq > 0 ? arg.slice(eq + 1) : null;
    const next = () => (inlineValue !== null ? inlineValue : argv[++i]);
    if (name === '--json') out.json = true;
    else if (name === '--author-family') out.authorFamily = (next() || '').trim() || null;
    else if (name === '--external') out.external = (next() || '').trim() === 'off' ? 'off' : 'auto';
    else if (name === '--agents') {
      const n = Number.parseInt(next(), 10);
      if (Number.isFinite(n) && n >= 1) out.agents = n;
    } else out.unknown.push(name);
  }
  return out;
}

// ── T0 / T0-b: PATH 스캔과 전송 수단 탐지 ────────────────────────────────────────────────────

// 셸을 띄우지 않는 command -v 대체. Windows 는 PATHEXT 의 각 확장자를 붙여 본다.
function whichExecutable(name, env) {
  const dirs = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!isWin) accessSync(candidate, fsConstants.X_OK); // POSIX 는 실행 비트까지 본다.
        return candidate;
      } catch { /* 다음 후보 */ }
    }
  }
  return null;
}

// T0-b. curl → python3(>=3.6 버전 프로브) → none. 프로브 자신은 이 값을 쓰지 않고 보고만 한다.
function detectTransport(env) {
  if (whichExecutable('curl', env)) return 'curl';
  const py = whichExecutable('python3', env);
  if (py) {
    try {
      const r = spawnSync(py, ['-c', PY_VERSION_PROBE], { stdio: 'ignore', timeout: DEFAULT_TIMEOUT_MS });
      if (r.status === 0) return 'python3';
    } catch { /* 버전 프로브 실패 = 전송 수단 없음으로 본다 */ }
  }
  return 'none';
}

// ── T1: provider 해석 ────────────────────────────────────────────────────────────────────────

// TOML 파서를 쓰지 않는다. 최상위 model_provider 와 [model_providers.X] 의 base_url·env_key 만
// 줄 단위로 뽑는다. 값이 한 줄 큰따옴표 문자열인 형태만 인정한다(이 두 필드는 항상 그 형태다).
function readTomlFields(src, provider) {
  const lines = src.split(/\r?\n/);
  const out = { modelProvider: null, model: null, baseUrl: null, envKey: null };
  const wanted = ['model_providers.' + provider, 'model_providers."' + provider + '"'];
  let section = null;
  for (const raw of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (header) { section = header[1].trim(); continue; }
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/.exec(raw);
    if (!kv) continue;
    const [, key, value] = kv;
    if (section === null && key === 'model_provider') out.modelProvider = value;
    if (section === null && key === 'model') out.model = value;
    if (provider && wanted.indexOf(section) >= 0) {
      if (key === 'base_url') out.baseUrl = value;
      if (key === 'env_key') out.envKey = value;
    }
  }
  return out;
}

function codexConfigPath(env) {
  const home = env.CODEX_HOME ? env.CODEX_HOME : join(env.HOME || env.USERPROFILE || homedir(), '.codex');
  return join(home, 'config.toml');
}

// api 구성 해석: codex config → env 폴백 → 없음. 키 값은 읽되 절대 출력하지 않는다.
function resolveApi(env, notes) {
  let src = '';
  try { src = readFileSync(codexConfigPath(env), 'utf8'); } catch { src = ''; }
  if (src) {
    const first = readTomlFields(src, null);
    if (first.modelProvider) {
      const fields = readTomlFields(src, first.modelProvider);
      if (fields.baseUrl) {
        const keyEnv = fields.envKey || null;
        return {
          configured: true,
          source: 'codex:' + first.modelProvider,
          baseUrl: fields.baseUrl,
          keyEnv,
          key: keyEnv ? (env[keyEnv] || '') : '',
          // 좌석 모델 선호값. 저자가 이미 자기 CLI 에 설정해 둔 모델 이름이고 이 파일에는 어떤
          // 모델 ID 도 박혀 있지 않다 — 계열 필터를 통과할 때만 쓰이는 선호값일 뿐이다.
          preferredModel: first.model || null,
        };
      }
      notes.push('codex config 의 model_provider 는 있으나 [model_providers.' + first.modelProvider + '] 의 base_url 을 찾지 못했다.');
    }
  }
  for (const nameEnv of BASE_URL_ENVS) {
    const baseUrl = (env[nameEnv] || '').trim();
    if (!baseUrl) continue;
    const keyEnv = API_KEY_ENVS.find((k) => (env[k] || '').trim()) || API_KEY_ENVS[0];
    return { configured: true, source: 'env:' + nameEnv, baseUrl, keyEnv, key: env[keyEnv] || '', preferredModel: null };
  }
  // base_url 을 아무 데서도 못 찾았지만 키 env 는 유효한 통상 케이스. 여기서 미구성으로 끊으면
  // 환경이 준 유효한 크리덴셜을 버리는 셈이라, 표준 기본 base URL 로 내려간다. env 가 있으면
  // 위 루프에서 이미 이겼으므로 이 상수는 언제나 최후 순위다.
  const fallbackKeyEnv = API_KEY_ENVS.find((k) => (env[k] || '').trim());
  if (fallbackKeyEnv) {
    if (noDefaultEndpoint(env)) {
      // 옛 동작으로 되돌린다: 목적지를 저자가 지목하지 않았으므로 미구성이다. 키를 관측해 놓고
      // 침묵하면 보고가 "환경이 아무것도 주지 않았다"로 읽히므로 사유를 남긴다.
      notes.push('base_url 을 해석하지 못했고 ' + NO_DEFAULT_ENDPOINT_ENV + ' 가 설정돼 기본 벤더 엔드포인트로 내려가지 않았다 — 키 env(' + fallbackKeyEnv + ')는 있으나 목적지가 없어 미구성으로 둔다.');
      return { configured: false, source: 'none', baseUrl: null, keyEnv: null, key: '', preferredModel: null };
    }
    notes.push('base_url 을 codex config·env 어디서도 해석하지 못해 표준 OpenAI 기본 base URL 로 내려갔다 (키 env: ' + fallbackKeyEnv + ') — 이 내려감이 싫으면 ' + NO_DEFAULT_ENDPOINT_ENV + ' 를 설정한다.');
    return {
      configured: true,
      source: 'default:openai',
      baseUrl: DEFAULT_OPENAI_BASE_URL,
      keyEnv: fallbackKeyEnv,
      key: env[fallbackKeyEnv],
      preferredModel: null,
    };
  }
  return { configured: false, source: 'none', baseUrl: null, keyEnv: null, key: '', preferredModel: null };
}

// GA1: gemini 크리덴셜 해석. CLI 존재 여부를 보지 않는다 — 두 경로는 별개 좌석이다.
// 키 값은 읽되 절대 출력하지 않는다(호출자는 keyEnv 이름만 낸다).
// reason 은 configured:false 일 때의 사유다 — 크리덴셜이 없는 것(no-credential)과 목적지가 없는
// 것(not-configured)은 다르고, 좌석 사유가 그 둘을 뭉개면 보고가 원인을 못 짚는다.
function resolveGeminiApi(env, notes = []) {
  const keyEnv = GEMINI_AUTH_ENVS.find((name) => (env[name] || '').trim()) || null;
  const override = (env[GEMINI_BASE_URL_ENV] || '').trim();
  const seat = (source, baseUrl, reason) => ({
    configured: Boolean(keyEnv) && !reason,
    source,
    baseUrl,
    keyEnv: reason === 'not-configured' ? null : keyEnv,
    key: keyEnv && reason !== 'not-configured' ? env[keyEnv] : '',
    reason: keyEnv ? reason : 'no-credential',
  });
  if (override) return seat('env:' + GEMINI_BASE_URL_ENV, override, null);
  if (keyEnv && noDefaultEndpoint(env)) {
    notes.push('gemini base URL 을 ' + GEMINI_BASE_URL_ENV + ' 에서 찾지 못했고 ' + NO_DEFAULT_ENDPOINT_ENV
      + ' 가 설정돼 기본 벤더 엔드포인트로 내려가지 않았다 — 키 env(' + keyEnv + ')는 있으나 목적지가 없어 미구성으로 둔다.');
    return seat('none', null, 'not-configured');
  }
  if (keyEnv) {
    notes.push('gemini base URL 을 ' + GEMINI_BASE_URL_ENV + ' 에서 찾지 못해 표준 벤더 기본 엔드포인트로 내려갔다 (키 env: '
      + keyEnv + ') — 이 내려감이 싫으면 ' + NO_DEFAULT_ENDPOINT_ENV + ' 를 설정한다.');
  }
  return seat('default:gemini', DEFAULT_GEMINI_BASE_URL, null);
}

// ── T2: 0토큰 생존 판정 ──────────────────────────────────────────────────────────────────────

function modelsUrl(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '') + '/models';
}

// GA2 요청 URL. 인증이 쿼리스트링에 실리므로 이 반환값은 요청에만 쓰고 출력·로그 어디에도 담지
// 않는다. 설정 base 에 딸려 온 쿼리·프래그먼트는 버린다 — 남겨 두면 경로 조립이 깨지면서 키가
// 엉뚱한 요청의 파라미터로 따라간다. 해석 불가한 base 는 null 을 돌려 호출자가 bad-url 로 끊는다.
function geminiModelsUrl(baseUrl, key) {
  try {
    const url = new URL(String(baseUrl));
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') + GEMINI_MODELS_PATH;
    url.searchParams.set(GEMINI_KEY_PARAM, key);
    return url.toString();
  } catch {
    return null;
  }
}

// 출력용 URL 정화 — userinfo·쿼리·프래그먼트를 떼어 크리덴셜이 섞여 들어올 여지를 없앤다.
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

// GET 한 번. 어떤 경로에서도 reject 하지 않고 {status, reason, body} 로 resolve 한다.
// 인증(헤더 값이든 쿼리스트링이든)은 요청에만 실리고 반환값·로그 어디에도 담기지 않는다 —
// 실패 사유는 고정 토큰이라 예외 메시지가 URL 을 물고 새어 나갈 경로가 없다.
function httpGet(url, extraHeaders, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    let parsed;
    try { parsed = new URL(url); } catch { return finish({ status: 0, reason: 'bad-url', body: '' }); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return finish({ status: 0, reason: 'bad-url', body: '' });
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    let req = null;
    const timer = setTimeout(() => {
      try { if (req) req.destroy(); } catch { /* 이미 닫힘 */ }
      finish({ status: 0, reason: 'timeout', body: '' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const headers = { accept: 'application/json', ...(extraHeaders || {}) };
    try {
      req = mod.request(parsed, { method: 'GET', headers }, (res) => {
        const status = res.statusCode || 0;
        let data = '';
        let bytes = 0;
        res.on('data', (chunk) => { bytes += chunk.length; if (bytes <= MAX_BODY_BYTES) data += chunk; });
        res.on('end', () => { clearTimeout(timer); finish({ status, reason: null, body: data }); });
        res.on('error', () => { clearTimeout(timer); finish({ status, reason: 'unreachable', body: '' }); });
      });
      req.on('error', () => { clearTimeout(timer); finish({ status: 0, reason: 'unreachable', body: '' }); });
      req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { /* 이미 닫힘 */ } });
      req.end(); // GET — 요청 본문 없음.
    } catch {
      clearTimeout(timer);
      finish({ status: 0, reason: 'unreachable', body: '' });
    }
  });
}

function statusReason(status, transportReason) {
  if (transportReason) return transportReason;          // timeout · unreachable · bad-url
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return 'dead-credential';
  if (status === 404) return 'route-missing';
  return 'http-error';
}

// Authorization: Bearer 를 먼저 쓰고, 401·403 이면 api-key 헤더로 한 번 더 시도한다
// (이 머신의 프록시는 두 헤더 모두 200 을 낸다 — 다른 프록시는 한쪽만 받을 수 있다).
// 재시도는 allowHeaderRetry 일 때만 — 저자가 지목하지 않은 기본 엔드포인트로 같은 키를 두 번
// 보내면 오배송 1건이 2건이 된다. requests 는 실제로 낸 요청 수이며 호출자가 그대로 보고한다.
async function probeModels(baseUrl, key, timeoutMs, allowHeaderRetry) {
  const url = modelsUrl(baseUrl);
  const first = await httpGet(url, { authorization: 'Bearer ' + key }, timeoutMs);
  if (allowHeaderRetry && (first.status === 401 || first.status === 403)) {
    const second = await httpGet(url, { 'api-key': key }, timeoutMs);
    if (second.status >= 200 && second.status < 300) return { ...second, header: 'api-key', requests: 2 };
    return { ...first, header: 'authorization', requests: 2 };
  }
  return { ...first, header: 'authorization', requests: 1 };
}

// ── T3: 계열 분류와 후보 선정 ────────────────────────────────────────────────────────────────

function classify(id) {
  const lowered = String(id).toLowerCase();
  for (const [family, patterns] of FAMILY_RULES) {
    for (const pattern of patterns) if (pattern.test(lowered)) return family;
  }
  return null; // 미분류 — fail-closed 로 제외한다.
}

// 좌석 모델: 저자가 자기 CLI 에 이미 설정해 둔 모델이 계열 필터를 통과했으면 그것을 쓰고,
// 아니면 통과 후보의 첫 항목을 쓴다. 어느 쪽도 이 파일에 모델 ID 를 박지 않는다.
//
// 단, codex 좌석이 함께 서면 그 선호를 그대로 따르면 안 된다 — preferred 의 출처가 바로 codex 의
// config 이므로, 두 좌석이 같은 모델을 두 전송 경로로 부르면서 좌석 수만 2가 된다. 보고의 "외부 2"
// 는 독립 검사 2건으로 읽히는데 모델 축에서는 하나다(승인 게이트가 넓어지지는 않지만 보고가
// 실제보다 독립적으로 읽힌다 — 이 스킬이 defect 로 다루는 종류다).
// 사다리: 다른 계열 → (없으면) 같은 계열의 다른 모델 → (없으면) 같은 모델. 내려간 단계는 pick 이
// 담고 호출부가 note 로 드러낸다. codex 좌석이 없으면 가를 상대가 없으므로 종전 동작 그대로다.
function pickSeatModel(candidates, preferred, avoid) {
  if (!avoid) {
    const hit = preferred ? candidates.find((row) => row.id === preferred) : null;
    return { id: hit ? hit.id : candidates[0].id, pick: 'unconstrained' };
  }
  const otherFamily = candidates.find((row) => row.family !== avoid.family);
  if (otherFamily) return { id: otherFamily.id, pick: 'independent-family' };
  const otherModel = candidates.find((row) => row.id !== avoid.model);
  if (otherModel) return { id: otherModel.id, pick: 'same-family-different-model' };
  return { id: candidates[0].id, pick: 'same-model' };
}

// 후보 목록은 계열별로 상한을 둔다. 카탈로그가 수백 개인 환경에서 전량을 내면 보고가 못 읽을
// 크기가 되기 때문인데, 상한을 계열별로 걸어 두면 어떤 계열이든 존재하면 반드시 목록에 나타난다
// — 저자 계열이 필터를 새어 나오는 회귀(AC-P1.4 가 보는 것)를 잘라내지 않는다. 전체 수는
// candidateCount 가 따로 담는다.
function sampleCandidates(candidates, keepId) {
  const perFamily = new Map();
  const out = [];
  for (const row of candidates) {
    const seen = perFamily.get(row.family) || 0;
    if (seen < CANDIDATES_PER_FAMILY || row.id === keepId) {
      perFamily.set(row.family, seen + 1);
      out.push(row);
    }
  }
  return out;
}

function catalogIds(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const rows = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.data) ? parsed.data : null);
  if (!rows) return null;
  const ids = [];
  for (const row of rows) {
    const id = row && typeof row === 'object' ? row.id : row;
    if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}

// ── 저자 계열 도출 ───────────────────────────────────────────────────────────────────────────

function detectAuthorRuntime(env) {
  if (CLAUDE_RUNTIME_ENVS.some((name) => env[name])) return 'claude';
  if (CODEX_RUNTIME_ENVS.some((name) => env[name])) return 'codex';
  return null;
}

// ── 조립 ─────────────────────────────────────────────────────────────────────────────────────

async function run(argv, env) {
  const startedAt = Date.now();
  const args = parseArgs(argv);
  const notes = [];
  if (args.unknown.length) notes.push('알 수 없는 인자를 무시했다: ' + args.unknown.join(' '));

  // 송신 게이트. 좌석 계산보다 먼저 서 있어야 한다 — 아래 T2·GA2 가 이 값을 보고 건너뛴다.
  const externalOff = args.external === 'off';
  let httpRequests = 0; // 이 실행이 실제로 낸 HTTP 요청 수. 미실행 주장의 근거다.
  if (externalOff) {
    notes.push('--external=off — HTTP 를 한 건도 내지 않았다. 관측 블록의 api·geminiApi 는 측정값이 아니라 미실행 표시다(probed:false · status:null).');
  }

  const timeoutMs = (() => {
    const raw = Number.parseInt(env.RALPH_QA_PROBE_TIMEOUT_MS || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  })();

  // 저자 계열: 런타임 도출이 기본, 명시 지정은 시끄러운 예외로 남긴다.
  const runtime = detectAuthorRuntime(env);
  let authorFamily;
  let authorFamilySource;
  if (args.authorFamily) {
    authorFamily = args.authorFamily;
    authorFamilySource = 'flag';
    notes.push('저자 계열이 플래그로 override 됐다 — 계열 필터의 신뢰 파라미터를 저자가 준 것이므로 보고에 드러낸다.');
  } else {
    authorFamily = runtime ? AUTHOR_RUNTIME_FAMILY[runtime] : 'unknown';
    authorFamilySource = 'runtime';
    if (!runtime) {
      notes.push('저자 런타임을 특정하지 못했다 — fail-closed 로 ' + AUTHOR_CAPABLE_FAMILIES.join('·') + ' 두 계열을 모두 후보에서 제외한다.');
    }
  }
  // 저자 계열을 특정하지 못하면 저자일 수 있는 계열을 모두 배제한다(fail-closed).
  const excludedFamilies = authorFamily === 'unknown' ? AUTHOR_CAPABLE_FAMILIES.slice() : [authorFamily];

  // T0 / T0-b.
  const transport = detectTransport(env);
  const codexPresent = Boolean(whichExecutable('codex', env));
  const geminiPresent = Boolean(whichExecutable('gemini', env));
  // GA1. CLI 좌석과 크리덴셜 좌석이 같은 env 목록을 보되, 관측은 한 곳에서만 한다.
  const geminiApi = resolveGeminiApi(env, notes);
  // CLI 좌석(G1)이 보는 것은 "인증 env 가 있는가"이지 "엔드포인트가 해석됐는가"가 아니다 —
  // 기본 엔드포인트를 껐다고 gemini CLI 의 자체 인증이 사라지는 것은 아니다.
  const geminiAuthEnvPresent = GEMINI_AUTH_ENVS.some((name) => (env[name] || '').trim());
  // 키는 있는데 목적지가 없는 상태를 사유 토큰에서 가르기 위해 필요하다(default-endpoint-off).
  const apiKeyEnvPresent = API_KEY_ENVS.some((name) => (env[name] || '').trim());

  if (codexPresent) {
    notes.push('codex login status·auth.json 은 유효성 근거로 쓰지 않았다 — 실측상 거짓 음성이다(Not logged in 을 출력하면서 codex 는 정상 동작하고 exit code 도 0이라 코드로도 갈리지 않는다). 인증은 provider env 키에서 온다.');
  }
  if (geminiPresent && !geminiAuthEnvPresent) {
    let geminiHome = false;
    try { geminiHome = statSync(join(env.HOME || env.USERPROFILE || homedir(), GEMINI_HOME_DIR)).isDirectory(); } catch { geminiHome = false; }
    if (geminiHome) {
      notes.push('gemini 홈 설정 디렉터리는 존재하나 인증 env 는 부재다 — 프로브는 env 만 인증 신호로 인정한다(fail-closed).');
    }
  }

  // T1.
  const api = resolveApi(env, notes);
  const hasKey = Boolean(String(api.key || '').trim());

  // T2 + T3. 요청을 내지 않은 경로는 status·live 를 null 로 둔다 — 0/false 로 적으면 "쟀는데
  // 죽었다"와 구분이 사라진다. 낸 경우에만 probed:true 이고 그때부터 숫자가 의미를 갖는다.
  let status = null;
  let live = null;
  let apiProbed = false;
  let apiReason = null;
  let candidates = [];
  let unclassified = 0;
  let catalogClassified = 0;

  if (externalOff) {
    apiReason = 'external-off'; // 미실행. 아래 좌석 게이트는 별도로 author-off 를 적는다.
  } else if (!api.configured) {
    apiReason = 'not-configured';
  } else if (!api.keyEnv || !hasKey) {
    apiReason = 'no-key'; // T1 에서 무효 — env 키가 비어 있으면 T2 를 낼 이유가 없다.
  } else {
    const result = await probeModels(api.baseUrl, api.key, timeoutMs, isExplicitSource(api.source));
    httpRequests += result.requests;
    apiProbed = true;
    live = false;
    status = result.status;
    apiReason = statusReason(result.status, result.reason);
    if (!apiReason) {
      const ids = catalogIds(result.body);
      if (!ids) {
        apiReason = 'catalog-unreadable';
      } else {
        for (const id of ids) {
          const family = classify(id);
          if (!family) { unclassified += 1; continue; } // 미분류는 fail-closed 로 제외.
          catalogClassified += 1;
          if (excludedFamilies.indexOf(family) >= 0) continue;
          candidates.push({ id, family });
        }
        if (catalogClassified === 0) apiReason = 'unclassifiable-catalog';
        else if (candidates.length === 0) apiReason = 'no-independent-model';
        else live = true;
      }
    }
  }

  // GA2. 크리덴셜이 있으면 잰다 — CLI 존재 여부·저자 플래그와 무관하게 관측은 관측이다.
  // 응답 본문은 파싱하지 않는다: OpenAI 호환 카탈로그가 아니라 계열 필터(T3)를 돌릴 대상이 아니고,
  // 이 사다리에서 2xx 는 곧 "이 크리덴셜로 이 엔드포인트가 산다"는 뜻이다.
  let geminiApiStatus = null;
  let geminiApiLive = null;
  let geminiApiProbed = false;
  let geminiApiReason = null;
  if (externalOff) {
    geminiApiReason = 'external-off'; // 미실행.
  } else if (!geminiApi.configured) {
    geminiApiReason = geminiApi.reason; // no-credential(크리덴셜 없음) · not-configured(목적지 없음)
  } else {
    const url = geminiModelsUrl(geminiApi.baseUrl, geminiApi.key);
    if (!url) {
      geminiApiReason = 'bad-url'; // base 를 해석하지 못했다 — 요청을 낸 적이 없으므로 status 는 null 이다.
    } else {
      httpRequests += 1;
      const result = await httpGet(url, {}, timeoutMs);
      geminiApiProbed = true;
      geminiApiStatus = result.status;
      geminiApiReason = statusReason(result.status, result.reason);
      geminiApiLive = !geminiApiReason;
    }
  }

  // 좌석 유효성(관측). transport 부재는 API 좌석에만 걸린다 — codex·gemini CLI 는 자기 전송을 쓴다.
  const apiSeat = (() => {
    if (externalOff) return { valid: false, reason: 'author-off' };
    if (!api.configured) return { valid: false, reason: 'not-configured' };
    if (transport === 'none') return { valid: false, reason: 'no-transport' };
    if (!live) return { valid: false, reason: apiReason };
    return { valid: true, reason: null };
  })();
  const codexSeat = (() => {
    if (externalOff) return { valid: false, reason: 'author-off' };
    if (!codexPresent) return { valid: false, reason: 'cli-absent' };
    if (runtime === 'codex') return { valid: false, reason: 'author-runtime' }; // 저자 자신은 외부 좌석 부적격.
    if (!api.configured) return { valid: false, reason: 'provider-unresolved' };
    if (!live) return { valid: false, reason: apiReason };
    return { valid: true, reason: null };
  })();
  const geminiSeat = (() => {
    if (externalOff) return { valid: false, reason: 'author-off' };
    if (!geminiPresent) return { valid: false, reason: 'cli-absent' };
    if (!geminiAuthEnvPresent) return { valid: false, reason: 'gemini-no-auth' };
    // G2 를 수행하지 않으므로 여기서는 "생존 미확인"까지가 최선이다. 첫 검증 호출이 곧 프로브다.
    return { valid: true, reason: null };
  })();
  // 크리덴셜 좌석은 CLI 좌석을 거치지 않는다 — geminiPresent 를 조건에 넣는 순간 B1(유효한 키를
  // 관측해 놓고 cli-absent 로 보고)이 되살아난다.
  const geminiApiSeat = (() => {
    if (externalOff) return { valid: false, reason: 'author-off' };
    if (!geminiApi.configured) return { valid: false, reason: geminiApi.reason };
    if (transport === 'none') return { valid: false, reason: 'no-transport' };
    if (!geminiApiLive) return { valid: false, reason: geminiApiReason };
    return { valid: true, reason: null };
  })();

  // 크리덴셜을 관측해 놓고 좌석이 안 서면 그 이유를 반드시 남긴다. 여기서 침묵하면 보고에는
  // 좌석 0 만 남고, 읽는 쪽은 그걸 "환경이 아무것도 주지 않았다"로 읽는다.
  if (geminiApi.configured && !geminiApiSeat.valid && !externalOff) {
    notes.push('gemini 모델 크리덴셜(' + geminiApi.keyEnv + ')은 있으나 좌석이 서지 못했다 — 사유 '
      + geminiApiSeat.reason + (geminiApiStatus ? ' (status ' + geminiApiStatus + ')' : '')
      + '. gemini CLI 부재는 이 경로와 무관하다.');
  }

  // codex 좌석이 서면 그 좌석이 돌릴 모델의 계열을 api 좌석이 피한다. codex 의 모델은 config 의
  // model 키에서 오는데(preferredModel 과 같은 출처), 그것을 확인하지 못하거나 계열 분류에
  // 실패하면 fail-closed 로 codex 런타임의 계열을 피한다 — 모르는 채로 안 피하는 쪽이 더 나쁘다.
  const codexAvoid = (() => {
    if (!codexSeat.valid) return null;
    const model = api.preferredModel || null;
    const family = model ? classify(model) : null;
    if (!family) {
      notes.push('codex 좌석이 돌릴 모델의 계열을 특정하지 못해 fail-closed 로 '
        + AUTHOR_RUNTIME_FAMILY.codex + ' 계열을 api 좌석에서 피했다 — '
        + (model ? 'model=' + model + ' 이 계열 분류표에 걸리지 않는다.'
                 : 'api 경로가 codex config 를 거치지 않았거나 config 에 model 키가 없다.'));
    }
    return { model, family: family || AUTHOR_RUNTIME_FAMILY.codex };
  })();

  // 좌석(선언). 프로브는 백본을 관측할 수 없고 플래그 값을 되받아 적는다.
  const external = [];
  if (apiSeat.valid) {
    const picked = pickSeatModel(candidates, api.preferredModel, codexAvoid);
    external.push({ kind: 'api', model: picked.id, modelPick: picked.pick });
    // 사다리를 내려간 사실은 반드시 드러낸다. 침묵하면 보고가 "외부 2 = 독립 2"로 읽힌다.
    if (picked.pick === 'same-family-different-model') {
      notes.push('api 좌석과 codex 좌석이 같은 계열(' + codexAvoid.family
        + ')이다 — 통과 후보에 다른 계열이 없어 모델만 갈랐다. 모델 축 독립은 부분적이다.');
    } else if (picked.pick === 'same-model') {
      notes.push('api 좌석과 codex 좌석이 같은 모델(' + picked.id
        + ')이다 — 통과한 후보가 그것뿐이다. 두 좌석은 전송 경로만 다르고 모델 축에서는 하나다.');
    }
  }
  if (codexSeat.valid) external.push({ kind: 'codex' });
  if (geminiSeat.valid) external.push({ kind: 'gemini', unverifiedPath: true });
  if (geminiApiSeat.valid) external.push({ kind: 'gemini-api' });

  // 사유 토큰은 ABSENT_REASONS 의 닫힌 정의역에서만 고른다.
  const externalAbsentReason = (() => {
    if (external.length) return null;
    if (externalOff) return 'author-off';
    if (api.configured) {
      if (transport === 'none') return 'no-transport';
      if (apiReason === 'unclassifiable-catalog') return 'unclassifiable-catalog';
      if (apiReason === 'no-independent-model') return 'no-independent-model';
      // 프로브를 돌리지 않았으면 "probe-unseated" 라고 말하지 않는다. 목적지는 설정됐는데 키 env 가
      // 비어 T2 를 아예 안 낸 경우(:596 no-key)가 그렇다 — httpRequests 0 · probed:false 인데
      // "프로브가 착석시키지 못했다"로 읽히고, <code> 자리에 상태코드가 아닌 문자열이 들어간다.
      // 위 gemini 분기 주석이 지목한 "두 번 거짓"과 같은 형태라 같은 규율을 적용한다.
      if (!apiProbed) return 'no-credential';
      const code = status > 0 ? String(status) : (apiReason || 'unreachable');
      return 'probe-unseated status=' + code;
    }
    // 기본 엔드포인트를 껐어도(configured:false) 크리덴셜은 관측된 그대로다 — 여기서 아래 cli-absent
    // 로 흘려보내면 "크리덴셜이 있으면 cli-absent 를 쓰지 않는다"가 옵트아웃 하나로 무너진다.
    // 키는 있는데 목적지가 없어서 못 선 경우 — 그 목적지를 없앤 것이 저자의 옵트아웃이라면 원인은
    // 저자다. 크리덴셜 유무와 무관하게 cli-absent 가 나오던 것이 N3 였다.
    // 이 검사는 아래 gemini 분기보다 **먼저** 와야 한다. 뒤에 두면 옵트아웃이 원인인데도 gemini
    // 분기가 먼저 잡아 `probe-unseated status=not-configured` 를 내는데, 그건 두 번 거짓이다 —
    // HTTP 를 한 건도 안 냈으므로 "probe-unseated" 가 아니고(probed:false), <code> 자리에 상태코드가
    // 아닌 문자열이 들어가며, 환경 계열로 분류돼 저자 설정이 원인인 것을 환경 탓으로 보고한다.
    if (noDefaultEndpoint(env) && (apiKeyEnvPresent || geminiAuthEnvPresent)) return 'default-endpoint-off';
    if (geminiApi.configured || (geminiAuthEnvPresent && geminiApi.reason === 'not-configured')) {
      // 환경이 유효한 크리덴셜을 준 이상 cli-absent 는 거짓말이다("환경이 경로를 안 줬다"는 뜻이라
      // 보고에서 APPROVE(모델축 미커버 — 환경)로 매핑된다). 실패한 지점을 그대로 적는다.
      if (transport === 'none') return 'no-transport';
      // api 가지와 같은 규율: 프로브를 실제로 내지 않았으면 probe-unseated 라고 말하지 않는다.
      // 여기 도달하는 경로는 형식이 깨진 RALPH_QA_GEMINI_BASE_URL override(bad-url) 처럼 목적지
      // 해석 자체가 실패한 경우다 — 그때도 httpRequests 는 0 이고 <code> 는 상태코드가 아니다.
      if (!geminiApiProbed) return 'no-credential';
      const code = geminiApiStatus > 0 ? String(geminiApiStatus) : (geminiApiReason || 'unreachable');
      return 'probe-unseated status=' + code;
    }
    if (geminiPresent && !geminiAuthEnvPresent) {
      // 닫힌 정의역에 gemini-no-auth 가 없다 — 사용 가능한 외부 경로가 없다는 뜻으로 cli-absent 를
      // 쓰고, 정확한 사유는 좌석 레코드(observed.external.gemini.reason)와 이 note 가 담는다.
      notes.push('gemini 는 PATH 에 있으나 인증 env 가 없어 착석 전 무효다(G1) — 좌석 사유는 gemini-no-auth 다.');
    }
    return 'cli-absent';
  })();

  const sampled = sampleCandidates(candidates, external.length && external[0].kind === 'api' ? external[0].model : null);
  if (sampled.length < candidates.length) {
    notes.push('후보 ' + candidates.length + '개 중 ' + sampled.length + '개만 목록에 실었다(계열당 ' + CANDIDATES_PER_FAMILY + '개 상한) — 전체 수는 candidateCount 에 있다.');
  }

  return {
    observed: {
      // HTTP 를 한 건도 내지 않았으면 잰 것이 없다 — 숫자를 적으면 "쟀는데 빨랐다"로 읽힌다.
      probeMs: httpRequests > 0 ? Date.now() - startedAt : null,
      httpRequests, // 미실행 주장의 근거. --external=off 면 언제나 0 이다.
      transport,
      cli: {
        codex: { present: codexPresent },
        // liveChecked 는 CLI 좌석(G2)에 대한 것이라 항상 false 다 — GA2 는 CLI 가 아니라 API 를
        // 잰 것이므로 여기 값을 올리지 않는다. 그 결과는 observed.geminiApi 가 따로 담는다.
        gemini: { present: geminiPresent, authEnvPresent: geminiAuthEnvPresent, liveChecked: false },
      },
      api: {
        configured: api.configured,
        source: api.source,
        baseUrl: api.baseUrl ? redactUrl(api.baseUrl) : null,
        keyEnv: api.keyEnv, // 키 이름만. 값은 어디에도 내지 않는다.
        probed: apiProbed,  // false 면 아래 status·live 는 측정값이 아니라 미실행 표시다.
        status,
        live,
        reason: apiReason,
      },
      geminiApi: {
        configured: geminiApi.configured,
        source: geminiApi.source,
        // 요청 URL 이 아니라 base 다 — redactUrl 이 search 를 떼므로 쿼리스트링의 키가 따라오지 않는다.
        baseUrl: redactUrl(geminiApi.baseUrl),
        keyEnv: geminiApi.keyEnv, // 키 이름만. 값은 어디에도 내지 않는다.
        probed: geminiApiProbed,  // api.probed 와 같은 뜻이다.
        status: geminiApiStatus,
        live: geminiApiLive,
        reason: geminiApiReason,
      },
      external: { api: apiSeat, codex: codexSeat, gemini: geminiSeat, geminiApi: geminiApiSeat },
      candidates: sampled,
      candidateCount: candidates.length,
      unclassified, // 0 이어도 키를 생략하지 않는다 — 없으면 보고에서 침묵으로 읽힌다.
    },
    declared: {
      authorFamily,
      authorFamilySource,
      authorFamilyOverridden: authorFamilySource === 'flag',
      seats: {
        backbone: args.agents,
        sourceIndependent: args.agents >= 1 ? 1 : 0,
        external,
      },
      externalAbsentReason,
    },
    notes,
  };
}

// 직접 실행일 때만 돈다 — 테스트가 import 해도 부작용이 없다.
const isMain = (() => {
  try { return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url; }
  catch { return false; }
})();

if (isMain) {
  run(process.argv.slice(2), process.env)
    .then((out) => { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); })
    .catch(() => { process.stdout.write(JSON.stringify({ observed: null, declared: null, notes: ['probe-crashed'] }, null, 2) + '\n'); });
}

// resolveApi·resolveGeminiApi 는 HTTP 없이 해석 단계만 in-process 로 검증하기 위해 내보낸다
// (기본 base URL 로 내려가는 경로는 스텁으로 못 가리므로 네트워크 없이 여기서 잠근다).
// probeModels·isExplicitSource 는 재시도 게이트를 스텁 서버로 직접 재기 위해 내보낸다 — 기본
// 엔드포인트 경로는 자식 프로세스로 돌리면 실 벤더 호스트로 나가므로 in-process 로만 잰다.
export {
  run, classify, whichExecutable, detectTransport, readTomlFields, resolveApi, resolveGeminiApi,
  probeModels, isExplicitSource,
  ABSENT_REASONS, FAMILY_RULES, DEFAULT_OPENAI_BASE_URL, DEFAULT_GEMINI_BASE_URL, GEMINI_BASE_URL_ENV,
  NO_DEFAULT_ENDPOINT_ENV,
};
