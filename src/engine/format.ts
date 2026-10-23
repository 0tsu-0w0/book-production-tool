// 自動整形（FMT-01〜08）。横書きの Web 原稿を縦書きの作法に合わせる。
// 原稿そのものは書き換えず、組版の直前に適用する。どの行がどう変わったかも返す（差分表示用）。

export interface FormatOptions {
  symbols: boolean;
  indent: boolean;
  dialogueBlankLines: boolean;
  digitsFullWidth: boolean;
  kanjiNumerals: boolean;
  spaceAfterMarks: boolean;
  limitMarks: boolean;
}

export interface FormatResult {
  text: string;
  /** 元の行ごとの結果。after が null の行は削除された。 */
  lines: { before: string; after: string | null }[];
}

/** ルビの読み・[[rb:…]]・数式の中は整形しない。 */
const PROTECTED = /(《[^《》\n]*》|\[\[rb:.*?\]\]|［＃(?:別行)?数式］.*?［＃／(?:別行)?数式］)/;
/** 会話文など、字下げしない行の始まり。 */
const OPENING = /^[「『（【〈《〔“‘]/;
const HEADING = /^[＃#]/;
const PAGEBREAK = /^\s*(＝＝＝|===)\s*$/;
const LEADING_SPACE = /^[ 　]+/;
/** 行頭の［＃名前］・［＃名前：…］（閉じる［＃／名前］が同じ行になければ、段落スタイル・画像・表・改ページなどの行の印）。 */
const LINE_MARK = /^［＃([^］：／]+)(?:：[^］]*)?］/;
/** 感嘆符・疑問符の直後でも空白を入れない文字。 */
const NO_SPACE_BEFORE = /^([」』）】〉》〕”’、。，．…―\s　!?！？]|$)/;

const KANJI_DIGITS = "〇一二三四五六七八九";

export function formatText(src: string, opts: FormatOptions): FormatResult {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const kinds = lines.map(classify);
  const after: (string | null)[] = lines.map((line, i) => {
    if (kinds[i] === "heading" || kinds[i] === "pagebreak") return line;
    if (kinds[i] === "blank") return line;
    let out = mapUnprotected(line, (seg) => formatSegment(seg, opts));
    if (opts.indent && kinds[i] === "mark") out = out.replace(LEADING_SPACE, "");
    else if (opts.indent) {
      const body = out.replace(LEADING_SPACE, "");
      out = kinds[i] === "dialogue" ? body : `　${body}`;
    }
    return out;
  });

  if (opts.dialogueBlankLines) {
    // 会話文の前後にある1行だけの空行を削除する。2行以上続く空行は場面転換とみなして残す。
    for (let i = 0; i < lines.length; i++) {
      if (kinds[i] !== "blank") continue;
      const singleBlank = kinds[i - 1] !== "blank" && kinds[i + 1] !== "blank";
      const nearDialogue = kinds[i - 1] === "dialogue" || kinds[i + 1] === "dialogue";
      if (singleBlank && nearDialogue && i > 0 && i < lines.length - 1) after[i] = null;
    }
  }

  return {
    text: after.filter((l): l is string => l !== null).join("\n"),
    lines: lines.map((before, i) => ({ before, after: after[i] })),
  };
}

type LineKind = "heading" | "pagebreak" | "blank" | "dialogue" | "mark" | "text";

function classify(line: string): LineKind {
  if (PAGEBREAK.test(line)) return "pagebreak";
  if (HEADING.test(line)) return "heading";
  const body = line.replace(LEADING_SPACE, "");
  if (body === "") return "blank";
  // 段落スタイルなどの行の印は、前に字下げを足すと印でなくなるので、字下げしない（字下げは段落スタイルで決める）。
  const mark = LINE_MARK.exec(body);
  if (mark && !body.includes(`［＃／${mark[1]}］`)) return "mark";
  return OPENING.test(body) ? "dialogue" : "text";
}

function mapUnprotected(line: string, fn: (s: string) => string): string {
  return line
    .split(PROTECTED)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join("");
}

function formatSegment(s: string, opts: FormatOptions): string {
  let out = s;
  if (opts.symbols) {
    out = out.replace(/[ー－―—–\-]{2,}/g, (m) => "―".repeat(evenLength(m.length)));
    out = out.replace(/\.{3,}|・{3,}|･{3,}|。{3,}|…+/g, (m) => "…".repeat(m[0] === "…" ? evenLength(m.length) : 2));
  }
  if (opts.limitMarks) out = out.replace(/[!?！？]{3,}/g, (m) => m.slice(0, 2));
  if (opts.spaceAfterMarks) {
    out = out.replace(/[!?！？]{1,2}/g, (m, offset: number, whole: string) =>
      NO_SPACE_BEFORE.test(whole.slice(offset + m.length)) ? m : `${m}　`,
    );
  }
  if (opts.kanjiNumerals) out = out.replace(/[0-9０-９]+/g, (m) => toKanjiNumeral(toHalfDigits(m)));
  else if (opts.digitsFullWidth) out = out.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
  return out;
}

function evenLength(n: number): number {
  return Math.max(2, n + (n % 2));
}

function toHalfDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
}

/**
 * 数字を漢数字にする。4桁以上や 0 で始まるもの（年号・番号）は一字ずつ（2026 → 二〇二六）、
 * 3桁以下は位取りで書く（25 → 二十五、105 → 百五）。
 */
export function toKanjiNumeral(digits: string): string {
  if (digits.length >= 4 || (digits.length > 1 && digits[0] === "0")) {
    return [...digits].map((d) => KANJI_DIGITS[Number(d)]).join("");
  }
  const n = Number(digits);
  if (n === 0) return "〇";
  const units: [number, string][] = [[100, "百"], [10, "十"]];
  let rest = n;
  let out = "";
  for (const [value, name] of units) {
    const q = Math.floor(rest / value);
    if (q > 0) out += (q === 1 ? "" : KANJI_DIGITS[q]) + name;
    rest %= value;
  }
  if (rest > 0) out += KANJI_DIGITS[rest];
  return out;
}
