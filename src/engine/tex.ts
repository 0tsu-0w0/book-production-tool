// TeX（LaTeX）の記法で書いた原稿を、tategumi の記法に置き換える。
//   見出し   \chapter{…} → ＃…、\section{…}・\subsection{…} → ＃＃…
//   ルビ     \ruby{漢字}{かんじ}（pxrubrica の「か|ん|じ」も可）→ ｜漢字《かんじ》
//   圏点     \kenten{…}・\bou{…}・\emph{…} → ｜…《圏》　傍線 \bousen{…}・\underline{…} → ｜…《傍線》
//   縦中横   \tatechuyoko{…}・\tcy{…}　割注 \warichu{…}　太字 \textbf{…}
//   改ページ \newpage・\clearpage → ［＃改ページ］、\cleardoublepage → ［＃改丁］
//   目次     \tableofcontents　画像 \includegraphics[…]{ファイル} → ［＃画像：ファイル名（拡張子なし）］
//   数式     $…$・\(…\) → ［＃数式］…［＃／数式］、\[…\]・$$…$$・equation などの環境 → ［＃別行数式］…［＃／別行数式］
//   図       \begin{figure}…\includegraphics…\caption{…}…\end{figure} → ［＃画像：…　キャプション：…］
//   マクロ   \newcommand・\renewcommand・\def（引数・省略時の値も）を展開してから置き換える
//   参照     \label{…} はラベル、\ref{…} はその見出しの題（「…」）、\pageref{…} はそのページ番号
// 段落は LaTeX と同じく、空行で区切る（続く行は1つの段落につなぐ）。% から行末はコメント。
// 知らない命令は、引数の中身だけを残して命令を消す。

export interface TexResult {
  /** tategumi の記法にした原稿。 */
  text: string;
  /** 置き換えた原稿の行ごとの、元の原稿の行（0始まり）。紙面から原稿へ戻るのに使う。 */
  origin: number[];
  /** プリアンブルの \title・\author。 */
  title?: string;
  author?: string;
}

/** 数式の環境（中身をそのまま別行数式にする）。 */
const MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*", "displaymath"]);

/** 空行を入れる印と、段落の字下げをしない印（置き換えの最後に消す）。 */
const BLANK = "\n\u0002\n";
const NO_INDENT = "\u0001";

/** 注の中身：1行にし、記法と紛れる［］を〔〕にする。 */
const noteText = (x: string) => x.replace(/\n/g, "").replace(/［/g, "〔").replace(/］/g, "〕");

/** 引数1つを取って、その中身を置き換えたものを包む命令。 */
const WRAP1: Record<string, (x: string) => string> = {
  chapter: (x) => `\n＃${x}\n`,
  section: (x) => `\n＃＃${x}\n`,
  subsection: (x) => `\n＃＃${x}\n`,
  subsubsection: (x) => `\n＃＃${x}\n`,
  kenten: (x) => `｜${x}《圏》`,
  bou: (x) => `｜${x}《圏》`,
  boten: (x) => `｜${x}《圏》`,
  emph: (x) => `｜${x}《圏》`,
  bousen: (x) => `｜${x}《傍線》`,
  underline: (x) => `｜${x}《傍線》`,
  uline: (x) => `｜${x}《傍線》`,
  tatechuyoko: (x) => `［＃縦中横］${x}［＃／縦中横］`,
  tcy: (x) => `［＃縦中横］${x}［＃／縦中横］`,
  rensuji: (x) => `［＃縦中横］${x}［＃／縦中横］`,
  warichu: (x) => `［＃割注］${x}［＃／割注］`,
  textbf: (x) => `［＃太字］${x}［＃／太字］`,
  footnote: (x) => `［＃注：${noteText(x)}］`,
  endnote: (x) => `［＃注：${noteText(x)}］`,
  vspace: () => BLANK,
};

/** 引数を取らない命令。 */
const WORDS: Record<string, string> = {
  newpage: "\n［＃改ページ］\n",
  clearpage: "\n［＃改ページ］\n",
  pagebreak: "\n［＃改ページ］\n",
  cleardoublepage: "\n［＃改丁］\n",
  tableofcontents: "\n［＃目次］\n",
  par: "\n",
  bigskip: BLANK,
  medskip: BLANK,
  smallskip: BLANK,
  noindent: NO_INDENT,
  indent: "",
  maketitle: "",
  ldots: "……",
  dots: "……",
  LaTeX: "LaTeX",
  TeX: "TeX",
  textbackslash: "\\",
};

