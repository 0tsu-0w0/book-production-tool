import { MM } from "./layout.js";
import type { PageLayout, PlacedGlyph, Shape } from "./types.js";

// 本文以外のページ要素：付記・ノンブル（PG-01〜05）、枠線（PG-06）、紙の色、上下の飾り、
// 詳しい組み方での柱とマスターページ（DTP-05）。

export type Placement = "note-tl.nombre-bl" | "note-tl.nombre-bc" | "note-bl.nombre-tl" | "both-tl" | "both-bl";
export type Decoration =
  | "none"
  | "double-line"
  | "top-bottom-line"
  | "gradient"
  | "dots"
  | "circle-m"
  | "diamond-m"
  | "square-m"
  | "circle-l"
  | "diamond-l"
  | "square-l";

/** 柱に出すもの。 */
export type HeadSource = "none" | "book-title" | "chapter" | "section";

/**
 * マスターページ（詳しい組み方で使う）。本文ページと、大見出しで始まるページ（章の始まり）の2種類。
 * それぞれ奇数ページ（右綴じの左ページ）と偶数ページ（右ページ）で柱の中身を分けられる。
 */
export interface MasterSettings {
  bookTitle: string;
  /** 柱の位置：上の余白の小口側・上の余白の中央・小口の余白に縦書き。 */
  headPosition: "top-outer" | "top-center" | "fore-edge";
  /** ノンブルの位置：下の余白の小口側・下の余白の中央・上の余白の小口側。 */
  nombrePosition: "bottom-outer" | "bottom-center" | "top-outer";
  /** 柱・ノンブルと版面との間（mm）。 */
  gapMm: number;
  /** 柱・ノンブルの文字サイズ（pt）。 */
  sizePt: number;
  bodyOdd: HeadSource;
  bodyEven: HeadSource;
  bodyNombre: boolean;
  openingOdd: HeadSource;
  openingEven: HeadSource;
  openingNombre: boolean;
}

/**
 * 名前を付けたマスターページ（DTP-05）。［＃マスター：名前］のページから使う。
 * 柱とノンブルの中身、飾りを、標準のマスターから変える（柱の位置・大きさは標準のまま）。
 */
export interface NamedMaster {
  name: string;
  bodyOdd: HeadSource;
  bodyEven: HeadSource;
  bodyNombre: boolean;
  openingOdd: HeadSource;
  openingEven: HeadSource;
  openingNombre: boolean;
  /** 上下の飾り。"inherit" なら標準のまま。 */
  decoration: Decoration | "inherit";
}

/** そのページの時点での章題・節題（柱に使う）。 */
export interface RunningHeads {
  chapter: string;
  section: string;
}

export interface PageDecor {
  /** simple：付記とノンブル（参照元と同じ）。book：マスターページの柱とノンブル。 */
  mode: "simple" | "book";
  master: MasterSettings;
  note1: string;
  note2: string;
  note2Faint: boolean;
  nombre: boolean;
  nombreStart: number;
  placement: Placement;
  /** 見開き用の配置。偶数ページ（右綴じの右ページ）は左右を反転し、付記を出さない。 */
  spread: boolean;
  border: boolean;
  /** 白ページ（本文のないページ）にもノンブル・付記・飾りを付ける。 */
  blankPageNombre: boolean;
  /** 横組み（左綴じ）：奇数ページが右ページになり、小口の左右が逆になる。 */
  horizontal?: boolean;
  /** 付記・ノンブルの大きさ（本文に対する割合。既定 0.8）。 */
  noteScale?: number;
  /** 名前を付けたマスターページ。 */
  masters?: NamedMaster[];
  paperColor: string;
  textColor: string;
  decoration: Decoration;
  decoColor1: string;
  decoColor2: string;
}

type Corner = "tl" | "tr" | "bl" | "br" | "bc";

const PLACEMENTS: Record<Placement, { note: Corner; nombre: Corner; note2: Corner; together: boolean }> = {
  "note-tl.nombre-bl": { note: "tl", nombre: "bl", note2: "br", together: false },
  "note-tl.nombre-bc": { note: "tl", nombre: "bc", note2: "br", together: false },
  "note-bl.nombre-tl": { note: "bl", nombre: "tl", note2: "tr", together: false },
  "both-tl": { note: "tl", nombre: "tl", note2: "br", together: true },
  "both-bl": { note: "bl", nombre: "bl", note2: "tr", together: true },
};

const MIRROR: Record<Corner, Corner> = { tl: "tr", tr: "tl", bl: "br", br: "bl", bc: "bc" };

export function pageNumber(page: PageLayout, d: PageDecor): number {
  return d.nombreStart + page.index;
}

