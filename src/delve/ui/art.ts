/**
 * Inline SVG illustrations (UI). No image files, no emoji: the home hero (the lantern-bearing delver in a cave
 * mouth with critters peeking from the dark), per-Omen and per-Twist badges, and the first-run onboarding panels.
 * Animation is CSS only (classes in style.css, all disabled by reduced motion). Gradient ids are prefixed per call
 * so several copies can share a page.
 */

let uid = 0;
const nid = (p: string): string => `${p}${++uid}`;

/** The delver figure (hat, scarf, cloak, lantern in the right hand), drawn around (0,0) = feet centre. */
function delver(g: string): string {
  return `
    <ellipse cx="0" cy="2" rx="17" ry="5" fill="#000" opacity=".45"/>
    <path d="M-12 0 Q-14 -24 -2 -30 L4 -30 Q14 -24 12 0 Z" fill="#2b2140"/>
    <path d="M-12 0 Q-13 -14 -8 -22 L-4 0 Z" fill="#3a2d56"/>
    <path d="M-9 -27 Q0 -22 9 -27 L10 -22 Q0 -16 -10 -22 Z" fill="#e0453a"/>
    <path d="M6 -24 l9 12 -4 2 -8 -11z" fill="#c43328"/>
    <circle cx="0" cy="-36" r="10.5" fill="#f3c9a0"/>
    <circle cx="-3.6" cy="-35" r="1.7" fill="#2a1a10"/><circle cx="3.6" cy="-35" r="1.7" fill="#2a1a10"/>
    <path d="M-2.5 -31 q2.5 2 5 0" stroke="#7a3a20" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    <circle cx="-6.5" cy="-32" r="2" fill="#ff8f7a" opacity=".55"/><circle cx="6.5" cy="-32" r="2" fill="#ff8f7a" opacity=".55"/>
    <ellipse cx="0" cy="-43" rx="17" ry="4.6" fill="#e9b03c"/>
    <path d="M-10 -44 Q-9 -56 0 -56 Q9 -56 10 -44 Z" fill="#f6c650"/>
    <path d="M-10 -45.5 Q0 -42 10 -45.5" stroke="#b9772a" stroke-width="2" fill="none"/>
    <g class="dv-sway" style="transform-origin:14px -22px">
      <path d="M10 -20 L22 -18" stroke="#2b2140" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M22 -19 L24 -12" stroke="#8a6a3a" stroke-width="1.4"/>
      <circle cx="24" cy="-4" r="16" fill="url(#${g})" class="dv-flick"/>
      <path d="M19.5 -12 h9 l-1.4 13 h-6.2 z" fill="#ffe8a8"/>
      <path d="M19 -12.5 h10 M20 1.5 h8" stroke="#6b4a24" stroke-width="2" stroke-linecap="round"/>
      <path d="M24 -8.5 c1.6 2.4 2.6 3.4 2.6 5.2 a2.6 2.6 0 0 1 -5.2 0 c0 -1.8 1 -2.8 2.6 -5.2z" fill="#fff"/>
    </g>`;
}