/** 1字の記号のエスケープ（\% など）。 */
const ESCAPES = new Set(["%", "&", "#", "$", "_", "{", "}"]);

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  get done() {
    return this.i >= this.s.length;
  }
  peek(n = 0) {
    return this.s[this.i + n] ?? "";
  }
  /** { … } の中身（対応する } まで。入れ子と \} を考える）。{ がなければ null。 */
  group(): string | null {
    this.skipSpaces();
    if (this.peek() !== "{") return null;
    let depth = 0;
    const start = this.i + 1;
    for (; this.i < this.s.length; this.i++) {
      const c = this.s[this.i];
      if (c === "\\") {
        this.i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        this.i++;
        return this.s.slice(start, this.i - 1);
      }
    }
    return this.s.slice(start);
  }
  /** [ … ] の中身。なければ null。 */
  optional(): string | null {
    const save = this.i;
    this.skipSpaces();
    if (this.peek() !== "[") {
      this.i = save;
      return null;
    }
    const end = this.s.indexOf("]", this.i);
    if (end < 0) return null;
    const out = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    return out;
  }
  skipSpaces() {
    while (this.peek() === " " || this.peek() === "\t") this.i++;
  }
  /** close が出てくるまでをそのまま読む（数式の中身）。 */
  until(close: string): string {
    const end = this.s.indexOf(close, this.i);
    const out = end < 0 ? this.s.slice(this.i) : this.s.slice(this.i, end);
    this.i = end < 0 ? this.s.length : end + close.length;
    return out;
  }
}

/** \label の名前 → その前の見出しの題（\ref で使う）。texToMarkup の間だけ持つ。 */
let labels = new Map<string, string>();

