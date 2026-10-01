import type { Face, ShapedGlyph } from "./face.js";
import type { Block, DrawItem, DrawPage, PageLayout, PlacedGlyph, Shape } from "./types.js";
import { textBlocks } from "./blocks.js";
import { multiply, renderMath, type Matrix } from "./math.js";

/** 縦中横を1マスに収めるときの最大幅（em）。 */
const TCY_MAX_WIDTH = 1;

/** 横倒しにする文字列の長さ（em）を、そのマスのフォントで測って Cell に書き込む。 */
export function measureRotated(blocks: Block[], faces: Face[]): void {
  for (const block of textBlocks(blocks)) {
    for (const atom of block.atoms) {
      for (const cell of atom.cells) {
        if (!cell.rotate) continue;
        const face = faces[cell.font ?? 0] ?? faces[0];
        cell.advance = (totalAdvance(face.shape(cell.text, "ltr")) / face.upem) * (cell.scale ?? 1);
      }
    }
  }
}

/** 行の中の数式の前後に空ける長さ（em）。 */
const MATH_SIDE = 0.25;

/**
 * 数式の輪郭をページに置く。縦組み（math）は横倒しの欧文と同じく時計回りに 90° 回し、
 * 横組み（hmath）はそのまま。どちらも数式の上下の中心を行の中心に合わせる。
 * x, y は、縦組みでは行の中心と数式の始まり（上端）、横組みでは数式の始まり（左端）と行の中心。
 */
function mathShapes(g: PlacedGlyph, color: string): Shape[] {
  const box = renderMath(g.text, !!g.display);
  const s = g.size;
  const shift = ((box.depth - box.height) / 2) * s;
  // 行の中の数式は、前後の和文との間を少し空ける（LaTeX の和欧文間の空き）。
  const start = g.display ? 0 : (g.pad ?? MATH_SIDE) * s;
  const place: Matrix = g.kind === "math" ? [0, s, -s, 0, g.x + shift, g.y + start] : [s, 0, 0, s, g.x + start, g.y - shift];
  if (box.paths.length === 0) {
    // 組めなかった数式：置き場所が分かるよう、赤い枠を描く。
    const corner = (x: number, y: number) => ({ x: place[0] * x + place[2] * y + place[4], y: place[1] * x + place[3] * y + place[5] });
    const p1 = corner(0, -box.height);
    const p2 = corner(box.width, box.depth);
    return [{ kind: "rect", x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y), stroke: { width: 0.5, color: "#c00000" } }];
  }
  return box.paths.map((p) => ({ kind: "path", d: p.d, m: multiply(place, p.m), color }));
}

/**
 * 数式の長さ（em）を決める。別行数式が行に入らなければ、入る大きさに縮める。
 * 別行数式の段落は、数式の高さが入るだけの行を取る。組めなかった数式の知らせを返す。
 */
export function measureMath(blocks: Block[], charsPerLine: number, lineGap: number, side = MATH_SIDE): string[] {
  const errors: string[] = [];
  for (const block of textBlocks(blocks)) {
    for (const atom of block.atoms) {
      for (const cell of atom.cells) {
        if (!cell.math) continue;
        const box = renderMath(cell.text, cell.math.display);
        if (box.error) errors.push(`${box.error}（${cell.text}）`);
        let scale = cell.scale ?? 1;
        if (cell.math.display && box.width * scale > charsPerLine) {
          scale = charsPerLine / box.width;
          cell.scale = scale;
        }
        // 前後の空きは、組むたびの設定で決める（記法の読み取り結果は使い回すので、毎回書き直す）。
        cell.math.pad = side;
        cell.advance = (box.width + (cell.math.display ? 0 : side * 2)) * scale;
        if (cell.math.display && block.format) {
          // 行の幅（行送り）に収まらない高さなら、行取りを増やす。
          const needed = Math.ceil(((box.height + box.depth) * scale) / lineGap - 1e-9);
          block.format = { ...block.format, lineSpan: Math.max(block.format.lineSpan, needed) };
        }
      }
    }
  }
  return errors;
}

/** プロポーショナルで詰める字（かなと約物）。漢字は字面いっぱいなので詰めない。 */
const TIGHTEN = /^[\p{Script=Hiragana}\p{Script=Katakana}ー、。，．・：；？！「」『』（）〔〕［］｛｝〈〉《》【】―…]$/u;

/**
 * プロポーショナル（DTP-10）：フォントに縦組みの詰め（vpal）があればその送り幅に、
 * なければ字面（インク）の上下に少しずつ余白を残して、かなと約物の長さを詰める。
 * 約物の詰め（prepareSpacing）のあとで呼ぶ。
 */
export function applyProportional(blocks: Block[], faces: Face[]): void {
  for (const block of textBlocks(blocks)) {
    for (const atom of block.atoms) {
      if (atom.warichu) continue;
      for (const cell of atom.cells) {
        if (!cell.proportional || cell.rotate || cell.tcy || !TIGHTEN.test(cell.text)) continue;
        const face = faces[cell.font ?? 0] ?? faces[0];
        const scale = cell.scale ?? 1;
        const plain = face.shape(cell.text, "ttb", cell.features)[0];
        const vpal = face.shape(cell.text, "ttb", cell.features ? `${cell.features},vpal` : "vpal")[0];
        let advance: number;
        let shift: number;
        if (plain && vpal && vpal.vAdvance !== undefined && Math.abs(vpal.vAdvance - (plain.vAdvance ?? face.upem)) > 1) {
          advance = vpal.vAdvance / face.upem;
          // yOffset は上向き。値が大きくなった分だけ字が上に動く。
          shift = -((vpal.yOffset ?? 0) - (plain.yOffset ?? 0)) / face.upem;
        } else {
          const ink = plain ? face.inkVertical(plain.gid) : null;
          if (!ink) continue;
          const margin = 0.08;
          const emTop = face.upem + face.emBottom;
          const topGap = (emTop - ink.top) / face.upem;
          const inkHeight = (ink.top - ink.bottom) / face.upem;
          advance = Math.min(1, Math.max(0.5, inkHeight + margin * 2));
          shift = -Math.max(0, topGap - margin);
        }
        cell.advance = advance * scale;
        cell.shift = (cell.shift ?? 0) + shift * scale;
        cell.compress = 0;
      }
    }
  }
}

