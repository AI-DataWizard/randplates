// pdf.js — P-563/P-564 v3: THE THEMED MASTERCLASS PDF (zero dependencies, PWA-safe).
// Hand-rolled PDF 1.4 writer: A4 portrait, standard-14 Type1 fonts with
// /WinAnsiEncoding, per-theme colors + FONTS, sticker stat cards, till-slip
// leader dashes, keep-together pagination with (CONT.) headers, and a
// self-audit that makes overflow a test gate.
//
// P-564 fixes (from the owner's two sample PDFs — every one was real):
//  1. RESOURCE KEYS ARE NAMES: "/F1", not "F1" (the bug that hid theme fonts
//     from every viewer and garbled strict-parser text extraction).
//  2. Header underline moved BELOW the title with real clearance (no more
//     rule slicing through section titles).
//  3. Money fit: shrink 9.5→8 before failing loud; never truncated text.
//  4. Sentence rows carry money in the RIGHT column, never mid-sentence.
//  5. Pagination: (CONT.) headers on split sections, no orphan last pages.
//  6. Cover: hero stat cards (BUDGET / TO BUY / SAVED).
//  7. Leader dashes between label and money (till-slip style), never through
//     wrapped note text.
import { formatRands } from "./costing.js";
import { textWidth, fitText, fitInfo, wrapText, FACE_RES } from "./pdfFonts.js";
import { DEFAULT_TOKENS, assertPaperLight, mix } from "./pdfTokens.js";
import { masterclass } from "./pdfContent.js";

const PAGE_W = 595,
  PAGE_H = 842,
  MARGIN = 48;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const MONEY_RIGHT = PAGE_W - MARGIN;
const GAP = 6;

const clean = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "-");
const esc = (s) =>
  String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

const f2 = (n) => +n.toFixed(2);
const hx = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => +(v / 255).toFixed(3))
    .join(" ");
};
const FILL = (h) => `${hx(h)} rg `;
const STROKE = (h) => `${hx(h)} RG `;
const rect = (x, y, w, h, c) =>
  `q ${FILL(c)}${f2(x)} ${f2(y)} ${f2(w)} ${f2(h)} re f Q\n`;
const rule = (x, y, w, t, c) => rect(x, y, w, Math.max(t, 0.75), c);
const dashed = (x1, x2, y, c) =>
  `q ${STROKE(c)}0.75 w [2 2] 0 d ${f2(x1)} ${f2(y)} m ${f2(x2)} ${f2(y)} l S Q\n`;
const KAPPA = 0.5522847498;
function rrect(x, y, w, h, r, c) {
  r = Math.min(r, w / 2, h / 2);
  const k = r * KAPPA,
    X = x + w,
    Y = y + h;
  return (
    `q ${FILL(c)}${f2(x + r)} ${f2(y)} m ${f2(X - r)} ${f2(y)} l ` +
    `${f2(X - r + k)} ${f2(y)} ${f2(X)} ${f2(y + r - k)} ${f2(X)} ${f2(y + r)} c ` +
    `${f2(X)} ${f2(Y - r)} l ${f2(X)} ${f2(Y - r + k)} ${f2(X - r + k)} ${f2(Y)} ${f2(X - r)} ${f2(Y)} c ` +
    `${f2(x + r)} ${f2(Y)} l ${f2(x + r - k)} ${f2(Y)} ${f2(x)} ${f2(Y - r + k)} ${f2(x)} ${f2(Y - r)} c ` +
    `${f2(x)} ${f2(y + r)} l ${f2(x)} ${f2(y + r - k)} ${f2(x + r - k)} ${f2(y)} ${f2(x + r)} ${f2(y)} c h f Q\n`
  );
}

