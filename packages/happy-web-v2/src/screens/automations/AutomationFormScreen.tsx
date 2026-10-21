/**
 * B-498 /automations/new and /automations/:id/edit — the one form for both.
 * All field logic lives in automationForm.ts (pure, tested); this file binds
 * inputs, maps error keys to copy and talks to the store. Server-side
 * refusals (name taken, invalid cron/tz, machine not found, stale version)
 * land on the field they belong to.
 */
import { useProjects } from '@/sync/projects';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BackButton } from '@/app/BackButton';
import { Spinner, toast } from '@/ui';
import { Checkbox } from '@/ui/Checkbox';
import { Combobox } from '@/ui/Combobox';
import { Segmented } from '@/ui/Segmented';
import { SelectMenu } from '@/ui/SelectMenu';
import { SuggestInput } from '@/ui/SuggestInput';
import { useTranslation, type TranslationKey } from '@/i18n/useTranslation';
import { useAllMachines, useSetting } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { AutomationsApiError } from '@/sync/apiAutomations';
import { AUTOMATIONS_DETAIL_POLL_MS, useAutomations, useAutomationsPoll } from '@/sync/automationsStore';
import {
  ACTION_KINDS,
  PRECHECK_MODES,
  SPAWN_AGENTS,
  SPAWN_PERMISSION_MODES,
  TRIGGER_KINDS,
  buildCreate,
  buildUpdate,
  cronPreview,
  draftFromAutomation,
  emptyDraft,
  knownTimeZones,
  parseDuration,
  type AutomationDraft,
  type DraftErrors,
  type DraftField,
} from './automationForm';
import { describeInterval, langOf } from './automationPresentation';
import { reportAutomationError } from './AutomationShared';
import './automations.css';

const ERR_KEY: Record<string, TranslationKey> = {
  name: 'automations.errName',
  machine: 'automations.errMachine',
  cron: 'automations.errCron',
  tz: 'automations.errTz',
  interval: 'automations.errInterval',
  once: 'automations.errOnce',
  agent: 'automations.errAgent',
  directory: 'automations.errDirectory',
  prompt: 'automations.errPrompt',
  session: 'automations.errSession',
  script: 'automations.errScript',
  maxRuntime: 'automations.errMaxRuntime',
  precheckCommand: 'automations.errPrecheckCommand',
  precheckTimeout: 'automations.errPrecheckTimeout',
  schema: 'automations.errSchema',
  name_taken: 'automations.errNameTaken',
  invalid_cron: 'automations.errInvalidCron',
  invalid_timezone: 'automations.errInvalidTimezone',
  machine_not_found: 'automations.errMachineNotFound',
  stale: 'automations.errStale',
};

/** `labelId`: the control is a picker button (not labelable by a wrapping <label>) — render a div and name it via aria-labelledby */
function Field({ label, hint, error, children, wide, labelId }: { label: string; hint?: string; error?: string; children: ReactNode; wide?: boolean; labelId?: string }) {
  const Tag = labelId ? 'div' : 'label';
  return (
    <Tag className={`au-field${wide ? ' au-field--wide' : ''}${error ? ' is-error' : ''}`}>
      <span className="au-field-label" id={labelId}>{label}</span>
      {children}
      {error ? <span className="au-field-error">{error}</span> : hint ? <span className="au-field-hint">{hint}</span> : null}
    </Tag>
  );
}

