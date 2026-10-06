import type { Atom, Block, Cell } from "./types.js";
import { textBlocks } from "./blocks.js";

// 約物の詰め（DTP-06）とルビの掛け方（DTP-07）。JIS X 4051・JLREQ の考え方に沿う。
// 括弧や句読点は「半角の字形＋半角のアキ」でできているとみなし、アキを詰めたり広げたりする。
// ここでは行分割の前に、各マスの長さ（advance）・字形のずれ（shift）・まだ詰められる量（compress）を決める。

export interface Typography {
  /** grid：すべて全角ベタ（参照元と同じ）。jis：約物の詰め・追い込み・両端揃え・ルビの掛けを行う。 */
  mode: "grid" | "jis";
  /** 段落の途中の行頭に来た始め括弧を、全角のままにするか半角（天付き）にするか。 */
  lineHeadBracket: "full" | "half";
  /**
   * 行末に来た終わり括弧・句読点を、全角のまま（アキを残す）にするか半角（アキを取る。行末約物半角）にするか。
   * 半角なら、取ったアキの分だけ行に字が入り、字形が行末にそろう。なければ全角。
   */
  lineEndPunct?: "full" | "half";
  /** 行頭禁則の文字が次の行へ出るとき、行内の約物を詰めて入れる（追い込み）。できなければ追い出す。 */
  oikomi: boolean;
  /** 親文字より長いルビを、前後の仮名に1字（ルビ文字1字分）まで掛ける。 */
  rubyOverhang: boolean;
  /** 文字組みアキ量（jis のとき。なければ標準）。 */
  aki?: Mojikumi;
}

/**
 * 文字組みアキ量（InDesign の文字組みアキ量設定にあたる）。値は字（全角1字 = 1）。
 * 括弧・句読点は「半角の字形＋アキ」とみなし、そのアキの量を決める。
 */
export interface Mojikumi {
  /** 終わり括弧（」』）など）のあと。 */
  afterClosing: number;
  /** 読点（、，）のあと。 */
  afterComma: number;
  /** 句点（。．）のあと。 */
  afterPeriod: number;
  /** 始め括弧（「『（など）の前。 */
  beforeOpening: number;
  /** 終わり括弧・句読点のあとに始め括弧が続くとき（」「・。「など）の間。 */
  between: number;
  /** 中点（・：；）の前後それぞれ。 */
  middleDot: number;
  /** 和欧間：和文と欧文（横倒し・横組みの欧文）の間。 */
  latin: number;
  /** 約物のアキを詰めて行の長さを合わせてよい（追い込み・両端揃え）。 */
  compress: boolean;
}

/** 標準（JIS X 4051 の考え方。これまでの組み方と同じ）。 */
export const MOJIKUMI_STANDARD: Mojikumi = {
  afterClosing: 0.5,
  afterComma: 0.5,
  afterPeriod: 0.5,
  beforeOpening: 0.5,
  between: 0.5,
  middleDot: 0.25,
  latin: 0,
  compress: true,
};

/** 文字組みアキ量の型（名前・説明・値）。 */
export const MOJIKUMI_PRESETS: { id: string; label: string; value: Mojikumi }[] = [
  { id: "standard", label: "標準（約物は半角＋半角のアキ）", value: MOJIKUMI_STANDARD },
  { id: "latin-quarter", label: "和欧間四分（和文と欧文の間を四分空ける）", value: { ...MOJIKUMI_STANDARD, latin: 0.25 } },
  { id: "full", label: "約物全角（続く約物も詰めない）", value: { ...MOJIKUMI_STANDARD, between: 1, compress: false } },
  { id: "half", label: "約物半角（句読点・括弧のアキをなくす）", value: { afterClosing: 0, afterComma: 0, afterPeriod: 0, beforeOpening: 0, between: 0, middleDot: 0, latin: 0, compress: false } },
];

/** 句点か（それ以外の句読点は読点）。 */
const PERIODS = new Set([..."。．"]);
/** 中点類：字形は字の中央にあり、前後にアキを持つ。 */
const MIDDLE_DOTS = new Set([..."・：；"]);

export const GRID_TYPOGRAPHY: Typography = { mode: "grid", lineHeadBracket: "full", lineEndPunct: "full", oikomi: false, rubyOverhang: false };

