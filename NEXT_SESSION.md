# 次回への引き継ぎメモ

## 目的と方針

Godot 4 の `.tscn` をブラウザで表示し、Three.js 用の再利用可能な class に変換する Web アプリ。TSCNLoader は内部処理であり、npm パッケージとして公開しない。会話は日本語。

- 利用者は生成 class と `AbstractVFXMesh.min.js` を使う。
- 全機能と数値精度を保持する。容量削減を理由に3Dノイズ等を削らない。
- 元の外部 Godot アセットは書き換えない。
- UI操作を始める前と完了時にユーザーへ知らせる。

## 現在の構成

- `src/`: TSCN解析・変換の内部処理。
- `src/app/index.html`: TSCNプレビューとWebGL/WebGPU class書き出し。
- `src/app/three-class/index.html`: 書き出したclassの動作確認。
- `src/app/three-class/AbstractVFXMesh.js`: 配布用共通ランタイムの読みやすい原本。
- `src/app/three-class/runtime.js`: 書き出し補助・テスト用ランタイム。`renderAbstractVFXMeshSource()` は原本の再生成に使う保守用関数。
- `examples/assets/`: 同梱Godotアセット。ExplosionFXの3種とデモシーン、共通リソース。
- `scripts/generate-preview-manifest.mjs`: `src/app/effects.js` の一覧生成。
- `scripts/minify-vfx-runtime.mjs`: 共通ランタイムの独自圧縮。Viteから関数として呼ぶほか、単独実行できる。
- `vite.config.js`: ページをバンドル。`emptyOutDir: true` で掃除し、プラグインでランタイム出力と配布ファイルのコピーを行う。
- `dist/`: 公開用の生成物。Git対象外。
- `package-lock.json`: このプロジェクトの依存を固定。インストールは `npm ci`。

公開URLは `/`、`/three-class/`、`/examples/assets/`。`/app` や旧ページへの転送はない。同梱の `res://assets/BinbunVFX_Vol2/examples/assets/` 参照はアプリのresourceMapResolverで `/examples/assets/` に対応付ける。外部プロジェクトは `GODOT_ROOT=/path/to/project` 指定時のみ `/godot/` から配信する。

Three.js core/WebGPU/TSLはimportmapでローカル配信し、生成classと同じモジュールを共有する。アプリのコードと使用するadd-onはViteでバンドルする。

## コマンド

- `npm run dev`: 一覧生成後にViteを起動。圧縮ランタイムはメモリから配信し、distを必要としない。
- `npm run build`: 一覧生成、型チェック、Viteビルド。
- `npm run preview`: ビルド後にVite previewを起動。
- `npm run minify:runtime`: 共通ランタイムだけをdistに再生成。
- `npm test`: pretestで圧縮ランタイムを生成してから全テスト。
- `npm run typecheck`: TypeScriptの型チェック。中間JSは生成しない。

## ランタイムの圧縮と再現性

同梱Terserを使用。enum数値化、勾配表のパレット化、乱数ベクトルの十進係数・指数のビット詰め/Base85可逆圧縮、3Dベクトルのゼロ成分省略、モジュール内FastNoiseLiteメソッドの短縮を行う。全2,048個のテーブル値を `Object.is` で検査し、公開APIとライセンスを保持する。Terserは `ecma: 2022`、`passes: 10`。

2026-10-13の原本は169,416 bytes、minは61,466 bytes。gzipは24,193 bytes、Brotliは21,415 bytes（Node zlib既定設定）。SHA-256:

```
3d404ba4e35d37f1ee45689a97f54bff0d1278b45a957f597460ce56a94f813d
```

圧縮出力は通常のES module。gzip復号ラッパー、WASM、精度を落とす量子化は導入していない。

classデータは辞書化とLZ3/Base85圧縮を使う。ジオメトリ・粒子・ノイズ・グラデーションは可能な場合レシピを保存して復元し、classごとに大量の画素や粒子インスタンスを埋め込まない。有効な粒子レシピがない場合はベイク済みインスタンスを保持する。

## 描画の留意点

