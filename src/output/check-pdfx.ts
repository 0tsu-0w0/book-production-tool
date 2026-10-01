import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFObject,
} from "pdf-lib";

// 書き出した PDF を読み直して、PDF/X-1a:2003（ISO 15930-4）・PDF/X-4（ISO 15930-7）の主な条件を満たすかを調べる。
// Acrobat のプリフライトの代わりにはならないが、書き出し処理の誤りはここで見つける。

export interface CheckItem {
  rule: string;
  ok: boolean;
  detail?: string;
}

const FORBIDDEN_COLOR_SPACES = ["DeviceRGB", "CalRGB", "CalGray", "Lab", "ICCBased"];
const FORBIDDEN_KEYS = ["JavaScript", "EmbeddedFiles"];

export async function checkPdfX1a(bytes: Uint8Array): Promise<CheckItem[]> {
  return checkPdfX(bytes, "x1a");
}

export async function checkPdfX(bytes: Uint8Array, standard: "x1a" | "x4"): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  const add = (rule: string, ok: boolean, detail?: string) => items.push({ rule, ok, detail });
  const raw = Buffer.from(bytes).toString("latin1");
  const x4 = standard === "x4";

  const version = /^%PDF-(\d)\.(\d)/.exec(raw);
  const maxMinor = x4 ? 6 : 4;
  add(`PDF のバージョンが 1.${maxMinor} 以下`, !!version && Number(version[1]) === 1 && Number(version[2]) <= maxMinor, version?.[0]);
  add("オブジェクトストリーム・相互参照ストリームを使っていない", !/\/Type\s*\/(ObjStm|XRef)\b/.test(raw));

  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const { context } = doc;
  add("暗号化されていない", !doc.isEncrypted);
  add("トレーラーにファイル識別子（/ID）がある", /trailer[\s\S]*\/ID\s*\[/.test(raw));

  const info = context.lookup(context.trailerInfo.Info);
  const infoDict = info instanceof PDFDict ? info : undefined;
  const infoText = (key: string) => {
    const v = infoDict?.get(PDFName.of(key));
    return v ? decodeText(v) : undefined;
  };
  add("文書情報に Title がある", !!infoText("Title"));
  if (x4) {
    // PDF/X-4 の版は XMP メタデータに書く。
    const meta = doc.catalog.lookupMaybe(PDFName.of("Metadata"), PDFStream);
    const xmp = meta instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(meta).decode()).toString("utf8") : "";
    add("XMP メタデータの GTS_PDFXVersion が PDF/X-4", /<pdfxid:GTS_PDFXVersion>PDF\/X-4<\/pdfxid:GTS_PDFXVersion>/.test(xmp));
    add(
      "XMP メタデータに作成日・版の情報（VersionID・RenditionClass）がある",
      ["xmp:CreateDate", "xmp:ModifyDate", "xmpMM:DocumentID", "xmpMM:VersionID", "xmpMM:RenditionClass"].every((k) => xmp.includes(`<${k}>`)),
    );
  } else {
    add("文書情報の GTS_PDFXVersion が PDF/X-1a:2003", infoText("GTS_PDFXVersion") === "PDF/X-1a:2003", infoText("GTS_PDFXVersion"));
  }
  const trapped = infoDict?.get(PDFName.of("Trapped"));
  add("文書情報の Trapped が True か False", trapped === PDFName.of("True") || trapped === PDFName.of("False"), trapped?.toString());
  add("文書情報に CreationDate と ModDate がある", !!infoText("CreationDate") && !!infoText("ModDate"));

  const intents = doc.catalog.lookupMaybe(PDFName.of("OutputIntents"), PDFArray);
  const pdfxIntent = intents
    ?.asArray()
    .map((r) => context.lookup(r))
    .find((d): d is PDFDict => d instanceof PDFDict && d.get(PDFName.of("S")) === PDFName.of("GTS_PDFX"));
  const conditionId = pdfxIntent?.get(PDFName.of("OutputConditionIdentifier"));
  add("出力インテント（GTS_PDFX）と印刷条件の識別子がある", !!conditionId, conditionId ? decodeText(conditionId) : undefined);
  if (x4) {
    const profile = pdfxIntent?.lookupMaybe(PDFName.of("DestOutputProfile"), PDFStream);
    const n = profile?.dict.get(PDFName.of("N"));
    const header = profile instanceof PDFRawStream ? decodePDFRawStream(profile).decode() : undefined;
    const ok = !!header && n instanceof PDFNumber && n.asNumber() === 4 && Buffer.from(header.subarray(36, 40)).toString("latin1") === "acsp";
    add("出力インテントに CMYK の ICC プロファイルが埋め込まれている", ok);
  }

  const pages = doc.getPages();
  const boxProblems: string[] = [];
  const colorProblems: string[] = [];
  pages.forEach((page, i) => {
    const media = boxOf(page.node, "MediaBox");
    const trim = boxOf(page.node, "TrimBox") ?? boxOf(page.node, "ArtBox");
    const bleed = boxOf(page.node, "BleedBox") ?? media;
    if (!trim) boxProblems.push(`${i + 1}ページ：TrimBox がない`);
    else if (!media || !bleed || !inside(trim, bleed) || !inside(bleed, media)) boxProblems.push(`${i + 1}ページ：TrimBox ⊂ BleedBox ⊂ MediaBox になっていない`);

    for (const stream of contentStreams(page.node.Contents(), context)) {
      const ops = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1").split(/\s+/);
      if (ops.includes("rg") || ops.includes("RG")) colorProblems.push(`${i + 1}ページ：RGB の色指定（rg / RG）`);
    }
  });
  add("全ページに TrimBox があり、TrimBox ⊂ BleedBox ⊂ MediaBox", boxProblems.length === 0, boxProblems.slice(0, 3).join("、"));

  // 文書内のすべてのオブジェクトを調べる。
  const unembedded: string[] = [];
  const badSubsetNames: string[] = [];
  const transparency: string[] = [];
  const forbidden: string[] = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : undefined;
    const text = obj instanceof PDFRawStream ? obj.dict.toString() : obj.toString();
    for (const cs of FORBIDDEN_COLOR_SPACES) if (text.includes(`/${cs}`)) colorProblems.push(`${ref}：/${cs}`);
    for (const key of FORBIDDEN_KEYS) if (text.includes(`/${key}`)) forbidden.push(`${ref}：/${key}`);
    if (!dict) continue;

    if (dict.get(PDFName.of("Type")) === PDFName.of("FontDescriptor")) {
      const embedded = ["FontFile", "FontFile2", "FontFile3"].some((k) => dict.has(PDFName.of(k)));
      const name = decodeText(dict.get(PDFName.of("FontName"))!) ?? ref.toString();
      if (!embedded) unembedded.push(name);
      else if (!/^\/?[A-Z]{6}\+/.test(name)) badSubsetNames.push(name);
    }
    const smask = dict.get(PDFName.of("SMask"));
    if (smask && smask !== PDFName.of("None")) transparency.push(`${ref}：SMask`);
    for (const key of ["CA", "ca"]) {
      const v = dict.get(PDFName.of(key));
      if (v instanceof PDFNumber && v.asNumber() < 1) transparency.push(`${ref}：/${key} ${v.asNumber()}`);
    }
    const group = dict.lookupMaybe(PDFName.of("Group"), PDFDict);
    if (group?.get(PDFName.of("S")) === PDFName.of("Transparency")) transparency.push(`${ref}：透明グループ`);
  }
  add("すべてのフォントが埋め込まれている", unembedded.length === 0, unembedded.join("、"));
  add("埋め込みフォントの名前にサブセットの接頭辞（ABCDEF+）がある", badSubsetNames.length === 0, badSubsetNames.join("、"));
  add("色は CMYK・グレー・特色だけ（RGB・ICCBased・Lab がない）", colorProblems.length === 0, colorProblems.slice(0, 3).join("、"));
  add("透明を使っていない", transparency.length === 0, transparency.slice(0, 3).join("、"));
  add("JavaScript・添付ファイルがない", forbidden.length === 0, forbidden.join("、"));

  return items;
}

