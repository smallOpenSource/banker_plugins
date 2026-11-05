// make-evidence: what the user must decide before anything runs. Staged changes, changes outside the evidence
// paths, and hosts that are not this machine in config files and in this process's environment. Only names,
// places and hosts are shown, never a value. Pure Node, no network.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { EVIDENCE, EXCLUDE, MAX_TEXT, git, gitOut, headOf, lines, otherStatus, topOf } from "./me-git.mjs";


const CONFIG_NAME = /^(\.env(\..+)?|.+\.env|(docker-)?compose.*\.ya?ml|application.*\.(ya?ml|properties)|appsettings.*\.json|database\.ya?ml|settings.*\.(py|json|ya?ml|toml)|config.*\.(json|ya?ml|toml|ini|js|mjs|cjs|ts)|.*\.properties|knexfile\..+|ormconfig\..+|schema\.prisma|alembic\.ini)$/i;
const SKIP_DIR = new Set([".git", "node_modules", ".venv", "venv", "vendor", "dist", "build", "target", ".next", "__pycache__", ".tox", ".mypy_cache"]);
const URL_HOST = /\b[a-z][\w+.-]*:\/\/(?:[^\s@/]+@)?(\[[^\]]+\]|[^\s/:'"?#,;)]+)/gi;
const KEY_HOST = /\b[\w.-]*(?:host|hostname|server|addr|address|endpoint|data source)\b["']?\s*[=:]\s*["']?([^\s"',;)]+)/gi;
const ENV_KEY = /(?:URL|URI|DSN|HOST|HOSTS|ADDR|ADDRESS|ENDPOINT|SERVER|SERVERS|BROKERS|NODES)$/i;
// Values that name a host without a URL: connection strings (Server=..., Host=..., Data Source=...).
const VALUE_HOST = /(?:^|;)\s*(?:server|host|data source|address|addr)\s*=/i;
// A secret's value is never read for a host: it could be printed.
const ENV_SECRET = /PASS|PWD|SECRET|TOKEN|CREDENTIAL|PRIVATE|_KEY$/i;
const ENV_SKIP = /^(HOSTNAME|HOST|HOSTTYPE|DISPLAY|.*_?PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|BANKER_.*|DBUS_.*|XDG_.*)$/i;
// Names that database and messaging libraries read from the environment without the project naming them.
// Spring Boot and Quarkus take any setting from the environment, ASP.NET Core takes ConnectionStrings__*, Azure App
// Service sets *CONNSTR_*.
const ENV_DATA = /^(PG[A-Z]*|MYSQL_.*|POSTGRES.*|SPRING_.*|QUARKUS_.*|ConnectionStrings__.*|(?:SQL|SQLAZURE|MYSQL|POSTGRESQL|CUSTOM)CONNSTR_.*|DATABASE_.*|DB_.*|.*_DATABASE_URL|MONGO.*|REDIS.*|AMQP_.*|RABBITMQ_.*|KAFKA_.*|CELERY_.*|ELASTIC.*|OPENSEARCH_.*|SMTP_.*|MAIL_.*|AWS_ENDPOINT.*|S3_.*)$/i;
const PLACEHOLDER = /^(\$|\{|<|%|\*|example\.|.*\.example$|.*\.invalid$|your[-_])/i;
const MAX_DEPTH = 4;

// Files that commonly hold where a service connects, up to four folders down; a linked file is read through.
function configFiles(top) {
  const out = [];
  const descend = (p, name, depth) => depth < MAX_DEPTH && !SKIP_DIR.has(name) && relative(top, p) !== EVIDENCE;
  const keep = (p) => { try { const st = statSync(p); return st.isFile() && st.size <= MAX_TEXT; } catch { return false; } }; // a broken link
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (descend(p, e.name, depth)) walk(p, depth + 1); }
      else if (CONFIG_NAME.test(e.name) && keep(p)) out.push(p);
    }
  };
  walk(top, 0);
  return out;
}

// Service names in compose files: those name containers on this machine.
function composeServices(files) {
  const names = new Set();
  for (const f of files.filter((p) => /compose.*\.ya?ml$/i.test(p))) {
    let inServices = false;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      if (/^services:\s*$/.test(line)) { inServices = true; continue; }
      if (/^\S/.test(line)) inServices = false;
      const m = inServices && line.match(/^ {2}([\w.-]+):\s*$/);
      if (m) names.add(m[1]);
    }
  }
  return names;
}

