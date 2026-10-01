# 同梱フォント

## NotoSerifJP-Regular.ttf

tategumi の既定の本文フォント。どの PC で開いても同じ組版になるように同梱している（要件 NF-05）。

| 項目 | 内容 |
| --- | --- |
| 書体 | Noto Serif JP Regular（太さ 400） |
| ライセンス | SIL Open Font License 1.1（[NotoSerifJP-OFL.txt](NotoSerifJP-OFL.txt)）。予約フォント名の指定はない |
| 元のファイル | `NotoSerifJP[wght].ttf`（可変フォント、Version 2.003）<br>https://github.com/google/fonts/tree/main/ofl/notoserifjp |
| 元のファイルの SHA-256 | `2fd527ba12b6a44ec30d796d633360da0aeba6c5d4af1304ce12bb4dc15a7dfc` |
| このファイルの SHA-256 | `eb9ad8326e459fbc405fac820260ea547ccfd8dc17eeaf3149719cd595e6e361` |

### 作り方

公式には可変フォントしか配布されていない。tategumi の PDF 書き出し（pdf-lib）は可変フォントを扱えないので、
fonttools で太さ 400 の静的な TrueType を取り出した。字形・縦書き用字形（vert）はそのまま残る。

```bash
pip install fonttools
fonttools varLib.instancer "NotoSerifJP[wght].ttf" wght=400 --update-name-table -o NotoSerifJP-Regular.ttf
```

OFL に従い、このフォントを単体で販売しないこと、ライセンス文を一緒に配布することを守る。
