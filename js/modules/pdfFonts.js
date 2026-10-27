// pdfFonts.js — P-563: standard-14 font metrics for the themed PDF engine.
// Width tables are the Adobe Core-14 AFM advance widths for WinAnsi codes
// 32..126 (1000 units/em), paired with /Encoding /WinAnsiEncoding on every
// font dict (code 39 = quotesingle, 96 = grave). Courier is fixed-pitch 600.
// Zero dependencies; pure functions; node-testable (tests/pdf-tests.js).

/** Resource-name map. The engine emits /Fn from these; objects 3..9 in pdf.js. */
export const FACES = ['Courier', 'Courier-Bold', 'Helvetica', 'Helvetica-Bold',
  'Times-Roman', 'Times-Bold', 'Times-Italic'];
export const FACE_RES = Object.fromEntries(FACES.map((n, i) => [n, 'F' + (i + 1)]));

// WinAnsi 32..126 advance widths (Adobe Core-14 AFM, glyph names paired to
// WinAnsi codes: quotesingle->39, grave->96).
const PACK = {
  'Helvetica': '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584',
  'Helvetica-Bold': '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584',
  'Times-Roman': '250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278 500 500 500 500 500 500 500 500 500 500 278 278 564 564 564 444 921 722 667 667 722 611 556 722 722 333 389 722 611 889 722 722 556 722 667 556 611 722 722 944 722 722 611 333 278 333 469 500 333 444 500 444 500 444 333 500 500 278 278 500 278 778 500 500 500 500 333 389 278 500 500 722 500 500 444 480 200 480 541',
  'Times-Bold': '250 333 555 500 500 1000 833 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 500 500 500 333 333 570 570 570 500 930 722 667 722 722 667 611 778 778 389 500 778 667 944 722 778 611 778 722 556 667 722 722 1000 722 722 667 333 278 333 581 500 333 500 556 444 556 444 333 500 556 278 333 556 278 833 556 500 556 556 444 389 333 278 556 500 722 500 500 444 394 220 394 520',
  'Times-Italic': '250 333 420 500 500 833 778 214 333 333 500 675 250 333 250 278 500 500 500 500 500 500 500 500 500 500 333 333 675 675 675 500 920 611 611 667 722 611 611 722 722 333 444 667 556 833 667 722 611 722 611 500 556 722 611 833 611 556 556 389 278 389 422 500 333 500 500 444 500 444 278 500 500 278 278 444 278 722 500 500 500 500 389 389 278 500 444 667 444 444 389 400 275 400 541'
};
const W = Object.fromEntries(Object.entries(PACK).map(([k, v]) => [k, v.split(' ').map(Number)]));

const CHAR_BASE = 32;

/** Exact advance width of a clean (escaped-free) string, in points. */
export function textWidth(str, face, size) {
  const s = String(str ?? '');
  if (face === 'Courier' || face === 'Courier-Bold') return s.length * 600 * size / 1000;
  const t = W[face];
  if (!t) return s.length * 600 * size / 1000;   // unknown face: conservative mono estimate
  let u = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    u += t[c - CHAR_BASE] ?? 556;               // pdfText maps anything else to '-'
  }
  return u * size / 1000;
}

/** Deterministic truncation with '...' (binary search). Money strings NEVER pass
 *  through here — a money string that cannot fit is an audit violation, not a
 *  silent trim. display=true lets short headings shrink up to 12% first (keeps
 *  cover titles whole); body text truncates only, never shrinks (ragged
 *  baselines read as broken). */
export function fitText(str, face, size, maxWidth, opts = {}) {
  const s = String(str ?? '');
  if (textWidth(s, face, size) <= maxWidth) return s;
  if (opts.display) {
    const shrink = Math.max(0.88, maxWidth / textWidth(s, face, size));
    const sz = +(size * shrink).toFixed(2);
    if (textWidth(s, face, sz) <= maxWidth) return s;   // caller re-renders at sz via fitInfo
    return ellipsize(s, face, size, maxWidth);
  }
  return ellipsize(s, face, size, maxWidth);
}

/** Like fitText but reports the size to render at (display shrink support). */
export function fitInfo(str, face, size, maxWidth) {
  const s = String(str ?? '');
  const w = textWidth(s, face, size);
  if (w <= maxWidth) return { text: s, size };
  const shrink = Math.max(0.88, maxWidth / w);
  const sz = +(size * shrink).toFixed(2);
  if (textWidth(s, face, sz) <= maxWidth) return { text: s, size: sz };
  const cut = ellipsize(s, face, size, maxWidth);
  return { text: cut, size };
}

function ellipsize(s, face, size, maxWidth) {
  const ell = '...';
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(s.slice(0, mid) + ell, face, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + ell;
}

/** Greedy word wrap with real metrics. A single word wider than maxWidth is
 *  hard-broken with '-' so the audit never sees an unbounded line. */
export function wrapText(str, face, size, maxWidth, maxLines = Infinity) {
  const words = String(str ?? '').split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (textWidth(test, face, size) <= maxWidth) { line = test; continue; }
    if (line) { out.push(line); line = ''; }
    if (textWidth(w, face, size) <= maxWidth) { line = w; continue; }
    let seg = '';
    for (const ch of w) {
      if (textWidth(seg + ch + '-', face, size) > maxWidth) { out.push(seg + '-'); seg = ch; }
      else seg += ch;
    }
    line = seg;
  }
  if (line) out.push(line);
  if (out.length > maxLines) {
    out.length = maxLines;
    out[maxLines - 1] = ellipsize(out[maxLines - 1], face, size, maxWidth);
  }
  return out.length ? out : [''];
}
