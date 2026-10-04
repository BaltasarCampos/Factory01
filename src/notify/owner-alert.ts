// Urgent alerts fail the project's owner-alert workflow (factory/workflows/owner-alert.yml) on
// purpose: a failed run is what makes GitHub email the Owner (FR-034a, research R10).
import { gh, repoArg, type GhOptions } from '../github/gh.js';

export const OWNER_ALERT_WORKFLOW = 'owner-alert.yml';

export async function triggerOwnerAlert(
  repo: string,
  alertId: string,
  options: GhOptions = {},
): Promise<void> {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(alertId)) throw new Error(`invalid alert id ${alertId}`);
  const args = ['workflow', 'run', OWNER_ALERT_WORKFLOW, '--repo', repoArg(repo)];
  await gh([...args, '-f', `alert_id=${alertId}`], options);
}
