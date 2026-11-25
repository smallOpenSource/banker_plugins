#!/usr/bin/env node
'use strict';
/*
 * compress-string - the compress command of banker's transfer-string (the /banker:transfer-string skill runs the same
 * script): see skills/transfer-string/SKILL.md. Named compress-string, not compress, so it never shadows a system command
 * of that name. Runs skills/transfer-string/scripts/transfer-string.mjs, which finds a Python 3.7 or later and runs
 * transfer_string.py with -I. Exit: 0 done; 1 no string, damaged or cut; 2 usage or input; 3 write; 4 internal
 * error; 9 no Python, or the install is broken (E_INSTALL).
 */
const path = require('path');
const { pathToFileURL } = require('url');

const entry = path.join(__dirname, '..', 'skills', 'transfer-string', 'scripts', 'transfer-string.mjs');
import(pathToFileURL(entry).href)
  .then((m) => { process.exitCode = m.run('compress', process.argv.slice(2)); })
  .catch((e) => {
    process.stderr.write('[transfer-string] 오류: ' + entry + ' 를 불러오지 못했습니다 (' + (e && e.message) + '). banker 를 다시 설치하십시오.\nTSTR_ERROR code=E_INSTALL\n');
    process.exitCode = 9;
  });
