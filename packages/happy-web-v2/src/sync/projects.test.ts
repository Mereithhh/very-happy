import { describe, expect, it } from 'vitest';
import { ProjectsApiError } from './projectsError';

describe('ProjectsApiError.unavailable (old server / kill switch → group by folder, never an error)', () => {
  it('treats an unknown route and projects_disabled as unavailable', () => {
    expect(new ProjectsApiError(404, 'route_not_found').unavailable).toBe(true);
    expect(new ProjectsApiError(404, 'projects_disabled').unavailable).toBe(true);
  });
  it('a missing project object or any other failure is not "unavailable"', () => {
    expect(new ProjectsApiError(404, 'project_not_found').unavailable).toBe(false);
    expect(new ProjectsApiError(500, 'http_500').unavailable).toBe(false);
    expect(new ProjectsApiError(409, 'instructions_version_conflict').unavailable).toBe(false);
  });
});
