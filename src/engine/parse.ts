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
/** ラベルとページ番号の参照：［＃ラベル：名前］・［＃ページ：名前］。 */
const LABEL = /^［＃ラベル[：:]([^［］]+)］/u;
const PAGE_REF = /^［＃ページ[：:]([^［］]+)］/u;
const LABEL_LINE = /^\s*［＃ラベル[：:]([^［］]+)］\s*$/u;

/** 注：［＃注：中身］（中身は章末・巻末にまとめる）。 */
const NOTE = /^［＃注[：:]([^［］]*)］/u;
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

/**
 * 横倒しの文字列を、語と空白ごとの Atom にする（語の途中では改行しない）。
 * URL やハイフンでつないだ語は、「/」（「//」の間は除く）と「-」のあとでも改行できるようにする。
 */
function rotatedAtoms(run: string): Atom[] {
  return run
    .split(/( +)/)
    .flatMap((s) => (s.startsWith(" ") ? [s] : s.split(/(?<=\/)(?!\/)|(?<=[A-Za-z]-)(?=[A-Za-z])/)))
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
  let pendingLabel: string | undefined;
  while (i < s.length) {
    if (pendingLabel && atoms.length > 0) {
      atoms[0].label = pendingLabel;
      pendingLabel = undefined;
    }
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
    if ((m = LABEL.exec(rest))) {
      // ラベルは前の字に付ける（行頭なら次の字に）。
      if (atoms.length > 0) atoms[atoms.length - 1].label = m[1].trim();
      else pendingLabel = m[1].trim();
      i += m[0].length;
      continue;
    }
    if ((m = PAGE_REF.exec(rest))) {
      // 番号は組んでから入れる。それまでは仮に3桁分。
      atoms.push({ cells: [{ text: "000", tcy: true }], pageRef: m[1].trim() });
      i += m[0].length;
      continue;
    }
    if ((m = NOTE.exec(rest))) {
      const at = base + i + m[0].indexOf(m[1]);
      atoms.push({ cells: [{ text: "注" }, { text: "0", tcy: true }], note: parseInline(m[1], opts, at) });
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

    if (s[i] === " " && opts.halfWidth === "rotate") {
      // 半角を半角のまま組むときは、和文と欧文の間などの半角の空白も、全角にせず字の幅のまま。
      atoms.push({ cells: [{ text: " ", rotate: true }] });
      i++;
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

/** キャプションの段落スタイルの名前。 */
export const CAPTION_STYLE = "キャプション";

/** 「上10下5」のような、方向と数の組を読む。 */
function sides(s: string): Partial<Record<"上" | "下" | "左" | "右", number>> {
  const out: Partial<Record<"上" | "下" | "左" | "右", number>> = {};
  for (const m of toHalfWidthDigits(s).replace(/[．]/g, ".").replace(/[－−]/g, "-").matchAll(/([上下左右])\s*(-?[0-9]+(?:\.[0-9]+)?)/gu)) {
    out[m[1] as "上"] = Number(m[2]);
  }
  return out;
}

/**
 * 画像の置き方を読む：全面・版面・N行（本文の中）、回り込み、天・中央・地、偶数・奇数。
 * 切り抜き（枠いっぱい）・切り抜き：上10下10（元の画像を％で切る）・大きさ：80%・ずらす：右2下3（mm）。
 */
export function parseImageOptions(name: string, options: string[]): ImageBlock {
  const lines = options.map((o) => /^([0-9０-９]+)行$/.exec(o)).find((m) => m);
  const n = lines ? Number(toHalfWidthDigits(lines[1])) : 0;
  const wrap = options.includes("回り込み");
  const position = options.includes("天") ? "top" : options.includes("地") ? "bottom" : wrap ? "bottom" : "center";
  const mode = n > 0 ? "lines" : options.includes("全面") ? "full" : "block";
  const parity = options.includes("偶数") ? "even" : options.includes("奇数") ? "odd" : undefined;
  const block: ImageBlock = { kind: "image", name, mode, lines: Math.max(1, n), wrap: mode === "lines" && wrap, position, ...(parity && mode !== "lines" ? { parity } : {}) };
  const value = (key: string) => options.find((o) => o.startsWith(`${key}：`) || o.startsWith(`${key}:`))?.slice(key.length + 1);
  if (options.includes("切り抜き") && mode !== "full") block.fill = true;
  const crop = value("切り抜き");
  if (crop) {
    const c = sides(crop);
    const f = (v = 0) => Math.min(0.45, Math.max(0, v / 100));
    block.crop = { top: f(c.上), right: f(c.右), bottom: f(c.下), left: f(c.左) };
  }
  const size = value("大きさ");
  if (size && mode !== "full") {
    const v = Number(toHalfWidthDigits(size).replace(/[%％]/g, ""));
    if (v > 0) block.scale = Math.min(1, Math.max(0.1, v / 100));
  }
  const shift = value("ずらす");
  if (shift) {
    const s = sides(shift);
    block.shift = { x: (s.右 ?? 0) - (s.左 ?? 0), y: (s.下 ?? 0) - (s.上 ?? 0) };
  }
  return block;
}

const toHalfWidthDigits = (s: string) => s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

/** 表の始まりと終わり。 */
const TABLE_OPEN = /^\s*［＃表(?:[：:]\s*([^［］]*))?］\s*$/u;
const TABLE_CLOSE = /^\s*［＃／表］\s*$/u;
/** 見出しの行と本体を分ける区切りの行：|---|---|（全角も可）。 */
const TABLE_RULE = /^\s*[|｜]?\s*[-－ー―:：]{2,}\s*(?:[|｜]\s*[-－ー―:：]{2,}\s*)*[|｜]?\s*$/u;
export const TABLE_STYLE = "表";
export const TABLE_HEADER_STYLE = "表の見出し";

/**
 * 表の行を欄に分ける。区切りは「|」か「｜」。ただし「｜漢字《かんじ》」のようなルビの「｜」は区切りにしない。
 * 返すのは、欄の文字と、行の中の位置。
 */
export function splitTableRow(line: string): { text: string; at: number }[] {
  const cells: { text: string; at: number }[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== "|" && c !== "｜") continue;
    if (c === "｜" && /^｜[^｜|《]+《[^》]*》/u.test(line.slice(i))) continue;
    cells.push({ text: line.slice(start, i), at: start });
    start = i + 1;
  }
  cells.push({ text: line.slice(start), at: start });
  // 行頭・行末の区切りの外側は欄ではない。
  if (cells.length > 1 && cells[0].text.trim() === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].text.trim() === "") cells.pop();
  return cells.map((c) => {
    const lead = c.text.length - c.text.trimStart().length;
    return { text: c.text.trim(), at: c.at + lead };
  });
}

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
  const label = LABEL_LINE.exec(line);
  if (label) return { kind: "anchor", name: label[1].trim() };
  const ms = MASTER.exec(line);
  if (ms) return { kind: "master", name: ms[1] === "標準" ? "" : ms[1] };
  const img = IMAGE.exec(line);
  if (img) {
    // キャプション：は最後に書く（空白を含めてよい）。
    const cap = /[\s](?:キャプション|説明)[：:]\s*(.*?)\s*$/u.exec(img[2]);
    const options = (cap ? img[2].slice(0, cap.index) : img[2]).trim().split(/\s+/u).filter(Boolean);
    const block = parseImageOptions(img[1], options);
    if (cap && cap[1]) {
      const at = line.lastIndexOf(cap[1]);
      block.caption = { kind: "para", style: CAPTION_STYLE, atoms: parseInline(cap[1], opts, at) };
    }
    return block;
  }
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
    const tableOpen = TABLE_OPEN.exec(line);
    if (tableOpen) {
      // 表：［＃／表］（なければ空行か原稿の終わり）までの行を、表の行にする。
      // ［＃表：罫なし］・［＃表：行の罫］で罫線を、［＃表：見出し二重線］で見出しのあとの線を変える。
      const options = (tableOpen[1] ?? "").split(/[\s　、,]+/u);
      const table: Block = {
        kind: "table",
        rows: [],
        header: 0,
        ...(options.includes("罫なし") ? { rules: "none" as const } : options.includes("行の罫") ? { rules: "rows" as const } : {}),
        ...(options.includes("見出し二重線") ? { headerDouble: true } : {}),
      };
      (group ?? blocks).push(table);
      if (group) groupLines.push(sourceLine(n));
      else lineOf?.push(sourceLine(n));
      for (n++; n < rawLines.length && !TABLE_CLOSE.test(rawLines[n]) && rawLines[n].trim() !== ""; n++) {
        const row = rawLines[n];
        if (TABLE_RULE.test(row)) {
          table.header = table.rows.length;
          // 「:---:」は中央、「---:」は地（右）揃え、「:---」と「---」は天（左）揃え。
          table.align = splitTableRow(row).map((c) => {
            const t = c.text.replace(/：/g, ":");
            return t.startsWith(":") && t.endsWith(":") ? "center" : t.endsWith(":") ? "end" : "start";
          });
          continue;
        }
        table.rows.push({
          line: sourceLine(n),
          cells: splitTableRow(row).map((c) => ({ kind: "para", style: TABLE_STYLE, atoms: parseInline(c.text, opts, c.at) })),
        });
      }
      for (let r = 0; r < table.header; r++) for (const c of table.rows[r].cells) c.style = TABLE_HEADER_STYLE;
      // 空行で終わったときは、その空行を段落の区切りとして残す。
      if (n < rawLines.length && !TABLE_CLOSE.test(rawLines[n])) n--;
      continue;
    }
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
