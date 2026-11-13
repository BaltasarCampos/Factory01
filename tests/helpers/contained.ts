// A factory side of its own for tests/contract/contain.test.ts (T061): it starts SCRIPT as the
// launcher starts a session's claude, through runProcess in CONTAIN's bubblewrap and a process group
// of its own, with FACTORY_SESSION set, prints the group's id and waits, so the test can SIGKILL it.
import { CONTAIN, runProcess } from '../../src/dispatcher/launcher/local.js';

const env = { PATH: process.env.PATH ?? '', FACTORY_SESSION: process.env.SESSION ?? '' };
void runProcess('sh', ['-c', process.env.SCRIPT ?? ''], {
  ...{ cwd: '/', env, group: true, contain: CONTAIN },
  started: (pgid) => process.stdout.write(`${String(pgid)}\n`),
});