/* ---- content sections → neutral row blocks (P-564: carry section for CONT.) ---- */
function rowBlocks(content, T) {
  const blocks = [];
  const cover = {
    kind: "cover",
    sub: clean(content.cover.sub),
    meta: content.cover.metaLines.map(clean),
    stats: content.cover.stats.map((s) => ({
      label: clean(s.label),
      value: clean(s.value),
      soft: !!s.soft,
    })),
  };
  blocks.push(cover);
  for (const sec of content.sections) {
    blocks.push({
      kind: "header",
      section: sec.id,
      title: clean(sec.title).toUpperCase(),
      keepNext: true,
    });
    for (const r of sec.rows) {
      if (r === null) continue;
      const base = { section: sec.id };
      if (r.kind === "line")
        blocks.push({
          ...base,
          kind: "line",
          label: clean(r.left),
          money: r.right != null ? clean(r.right) : null,
          indent: r.indent || 0,
          soft: !!r.soft,
          strong: !!r.strong,
          tag: !!r.tag,
        });
      else if (r.kind === "note")
        blocks.push({ ...base, kind: "note", text: clean(r.text) });
      else if (r.kind === "sub")
        blocks.push({
          ...base,
          kind: "sub",
          text: clean(r.text),
          money: r.money != null ? clean(r.money) : null,
          keepNext: true,
        });
      else if (r.kind === "gap") blocks.push({ ...base, kind: "gap" });
    }
    blocks.push({ section: sec.id, kind: "gap" });
  }
  return blocks;
}

/* ---- measure: exact heights (must mirror emit consumption 1:1) ---- */
function measure(blocks, T) {
  const S = T.type_scale;
  for (const b of blocks) {
    if (b.kind === "cover") {
      b.lines = {
        band: 34,
        gapA: 6,
        sub: S.line,
        metaRow: 11,
        gapB: 4,
        stats: 44,
        gapC: 8,
      };
      b.h = 34 + 6 + S.line + b.meta.length * 11 + 4 + 44 + 8;
    } else if (b.kind === "header")
      b.h = S.section + 9; // title + rule + clearance
    else if (b.kind === "line" || b.kind === "sub") b.h = S.line;
    else if (b.kind === "note") {
      b.wrapped = wrapText(b.text, T.fonts.body, S.caption, CONTENT_W - 4, 3);
      b.h = b.wrapped.length * 11 + 2;
    } else if (b.kind === "gap") b.h = T.density.section_gap;
  }
}

/* ---- money fit: shrink before failing loud (P-564 #3) ---- */
function moneyFit(money, T, face) {
  const S = T.type_scale;
  for (const size of [S.body, S.body - 0.5, S.body - 1, 8]) {
    if (textWidth(money, face, size) <= CONTENT_W * 0.42)
      return { size, ok: true };
  }
  return { size: 8, ok: false };
}

/* ---- pagination: keep-together, CONT. headers, no orphan last pages ---- */
function paginate(blocks, T) {
  const M = T.margin ?? MARGIN;
  const full = PAGE_H - 2 * M;
  const pages = [];
  let cur = [],
    room = full;
  const seen = new Set();
  const headerOf = {};
  for (const b of blocks) if (b.kind === "header") headerOf[b.section] = b;
  for (const b of blocks) {
    if (b.kind === "header") seen.add(b.section);
    const nextH = (blocks[blocks.indexOf(b) + 1] || {}).h || 0;
    const need =
      b.h + (b.keepNext ? Math.min(nextH, 2 * T.type_scale.line) : 0);
    if (b.h > full) {
      // oversized note: own page
      if (cur.length) pages.push(cur);
      cur = [b];
      room = full - b.h;
      continue;
    }
    if (need <= room) {
      cur.push(b);
      room -= b.h;
      continue;
    }
    // start a new page; if we land mid-section, re-announce it with a CONT.
    // header whose height is reserved NOW (the P-564 overflow regression).
    if (cur.length) pages.push(cur);
    cur = [];
    room = full;
    if (b.kind !== "header" && b.section && seen.has(b.section)) {
      const src = headerOf[b.section];
      const hb = {
        kind: "header",
        section: b.section,
        cont: true,
        title: (src ? src.title : b.section.toUpperCase()) + " (CONT.)",
        h: src ? src.h : T.type_scale.section + 9,
      };
      cur.push(hb);
      room -= hb.h;
    }
    cur.push(b);
    room -= b.h;
  }
  if (cur.length) pages.push(cur);

  // orphan/widow: a keepNext (header/sub) may never be last on its page
  for (let p = 0; p < pages.length - 1; p++) {
    while (pages[p].length && pages[p][pages[p].length - 1].keepNext) {
      pages[p + 1].unshift(pages[p].pop());
    }
  }
  // no orphan last page: last page must hold >= 4 blocks (pull from prev tail)
  while (pages.length > 1 && pages[pages.length - 1].length < 4) {
    const prev = pages[pages.length - 2],
      last = pages[pages.length - 1];
    if (!prev.length || prev.length <= 5) break;
    let used = last.reduce((t, b) => t + b.h, 0);
    // move back-to-front, skipping keepNext headers; NEVER exceed page room
    for (let i = prev.length - 1; i > 0 && last.length < 4; i--) {
      if (prev[i].keepNext || used + prev[i].h > full) continue;
      const b = prev.splice(i, 1)[0];
      last.unshift(b);
      used += b.h;
    }
    if (!pages[pages.length - 1].length) pages.pop();
  }
  return pages.filter((p) => p.length);
}

