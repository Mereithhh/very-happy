import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getPublicDoc, INSTALL_COMMAND, LOGIN_COMMAND, PUBLIC_DOCS } from './publicContent';
import { getProductPreviewIds } from './productPreviewIds';

describe('public documentation registry', () => {
  it('provides every public-release topic with unique stable slugs', () => {
    expect(new Set(PUBLIC_DOCS.map((doc) => doc.slug)).size).toBe(PUBLIC_DOCS.length);
    expect(PUBLIC_DOCS.map((doc) => doc.slug)).toEqual(expect.arrayContaining([
      'quickstart', 'keyboard', 'cli', 'cloud', 'self-hosting', 'configuration', 'architecture',
      'integrations', 'security', 'accounts-and-quotas', 'upgrades', 'troubleshooting', 'contributing',
    ]));
  });

  it('keeps onboarding commands and trust disclosure in the published content', () => {
    const text = JSON.stringify(PUBLIC_DOCS);
    expect(text).toContain(INSTALL_COMMAND);
    expect(text).toContain(LOGIN_COMMAND);
    expect(text).toContain('not end-to-end encrypted');
    expect(text).toContain('server-trusted');
    expect(text).toContain('very-happy openclaw');
    expect(text).toContain('OpenClaw uses its own local gateway protocol, not ACP');
    expect(text).toContain('very-happy install-terminal-hooks --remove');
    expect(text).toContain('~/.claude/settings.json');
    expect(text).toContain('3. Configure Claude credentials');
    expect(text).toContain('6. Start the machine daemon');
    expect(text).toContain('ANTHROPIC_API_KEY');
    expect(text).toContain('credential source captured at daemon startup');
    expect(text).toContain('This starts a detached background process');
    expect(text).toContain('Required: Node.js 20.19+ within 20.x, 22.13+ within 22.x, or 24+, with npm');
    expect(text).toContain('very-happy doctor');
    expect(text).toContain('upstream-owned happy-server-self-host');
    expect(text).toContain('Provider credentials stay agent-local by default');
    expect(text).toContain('very-happy connect');
    expect(text).toContain("Upstream Happy's core Claude flow");
    expect(text).toContain('tmux keeps the real TTY/TUI alive');
    expect(text).toContain('This mirror is Claude-specific');
    expect(text).toContain('tmux 3.2 or newer');
    expect(text).toContain('non-persistent direct-shell fallback');
    expect(text).toContain('Home Screen');
    expect(text).toContain('native install dialog');
  });

  it('documents the exact tmux and endpoint degradation boundaries', () => {
    const text = JSON.stringify(PUBLIC_DOCS);
    expect(text).toContain('Without it, terminals use a non-durable direct shell');
    expect(text).toContain('HAPPY_SERVER_URL selects the API and socket relay');
    expect(text).toContain('HAPPY_WEBAPP_URL selects the browser origin');
    expect(text).toContain('The daemon inherits its environment at startup');
    expect(text).toContain('Use a separate HAPPY_HOME_DIR for each relay');
  });

  it('anchors the public keyboard story to shipped chords and browser boundaries', () => {
    const text = JSON.stringify(PUBLIC_DOCS);
    const landing = readFileSync(new URL('./LandingScreen.tsx', import.meta.url), 'utf8');
    const docs = readFileSync(new URL('./DocsScreen.tsx', import.meta.url), 'utf8');
    const proof = readFileSync(new URL('./KeyboardWorkflowProof.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('./keyboardWorkflowProof.css', import.meta.url), 'utf8');
    const commandPalette = readFileSync(new URL('../command/CommandPalette.tsx', import.meta.url), 'utf8');
    const newTerminal = readFileSync(new URL('../../app/newTerminal.ts', import.meta.url), 'utf8');
    const closeGuard = readFileSync(new URL('../../app/closeGuard.ts', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../../../../../README.md', import.meta.url), 'utf8');
    const keyboardDoc = readFileSync(new URL('../../../../../docs/keyboard-shortcuts.md', import.meta.url), 'utf8');
    expect(text).toContain('Command K on macOS or Ctrl K on Windows and Linux');
    expect(text).toContain('Ctrl W remains browser/window behavior');
    expect(text).not.toContain('non-macOS installed PWAs use the platform Ctrl app chord');
    expect(landing).toContain('<KeyboardWorkflowProof />');
    expect(docs).toContain('<KeyboardWorkflowProof compact />');
    expect(proof).toContain("import '../command/commandpalette.css'");
    expect(proof).toContain('className="cp-panel"');
    expect(proof).toContain('ime.isGuarded(event)');
    expect(proof).toContain('PUBLIC_COMMAND_PROOF_EVENT');
    expect(proof).not.toContain("window.addEventListener('keydown'");
    expect(proof).toContain('role="combobox"');
    expect(proof).toContain('aria-activedescendant={activeItemId}');
    expect(proof).toContain('role="listbox"');
    expect(proof).toContain('role="option"');
    expect(proof).toContain('aria-selected={index === active}');
    expect(proof).toContain("reducedMotion ? 'auto' : 'smooth'");
    expect(proof).toContain('window.clearTimeout(summonTimerRef.current)');
    expect(proof).toContain('sidebar search button opens the same command surface');
    expect(proof).not.toMatch(/@\/sync\//);
    expect(proof).not.toMatch(/@\/auth\//);
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toMatch(/\.kwp-palette \.cp-panel[^}]*max-height/);
    expect(styles).toContain('container: keyboard-workflow / inline-size');
    expect(styles).toMatch(/@container keyboard-workflow \(max-width: 880px\)[\s\S]*\.kwp-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(styles).not.toMatch(/@container keyboard-workflow[^}]*\.kwp \{ grid-template-columns/);
    expect(styles).toMatch(/@container keyboard-workflow \(max-width: 560px\)[\s\S]*\.kwp-palette \{ transform: none; \}/);
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(styles).not.toContain('var(--accent-glow)');
    expect(styles).not.toContain('var(--accent-2)');
    expect(commandPalette).toContain('isAppChord(e)');
    expect(commandPalette).toContain("IS_MAC ? '⌘J' : 'Ctrl+J'");
    expect(newTerminal).toContain("IS_MAC ? '⌘N · ⌥N' : 'Ctrl+N · Alt+N'");
    expect(newTerminal).toContain('isAppChord(e)');
    expect(newTerminal).toContain('const altN =');
    expect(closeGuard).toContain('const cmdW = e.metaKey');
    expect(closeGuard).not.toContain('const cmdW = e.ctrlKey');
    expect(readme).toContain('keyboard and touch reference');
    expect(keyboardDoc).toContain('Normal browser tabs reserve `Command/Ctrl+N` and `Command/Ctrl+W`');
    expect(keyboardDoc).toContain('`Ctrl+N` outside editable/terminal input');
    expect(keyboardDoc).not.toContain('All global shortcuts are guarded during IME composition');
    const productPreview = readFileSync(new URL('./ProductWorkspacePreview.tsx', import.meta.url), 'utf8');
    expect(productPreview).toContain('window.dispatchEvent(new Event(PUBLIC_COMMAND_PROOF_EVENT))');
    expect(productPreview).toContain('aria-label="Search actions, chats, and terminals" onClick={onSearch}');
  });

  it('resolves known slugs and rejects unknown routes', () => {
    expect(getPublicDoc('quickstart')?.label).toBe('Quick start');
    expect(getPublicDoc('missing')).toBeUndefined();
  });

  it('keeps public positioning honest about shipped agents and roadmap', () => {
    const landing = readFileSync(new URL('./LandingScreen.tsx', import.meta.url), 'utf8');
    const productPreview = readFileSync(new URL('./ProductWorkspacePreview.tsx', import.meta.url), 'utf8');
    const featureProofs = readFileSync(new URL('./CoreFeatureProofs.tsx', import.meta.url), 'utf8');
    const continuityProof = readFileSync(new URL('./MobileContinuityProof.tsx', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    expect(landing).toContain('Work anywhere.');
    expect(landing).toContain('Claude Code');
    expect(landing).toContain('Codex');
    expect(landing).toContain('Gemini + OpenCode via ACP');
    expect(landing).toContain('BETA · IMPLEMENTED');
    expect(landing).not.toContain('ACP extensible');
    expect(landing).toContain('Pi + provider gateway');
    expect(landing).toContain('THE REAL PRODUCT UI');
    expect(landing).toContain('From zero to a live agent in six steps.');
    expect(landing).toContain('<h3>Configure the agent</h3>');
    expect(landing).toContain('<h3>Start the daemon</h3>');
    expect(landing).toContain('Node 20.19+ within 20.x, 22.13+ within 22.x, or 24+ is required');
    expect(landing).toContain('tmux is recommended for durable terminals');
    expect(landing).toContain('STRUCTURED WHEN YOU WANT IT.');
    expect(landing).toContain('THE REAL TUI WHEN YOU NEED IT.');
    expect(continuityProof).toContain('STRUCTURED WHEN YOU WANT IT // NATIVE WHEN YOU NEED IT');
    expect(continuityProof).toContain('REAL TUI · TMUX-BACKED');
    expect(continuityProof).toContain('CLAUDE · STRUCTURED MIRROR');
    expect(productPreview).toContain('terminal and files');
    expect(productPreview).toContain('Open task board');
    expect(productPreview).toContain('Optional terminal hooks installed');
    expect(productPreview).not.toContain('Sanitized Codex terminal');
    expect(productPreview).toContain('Task board');
    expect(featureProofs).toContain('The coordinator is a Claude meta-agent session on one selected machine');
    expect(featureProofs).toContain('Automatic cross-machine or cross-provider routing is roadmap');
    expect(featureProofs).toContain('REQUIRES VOICE CONFIGURATION');
    expect(landing).toContain('You get to be Very Happy.');
    expect(landing).not.toContain('private Tanka deployment');
    expect(landing).toContain('ROADMAP');
    expect(landing).toContain('not end-to-end encrypted');
    expect(html).toContain('Work anywhere. Keep the thread.');
    expect(html).not.toContain('Claude Code, from any browser.');
  });

  it('keeps the SDK and tmux dual-path copy aligned with shipped transport boundaries', () => {
    const cliPackage = readFileSync(new URL('../../../../happy-cli/package.json', import.meta.url), 'utf8');
    const sdkQuery = readFileSync(new URL('../../../../happy-cli/src/claude/sdk/query.ts', import.meta.url), 'utf8');
    const terminalControl = readFileSync(new URL('../../../../happy-cli/src/terminal/controlClient.ts', import.meta.url), 'utf8');
    const terminalManager = readFileSync(new URL('../../../../happy-cli/src/terminal/webTerminal.ts', import.meta.url), 'utf8');
    const terminalTests = readFileSync(new URL('../../../../happy-cli/src/terminal/webTerminal.test.ts', import.meta.url), 'utf8');
    const mirrorManager = readFileSync(new URL('../../../../happy-cli/src/mirror/mirrorManager.ts', import.meta.url), 'utf8');
    const architecture = readFileSync(new URL('../../../../../docs/architecture.md', import.meta.url), 'utf8');
    expect(cliPackage).toContain('@anthropic-ai/claude-agent-sdk');
    expect(sdkQuery).toContain('query as sdkQuery');
    expect(terminalControl).toContain('tmux -C attach-session -t vh-<id>');
    expect(terminalControl).toContain("['-C', 'attach-session', '-t'");
    expect(terminalManager).toContain("import { ControlClient } from './controlClient'");
    expect(terminalManager).toContain('No-tmux fallback');
    expect(terminalManager).toContain('tmux ≥3.2');
    expect(terminalTests).toContain('accepts tmux ≥3.2');
    expect(terminalTests).toContain('rejects older tmux and unparseable output');
    expect(mirrorManager).toContain("spawnSync('tmux', ['has-session'");
    expect(architecture).toContain('Two Claude interaction paths');
    expect(architecture).toContain('not a screenshot or a browser reimplementation');
  });

  it('backs the public ACP claim with the shipped SDK, routes, and compatibility boundary', () => {
    const landing = readFileSync(new URL('./LandingScreen.tsx', import.meta.url), 'utf8');
    const cliPackage = readFileSync(new URL('../../../../happy-cli/package.json', import.meta.url), 'utf8');
    const cliIndex = readFileSync(new URL('../../../../happy-cli/src/index.ts', import.meta.url), 'utf8');
    const acpConfig = readFileSync(new URL('../../../../happy-cli/src/agent/acp/acpAgentConfig.ts', import.meta.url), 'utf8');
    const openClawBackend = readFileSync(new URL('../../../../happy-cli/src/openclaw/OpenClawBackend.ts', import.meta.url), 'utf8');
    const protocolDoc = readFileSync(new URL('../../../../../docs/session-protocol.md', import.meta.url), 'utf8');
    expect(cliPackage).toContain('@agentclientprotocol/sdk');
    expect(cliIndex).toContain("subcommand === 'acp'");
    expect(cliIndex).toContain("subcommand === 'gemini'");
    expect(cliIndex).toContain("subcommand === 'openclaw'");
    expect(cliIndex).toContain('very-happy install-terminal-hooks');
    expect(cliIndex).toContain('parseTerminalHooksArgs(args.slice(1))');
    expect(acpConfig).toContain("gemini: { command: 'gemini'");
    expect(acpConfig).toContain("opencode: { command: 'opencode'");
    expect(openClawBackend).toContain('Unlike ACP-based backends, OpenClaw uses its own protocol');
    expect(landing).toContain('compatible ACP stdio endpoint');
    expect(landing).toContain('BETA · IMPLEMENTED');
    expect(protocolDoc).toContain('**not** the Agent Client');
    expect(protocolDoc).toContain('share the acronym “ACP.”');
  });

  it('keeps branded public motion meaningful and fully reducible', () => {
    const landing = readFileSync(new URL('./LandingScreen.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('./public.css', import.meta.url), 'utf8');
    const featureStyles = readFileSync(new URL('./coreFeatureProofs.css', import.meta.url), 'utf8');
    expect(landing).toContain('pub-hero-product');
    expect(landing).toContain('<ProductWorkspacePreview compact />');
    expect(landing).toContain('pub-product-frame');
    expect(landing).toContain('pub-fleet');
    expect(landing).toContain('SANITIZED DEMO · LIVE PRODUCT UI');
    expect(landing).toContain('ACCOUNT OVERVIEW / SANITIZED');
    expect(landing).toContain('YOU CHOOSE WHERE WORK RUNS');
    expect(landing).not.toContain('CONNECTED · 42 MS');
    expect(landing).not.toContain('FLEET / LIVE NOW');
    expect(styles).toContain('@keyframes pub-field-drift');
    expect(styles).toContain('@keyframes pub-frame-signal');
    expect(styles).toContain('@keyframes pub-title-sheen');
    expect(styles).toContain('@keyframes pub-hero-tunnel');
    expect(styles).toContain('@keyframes pub-stage-scan');
    expect(styles).toContain('@keyframes pub-stage-float');
    expect(styles).toContain('@keyframes pub-stage-orbit');
    expect(styles).toContain('@keyframes pub-stage-packet');
    expect(landing).toContain('onPointerMove={tiltStage}');
    expect(landing).not.toContain('pub-stage-node');
    expect(landing).not.toContain('EDGE-RELAY');
    expect(landing).not.toContain('STUDIO-MAC');
    expect(landing).not.toContain('BUILD-NODE');
    expect(landing).not.toContain('HW-SG');
    expect(landing).not.toContain('MAC-OFFICE');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toMatch(/\.pub-hero-product::before[^}]*animation: none/);
    expect(styles).toMatch(/\.pub-page::after[^}]*animation: none/);
    expect(styles).toMatch(/\.pub-hero::after[^}]*animation: none/);
    expect(styles).toMatch(/\.pub-stage-float[^}]*animation: none/);
    expect(styles).toMatch(/\.pub-stage-orbit[^}]*animation: none/);
    expect(styles).toMatch(/\.pub-stage-packet[^}]*animation: none/);
    expect(styles).not.toContain('.pub-stage-node');
    expect(styles).toMatch(/\.pub-agent-grid article[^}]*transition: none/);
    expect(styles).toMatch(/\.docs-cards > a:hover[^}]*transform: none/);
    expect(featureStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(featureStyles).toContain('animation-duration: 0.01ms !important');
  });

  it('renders public product proof from production UI class contracts without app state imports', () => {
    const preview = readFileSync(new URL('./ProductWorkspacePreview.tsx', import.meta.url), 'utf8');
    expect(preview).toContain("import '../sessions/sidebar.css'");
    expect(preview).toContain("import '../terminal/terminal.css'");
    expect(preview).toContain("import '../files/fsbrowser.css'");
    expect(preview).toContain("import '../session/message.css'");
    expect(preview).toContain("import '../session/mirror.css'");
    expect(preview).toContain("import '../session/toolgroup.css'");
    expect(preview).toContain("import '../board/board.css'");
    expect(preview).toContain('className="term-screen"');
    expect(preview).toContain('className="fsb-viewer product-file-preview"');
    expect(preview).toContain('className="mrb"');
    expect(preview).toContain('className="mri"');
    expect(preview).toContain('className="tg tg--done"');
    expect(preview).toContain("'- font-size: var(--fs-14);");
    expect(preview).toContain('className="sd"');
    expect(preview).toContain('className="bd"');
    expect(preview).toContain('window.requestAnimationFrame');
    expect(preview.match(/\sinert[> }]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(preview).not.toMatch(/@\/sync\//);
    expect(preview).not.toMatch(/@\/auth\//);
    expect(preview).not.toMatch(/from ['"].*WebTerminalScreen/);
    expect(preview).not.toContain('FsBrowser machineId');
  });

  it('makes every narrow product surface usable instead of shrinking desktop mockups', () => {
    const landing = readFileSync(new URL('./LandingScreen.tsx', import.meta.url), 'utf8');
    const preview = readFileSync(new URL('./ProductWorkspacePreview.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('./productWorkspacePreview.css', import.meta.url), 'utf8');
    const publicStyles = readFileSync(new URL('./public.css', import.meta.url), 'utf8');
    expect(preview).toContain('onClick={closeFiles}');
    expect(preview).toContain('onClick={openFiles}');
    expect(preview).toContain('onBack={closeFile}');
    expect(preview).toContain('aria-controls={filesId}');
    expect(preview).toContain('aria-expanded={filesOpen}');
    expect(preview).toContain("window.getComputedStyle(event.currentTarget).position !== 'absolute'");
    expect(preview).toContain('onKeyDown={keepOverlayFocus}');
    expect(preview).toContain('useLayoutEffect(() =>');
    expect(preview).toContain('fileButtonRefs.current[lastFile.current]?.focus()');
    expect(preview).not.toMatch(/<button[^>]*className="fsb-crumb/);
    expect(preview).toContain('LOCAL PREVIEW · NOT SENT');
    expect(preview).toContain('initialFilesOpen = true');
    expect(preview).toContain('useState(initialFilesOpen)');
    expect(preview).not.toContain('Send to the running Claude terminal');
    expect(preview).toContain('useImeGuard()');
    expect(preview).toContain('ime.isGuarded(event)');
    expect(preview).toContain('onCompositionStart={ime.onCompositionStart}');
    expect(preview).not.toContain("'ArrowDown', 'ArrowLeft', 'ArrowUp'");
    expect(styles).toContain('container: product-preview / inline-size');
    expect(styles).toContain('@container product-preview (max-width: 760px)');
    expect(styles).toMatch(/@container product-preview \(max-width: 760px\)[\s\S]*\.product-term-files \{ position: absolute; inset: 0; z-index: 2; display: flex; width: 100%; max-width: 100%; \}/);
    expect(styles).toMatch(/\.term-screen:has\(\.product-term-files\)[^}]*\.term-header,[\s\S]*\.term-mid:has\(\.product-term-files\)[^}]*\.term-host \{ visibility: hidden; \}/);
    expect(styles).toMatch(/\.product-preview \.bd-cols \{ display: block; overflow-y: auto; \}/);
    expect(styles).toContain('@container product-preview (max-width: 480px)');
    expect(publicStyles).toMatch(/\.pub-flow code \{[^}]*white-space: pre-line/);
    expect(landing).toContain("{'Web → New session\\nchoose machine + agent'}");
    expect(landing).not.toContain('One thread. Three ways');
  });

  it('shows terminal-to-conversation continuity in authentic mobile product surfaces', () => {
    const landing = readFileSync(new URL('./LandingScreen.tsx', import.meta.url), 'utf8');
    const docs = readFileSync(new URL('./DocsScreen.tsx', import.meta.url), 'utf8');
    const proof = readFileSync(new URL('./MobileContinuityProof.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('./mobileContinuityProof.css', import.meta.url), 'utf8');
    expect(landing).toContain('<MobileContinuityProof />');
    expect(docs).toContain('<MobileContinuityProof compact />');
    expect(proof).toContain('initialView="terminal" initialFilesOpen={false} sidebar={false}');
    expect(proof).toContain('initialView="conversation" sidebar={false}');
    expect(proof).toContain('SAME CLAUDE PROCESS');
    expect(proof).toContain('OPTIONAL CLAUDE HOOKS');
    expect(proof).toContain('TERM · SOURCE');
    expect(proof).toContain('CHAT · MIRROR');
    expect(proof).not.toContain('TERM · LIVE');
    expect(proof).toContain('Tap “Back to terminal”');
    expect(proof).not.toMatch(/@\/sync\//);
    expect(proof).not.toMatch(/@\/auth\//);
    expect(styles).toContain('container: mobile-continuity / inline-size');
    expect(styles).toContain('@container mobile-continuity (max-width: 620px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toMatch(/prefers-reduced-motion[\s\S]*\.mcp-phone:hover \.mcp-phone-shell \{ transform: none/);
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('navigates the product proof through real product controls instead of marketing scene tabs', () => {
    const preview = readFileSync(new URL('./ProductWorkspacePreview.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('./productWorkspacePreview.css', import.meta.url), 'utf8');
    const publicStyles = readFileSync(new URL('./public.css', import.meta.url), 'utf8');
    expect(preview).not.toContain('pub-product-tabs');
    expect(preview).not.toContain('role="tablist"');
    expect(preview).not.toContain('role="tab"');
    expect(preview).not.toContain('tabRefs');
    expect(publicStyles).not.toContain('.pub-product-tabs');
    expect(preview).toContain('aria-label="Open task board"');
    expect(preview).toContain('onClick={onBoard}');
    expect(preview).toContain('onClick={onStructured}');
    expect(preview).toContain('onClick={onFiles}');
    expect(preview).toContain('onClick={onBack}');
    expect(preview).toContain('data-product-session');
    expect(preview).toContain('product-app--nav-open');
    expect(preview).toContain('aria-live="polite"');
    expect(preview).toContain('event.target !== event.currentTarget');
    expect(preview).toContain("focusInsideProduct('.product-detail .vh-back')");
    expect(styles).toContain('.product-app--nav-open .product-sidebar');
    expect(styles).toContain('.product-app--nav-open .product-detail { visibility: hidden; }');
  });

  it('renders interactive voice and launcher proofs without public-route app state', () => {
    const proof = readFileSync(new URL('./CoreFeatureProofs.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('./coreFeatureProofs.css', import.meta.url), 'utf8');
    expect(proof).toContain("import { AssistantLogo");
    expect(proof).toContain("import '../assistant/assistant.css'");
    expect(proof).toContain("import '../sessions/newsession.css'");
    expect(proof).toContain("['claude', 'codex', 'gemini', 'openclaw']");
    expect(proof).toContain("status: 'ACP · BETA'");
    expect(proof).toContain('OpenClaw gateway over its own protocol—not ACP');
    expect(proof).toContain('LOCAL INTERACTION · NO AUDIO CAPTURE');
    expect(proof).toContain('SANITIZED DEMO · NO CONNECTION');
    expect(proof).toContain("onClick={() => { if (voiceState === 'idle') finishVoicePreview(); }}");
    expect(proof).toContain('setSpeakingTurn((turn) => turn + 1)');
    expect(proof).toContain('[speakingTurn, voiceState]');
    expect(proof).toContain("aria-pressed={voiceState === 'listening'}");
    expect(proof).toContain('aria-labelledby={sectionTitleId}');
    expect(proof).not.toContain('id="cfp-voice-title"');
    expect(proof).not.toMatch(/@\/sync\//);
    expect(proof).not.toMatch(/@\/auth\//);
    expect(styles).toContain('font-size: var(--fs-16)');
    expect(styles).toMatch(/\.cfp-voice \.as-logo \{[^}]*margin-bottom: var\(--sp-5\)/);
    expect(styles).toMatch(/\.cfp-surface-bar i \{[^}]*background: var\(--text-faint\)/);
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('keeps multiple product previews in separate id and focus scopes', () => {
    const hero = getProductPreviewIds('hero');
    const showcase = getProductPreviewIds('showcase');
    const preview = readFileSync(new URL('./ProductWorkspacePreview.tsx', import.meta.url), 'utf8');
    expect(new Set([
      hero.panel,
      hero.files,
      showcase.panel,
      showcase.files,
    ]).size).toBe(4);
    expect(preview).toContain('focusInsideProduct');
    expect(preview).toContain("window.getComputedStyle(sidebarElement).display !== 'none'");
    expect(preview).not.toContain('document.getElementById');
    expect(preview).not.toContain('<main className="product-detail">');
  });

  it('keeps anonymous public routes outside the authenticated app bundle', () => {
    const main = readFileSync(new URL('../../main.tsx', import.meta.url), 'utf8');
    const publicRoot = readFileSync(new URL('../../app/PublicRoot.tsx', import.meta.url), 'utf8');
    const appRoot = readFileSync(new URL('../../app/AppRoot.tsx', import.meta.url), 'utf8');
    const publicShell = readFileSync(new URL('./PublicShell.tsx', import.meta.url), 'utf8');
    const publicLegal = readFileSync(new URL('../legal/PublicLegalScreen.tsx', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../../../../../README.md', import.meta.url), 'utf8');
    const vite = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
    expect(main).not.toMatch(/^import .*AppRoot/m);
    expect(main).toContain("import('./app/PublicRoot.tsx')");
    expect(main).toContain("import('./app/AppRoot.tsx')");
    expect(main).toContain('auth_credentials');
    expect(main).toContain('shouldUsePublicRoot(routePath, hasStoredCredentials)');
    expect(publicRoot).toContain("path: '/welcome'");
    expect(appRoot).toContain("path: '/welcome'");
    expect(publicShell).toContain('to="/welcome"');
    expect(publicLegal).toContain('className="legal-brand" to="/welcome"');
    expect(readme).toContain('href="https://happy.mereith.com/welcome"');
    expect(publicRoot).not.toContain('AuthProvider');
    expect(publicRoot).not.toContain('@/sync/');
    expect(publicRoot).toContain('<PwaInstallPrompt />');
    expect(appRoot).toContain('<PwaInstallPrompt />');
    expect(vite).toContain("globPatterns: ['index.html', 'manifest.webmanifest', 'registerSW.js']");
    expect(vite).toContain("handler: 'CacheFirst'");
    expect(vite).not.toContain("orientation: 'portrait'");
  });

  it('keeps the public IM adapter example fail-closed and environment-neutral', () => {
    const channels = readFileSync(new URL('../../../../../docs/channels.md', import.meta.url), 'utf8');
    const spec = readFileSync(new URL('../../../../../specs/2026-08-tanka-channel.md', import.meta.url), 'utf8');
    expect(channels).toContain('allowed_sender(msg.sender)');
    expect(channels).toContain('allowed_chat(msg.chat)');
    expect(channels).toContain('allowed_workdir(msg.chat)');
    expect(channels).toContain('routing key, not authentication');
    expect(spec).toContain('Fail closed unless both sender and chat are allowlisted');
    expect(spec).not.toMatch(/mac-office|hw-sg|apodex-bot|happy\.mereith\.com\/session/);
  });
});
