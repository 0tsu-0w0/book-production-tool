import type { FontChoice } from "../document/settings.js";
import { SPOT_LIST_ID } from "./spot-editor.js";
import { PAGE_COMMANDS } from "../engine/parse.js";
import { grepError } from "../engine/grep.js";
import {
  BUILTIN_PARAGRAPH_STYLES,
  DEFORMS,
  DEFORM_RATIOS,
  GLYPH_FORMS,
  GREP_EXAMPLES,
  RULE_KINDS,
  type ParagraphRule,
  type RuleKind,
  type Deform,
  fontKey,
  type GlyphForm,
  newCharacterStyle,
  newParagraphStyle,
  type CharacterStyle,
  type ParagraphStyle,
  type NestedStyle,
  RUBY_ALIGNS,
  RUBY_SIDES,
  type RubyAlign,
  type RubySide,
  type StyleSheet,
} from "../document/styles.js";

// 設定欄の「スタイル」。段落スタイル・文字スタイルを選んで、書体や大きさなどを変える（DTP-04）。

export interface StyleEditorFont {
  name: string;
  choice: FontChoice;
}

type Kind = "paragraph" | "character";

export class StyleEditor {
  private kind: Kind = "paragraph";
  private selected: Record<Kind, string> = { paragraph: "大見出し", character: "太字" };

  constructor(
    private readonly root: HTMLElement,
    private readonly getSheet: () => StyleSheet,
    private readonly fonts: () => StyleEditorFont[],
    private readonly onChange: () => void,
  ) {}

