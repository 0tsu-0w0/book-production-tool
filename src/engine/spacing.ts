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
  /** 行頭禁則の文字が次の行へ出るとき、行内の約物を詰めて入れる（追い込み）。できなければ追い出す。 */
  oikomi: boolean;
  /** 親文字より長いルビを、前後の仮名に1字（ルビ文字1字分）まで掛ける。 */
  rubyOverhang: boolean;
}

export const GRID_TYPOGRAPHY: Typography = { mode: "grid", lineHeadBracket: "full", oikomi: false, rubyOverhang: false };

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
        cells.push(cell);
      }
    }
    if (t.mode === "grid") continue;

    // 約物のアキは、あとで行を合わせるために詰められる（最大で半角）。
    for (const cell of cells) {
      if (cell.rotate || cell.tcy || cell.text === "") continue;
      const cls = punctClass(cell.text);
      const half = 0.5 * (cell.scale ?? 1);
      if (cls === "closing" || cls === "stop") cell.compress = half;
      else if (cls === "opening") {
        cell.compress = half;
        cell.compressFromStart = true;
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
      } else if (a === "opening" && b === "opening") {
        const next = cells[i + 1];
        const scale = next.scale ?? 1;
        next.advance = 0.5 * scale;
        next.shift = -0.5 * scale;
        next.compress = 0;
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
