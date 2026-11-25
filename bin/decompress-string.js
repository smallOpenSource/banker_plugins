#!/usr/bin/env node
'use strict';
/*
 * decompress-string - the decompress command of banker's transfer-string (the /banker:transfer-string skill runs the same
 * script): see skills/transfer-string/SKILL.md. Named decompress-string, not decompress, so it never shadows a system command
 * of that name. Runs skills/transfer-string/scripts/transfer-string.mjs, which finds a Python 3.7 or later and runs
 * transfer_string.py with -I. Exit: 0 done; 1 no string, damaged or cut; 2 usage or input; 3 write; 4 internal
 * error (also an exception in the launcher once it is loaded: E_INTERNAL); 9 no Python, or the install is broken
 * (the launcher cannot be loaded or has no run: E_INSTALL).
 */
const path = require('path');
const { pathToFileURL } = require('url');

const entry = path.join(__dirname, '..', 'skills', 'transfer-string', 'scripts', 'transfer-string.mjs');
const broken = (why) => {
  process.stderr.write('[transfer-string] 오류: ' + entry + ' 를 불러오지 못했습니다 (' + why + '). banker 를 다시 설치하십시오.\nTSTR_ERROR code=E_INSTALL\n');
  process.exitCode = 9;
};
// Only a failed import is a broken install; an exception inside run() is the launcher's own fault: exit 4.
import(pathToFileURL(entry).href).then((m) => {
  if (typeof m.run !== 'function') return broken('run 이 없음');
  try {
    process.exitCode = m.run('decompress', process.argv.slice(2));
  } catch (e) {
    process.stderr.write('[transfer-string] 오류: 내부 오류 (' + ((e && e.name) || 'Error') + ': ' + ((e && e.message) || e) + ').\nTSTR_ERROR code=E_INTERNAL\n');
    process.exitCode = 4;
  }
}, (e) => broken(e && e.message));