  render() {
    const sheet = this.getSheet();
    this.root.replaceChildren();

    const kindSelect = this.select(
      [
        ["paragraph", "段落スタイル"],
        ["character", "文字スタイル"],
      ],
      this.kind,
      (v) => {
        this.kind = v as Kind;
        this.render();
      },
    );
    this.root.append(this.labeled("種類", kindSelect));

    const list = sheet[this.kind] as (ParagraphStyle | CharacterStyle)[];
    if (!list.some((s) => s.name === this.selected[this.kind])) this.selected[this.kind] = list[0]?.name ?? "";
    const style = list.find((s) => s.name === this.selected[this.kind]);

    const nameSelect = this.select(
      list.map((s) => [s.name, s.name]),
      this.selected[this.kind],
      (v) => {
        this.selected[this.kind] = v;
        this.render();
      },
    );
    const add = this.button("追加", () => this.add());
    const row = document.createElement("div");
    row.className = "row";
    row.append(nameSelect, add);
    this.root.append(this.labeled("スタイル", row));
    this.root.append(this.hint());
    if (!style) return;

    const builtin = this.kind === "paragraph" && BUILTIN_PARAGRAPH_STYLES.includes(style.name);
    if (!builtin) {
      const name = document.createElement("input");
      name.type = "text";
      name.value = style.name;
      name.addEventListener("change", () => this.rename(style, name.value.trim(), name));
      const del = this.button("削除", () => this.remove(style));
      del.classList.add("danger");
      const r = document.createElement("div");
      r.className = "row";
      r.append(name, del);
      this.root.append(this.labeled("名前", r));
    }

    // 書体：本文と同じか、PC のフォントから選ぶ。
    const fontOptions: [string, string][] = [["", this.kind === "paragraph" ? "本文と同じ" : "段落と同じ"]];
    for (const f of this.fonts()) fontOptions.push([fontKey(f.choice), f.name]);
    if (style.font && !fontOptions.some(([k]) => k === fontKey(style.font!))) fontOptions.push([fontKey(style.font), `${style.font.name}（見つかりません）`]);
    this.root.append(
      this.labeled(
        "書体",
        this.select(fontOptions, style.font ? fontKey(style.font) : "", (v) => {
          style.font = v ? (this.fonts().find((f) => fontKey(f.choice) === v)?.choice ?? style.font) : null;
          this.onChange();
        }),
      ),
    );
    this.root.append(this.number("文字サイズ（本文に対する倍率）", style.scale, 0.3, 5, 0.05, "倍", (v) => (style.scale = v)));

    if (this.kind === "paragraph") {
      const p = style as ParagraphStyle;
      this.root.append(this.number("行取り", p.lineSpan, 1, 10, 1, "行", (v) => (p.lineSpan = v)));
      this.root.append(
        this.number("行送り（標準に対する割合）", Math.round(p.linePitch * 100), 50, 300, 5, "%", (v) => (p.linePitch = Math.round(v) / 100)),
      );
      this.root.append(
        this.labeled(
          "揃え",
          this.select(
            [
              ["start", "天（字下げのあと）"],
              ["center", "中央"],
              ["end", "地付き"],
            ],
            p.align,
            (v) => {
              p.align = v as ParagraphStyle["align"];
              this.onChange();
            },
          ),
        ),
      );
      this.root.append(this.number("字下げ", p.indent, 0, 40, 0.5, "字", (v) => (p.indent = v)));
      this.root.append(this.number("前の空き", p.spaceBefore, 0, 10, 1, "行", (v) => (p.spaceBefore = v)));
      this.root.append(this.number("後の空き", p.spaceAfter, 0, 10, 1, "行", (v) => (p.spaceAfter = v)));
      this.root.append(this.check("孤立行を避ける（1行目だけ・最後の1行だけをページの境目で離さない）", p.keepLines, (v) => (p.keepLines = v)));
      this.root.append(this.check("次の行と離さない（ページの最後に取り残さない）", p.keepWithNext, (v) => (p.keepWithNext = v)));
      this.root.append(this.check("段抜き（段組みのとき、すべての段をまたいで置く。前の本文は段の長さをそろえる）", !!p.spanColumns, (v) => (p.spanColumns = v || undefined)));
    }

    // 色：指定しなければ文字の色。
    const useColor = document.createElement("input");
    useColor.type = "checkbox";
    useColor.checked = style.color !== null;
    const picker = document.createElement("input");
    picker.type = "color";
    // 登録した特色を候補に出す。
    picker.setAttribute("list", SPOT_LIST_ID);
    picker.value = style.color ?? "#9e3d3f";
    picker.disabled = !useColor.checked;
    useColor.addEventListener("change", () => {
      style.color = useColor.checked ? picker.value : null;
      picker.disabled = !useColor.checked;
      this.onChange();
    });
    picker.addEventListener("input", () => {
      style.color = picker.value;
      this.onChange();
    });
    const colorRow = document.createElement("label");
    colorRow.className = "field check";
    colorRow.append(useColor, document.createTextNode("色を変える"), picker);
    this.root.append(colorRow);

    const bold = document.createElement("input");
    bold.type = "checkbox";
    bold.checked = style.bold;
    bold.addEventListener("change", () => {
      style.bold = bold.checked;
      this.onChange();
    });
    const boldRow = document.createElement("label");
    boldRow.className = "field check";
    boldRow.append(bold, document.createTextNode("太字（輪郭を太らせる擬似ボールド）"));
    this.root.append(boldRow);

    // 字形（DTP-10）：OpenType の字形の切り替えと、プロポーショナル。
    const forms: [string, string][] = GLYPH_FORMS.map(([k, label]) => [k, k === "" && this.kind === "character" ? "段落と同じ" : label]);
    this.root.append(
      this.labeled(
        "字形（フォントにある場合）",
        this.select(forms, style.glyphForm, (v) => {
          style.glyphForm = v as GlyphForm;
          this.onChange();
        }),
      ),
    );
    this.root.append(this.check("かなと約物を詰める（プロポーショナル）", style.proportional, (v) => (style.proportional = v)));

    // 長体・平体：字を縦長・横長に変形する。縦組みでは平体が、横組みでは長体が行の長さを縮める。
    const deforms: [string, string][] = DEFORMS.map(([k, label]) => [k, k === "" && this.kind === "character" ? "段落と同じ" : label]);
    const ratio = this.select(
      DEFORM_RATIOS.map((r) => [String(r), `${r}%`]),
      String(style.deformRatio),
      (v) => {
        style.deformRatio = Number(v);
        this.onChange();
      },
    ) as HTMLSelectElement;
    ratio.disabled = !style.deform;
    const kind = this.select(deforms, style.deform, (v) => {
      style.deform = v as Deform;
      ratio.disabled = !style.deform;
      this.onChange();
    });
    const deformRow = document.createElement("div");
    deformRow.className = "row";
    deformRow.append(kind, ratio);
    this.root.append(this.labeled("長体・平体", deformRow));

    // ルビの揃え・側（空なら文書の設定。文字スタイルは段落スタイルより優先）。
    const rubyRow = document.createElement("div");
    rubyRow.className = "row";
    rubyRow.append(
      this.select(
        RUBY_ALIGNS.map(([k, label]) => [k, k === "" && this.kind === "character" ? "段落と同じ" : label]),
        style.rubyAlign,
        (v) => {
          style.rubyAlign = v as RubyAlign;
          this.onChange();
        },
      ),
      this.select(
        RUBY_SIDES.map(([k, label]) => [k, k === "" && this.kind === "character" ? "段落と同じ" : label]),
        style.rubySide,
        (v) => {
          style.rubySide = v as RubySide;
          this.onChange();
        },
      ),
    );
    this.root.append(this.labeled("ルビの揃えと側", rubyRow));

    // 字間（トラッキング）：字のあとに足す長さ。全角1字の 1/1000（InDesign と同じ単位）。
    this.root.append(
      this.number(this.kind === "character" ? "字間（0 なら段落と同じ）" : "字間（トラッキング）", style.tracking, -500, 1000, 10, "／1000 字", (v) => (style.tracking = Math.round(v))),
    );

    if (this.kind === "paragraph") {
      this.root.append(this.dropCapSection(style as ParagraphStyle, sheet));
      this.root.append(this.decorationSection(style as ParagraphStyle));
      this.root.append(this.nestedSection(style as ParagraphStyle, sheet));
      this.root.append(this.grepSection(style as ParagraphStyle, sheet));
    }
  }

