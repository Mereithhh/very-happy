import type { ComponentProps, ReactNode } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import { WorkspaceTabsView } from './WorkspaceTabsView';
export function WorkspaceTabs(props: Omit<ComponentProps<typeof WorkspaceTabsView>, 'zh'>) {
 const {lang}=useTranslation();
 return <WorkspaceTabsView {...props} zh={lang.startsWith('zh')}/>;
}

export function WorkspaceTabsSlot({ render, ...props }: ComponentProps<typeof WorkspaceTabs> & { render?: (props: ComponentProps<typeof WorkspaceTabs>) => ReactNode }) {
  return render ? render(props) : <WorkspaceTabs {...props}/>;
}