- classには元のシーンルートを含め、比較用の床・カメラは含めない。
- Hue確定値とシェーダーパラメータ変更はclassに反映する。画像ピクセルとシェーダー内の固定色はHue変更対象外。
- 音声差し替えはプレビュー用。classの音声再生は書き出さない。
- GradientTexture2Dの省略時はGodot既定値（64×64、開始(0,0)、終了(1,0)）を使う。過去の偽の半球表示はこの既定値の誤りが原因だった。
- GradientTexture2Dは寸法・linear/radial・HDR・RGBA・補間等をレシピとして保存。旧Base64画像も読み込める。
- CPU粒子の乱数配置や最終画像はGodotと完全一致しない。警告がないことは画像一致を意味しない。
- GDScriptの一般実行、物理、Skeleton3D/AnimationTree、VisualShaderのグラフ、Godotの高度な環境描画は未対応または近似。

## 外部アセットに関する過去の確認

外部TSCN 53件をNode.jsでパース・ロード・updateTimeした際は構文エラーとロード例外がなかった。画像読み込みをモックした確認であり、全件のブラウザ描画確認ではない。以下の外部アセット不足・未対応は当時の調査結果であり、同梱サンプルの欠落ではない。

- BattleFX: `effects/shield/vfx_blank_shield_02.tscn` が不足。
- DarkMagicFX full: 子シーン18件が不足。
- ElectricFX full: 子シーン16件が不足。
- StatusFX: `poison_overlay.tres` が不足。人物のバイナリArrayMesh等は未対応。
- tornado: OBJ/TGAは対応、VisualShaderは代替マテリアル。
- spell-fx-freeのNode2Dデモ: 3Dプレビューの対象外。

## 不要ファイルの整理

旧サーバー、旧Loader利用例、clean/copyスクリプト、未参照のexplosion_sphereシェーダー、旧standalone HTML用の埋め込み分岐は削除済み。HDRの `.import` はGodot用設定として保持。`.playwright-mcp/` はアプリには不要な検証ログ・画像・classでGit対象外。必要なclassを保存しなければフォルダーごと削除可能。

## 検証

2026-10-13、プロジェクト内の依存で確認済み。

- レジストリのDNS解決ができないため、ローカルnpmキャッシュから宣言済みの依存をインストールし、lockファイルを生成した。
- `npm ci --offline`: 成功。全依存はこのプロジェクト内にあり、別プロジェクトへのリンクはない。
- Vite 7.3.6、Vitest 3.2.4、Three.js / @types/three 0.180.0、TypeScript 5.9.3、@types/node 22.20.2。
- `npm test`: 17ファイル成功、93件成功・1件スキップ。Loot実アセットは `BINBUN_VFX_ROOT=/path/to/BinbunVFX npm test` で検証する。
- `npm run build`: 型チェックを含め成功。
- 圧縮ランタイムのSHA-256は上記と一致。
- Three.js r180のprimitive `toJSON()` は `_transformed` を無視するため、exporterはカスタム頂点属性を持つprimitiveを一時的にBufferGeometryとして保存し、その後に元の型・parametersを復元する。頂点カラーと粒子・軌跡の再現テストは成功。
- TGALoader.parseの型定義が実際の返り値と異なるため、画像descriptorとして局所的に型指定した。
- 手書きNode型のshimは削除し、@types/nodeを直接依存に追加した。
- この確認ではブラウザの描画を目視確認していない。


## 依存更新の事前確認（未適用）

ユーザー指定: @types/node ^26.6.5、TypeScript ^7.0.2、Vite ^8.3.4、Vitest ^5.0.4、@types/three ^0.186.0、Three.js ^0.186.1。

npmレジストリへのDNS解決がENOTFOUNDになるため、一時環境 `/tmp/godot-ts7-upgrade-check` でキャッシュ済みのパッケージだけを検証した。

- TypeScript 7.0.2、Three.js 0.186.1、@types/three 0.186.0と現行Vite 7.3.6 / Vitest 3.2.4: 型チェック、ビルド、93テスト成功・1スキップ。
- TypeScript 7.0.2とVite 8.3.2: 型チェックとビルド成功。開発時のTS変換と両ページのinline module変換も成功。サンドボックスがWebSocketのlistenをEPERMで拒否するため、HTTP/HMRの稼働やブラウザ描画は未検証。
- 指定Vite 8.3.4、Vitest 5.0.4、@types/node 26.6.5はキャッシュにない。全指定バージョンの組み合わせは未検証。
- ユーザーの指示で本体のpackage.jsonを指定版へ更新済み。npm installはレジストリのDNS解決エラー（ENOTFOUND）で失敗。package-lock.jsonとインストール済み依存は更新前のままであり、package.jsonと未同期。接続可能な環境でnpm installを完了し、npm testとnpm run buildを実行する必要がある。
