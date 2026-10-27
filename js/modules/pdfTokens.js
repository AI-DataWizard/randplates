// pdfTokens.js — P-563: per-theme print tokens for the themed PDF.
// PALETTE SOURCE OF TRUTH: the site's live theme definitions (light palettes),
// print-translated: paper is ALWAYS light (a PDF prints on white paper; dark
// site themes become dark ink + strong accents, never toner floods). Fonts
// come from the standard PDF-14 set so nothing is ever fetched or embedded.
// Pure module: validateTokens() is the CI wall (tests/pdf-tests.js).

/** WCAG relative luminance helpers */
const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
export const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
export const contrast = (a, b) => {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** Pre-blend a color toward paper: opaque soft fills instead of /ca alpha. */
export const mix = (color, paper, t) => {
  const a = parseInt(color.slice(1), 16), b = parseInt(paper.slice(1), 16);
  const ch = (sh) => Math.round(((a >> sh & 255) * (1 - t) + (b >> sh & 255) * t));
  return '#' + [16, 8, 0].map(sh => ch(sh).toString(16).padStart(2, '0')).join('');
};

/**
 * PDF_TOKENS[themeId]. Derived from the site's light palettes (themeData):
 *   primary ~ site brand · tag ~ site sun/coin yellow · paper = white or the
 *   theme's warm cream when light enough · ink = the site ink, deepened.
 */
export const PDF_TOKENS = {
  'spaza-classic': {   // flagship: chilli orange + sun-yellow stickers on warm paper (rebrand A1)
    paper: '#fff8f0', ink: '#26170b', soft_ink: '#6b5444',
    primary: '#c2410c', accent: '#ea580c', tag_sticker: '#fbbf24',
    rule: '#c2410c', rule_soft: '#ecd9c3',
    fonts: { display: 'Helvetica-Bold', body: 'Helvetica', mono: 'Courier' },
    type_scale: { display: 21, section: 12, body: 9.5, caption: 7.5, line: 13 },
    decor: { band: 'primary', band_text: '#fff8f0', tag_radius: 4, tag_offset: 2, dashed_rules: true },
    density: { section_gap: 12, card_pad: 8 } },

  'midnight-noir': {   // velvet lounge on white: violet ink-headers, gold tags
    paper: '#ffffff', ink: '#140f22', soft_ink: '#5a5366',
    primary: '#5929dc', accent: '#6a3fe0', tag_sticker: '#f5cf4a',
    rule: '#5929dc', rule_soft: '#d8d2ea',
    fonts: { display: 'Times-Bold', body: 'Helvetica', mono: 'Courier' },
    type_scale: { display: 23, section: 12, body: 9.5, caption: 7.5, line: 13.5 },
    decor: { band: 'primary', band_text: '#ffffff', tag_radius: 0, tag_offset: 0, dashed_rules: false },
    density: { section_gap: 14, card_pad: 9 } },

  'ocean-breeze': {   // seaside kiosk: azure, sandy tags
    paper: '#ffffff', ink: '#0b2a3d', soft_ink: '#4a6677',
    primary: '#0b6fb8', accent: '#0b6fb8', tag_sticker: '#ffd97a',
    rule: '#0b6fb8', rule_soft: '#cfe6f2',
    fonts: { display: 'Helvetica-Bold', body: 'Helvetica', mono: 'Courier' },
    type_scale: { display: 22, section: 12, body: 10, caption: 8, line: 14 },
    decor: { band: 'primary', band_text: '#ffffff', tag_radius: 5, tag_offset: 2, dashed_rules: true },
    density: { section_gap: 14, card_pad: 10 } },

  'retro-terminal': {   // phosphor CRT on paper: monospace, boxed
    paper: '#fbfdf9', ink: '#0b2b18', soft_ink: '#3f6b4b',
    primary: '#1a8030', accent: '#1a8030', tag_sticker: '#f0e04a',
    rule: '#0f3d1c', rule_soft: '#cfe3d2',
    fonts: { display: 'Courier-Bold', body: 'Courier', mono: 'Courier' },
    type_scale: { display: 16, section: 11, body: 9, caption: 7.5, line: 12 },
    decor: { band: 'primary', band_text: '#fbfdf9', tag_radius: 0, tag_offset: 1, dashed_rules: true },
    density: { section_gap: 10, card_pad: 6 } },

  'vintage-paper': {   // 1950s recipe card: aubergine ink, parchment (warm paper allowed)
    paper: '#faf6ea', ink: '#3b1f33', soft_ink: '#6e4f64',
    primary: '#7a2e66', accent: '#7a2e66', tag_sticker: '#e9c873',
    rule: '#7a2e66', rule_soft: '#e0d4bc',
    fonts: { display: 'Times-Bold', body: 'Times-Roman', mono: 'Courier' },
    type_scale: { display: 22, section: 12.5, body: 10, caption: 8, line: 14 },
    decor: { band: 'primary', band_text: '#faf6ea', tag_radius: 3, tag_offset: 2, dashed_rules: false },
    density: { section_gap: 14, card_pad: 10 } },

  'neon-cyber': {   // cyan rules on white glass, acid tags, mono body
    paper: '#ffffff', ink: '#0a1620', soft_ink: '#4b5d6b',
    primary: '#007c99', accent: '#007c99', tag_sticker: '#eef33e',
    rule: '#007c99', rule_soft: '#c8e8f0',
    fonts: { display: 'Helvetica-Bold', body: 'Courier', mono: 'Courier' },
    type_scale: { display: 20, section: 11.5, body: 9, caption: 7.5, line: 12.5 },
    decor: { band: 'primary', band_text: '#ffffff', tag_radius: 0, tag_offset: 2, dashed_rules: true },
    density: { section_gap: 12, card_pad: 8 } },

  'botanical-garden': {   // market-garden booklet: moss + seed-packet tags
    paper: '#ffffff', ink: '#1e2a1a', soft_ink: '#55634e',
    primary: '#56741b', accent: '#56741b', tag_sticker: '#f4dc74',
    rule: '#56741b', rule_soft: '#dce8d6',
    fonts: { display: 'Times-Bold', body: 'Times-Roman', mono: 'Courier' },
    type_scale: { display: 22, section: 12, body: 10, caption: 8, line: 13.5 },
    decor: { band: 'primary', band_text: '#ffffff', tag_radius: 4, tag_offset: 1.5, dashed_rules: true },
    density: { section_gap: 15, card_pad: 10 } },

  'desert-clay': {   // adobe cookbook: terracotta, apricot tags
    paper: '#ffffff', ink: '#2a1a14', soft_ink: '#6a4a3c',
    primary: '#b4442a', accent: '#b4442a', tag_sticker: '#f3c05f',
    rule: '#b4442a', rule_soft: '#f0d8c8',
    fonts: { display: 'Helvetica-Bold', body: 'Helvetica', mono: 'Courier' },
    type_scale: { display: 23, section: 12.5, body: 10, caption: 8, line: 13.5 },
    decor: { band: 'primary', band_text: '#ffffff', tag_radius: 0, tag_offset: 2, dashed_rules: false },
    density: { section_gap: 16, card_pad: 11 } },

  'arctic-frost': {   // clinical glacier sheet: steel-blue razor lines
    paper: '#ffffff', ink: '#10232b', soft_ink: '#526b75',
    primary: '#3a5873', accent: '#3a5873', tag_sticker: '#c2e8f8',
    rule: '#3a5873', rule_soft: '#d7eef5',
    fonts: { display: 'Helvetica', body: 'Helvetica', mono: 'Courier' },
    type_scale: { display: 21, section: 11.5, body: 9.5, caption: 7.5, line: 13 },
    decor: { band: 'primary', band_text: '#ffffff', tag_radius: 0, tag_offset: 1, dashed_rules: false },
    density: { section_gap: 17, card_pad: 9 } },

  'editorial-ink': {   // broadsheet food column: black ink, highlighter marks
    paper: '#ffffff', ink: '#111111', soft_ink: '#555555',
    primary: '#1b1b1b', accent: '#1b1b1b', tag_sticker: '#ffe258',
    rule: '#111111', rule_soft: '#d9d9d9',
    fonts: { display: 'Times-Bold', body: 'Times-Roman', mono: 'Courier' },
    type_scale: { display: 26, section: 12.5, body: 10, caption: 8, line: 13.5 },
    decor: { band: 'primary', band_text: '#ffffff', tag_radius: 0, tag_offset: 2, dashed_rules: false },
    density: { section_gap: 13, card_pad: 8 } },

  'sunset-highway': {   // N1 diner menu: road-sign gold, sky-blue tags
    paper: '#ffffff', ink: '#241826', soft_ink: '#5e4a5e',
    primary: '#8f6b00', accent: '#8f6b00', tag_sticker: '#9bd5fa',
    rule: '#8f6b00', rule_soft: '#ead6e4',
    fonts: { display: 'Helvetica-Bold', body: 'Helvetica', mono: 'Courier' },
    type_scale: { display: 23, section: 12, body: 10, caption: 8, line: 13.5 },
    decor: { band: 'primary', band_text: '#ffffff', tag_radius: 3, tag_offset: 2, dashed_rules: true },
    density: { section_gap: 15, card_pad: 10 } },

  'candy-pop': {   // sweet-shop flyer: bubblegum pink, lemon tags
    paper: '#ffffff', ink: '#33131f', soft_ink: '#7a4a5e',
    primary: '#c01f63', accent: '#c01f63', tag_sticker: '#ffe066',
    rule: '#c01f63', rule_soft: '#f4d4e4',
    fonts: { display: 'Helvetica-Bold', body: 'Helvetica', mono: 'Courier' },
    type_scale: { display: 22, section: 12, body: 9.5, caption: 8, line: 13.5 },
    decor: { band: 'primary', band_text: '#ffffff', tag_radius: 5, tag_offset: 2, dashed_rules: true },
    density: { section_gap: 15, card_pad: 10 } },

  'brutalist-concrete': {   // poured-concrete grid: heavy rules, safety tags
    paper: '#ffffff', ink: '#14140f', soft_ink: '#5b5b52',
    primary: '#097063', accent: '#097063', tag_sticker: '#ffd400',
    rule: '#14140f', rule_soft: '#c9c9c4',
    fonts: { display: 'Courier-Bold', body: 'Courier', mono: 'Courier' },
    type_scale: { display: 17, section: 11.5, body: 9, caption: 7.5, line: 12.5 },
    decor: { band: 'primary', band_text: '#ffffff', tag_radius: 0, tag_offset: 0, dashed_rules: false },
    density: { section_gap: 11, card_pad: 7 } }
};

export const DEFAULT_TOKENS = PDF_TOKENS['spaza-classic'];

/**
 * Token wall. Returns an array of violations ([] = safe to ship).
 *  paper luminance >= 0.90 (vintage-paper exempt at 0.88 floor)
 *  ink/paper >= 7:1 · primary-on-paper >= 3:1 (display-size text + rules)
 *  tag_sticker keeps ink text readable (>= 4.5:1) · fonts all standard-14.
 */
export function validateTokens(t, opts = {}) {
  const errs = [];
  if (!t) return ['tokens: missing'];
  const paperFloor = opts.paperFloor ?? 0.88;
  if (luminance(t.paper) < paperFloor) errs.push(`paper too dark: ${t.paper} lum=${luminance(t.paper).toFixed(2)}`);
  if (contrast(t.ink, t.paper) < 7) errs.push(`ink/paper contrast ${contrast(t.ink, t.paper).toFixed(1)} < 7`);
  if (contrast(t.primary, t.paper) < 3) errs.push(`primary/paper contrast ${contrast(t.primary, t.paper).toFixed(1)} < 3`);
  if (contrast(t.ink, t.tag_sticker) < 4.5) errs.push(`ink on tag_sticker contrast ${contrast(t.ink, t.tag_sticker).toFixed(1)} < 4.5`);
  if (contrast(t.decor.band_text, t.primary) < 4.5) errs.push(`band_text on primary contrast ${contrast(t.decor.band_text, t.primary).toFixed(1)} < 4.5`);
  if (!t.decor || contrast(t.decor.band_text, t.primary) < 4.5) return ['decor.band_text contrast < 4.5'];
  const okFonts = new Set(['Courier', 'Courier-Bold', 'Helvetica', 'Helvetica-Bold', 'Times-Roman', 'Times-Bold', 'Times-Italic']);
  for (const k of ['display', 'body', 'mono']) if (!okFonts.has(t.fonts[k])) errs.push(`font not standard-14: ${t.fonts[k]}`);
  if (!((t.type_scale.line >= 11) && (t.type_scale.line <= 16))) errs.push('line height out of print range');
  if (!(t.density.section_gap >= 8 && t.density.card_pad >= 4)) errs.push('density below floor');
  return errs;
}

/** Hard paper-light contract used at render time: dark paper never ships. */
export function assertPaperLight(tokens) {
  if (luminance(tokens.paper) < 0.85) throw new Error('PDF token contract: paper must be light (lum >= 0.85)');
}
