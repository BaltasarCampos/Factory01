// Which launcher a project's sessions use: the Owner's `agents:` choice in main's config
// (FR-004). Without that choice no session starts at all, because agents in the cloud clone the
// code into provider-managed VMs and the Owner has not consented (AC-002).
import { RefusedError } from '../../cli/env.js';
import type { ProjectConfig } from '../../model/types.js';
import type { Launchers, SessionLauncher } from './types.js';

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
