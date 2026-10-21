/**
 * DEV-only (B-714): SelectMenu / Combobox / Checkbox / Summary on fixtures,
 * for browser checks of keyboard, sheet, themes and 44px targets.
 * /dev/picker?theme=dark
 */
import { Plus } from 'lucide-react';
import React from 'react';
import { Checkbox, Combobox, SelectMenu, Summary, type SelectOption } from '@/ui';

const MACHINES: SelectOption[] = [
    { value: 'm1', label: 'build-box', meta: 'online' },
    { value: 'm2', label: 'mac-office', disabled: true, description: 'offline · 2h ago' },
    { value: 'm3', label: 'dev-sg', meta: 'online' },
];
const BRANCHES: SelectOption[] = Array.from({ length: 200 }, (_, i) => ({ value: `b${i}`, label: i === 0 ? 'main' : i === 42 ? 'team/B-714-select-components' : `feature/topic-${i}` }));
const MODELS: SelectOption[] = [
    { value: 'default', label: 'Default', description: 'Follow the CLI setting' },
    { value: 'opus', label: 'claude-opus-5-5', group: 'Catalog', meta: 'default' },
    { value: 'sonnet', label: 'claude-sonnet-5-5', group: 'Catalog' },
    { value: 'haiku', label: 'claude-haiku-5-5', group: 'Catalog' },
    { value: 'mine', label: 'my-gateway/opus', group: 'Custom' },
];
const AGENTS: SelectOption[] = [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'pi', label: 'pi' },
];

const row = { display: 'grid', gap: 'var(--sp-2)', minWidth: 0 } as const;
const label = { color: 'var(--text-dim)', fontSize: 'var(--fs-12)', fontWeight: 600 } as const;

export function PickerHarness() {
    React.useEffect(() => {
        const theme = new URLSearchParams(window.location.search).get('theme');
        if (theme) document.documentElement.dataset.theme = theme;
    }, []);
    const [machine, setMachine] = React.useState<string | null>('m1');
    const [branch, setBranch] = React.useState<string | null>('b0');
    const [model, setModel] = React.useState<string | null>('opus');
    const [agent, setAgent] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [checked, setChecked] = React.useState(true);
    const [submitted, setSubmitted] = React.useState('');
    return (
        <main style={{ minHeight: '100dvh', padding: 'var(--sp-5) var(--sp-4)', background: 'var(--bg-0)', color: 'var(--text)' }}>
            <div style={{ display: 'grid', gap: 'var(--sp-5)', width: 'min(560px, 100%)', margin: '0 auto' }} data-testid="picker-harness">
                <div style={row}>
                    <span style={label} id="h-machine">Machine (SelectMenu)</span>
                    <SelectMenu labelledBy="h-machine" label="Machine" options={MACHINES} value={machine} onChange={setMachine} size="md" />
                </div>
                <div style={row}>
                    <span style={label} id="h-branch">Base branch (Combobox, 200)</span>
                    <Combobox labelledBy="h-branch" label="Base branch" options={BRANCHES} value={branch} onChange={setBranch} size="md" />
                </div>
                <div style={row}>
                    <span style={label} id="h-model">Model (groups + action, busy)</span>
                    <Combobox labelledBy="h-model" label="Model" options={MODELS} value={model} busy={busy}
                        onChange={(v) => { setModel(v); setBusy(true); window.setTimeout(() => setBusy(false), 1200); }}
                        actions={[{ key: 'new', label: 'Custom model…', icon: Plus, onSelect: () => undefined }]} size="md" />
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
                    <SelectMenu variant="chip" label="Agent" placeholder="Agent" options={AGENTS} value={agent} onChange={setAgent} />
                    <SelectMenu variant="soft" label="Machine" options={MACHINES} value={machine} onChange={setMachine} />
                    <Combobox variant="chip" label="Provider" placeholder="Provider" options={[]} value={null} onChange={() => undefined} loading />
                    <Combobox variant="chip" label="Branch" placeholder="Branch" options={[]} value={null} onChange={() => undefined} error="git branch failed" onRetry={() => undefined} />
                    <SelectMenu label="Disabled" options={AGENTS} value="codex" onChange={() => undefined} disabled />
                </div>
                <form style={row} onSubmit={(e) => { e.preventDefault(); setSubmitted(String(new FormData(e.currentTarget).get('assistant'))); }}>
                    <span style={label} id="h-form">Form (name=assistant, required)</span>
                    <SelectMenu labelledBy="h-form" label="Coding agent" name="assistant" required placeholder="Choose" options={AGENTS} value={agent} onChange={setAgent} size="md" />
                    <Checkbox checked={checked} onCheckedChange={setChecked}>Push after commit</Checkbox>
                    <button type="submit" className="vh-btn" data-testid="h-submit">Submit</button>
                    <output data-testid="h-out">{submitted}</output>
                </form>
                <details>
                    <Summary>Advanced</Summary>
                    <p style={{ color: 'var(--text-dim)' }}>Collapsed body.</p>
                </details>
            </div>
        </main>
    );
}