function decodeText(obj: PDFObject): string | undefined {
  if ("decodeText" in obj && typeof obj.decodeText === "function") return obj.decodeText();
  return obj.toString();
}

type Box = [number, number, number, number];

function boxOf(node: PDFDict, key: string): Box | undefined {
  // MediaBox などはページツリーの親から受け継ぐことがある。
  let current: PDFDict | undefined = node;
  while (current) {
    const box = current.lookupMaybe(PDFName.of(key), PDFArray);
    if (box) {
      const [a, b, c, d] = box.asArray().map((n) => (n as PDFNumber).asNumber());
      return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    }
    current = current.lookupMaybe(PDFName.of("Parent"), PDFDict);
  }
  return undefined;
}

function inside(inner: Box, outer: Box): boolean {
  const e = 1e-3;
  return inner[0] >= outer[0] - e && inner[1] >= outer[1] - e && inner[2] <= outer[2] + e && inner[3] <= outer[3] + e;
}

function contentStreams(contents: PDFStream | PDFArray | undefined, context: PDFDocument["context"]): PDFRawStream[] {
  if (!contents) return [];
  if (contents instanceof PDFRawStream) return [contents];
  if (contents instanceof PDFArray) {
    return contents
      .asArray()
      .map((r) => (r instanceof PDFRef ? context.lookup(r) : r))
      .filter((s): s is PDFRawStream => s instanceof PDFRawStream);
  }
  return [];
}