export function isLocalHost(h, services = new Set()) {
  const host = h.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "::1", "0.0.0.0", "host.docker.internal"].includes(host) || host.startsWith("127.")) return true;
  return services.has(host);
}

function hostsIn(text, services) {
  const found = [];
  for (const re of [URL_HOST, KEY_HOST]) {
    for (const m of text.matchAll(re)) {
      const host = m[1].replace(/^\[|\]$/g, "").replace(/:\d+$/, "");
      if (host && !PLACEHOLDER.test(host) && !/^\d+$|[/=]/.test(host) && !isLocalHost(host, services)) found.push(host);
    }
  }
  return found;
}

// Environment variables that may say where the service connects. Asked about: those the project's tracked files
// name (one git grep for all), and those database and messaging libraries read on their own (PGHOST,
// SPRING_DATASOURCE_URL, REDIS_URL...). The rest are only noted: the shell's settings for other tools.
function envCandidates(top, env) {
  const candidate = (k) => ENV_KEY.test(k) || ENV_DATA.test(k) || /:\/\//.test(env[k]) || VALUE_HOST.test(env[k]);
  const keys = Object.keys(env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && env[k] && !ENV_SKIP.test(k) && !ENV_SECRET.test(k) && candidate(k));
  if (!keys.length) return [];
  // the evidence paths are left out: an earlier precheck log names these variables itself
  const named = new Set(lines(git(top, ["grep", "-I", "-o", "-h", "-w", "-F", ...keys.flatMap((k) => ["-e", k]), "--", ".", ...EXCLUDE]).stdout));
  return keys.map((k) => ({ k, ask: named.has(k) || ENV_DATA.test(k) }));
}

export function foreignHosts(top, env = process.env) {
  const files = configFiles(top);
  const services = composeServices(files);
  const found = [];
  for (const f of files) {
    readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(#|\/\/)/.test(line)) return;
      for (const host of hostsIn(line, services)) found.push({ where: `${relative(top, f).split("\\").join("/")}:${i + 1}`, host });
    });
  }
  for (const { k, ask } of envCandidates(top, env)) {
    const v = env[k];
    const text = /:\/\//.test(v) || VALUE_HOST.test(v) ? v : /HOST|SERVER|ADDR|BROKER|NODE/i.test(k) ? v.split(",").map((h) => `host=${h}`).join(" ") : `${k}=${v}`;
    for (const host of hostsIn(text, services)) found.push({ where: `env ${k}`, host, note: !ask });
  }
  return found;
}

export function precheck(repo, env = process.env) {
  const top = topOf(repo);
  const staged = lines(gitOut(top, ["diff", "--cached", "--name-only"]));
  const dirty = lines(otherStatus(top));
  const ignored = ["logs/x.log", "logs/x.patch"].filter((p) => git(top, ["check-ignore", "-q", `${EVIDENCE}/${p}`]).status === 0);
  const all = foreignHosts(top, env);
  const hosts = all.filter((h) => !h.note);
  const out = [`head ${headOf(top)}`];
  for (const f of staged) out.push(`STOP staged ${f}`);
  for (const l of dirty) out.push(`ASK dirty ${l}`);
  // an environment variable's host is not printed: this output goes into a log that is committed
  for (const h of hosts) out.push(h.where.startsWith("env ") ? `ASK host ${h.where} (이 컴퓨터 밖 주소)` : `ASK host ${h.where} ${h.host}`);
  for (const k of new Set(all.filter((x) => x.note).map((x) => x.where))) out.push(`NOTE host ${k} (이 컴퓨터 밖 주소, 저장소가 부르지 않는 환경 변수. 서비스가 읽는다면 묻기)`);
  for (const p of ignored) out.push(`NOTE ignored ${EVIDENCE}/${p} (commit 이 logs 아래의 .log 와 .patch 만 강제로 넣음)`);
  out.push("NOTE precheck 는 흔한 설정 꼴만 봄. 시작 스크립트와 설정 로더가 읽는 곳도 직접 확인");
  return { out, decide: staged.length + dirty.length + hosts.length > 0 };
}