/** Home hero: cave arch, lantern glow, the delver, peeking critter eyes, a bat. */
export function heroArt(): string {
  const glow = nid('hg');
  const lamp = nid('hl');
  const rock = nid('hr');
  const floor = nid('hf');
  const eyes = (x: number, y: number, s: number, c: string, d: number) =>
    `<g class="dv-blink" style="animation-delay:${d}s"><ellipse cx="${x - 4 * s}" cy="${y}" rx="${2.2 * s}" ry="${2.6 * s}" fill="${c}"/><ellipse cx="${x + 4 * s}" cy="${y}" rx="${2.2 * s}" ry="${2.6 * s}" fill="${c}"/></g>`;
  return `<svg class="dv-hero-art" viewBox="0 0 360 200" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id="${glow}" cx="58%" cy="72%" r="55%"><stop offset="0" stop-color="#ffcf7a" stop-opacity=".75"/><stop offset=".35" stop-color="#ff9a3c" stop-opacity=".28"/><stop offset="1" stop-color="#ff7a20" stop-opacity="0"/></radialGradient>
      <radialGradient id="${lamp}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff6d0"/><stop offset=".3" stop-color="#ffc45a" stop-opacity=".7"/><stop offset="1" stop-color="#ff8a20" stop-opacity="0"/></radialGradient>
      <linearGradient id="${rock}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1222"/><stop offset="1" stop-color="#2e1f2a"/></linearGradient>
      <radialGradient id="${floor}" cx="56%" cy="20%" r="70%"><stop offset="0" stop-color="#7a4a24"/><stop offset=".6" stop-color="#2e1c18"/><stop offset="1" stop-color="#130c12"/></radialGradient>
    </defs>
    <ellipse cx="190" cy="176" rx="170" ry="30" fill="url(#${floor})"/>
    <rect x="0" y="0" width="360" height="200" fill="url(#${glow})"/>
    <path d="M0 0 H360 V200 H322 C330 120 300 52 240 38 C210 30 170 30 130 40 C70 56 36 120 42 200 H0 Z" fill="url(#${rock})"/>
    <path d="M130 40 l6 22 6 -20 M176 33 l5 30 6 -31 M222 36 l4 16 5 -15 M262 48 l3 18 6 -14" fill="#1a1222"/>
    <path d="M42 200 C36 120 70 56 130 40 C170 30 210 30 240 38 C300 52 330 120 322 200" fill="none" stroke="#ffb36b" stroke-opacity=".22" stroke-width="2"/>
    <g fill="#ffd34d" class="dv-gemfloat">
      <path d="M118 168 l5 -7 5 7 -5 7z"/><path d="M262 172 l4 -6 4 6 -4 6z" opacity=".8"/><path d="M286 160 l3 -5 3 5 -3 5z" opacity=".6"/>
    </g>
    <path d="M222 178 l3 -12 h16 l3 12z" fill="#5a3a22"/><path d="M220 168 h28 v-5 h-28z" fill="#8a5a2a"/><rect x="231" y="168" width="6" height="5" fill="#ffd34d"/>
    ${eyes(78, 120, 1, '#b6ff7a', 0)}
    ${eyes(300, 112, 0.8, '#ff9a6a', 1.3)}
    ${eyes(60, 70, 0.7, '#c9a8ff', 2.1)}
    ${eyes(312, 60, 0.6, '#b6ff7a', 0.6)}
    <g class="dv-bat"><path d="M268 70 q8 -10 16 -2 q4 -6 8 0 q8 -8 16 2 q-10 -2 -14 6 q-4 -3 -6 0 q-6 -8 -20 -6z" fill="#3a2550"/><circle cx="287" cy="70" r="1.2" fill="#ffcf7a"/><circle cx="291" cy="70" r="1.2" fill="#ffcf7a"/></g>
    <g transform="translate(178 172)">${delver(lamp)}</g>
    <g class="dv-motes" fill="#ffd9a0"><circle cx="210" cy="120" r="1.4"/><circle cx="170" cy="100" r="1"/><circle cx="232" cy="96" r="1.2"/><circle cx="196" cy="84" r=".9"/></g>
  </svg>`;
}

/** Badge art for an Omen (weekly modifier). */
export function omenArt(id: string): string {
  if (id === 'ironhide') {
    const sh = nid('ih');
    return `<svg class="dv-mod-art" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs><linearGradient id="${sh}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e6ecf6"/><stop offset=".5" stop-color="#8a96ac"/><stop offset="1" stop-color="#4a5266"/></linearGradient></defs>
      <path d="M14 46 l-6 6 M50 46 l6 6 M12 34 h-7 M52 34 h7 M16 24 l-6 -4 M48 24 l6 -4" stroke="#6a5a80" stroke-width="3" stroke-linecap="round"/>
      <ellipse cx="32" cy="36" rx="20" ry="18" fill="url(#${sh})"/>
      <path d="M32 18 V54" stroke="#3a4050" stroke-width="2.4"/>
      <path d="M17 30 q15 -6 30 0" stroke="#fff" stroke-opacity=".6" stroke-width="2" fill="none"/>
      <circle cx="22" cy="40" r="2" fill="#3a4050"/><circle cx="42" cy="40" r="2" fill="#3a4050"/><circle cx="24" cy="47" r="1.6" fill="#3a4050"/><circle cx="40" cy="47" r="1.6" fill="#3a4050"/>
      <ellipse cx="32" cy="18" rx="9" ry="6" fill="#4a3a60"/><circle cx="28.5" cy="17" r="1.8" fill="#ffd34d"/><circle cx="35.5" cy="17" r="1.8" fill="#ffd34d"/>
      <path d="M38 30 l4 6 -3 3 4 5" stroke="#ffd34d" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="dv-crack"/>
    </svg>`;
  }
  // swarming (default): a cloud of small bats with glowing eyes
  const bat = (x: number, y: number, s: number, o: number) =>
    `<g transform="translate(${x} ${y}) scale(${s})" opacity="${o}"><path d="M-10 0 q4 -7 9 -2 q1 -3 2 0 q5 -5 9 2 q-6 -1 -8 4 q-1.5 -2 -3 0 q-3 -5 -9 -4z" fill="#5a3a80"/><circle cx="-1.6" cy="-.4" r=".9" fill="#ffcf7a"/><circle cx="1.6" cy="-.4" r=".9" fill="#ffcf7a"/></g>`;
  return `<svg class="dv-mod-art" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <g class="dv-swarm">
      ${bat(32, 30, 1.7, 1)}${bat(14, 18, 1, 0.85)}${bat(50, 16, 1.1, 0.9)}${bat(16, 44, 1.2, 0.9)}${bat(50, 46, 0.9, 0.8)}
      ${bat(30, 10, 0.7, 0.7)}${bat(33, 52, 0.8, 0.75)}${bat(6, 31, 0.6, 0.6)}${bat(58, 32, 0.65, 0.6)}
    </g>
  </svg>`;
}