  /** ドロップキャップ：またがる行数（なしで使わない）・大きくする字数・大きな字に当てる文字スタイル。 */
  private dropCapSection(p: ParagraphStyle, sheet: StyleSheet): HTMLElement {
    const d = p.dropCap;
    const box = document.createElement("fieldset");
    box.className = "deco-styles";
    const legend = document.createElement("legend");
    legend.textContent = "ドロップキャップ";
    const help = document.createElement("p");
    help.className = "hint";
    help.textContent = "段落の頭の字を大きくして、何行かにまたがらせます。行頭の字下げ（全角の空白）は落とします。大きな字の分だけ、またがる行を下げて始めます。";
    const details = document.createElement("div");
    details.className = "deco-rule-details";
    details.hidden = d.lines < 2;
    const lines = this.select(
      [
        ["0", "なし"],
        ...[2, 3, 4, 5].map((n): [string, string] => [String(n), `${n}行にまたがる`]),
      ],
      String(d.lines),
      (v) => {
        d.lines = Number(v);
        details.hidden = d.lines < 2;
        this.onChange();
      },
    );
    const styleOptions: [string, string][] = [["", "段落の字のまま"], ...sheet.character.map((c): [string, string] => [c.name, c.name])];
    if (d.style && !sheet.character.some((c) => c.name === d.style)) styleOptions.push([d.style, `${d.style}（ありません）`]);
    details.append(
      this.number("大きくする字数", d.chars, 1, 5, 1, "字", (v) => (d.chars = Math.round(v))),
      this.labeled(
        "大きな字の文字スタイル（書体・色・太字）",
        this.select(styleOptions, d.style, (v) => {
          d.style = v;
          this.onChange();
        }),
      ),
    );
    box.append(legend, help, this.labeled("大きさ", lines), details);
    return box;
  }