/* ---- emit one page (heights come from measure; audit records everything) ---- */
function emitPage(blocks, T, placed, pageNo) {
  const S = T.type_scale;
  const M = T.margin ?? MARGIN;
  let y = PAGE_H - M,
    out = "";
  const baseOf = (top, box, size) => top - (box - size) * 0.5 - size * 0.25;
  const text = (s, face, size, x, base, color) => {
    out += `q ${FILL(color)}BT /${FACE_RES[face]} ${f2(size)} Tf ${f2(x)} ${f2(base)} Td (${esc(s)}) Tj ET Q\n`;
    placed.push({
      page: pageNo,
      kind: "text",
      x,
      y: base,
      w: textWidth(s, face, size),
      h: size,
    });
  };
  for (const b of blocks) {
    if (b.kind === "cover") {
      const L = b.lines;
      out += rect(MARGIN, y - L.band, CONTENT_W, L.band, T.primary);
      placed.push({
        page: pageNo,
        kind: "band",
        x: MARGIN,
        y: y,
        w: CONTENT_W,
        h: L.band,
      }); // top edge
      const tInfo = fitInfo(
        "RANDPLATES WEEK MASTERCLASS",
        T.fonts.display,
        S.display,
        CONTENT_W - 20,
      );
      text(
        tInfo.text,
        T.fonts.display,
        tInfo.size,
        MARGIN + 10,
        y - L.band + 11.5,
        T.decor.band_text,
      );
      y -= L.band + L.gapA;
      if (b.sub) {
        text(
          fitText(b.sub, T.fonts.body, S.body, CONTENT_W),
          T.fonts.body,
          S.body,
          MARGIN,
          baseOf(y, S.line, S.body),
          T.soft_ink,
        );
        y -= L.sub;
      }
      for (const m of b.meta) {
        text(
          fitText(m, T.fonts.body, S.caption, CONTENT_W),
          T.fonts.body,
          S.caption,
          MARGIN,
          baseOf(y, 11, S.caption),
          T.ink,
        );
        y -= L.metaRow;
      }
      y -= L.gapB;
      // hero stat cards
      const cw = (CONTENT_W - 2 * 10) / 3;
      const card = mix(T.ink, T.paper, 0.05);
      b.stats.forEach((st, k) => {
        const x = MARGIN + k * (cw + 10);
        const cy = y - L.stats + 4;
        out += rrect(x, cy, cw, L.stats - 8, 6, card);
        placed.push({
          page: pageNo,
          kind: "card",
          x,
          y: cy + L.stats - 8,
          w: cw,
          h: L.stats - 8,
        }); // top edge
        text(
          fitText(st.label, T.fonts.body, S.caption - 1, cw - 10),
          T.fonts.body,
          S.caption - 1,
          x + 7,
          y - 20,
          T.soft_ink,
        );
        const vInfo = fitInfo(st.value, T.fonts.display, S.stat || 13, cw - 12);
        text(
          vInfo.text,
          T.fonts.display,
          vInfo.size,
          x + 7,
          y - 36,
          st.soft ? T.soft_ink : T.primary,
        );
      });
      y -= L.stats + L.gapC;
      continue;
    }
    if (b.kind === "header") {
      const info = fitInfo(b.title, T.fonts.display, S.section, CONTENT_W - 8);
      const base = y - info.size; // title sits at top of its block
      out += rect(MARGIN, base - 2.5, 2.5, info.size * 0.78, T.primary); // accent bar left of title
      placed.push({
        page: pageNo,
        kind: "bar",
        x: MARGIN,
        y: base - 2.5 + info.size * 0.78,
        w: 2.5,
        h: info.size * 0.78,
      });
      text(info.text, T.fonts.display, info.size, MARGIN + 7, base, T.primary);
      const ruleY = base - 4.5; // underline BELOW the title text
      out += rule(MARGIN, ruleY, CONTENT_W, 0.9, T.rule);
      placed.push({
        page: pageNo,
        kind: "rule",
        x: MARGIN,
        y: ruleY + 0.45,
        w: CONTENT_W,
        h: 0.9,
      });
      y -= b.h;
      continue;
    }
    if (b.kind === "sub") {
      const x = MARGIN;
      if (b.money != null) {
        const mFace = T.fonts.body,
          mf = moneyFit(b.money, T, mFace);
        const mW = textWidth(b.money, mFace, mf.size);
        text(
          b.money,
          mFace,
          mf.size,
          MONEY_RIGHT - mW,
          baseOf(y, S.line, mf.size),
          T.ink,
        );
        if (T.decor.dashed_rules)
          out += dashed(
            x + textWidth(b.text, T.fonts.display, S.body) + 6,
            MONEY_RIGHT - mW - 5,
            baseOf(y, S.line, S.body) - 2.5,
            T.rule_soft,
          );
        text(
          fitText(b.text, T.fonts.display, S.body, MONEY_RIGHT - mW - 12 - x),
          T.fonts.display,
          S.body,
          x,
          baseOf(y, S.line, S.body),
          T.ink,
        );
      } else {
        text(
          fitText(b.text, T.fonts.display, S.body, CONTENT_W),
          T.fonts.display,
          S.body,
          x,
          baseOf(y, S.line, S.body),
          T.ink,
        );
      }
      y -= b.h;
      continue;
    }
    if (b.kind === "line") {
      const x = MARGIN + b.indent * 10;
      const face = b.strong ? T.fonts.display : T.fonts.body;
      let labelMaxW = CONTENT_W - b.indent * 10;
      if (b.money != null) {
        const mf = moneyFit(b.money, T, T.fonts.body);
        const mW = textWidth(b.money, T.fonts.body, mf.size);
        if (!mf.ok)
          placed.push({
            page: pageNo,
            kind: "money-overflow",
            x: MONEY_RIGHT - mW,
            y: baseOf(y, S.line, mf.size),
            w: mW,
            h: mf.size,
            money: b.money,
          });
        if (b.tag) {
          const pad = 4,
            th = mf.size + 5,
            tw = mW + 2 * pad + (T.decor.tag_offset || 0);
          const tx = MONEY_RIGHT - tw;
          const ty = baseOf(y, S.line, mf.size) - 2.5;
          out += rrect(tx, ty, tw, th, T.decor.tag_radius, T.tag_sticker);
          placed.push({
            page: pageNo,
            kind: "tag",
            x: tx,
            y: ty + th,
            w: tw,
            h: th,
          }); // top edge
        }
        text(
          b.money,
          T.fonts.body,
          mf.size,
          MONEY_RIGHT - mW,
          baseOf(y, S.line, mf.size),
          T.ink,
        );
        labelMaxW = MONEY_RIGHT - mW - 10 - x;
        if (T.decor.dashed_rules) {
          const lw = Math.min(
            textWidth(fitText(b.label, face, S.body, labelMaxW), face, S.body),
            labelMaxW,
          );
          out += dashed(
            x + lw + 5,
            MONEY_RIGHT - mW - 5,
            baseOf(y, S.line, S.body) - 2.5,
            T.rule_soft,
          );
        }
      }
      const info = fitInfo(b.label, face, S.body, Math.max(labelMaxW, 40));
      text(
        info.text,
        face,
        info.size,
        x,
        baseOf(y, S.line, info.size),
        b.soft ? T.soft_ink : T.ink,
      );
      y -= b.h;
      continue;
    }
    if (b.kind === "note") {
      for (const l of b.wrapped) {
        text(
          l,
          T.fonts.body,
          S.caption,
          MARGIN + 2,
          baseOf(y, 11, S.caption),
          T.soft_ink,
        );
        y -= 11;
      }
      y -= 2;
      continue;
    }
    if (b.kind === "gap") {
      y -= b.h;
      continue;
    }
  }
  return out;
}

