# 課題一覧

確認日: 2026-09-07。対象: 現在の作業ツリー（HEAD: `c979f71`）。既存13件をすべて再確認し、完6件・未7件。新規は3件（すべて未）。前回「新規」だった課題11〜13は今回「既存」として扱う。以下の再現入力中の `\n` は改行を表す。

## 1. PostgreSQL固有演算子が整形で分断される

- ステータス: 未
- 種別: 既存
- 重要度: 高
- 問題: JSON/配列系演算子の従来例は改善しているが、PostgreSQLの複合演算子を整形で分断する問題が残っている。
- 根拠: [保護対象の定義](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1116) に `<<` と `>>` がなく、[演算子への空白付与](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2563) が各 `<` / `>` を個別に処理する。`select 8 << 1, 8 >> 1` の出力は `8 < < 1` と `8 > > 1` になる。両演算子は [PostgreSQL公式の数値演算子一覧](https://www.postgresql.org/docs/current/functions-math.html) に定義されている。
- 現状: `#>>`、`->>`、`@>`、`<@`、`?|`、`?&`、`&&` の保持を確認した一方、ビットシフト演算子の分断を再現したため「未」に戻す。同種の演算子保護漏れとして本課題にまとめる。
- 影響: 正しいSQLが構文の壊れたSQLになり、変換警告も出ない。
- 次の対応: 複合演算子の保護対象に `<<` / `>>` を追加し、既存のJSON/配列系演算子と合わせて整形前後の保持を回帰確認する。

## 2. 行コメント後の改行が失われてSQLの意味が変わる

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: `--` 行コメントの終端改行が消え、後続SQLまでコメントに取り込まれる。
- 根拠: [行コメントの保護](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1508) が終端改行を含めて退避し、[整形結果の復元](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:3249) で戻している。`select -- first column\n  * from users where id = ?\n1 = 7` の出力で、コメントの次行に `*` が残り、`id = 7` もコメント外に保持された。
- 現状: 現行実装と再現入力の実行結果から、既存の行コメント終端消失は解消済みと判断する。
- 影響: 確認した入力では後続SQLのコメント化は起きない。
- 次の対応: 本課題の修正は不要。

## 3. 複数行のJavaログSQLをログ入力として解析できない

- ステータス: 未
- 種別: 既存
- 重要度: 高
- 問題: `org.hibernate.SQL` のログヘッダーの次行からSQL本文が始まる複数行ログを認識できない。
- 根拠: [Hibernateロガー行の解析](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2095) は、区切り記号とSQL開始キーワードが同じ行にあることを要求する。[複数行の収集開始](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2121) は空の `Hibernate:` 行には対応するが、SQL本文のない `org.hibernate.SQL` 行には対応しない。`2026-09-07 DEBUG org.hibernate.SQL :\n    select *\n    from users\n    where id=?\nbinding parameter [1] as [INTEGER] - [7]` では、ヘッダーとバインドログが出力に混入し、`?` が未置換になった。
- 現状: `==> Preparing:` と `Hibernate:` から始まる従来の複数行例は成功した。しかしロガー形式の複数行入力は失敗するため「未」に戻す。
- 影響: Hibernateログをそのまま貼り付けても実行可能なSQLにならず、手作業での切り出しが必要になる。
- 次の対応: SQL本文が空の `org.hibernate.SQL` ヘッダーでもSQL収集を開始し、次のログレコードやバインド行までの継続行を取り込む。ヘッダーとSQLが同一行・別行の両形式を回帰確認する。

## 4. `BETWEEN` や `LIMIT` の位置バインドが `?` 演算子扱いされる

- ステータス: 未
- 種別: 既存
- 重要度: 高
- 問題: 従来の `BETWEEN` / `LIMIT` 等は改善したが、通常の位置バインドをPostgreSQLの `?` 演算子と誤判定する問題が `DISTINCT` 直後に残っている。
- 根拠: [直前キーワードの集合](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2348) に `DISTINCT` がなく、[式と演算子の判定](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2416) がこれを左辺の式として扱う。`select distinct ? from t\nparams:\n1 = abc` では `DISTINCT ?` が残り、位置バインド `[1]` が余剰と表示された。
- 現状: `BETWEEN ? AND ?`、`LIKE ? ESCAPE ?`、`LIMIT ? OFFSET ?` は置換に成功した。通常句の判定漏れは残るため、重複課題を作らず本課題を「未」に戻す。
- 影響: 正常なSQLとバインド値でも変換が未完了となり、コピーできない。
- 次の対応: `DISTINCT` 直後の `?` を位置バインドとして認識させる。既存句とJSONの `?` 演算子の両方を回帰確認する。

## 5. 空文字のMyBatis/Hibernateログバインド値が未置換になる

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 文字列型の空値が空のバインド定義になり、`?` が置換されない。
- 根拠: [ログの型の反映](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1427) と [空文字の引用](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1233) により、文字列型の空値は `''` になる。`==> Preparing: select * from t where name = ?\n==> Parameters: (String)` と `Hibernate: select * from t where name = ?\nbinding parameter [1] as [VARCHAR] - []` は、いずれも `name = ''` になった。
- 現状: MyBatis/Hibernateの文字列型空値はバインド定義として認識・置換される。
- 影響: この空値の未置換問題は確認した入力で解消している。空白や引用符を含む非空文字列の内容変化は課題15で扱う。
- 次の対応: 本課題の修正は不要。

## 6. SQL本文中の `1 = 1` 行がバインド行として削除される

- ステータス: 未
- 種別: 既存
- 重要度: 高
- 問題: 直前のSQL行が条件式と `AND` を含む場合、続く `1 = 1` がバインド定義として削除される。
- 根拠: [SQL述語を保護する条件](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2033) は直前行全体が `WHERE` / `AND` / `OR` の場合に限定される。`select * from t where id=? AND\n1 = 1\n1 = 7` の出力は `WHERE id = 7 AND` で終わり、`1 = 1` が消える。[位置バインドの登録](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2307) で同じ添字の値が上書きされるため、この入力では警告も出なかった。
- 現状: `WHERE` だけの行に続く従来例と、括弧で囲んだ条件の例は保持された。一方、行末の `AND` に続く条件の消失を再現したため「未」に戻す。
- 影響: SQL条件が削除され、構文の壊れた出力が変換成功として扱われる。
- 次の対応: 直前行の全文一致ではなく、SQLが条件式を待っている文脈を確認して `1 = 1` を保持する。行末の `AND` と独立行の `AND` の両例を回帰確認する。

## 7. Spring JDBCログのSQL抽出が `]` を含むSQLで途中終了する

- ステータス: 未
- 種別: 既存
- 重要度: 中
- 問題: 複数行のSpring JDBCログで、SQLの最初の行に配列添字の `]` があると、そこをログのSQL終端と誤認する。
- 根拠: [Spring JDBCのSQL抽出](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2163) は、開始行に `]` が見つかれば即座にその位置までを返す。`Executing prepared SQL statement [select arr[1]\nfrom t where id = ?]\ncolumn index 1, parameter value [7], value class [java.lang.Integer], SQL type unknown` ではSQLが `select arr[1` に切られ、`[1]` の余剰バインド警告になった。
- 現状: 同一行にSQL全体がある従来例は成功するが、複数行かつ初行に `]` を含む場合は失敗するため「未」に戻す。
- 影響: SELECT式・FROM句・WHERE句が欠け、出力SQLを実行できない。
- 次の対応: 本文中の角括弧とログ外枠の閉じ括弧を区別してSQL終端を求める。同一行と複数行の両方で配列添字を含む例を回帰確認する。

## 8. Spring JDBCのパラメータ値解析が値の `]` と文字列型を保持しない

- ステータス: 完
- 種別: 既存
- 重要度: 高
- 問題: Spring JDBCの値に含まれる `]` で値が切られたり、`001` / `true` の文字列値が数値・真偽値に変わったりする。
- 根拠: [パラメータ行の解析](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2180) が `value class` の前まで値を取得し、[ログバインド生成への型の引き渡し](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2215) で型情報を保持している。`java.lang.String` 型の `abc]def`、`001`、`true` は、それぞれ `'abc]def'`、`'001'`、`'true'` として出力された。
- 現状: 既存の `]` による切り詰めと、数値・真偽値に見える文字列の型喪失は解消済みと判断する。
- 影響: 確認した従来例で値と文字列型は保持される。解析後の共通処理による前後空白・引用符の消失は課題15で扱う。
- 次の対応: 本課題の修正は不要。

## 9. 明示的なバインドセクションでもSQLキーワード名の名前付きバインドを解析できない

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: 明示的なバインドセクションでも `limit` / `sql` 等の名前がSQLの一部と判断され、未置換になる。
- 根拠: [明示セクションの判定](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2017) がSQLキーワード名も許可し、[入力分割](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2264) がSQLプレフィックス判定より先にバインドとして取り込む。`select :user, :limit, :offset, :sql\nparams:\nuser = 42\nlimit = 10\noffset = 5\nsql = abc` は `42, 10, 5, 'abc'` に置換され、バインド行も出力に混入しなかった。
- 現状: 明示セクション内のSQLキーワード名のバインドは認識される。
- 影響: 確認した入力では未置換・SQL本文への混入は起きない。
- 次の対応: 本課題の修正は不要。

## 10. `sql=[...] params=[...]` 形式のパラメータ値がカンマ入り構造で分割される

- ステータス: 未
- 種別: 既存
- 重要度: 高
- 問題: 角括弧・丸括弧内のカンマは保護されるが、JSONオブジェクトの波括弧内のカンマで値が分断される。
- 根拠: [パラメータの分割](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1248) は角括弧と丸括弧の深さだけを管理し、[区切り判定](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1305) でも波括弧を考慮しない。`sql=[select ?, ?] params=[1 = {"a":1,"b":2}, 2 = 3]` の出力は `SELECT '{"a":1', 3` 相当となり、`"b":2}` が欠落した。分断された後半は [バインド解析](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2291) で認識されず、警告も出なかった。
- 現状: `params=[1 = ARRAY[1,2], 2 = 3]` は2件の値として取り込まれる。一方、JSON構造の途中分割が残るため「未」に戻す。警告なしの値欠落を確認したため重要度を高とする。
- 影響: JSON値が欠損し、実行時の型変換エラーや、文字列として保存する場合の誤データにつながる。
- 次の対応: 波括弧のネストも考慮し、JSON内部のカンマを区切りにしない。複数キーのJSONと後続パラメータが両方保持されることを回帰確認する。

## 11. PostgreSQL配列添字内のプレースホルダが置換されない

- ステータス: 未
- 種別: 既存
- 重要度: 高
- 問題: 配列名と `[` の間に空白があると、添字全体が引用識別子扱いされ、プレースホルダが置換されない。
- 根拠: [角括弧の判別](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1523) は `[` の直前1文字しか見ない。`select arr [ ? ] from t\n1 = 2` の出力は `SELECT arr [ ? ] FROM t 1 = 2` 相当になり、添字もバインド行も残る。[暗黙バインド検出](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1961) でも添字が保護されるため、未置換の警告は出なかった。空白でトークンを区切れることと配列添字の角括弧は [PostgreSQL公式の字句規則](https://www.postgresql.org/docs/current/sql-syntax-lexical.html) に記載されている。
- 現状: `arr[?]`、`data[:idx]` は置換され、引用識別子 `[from]` も保持された。空白を挟む添字の取りこぼしが残るため「未」に戻す。
- 影響: 通常の空白を含むSQLで未置換とバインド行のSQL混入が起き、構文の壊れた出力が成功扱いされる。
- 次の対応: 直前の有効なSQLトークンを見て配列添字を識別する。空白あり・なしの添字と引用識別子の保持を回帰確認する。

## 12. ヘッダーなしの名前付きバインド行がSQL本文に混入する

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: SQL直後の `id = 1` が、`params:` 等のヘッダーなしではSQL本文に混入する。
- 根拠: [名前付きプレースホルダの収集](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1975) と [暗黙バインド行の判定](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1993) が同名の定義を認識し、[残り行の確認](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2002) を経てセクションを切り替える。`select * from t where id=:id\nid=1` は `WHERE id = 1` となり、定義行や `:id` は残らなかった。
- 現状: 既存のヘッダーなしbare name入力は正しく認識される。
- 影響: 確認した入力では未置換・バインド行混入は起きない。
- 次の対応: 本課題の修正は不要。

## 13. 指数表記の数値バインドが文字列リテラル化される

- ステータス: 完
- 種別: 既存
- 重要度: 中
- 問題: `1e-3` / `1E+6` が文字列として引用され、また指数の `+` が整形で分断される。
- 根拠: [数値リテラルの共通定義](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1108) と [バインド値の正規化](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1902) が指数表記を数値扱いし、[指数のプラス符号の保護](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2557) もある。手入力の `1 = 1e-3`、MyBatisの `1E+6(BigDecimal)`、Hibernateの `[NUMERIC] - [1E+6]`、Spring JDBCの `java.math.BigDecimal` 値で、指数表記が引用なし・符号の分断なしで出力された。Spring JDBCの `java.lang.String` 値 `1E+6` は `'1E+6'` のまま保持された。
- 現状: 各対応入力形式で指数表記の数値と文字列を区別できている。
- 影響: この課題の文字列化・指数部の分断は確認した入力で起きない。
- 次の対応: 本課題の修正は不要。

## 14. `AS` の空白補完が `ASC` や `ASCII` を分断する

- ステータス: 未
- 種別: 新規
- 重要度: 高
- 問題: キーワードや関数名の先頭の `AS` まで別名指定と判断し、正常なSQLを壊す。
- 根拠: [AS後の空白補完](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:3223) の正規表現は、`AS` の後ろに英数字が続く場合も置換対象にする。`select id from users order by id asc` は `ORDER BY id AS C`、`select ASCII(name) from users` は `SELECT AS CII(name) FROM users` 相当になった。
- 現状: 通常の昇順指定だけで再現する。バインド不足・余剰はないため、[描画処理](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:3334) は壊れた出力を変換成功としてコピー対象にする。
- 影響: 頻出の `ORDER BY ... ASC` を含むSQLが実行できなくなる。
- 次の対応: 空白補完を独立した `AS` と別名の境界に限定し、`ASC`、`ASCII`、`AS` から始まる識別子を分断しないようにする。昇順指定と通常の別名指定の回帰確認を追加する。

## 15. ログの文字列バインド値から前後空白・引用符が失われる

- ステータス: 未
- 種別: 新規
- 重要度: 高
- 問題: ログに含まれる文字列そのものの前後空白や引用符が、入力書式の装飾として削除され、別の値へ変換される。
- 根拠: [ログ値の取り出し](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1334) と [ログバインド行の生成](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1427) が値を `trim()` し、[文字列の引用処理](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:1233) は既に引用符で囲まれて見える値をそのまま返す。`==> Preparing: select ?\n==> Parameters: 'hello'(String)` は、引用符を値に含めた `'''hello'''` ではなく `'hello'` を出力した。Spring JDBCの `Executing prepared SQL statement [select ?]\ncolumn index 1, parameter value [ abc ], value class [java.lang.String], SQL type unknown` は `' abc '` ではなく `'abc'` になった。[MyBatis公式のログ生成実装](https://mybatis.org/mybatis-3/xref/org/apache/ibatis/logging/jdbc/BaseJdbcLogger.html#L87) も、文字列の実値に型名を添える処理であり、この引用符はSQLリテラルの外枠ではない。
- 現状: Hibernateの `[VARCHAR] - ['hello']` でも引用符の消失を再現した。ログ行から取得した値を手入力のSQLリテラルと同じ規則で正規化している。空文字の未置換（課題5）、Spring JDBCの `]` 抽出と数値風文字列の型判定（課題8）とは別の共通処理の問題である。
- 影響: 変換成功の表示でも検索条件や保存対象の文字列が元のログと異なり、調査結果の誤りや誤データにつながる。
- 次の対応: ログ由来の文字列を生の値として扱い、前後空白・引用符を保持したままSQL文字列にエスケープする。手入力の引用ルールと分け、3ログ形式で値の保持を回帰確認する。

## 16. 複数SQLのログで別のSQLのバインド値が混入する

- ステータス: 未
- 種別: 新規
- 重要度: 高
- 問題: 複数SQLを含むログを貼り付けると、SQL本文とパラメータが別々の範囲から選ばれ、異なるSQLの値が警告なしで使われる。
- 根拠: [MyBatisパーサ](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2054) は新しい `Preparing:` でSQLだけを初期化し、前の `_parametersText` を残す。`==> Preparing: select * from a where id=?\n==> Parameters: 7(Integer)\n==> Preparing: delete from b where id=?` は、後者の値が記録されていないのに `DELETE FROM b WHERE id = 7` を出力した。[Hibernateパーサ](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2116) もSQL更新時に `_bindLines` を初期化しない。[Spring JDBCパーサ](/Users/arita-ritsuki/Documents/ドキュメント/個人開発/bind-sql-java-logs/BindSQLJavaLogs.html:2208) は最初のSQLと入力全体のパラメータ行を組み合わせる。
- 現状: Hibernateでは前SQLの `[2] = 2` が後SQLに残り、後SQLの `[1] = 9` と合わせて `x = 9 AND y = 2` になった。Spring JDBCでは最初のSQLの `id = 1` が、後SQLの値を使った `id = 9` に変わった。いずれもプレースホルダの件数が合うと警告されない。
- 影響: 元ログに存在しないSQLと値の組み合わせを生成する。出力を実行すると、誤ったレコードの検索・更新・削除につながる。
- 次の対応: SQL開始ごとに対応するバインドを分離し、対象の組み合わせを確定できない複数文入力は変換未完了としてコピーを抑止する。3ログ形式で別SQLの値が流入しないことを回帰確認する。

---

**調査範囲と確認方法**

- `BindSQLJavaLogs.html` 全体、README、既存REPORT、Git管理ファイルと隠しファイルの構成を読み取りで確認した。ルーティング、API、外部API連携、DB実行・保存、認証・認可の実装はなく、単一HTML内で変換する構成である。`package.json`、依存関係・lock file、環境変数ファイル、ビルド設定、自動テスト・CIは確認できなかった。
- 永続化はテーマ設定の `localStorage` のみで、読み書き失敗は捕捉される。入力表示はHTMLエスケープを経てハイライトされ、出力はtextareaの `value` に設定される。HTML風の文字列もエスケープされたことを確認した。CSPは外部接続を禁止している。これらを根拠なく追加課題にはしていない。
- HTML内の既存スクリプトを変更せずNode.jsのVMで実行し、最小限のDOM・ブラウザAPI代替を用いて実際のinputイベント処理から出力まで確認した。既存13件の従来例、残存不具合の入力、新規3件の入力を照合した。検証スクリプト・テストファイルは保存していない。
- 実ブラウザの見た目・クリップボード動作と、PostgreSQLへの実接続・SQL実行は今回の確認対象外。記載した再現結果は変換処理の実行結果であり、DB上での実行結果ではない。
- 実装、設定、テスト、依存関係は変更せず、更新対象はこの `REPORT.md` のみ。
