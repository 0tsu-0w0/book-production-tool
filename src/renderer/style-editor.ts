import type { FontChoice } from "../document/settings.js";
import { PAGE_COMMANDS } from "../engine/parse.js";
import {
  BUILTIN_PARAGRAPH_STYLES,
  GLYPH_FORMS,
  fontKey,
  type GlyphForm,
  newCharacterStyle,
  newParagraphStyle,
  type CharacterStyle,
  type ParagraphStyle,
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
    }

    // 色：指定しなければ文字の色。
    const useColor = document.createElement("input");
    useColor.type = "checkbox";
    useColor.checked = style.color !== null;
    const picker = document.createElement("input");
    picker.type = "color";
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
      const v = Math.min(max, Math.max(min, Number(input.value) || min));
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
