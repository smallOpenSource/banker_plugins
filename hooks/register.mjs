/**
 * banker's function-hooks module: the one file hooks/hooks.json names under
 * `modules`. Claude Code loads it beside the classic hooks in the same file;
 * builds without function hooks, and Codex, leave it alone.
 *
 * Each feature registers its own hooks; this file only gathers them.
 */
import { registerGracefulPause } from './graceful-pause.mjs';

export const register = (on) => {
  registerGracefulPause(on);
};
