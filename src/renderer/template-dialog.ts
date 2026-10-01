import type { Settings } from "../document/settings.js";

// テンプレートの画面（DTP-17）：一覧から選んで新規作成・今の文書に適用・削除。今の設定を名前を付けて保存。

export interface TemplateEntry {
  id: string;
  name: string;
  builtin: boolean;
  /** 新規作成の既定か。 */
  isDefault?: boolean;
}

export interface TemplateApi {
  listTemplates(): Promise<TemplateEntry[]>;
  getTemplate(id: string): Promise<{ settings: Settings } | { error: string }>;
  saveTemplate(name: string, settings: Settings): Promise<string | undefined>;
  deleteTemplate(id: string): Promise<void>;
  importTemplate(): Promise<{ id: string; name: string } | { error: string } | undefined>;
  openTemplateFolder(): Promise<void>;
  getDefaultTemplate(): Promise<{ id: string; name: string; settings: Settings } | null>;
  setDefaultTemplate(id: string | null): Promise<void>;
}

export interface TemplateHandlers {
  /** テンプレートの設定で、空の原稿の新しい文書を作る。false なら取りやめ（保存していない変更があるなど）。 */
  create(settings: Settings): boolean;
  /** 今の文書にテンプレートの設定を当てる。 */
  apply(settings: Settings): void;
  current(): Settings;
  status(text: string): void;
  /** 新規作成の既定が変わった（名前。空なら標準の設定）。 */
  defaultChanged(name: string): void;
}

export class TemplateDialog {
  private readonly dialog = document.getElementById("template-dialog") as HTMLDialogElement;
  private readonly list = document.getElementById("tpl-list") as HTMLSelectElement;
  private readonly note = document.getElementById("tpl-note") as HTMLParagraphElement;
  private readonly name = document.getElementById("tpl-name") as HTMLInputElement;
  private readonly del = document.getElementById("tpl-delete") as HTMLButtonElement;
  private readonly makeDefault = document.getElementById("tpl-default") as HTMLButtonElement;
  private readonly saveDefault = document.getElementById("tpl-save-default") as HTMLInputElement;
  private readonly defaultNote = document.getElementById("tpl-default-note") as HTMLParagraphElement;
  private entries: TemplateEntry[] = [];

  constructor(
    private readonly api: TemplateApi,
    private readonly h: TemplateHandlers,
  ) {
    const on = (id: string, fn: () => void | Promise<void>) => document.getElementById(id)!.addEventListener("click", () => void fn());
    on("tpl-new", () => this.use("create"));
    on("tpl-apply", () => this.use("apply"));
    on("tpl-delete", () => this.remove());
    on("tpl-default", () => this.toggleDefault());
    on("tpl-save", () => this.save());
    on("tpl-import", () => this.importFile());
    on("tpl-folder", () => this.api.openTemplateFolder());
    this.list.addEventListener("change", () => this.updateButtons());
    this.list.addEventListener("dblclick", () => void this.use("create"));
  }

  async open(focusSave = false) {
    await this.refresh();
    this.dialog.showModal();
    if (focusSave) this.name.focus();
    else this.list.focus();
  }

  private async refresh(select?: string) {
    const keep = select ?? this.list.value;
    this.entries = await this.api.listTemplates();
    this.list.replaceChildren(
      ...this.entries.map((e) => new Option(`${e.name}${e.builtin ? "（標準）" : ""}${e.isDefault ? "　★新規作成の既定" : ""}`, e.id)),
    );
    const def = this.entries.find((e) => e.isDefault);
    this.defaultNote.textContent = `新規作成の既定：${def ? def.name : "標準の設定（テンプレートなし）"}`;
    this.h.defaultChanged(def?.name ?? "");
    this.list.value = this.entries.some((e) => e.id === keep) ? keep : (this.entries[0]?.id ?? "");
    this.updateButtons();
  }

  private selected(): TemplateEntry | undefined {
    return this.entries.find((e) => e.id === this.list.value);
  }

  private updateButtons() {
    const e = this.selected();
    this.del.disabled = !e || e.builtin;
    this.makeDefault.disabled = !e;
    this.makeDefault.textContent = e?.isDefault ? "既定をやめる（標準の設定に戻す）" : "新規作成の既定にする";
    this.note.textContent = e?.builtin ? "標準のテンプレートは消せません。" : "";
  }

  private async use(mode: "create" | "apply") {
    const e = this.selected();
    if (!e) return;
    const got = await this.api.getTemplate(e.id);
    if ("error" in got) {
      alert(got.error);
      return;
    }
    if (mode === "create") {
      if (!this.h.create(got.settings)) return;
      this.h.status(`テンプレート「${e.name}」で新しい文書を作りました。`);
    } else {
      if (!confirm(`今の文書の設定を、テンプレート「${e.name}」の設定に置き換えます（原稿と、書名・著者名はそのまま）。よろしいですか？`)) return;
      this.h.apply(got.settings);
      this.h.status(`テンプレート「${e.name}」を当てました。`);
    }
    this.dialog.close();
  }

  /** 選んだテンプレートを新規作成の既定にする（既定ならやめる）。 */
  private async toggleDefault() {
    const e = this.selected();
    if (!e) return;
    await this.api.setDefaultTemplate(e.isDefault ? null : e.id);
    await this.refresh(e.id);
    this.h.status(e.isDefault ? "新規作成は標準の設定に戻しました。" : `新規作成ではテンプレート「${e.name}」の設定を使います。`);
  }

  private async remove() {
    const e = this.selected();
    if (!e || e.builtin) return;
    if (!confirm(`テンプレート「${e.name}」を削除します。よろしいですか？`)) return;
    await this.api.deleteTemplate(e.id);
    await this.refresh();
  }

  private async save() {
    const name = this.name.value.trim();
    if (!name) {
      this.name.setCustomValidity("名前を入れてください。");
      this.name.reportValidity();
      return;
    }
    this.name.setCustomValidity("");
    const id = await this.api.saveTemplate(name, this.h.current());
    if (!id) return;
    if (this.saveDefault.checked) await this.api.setDefaultTemplate(id);
    this.name.value = "";
    await this.refresh(id);
    this.h.status(`テンプレート「${name}」を保存しました。`);
  }

  private async importFile() {
    const r = await this.api.importTemplate();
    if (!r) return;
    if ("error" in r) {
      alert(r.error);
      return;
    }
    await this.refresh(r.id);
  }
}