/* ---- self-audit: the no-overflow guarantee ---- */
export function auditPlaced(placed, T) {
  const M = T.margin ?? MARGIN;
  const v = [],
    E = 0.5;
  for (const e of placed) {
    if (e.x < M - E) v.push({ ...e, why: "left" });
    if (e.x + e.w > PAGE_W - M + E) v.push({ ...e, why: "right" });
    const bottom = e.kind === "text" ? e.y - e.h * 0.25 : e.y - e.h;
    if (bottom < M - E) v.push({ ...e, why: "bottom" });
    if (e.y > PAGE_H - M + E && e.kind !== "band") v.push({ ...e, why: "top" });
    if (e.kind === "money-overflow") v.push({ ...e, why: "money-too-wide" });
  }
  // a text glyph box [base-0.25h, base+0.75h] may never cross a rule line
  for (const r of placed.filter((e) => e.kind === "rule")) {
    for (const t of placed.filter(
      (e) => e.kind === "text" && e.page === r.page,
    )) {
      if (t.x + t.w < r.x || t.x > r.x + r.w) continue; // x-ranges must overlap
      if (t.y + t.h * 0.75 > r.y && t.y - t.h * 0.25 < r.y + r.h)
        v.push({ ...t, ruleY: r.y, why: "text-collides-rule" });
    }
  }
  return v;
}

