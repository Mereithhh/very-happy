export function GlobalRelayMap() {
  return <div className="pub-global-map" aria-label="US and Singapore machines use their nearest regional relay while account control and durable data remain on the Japan control server">
    <div className="pub-global-map-head mono">
      <span><i /> LIVE ROUTE TELEMETRY</span>
      <span>2 MACHINES · 2 RELAYS · 1 CONTROL</span>
    </div>
    <div className="pub-global-map-stage">
      <svg viewBox="0 0 800 440" role="img" aria-labelledby="global-relay-title global-relay-desc">
        <title id="global-relay-title">Machine-anchored regional relay topology</title>
        <desc id="global-relay-desc">A US machine connects to a nearby US relay, a Singapore machine connects to a nearby Singapore relay, and both retain account control and durable synchronization through the Japan control server. The browser follows the selected machine relay.</desc>
        <defs>
          <pattern id="relay-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" className="pub-global-grid-line" />
          </pattern>
          <filter id="relay-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        <rect width="800" height="440" className="pub-global-grid" />
        <g className="pub-global-coordinates mono" aria-hidden="true">
          <text x="18" y="25">60°N</text><text x="18" y="217">00°</text><text x="18" y="414">60°S</text>
          <text x="104" y="428">120°W</text><text x="374" y="428">000°</text><text x="665" y="428">120°E</text>
        </g>

        <g className="pub-global-land" aria-hidden="true">
          <path d="M88 105l54-48 78 4 39 31 44 4 28 35-28 29-60-2-27 21-42-8-25-27-47-4-30-18z" />
          <path d="M230 185l38 14 30 37 12 55-21 72-27 42-18-60-30-47 5-58-22-33z" />
          <path d="M385 102l45-38 97 4 42 26 91-2 70 35-21 37-71 9-34 29-72-13-39 12-42-24-60 8-33-29z" />
          <path d="M452 207l58 8 43 36-6 75-32 64-47-18-18-73-26-42z" />
          <path d="M650 303l45-26 55 20 9 43-47 24-54-15z" />
        </g>

        <g className="pub-global-routes" aria-hidden="true">
          <path className="is-control" d="M140 190 Q405 38 700 150" />
          <path className="is-control" d="M690 340 Q735 230 700 150" />
          <path className="is-live" pathLength="100" d="M140 190 Q176 132 225 125" />
          <path className="is-live is-return" pathLength="100" d="M690 340 Q655 303 620 280" />
          <path className="is-live is-browser" pathLength="100" d="M400 370 Q510 344 620 280" />
        </g>

        <g className="pub-global-control" transform="translate(700 150)">
          <circle r="36" /><circle r="25" />
          <path d="M-9 0h18M0-9v18" />
          <text x="0" y="55">JAPAN CONTROL</text>
          <text x="0" y="68">AUTH · STATE · DURABLE SYNC</text>
        </g>

        <g className="pub-global-node is-machine" transform="translate(140 190)">
          <circle className="pulse" r="19" /><circle r="7" />
          <text x="0" y="35">US MACHINE</text><text x="0" y="47">DAEMON</text>
        </g>
        <g className="pub-global-node is-selected" transform="translate(225 125)" filter="url(#relay-glow)">
          <circle className="pulse" r="19" /><circle r="7" />
          <text x="0" y="34">US RELAY</text><text x="0" y="46">NEAREST HEALTHY</text>
        </g>
        <g className="pub-global-node is-selected is-secondary" transform="translate(620 280)" filter="url(#relay-glow)">
          <circle className="pulse" r="19" /><circle r="7" />
          <text x="0" y="34">SINGAPORE RELAY</text><text x="0" y="46">NEAREST HEALTHY</text>
        </g>
        <g className="pub-global-node is-machine is-secondary" transform="translate(690 340)">
          <circle className="pulse" r="19" /><circle r="7" />
          <text x="0" y="35">SINGAPORE MACHINE</text><text x="0" y="47">DAEMON</text>
        </g>
        <g className="pub-global-node is-client" transform="translate(400 370)">
          <circle className="pulse" r="17" /><circle r="6" />
          <text x="0" y="32">WEB / PWA</text><text x="0" y="44">FOLLOWS MACHINE</text>
        </g>

        <g className="pub-global-scan" aria-hidden="true"><rect x="0" y="0" width="800" height="2" /></g>
      </svg>
      <div className="pub-global-status mono" aria-hidden="true">
        <span>US PATH <b>LOCAL RELAY</b></span>
        <span>SG PATH <b>LOCAL RELAY</b></span>
        <span>CONTROL <b>JAPAN</b></span>
      </div>
    </div>
    <div className="pub-relay-candidates mono">
      <span>MACHINE-ANCHORED ROUTING</span><b>US → US RELAY</b><b>SG → SINGAPORE RELAY</b><b>CONTROL → JAPAN</b>
    </div>
  </div>;
}
