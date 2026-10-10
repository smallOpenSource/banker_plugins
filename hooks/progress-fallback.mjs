/**
 * /progress on a Claude Code without mods (Claude Mods, the function hooks of early access): an
 * engine older than them, or one where they are turned off.
 *
 * There the mod in hooks/progress.mjs never loads, so `/progress` finds commands/progress.md
 * instead and Claude Code expands it. This UserPromptExpansion hook stops that expansion before
 * the model reads it and shows the one message. Where mods run, the mod answers the command
 * itself and nothing expands, so this hook does not run.
 */
process.stdout.write(JSON.stringify({ decision: 'block', reason: 'mod 를 지원하지않는 claude code 버전입니다' }));
