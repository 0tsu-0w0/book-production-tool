import type { Atom, Block, ImageBlock, SideLine } from "./types.js";

// 原稿の記法（参照元の文庫ページメーカーと互換）を読み、段落と Atom の並びにする。
//   ルビ    ｜漢字《かんじ》 / 漢字《かんじ》 / [[rb:漢字 > かんじ]]
//   圏点    ｜文字列《圏》（ゴマ）／《白ゴマ》《丸》《白丸》《二重丸》《蛇の目》《三角》《白三角》
//   傍線    ｜文字列《傍線》／《二重傍線》《波線》《点線》《破線》
//   割注    ［＃割注］注の文字列［＃／割注］（半分の大きさの2行で組む）
//   縦中横  ［＃縦中横］12ab［＃／縦中横］（自動の縦中横は 2〜3桁の数字と !? など）
//   見出し  ＃大見出し / ＃＃中見出し
//   改ページ ＝＝＝ / ［＃改ページ］　改丁（次の奇数ページから）［＃改丁］　白ページ ［＃白ページ］
//   扉      ［＃扉］…［＃／扉］（間の行を1ページの中央に置く）
//   目次    ［＃目次］（見出しから目次を作って、ここに入れる）
//   数式    ［＃数式］x^2［＃／数式］（行の中）／［＃別行数式］\int f\,dx［＃／別行数式］（1行に1つ）
//   マスター ［＃マスター：名前］（このページから使うマスターページ。［＃マスター：標準］で戻す）
//   画像    ［＃画像：名前］（版面に1ページ）／［＃画像：名前　全面］／［＃画像：名前　5行　回り込み　地］