/* ---- serialize (fonts 3..9, /Name keys in the resource dict!) ---- */
function assemblePdf(pages, streams) {
  const objects = [];
  const pageObjIds = pages.map((_, i) => 10 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  [
    "Courier",
    "Courier-Bold",
    "Helvetica",
    "Helvetica-Bold",
    "Times-Roman",
    "Times-Bold",
    "Times-Italic",
  ].forEach((n, i) => {
    objects[3 + i] =
      `<< /Type /Font /Subtype /Type1 /BaseFont /${n} /Encoding /WinAnsiEncoding >>`;
  });
  // P-564 #1: resource keys are PDF NAME objects — /F1, not F1.
  const fontRes = Object.values(FACE_RES)
    .map((r, i) => `/${r} ${3 + i} 0 R`)
    .join(" ");
  pages.forEach((_, i) => {
    const contentObjId = 11 + i * 2;
    objects[pageObjIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << ${fontRes} >> >> /Contents ${contentObjId} 0 R >>`;
    objects[contentObjId] = { stream: streams[i] };
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objects.length; i++) {
    const obj = objects[i];
    if (obj === undefined) continue;
    offsets[i] = pdf.length;
    if (typeof obj === "string") pdf += `${i} 0 obj\n${obj}\nendobj\n`;
    else
      pdf += `${i} 0 obj\n<< /Length ${obj.stream.length} >>\nstream\n${obj.stream}endstream\nendobj\n`;
  }
  const xrefStart = pdf.length;
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++)
    pdf += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

export function buildPlanPdf(plan, opts = {}) {
  let T = opts.tokens || DEFAULT_TOKENS;
  try {
    assertPaperLight(T);
  } catch {
    T = DEFAULT_TOKENS;
  }
  const content = masterclass(plan, opts);
  const blocks = rowBlocks(content, T);
  measure(blocks, T);
  const pages = paginate(blocks, T);
  const placed = [];
  const streams = pages.map((pg, i) => emitPage(pg, T, placed, i + 1));
  const violations = auditPlaced(placed, T);
  const bytes = assemblePdf(pages, streams);
  if (opts.debug)
    return { bytes, placed, violations, tokens: T, content, pages };
  return bytes;
}

export function planPdfName(date = new Date()) {
  return `randplates-plan-${date.toISOString().slice(0, 10)}.pdf`;
}
