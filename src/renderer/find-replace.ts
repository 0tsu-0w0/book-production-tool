// 原稿の検索と置換（Ctrl+F・Ctrl+H）。正規表現と、大文字・小文字の区別も選べる。
// 見つかった所は、原稿欄の後ろに重ねた層（同じ字の大きさ・折り返し）に色を付けて示す。
// 置き換えは原稿欄を通して行うので、原稿欄の「元に戻す」（Ctrl+Z）で戻せる（すべて置換は1回で戻る）。

export interface FindHost {
  source: HTMLTextAreaElement;
  setStatus(text: string): void;
}

interface Match {
  start: number;
  end: number;
}

/** 正規表現で使う字を、そのままの字として探すように直す。 */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** 探す文字列（または正規表現）と、その中で見つかった所。正規表現が書き間違いなら error。 */
export function findMatches(text: string, query: string, opts: { regex: boolean; caseSensitive: boolean }): { matches: Match[]; error?: string } {
  if (!query) return { matches: [] };
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? query : escapeRegExp(query), `g${opts.caseSensitive ? "" : "i"}u`);
  } catch (e) {
    return { matches: [], error: `正規表現が正しくありません：${e instanceof Error ? e.message : String(e)}` };
  }
  const matches: Match[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      // 空の一致（^ や \b だけなど）は飛ばして、次の字から探す。
      re.lastIndex++;
      continue;
    }
    matches.push({ start: m.index, end: m.index + m[0].length });
    if (matches.length >= 10000) break;
  }
  return { matches };
}

/** 置き換えた結果の文字列（正規表現なら $1 などを使える）。 */
export function replaceAllText(text: string, query: string, replacement: string, opts: { regex: boolean; caseSensitive: boolean }): { text: string; count: number } {
  const { matches, error } = findMatches(text, query, opts);
  if (error || matches.length === 0) return { text, count: 0 };
  const re = new RegExp(opts.regex ? query : escapeRegExp(query), `g${opts.caseSensitive ? "" : "i"}u`);
  // 正規表現でなければ、置き換える文字列の $ もそのままの字にする。
  const out = text.replace(re, (m, ...rest) => {
    if (m.length === 0) return m;
    return opts.regex ? expand(replacement, m, rest) : replacement;
  });
  return { text: out, count: matches.length };
}

/** 置き換える文字列の $&・$1〜$99・$<名前>・$$ を展開する。 */
function expand(template: string, whole: string, rest: unknown[]): string {
  // rest：グループ…, 位置, 全体の文字列, （名前付きグループ）
  const named = typeof rest[rest.length - 1] === "object" ? (rest[rest.length - 1] as Record<string, string> | undefined) : undefined;
  const groups = rest.slice(0, named ? rest.length - 3 : rest.length - 2) as (string | undefined)[];
  return template.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (token, key: string) => {
    if (key === "$") return "$";
    if (key === "&") return whole;
    if (key.startsWith("<")) return named?.[key.slice(1, -1)] ?? "";
    const n = Number(key);
    return n >= 1 && n <= groups.length ? (groups[n - 1] ?? "") : token;
  });
}

export class FindReplace {
  readonly bar = document.createElement("div");
  private readonly backdrop: HTMLDivElement;
  private readonly query = document.createElement("input");
  private readonly replacement = document.createElement("input");
  private readonly regex = document.createElement("input");
  private readonly caseSensitive = document.createElement("input");
  private readonly count = document.createElement("span");
  private readonly replaceRow = document.createElement("div");
  private matches: Match[] = [];
  private current = -1;
  private timer: number | undefined;