  /**
   * 段落の罫線・網掛け：前の罫・後の罫・囲み罫（それぞれ 種類・太さ・色、前後の罫は字との間）、網掛けの色、
   * 囲み罫と網掛けの字との間、長さ（行の長さいっぱい・字のある所だけ）。使っていない罫の細かな設定は隠す。
   */
  private decorationSection(p: ParagraphStyle): HTMLElement {
    const d = p.decoration;
    const box = document.createElement("fieldset");
    box.className = "deco-styles";
    const legend = document.createElement("legend");
    legend.textContent = "罫線・網掛け";
    const help = document.createElement("p");
    help.className = "hint";
    help.textContent =
      "縦組みでは前の罫は段落の右、後の罫は左に、横組みでは上と下に引きます。色を変えなければ文字の色です。字の位置は動かないので、前後の段落と近いときは「前の空き」「後の空き」で間を空けてください。";
    box.append(legend, help);

    /** 色：文字の色か、選んだ色。 */
    const colorControl = (value: string | null, set: (v: string | null) => void, fallback: string) => {
      const own = document.createElement("input");
      own.type = "checkbox";
      own.checked = value !== null;
      const picker = document.createElement("input");
      picker.type = "color";
      picker.setAttribute("list", SPOT_LIST_ID);
      picker.value = value ?? fallback;
      picker.disabled = !own.checked;
      own.addEventListener("change", () => {
        picker.disabled = !own.checked;
        set(own.checked ? picker.value : null);
        this.onChange();
      });
      picker.addEventListener("input", () => {
        set(picker.value);
        this.onChange();
      });
      const label = document.createElement("label");
      label.className = "field check";
      label.append(own, document.createTextNode("色を変える"), picker);
      return label;
    };

    /** 罫1本の設定。on のときだけ細かな設定を見せる。 */
    const ruleControls = (title: string, r: ParagraphRule, withGap: boolean) => {
      const wrap = document.createElement("div");
      wrap.className = "deco-rule";
      const details = document.createElement("div");
      details.className = "deco-rule-details";
      details.hidden = !r.on;
      const on = this.check(title, r.on, (v) => {
        r.on = v;
        details.hidden = !v;
      });
      const kind = this.select(RULE_KINDS, r.kind, (v) => {
        r.kind = v as RuleKind;
        this.onChange();
      });
      details.append(
        this.labeled("種類", kind),
        this.number("太さ", r.width, 0.1, 10, 0.1, "pt", (v) => (r.width = v)),
        ...(withGap ? [this.number("字との間", r.gap, 0, 5, 0.1, "字", (v) => (r.gap = v))] : []),
        colorControl(r.color, (v) => (r.color = v), "#7a5c3a"),
      );
      wrap.append(on, details);
      return wrap;
    };

    const shadingDetails = document.createElement("div");
    shadingDetails.className = "deco-rule-details";
    shadingDetails.hidden = !d.shading;
    const shadingColor = document.createElement("input");
    shadingColor.type = "color";
    shadingColor.setAttribute("list", SPOT_LIST_ID);
    shadingColor.value = d.shading ?? "#ece6da";
    shadingColor.addEventListener("input", () => {
      d.shading = shadingColor.value;
      this.onChange();
    });
    shadingDetails.append(this.labeled("網の色", shadingColor));
    const shading = this.check("網掛け（段落の後ろを色で塗る）", !!d.shading, (v) => {
      d.shading = v ? shadingColor.value : null;
      shadingDetails.hidden = !v;
    });

    box.append(
      ruleControls("前の罫", d.ruleBefore, true),
      ruleControls("後の罫", d.ruleAfter, true),
      ruleControls("囲み罫", d.border, false),
      shading,
      shadingDetails,
      this.number("囲み罫・網掛けと字の間", d.pad, 0, 5, 0.1, "字", (v) => (d.pad = v)),
      this.labeled(
        "長さ",
        this.select(
          [
            ["column", "行の長さいっぱい"],
            ["text", "字のある所だけ"],
          ],
          d.length,
          (v) => {
            d.length = v === "text" ? "text" : "column";
            this.onChange();
          },
        ),
      ),
    );
    return box;
  }

