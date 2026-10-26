/**
 * Settings → About (Owner 10-27): version, who built it, the source and where to report
 * an issue. Replaces the old About modal (version + disclaimer only) with real links.
 *
 * Separate file on purpose: SettingsRoutes.tsx is a declared conflict hot-zone —
 * it only gains an import, one <Route> line and the overview <Item> target.
 */
import { Bug, ExternalLink, Github, Info, User } from 'lucide-react';
import { SettingsPage as Page, SettingsHeader as Header } from './SettingsLayout';
import { ItemList, ItemGroup, Item } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { BRAND } from '@/app/brand';
import { AUTHOR_NAME, AUTHOR_URL, NEW_ISSUE_URL, REPO_URL, buildCommitUrl, shortBuildId } from '@/app/attribution';

export function AboutSettings() {
  const { t } = useTranslation();
  const commitUrl = buildCommitUrl(__APP_VERSION__);
  const external = <ExternalLink size={14} aria-hidden />;
  return (
    <Page>
      <Header title={t('settings.about')} />
      <ItemList>
        <ItemGroup settingId="about.project" title={BRAND.name} footer={t('settings.aboutFooter')}>
          <Item
            settingId="about.version"
            title={t('settingsAbout.version')}
            subtitle={t('settingsAbout.versionSubtitle')}
            left={<Info size={18} />}
            right={<><span className="set-value mono" title={__APP_VERSION__}>{shortBuildId(__APP_VERSION__)}</span>{commitUrl && external}</>}
            href={commitUrl ?? undefined}
          />
          <Item
            settingId="about.author"
            title={t('settingsAbout.author')}
            subtitle={t('credit.builtBy')}
            left={<User size={18} />}
            right={<><span className="set-value">{AUTHOR_NAME}</span>{external}</>}
            href={AUTHOR_URL}
          />
          <Item
            settingId="about.source"
            title={t('settingsAbout.source')}
            subtitle={t('settingsAbout.sourceSubtitle')}
            detail={REPO_URL.replace(/^https:\/\//, '')}
            left={<Github size={18} />}
            right={external}
            href={REPO_URL}
          />
          <Item
            settingId="about.issue"
            title={t('settingsAbout.reportIssue')}
            subtitle={t('settingsAbout.reportIssueSubtitle')}
            left={<Bug size={18} />}
            right={external}
            href={NEW_ISSUE_URL}
          />
        </ItemGroup>
      </ItemList>
    </Page>
  );
}