/** Badge art for a Twist (daily modifier). */
export function twistArt(id: string): string {
  if (id === 'leanSeam') {
    return `<svg class="dv-mod-art" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      ${[-24, -8, 8, 24].map((a, i) => `<rect x="24" y="14" width="16" height="24" rx="3" transform="rotate(${a} 32 52)" fill="${i === 3 ? '#7af0e0' : '#2d5a58'}" stroke="#7af0e0" stroke-width="1.6"/>`).join('')}
      <path d="M26 56 h12" stroke="#7af0e0" stroke-width="2.4" stroke-linecap="round" opacity=".6"/>
    </svg>`;
  }
  // longFuse (default): a lit fuse with a spark and a widening red ring
  return `<svg class="dv-mod-art" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <ellipse cx="32" cy="46" rx="24" ry="9" fill="#ff4d4d" fill-opacity=".18" stroke="#ff6a5a" stroke-width="2"/>
    <ellipse cx="32" cy="46" rx="13" ry="5" fill="#ff4d4d" fill-opacity=".35"/>
    <path d="M32 44 C30 34 40 30 36 22 C33 16 40 12 44 10" stroke="#c9a46a" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-dasharray="3 2"/>
    <g class="dv-spark"><circle cx="44" cy="10" r="4" fill="#fff3c0"/><path d="M44 2 v4 M44 14 v4 M36 10 h4 M48 10 h4 M38.5 4.5 l2.5 2.5 M47 13 l2.5 2.5 M38.5 15.5 l2.5 -2.5 M47 7 l2.5 -2.5" stroke="#7af0e0" stroke-width="1.8" stroke-linecap="round"/></g>
  </svg>`;
}

// ---------------------------------------------------------------------------------------------------
// Onboarding panels (160 x 120 scenes)

export function obMoveArt(): string {
  const lamp = nid('ol');
  return `<svg class="dv-ob-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
    <defs><radialGradient id="${lamp}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff6d0"/><stop offset=".3" stop-color="#ffc45a" stop-opacity=".7"/><stop offset="1" stop-color="#ff8a20" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="80" cy="70" rx="74" ry="40" fill="#2a1a18"/>
    <g class="dv-ob-walk"><g transform="translate(70 66) scale(.62)">${delver(lamp)}</g></g>
    <g class="dv-ob-stick" transform="translate(116 92)">
      <circle r="17" fill="rgba(255,230,190,.08)" stroke="rgba(255,220,170,.5)" stroke-width="2"/>
      <g class="dv-ob-knob"><circle r="8" fill="#ffcf8a"/>
        <path d="M2 4 c0 -6 3 -8 6 -8 c2 0 3 2 3 4 v10 c0 6 -4 10 -9 10 c-6 0 -9 -4 -9 -9 v-3 c0 -2 2 -3 3 -1z" fill="#f3c9a0" stroke="#6b4a2a" stroke-width="1.2" transform="translate(-2 2)"/></g>
    </g>
  </svg>`;
}

export function obAutoArt(): string {
  const lamp = nid('oa');
  const crit = (x: number, y: number, c: string, d: number) =>
    `<g class="dv-ob-crit" style="animation-delay:${d}s"><ellipse cx="${x}" cy="${y}" rx="9" ry="7" fill="${c}"/><circle cx="${x - 3}" cy="${y - 1}" r="1.6" fill="#fff"/><circle cx="${x + 3}" cy="${y - 1}" r="1.6" fill="#fff"/></g>`;
  return `<svg class="dv-ob-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
    <defs><radialGradient id="${lamp}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff6d0"/><stop offset=".3" stop-color="#ffc45a" stop-opacity=".7"/><stop offset="1" stop-color="#ff8a20" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="80" cy="70" rx="74" ry="40" fill="#2a1a18"/>
    <g transform="translate(46 84) scale(.62)">${delver(lamp)}</g>
    ${crit(128, 50, '#7a5aa0', 0)}${crit(136, 84, '#5aa05a', 0.6)}${crit(108, 96, '#a0705a', 1.2)}
    <g class="dv-ob-bolt"><circle cx="0" cy="0" r="7" fill="#ff8a3d" opacity=".35"/><circle cx="0" cy="0" r="3.6" fill="#fff3c0"/></g>
    <g class="dv-ob-bolt b2"><circle cx="0" cy="0" r="7" fill="#ff8a3d" opacity=".35"/><circle cx="0" cy="0" r="3.6" fill="#fff3c0"/></g>
    <g fill="#ffd34d" class="dv-ob-gems"><path d="M124 60 l3 -4 3 4 -3 4z"/><path d="M132 94 l3 -4 3 4 -3 4z"/></g>
  </svg>`;
}

