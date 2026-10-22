import { useRef, useState } from 'react';
import type { TeamState } from '@slopus/happy-wire';
import { bindTeamProject, TeamsApiError } from '@/sync/teams';
import { refreshProjects } from '@/sync/projects';
import { toast } from '@/ui/Toast';
import type { ProjectChoice } from '@/screens/projects/projectChoice';

/**
 * B-726: the one way a team's project changes — bind / create same-name /
 * detach, then refresh the shared projects snapshot. Used by the team page
 * (nudge, settings) and, since B-763, by 「换项目…」 in the team row and team
 * page menus. Resolves true when the server accepted the change.
 */
export function useTeamProjectBind(team: Pick<TeamState, 'id'>, msgs: { failed: string; unsupported: string }) {
  const [busy, setBusy] = useState(false);
  const createRequest = useRef<string>('');
  const bind = async (choice: ProjectChoice): Promise<boolean> => {
    setBusy(true);
    try {
      if (choice.kind === 'new') {
        createRequest.current ||= crypto.randomUUID();
        await bindTeamProject(team.id, { create: true, requestId: createRequest.current });
        createRequest.current = '';
      } else {
        await bindTeamProject(team.id, { projectId: choice.kind === 'existing' ? choice.projectId : null });
      }
      await refreshProjects();
      return true;
    } catch (error) {
      toast.error(error instanceof TeamsApiError && error.status === 404 && error.code.startsWith('http_') ? msgs.unsupported : msgs.failed);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, bind };
}
