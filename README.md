# BindSQL for Eclipse

EclipseでJavaアプリケーションをデバッグし、SQL実行直前のブレークポイントで確認したSQLとバインド変数を、実行時の内容を確認しやすいSQLへ展開するローカルツールです。PostgreSQL専用です。

`bind-sql-for-eclipse-postgresql.html` の単一HTMLだけで動作します。外部CDNや外部APIには依存しません。

## 使い方

1. `bind-sql-for-eclipse-postgresql.html` をブラウザで開きます。
2. EclipseでSQL実行直前にブレークポイントを設定し、デバッグ実行します。
3. 停止時に変数の内容を確認し、SQLとバインド変数を左側の入力欄へ貼り付けます。
4. 右側にPostgreSQL向けSQLがリアルタイムで表示されます。
   変換後のSQLを自動チェックし、エラーがあれば出力欄の下に表示します。行・列を押すと該当箇所へ移動できます。
5. `コピー` ボタンで結果をコピーできます。

## できること

- SQL本文とバインド変数をまとめて貼り付けて、PostgreSQLで実行しやすいSQLへ変換
- `?` の位置バインドと `:name` の名前付きバインドを実値へ置換
- SQLキーワードを大文字化
- 主要な句ごとに改行して整形
- インデントは半角スペース2つ単位
- PostgreSQL 15の構文チェックと、SQLから判定できる列数の不一致などのチェック
- ライト/ダークモード切り替え

## 整形方針

- SQL文字列、コメント、引用識別子、PostgreSQLのドルクォート文字列内のキーワードは整形対象から保護します。
- 未置換のバインド変数や余剰のバインド変数がある場合は、変換結果と一緒に警告を表示します。
- 出力SQLはPostgreSQLでの確認・実行を主対象としています。
- 出力先DBはPostgreSQL固定です。
- このツールはデバッグ中のSQLとバインド変数を、PostgreSQLで確認しやすい形に整える補助ツールです。

## ライセンス

MIT License

ライセンス文はHTMLに埋め込まず、本ツールは `LICENSE`、解析器・ランタイム・アイコンは `THIRD_PARTY_NOTICES.txt` に記載しています。配布時はHTMLと一緒にこの2ファイルを同梱してください。

## SQLチェックの範囲

変換・整形の処理はそのままに、**出力されたSQL**を別処理でチェックします。SQLを実行したり、外部へ送信したりすることはありません。エラーの説明はSQL本文に混ぜず、コピー対象は従来どおり出力SQLだけです。

- PostgreSQL 15の解析器による構文チェック。括弧・引用符・句の記述などのエラーは、解析器のメッセージと位置を表示します。
- INSERTで指定した列数とVALUESの値の数の不一致、不足・超過した数
- 複数行VALUESで行ごとの値の数が異なる場合
- INSERTで同じ列を重複して指定した場合（配列要素・複合型の部分指定は除く）
- 列数が確定するINSERT ... SELECT、UNION / INTERSECT / EXCEPT、SETの複数列代入での列数の不一致

**実際のテーブル定義やデータを参照するチェックは行いません。** テーブル・列・関数の存在、型の整合性、NOT NULLの必須列不足、UNIQUE / 外部キー / CHECK制約、権限、実行時エラーなどは対象外です。列リストを省略したINSERTや、`SELECT *`・複合型の`.*`などの展開後の列数も判定しません。列の省略はDEFAULTやNULLで補われる場合があるため、それだけでエラーとはしません（[PostgreSQL 15 INSERT仕様](https://www.postgresql.org/docs/15/sql-insert.html)）。「チェック済み」はDBでの実行成功を保証するものではありません。

構文エラーは解析器が最初に検出した1件を表示します。構文が通った場合は上記の構造チェックを行います。SQL文中の文字列に含まれる動的SQLや関数本体の言語までは解析しません。

解析器は [libpg-query 15.6.3](https://github.com/constructive-io/libpg-query-node)（libpg_query 15-4.2.4、PostgreSQL 15.1由来）を固定してHTMLへ同梱しています。WebAssemblyとWeb Workerに対応したブラウザで動作します。入力から300ms後に別スレッドでチェックし、10秒以内に完了しない場合や解析器を起動できない場合は「チェックできない」状態を表示します。

## 開発・検証

利用時のインストールやビルドは不要です。開発時はNode.js 20以降で以下を実行してください。

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run format:check
```

`src/` を編集し、`npm run build` で配布HTMLを再生成します。配布HTMLは直接編集しないでください。

| ファイル | 役割 |
| --- | --- |
| `src/index.html` | 画面の構造・CSSとスクリプトの埋め込み位置 |
| `src/styles.css` | テーマ・レイアウト・各部品のスタイル（CSSネストを使用） |
| `src/sql-engine.js` | DOMに依存しないSQL入力の解釈・バインド展開・整形・ハイライト |
| `src/bindsql-app.js` | 入出力の表示・コピー・テーマ・入力イベントの制御 |
| `src/sql-validation-ui.js` | 検査の予約・Workerの管理・診断の表示 |
| `src/sql-validation-worker.js` | PostgreSQL解析器の呼び出し・構造の検査 |
| `scripts/build.mjs` | CSS・自作スクリプト・解析器・WASMを単一HTMLへ組み込み |

`npm run format` は `src/` と `scripts/` の書式を統一し、配布HTMLも更新します。`npm run format:check` は書式と配布HTMLの一致を確認します。`npm run build:check` では再生成が必要かだけを確認できます。WASMの内容は変更しません。

CSSはネイティブのネスト構文を使用しています。各部品の状態・メディアクエリをその部品のルール内にまとめ、配色とサイズは `:root` のカスタムプロパティで管理します。利用にはCSSネストに対応したモダンブラウザが必要です。

入出力とハイライトの文字サイズ・余白は共通の `.editor` で管理し、入力欄とハイライトは同じグリッド領域に重ねています。片方だけのサイズ変更は表示位置のずれにつながるため、共通スタイルを変更してください。画面のイベントは各操作要素に直接登録し、空の出力案内にはHTMLの `placeholder` を使います。

`BindSQLEngine.convert(text)` は `{ sql, issues }` を返し、`highlight(text)` はHTMLエスケープ済みの表示用文字列を返します。変換処理はDOMやブラウザAPIがない環境でも利用できます。キーワード辞書はPostgreSQL 15向けに統一しています。

テストは配布HTMLに埋め込まれたスクリプトを実行し、SQLの意味の保持、コピー・IME・検査のキャンセル、WorkerとWASMのオフライン動作、ソースからの再生成結果を確認します。変更したソースと生成されたHTMLを一緒に更新してください。依存ライブラリはビルド時にのみ利用し、利用時のネットワーク接続はCSPでも禁止しています。