export function obRedArt(): string {
  const lamp = nid('or');
  return `<svg class="dv-ob-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
    <defs><radialGradient id="${lamp}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff6d0"/><stop offset=".3" stop-color="#ffc45a" stop-opacity=".7"/><stop offset="1" stop-color="#ff8a20" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="80" cy="70" rx="74" ry="40" fill="#2a1a18"/>
    <ellipse cx="62" cy="72" rx="34" ry="18" fill="#ff3d3d" fill-opacity=".14" stroke="#ff5a5a" stroke-width="2.4"/>
    <ellipse cx="62" cy="72" rx="34" ry="18" fill="#ff3d3d" fill-opacity=".55" class="dv-ob-fill"/>
    <g class="dv-ob-escape"><g transform="translate(62 76) scale(.56)">${delver(lamp)}</g></g>
    <g class="dv-ob-goldgem"><path d="M134 76 l8 -10 8 10 -8 10z" fill="#ffd34d" stroke="#fff3c0" stroke-width="1.4"/><circle cx="142" cy="76" r="15" fill="#ffd34d" opacity=".18"/></g>
  </svg>`;
}

export function obCardsArt(): string {
  const card = (x: number, rot: number, c: string, icon: string, cls = '') =>
    `<g transform="translate(${x} 62) rotate(${rot})" class="${cls}"><rect x="-19" y="-28" width="38" height="56" rx="7" fill="#1e1428" stroke="${c}" stroke-width="2.4"/><g transform="translate(-10 -16) scale(.85)" fill="${c}" color="${c}">${icon}</g><rect x="-12" y="12" width="24" height="3" rx="1.5" fill="${c}" opacity=".5"/><rect x="-9" y="18" width="18" height="3" rx="1.5" fill="${c}" opacity=".3"/></g>`;
  const fire = '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-3-1-6 1-9z"/>';
  const storm = '<path d="M13.5 2L5 13.5h6L9.5 22 19 9.5h-6.2z"/>';
  const drop = '<path d="M12 2.5c3 4.5 6.5 8 6.5 12a6.5 6.5 0 0 1-13 0c0-4 3.5-7.5 6.5-12z"/>';
  return `<svg class="dv-ob-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
    ${card(38, -10, '#ff8a3d', fire)}${card(122, 10, '#8dff5a', drop)}${card(80, 0, '#ffe066', storm, 'dv-ob-pick')}
    <g class="dv-ob-tap"><circle cx="86" cy="80" r="9" fill="#fff" opacity=".25"/><circle cx="86" cy="80" r="5" fill="#fff" opacity=".7"/></g>
  </svg>`;
}

/** Onboarding panel 5 (v0.2): the goal. A delver under a ticking timer, with a "best" crown. */
export function obGoalArt(): string {
  const lamp = nid('og');
  return `<svg class="dv-ob-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
    <defs><radialGradient id="${lamp}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff6d0"/><stop offset=".3" stop-color="#ffc45a" stop-opacity=".7"/><stop offset="1" stop-color="#ff8a20" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="80" cy="76" rx="74" ry="36" fill="#2a1a18"/>
    <g transform="translate(80 86) scale(.6)">${delver(lamp)}</g>
    <rect x="50" y="10" width="60" height="26" rx="9" fill="#1e1428" stroke="#ffd34d" stroke-width="2"/>
    <text x="80" y="29" text-anchor="middle" font-family="Fredoka, Nunito, system-ui, sans-serif" font-weight="700" font-size="17" fill="#ffd34d">2:31</text>
    <g transform="translate(114 4)" fill="#ffd34d"><path d="M2 14 L0 4 L6 9 L10 2 L14 9 L20 4 L18 14 Z"/><rect x="2" y="15" width="16" height="3" rx="1"/></g>
  </svg>`;
}
