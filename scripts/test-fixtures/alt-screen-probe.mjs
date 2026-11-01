#!/usr/bin/env node
/**
 * alt-screen-probe: a tiny full-screen app for the tune-tmux tests. It switches the terminal to the alternate
 * screen (as Claude Code and Codex full-screen views do), reads keys in raw mode and appends every byte it gets
 * to a log file, so a test can tell whether PageUp and PageDown reached the app or were taken by tmux.
 *
 *   node alt-screen-probe.mjs <log file> [--mouse] [--seconds <n>]
 *
 * --mouse also turns on mouse reporting (the app grabs the mouse). It leaves on a lone "q" or after --seconds
 * (default 60) and puts the screen back. Exit status: 0 done, 2 usage error.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

function parse(argv) {
  const log = argv[0];
  const at = argv.indexOf("--seconds");
  const seconds = at === -1 ? 60 : Number(argv[at + 1]);
  if (!log || log.startsWith("--") || !(seconds > 0)) return null;
  return { log, mouse: argv.includes("--mouse"), seconds };
}

function main() {
  const o = parse(process.argv.slice(2));
  if (!o) {
    process.stderr.write("사용법: node alt-screen-probe.mjs <log file> [--mouse] [--seconds <n>]\n");
    process.exitCode = 2;
    return;
  }
  writeFileSync(o.log, "");
  process.stdout.write(`\x1b[?1049h\x1b[H\x1b[2JALT SCREEN PROBE${o.mouse ? MOUSE_ON : ""}`);
  const finish = () => {
    process.stdout.write(`${o.mouse ? MOUSE_OFF : ""}\x1b[?1049l`);
    process.exit(0);
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", (b) => {
    appendFileSync(o.log, b);
    if (b.length === 1 && b[0] === 0x71) finish();
  });
  setTimeout(finish, o.seconds * 1000);
}

main();