/** 段落（行をつないだもの）の中の命令を置き換える。 */
export function convertInline(src: string): string {
  const r = new Reader(src);
  let out = "";
  // 直前に置いた画像の行の「］」の位置（\caption を、その画像のキャプションにする）。
  let imageEnd = -1;
  while (!r.done) {
    const c = r.peek();
    if (c === "$") {
      if (r.peek(1) === "$") {
        r.i += 2;
        out += `\n［＃別行数式］${r.until("$$").trim()}［＃／別行数式］\n`;
      } else {
        r.i++;
        out += `［＃数式］${r.until("$").trim()}［＃／数式］`;
      }
      continue;
    }
    if (c === "{" || c === "}") {
      // ただの波かっこ（グループ）は外す。
      r.i++;
      continue;
    }
    if (c === "~") {
      out += " ";
      r.i++;
      continue;
    }
    if (c === "-" && r.peek(1) === "-" && r.peek(2) === "-") {
      out += "――";
      r.i += 3;
      continue;
    }
    if (c !== "\\") {
      out += c;
      r.i++;
      continue;
    }
    // 命令
    const next = r.peek(1);
    if (ESCAPES.has(next)) {
      out += next;
      r.i += 2;
      continue;
    }
    if (next === "\\") {
      r.i += 2;
      r.optional();
      // 強制改行：次の行は字下げしない。
      out += `\n${NO_INDENT}`;
      continue;
    }
    if (next === "(") {
      r.i += 2;
      out += `［＃数式］${r.until("\\)").trim()}［＃／数式］`;
      continue;
    }
    if (next === "[") {
      r.i += 2;
      out += `\n［＃別行数式］${r.until("\\]").trim()}［＃／別行数式］\n`;
      continue;
    }
    const m = /^\\([A-Za-z]+\*?)/.exec(src.slice(r.i));
    if (!m) {
      // \ のあとが記号（\, \; など）：空白として扱う。
      r.i += 2;
      continue;
    }
    r.i += m[0].length;
    const name = m[1];
    const base = name.replace(/\*$/, "");
    if (base === "begin" || base === "end") {
      const env = r.group() ?? "";
      if (base === "begin" && MATH_ENVS.has(env)) {
        const body = r.until(`\\end{${env}}`);
        // 番号は付けない（星付きの環境にする）。displaymath は中身だけ。
        const star = env.endsWith("*") ? env : `${env}*`;
        const tex = env === "displaymath" ? body.trim() : `\\begin{${star}}${body.trim()}\\end{${star}}`;
        out += `\n［＃別行数式］${tex}［＃／別行数式］\n`;
      } else if (base === "begin" && (env === "tabular" || env === "tabular*" || env === "tabularx")) {
        // 表：列の指定（{l|c|r} など。tabular* と tabularx は幅も）を読み飛ばし、行を \\、欄を & で分ける。
        if (env !== "tabular") r.group();
        const spec = r.group() ?? "";
        out += tableMarkup(r.until(`\\end{${env}}`), spec);
      } else if (env === "quote" || env === "quotation" || env === "center" || env === "flushright" || env === "flushleft" || env === "document") {
        out += "\n";
      }
      continue;
    }
    if (base === "ruby") {
      r.optional();
      const rb = r.group() ?? "";
      // 読みの「|」は残す（熟語ルビ・モノルビとして組む）。
      const rt = r.group() ?? "";
      out += `｜${convertInline(rb)}《${rt}》`;
      continue;
    }
    if (base === "includegraphics") {
      const opts = r.optional() ?? "";
      const file = r.group() ?? "";
      const name = file.split(/[\\/]/).pop()!.replace(/\.[A-Za-z0-9]+$/, "");
      const lines = /(\d+)\s*行/.exec(opts);
      // width=0.8\textwidth のような幅は、版面に対する大きさにする。
      const width = /width\s*=\s*([0-9.]+)\s*\\(?:text|line|column)width/.exec(opts);
      const size = width && Number(width[1]) > 0 && Number(width[1]) < 1 ? `　大きさ：${Math.round(Number(width[1]) * 100)}%` : "";
      out += `\n［＃画像：${name}${lines ? `　${lines[1]}行` : ""}${size}`;
      imageEnd = out.length;
      out += "］\n";
      continue;
    }
    if (base === "caption") {
      r.optional();
      const text = convertInline(r.group() ?? "").replace(/\n/g, "").replace(/［/g, "〔").replace(/］/g, "〕");
      if (imageEnd >= 0 && text) {
        out = `${out.slice(0, imageEnd)}　キャプション：${text}${out.slice(imageEnd)}`;
        imageEnd = -1;
      } else if (text) {
        out += `\n${text}\n`;
      }
      continue;
    }
    if (base === "label") {
      // ラベル：\pageref でページ番号を引けるようにする。
      const key = (r.group() ?? "").trim().replace(/[［］]/g, "");
      if (key) out += `［＃ラベル：${key}］`;
      continue;
    }
    if (base === "pageref") {
      const key = (r.group() ?? "").trim().replace(/[［］]/g, "");
      out += `［＃ページ：${key}］`;
      continue;
    }
    if (base === "ref" || base === "autoref" || base === "nameref") {
      const key = r.group() ?? "";
      const title = labels.get(key.trim());
      out += title === undefined ? "??" : `「${title}」`;
      continue;
    }
    if (WRAP1[base]) {
      r.optional();
      const arg = r.group();
      out += WRAP1[base](convertInline(arg ?? ""));
      continue;
    }
    if (base in WORDS) {
      out += WORDS[base];
      // 命令のあとの空白は、命令の区切り（LaTeX と同じく読み飛ばす）。
      r.skipSpaces();
      continue;
    }
    // 知らない命令：引数があれば中身を残す。
    r.optional();
    const arg = r.group();
    if (arg !== null) out += convertInline(arg);
    else r.skipSpaces();
  }
  return out;
}

/** % から行末までを消す（\% は残す）。 */
function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "%") return line.slice(0, i);
  }
  return line;
}

/** 前の行と次の行をつなぐ。どちらも英字なら空白を入れ、日本語どうしなら詰める（LaTeX の和文と同じ）。 */
function joinLines(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return /[A-Za-z0-9.,;:!?)]$/.test(a) && /^[A-Za-z0-9(]/.test(b) ? `${a} ${b}` : a + b;
}

/**
 * tabular の中身を、tategumi の表の記法（［＃表］…［＃／表］）にする。
 * 1行目のあとに \hline などの罫線があれば、1行目を見出しの行にする。罫線の命令は消す。
 */