/** 置き場所の決まった文字に、フォントの字形を割り当てる。faces[0] は本文の書体。 */
export function resolvePage(page: PageLayout, faces: Face[], textColor: string): DrawPage {
  return {
    index: page.index,
    width: page.width,
    height: page.height,
    paper: page.paper,
    // 色の決まっていない線（傍線）は文字の色にする。
    shapes: [
      ...page.shapes.map((s) => (s.kind === "line" && !s.color ? { ...s, color: textColor } : s)),
      // 数式は字形ではなく輪郭（パス）で描く。
      ...page.glyphs.flatMap((g) => (g.kind === "math" || g.kind === "hmath" ? mathShapes(g, g.color ?? textColor) : [])),
    ],
    items: page.glyphs
      .filter((g) => g.kind !== "math" && g.kind !== "hmath")
      .map((g) => resolveGlyph(g, g.font ?? 0, faces[g.font ?? 0] ?? faces[0], g.color ?? textColor)),
  };
}

function resolveGlyph(g: PlacedGlyph, faceIndex: number, face: Face, color: string): DrawItem {
  const scale = g.size / face.upem;
  const base = { text: g.text, size: g.size, color, sx: 1, face: faceIndex, ...(g.bold ? { bold: true } : {}), ...(g.src ? { src: g.src } : {}) };

  if (g.kind === "horiz") {
    const shaped = face.shape(g.text, "ltr");
    const w = totalAdvance(shaped) * scale;
    const x = g.align === "center" ? g.x - w / 2 : g.align === "right" ? g.x - w : g.x;
    return { ...base, font: "horiz", glyphs: withOffsets(shaped), x, y: g.y };
  }

  if (g.kind === "rot") {
    // 時計回りに 90° 回すと、字形の上（y の正）が右を向く。仮想ボディの中心を行の中心に合わせる。
    const shaped = face.shape(g.text, "ltr");
    const baselineX = g.x - (face.emBottom + face.upem / 2) * scale;
    return { ...base, font: "horiz", glyphs: withOffsets(shaped), x: baselineX, y: g.y, rotate: true };
  }

  if (g.kind === "hcell") {
    // 横組みの1マス：y は行の中心。仮想ボディの中心を行の中心に合わせる。fit なら1字分の幅に収める。
    const shaped = face.shape(g.text, "ltr", g.features);
    const total = totalAdvance(shaped);
    const sx = g.fit ? Math.min(1, (face.upem * TCY_MAX_WIDTH) / total) : 1;
    const x = g.fit ? g.x + (g.size - total * scale * sx) / 2 : g.x;
    return { ...base, font: "horiz", glyphs: withOffsets(shaped), x, y: g.y + (face.emBottom + face.upem / 2) * scale, sx };
  }

  if (g.kind === "hmark") {
    const shaped = face.shape(g.text, "ltr");
    const center = face.inkCenter(shaped[0].gid);
    return { ...base, font: "horiz", glyphs: withOffsets(shaped), x: g.x - center.x * scale, y: g.y + center.y * scale };
  }

  if (g.kind === "mark") {
    // 記号は仮想ボディのどこに描かれているかが字形ごとに違うので、インクの中心を (x, y) に合わせる。
    const shaped = face.shape(g.text, "ttb");
    const center = face.inkCenter(shaped[0].gid);
    return { ...base, font: "vert", glyphs: withOffsets(shaped), x: g.x - center.x * scale, y: g.y + center.y * scale };
  }

  // マスの上端から仮想ボディの上端までを 1em とみなし、ベースラインの位置を決める。
  const baseline = g.y + (face.upem + face.emBottom) * scale;

  if (g.kind === "tcy") {
    const shaped = face.shape(g.text, "ltr");
    const total = totalAdvance(shaped);
    const sx = Math.min(1, (face.upem * TCY_MAX_WIDTH) / total);
    return { ...base, font: "horiz", glyphs: withOffsets(shaped), x: g.x - (total * scale * sx) / 2, y: baseline, sx };
  }

  const shaped = face.shape(g.text, "ttb", g.features);
  const advance = shaped[0]?.advance ?? face.upem;
  return { ...base, font: "vert", glyphs: withOffsets(shaped), x: g.x - (advance * scale) / 2, y: baseline };
}

function totalAdvance(shaped: readonly ShapedGlyph[]): number {
  return shaped.reduce((sum, s) => sum + s.advance, 0);
}

/** シェーピング結果ごとに、字形の並び（送り量の累計つき）を1つだけ作って共有する。 */
const offsetsCache = new WeakMap<readonly ShapedGlyph[], { gid: number; dx: number }[]>();

function withOffsets(shaped: readonly ShapedGlyph[]): { gid: number; dx: number }[] {
  let glyphs = offsetsCache.get(shaped);
  if (!glyphs) {
    let dx = 0;
    glyphs = shaped.map((s) => {
      const out = { gid: s.gid, dx };
      dx += s.advance;
      return out;
    });
    offsetsCache.set(shaped, glyphs);
  }
  return glyphs;
}
