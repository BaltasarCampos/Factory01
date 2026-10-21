// Which launcher a project's sessions use: the Owner's `agents:` choice in main's config
// (FR-004). Without that choice no session starts at all, because agents in the cloud clone the
// code into provider-managed VMs and the Owner has not consented (AC-002).
import { homedir } from 'node:os';
import { factorySource, laptopKeys } from '../../approvals/keys.js';
import { RefusedError } from '../../cli/env.js';
import type { ProjectConfig } from '../../model/types.js';
import { verifiedManifest } from '../../release/tag.js';
import { CloudLauncher } from './cloud.js';
import { LocalLauncher } from './local.js';
import type { Launchers, SessionLauncher } from './types.js';

/**
 * The launchers every command uses unless a test passes its own (T159): sessions run locally
 * (once the release ships the guards, slice 28) or in the cloud (once T125 confirms the command).
 */
export function defaultLaunchers(env: NodeJS.ProcessEnv): Launchers {
  const home = env.HOME ?? homedir();
  const local = new LocalLauncher({
    home,
    env,
    // The release's own tag, verified with the laptop's own key lists before its hashes are
    // used; the launcher runs only on the laptop, and the release's own lists would vouch for
    // themselves.
    release: (pin) => verifiedManifest(factorySource(env), pin, laptopKeys(home)),
  });
  return { local, cloud: new CloudLauncher() };
}

export function selectLauncher(
  config: Pick<ProjectConfig, 'repo' | 'agents'>,
  launchers: Launchers,
): SessionLauncher {
  const mode = config.agents;
  if (mode === undefined)
    throw new RefusedError(
      `no session started for ${config.repo}: .factory/config on main has no agents setting, ` +
        'so the Owner has not chosen whether agents may clone the code into provider-managed ' +
        'cloud VMs; run `factory config set agents cloud` or `factory config set agents local`',
    );
  const launcher = launchers[mode];
  if (launcher === undefined)
    throw new RefusedError(`no ${mode} launcher is configured for ${config.repo}`);
  return launcher;
}