function tableMarkup(body: string, spec = ""): string {
  const RULES = /\\(?:hline|toprule|midrule|bottomrule|cline\s*\{[^}]*\})/g;
  const rows = body.split(/\\\\(?:\s*\[[^\]]*\])?/);
  const out: string[] = [];
  let header = false;
  for (const raw of rows) {
    // 2行目の前に罫線があれば、1行目は見出し。
    if (out.length === 1 && /\\(?:hline|midrule)/.test(raw)) header = true;
    const text = raw.replace(RULES, "").trim();
    if (!text) continue;
    const cells = text.split(/(?<!\\)&/).map((c) => convertInline(c.trim()).replace(/\n/g, " ").replace(/[|｜]/g, "／").trim());
    out.push(`| ${cells.join(" | ")} |`);
  }
  if (out.length === 0) return "";
  // 列の指定の l・c・r を、区切りの行の揃え（---・:---:・---:）にする。
  const aligns = (spec.replace(/\{[^}]*\}/g, "").match(/[lcrpXmb]/g) ?? []).map((a) => (a === "c" ? ":---:" : a === "r" ? "---:" : "---"));
  const columns = out[0].split(" | ").length;
  const rule = `|${Array.from({ length: columns }, (_, i) => aligns[i] ?? "---").join("|")}|`;
  if (header) out.splice(1, 0, rule);
  else if (aligns.some((a) => a !== "---")) out.unshift(rule);
  return `\n［＃表］\n${out.join("\n")}\n［＃／表］\n`;
}

/** 段落の頭を全角1字下げる（LaTeX の段落の字下げ）。会話文・見出し・記法の行・\noindent の段落は下げない。 */
function indentParagraph(line: string): string {
  if (line.startsWith(NO_INDENT)) return line.replaceAll(NO_INDENT, "");
  line = line.replaceAll(NO_INDENT, "");
  if (/^(＃|［＃|「|『|（|　|\||\u0002)/.test(line) || line === "") return line;
  return `　${line}`;
}

/** マクロ：引数の数・省略できる最初の引数の既定値・中身。 */
interface Macro {
  args: number;
  optional?: string;
  body: string;
}

/** s[i] が { なら、対応する } までの中身と、その次の位置。 */
function braceGroup(s: string, i: number): [string, number] | undefined {
  if (s[i] !== "{") return undefined;
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === "\\") {
      k++;
      continue;
    }
    if (s[k] === "{") depth++;
    else if (s[k] === "}" && --depth === 0) return [s.slice(i + 1, k), k + 1];
  }
  return undefined;
}

const skipWs = (s: string, i: number) => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

/**
 * \newcommand・\renewcommand・\providecommand・\def の定義を読み、原稿から消す（行の数は変えない）。
 * 書き方：\newcommand{\名前}[引数の数][省略時の値]{中身}、\newcommand\名前{中身}、\def\名前#1#2{中身}。
 */
export function extractMacros(src: string): { text: string; macros: Map<string, Macro> } {
  const macros = new Map<string, Macro>();
  let out = "";
  let i = 0;
  const re = /\\(?:(re|provide)?newcommand\*?|def)(?![A-Za-z])/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let k = skipWs(src, m.index + m[0].length);
    let name: string | undefined;
    const g = braceGroup(src, k);
    if (g) {
      name = /^\s*\\([A-Za-z]+)\s*$/.exec(g[0])?.[1];
      k = g[1];
    } else {
      const n = /^\\([A-Za-z]+)/.exec(src.slice(k));
      if (n) {
        name = n[1];
        k += n[0].length;
      }
    }
    if (!name) continue;
    let args = 0;
    let optional: string | undefined;
    if (m[0].startsWith("\\def")) {
      // \def\名前#1#2{…}
      const p = /^(?:#\d)*/.exec(src.slice(k))![0];
      args = p.length / 2;
      k += p.length;
    } else {
      k = skipWs(src, k);
      const n = /^\[\s*(\d)\s*\]/.exec(src.slice(k));
      if (n) {
        args = Number(n[1]);
        k = skipWs(src, k + n[0].length);
        if (src[k] === "[") {
          const end = src.indexOf("]", k);
          if (end > 0) {
            optional = src.slice(k + 1, end);
            k = skipWs(src, end + 1);
          }
        }
      }
    }
    k = skipWs(src, k);
    const body = braceGroup(src, k);
    if (!body) continue;
    // \providecommand は、すでにあれば何もしない。
    if (!(m[1] === "provide" && macros.has(name))) macros.set(name, { args, ...(optional !== undefined ? { optional } : {}), body: body[0].replace(/\n/g, " ") });
    // 定義を消す。行の対応を保つため、改行は残す。
    out += src.slice(i, m.index) + src.slice(m.index, body[1]).replace(/[^\n]/g, "");
    i = body[1];
    re.lastIndex = body[1];
  }
  return { text: out + src.slice(i), macros };
}

