/**
 * B-974e: what to do when a plugin's machine (or a session on it) was signed in
 * with the old CLI credentials — no data key, so the server cannot relay the
 * panel (`502 machine_unsupported`) and refuses widgets on its sessions.
 *
 * The fix is a fresh sign-in, which gives the computer a new machine id; the
 * install is bound to the old id, so the plugin is removed and added again.
 * Order matters: `plugin remove` first (still signed in as the old machine, so
 * the server drops the old install too, and the local files that would make a
 * later `add` answer `already_installed` are gone).
 */
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { Button } from '@/ui';
import { CopyButton } from '@/ui/CopyButton';
import type { PluginInstallView } from './pluginTypes';

/** The commands, in order. Pure so the notice and its test agree. */
export function legacyFixCommands(pluginId: string): string[] {
  return [
    `very-happy plugin remove ${pluginId}`,
    'very-happy auth login --force',
    'very-happy daemon start',
    'very-happy plugin add <manifest>',
  ];
}

export function LegacyCredentialsNotice({ install, machineName, compact }: { install: Pick<PluginInstallView, 'id' | 'pluginId' | 'name'>; machineName: string | null; compact?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const commands = legacyFixCommands(install.pluginId);
  const steps = [t('plugins.legacy.stepRemove'), t('plugins.legacy.stepLogin'), t('plugins.legacy.stepDaemon'), t('plugins.legacy.stepAdd')];
  return (
    <div className="plg-legacy" data-compact={compact ? '' : undefined} data-testid="plugin-legacy-notice" role="status">
      <p className="plg-legacy-lead">{t('plugins.legacy.title', { machine: machineName ?? t('plugins.unknownMachine') })}</p>
      {!compact && <p className="plg-legacy-why">{t('plugins.legacy.why')}</p>}
      <p className="plg-legacy-how">{t('plugins.legacy.how')}</p>
      <ol className="plg-legacy-steps">
        {commands.map((cmd, i) => (
          <li key={cmd}>
            <span className="plg-legacy-step">{steps[i]}</span>
            <span className="plg-legacy-cmd">
              <code>{cmd}</code>
              <CopyButton text={cmd} size={13} />
            </span>
          </li>
        ))}
      </ol>
      <p className="plg-legacy-note">{t('plugins.legacy.note')}</p>
      {!compact && (
        <Button size="sm" variant="secondary" onClick={() => navigate(`/settings/plugins/${encodeURIComponent(install.id)}`)}>
          {t('plugins.title')}
        </Button>
      )}
    </div>
  );
}
