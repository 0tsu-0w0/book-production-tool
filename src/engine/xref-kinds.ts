// 相互参照の書式（parse.ts と xref.ts で使う。parse.ts が xref.ts を読むと、互いに読み合うことになるので分けてある）。

/** ［＃参照：名前］の書式。〈見出し〉〈章〉〈ページ〉に、参照先の字が入る。 */
export const XREF_FORMAT = "「〈見出し〉」（〈ページ〉ページ）";
/** 記法の名前ごとの書式。 */
export const XREF_KINDS: Record<string, string> = { 見出し: "〈見出し〉", 章: "〈章〉", 参照: XREF_FORMAT };