const OPENING = new Set([..."「『（［｛〔〈《【〘〖｟“‘"]);
const CLOSING = new Set([..."」』）］｝〕〉》】〙〗｠”’"]);
const STOPS = new Set([..."、。，．"]);
const KANA = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]$/u;

/** 約物の種類。始め括弧は前（上）に、終わり括弧と句読点は後ろ（下）に半角のアキを持つ。 */
export function punctClass(text: string): "opening" | "closing" | "stop" | null {
  if (OPENING.has(text)) return "opening";
  if (CLOSING.has(text)) return "closing";
  if (STOPS.has(text)) return "stop";
  return null;
}

/**
 * 段落ごとに、マスの長さと詰められる量を決める。
 * 行分割より前に毎回やり直す（記法の読み取り結果は使い回すので、前の設定の値を残さないため）。
 */
export function prepareSpacing(blocks: Block[], t: Typography, rubyScale: number): void {
  for (const block of textBlocks(blocks)) {
    const cells: Cell[] = [];
    for (const atom of block.atoms) {
      atom.rubyBefore = 0;
      for (const cell of atom.cells) {
        // 文字スタイルなどで大きさを変えた字は、その倍率がマスの長さになる。
        // 割注は半角の枠。
        const unit = atom.warichu ? 0.5 : 1;
        if (!cell.rotate) cell.advance = unit * (cell.scale ?? 1) !== 1 ? unit * (cell.scale ?? 1) : undefined;
        cell.shift = 0;
        cell.compress = 0;
        cell.compressFromStart = false;
        cell.endAki = 0;
        cells.push(cell);
      }
    }
    if (t.mode === "grid") continue;

    // 約物のアキ（文字組みアキ量）。字形は半角で、アキはあとで行を合わせるために詰められる（詰めてよいとき）。
    const k = t.aki ?? MOJIKUMI_STANDARD;
    /** マスの長さ（字）。標準と同じ全角なら、これまでどおり値を持たない（倍率が1のとき）。 */
    const setLength = (cell: Cell, length: number, scale: number) => {
      cell.advance = length === 1 && scale === 1 ? undefined : length * scale;
    };
    for (const cell of cells) {
      if (cell.rotate || cell.tcy || cell.text === "") continue;
      const cls = punctClass(cell.text);
      const scale = cell.scale ?? 1;
      if (cls === "closing" || cls === "stop") {
        // 字形は前（上）の半角、アキは後ろ。
        const aki = cls === "closing" ? k.afterClosing : PERIODS.has(cell.text) ? k.afterPeriod : k.afterComma;
        setLength(cell, 0.5 + aki, scale);
        cell.compress = k.compress ? aki * scale : 0;
        // 行末に来たら取れるアキ（行末約物半角）。詰めてよいかに関わらず、アキの全部。
        cell.endAki = aki * scale;
      } else if (cls === "opening") {
        // 字形は後ろ（下）の半角、アキは前。アキを減らした分だけ、字形を前へずらす。
        setLength(cell, 0.5 + k.beforeOpening, scale);
        cell.shift = -(0.5 - k.beforeOpening) * scale;
        cell.compress = k.compress ? k.beforeOpening * scale : 0;
        cell.compressFromStart = true;
      } else if (MIDDLE_DOTS.has(cell.text) && k.middleDot !== 0.25) {
        // 中点類：字形は真ん中の半角、前後に同じアキ（標準の四分ずつなら全角のまま）。
        setLength(cell, 0.5 + k.middleDot * 2, scale);
        cell.shift = (k.middleDot - 0.25) * scale;
      }
    }

    // 約物が続くときは、間のアキを半角1つ分にする（」「・。」・」、・「「 など）。
    for (let i = 0; i + 1 < cells.length; i++) {
      const a = punctClass(cells[i].text);
      const b = punctClass(cells[i + 1].text);
      if (!a || !b || cells[i].tcy || cells[i + 1].tcy) continue;
      if ((a === "closing" || a === "stop") && b !== null) {
        cells[i].advance = 0.5 * (cells[i].scale ?? 1);
        cells[i].compress = 0;
        cells[i].endAki = 0;
        // 終わり括弧・句読点のあとの始め括弧：間のアキは「続くとき」の量（始め括弧の前に付ける）。
        if (b === "opening") {
          const next = cells[i + 1];
          const scale = next.scale ?? 1;
          setLength(next, 0.5 + k.between, scale);
          next.shift = -(0.5 - k.between) * scale;
          next.compress = k.compress ? k.between * scale : 0;
        }
      } else if (a === "opening" && b === "opening") {
        const next = cells[i + 1];
        const scale = next.scale ?? 1;
        next.advance = 0.5 * scale;
        next.shift = -0.5 * scale;
        next.compress = 0;
      }
    }

    // 和欧間：和文の字と欧文（横倒しの字）が隣り合う所に、欧文の側の前後にアキを付ける
    // （欧文の字の長さは組むたびに測り直すので、和文の側のプロポーショナルなどに消されない）。
    if (k.latin > 0) {
      const latin = (c: Cell) => !!c.rotate && !c.math && c.text.trim() !== "";
      const japanese = (c: Cell) => !c.rotate && !c.tcy && !c.math && c.text !== "" && c.text.trim() !== "" && punctClass(c.text) === null;
      for (let i = 0; i + 1 < cells.length; i++) {
        const a = cells[i];
        const b = cells[i + 1];
        if (japanese(a) && latin(b)) {
          const add = k.latin * (b.scale ?? 1);
          b.advance = (b.advance ?? 1) + add;
          b.shift = (b.shift ?? 0) + add;
        } else if (latin(a) && japanese(b)) {
          a.advance = (a.advance ?? 1) + k.latin * (a.scale ?? 1);
        }
      }
    }

    block.atoms.forEach((atom, i) => {
      if (atom.ruby) placeRubySpacing(atom, block.atoms[i - 1], block.atoms[i + 1], t, rubyScale);
    });
  }
}