  /**
   * 正規表現スタイル：この段落スタイルの段落で、正規表現に合う字に文字スタイルを当てる規則の一覧。
   * 1つの規則は「正規表現・文字スタイル・削除」の1行。例を選ぶと正規表現の欄に入る。
   */
  private grepSection(p: ParagraphStyle, sheet: StyleSheet): HTMLElement {
    const box = document.createElement("fieldset");
    box.className = "grep-styles";
    const legend = document.createElement("legend");
    legend.textContent = "正規表現スタイル";
    box.append(legend);
    const help = document.createElement("p");
    help.className = "hint";
    help.textContent =
      "この段落スタイルの段落で、正規表現に合う字に文字スタイルを当てます（原稿で［＃名前］を書かなくても、数字だけ・かぎかっこの中だけなどに当たる）。原稿で文字スタイルを当てた字はそちらが優先。規則が重なった字には、下の規則が当たります。";
    box.append(help);
    const characterNames = sheet.character.map((c) => c.name);
    if (characterNames.length === 0) {
      const none = document.createElement("p");
      none.className = "hint";
      none.textContent = "先に文字スタイルを作ってください（「種類」で文字スタイルを選んで「追加」）。";
      box.append(none);
      return box;
    }
    p.grep.forEach((rule, i) => {
      const row = document.createElement("div");
      row.className = "row grep-rule";
      const pattern = document.createElement("input");
      pattern.type = "text";
      pattern.className = "grep-pattern";
      pattern.placeholder = "正規表現（例：[0-9]+）";
      pattern.spellcheck = false;
      pattern.value = rule.pattern;
      const error = document.createElement("span");
      error.className = "grep-error";
      const check = () => {
        const e = grepError(pattern.value);
        pattern.setCustomValidity(e ?? "");
        error.textContent = e ? `使えません：${e}` : "";
      };
      check();
      pattern.addEventListener("input", check);
      pattern.addEventListener("change", () => {
        rule.pattern = pattern.value;
        this.onChange();
      });
      const styleOptions: [string, string][] = characterNames.map((n) => [n, n]);
      if (!characterNames.includes(rule.style)) styleOptions.unshift([rule.style, rule.style ? `${rule.style}（ありません）` : "（文字スタイルを選ぶ）"]);
      const target = this.select(styleOptions, rule.style, (v) => {
        rule.style = v;
        this.onChange();
      });
      const del = this.button("削除", () => {
        p.grep.splice(i, 1);
        this.onChange();
        this.render();
      });
      del.classList.add("danger");
      row.append(pattern, target, del);
      box.append(row, error);
    });
    // 規則を足す：例から選ぶか、空の規則を足す。
    const examples = this.select([["", "例から足す…"], ...GREP_EXAMPLES.map(([label, re]): [string, string] => [re, `${label}　${re}`])], "", (v) => {
      if (!v) return;
      p.grep.push({ pattern: v, style: characterNames[0] });
      this.onChange();
      this.render();
    });
    const add = this.button("規則を足す", () => {
      p.grep.push({ pattern: "", style: characterNames[0] });
      this.render();
    });
    const addRow = document.createElement("div");
    addRow.className = "grep-add";
    addRow.append(add, examples);
    box.append(addRow);
    return box;
  }

