/**
 * Inline SVG glyphs and keyword colours (UI). No image files: every icon is a 24x24 path set drawn in
 * currentColor, so CSS tints it. Keyword colours match the renderer's spell FX palette.
 */

export const KW_COLOR: Record<string, string> = {
  fire: '#ff8a3d', frost: '#9fe6ff', storm: '#ffe066', poison: '#8dff5a', shadow: '#b27bff',
  radiant: '#fff0a8', steel: '#c9d4e6', blade: '#f0f0f6', summon: '#d0a8ff', orbit: '#ffb36b',
};

export const KW_LABEL: Record<string, string> = {
  fire: 'Fire', frost: 'Frost', storm: 'Storm', poison: 'Poison', shadow: 'Shadow',
  radiant: 'Radiant', steel: 'Steel', blade: 'Blade', summon: 'Summon', orbit: 'Orbit',
};

const P: Record<string, string> = {
  // keywords
  fire: '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-3-1-6 1-9z" fill="currentColor"/><path d="M12 13c1 2 3 3 3 5a3 3 0 0 1-6 0c0-1 1-2 1-3 1 1 2 0 2-2z" fill="#fff8" />',
  frost: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M9 3.5l3 2.5 3-2.5M9 20.5l3-2.5 3 2.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  storm: '<path d="M13.5 2L5 13.5h6L9.5 22 19 9.5h-6.2z" fill="currentColor"/>',
  poison: '<path d="M12 2.5c3 4.5 6.5 8 6.5 12a6.5 6.5 0 0 1-13 0c0-4 3.5-7.5 6.5-12z" fill="currentColor"/><circle cx="9.6" cy="15" r="1.6" fill="#0006"/><circle cx="14.4" cy="15" r="1.6" fill="#0006"/><path d="M10 18.5h4" stroke="#0006" stroke-width="1.4" stroke-linecap="round"/>',
  shadow: '<path d="M16 3a9 9 0 1 0 5 15.5A7.5 7.5 0 0 1 16 3z" fill="currentColor"/><circle cx="17.5" cy="7" r="1.2" fill="currentColor"/><circle cx="20" cy="11" r=".9" fill="currentColor"/>',
  radiant: '<circle cx="12" cy="12" r="4.6" fill="currentColor"/><path d="M12 1.5v3.5M12 19v3.5M1.5 12H5M19 12h3.5M4.6 4.6l2.4 2.4M17 17l2.4 2.4M4.6 19.4L7 17M17 7l2.4-2.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  steel: '<path d="M4 7l5-3 8 0 3 3-3 3H9z" fill="currentColor"/><rect x="10.5" y="9.5" width="3" height="12" rx="1.2" fill="currentColor"/>',
  blade: '<path d="M19.5 2.5L8 14l2 2L21.5 4.5z" fill="currentColor"/><path d="M5 13l6 6M7 17l-4 4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  summon: '<path d="M12 3c4.5 0 7 3.5 7 7.5V21l-2.3-1.8L14.3 21 12 19.2 9.7 21l-2.4-1.8L5 21V10.5C5 6.5 7.5 3 12 3z" fill="currentColor"/><circle cx="9.5" cy="10.5" r="1.5" fill="#0007"/><circle cx="14.5" cy="10.5" r="1.5" fill="#0007"/>',
  orbit: '<circle cx="12" cy="12" r="3.2" fill="currentColor"/><ellipse cx="12" cy="12" rx="9.5" ry="4.5" fill="none" stroke="currentColor" stroke-width="1.8" transform="rotate(-25 12 12)"/><circle cx="20" cy="8" r="2" fill="currentColor"/>',
  // passives
  fist: '<path d="M6 10V7.5a1.5 1.5 0 0 1 3 0V6a1.5 1.5 0 0 1 3 0v.5a1.5 1.5 0 0 1 3 0V8a1.5 1.5 0 0 1 3 0v6c0 4-2.5 7-6.5 7S5 18.5 5 15.5V12c0-1 .5-2 1-2z" fill="currentColor"/>',
  clock: '<circle cx="12" cy="13" r="8.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 8.5V13l3 2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M9 2.5h6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  ring: '<circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2.4"/><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".6"/>',
  eye: '<path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" fill="currentColor"/><circle cx="12" cy="12" r="3.6" fill="#0008"/><circle cx="13.2" cy="10.8" r="1.1" fill="#fff"/>',
  heart: '<path d="M12 21s-8.5-5.2-8.5-11.2A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 3.2C20.5 15.8 12 21 12 21z" fill="currentColor"/>',
  shield: '<path d="M12 2l8 3v6.5c0 5-3.5 8.7-8 10.5-4.5-1.8-8-5.5-8-10.5V5z" fill="currentColor"/><path d="M12 5v14" stroke="#0004" stroke-width="2"/>',
  leaf: '<path d="M20 3C9 3 4 8 4 15c0 2 .6 3.6 1.4 5C7 13 11 10 15 8c-4 3-7 6-8.4 12.6C16 21 21 14 20 3z" fill="currentColor"/>',
  magnet: '<path d="M5 3h4.5v8a2.5 2.5 0 0 0 5 0V3H19v8a7 7 0 0 1-14 0z" fill="currentColor"/><path d="M5 3h4.5v3.5H5zM14.5 3H19v3.5h-4.5z" fill="#fff9"/>',
  // misc
  door: '<path d="M5 22V9a7 7 0 0 1 14 0v13z" fill="currentColor"/><circle cx="15" cy="15" r="1.3" fill="#0008"/>',
  relic: '<path d="M12 2l3 6.5 7 .8-5.2 4.8 1.5 7L12 17.5 5.7 21l1.5-7L2 9.3l7-.8z" fill="currentColor"/>',
  talent: '<path d="M12 2l2.6 5.5L20 9l-4 4.2.9 6L12 16.5 7.1 19.2l.9-6L4 9l5.4-1.5z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><circle cx="12" cy="11.5" r="2.4" fill="currentColor"/>',
  reroll: '<path d="M20 11a8 8 0 0 0-14.5-4.5M4 13a8 8 0 0 0 14.5 4.5" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M4 3v5h5M20 21v-5h-5" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  banish: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M5.6 5.6l12.8 12.8" stroke="currentColor" stroke-width="2.6"/>',
  pause: '<rect x="6" y="4" width="4.2" height="16" rx="1.5" fill="currentColor"/><rect x="13.8" y="4" width="4.2" height="16" rx="1.5" fill="currentColor"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  dash: '<path d="M13 4l7 8-7 8M5 4l7 8-7 8" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  skull: '<path d="M12 2.5c-5 0-8.5 3.4-8.5 8 0 2.6 1.2 4.4 3 5.5V20h11v-4c1.8-1.1 3-2.9 3-5.5 0-4.6-3.5-8-8.5-8z" fill="currentColor"/><circle cx="8.7" cy="11.5" r="2.2" fill="#0009"/><circle cx="15.3" cy="11.5" r="2.2" fill="#0009"/><path d="M10 20v-2.5M14 20v-2.5" stroke="#0009" stroke-width="1.5"/>',
  gear: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  sound: '<path d="M3 9h4l5-4.5v15L7 15H3z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
  mute: '<path d="M3 9h4l5-4.5v15L7 15H3z" fill="currentColor"/><path d="M16 9l6 6M22 9l-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  share: '<circle cx="18" cy="5" r="3" fill="currentColor"/><circle cx="6" cy="12" r="3" fill="currentColor"/><circle cx="18" cy="19" r="3" fill="currentColor"/><path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4" stroke="currentColor" stroke-width="2.2"/>',
  copy: '<rect x="8" y="8" width="12.5" height="13" rx="2.5" fill="currentColor"/><path d="M5.5 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v.5" stroke="currentColor" stroke-width="2.2" fill="none"/>',
  chest: '<path d="M3 10h18v10H3z" fill="currentColor"/><path d="M3 10a9 5 0 0 1 18 0z" fill="currentColor" opacity=".75"/><rect x="10" y="11" width="4" height="5" rx="1" fill="#0007"/>',
  lantern: '<path d="M9 3h6M12 3v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7.5 7h9l-1 12h-7z" fill="currentColor"/><path d="M12 10c1.2 1.8 2 2.6 2 4a2 2 0 0 1-4 0c0-1.4.8-2.2 2-4z" fill="#fff"/>',
  arrow: '<path d="M12 2l9 12h-5.5v8h-7v-8H3z" fill="currentColor"/>',
  home: '<path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z" fill="currentColor"/>',
  hourglass: '<path d="M6 2h12v4l-4.5 6 4.5 6v4H6v-4l4.5-6L6 6z" fill="currentColor"/>',
  crown: '<path d="M3 18l-1-11 6 4 4-7 4 7 6-4-1 11z" fill="currentColor"/><rect x="3" y="19" width="18" height="2.5" rx="1" fill="currentColor"/>',
  wyrm: '<path d="M3 15c3-8 9-11 16-9l2-3 .5 6c-3-1-6 0-8 3 3 0 5 1 6 3-4-1-7 0-9 3-2-1-5-1-7-3z" fill="currentColor"/>',
};