export interface ParseOptions {
  /** 2〜3桁の半角数字を縦中横にする。 */
  tcyDigits: boolean;
  /** 自動で縦中横にする桁数の上限（2〜4。既定は 3）。 */
  tcyMaxDigits?: number;
  /** 半角英数字を全角にするか、横倒しで組むか。 */
  halfWidth: "fullwidth" | "rotate";
  /** ＝＝＝ の行で改ページする。 */
  pageBreakMark: boolean;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = { tcyDigits: true, halfWidth: "fullwidth", pageBreakMark: true };

/** 異体字セレクタ（標準・IVS）。 */
const VARIATION_SELECTOR = /^[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
/** 文字列を字に分ける（異体字セレクタは前の字に付ける）。 */
export function splitChars(s: string): string[] {
  return s.match(/[\s\S][\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]?/gu) ?? [];
}

const WARICHU = /^［＃割注］(.+?)［＃／割注］/;
const INLINE_MATH = /^［＃数式］(.+?)［＃／数式］/;
const DISPLAY_MATH = /^\s*［＃別行数式］(.+)［＃／別行数式］\s*$/;
/** 別行数式に当てる段落スタイル。 */
export const DISPLAY_MATH_STYLE = "別行数式";
const MANUAL_TCY = /^［＃縦中横］(.{1,6}?)［＃／縦中横］/;

/** 割注の Atom：2字で半角1つ分の長さ（右の行に前半、左の行に後半）。 */
export function warichuAtom(text: string): Atom {
  const n = Math.max(1, Math.ceil([...text].length / 2));
  return { warichu: text, cells: Array.from({ length: n }, () => ({ text: "", advance: 0.5 })) };
}

/** ルビの読みを区切る字（熟語ルビ・モノルビ）。 */
const RUBY_SEPARATOR = /[|｜]/;

/**
 * ルビの Atom を作る（DTP-07）。読みを「|」で親文字の数に区切った熟語ルビ（とう|きょう）は、
 * どの読みも親文字に収まる（2字まで）なら1字ずつのモノルビにして、字の間で改行できるようにする。
 * 収まらない読みがあれば、熟語全体にかけるグループルビにする（区切りは外す）。
 */
export function rubyAtoms(base: string[], reading: string): Atom[] {
  if (!RUBY_SEPARATOR.test(reading)) return [{ cells: base.map((text) => ({ text })), ruby: reading }];
  const parts = reading.split(RUBY_SEPARATOR);
  if (parts.length === base.length && parts.every((p) => p.length > 0 && [...p].length <= 2)) {
    return base.map((text, k) => ({ cells: [{ text }], ruby: parts[k] }));
  }
  return [{ cells: base.map((text) => ({ text })), ruby: parts.join("") }];
}

/** 圏点の名前と記号。 */
export const KENTEN_MARKS: Record<string, string> = {
  圏: "﹅",
  傍点: "﹅",
  ゴマ: "﹅",
  白ゴマ: "﹆",
  丸: "●",
  白丸: "○",
  二重丸: "◎",
  蛇の目: "◉",
  三角: "▲",
  白三角: "△",
};

/** 傍線の名前と種類。 */
export const SIDELINES: Record<string, SideLine> = {
  傍線: "single",
  二重傍線: "double",
  波線: "wave",
  点線: "dotted",
  破線: "dashed",
};

const KANJI = /^[\p{Script=Han}々〆ヶ〇]$/u;

const RUBY_RB = /^\[\[rb:(.+?)\s*>\s*(.+?)\]\]/;
/** 文字スタイルの始まりと終わり：［＃名前］…［＃／名前］。行頭の［＃名前］だけなら段落スタイル。 */
const STYLE_OPEN = /^［＃([^［］／]+?)］/;
const STYLE_CLOSE = /^［＃／([^［］]+?)］/;
const RUBY_BAR = /^[｜|]([^｜|《》\n]+)《([^《》\n]+)》/;
const RUBY_IMPLICIT = /^《([^《》\n]+)》/;
const DIGITS = /^[0-9]+/;
/** 自動で縦中横にする数字か（2桁から上限の桁数まで）。 */
const isTcyDigits = (digits: string, opts: ParseOptions) => /^[0-9]+$/.test(digits) && digits.length >= 2 && digits.length <= (opts.tcyMaxDigits ?? 3);
const MARK_PAIR = /^[!?！？]{2}(?![!?！？])/;
const DOUBLED = /^(?:[―—]{2}|…{2})/;
/** 横倒しにする半角文字の連なり（語の間の半角スペースも含む）。ルビ記号 | は含めない。 */
const ASCII_RUN = /^[!-{}~]+(?: +[!-{}~]+)*/;

/** 半角の英数記号を全角にする（半角スペースは全角スペースにする）。 */
export function toFullWidth(s: string): string {
  return s
    .replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
    .replace(/ /g, "　");
}

function toHalfWidthMarks(s: string): string {
  return s.replace(/！/g, "!").replace(/？/g, "?");
}

function charAtom(ch: string): Atom {
  return { cells: [{ text: toFullWidth(ch) }] };
}

function isPlainKanji(a: Atom): boolean {
  const c = a.cells[0];
  return a.cells.length === 1 && !a.ruby && !a.kenten && !a.sideline && !c.tcy && !c.rotate && KANJI.test(c.text);
}

/** 横倒しの文字列を、語と空白ごとの Atom にする（語の途中では改行しない）。 */
function rotatedAtoms(run: string): Atom[] {
  return run
    .split(/( +)/)
    .filter((s) => s !== "")
    .map((s) => ({ cells: [{ text: s, rotate: true }] }));
}

export function parseInline(s: string, opts: ParseOptions = DEFAULT_PARSE_OPTIONS, base = 0): Atom[] {
  const atoms: Atom[] = [];
  const styles: string[] = [];
  let i = 0;
  // 各字に、原稿の行の中の位置（記法の始まり）を付ける。
  let start = 0;
  let marked = 0;
  const markSrc = () => {
    for (; marked < atoms.length; marked++) for (const c of atoms[marked].cells) c.src ??= base + start;
  };
  let styled = 0; // 文字スタイルを付け終えた Atom の数
  const markStyled = () => {
    const current = styles[styles.length - 1];
    for (; styled < atoms.length; styled++) if (current && !atoms[styled].style) atoms[styled].style = current;
    styled = atoms.length;
  };
  while (i < s.length) {
    markSrc();
    start = i;
    markStyled();
    const rest = s.slice(i);
    let m: RegExpExecArray | null;

    if ((m = INLINE_MATH.exec(rest))) {
      // 数式は横倒しの欧文と同じく組む（字の長さは数式を組んでから決める）。
      atoms.push({ cells: [{ text: m[1], rotate: true, math: { display: false } }] });
      i += m[0].length;
      continue;
    }
    if ((m = WARICHU.exec(rest))) {
      atoms.push(warichuAtom(toFullWidth(m[1])));
      i += m[0].length;
      continue;
    }
    if ((m = MANUAL_TCY.exec(rest))) {
      atoms.push({ cells: [{ text: m[1], tcy: true }] });
      i += m[0].length;
      continue;
    }
    if ((m = STYLE_CLOSE.exec(rest))) {
      const at = styles.lastIndexOf(m[1]);
      if (at >= 0) styles.splice(at, 1);
      i += m[0].length;
      continue;
    }
    if ((m = STYLE_OPEN.exec(rest))) {
      styles.push(m[1]);
      i += m[0].length;
      continue;
    }

    if ((m = RUBY_RB.exec(rest)) || (m = RUBY_BAR.exec(rest))) {
      const base = splitChars(m[1]);
      const mark = KENTEN_MARKS[m[2]];
      const line = SIDELINES[m[2]];
      if (mark) {
        for (const ch of base) atoms.push({ ...charAtom(ch), kenten: mark });
      } else if (line) {
        for (const ch of base) atoms.push({ ...charAtom(ch), sideline: line });
      } else {
        atoms.push(...rubyAtoms(base.map((ch) => toFullWidth(ch)), m[2]));
      }
      i += m[0].length;
      continue;
    }

    if ((m = RUBY_IMPLICIT.exec(rest))) {
      const base: string[] = [];
      while (atoms.length > 0 && isPlainKanji(atoms[atoms.length - 1])) {
        base.unshift(atoms.pop()!.cells[0].text);
      }
      if (base.length > 0) {
        atoms.push(...rubyAtoms(base, m[1]));
        i += m[0].length;
        continue;
      }
    }

    if ((m = MARK_PAIR.exec(rest))) {
      atoms.push({ cells: [{ text: toHalfWidthMarks(m[0]), tcy: true }] });
      i += m[0].length;
      continue;
    }

    if (opts.halfWidth === "rotate" && (m = ASCII_RUN.exec(rest))) {
      if (opts.tcyDigits && isTcyDigits(m[0], opts)) atoms.push({ cells: [{ text: m[0], tcy: true }] });
      else atoms.push(...rotatedAtoms(m[0]));
      i += m[0].length;
      continue;
    }

    if ((m = DIGITS.exec(rest))) {
      // 2〜3桁の半角数字は縦中横、それ以外は1桁ずつ全角で立てる。
      if (opts.tcyDigits && isTcyDigits(m[0], opts)) {
        atoms.push({ cells: [{ text: m[0], tcy: true }] });
      } else {
        for (const d of m[0]) atoms.push(charAtom(d));
      }
      i += m[0].length;
      continue;
    }

    if ((m = DOUBLED.exec(rest))) {
      // 「――」「……」は2マスで1組にして、行をまたがせない。
      const ch = m[0][0] === "…" ? "…" : "―";
      atoms.push({ cells: [{ text: ch }, { text: ch }] });
      i += m[0].length;
      continue;
    }

    let ch = String.fromCodePoint(s.codePointAt(i)!);
    // 異体字セレクタ（IVS など）は前の字と1字として扱う（DTP-10）。
    const vs = VARIATION_SELECTOR.exec(s.slice(i + ch.length));
    if (vs) ch += vs[0];
    atoms.push(charAtom(ch));
    i += ch.length;
  }
  markSrc();
  markStyled();
  return atoms;
}

/** ページ操作の命令。スタイルの名前には使えない。 */
export const PAGE_COMMANDS = ["改ページ", "改丁", "白ページ", "扉", "目次", "画像", "数式", "マスター"];
const COMMAND = /^\s*［＃(／?)(改ページ|改丁|白ページ|扉|目次)］\s*$/;

/** 画像：［＃画像：名前］。名前のあとに全角か半角の空白で区切って、置き方を書ける。 */
const IMAGE = /^\s*［＃画像[：:]\s*([^［］\s]+)((?:\s+[^［］\s]+)*)\s*］\s*$/u;

/** 画像の置き方を読む：全面・版面・N行（本文の中）、回り込み、天・中央・地。 */
export function parseImageOptions(name: string, options: string[]): ImageBlock {
  const lines = options.map((o) => /^([0-9０-９]+)行$/.exec(o)).find((m) => m);
  const n = lines ? Number(toHalfWidthDigits(lines[1])) : 0;
  const wrap = options.includes("回り込み");
  const position = options.includes("天") ? "top" : options.includes("地") ? "bottom" : wrap ? "bottom" : "center";
  const mode = n > 0 ? "lines" : options.includes("全面") ? "full" : "block";
  const parity = options.includes("偶数") ? "even" : options.includes("奇数") ? "odd" : undefined;
  return { kind: "image", name, mode, lines: Math.max(1, n), wrap: mode === "lines" && wrap, position, ...(parity && mode !== "lines" ? { parity } : {}) };
}

const toHalfWidthDigits = (s: string) => s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

/** マスターページの切り替え：［＃マスター：名前］（「標準」で元に戻す）。 */
const MASTER = /^\s*［＃マスター[：:]\s*([^［］\s]+)\s*］\s*$/u;

/** 扉の始まりと終わり。parse の最後で、間の段落を1つのまとまりにする。 */
type Marker = { kind: "tobira-open" } | { kind: "tobira-close" };

function parseLine(line: string, opts: ParseOptions): Block | Marker {
  const full = line;
  if (opts.pageBreakMark && /^\s*(＝＝＝|===)\s*$/.test(line)) return { kind: "pagebreak" };
  const dm = DISPLAY_MATH.exec(line);
  if (dm) {
    const at = line.indexOf("］") + 1;
    return { kind: "para", style: DISPLAY_MATH_STYLE, atoms: [{ cells: [{ text: dm[1], rotate: true, math: { display: true }, src: at }] }] };
  }
  const ms = MASTER.exec(line);
  if (ms) return { kind: "master", name: ms[1] === "標準" ? "" : ms[1] };
  const img = IMAGE.exec(line);
  if (img) return parseImageOptions(img[1], img[2].trim().split(/\s+/u).filter(Boolean));
  const c = COMMAND.exec(line);
  if (c) {
    if (c[2] === "扉") return { kind: c[1] ? "tobira-close" : "tobira-open" };
    if (!c[1] && c[2] === "目次") return { kind: "toc" };
    if (!c[1]) return c[2] === "白ページ" ? { kind: "blankpage" } : { kind: "pagebreak", odd: c[2] === "改丁" };
  }
  // 行頭の［＃名前］で、同じ行に［＃／名前］がなければ、その行の段落スタイル。
  let style: string | undefined;
  const p = STYLE_OPEN.exec(line);
  if (p && !line.includes(`［＃／${p[1]}］`)) {
    style = p[1];
    line = line.slice(p[0].length);
  }
  const h = /^(＃{1,2}|#{1,2})\s*(.*)$/.exec(line);
  // 行頭の記法（［＃名前］・＃）を除いた分だけ、字の位置をずらす。
  if (h) return { kind: "heading", level: h[1].length as 1 | 2, atoms: parseInline(h[2], opts, full.length - h[2].length), style };
  if (line === "" && !style) return { kind: "blank" };
  return { kind: "para", atoms: parseInline(line, opts, full.length - line.length), style };
}

/**
 * 読み取った行を覚えておき、変わっていない行は読み直さない（1文字直すたびの組み直しを速くするため）。
 * 読み取り方の設定ごとに分け、大きくなりすぎたら捨てる。
 */
const lineCache = new Map<string, Map<string, Block | Marker>>();
const LINE_CACHE_LIMIT = 50_000;

/**
 * 原稿を段落に分ける。lineOf を渡すと、返す段落（の一番外側）ごとに原稿の行の番号を入れる
 * （扉の中の段落の行は、その pagegroup の lines に入る）。sourceLine で、整形後の行を元の原稿の行に読み替える。
 */
export function parse(src: string, opts: ParseOptions = DEFAULT_PARSE_OPTIONS, lineOf?: number[], sourceLine: (i: number) => number = (i) => i): Block[] {
  const optsKey = `${opts.tcyDigits}|${opts.halfWidth}|${opts.pageBreakMark}|${opts.tcyMaxDigits ?? 3}`;
  let cache = lineCache.get(optsKey);
  if (!cache) lineCache.set(optsKey, (cache = new Map()));
  if (cache.size > LINE_CACHE_LIMIT) cache.clear();

  const blocks: Block[] = [];
  // 扉の中なら、その段落を入れる先。閉じ忘れは次の改ページ（なければ原稿の終わり）で閉じる。
  let group: Block[] | null = null;
  let groupLines: number[] = [];
  const rawLines = src.replace(/\r\n?/g, "\n").split("\n");
  for (let n = 0; n < rawLines.length; n++) {
    const line = rawLines[n];
    let cached = cache.get(line);
    if (!cached) cache.set(line, (cached = parseLine(line, opts)));
    const block = cached;
    if (block.kind === "tobira-open") {
      blocks.push({ kind: "pagegroup", role: "tobira", place: "center", blocks: (group = []), lines: (groupLines = []) });
      lineOf?.push(sourceLine(n));
    } else if (block.kind === "tobira-close") {
      group = null;
    } else if (group && block.kind !== "pagebreak" && block.kind !== "blankpage") {
      group.push(block);
      groupLines.push(sourceLine(n));
    } else {
      group = null;
      blocks.push(block);
      lineOf?.push(sourceLine(n));
    }
  }
  while (blocks.length > 0 && blocks[blocks.length - 1].kind === "blank") {
    blocks.pop();
    lineOf?.pop();
  }
  return blocks;
}
