import './orbitLoader.css';

export interface OrbitLoaderProps {
  size?: 'compact' | 'medium' | 'large';
  label?: string;
  showWordmark?: boolean;
  presentation?: boolean;
  className?: string;
}

const modelMarks = [
  {
    key: 'anthropic',
    label: 'Anthropic',
    path: 'M17.304 3.541h-3.672l6.696 16.918H24ZM6.696 3.541 0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223 2.291-5.946 2.292 5.946Z',
  },
  {
    key: 'llama',
    label: 'Llama by Meta',
    path: 'M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973.303 1.31 1.336 3.548 4.249 3.548 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.942-1.664 2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 2.194 0 4.289-1.478 4.289-5.92 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-2.337 0-4.055 2.198-4.873 3.358-1.92-2.433-3.518-3.699-5.412-3.699Zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-3.449-5.386a44.908 44.908 0 0 0-1.255-1.98c1.215-1.881 2.24-2.929 3.569-2.929Zm-10.201.553c1.894 0 3.088 1.778 3.909 3.025l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-1.097 0-1.847-1.038-1.847-2.84 0-2.221.63-4.535 1.66-6.088.908-1.374 1.826-1.818 2.621-1.818Z',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    path: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.423.444-.884.797-1.51.763-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.599-.264-.984-.633-1.26-1.424-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323l-.266.833c-.055.179-.137.218-.328.14-1.697-.69-2.755-2.13-4.334-3.3-1.378-1.022-3.132-1.54-5.077-1.322-4.873.545-7.76 4.55-7.047 8.595.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257 2.201-.238 3.507-1.637 3.638-3.992.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-2.697-1.587-4.451-4.485-4.6-7.788-.02-.385.094-.522.477-.592 2.46-.45 4.877.451 6.997 2.736 1.69 1.823 2.742 4.099 4.682 5.805.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615Z',
  },
  {
    key: 'qwen',
    label: 'Qwen',
    path: 'm23.919 14.545-3.102-5.375 1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267l6.367 11.032Zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83 6.373-11.028h3.592l3.102 5.374Z',
  },
  {
    key: 'mistral',
    label: 'Mistral AI',
    path: 'M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.429V3.429Z',
  },
] as const;

export function OrbitLoader({
  size = 'compact',
  label = 'Loading Very Happy',
  showWordmark = false,
  presentation = false,
  className,
}: OrbitLoaderProps) {
  return (
    <div
      className={`vh-orbit-widget vh-orbit-widget--${size}${className ? ` ${className}` : ''}`}
      role={presentation ? 'img' : 'status'}
      aria-label={label}
      aria-live={presentation ? undefined : 'polite'}
    >
      <div className="vh-orbit-widget__viewport" aria-hidden="true">
        <div className="vh-orbit-widget__stage">
          <div className="vh-orbit-widget__model-track">
            {modelMarks.map((mark) => (
              <div key={mark.key} className={`vh-orbit-widget__model vh-orbit-widget__model--${mark.key}`}>
                <div className="vh-orbit-widget__model-glyph" title={mark.label}>
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d={mark.path} /></svg>
                </div>
              </div>
            ))}
          </div>

          <div className="vh-orbit-widget__core">
            <svg viewBox="0 0 32 32" fill="none">
              <rect x="1.5" y="1.5" width="29" height="29" rx="7" stroke="currentColor" strokeWidth="2" />
              <path d="M9 9.6 12.9 12.3 9 15.1" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="19.1" y="9.2" width="3.9" height="6" rx="0.9" fill="currentColor" />
              <path d="M9.2 19.5C11 22 13.8 23.4 16 23.4s5-1.4 6.8-3.9" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
            </svg>
            <i className="vh-orbit-widget__live-dot" />
          </div>

          <div className="vh-orbit-widget__agent-track">
            <div className="vh-orbit-widget__agent vh-orbit-widget__agent--claude">
              <div className="vh-orbit-widget__agent-face">
                <svg viewBox="0 0 24 24" fill="none"><path d="M12 2.8v18.4M4.1 7.4l15.8 9.2M4.1 16.6l15.8-9.2M5.8 4.8l12.4 14.4M5.8 19.2 18.2 4.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                <span>Claude</span>
              </div>
            </div>
            <div className="vh-orbit-widget__agent vh-orbit-widget__agent--codex">
              <div className="vh-orbit-widget__agent-face">
                <svg viewBox="0 0 24 24" fill="none"><path d="m9 7-5 5 5 5M15 7l5 5-5 5M13.5 4 10.5 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span>Codex</span>
              </div>
            </div>
            <div className="vh-orbit-widget__agent vh-orbit-widget__agent--gemini">
              <div className="vh-orbit-widget__agent-face">
                <svg viewBox="0 0 24 24" fill="none"><path d="M12 2.8c.8 5.6 3.6 8.4 9.2 9.2-5.6.8-8.4 3.6-9.2 9.2C11.2 15.6 8.4 12.8 2.8 12 8.4 11.2 11.2 8.4 12 2.8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
                <span>Gemini</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      {showWordmark && <strong className="vh-orbit-widget__wordmark">veryhappy</strong>}
      {label && <span className="vh-orbit-widget__caption" aria-hidden="true">{label}</span>}
    </div>
  );
}