  /**
   * 先頭文字スタイル（段落の頭から順に、決めた範囲の字に文字スタイルを当てる）と、
   * 行スタイル（段落の最初の何行かに文字スタイルを当てる）。
   */
  private nestedSection(p: ParagraphStyle, sheet: StyleSheet): HTMLElement {
    const box = document.createElement("fieldset");
    box.className = "grep-styles";
    const legend = document.createElement("legend");
    legend.textContent = "先頭文字スタイル・行スタイル";
    const help = document.createElement("p");
    help.className = "hint";
    help.textContent =
      "先頭文字スタイル：段落の頭から順に、決めた範囲の字に文字スタイルを当てます（上の規則の範囲が終わると、続きの字から次の規則）。区切りの字が見つからなければ段落の終わりまで。行スタイル：段落の最初の何行かの字に、文字スタイルの書体・色・太字・字形・大きさ・字間を当てます（大きさや字間で行の分かれ目が変われば、組み直して決めます）。原稿の文字スタイルと正規表現スタイルが優先します。";
    box.append(legend, help);
    const names = sheet.character.map((c) => c.name);
    const styleOptions = (current: string): [string, string][] => {
      const opts: [string, string][] = [["", "（なし）"], ...names.map((n): [string, string] => [n, n])];
      if (current && !names.includes(current)) opts.push([current, `${current}（ありません）`]);
      return opts;
    };
    p.nested.forEach((rule, i) => {
      const row = document.createElement("div");
      row.className = "row grep-rule";
      const style = this.select(styleOptions(rule.style), rule.style, (v) => {
        rule.style = v;
        this.onChange();
      });
      const count = document.createElement("input");
      count.type = "number";
      Object.assign(count, { min: "1", max: "999", step: "1" });
      count.value = String(rule.count);
      count.className = "nested-count";
      count.setAttribute("aria-label", "数");
      count.addEventListener("change", () => {
        rule.count = Math.min(999, Math.max(1, Math.round(Number(count.value) || 1)));
        count.value = String(rule.count);
        this.onChange();
      });
      const chars = document.createElement("input");
      chars.type = "text";
      chars.className = "nested-chars";
      chars.value = rule.chars;
      chars.placeholder = "区切りの字";
      chars.title = "区切りの字（いくつか並べてよい。全角の空白も書ける）";
      // 空白は欄の中で見えないので、区切りの字を言葉でも見せる。
      const shown = document.createElement("span");
      shown.className = "hint nested-shown";
      const describe = () => {
        shown.textContent = rule.chars
          ? `区切り：${[...rule.chars].map((ch) => (ch === "　" ? "全角の空白" : ch === " " ? "半角の空白" : ch === "	" ? "タブ" : ch)).join("・")}`
          : "区切り：全角の空白";
      };
      describe();
      chars.hidden = shown.hidden = rule.until === "chars";
      chars.addEventListener("change", () => {
        rule.chars = chars.value.slice(0, 20);
        describe();
        this.onChange();
      });
      const until = this.select(
        [
          ["chars", "字まで"],
          ["through", "個目の区切りまで"],
          ["before", "個目の区切りの前まで"],
        ],
        rule.until,
        (v) => {
          rule.until = v as NestedStyle["until"];
          chars.hidden = shown.hidden = rule.until === "chars";
          this.onChange();
        },
      );
      const up = this.button("↑", () => {
        if (i === 0) return;
        [p.nested[i - 1], p.nested[i]] = [p.nested[i], p.nested[i - 1]];
        this.onChange();
        this.render();
      });
      up.title = "上へ（先に当てる）";
      const del = this.button("削除", () => {
        p.nested.splice(i, 1);
        this.onChange();
        this.render();
      });
      del.classList.add("danger");
      row.append(style, count, until, chars, up, del, shown);
      box.append(row);
    });
    const add = this.button("先頭文字スタイルを足す", () => {
      p.nested.push({ style: names[0] ?? "", until: "through", count: 1, chars: "　" });
      this.onChange();
      this.render();
    });
    const addRow = document.createElement("div");
    addRow.className = "grep-add";
    addRow.append(add);
    box.append(addRow);

    // 行スタイル：文字スタイルと行数。
    const lineRow = document.createElement("div");
    lineRow.className = "row";
    const lineStyle = this.select(styleOptions(p.lineStyle.style), p.lineStyle.style, (v) => {
      p.lineStyle.style = v;
      this.onChange();
    });
    const lines = this.select(
      [
        ["0", "使わない"],
        ...[1, 2, 3, 4, 5].map((n): [string, string] => [String(n), `最初の${n}行`]),
      ],
      String(p.lineStyle.lines),
      (v) => {
        p.lineStyle.lines = Number(v);
        this.onChange();
      },
    );
    lineRow.append(lines, lineStyle);
    box.append(this.labeled("行スタイル", lineRow));
    return box;
  }