/** Inline SVG markup for a glyph id (keyword, passive icon, or misc). */
export function glyph(id: string, cls = 'dv-ico'): string {
  const body = P[id] ?? P.relic;
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Coloured keyword chip: glyph + label. */
export function kwChip(k: string, withLabel = true): string {
  return `<span class="dv-kw" style="--kw:${KW_COLOR[k] ?? '#fff'}">${glyph(k)}${withLabel ? `<b>${KW_LABEL[k] ?? k}</b>` : ''}</span>`;
}

/** Big spell art for the spec picker (signature spells). */
export function specArt(specId: string): string {
  if (specId === 'venom') {
    return `<svg class="dv-art" viewBox="0 0 160 100" aria-hidden="true">
      <defs>
        <radialGradient id="vg1" cx="50%" cy="55%" r="60%"><stop offset="0" stop-color="#b6ff7a"/><stop offset=".55" stop-color="#3bbf3a" stop-opacity=".55"/><stop offset="1" stop-color="#0a2a12" stop-opacity="0"/></radialGradient>
        <radialGradient id="vg2" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#eaffd0"/><stop offset="1" stop-color="#5ee05a"/></radialGradient>
      </defs>
      <ellipse cx="80" cy="62" rx="76" ry="34" fill="url(#vg1)"/>
      <g class="dv-art-pulse">
        <circle cx="44" cy="66" r="9" fill="#2f6b2a"/><circle cx="44" cy="66" r="5" fill="url(#vg2)"/>
        <circle cx="116" cy="58" r="10" fill="#2f6b2a"/><circle cx="116" cy="58" r="6" fill="url(#vg2)"/>
        <circle cx="132" cy="80" r="6" fill="#2f6b2a"/><circle cx="132" cy="80" r="3.5" fill="url(#vg2)"/>
      </g>
      <path d="M80 30c8 12 16 20 16 30a16 16 0 0 1-32 0c0-10 8-18 16-30z" fill="url(#vg2)" stroke="#1d4a1a" stroke-width="3"/>
      <circle cx="74" cy="62" r="3.4" fill="#1d4a1a"/><circle cx="86" cy="62" r="3.4" fill="#1d4a1a"/>
      <path d="M74 70q6 4 12 0" stroke="#1d4a1a" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <path d="M96 60 Q106 58 112 58 M64 62 Q54 64 50 66 M92 74 Q112 80 128 80" stroke="#8dff5a" stroke-width="2.4" stroke-dasharray="3 4" fill="none" opacity=".9"/>
    </svg>`;
  }
  return `<svg class="dv-art" viewBox="0 0 160 100" aria-hidden="true">
    <defs>
      <radialGradient id="eg1" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff6c8"/><stop offset=".35" stop-color="#ffb347"/><stop offset=".75" stop-color="#ff5a1f" stop-opacity=".6"/><stop offset="1" stop-color="#ff3d00" stop-opacity="0"/></radialGradient>
      <linearGradient id="eg2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff5a1f" stop-opacity="0"/><stop offset="1" stop-color="#ffcf6b"/></linearGradient>
    </defs>
    <ellipse cx="118" cy="66" rx="34" ry="16" fill="none" stroke="#ff8a3d" stroke-width="3" opacity=".8" class="dv-art-ring"/>
    <ellipse cx="118" cy="66" rx="22" ry="10" fill="url(#eg1)" opacity=".85"/>
    <path d="M18 34 Q60 40 104 56" stroke="url(#eg2)" stroke-width="12" stroke-linecap="round" fill="none" opacity=".9"/>
    <path d="M26 40 Q64 46 104 58" stroke="#fff3c0" stroke-width="3" stroke-linecap="round" fill="none" opacity=".7"/>
    <circle cx="106" cy="57" r="13" fill="url(#eg1)"/>
    <circle cx="106" cy="57" r="6" fill="#fffbe6"/>
    <g fill="#ffb347" class="dv-art-sparks"><circle cx="134" cy="48" r="2.4"/><circle cx="142" cy="62" r="1.8"/><circle cx="96" cy="78" r="2"/><circle cx="126" cy="84" r="1.6"/><circle cx="88" cy="70" r="1.4"/></g>
  </svg>`;
}
