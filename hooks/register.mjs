/**
 * banker's mods module (Claude Mods, the function hooks of early access): the one file
 * hooks/hooks.json names under `modules`. Claude Code loads it beside the classic hooks in the
 * same file; builds without mods, and Codex, leave it alone.
 *
 * The engine reads the module's source before it runs it: each `on("<event>", hook)` names its
 * event as a string literal, an event without a matcher is hooked once in the whole module (its
 * imported files included), and `$` goes only to functions declared in the file that holds it.
 * So each feature (graceful-pause.mjs, progress.mjs) hooks the events only it needs, and this
 * file hooks the four they share: it calls the features' plain functions for them and makes the
 * engine calls itself, the module's command registrations among them. The engine shows a
 * `$.ui.log` line under the plugin's name, so the lines here do not repeat it.
 */
import {
  COMMAND as PAUSE, MIN_ENGINE, SPEC as PAUSE_SPEC, atLeast, pauseReset, pauseTurnCompleted, pauseTurnStarted,
  registerGracefulPause,
} from './graceful-pause.mjs';
import {
  SPEC as PROGRESS_SPEC, progressReset, progressTurnCompleted, progressTurnStarted, registerProgress,
} from './progress.mjs';

async function engineVersion($) {
  try {
    const v = await $.session.version();
    return v?.base || v?.version || null;
  } catch {
    return null; /* an engine without the call is older than /graceful-pause needs */
  }
}

async function registerOne($, spec) {
  try {
    await $.command.register(spec);
  } catch (err) {
    $.ui.log(`/${spec.name} 를 등록하지 못했습니다 (${String(err?.message ?? err)})`);
  }
}

// /graceful-pause from 2.1.289 on (an older engine gets one line saying why), /progress wherever
// mods run. A name the engine refuses is logged and the other still registers.
async function registerCommands($) {
  const version = await engineVersion($);
  if (atLeast(version, MIN_ENGINE)) await registerOne($, PAUSE_SPEC);
  else $.ui.log(`/${PAUSE} 는 Claude Code ${MIN_ENGINE.join('.')} 이상에서만 켭니다 (이 엔진: ${version || '버전 미상'})`);
  await registerOne($, PROGRESS_SPEC);
}

// A /graceful-pause request that came after its turn's last model request: a note voids it.
async function voidLateRequest($, late) {
  try {
    await $.session.append(late.row);
  } catch {
    /* nothing more to do: the log line below still tells the person */
  }
  $.ui.log(late.log);
}

export const register = (on) => {
  registerGracefulPause(on);
  registerProgress(on);

  on('session.start', async ($, e, next) => {
    progressReset();
    await registerCommands($);
    return next(e);
  });

  // `/clear` ends the conversation and raises no session.start for the next one.
  on('session.end', async ($, e, next) => {
    pauseReset();
    progressReset();
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    pauseTurnStarted(e);
    progressTurnStarted(e);
    $.ui.invalidate('ui.render');
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const late = pauseTurnCompleted(e);
    if (late) await voidLateRequest($, late);
    progressTurnCompleted(e);
    $.ui.invalidate('ui.render');
    return next(e);
  });
};