export function decoratePage(page: PageLayout, decor: PageDecor, bodySize: number, running: RunningHeads = { chapter: "", section: "" }): void {
  // 名前付きのマスターのページは、柱・ノンブル・飾りをそのマスターのものにする。
  const named = page.master ? decor.masters?.find((m) => m.name === page.master) : undefined;
  const d: PageDecor = named
    ? {
        ...decor,
        master: {
          ...decor.master,
          bodyOdd: named.bodyOdd,
          bodyEven: named.bodyEven,
          bodyNombre: named.bodyNombre,
          openingOdd: named.openingOdd,
          openingEven: named.openingEven,
          openingNombre: named.openingNombre,
        },
        decoration: named.decoration === "inherit" ? decor.decoration : named.decoration,
      }
    : decor;
  page.paper = d.paperColor;
  // 扉・奥付などには柱もノンブルも付けない（隠しノンブル）。
  if (page.role !== "body" && page.role !== "blank") return;
  if (page.lineCount === 0 && !d.blankPageNombre) return;
  if (d.mode === "book") placeMaster(page, d, running);
  else placeNotes(page, d, bodySize);

  if (d.border) {
    const inset = 4 * MM;
    page.shapes.push({ kind: "rect", x: inset, y: inset, w: page.width - inset * 2, h: page.height - inset * 2, stroke: { width: 0.5, color: d.textColor } });
  }
  page.shapes.push(...decorationShapes(page, d));
}

/**
 * マスターページの柱とノンブルを置く。右綴じの本では、奇数ページは左ページで左側が小口、
 * 偶数ページは右ページで右側が小口になる。
 */
function placeMaster(page: PageLayout, d: PageDecor, running: RunningHeads): void {
  const m = d.master;
  const n = pageNumber(page, d);
  const odd = n % 2 !== 0;
  const opening = page.headings.some((h) => h.level === 1);
  const source = opening ? (odd ? m.openingOdd : m.openingEven) : odd ? m.bodyOdd : m.bodyEven;
  const head = { none: "", "book-title": m.bookTitle, chapter: running.chapter, section: running.section || running.chapter }[source];
  const nombre = (opening ? m.openingNombre : m.bodyNombre) ? String(n) : "";
  const { block } = page;
  const gap = m.gapMm * MM;
  const size = m.sizePt;
  // 小口が左にあるページ：右綴じ（縦組み）では奇数ページ、左綴じ（横組み）では偶数ページ。
  const leftOuter = d.horizontal ? !odd : odd;
  const outerAlign = leftOuter ? "left" : "right";
  const outerX = leftOuter ? block.left : block.left + block.width;
  const topY = block.top - gap;
  const bottomY = block.top + block.height + gap + size * 0.8;
  const horiz = (text: string, x: number, y: number, align: "left" | "center" | "right") =>
    page.glyphs.push({ text, kind: "horiz", x, y, size, color: d.textColor, align });

  // ノンブルと柱がどちらも上の小口側に来るときは、1行にまとめる（小口側にノンブル）。
  if (m.headPosition === "top-outer" && m.nombrePosition === "top-outer") {
    const parts = leftOuter ? [nombre, head] : [head, nombre];
    const text = parts.filter(Boolean).join("　");
    if (text) horiz(text, outerX, topY, outerAlign);
    return;
  }

  if (head) {
    if (m.headPosition === "top-outer") horiz(head, outerX, topY, outerAlign);
    else if (m.headPosition === "top-center") horiz(head, block.left + block.width / 2, topY, "center");
    else {
      // 小口の余白に縦書きで置く。版面の天にそろえる。
      const x = leftOuter ? block.left - gap - size / 2 : block.left + block.width + gap + size / 2;
      [...head].forEach((ch, i) => page.glyphs.push({ text: ch, kind: "vert", x, y: block.top + i * size, size, color: d.textColor }));
    }
  }
  if (nombre) {
    if (m.nombrePosition === "bottom-outer") horiz(nombre, outerX, bottomY, outerAlign);
    else if (m.nombrePosition === "bottom-center") horiz(nombre, block.left + block.width / 2, bottomY, "center");
    else horiz(nombre, outerX, topY, outerAlign);
  }
}

function placeNotes(page: PageLayout, d: PageDecor, bodySize: number): void {
  const n = pageNumber(page, d);
  const mirrored = d.spread && n % 2 === 0;
  const p = PLACEMENTS[d.placement];
  const corner = (c: Corner) => (mirrored ? MIRROR[c] : c);
  const showNotes = !mirrored;
  const size = bodySize * (d.noteScale ?? 0.8);
  const nombreText = d.nombre ? String(n) : "";

  const texts: { corner: Corner; text: string; color: string }[] = [];
  if (p.together) {
    const joined = [nombreText, showNotes ? d.note1 : ""].filter(Boolean).join("　");
    if (joined) texts.push({ corner: corner(p.note), text: joined, color: d.textColor });
  } else {
    if (showNotes && d.note1) texts.push({ corner: corner(p.note), text: d.note1, color: d.textColor });
    if (nombreText) texts.push({ corner: corner(p.nombre), text: nombreText, color: d.textColor });
  }
  if (showNotes && d.note2) {
    texts.push({ corner: corner(p.note2), text: d.note2, color: d.note2Faint ? mix(d.textColor, d.paperColor, 0.45) : d.textColor });
  }
  for (const t of texts) page.glyphs.push(placeCornerText(page, t.corner, t.text, size, t.color));
}

