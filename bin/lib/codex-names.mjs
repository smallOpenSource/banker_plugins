// Written by scripts/sync-codex-plugin.js from codex/manifest.json (codexName). Do not edit.
// CODEX_NAMES: Claude name to Codex name; CLAUDE_NAMES: the other way.
export const CODEX_NAMES = Object.freeze({"omc-reference":"omx-reference","setup-omc":"setup-omx","setup-omc-hud":"setup-omx-hud"});
export const CLAUDE_NAMES = Object.freeze(Object.fromEntries(Object.entries(CODEX_NAMES).map(([a, b]) => [b, a])));
