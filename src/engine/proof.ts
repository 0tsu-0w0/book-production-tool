import { isLineEndProhibited, isLineStartProhibited } from "./kinsoku.js";
import type { LineText } from "./types.js";

// 校正の補助（DTP-16）。
//   表記ゆれ：同じ語を漢字とかなで書き分けている、カタカナ語の長音の有無がまちまち、など。原稿の文字列から探す。
//   禁則違反：行頭に来てはいけない字が行頭に、行末に来てはいけない字が行末にある行。組んだ結果から探す。
//   段落末の1文字だけの行：段落の最後の行が1字（句読点・閉じ括弧を除く）しかない行。組んだ結果から探す。

/** 表記ゆれの1つの書き方：出てくる回数と、最初に出てくる原稿の行（1始まり）と位置。 */
export interface VariantForm {
  form: string;
  count: number;
  line: number;
  index: number;
}

export interface VariantGroup {
  /** 何のゆれか（辞書の語・長音・数字の幅）。 */
  kind: "word" | "long-vowel" | "digits";
  forms: VariantForm[];
}

/**
 * よくある表記ゆれ（漢字・かな・送り仮名の違い）。同じ組の中で2つ以上の書き方が出てきたら知らせる。
 * かなの語は前後の文字によっては別の語の一部になるので、漢字の語と組になったときだけ挙げる（ここでは数えるだけ）。
 */
const VARIANT_WORDS: string[][] = [
  ["出来る", "できる"],
  ["出来た", "できた"],
  ["出来ない", "できない"],
  ["下さい", "ください"],
  ["頂く", "いただく"],
  ["頂いた", "いただいた"],
  ["致します", "いたします"],
  ["又は", "または"],
  ["既に", "すでに"],
  ["全て", "すべて"],
  ["様々", "さまざま"],
  ["色々", "いろいろ"],
  ["何故", "なぜ"],
  ["沢山", "たくさん"],
  ["殆ど", "ほとんど"],
  ["綺麗", "きれい"],
  ["嬉しい", "うれしい"],
  ["分かる", "わかる", "解る", "判る"],
  ["分かった", "わかった", "解った", "判った"],
  ["分からない", "わからない", "解らない", "判らない"],
  ["一人", "ひとり"],
  ["二人", "ふたり"],
  ["一つ", "ひとつ", "１つ"],
  ["何時も", "いつも"],
  ["有難う", "ありがとう", "有り難う"],
  ["御免", "ごめん"],
  ["流石", "さすが"],
  ["勿論", "もちろん"],
  ["矢張り", "やはり"],
  ["矢っ張り", "やっぱり"],
  ["丁度", "ちょうど"],
  ["暫く", "しばらく"],
  ["恐らく", "おそらく"],
  ["是非", "ぜひ"],
  ["何処", "どこ"],
  ["其処", "そこ"],
  ["此処", "ここ"],
  ["貴方", "あなた"],
  ["僅か", "わずか"],
  ["呟く", "つぶやく"],
  ["眩しい", "まぶしい"],
  ["行う", "行なう"],
  ["表す", "表わす"],
  ["終る", "終わる"],
  ["変る", "変わる"],
];

/** 文字列の中の出現位置をすべて返す。 */
function occurrences(lines: string[], word: string): { line: number; index: number }[] {
  const out: { line: number; index: number }[] = [];
  lines.forEach((l, i) => {
    for (let at = l.indexOf(word); at >= 0; at = l.indexOf(word, at + word.length)) out.push({ line: i + 1, index: at });
  });
  return out;
}

const KATAKANA_WORD = /[ァ-ヴヵヶ][ァ-ヴヵヶー]{2,}/gu;