  constructor(
    private readonly host: FindHost,
    backdrop: HTMLDivElement,
  ) {
    this.backdrop = backdrop;
    this.bar.className = "find-bar";
    this.bar.hidden = true;
    this.bar.setAttribute("role", "search");

    const row = document.createElement("div");
    row.className = "find-row";
    this.query.type = "search";
    this.query.placeholder = "検索";
    this.query.setAttribute("aria-label", "検索する文字");
    this.count.className = "find-count";
    row.append(this.query, this.count, this.button("↑", "前を探す（Shift+Enter）", () => this.step(-1)), this.button("↓", "次を探す（Enter・F3）", () => this.step(1)), this.button("✕", "閉じる（Esc）", () => this.close()));

    this.replaceRow.className = "find-row";
    this.replacement.type = "text";
    this.replacement.placeholder = "置換後の文字（正規表現では $1 などが使える）";
    this.replacement.setAttribute("aria-label", "置き換える文字");
    this.replaceRow.append(this.replacement, this.button("置換", "見つかった所を1つ置き換えて、次を探す", () => this.replaceOne()), this.button("すべて置換", "見つかった所をすべて置き換える", () => this.replaceAll()));

    const opts = document.createElement("div");
    opts.className = "find-row find-options";
    opts.append(this.check(this.regex, "正規表現"), this.check(this.caseSensitive, "大文字と小文字を区別"));

    this.bar.append(row, this.replaceRow, opts);

    this.query.addEventListener("input", () => this.refresh(true));
    this.query.addEventListener("keydown", (e) => this.keys(e));
    this.replacement.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.replaceOne();
      } else if (e.key === "Escape") this.close();
    });
    for (const c of [this.regex, this.caseSensitive]) c.addEventListener("change", () => this.refresh(true));
    host.source.addEventListener("input", () => {
      if (this.bar.hidden) return;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.refresh(false), 120);
    });
    host.source.addEventListener("scroll", () => this.syncScroll());
    window.addEventListener("resize", () => this.paint());
  }

  private button(label: string, title: string, action: () => void) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", action);
    return b;
  }

  private check(input: HTMLInputElement, label: string) {
    const wrap = document.createElement("label");
    wrap.className = "check";
    input.type = "checkbox";
    wrap.append(input, document.createTextNode(label));
    return wrap;
  }

  private keys(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }

  /** 検索を開く。replace なら置換の欄も。原稿で選んでいる字があれば、それを探す。 */
  open(replace: boolean) {
    const { source } = this.host;
    const selected = source.value.slice(source.selectionStart, source.selectionEnd);
    if (selected && !selected.includes("\n")) this.query.value = selected;
    this.bar.hidden = false;
    this.replaceRow.hidden = !replace;
    this.refresh(true);
    (replace && this.query.value ? this.replacement : this.query).focus();
    this.query.select();
  }

  close() {
    this.bar.hidden = true;
    this.matches = [];
    this.current = -1;
    this.paint();
    this.host.source.focus();
  }

  get isOpen() {
    return !this.bar.hidden;
  }

  private options() {
    return { regex: this.regex.checked, caseSensitive: this.caseSensitive.checked };
  }

  /** 探し直す。jump なら、カーソルより後ろの最初の所に移る。 */
  private refresh(jump: boolean) {
    const { source } = this.host;
    const { matches, error } = findMatches(source.value, this.query.value, this.options());
    this.matches = matches;
    this.query.setCustomValidity(error ?? "");
    this.query.title = error ?? "";
    if (matches.length === 0) this.current = -1;
    else if (jump || this.current < 0 || this.current >= matches.length) {
      const at = source.selectionStart;
      const i = matches.findIndex((m) => m.start >= at);
      this.current = i >= 0 ? i : 0;
    }
    this.paint();
    if (jump && this.current >= 0) this.reveal();
  }

  /** 次（dir=1）・前（dir=-1）の見つかった所へ。端まで行ったら反対の端へ戻る。 */
  step(dir: 1 | -1) {
    if (this.bar.hidden) return this.open(false);
    if (this.matches.length === 0) return this.refresh(true);
    this.current = (this.current + dir + this.matches.length) % this.matches.length;
    this.paint();
    this.reveal();
  }

  /** 今の所を原稿欄で選び、見えるところまで送る（フォーカスは検索の欄のまま）。 */
  private reveal() {
    const m = this.matches[this.current];
    if (!m) return;
    const { source } = this.host;
    source.setSelectionRange(m.start, m.end);
    const mark = this.backdrop.querySelector<HTMLElement>("mark.current");
    if (mark) {
      const top = mark.offsetTop;
      if (top < source.scrollTop + 20 || top > source.scrollTop + source.clientHeight - 40) source.scrollTop = Math.max(0, top - source.clientHeight / 3);
      this.syncScroll();
    }
  }

  private replaceOne() {
    const m = this.matches[this.current];
    if (!m) return this.refresh(true);
    const { source } = this.host;
    const found = source.value.slice(m.start, m.end);
    const { text } = replaceAllText(found, this.query.value, this.replacement.value, this.options());
    this.write(m.start, m.end, text);
    // 置き換えた字のあとから、次を探す。
    source.setSelectionRange(m.start + text.length, m.start + text.length);
    this.refresh(true);
    this.host.setStatus(`1件を置換しました。残り${this.matches.length}件。`);
  }

  private replaceAll() {
    const { source } = this.host;
    const { text, count } = replaceAllText(source.value, this.query.value, this.replacement.value, this.options());
    if (count === 0) return this.host.setStatus("置き換える所がありません。");
    this.write(0, source.value.length, text);
    this.refresh(false);
    this.host.setStatus(`${count}件を置換しました（Ctrl+Z で戻せます）。`);
  }

  /** 原稿の [from, to) を text に置き換える（原稿欄の「元に戻す」で戻せるように）。 */
  private write(from: number, to: number, text: string) {
    const { source } = this.host;
    const focused = document.activeElement as HTMLElement | null;
    source.focus();
    source.setSelectionRange(from, to);
    if (text) document.execCommand("insertText", false, text);
    else document.execCommand("delete");
    focused?.focus();
  }

  /** 見つかった所に色を付けた層を描く（原稿欄と同じ字の大きさ・折り返し）。 */
  private paint() {
    const { source } = this.host;
    this.backdrop.className = `source-backdrop ${source.className}`;
    const n = this.matches.length;
    this.count.textContent = this.bar.hidden || !this.query.value ? "" : n === 0 ? "0件" : `${this.current + 1} / ${n}件`;
    if (this.bar.hidden || n === 0) {
      this.backdrop.textContent = "";
      return;
    }
    const text = source.value;
    let html = "";
    let at = 0;
    this.matches.forEach((m, i) => {
      html += escapeHtml(text.slice(at, m.start));
      html += `<mark${i === this.current ? ' class="current"' : ""}>${escapeHtml(text.slice(m.start, m.end))}</mark>`;
      at = m.end;
    });
    // 最後の改行のあとにも行の高さを取る（原稿欄と高さをそろえる）。
    html += `${escapeHtml(text.slice(at))} `;
    this.backdrop.innerHTML = html;
    this.syncScroll();
  }

  private syncScroll() {
    this.backdrop.scrollTop = this.host.source.scrollTop;
  }
}