/** ルビを掛けてよい隣の文字：ルビのない1字の仮名か約物。 */
function canHangOn(atom: Atom | undefined): boolean {
  if (!atom || atom.ruby || atom.cells.length !== 1) return false;
  const c = atom.cells[0];
  return !c.rotate && !c.tcy && (KANA.test(c.text) || punctClass(c.text) !== null);
}

/**
 * 親文字より長いルビ：まず前後の仮名に掛け（それぞれルビ1字分まで）、足りない分は親文字の字間を空ける。
 * 親文字の字間は、各字の前後に均等に配る（1:2:1 の考え方）。
 */
function placeRubySpacing(atom: Atom, prev: Atom | undefined, next: Atom | undefined, t: Typography, rubyScale: number): void {
  const rubyLength = [...atom.ruby!].length * rubyScale * (atom.cells[0].scale ?? 1);
  const baseLength = atom.cells.reduce((s, c) => s + (c.advance ?? 1), 0);
  const excess = rubyLength - baseLength;
  if (excess <= 0) return;
  const limit = rubyScale; // ルビ文字1字分
  const before = t.rubyOverhang && canHangOn(prev) ? Math.min(limit, excess / 2) : 0;
  const after = t.rubyOverhang && canHangOn(next) ? Math.min(limit, excess / 2) : 0;
  const remaining = excess - before - after;
  atom.rubyBefore = before;
  if (remaining <= 0) return;
  const per = remaining / atom.cells.length;
  for (const cell of atom.cells) {
    cell.advance = (cell.advance ?? 1) + per;
    cell.shift = (cell.shift ?? 0) + per / 2;
  }
}

/**
 * 長体・平体：字の取る長さを、行の向きに縮めた分だけ短くする（約物の詰めの量と字のずれも同じ割合で）。
 * 縦組みでは平体（縦を縮める）が、横組みと横倒しの欧文では長体（横を縮める）が行の長さに効く。
 * 約物の詰めとプロポーショナルのあとで呼ぶ。
 */
export function applyDeform(blocks: Block[], horizontal: boolean): void {
  for (const block of textBlocks(blocks)) {
    for (const atom of block.atoms) {
      if (atom.warichu) continue;
      for (const cell of atom.cells) {
        if (cell.sx === undefined && cell.sy === undefined) continue;
        const f = horizontal || cell.rotate ? (cell.sx ?? 1) : (cell.sy ?? 1);
        if (f === 1 || cell.math) continue;
        cell.advance = (cell.advance ?? 1) * f;
        cell.compress = (cell.compress ?? 0) * f;
        if (cell.endAki) cell.endAki *= f;
        cell.shift = (cell.shift ?? 0) * f;
        if (cell.hyph) cell.hyph = cell.hyph.map((h) => ({ at: h.at, width: h.width * f, rest: h.rest * f }));
      }
    }
  }
}