export function findVariants(text: string): VariantGroup[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const groups: VariantGroup[] = [];

  // 辞書の語。長い語に含まれる短い語（「出来ない」の中の「出来」など）を数えないよう、辞書の語どうしは別の組にしてある。
  for (const words of VARIANT_WORDS) {
    const forms = words
      .map((w) => ({ w, at: occurrences(lines, w) }))
      .filter((f) => f.at.length > 0)
      .map((f) => ({ form: f.w, count: f.at.length, line: f.at[0].line, index: f.at[0].index }));
    if (forms.length >= 2) groups.push({ kind: "word", forms });
  }

  // カタカナ語の長音の有無（コンピューター／コンピュータ）。
  const kata = new Map<string, { count: number; line: number; index: number }>();
  lines.forEach((l, i) => {
    for (const m of l.matchAll(KATAKANA_WORD)) {
      const e = kata.get(m[0]);
      if (e) e.count++;
      else kata.set(m[0], { count: 1, line: i + 1, index: m.index ?? 0 });
    }
  });
  for (const [word, e] of kata) {
    if (!word.endsWith("ー")) continue;
    const short = kata.get(word.slice(0, -1));
    if (short) {
      groups.push({
        kind: "long-vowel",
        forms: [
          { form: word, ...e },
          { form: word.slice(0, -1), ...short },
        ],
      });
    }
  }

  // 数字の全角と半角が混ざっている（縦中横の自動変換と関わるので知らせる）。
  const digitForms: VariantForm[] = [];
  for (const [form, re] of [
    ["半角数字", /[0-9]/u],
    ["全角数字", /[０-９]/u],
  ] as const) {
    let count = 0;
    let first: { line: number; index: number } | undefined;
    lines.forEach((l, i) => {
      const m = re.exec(l);
      if (!m) return;
      count += (l.match(new RegExp(re.source, "gu")) ?? []).length;
      first ??= { line: i + 1, index: m.index };
    });
    if (first) digitForms.push({ form, count, ...first });
  }
  if (digitForms.length === 2) groups.push({ kind: "digits", forms: digitForms });
  return groups;
}

/** 組んだ結果の中の1行の場所。 */
export interface LineIssue {
  /** 0 始まりのページの通し番号。 */
  page: number;
  /** ページの中の何行目か（1始まり、空行は数えない）。 */
  line: number;
  text: string;
  reason: string;
}

/** 行の最後に置いてよい閉じの約物（段落末の1文字を数えるときに除く）。 */
const TRAILING_PUNCT = /[、。，．！？!?」』）］｝〕〉》】…―]+$/u;

export function checkLines(
  pageCount: number,
  linesOf: (page: number) => LineText[],
  extra: { start: string; end: string } = { start: "", end: "" },
  custom?: { start: string; end: string },
): { kinsoku: LineIssue[]; shortLast: LineIssue[] } {
  // 自分で決めた禁則なら、その字で調べる。そうでなければ強い禁則と、足した字。
  const startBad = (c: string) => (custom ? custom.start.includes(c) : isLineStartProhibited(c, "strong") || extra.start.includes(c));
  const endBad = (c: string) => (custom ? custom.end.includes(c) : isLineEndProhibited(c, "strong") || extra.end.includes(c));
  const kinsoku: LineIssue[] = [];
  const shortLast: LineIssue[] = [];
  for (let p = 0; p < pageCount; p++) {
    linesOf(p).forEach((l, i) => {
      const chars = [...l.text];
      if (chars.length === 0) return;
      const head = chars[0];
      const tail = chars[chars.length - 1];
      // 段落の頭の行の始めの字は、字下げの空白などなので行頭禁則とは見ない。
      if (!l.start && startBad(head)) {
        kinsoku.push({ page: p, line: i + 1, text: l.text, reason: `行頭に「${head}」` });
      }
      if (!l.end && endBad(tail)) {
        kinsoku.push({ page: p, line: i + 1, text: l.text, reason: `行末に「${tail}」` });
      }
      if (l.end && !l.start) {
        const body = l.text.replace(TRAILING_PUNCT, "");
        if ([...body].length <= 1) shortLast.push({ page: p, line: i + 1, text: l.text, reason: "段落の最後の行が1字だけ" });
      }
    });
  }
  return { kinsoku, shortLast };
}
