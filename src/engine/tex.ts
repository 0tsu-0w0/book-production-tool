// TeX（LaTeX）の記法で書いた原稿を、tategumi の記法に置き換える。
//   見出し   \chapter{…} → ＃…、\section{…}・\subsection{…} → ＃＃…
//   ルビ     \ruby{漢字}{かんじ}（pxrubrica の「か|ん|じ」も可）→ ｜漢字《かんじ》
//   圏点     \kenten{…}・\bou{…}・\emph{…} → ｜…《圏》　傍線 \bousen{…}・\underline{…} → ｜…《傍線》
//   縦中横   \tatechuyoko{…}・\tcy{…}　割注 \warichu{…}　太字 \textbf{…}
//   改ページ \newpage・\clearpage → ［＃改ページ］、\cleardoublepage → ［＃改丁］
//   目次     \tableofcontents　画像 \includegraphics[…]{ファイル} → ［＃画像：ファイル名（拡張子なし）］
//   数式     $…$・\(…\) → ［＃数式］…［＃／数式］、\[…\]・$$…$$・equation などの環境 → ［＃別行数式］…［＃／別行数式］
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

/** 段落（行をつないだもの）の中の命令を置き換える。 */
export function convertInline(src: string): string {
  const r = new Reader(src);
  let out = "";
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
      } else if (env === "quote" || env === "quotation" || env === "center" || env === "flushright" || env === "flushleft" || env === "document") {
        out += "\n";
      }
      continue;
    }
    if (base === "ruby") {
      r.optional();
      const rb = r.group() ?? "";
      const rt = (r.group() ?? "").replace(/\|/g, "");
      out += `｜${convertInline(rb)}《${rt}》`;
      continue;
    }
    if (base === "includegraphics") {
      const opts = r.optional() ?? "";
      const file = r.group() ?? "";
      const name = file.split(/[\\/]/).pop()!.replace(/\.[A-Za-z0-9]+$/, "");
      const lines = /(\d+)\s*行/.exec(opts);
      out += `\n［＃画像：${name}${lines ? `　${lines[1]}行` : ""}］\n`;
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

/** 段落の頭を全角1字下げる（LaTeX の段落の字下げ）。会話文・見出し・記法の行・\noindent の段落は下げない。 */
function indentParagraph(line: string): string {
  if (line.startsWith(NO_INDENT)) return line.replaceAll(NO_INDENT, "");
  line = line.replaceAll(NO_INDENT, "");
  if (/^(＃|［＃|「|『|（|　|\u0002)/.test(line) || line === "") return line;
  return `　${line}`;
}

export function texToMarkup(src: string): TexResult {
  const raw = src.replace(/\r\n?/g, "\n").split("\n").map(stripComment);
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