function placeCornerText(page: PageLayout, corner: Corner, text: string, size: number, color: string): PlacedGlyph {
  const { block } = page;
  const bottomMargin = page.height - block.top - block.height;
  const top = corner[0] === "t";
  const y = top ? block.top / 2 + size * 0.35 : block.top + block.height + bottomMargin / 2 + size * 0.35;
  const align = corner === "bc" ? "center" : corner[1] === "l" ? "left" : "right";
  const x = align === "center" ? page.width / 2 : align === "left" ? block.left : block.left + block.width;
  return { text, kind: "horiz", x, y, size, color, align };
}

function decorationShapes(page: PageLayout, d: PageDecor): Shape[] {
  const { block } = page;
  const x0 = block.left;
  const x1 = block.left + block.width;
  const gap = 3.5 * MM;
  const topY = block.top - gap;
  const bottomY = block.top + block.height + gap;
  const [c1, c2] = [d.decoColor1, d.decoColor2];
  const shapes: Shape[] = [];
  const line = (y: number, color: string, width: number) => shapes.push({ kind: "line", x1: x0, y1: y, x2: x1, y2: y, width, color });

  switch (d.decoration) {
    case "none":
      break;
    case "double-line":
      line(topY, c1, 0.6);
      line(topY - 1.2 * MM, c2, 0.6);
      line(bottomY, c1, 0.6);
      line(bottomY + 1.2 * MM, c2, 0.6);
      break;
    case "top-bottom-line":
      line(topY, c1, 0.8);
      line(bottomY, c2, 0.8);
      break;
    case "gradient": {
      // 塗り足しの外（-3mm）まで伸ばす。透明を使わず、色を段階的に変えた帯で表す。
      const steps = 24;
      const band = 7 * MM;
      const bleed = 3 * MM;
      for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        const color = mix(c1, c2, t);
        const h = (band + bleed) / steps;
        shapes.push({ kind: "rect", x: -bleed, y: -bleed + i * h, w: page.width + bleed * 2, h: h + 0.05, fill: color });
        shapes.push({ kind: "rect", x: -bleed, y: page.height + bleed - (i + 1) * h, w: page.width + bleed * 2, h: h + 0.05, fill: color });
      }
      break;
    }
    default: {
      const style = DOT_STYLES[d.decoration];
      const count = Math.max(1, Math.floor((x1 - x0) / style.spacing) + 1);
      const start = (x0 + x1) / 2 - ((count - 1) * style.spacing) / 2;
      for (const y of [topY, bottomY]) {
        for (let i = 0; i < count; i++) {
          const cx = start + i * style.spacing;
          const fill = i % 2 === 0 ? c1 : c2;
          if (style.shape === "circle") shapes.push({ kind: "circle", cx, cy: y, r: style.r, fill });
          else if (style.shape === "diamond") shapes.push({ kind: "diamond", cx, cy: y, r: style.r * 1.25, fill });
          else shapes.push({ kind: "rect", x: cx - style.r, y: y - style.r, w: style.r * 2, h: style.r * 2, fill });
        }
      }
    }
  }
  return shapes;
}

const DOT_STYLES: Record<string, { shape: "circle" | "diamond" | "square"; r: number; spacing: number }> = {
  dots: { shape: "circle", r: 0.35 * MM, spacing: 2.2 * MM },
  "circle-m": { shape: "circle", r: 0.9 * MM, spacing: 3 * MM },
  "diamond-m": { shape: "diamond", r: 0.9 * MM, spacing: 3 * MM },
  "square-m": { shape: "square", r: 0.8 * MM, spacing: 3 * MM },
  "circle-l": { shape: "circle", r: 1.4 * MM, spacing: 4.2 * MM },
  "diamond-l": { shape: "diamond", r: 1.4 * MM, spacing: 4.2 * MM },
  "square-l": { shape: "square", r: 1.25 * MM, spacing: 4.2 * MM },
};

/** 2色を t（0〜1）の割合で混ぜる。t=0 で a、t=1 で b。 */
export function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  return toHex(pa.map((v, i) => v + (pb[i] - v) * t) as [number, number, number]);
}

export function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.padEnd(6, "0");
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}