export function AutomationFormScreen() {
  const { id } = useParams();
  const editing = Boolean(id);
  const { t, lang } = useTranslation();
  const zhCopy = lang === 'zh-Hans';
  const projectsSnap = useProjects();
  const l = langOf(lang);
  const navigate = useNavigate();
  const machines = useAllMachines({ includeOffline: true });
  const recentPaths = useSetting('recentMachinePaths');
  const enabled = useAutomations((s) => s.enabled);
  const current = useAutomations((s) => (id ? s.automations.find((a) => a.id === id) ?? null : null));
  const refreshAutomation = useAutomations((s) => s.refreshAutomation);
  const create = useAutomations((s) => s.create);
  const update = useAutomations((s) => s.update);
  const refresh = useCallback(() => (id ? refreshAutomation(id) : Promise.resolve()), [refreshAutomation, id]);
  useAutomationsPoll(refresh, AUTOMATIONS_DETAIL_POLL_MS, editing && !current);

  const [draft, setDraft] = useState<AutomationDraft>(() => emptyDraft());
  const [seeded, setSeeded] = useState(!editing);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [busy, setBusy] = useState(false);
  const timeZones = useMemo(knownTimeZones, []);

  // seed from the loaded automation once; later polls must not clobber typing
  useEffect(() => {
    if (editing && current && !seeded) {
      setDraft(draftFromAutomation(current));
      setSeeded(true);
    }
  }, [editing, current, seeded]);
  // default machine: the first online one (create only)
  useEffect(() => {
    if (!editing && !draft.machineId && machines.length) {
      const online = machines.find(isMachineOnline) ?? machines[0];
      setDraft((d) => ({ ...d, machineId: online.id }));
    }
  }, [editing, draft.machineId, machines]);

  const set = <K extends DraftField>(key: K, value: AutomationDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };
  const err = (key: DraftField) => (errors[key] ? (t(ERR_KEY[errors[key]!] ?? 'automations.errSchema') as string) : undefined);
  const pathsForMachine = useMemo(() => (recentPaths ?? []).filter((p) => p.machineId === draft.machineId).map((p) => p.path), [recentPaths, draft.machineId]);
  const preview = draft.triggerKind === 'cron' ? cronPreview(draft.cronExpr, draft.cronTz, l) : draft.triggerKind === 'interval' && parseDuration(draft.intervalEvery) ? describeInterval(parseDuration(draft.intervalEvery)!, l) : null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (editing && current) {
        const result = buildUpdate(draft, current);
        if (!result.ok) { setErrors(result.errors); return; }
        if (!result.changed) {
          toast.success(t('automations.noChanges') as string);
          navigate(`/automations/${encodeURIComponent(current.id)}`);
          return;
        }
        await update(current.id, result.body);
        toast.success(t('automations.saved') as string);
        navigate(`/automations/${encodeURIComponent(current.id)}`, { replace: true });
      } else {
        const result = buildCreate(draft);
        if (!result.ok) { setErrors(result.errors); return; }
        const created = await create(result.body);
        toast.success(t('automations.created', { name: created.name }) as string);
        navigate(`/automations/${encodeURIComponent(created.id)}`, { replace: true });
      }
    } catch (error) {
      if (error instanceof AutomationsApiError) {
        const map: Record<string, DraftErrors> = {
          automation_name_taken: { name: 'name_taken' },
          invalid_cron: { cronExpr: 'invalid_cron' },
          invalid_timezone: { cronTz: 'invalid_timezone' },
          machine_not_found: { machineId: 'machine_not_found' },
          stale_automation: { name: 'stale' },
        };
        if (map[error.code]) {
          setErrors(map[error.code]);
          if (error.code === 'stale_automation' && id) void refreshAutomation(id);
          return;
        }
      }
      reportAutomationError(error, t);
    } finally {
      setBusy(false);
    }
  };

  const title = editing ? (current ? t('automations.formTitleEdit', { name: current.name }) : t('automations.editAutomation')) : t('automations.formTitleNew');
  let body: ReactNode;
  if (enabled === false) {
    body = <div className="au-error">{t('automations.disabledTitle')}</div>;
  } else if (editing && !seeded) {
    body = (
      <div className="au-loading">
        <Spinner size={14} /> {t('common.loading')}
      </div>
    );
  } else {
    body = (
      <form className="au-form" onSubmit={(e) => void onSubmit(e)} noValidate>
        <fieldset className="au-fieldset">
          <legend className="au-legend">{t('automations.formBasics')}</legend>
          <Field label={t('automations.fieldName') as string} hint={t('automations.fieldNameHint') as string} error={err('name')}>
            <input className="au-input mono" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="daily-work-inventory" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t('automations.fieldMachine') as string} hint={t('automations.fieldMachineHint') as string} error={err('machineId')} labelId="au-field-machine">
            <Combobox
              size="md"
              className="au-picker"
              labelledBy="au-field-machine"
              label={t('automations.fieldMachine') as string}
              placeholder={t('automations.chooseMachine') as string}
              value={draft.machineId}
              onChange={(v) => set('machineId', v)}
              options={machines.map((m) => ({ value: m.id, label: machineLabel(m), meta: isMachineOnline(m) ? undefined : (t('automations.offlineMachine') as string) }))}
            />
          </Field>
          {projectsSnap.status === 'ready' && (draft.actionKind === 'spawn' || draft.projectId) && (
            <Field label={zhCopy ? '项目' : 'Project'} hint={zhCopy ? '这个自动化新开的会话进入该项目（安静模式：只拿说明，不主动发消息、不写记录）' : 'Sessions this automation starts join the project (quiet: they get its instructions but do not message others or write notes)'} labelId="au-field-project">
              <Combobox
                size="md"
                className="au-picker"
                labelledBy="au-field-project"
                label={zhCopy ? '项目' : 'Project'}
                value={draft.projectId}
                onChange={(v) => set('projectId', v)}
                options={[
                  { value: '', label: zhCopy ? '无项目' : 'No project' },
                  ...projectsSnap.projects.filter((p) => !p.archivedAt || p.id === draft.projectId).map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </Field>
          )}
          <Field label={t('automations.fieldDescription') as string} wide>
            <input className="au-input" value={draft.description} onChange={(e) => set('description', e.target.value)} maxLength={4000} />
          </Field>
        </fieldset>

        <fieldset className="au-fieldset">
          <legend className="au-legend">{t('automations.formTrigger')}</legend>
          <div className="au-choice" role="radiogroup" aria-label={t('automations.formTrigger') as string}>
            {TRIGGER_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={draft.triggerKind === kind}
                className={`au-choice-btn${draft.triggerKind === kind ? ' is-on' : ''}`}
                onClick={() => set('triggerKind', kind)}
              >
                {t(kind === 'cron' ? 'automations.triggerCron' : kind === 'interval' ? 'automations.triggerInterval' : kind === 'once' ? 'automations.triggerOnce' : 'automations.triggerManual')}
              </button>
            ))}
          </div>
          {draft.triggerKind === 'cron' && (
            <>
              <Field label={t('automations.fieldCron') as string} hint={preview ?? (t('automations.fieldCronHint') as string)} error={err('cronExpr')}>
                <input className="au-input mono" value={draft.cronExpr} onChange={(e) => set('cronExpr', e.target.value)} placeholder="0 9 * * 1-5" autoComplete="off" spellCheck={false} />
              </Field>
              <Field label={t('automations.fieldTz') as string} error={err('cronTz')}>
                <SuggestInput className="au-input mono" aria-label={t('automations.fieldTz') as string} value={draft.cronTz} onValueChange={(v) => set('cronTz', v)} suggestions={timeZones} placeholder="Asia/Singapore" spellCheck={false} />
              </Field>
            </>
          )}
          {draft.triggerKind === 'interval' && (
            <Field label={t('automations.fieldEvery') as string} hint={preview ?? (t('automations.fieldEveryHint') as string)} error={err('intervalEvery')}>
              <input className="au-input mono" value={draft.intervalEvery} onChange={(e) => set('intervalEvery', e.target.value)} placeholder="15m" autoComplete="off" />
            </Field>
          )}
          {draft.triggerKind === 'once' && (
            <Field label={t('automations.fieldAt') as string} hint={t('automations.fieldAtHint') as string} error={err('onceAt')}>
              <input className="au-input mono" type="datetime-local" value={draft.onceAt} onChange={(e) => set('onceAt', e.target.value)} />
            </Field>
          )}
          {draft.triggerKind === 'manual' && <p className="au-field-hint au-field--wide">{t('automations.triggerManualHint')}</p>}
        </fieldset>

        <fieldset className="au-fieldset">
          <legend className="au-legend">{t('automations.formAction')}</legend>
          <div className="au-choice" role="radiogroup" aria-label={t('automations.formAction') as string}>
            {ACTION_KINDS.map((kind) => (
              <button key={kind} type="button" role="radio" aria-checked={draft.actionKind === kind} className={`au-choice-btn${draft.actionKind === kind ? ' is-on' : ''}`} onClick={() => set('actionKind', kind)}>
                {t(kind === 'spawn' ? 'automations.actionSpawn' : kind === 'send' ? 'automations.actionSend' : 'automations.actionScript')}
              </button>
            ))}
          </div>
          <p className="au-field-hint au-field--wide">
            {t(draft.actionKind === 'spawn' ? 'automations.actionSpawnHint' : draft.actionKind === 'send' ? 'automations.actionSendHint' : 'automations.actionScriptHint')}
          </p>
          {draft.actionKind === 'spawn' && (
            <>
              <Field label={t('automations.fieldAgent') as string} error={err('agent')} labelId="au-field-agent">
                <SelectMenu
                  size="md"
                  className="au-picker"
                  labelledBy="au-field-agent"
                  label={t('automations.fieldAgent') as string}
                  value={draft.agent}
                  onChange={(v) => set('agent', v)}
                  options={SPAWN_AGENTS.map((a): { value: string; label: string } => ({ value: a, label: a }))}
                />
              </Field>
              <Field label={t('automations.fieldDirectory') as string} hint={t('automations.fieldDirectoryHint') as string} error={err('directory')}>
                <SuggestInput className="au-input mono" aria-label={t('automations.fieldDirectory') as string} value={draft.directory} onValueChange={(v) => set('directory', v)} suggestions={pathsForMachine} placeholder="~/project" spellCheck={false} />
              </Field>
              <Field label={t('automations.fieldModel') as string} hint={t('automations.fieldModelHint') as string}>
                <input className="au-input mono" value={draft.model} onChange={(e) => set('model', e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label={t('automations.fieldPermissionMode') as string} labelId="au-field-permission">
                <SelectMenu
                  size="md"
                  className="au-picker"
                  labelledBy="au-field-permission"
                  label={t('automations.fieldPermissionMode') as string}
                  value={draft.permissionMode}
                  onChange={(v) => set('permissionMode', v)}
                  options={SPAWN_PERMISSION_MODES.map((m): { value: string; label: string } => ({ value: m, label: m || (t('automations.fieldPermissionDefault') as string) }))}
                />
              </Field>
              <Field label={t('automations.fieldStickyKey') as string} hint={t('automations.fieldStickyKeyHint') as string}>
                <input className="au-input mono" value={draft.stickyKey} onChange={(e) => set('stickyKey', e.target.value)} placeholder="conv-{{payload.conversationId}}" autoComplete="off" spellCheck={false} />
              </Field>
              <Checkbox className="au-check" checked={draft.worktree} onCheckedChange={(v) => set('worktree', v)}>
                {t('automations.fieldWorktree')}
              </Checkbox>
              <Field label={t('automations.fieldPrompt') as string} hint={t('automations.fieldPromptHint') as string} error={err('prompt')} wide>
                <textarea className="au-input au-textarea" value={draft.prompt} onChange={(e) => set('prompt', e.target.value)} rows={6} maxLength={32000} />
              </Field>
            </>
          )}
          {draft.actionKind === 'send' && (
            <>
              <Field label={t('automations.fieldSession') as string} error={err('sendSessionId')}>
                <input className="au-input mono" value={draft.sendSessionId} onChange={(e) => set('sendSessionId', e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label={t('automations.fieldPrompt') as string} hint={t('automations.fieldPromptHint') as string} error={err('prompt')} wide>
                <textarea className="au-input au-textarea" value={draft.prompt} onChange={(e) => set('prompt', e.target.value)} rows={6} maxLength={32000} />
              </Field>
            </>
          )}
          {draft.actionKind === 'script' && (
            <>
              <Field label={t('automations.fieldCommand') as string} hint={t('automations.fieldCommandHint') as string} error={err('scriptCommand')} wide>
                <input className="au-input mono" value={draft.scriptCommand} onChange={(e) => set('scriptCommand', e.target.value)} placeholder='python3 sync.py --since "15 min"' autoComplete="off" spellCheck={false} />
              </Field>
              <Field label={t('automations.fieldCwd') as string}>
                <input className="au-input mono" value={draft.scriptCwd} onChange={(e) => set('scriptCwd', e.target.value)} autoComplete="off" spellCheck={false} />
              </Field>
            </>
          )}
        </fieldset>

        <fieldset className="au-fieldset">
          <legend className="au-legend">{t('automations.formPrecheck')}</legend>
          <Checkbox className="au-check au-field--wide" checked={draft.precheckEnabled} onCheckedChange={(v) => set('precheckEnabled', v)}>
            {t('automations.precheckEnable')}
          </Checkbox>
          <p className="au-field-hint au-field--wide">{t('automations.precheckEnableHint')}</p>
          {draft.precheckEnabled && (
            <>
              <div className="au-choice au-field--wide" role="radiogroup" aria-label={t('automations.formPrecheck') as string}>
                {PRECHECK_MODES.map((mode) => (
                  <button key={mode} type="button" role="radio" aria-checked={draft.precheckMode === mode} className={`au-choice-btn${draft.precheckMode === mode ? ' is-on' : ''}`} onClick={() => set('precheckMode', mode)}>
                    {t(mode === 'shell' ? 'automations.precheckModeShell' : 'automations.precheckModeArgv')}
                  </button>
                ))}
              </div>
              <Field
                label={t('automations.fieldPrecheckCommand') as string}
                hint={t(draft.precheckMode === 'shell' ? 'automations.fieldPrecheckShellHint' : 'automations.fieldPrecheckArgvHint') as string}
                error={err('precheckCommand')}
                wide
              >
                <input
                  className="au-input mono"
                  value={draft.precheckCommand}
                  onChange={(e) => set('precheckCommand', e.target.value)}
                  placeholder={draft.precheckMode === 'shell' ? 'test -s ~/inbox/new.json' : './has-new-messages --since 5m'}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label={t('automations.fieldPrecheckCwd') as string} hint={t('automations.fieldPrecheckCwdHint') as string}>
                <input className="au-input mono" value={draft.precheckCwd} onChange={(e) => set('precheckCwd', e.target.value)} placeholder="~/project" autoComplete="off" spellCheck={false} />
              </Field>
              <Field label={t('automations.fieldPrecheckTimeout') as string} hint={t('automations.fieldPrecheckTimeoutHint') as string} error={err('precheckTimeout')}>
                <input className="au-input mono" value={draft.precheckTimeout} onChange={(e) => set('precheckTimeout', e.target.value)} placeholder="60s" autoComplete="off" />
              </Field>
              {draft.actionKind !== 'script' && (
                <Checkbox className="au-check" checked={draft.precheckIncludeOutput} onCheckedChange={(v) => set('precheckIncludeOutput', v)}>
                  {t('automations.fieldPrecheckIncludeOutput')}
                </Checkbox>
              )}
            </>
          )}
        </fieldset>

        <fieldset className="au-fieldset">
          <legend className="au-legend">{t('automations.formLimits')}</legend>
          <Field label={t('automations.fieldConcurrency') as string} labelId="au-field-concurrency">
            <Segmented<'skip' | 'queue'>
              className="au-segmented"
              labelledBy="au-field-concurrency"
              value={draft.concurrency}
              onChange={(v) => set('concurrency', v)}
              options={[
                { value: 'skip', label: t('automations.concurrencySkipLabel') as string },
                { value: 'queue', label: t('automations.concurrencyQueueLabel') as string },
              ]}
            />
          </Field>
          <Field label={t('automations.fieldMaxRuntime') as string} hint={t('automations.fieldMaxRuntimeHint') as string} error={err('maxRuntime')}>
            <input className="au-input mono" value={draft.maxRuntime} onChange={(e) => set('maxRuntime', e.target.value)} placeholder="6h" autoComplete="off" />
          </Field>
        </fieldset>

        <div className="au-form-actions">
          <button type="button" className="au-btn" onClick={() => navigate(editing && id ? `/automations/${encodeURIComponent(id)}` : '/automations')}>
            {t('automations.cancel')}
          </button>
          <button type="submit" className="au-btn au-btn--primary" disabled={busy} aria-busy={busy}>
            {busy ? <Spinner size={12} color="var(--bg-0)" /> : null} {editing ? t('automations.saveChanges') : t('automations.create')}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="au">
      <header className="au-header">
        <BackButton />
        <span className="au-title">{title}</span>
      </header>
      <div className="au-body">{body}</div>
    </div>
  );
}