  private check(label: string, value: boolean, set: (v: boolean) => void): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = value;
    box.addEventListener("change", () => {
      set(box.checked);
      this.onChange();
    });
    const row = document.createElement("label");
    row.className = "field check";
    row.append(box, document.createTextNode(label));
    return row;
  }

  private hint(): HTMLElement {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent =
      this.kind === "paragraph"
        ? "行頭に［＃名前］と書いた行に当たります。見出し（＃・＃＃）には大見出し・中見出し、ほかの行には本文が当たります。"
        : "［＃名前］と［＃／名前］で囲んだ文字に当たります。";
    return p;
  }

  private add() {
    const sheet = this.getSheet();
    const list = sheet[this.kind] as { name: string }[];
    let n = 1;
    while (list.some((s) => s.name === `新しいスタイル${n}`)) n++;
    const name = `新しいスタイル${n}`;
    if (this.kind === "paragraph") sheet.paragraph.push(newParagraphStyle(name));
    else sheet.character.push(newCharacterStyle(name));
    this.selected[this.kind] = name;
    this.onChange();
    this.render();
  }

  private rename(style: { name: string }, name: string, input: HTMLInputElement) {
    const list = this.getSheet()[this.kind] as { name: string }[];
    // 記法で使えない文字（［］＃／）と、重複する名前は受け付けない。
    if (!name || /[［］＃／]/.test(name) || PAGE_COMMANDS.includes(name) || list.some((s) => s !== style && s.name === name)) {
      input.value = style.name;
      input.setCustomValidity("使えない名前です（空・重複・［］＃／を含む・改ページなどの命令と同じ）。");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    // 文字スタイルの名前を変えたら、正規表現スタイルの規則もその名前に付け替える。
    if (this.kind === "character") {
      for (const p of this.getSheet().paragraph) {
        for (const r of p.grep) if (r.style === style.name) r.style = name;
        // ドロップキャップの文字スタイルも付け替える。
        if (p.dropCap.style === style.name) p.dropCap.style = name;
      }
    }
    style.name = name;
    this.selected[this.kind] = name;
    this.onChange();
    this.render();
  }

  private remove(style: { name: string }) {
    const sheet = this.getSheet();
    if (!confirm(`スタイル「${style.name}」を削除します。原稿の［＃${style.name}］は、本文として組まれます。`)) return;
    if (this.kind === "paragraph") sheet.paragraph = sheet.paragraph.filter((s) => s !== style);
    else sheet.character = sheet.character.filter((s) => s !== style);
    this.onChange();
    this.render();
  }

  private labeled(text: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const span = document.createElement("span");
    span.textContent = text;
    wrap.append(span, control);
    return wrap;
  }

  private select(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
    const select = document.createElement("select");
    for (const [v, label] of options) select.add(new Option(label, v));
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  private number(label: string, value: number, min: number, max: number, step: number, unit: string, set: (v: number) => void): HTMLElement {
    const input = document.createElement("input");
    input.type = "number";
    Object.assign(input, { min: String(min), max: String(max), step: String(step) });
    input.value = String(value);
    input.addEventListener("change", () => {
      // 空や数でない値は下限に（0 や負の数はそのまま）。
      const n = input.value.trim() === "" ? NaN : Number(input.value);
      const v = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
      input.value = String(v);
      set(v);
      this.onChange();
    });
    const row = document.createElement("span");
    row.className = "row";
    row.append(input, document.createTextNode(unit));
    const wrap = this.labeled(label, row);
    wrap.classList.add("inline");
    return wrap;
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }
}