/** マクロを展開する（中身のマクロも。入れ子は20段まで）。 */
export function expandMacros(src: string, macros: Map<string, Macro>): string {
  if (macros.size === 0) return src;
  let s = src;
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    let out = "";
    let i = 0;
    const re = /\\([A-Za-z]+)(?![A-Za-z])/g;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      const macro = macros.get(m[1]);
      // \\名前（強制改行のあとの文字）は命令ではない。
      if (!macro || (m.index > 0 && s[m.index - 1] === "\\")) continue;
      let k = m.index + m[0].length;
      // 命令の名前のあとの空白は、命令の区切り（LaTeX と同じく読み飛ばす）。
      while (s[k] === " ") k++;
      const args: string[] = [];
      if (macro.optional !== undefined) {
        const at = skipWs(s, k);
        if (s[at] === "[") {
          const end = s.indexOf("]", at);
          args.push(s.slice(at + 1, end));
          k = end + 1;
        } else {
          args.push(macro.optional);
        }
      }
      while (args.length < macro.args) {
        const at = skipWs(s, k);
        const g = braceGroup(s, at);
        if (g) {
          args.push(g[0]);
          k = g[1];
        } else {
          // 波かっこのない引数は1字（または1つの命令）。
          const t = /^\\[A-Za-z]+|^[\s\S]/u.exec(s.slice(at))?.[0] ?? "";
          args.push(t);
          k = at + t.length;
        }
      }
      out += s.slice(i, m.index) + macro.body.replace(/#(\d)/g, (_, d: string) => args[Number(d) - 1] ?? "");
      i = k;
      re.lastIndex = k;
      changed = true;
    }
    s = out + s.slice(i);
    if (!changed) break;
  }
  return s;
}

/** \label を、その前の見出しの題と結びつける。 */
function collectLabels(src: string): Map<string, string> {
  const map = new Map<string, string>();
  let title = "";
  const re = /\\(?:(chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}|label\s*\{([^{}]*)\})/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) title = m[2].trim();
    else if (m[3] !== undefined && title) map.set(m[3].trim(), title);
  }
  return map;
}

export function texToMarkup(src: string): TexResult {
  const stripped = src.replace(/\r\n?/g, "\n").split("\n").map(stripComment).join("\n");
  const { text: undefinedText, macros } = extractMacros(stripped);
  const expanded = expandMacros(undefinedText, macros);
  labels = collectLabels(expanded);
  const raw = expanded.split("\n");
  let start = 0;
  let end = raw.length;
  let title: string | undefined;
  let author: string | undefined;
  const begin = raw.findIndex((l) => /\\begin\s*\{document\}/.test(l));
  if (begin >= 0) {
    const preamble = raw.slice(0, begin).join("\n");
    title = /\\title\s*\{([^{}]*)\}/.exec(preamble)?.[1]?.trim();
    author = /\\author\s*\{([^{}]*)\}/.exec(preamble)?.[1]?.trim();
    start = begin + 1;
    const fin = raw.findIndex((l, i) => i > begin && /\\end\s*\{document\}/.test(l));
    if (fin >= 0) end = fin;
  }

  const outLines: string[] = [];
  const origin: number[] = [];
  const emit = (text: string, line: number) => {
    for (const l of text.split("\n")) {
      outLines.push(l);
      origin.push(line);
    }
  };
  // 空行で区切った段落ごとに、行をつないでから命令を置き換える。
  let para = "";
  let paraLine = start;
  const flush = () => {
    if (para.trim() === "") {
      para = "";
      return;
    }
    const converted = convertInline(para.trim())
      // 見出しなどのあとの \label は、改行の次に来るので、前の行（見出し）に付ける。
      .replace(/\n+(［＃ラベル[：:][^］]*］)/g, "$1\n")
      // 和文と数式の間の空白は、LaTeX と同じく無視する（和文と数式の間は詰める）。
      .replace(/(?<=[^\x00-\x7F]) +(?=［＃数式］)/g, "")
      .replace(/(?<=［＃／数式］) +(?=[^\x00-\x7F])/g, "")
      .split("\n")
      .map((l) => l.trim())
      .map(indentParagraph);
    // 置き換えで生まれた空行は詰める（見出しや改ページの前後）。空行はあとで段落の区切りとして入れる。
    emit(
      converted
        .filter((l) => l !== "")
        .map((l) => (l === "\u0002" ? "" : l))
        .join("\n"),
      paraLine,
    );
    para = "";
  };
  for (let i = start; i < end; i++) {
    const line = raw[i].trim();
    if (line === "") {
      if (para.trim() !== "") flush();
      continue;
    }
    if (para === "") paraLine = i;
    para = joinLines(para, line);
  }
  flush();
  return { text: outLines.join("\n"), origin, ...(title ? { title } : {}), ...(author ? { author } : {}) };
}
