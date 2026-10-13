# Godot TSCN Preview & Three.js Class Converter

Godot 4 の `.tscn` をブラウザでプレビューし、three.js 用の再利用可能な class に変換して書き出すローカル Web アプリです。TSCN の読み込み処理はアプリ内部で使います。利用側に TSCNLoader の npm パッケージは不要で、書き出した class を three.js のシーンへ追加して使えます。

## 開発・公開

Node.js 20.19以降の20系、または22.12以降を使用してください。

```sh
npm ci
npm run dev
```

`package-lock.json` を含めて依存バージョンを管理します。取得後は `npm ci` でこのプロジェクト専用の依存をインストールしてください。

`npm run dev` は Vite の開発サーバーで `src/` の TypeScript と画面コードを直接配信します。`npm run build` は Vite で画面コードをバンドルして `dist/` に出力します。`npm run preview` はビルド後に Vite のプレビューサーバーを起動します。どちらも `http://127.0.0.1:5173/` で開けます。Three.js はローカルから配信します。開発時の圧縮ランタイムはメモリから配信するため、`dist/` は不要です。

プレビュー画面の編集元は `src/app/index.html` です。Vite が TypeScript と Web アプリの JavaScript を直接 `dist/assets/` にバンドルし、Three.js、共通 class ランタイム、サンプル Godot アセットと一緒に出力します。`dist/` を静的ホスティングに配置して公開できます。`package.json` は npm パッケージとして公開しない設定です。

プレビューは市松模様の床、黒い背景、低いカメラ視点を備えています。エフェクト選択、全エフェクトの同時比較、アニメーション選択、再生・一時停止、速度変更、再スタート、繰り返し再生、OrbitControls に対応しています。床の反射は省略しています。床の接地影は比較用の簡易表示です。

### 書き出した Three.js class の確認と利用

`http://127.0.0.1:5173/three-class/` で書き出した `.js` class を確認できます。プレビュー画面の「WebGL class を書き出す」または「WebGPU class を書き出す」で class を保存します。WebGPU class は WebGPU 対応ブラウザと GPU が必要です。

生成 class は `AbstractVFXMesh.min.js` を import するため、`dist/three-class/AbstractVFXMesh.min.js` を class ファイルと同じフォルダーに置いてください。実際の three.js アプリでは、Three.js を依存関係に追加し、生成 class を import してシーンへ追加します。

共通ランタイムの編集元は `src/app/three-class/AbstractVFXMesh.js` です。`npm run build` は Vite のプラグインから `scripts/minify-vfx-runtime.mjs` の圧縮処理を呼び出し、min 版をビルド成果物として毎回出力します。ランタイムだけを更新する場合は `npm run minify:runtime` を実行してください。圧縮は同梱の Terser を使い、ノイズ数値表のパレット化・十進数の可逆圧縮・ゼロ成分の省略・内部メソッド名の短縮を行います。生成時に全数値表の完全一致を検査し、ライセンスと公開 API を保持します。同じ原本・スクリプト・同梱 Terser からは同一の出力を生成します。

```js
import VFXClass from './effect.webgl.js';

const effect = new VFXClass();
scene.add(effect);
```

プレビュー用の床・カメラ・照明は生成 class に含みません。遠距離でエフェクトがフォグに埋もれないよう、class preview ではシーンの大きさに合わせてカメラのズーム上限を設定し、必要な場合だけ視距離に応じてフォグを弱めます。通常の視点距離では Godot のフォグ設定をそのまま使います。

`npm run build` は `examples/assets/ExplosionFX/effects` 以下の `.tscn` を検索し、`src/app/effects.js` の一覧を更新します。VFX アセットと共通リソースは `examples/assets/` に置き、ソースコードと分けています。現時点の対象は次の 3 種類です。

### ディレクトリ

- `src/`: TSCN 解析・Three.js 変換の内部処理とアプリのソースコード
- `src/app/`: プレビュー画面と Three.js class 書き出し機能
- `src/app/three-class/AbstractVFXMesh.js`: 共通 class ランタイムの編集元
- `examples/assets/`: 参照用の Godot シーンとリソース
- `dist/`: `npm run build` が生成する公開用 Web アプリと共通ランタイム
- `dist/examples/assets/`: 同梱アセットの公開先。元の `res://` 参照はアプリ側でこの URL に対応付けます。
- `scripts/`: エフェクト一覧の生成と共通ランタイムの圧縮。`dist/` の掃除は Vite の `emptyOutDir`、配布ファイルのコピーは `vite.config.js` のプラグインが担当します。

- 地上爆発：`examples/assets/ExplosionFX/effects/ground/vfx_ground_explosion_01.tscn`
- 空中爆発：`examples/assets/ExplosionFX/effects/air/vfx_air_explosion_01.tscn`
- 核爆発：`examples/assets/ExplosionFX/effects/nuke/vfx_nuke_explosion_01.tscn`

`explosion_fx_scene_free.tscn` は環境・物理ノードを含む Godot のデモシーンです。全エフェクト比較では、3 種類のエフェクトを比較用の環境に配置します。

## フォルダのドロップ

Chrome でプレビューを開き、Finder から Godot プロジェクトまたはアセットフォルダを画面へドロップします。「フォルダを選択」でも読み込めます。DarkMagicFXFree の `assets/BinbunVFX_Vol2` のような、プロジェクトの一部だけのフォルダにも対応しています。

- `.tscn` を再帰検索し、`effects` 以下を優先して一覧に表示します。デモシーンも個別に選択できます。
- `res://` のパスは、フォルダ内の相対パスとシーンの外部リソース宣言を照合して解決します。関連リソースと `shared` を含むフォルダを選んでください。
- 読み込んだファイルはブラウザ内の Blob URL で利用します。アセットをサーバーへ送信する処理はありません。ブラウザの再読み込み後は再ドロップが必要です。
- 「すべて並べて比較」はエフェクトを並べます。カメラと床からの高さを比較用に調整します。「元のアセット」で ExplosionFX の一覧に戻れます。
- 常時動くエフェクトは `open` を再生した後もシェーダーの時間更新を続けます。一時停止すると時間更新も停止します。
- フォルダ全体の参照問題は折りたたみ欄で表示します。選択シーンの変換警告は従来の警告欄に表示します。DarkMagicFXFree の `dark_magic_fx_scene_full.tscn` は無料配布に含まれないシーンを参照しているため、その参照は解決できません。

DarkMagicFX の `vfx_evil_area_01.tscn`、`vfx_ball_evil_01.tscn`、`vfx_evil_projectile_01.tscn` を実際に読み込み、描画を確認しました。任意の Godot プロジェクトの全機能が動作するという意味ではありません。外部 glTF の別ファイル参照など、Blob URL を基点にした依存読み込みには追加の対応が必要です。

## 対応機能

| 分野 | 対応範囲 |
| --- | --- |
| パーサー | TSCN / TRES セクション（`[resource]` を含む）、複数行、ネストした配列・辞書、リソース参照、Vector、Color、Basis、Transform3D、Quaternion、NodePath |
| ノード | Node3D、MeshInstance3D、Camera3D、Directional/Omni/Spot Light、AnimationPlayer、GPUParticles3D の CPU 再生、WorldEnvironment、StaticBody3D/CollisionShape3D の階層と Transform |
| メッシュ | Box、Sphere、Plane、Quad、Cylinder、Capsule、Torus、OBJ、外部 glTF/GLB、TubeTrailMesh の履歴を使った変形 |
| リソース | `.tscn`、`.tres`、`.gdshader`、`.gdshaderinc`、PNG/JPEG/WebP/TGA 等の画像、内部リソース、外部リソース、キャッシュ、循環シーン検出 |
| マテリアル | Standard/ORM の PBR プロパティ、透明・加算等の合成、ShaderMaterial のパラメーター |
| シェーダー | spatial、相対／res パスの #include（循環検出）、uniform、varying、補助関数、vertex/fragment/light ステージ、UV/TIME、texture/textureLod、頂点変形、ALBEDO/ALPHA/EMISSION、法線マップ、source_color |
| 生成テクスチャ | FastNoiseLite、シームレス生成、反転、正規化、domain warp、color_ramp（法線生成前にも適用）、法線生成、ミップマップ、CurveTexture/CurveXYZTexture、GradientTexture1D |
| アニメーション | 位置・回転・スケール、可視性、放出、数値、マテリアル uniform、ループ情報、離散/線形/対応可能な滑らか補間、キーの transitions（120 Hz の標準トラックにサンプリング） |
| 粒子 | 寿命・放出量・爆発率、初速・方向・spread、球状放出、重力、放射／直線／接線方向の加速度とカーブ、damping、角度、サイズカーブ、色・アルファカーブ、ビルボード、軌跡、周波数式サブエミッター |

粒子はノード名に依存する推測を使わず、ParticleProcessMaterial の値から計算します。1 エミッターの表示上限は 2048 個です。Godot の GPU 実装とは乱数列が異なるため配置は一致しません。

同梱の `VFXExplosionBB.gd`、`VFXOmniLightBB.gd` と DarkMagicFX の球・領域・弾の制御スクリプト は実際のコードを確認し、保存された色・テクスチャ・煙の個数・ライト倍率を専用アダプターで反映します。一般の GDScript 実行機能ではありません。音声リソースを持たない AudioStreamPlayer3D は無音の制御ノードとして扱います。

## 検証と残る差異

```sh
npm run typecheck
npm test
npm run build
```

2026-10-13の全テストは17ファイル、93件成功・1件スキップです。

テストには同梱シーンの読み込み、class 書き出し、通常ランタイムと圧縮ランタイムの再現性を確認するものが含まれます。任意の外部アセットを必要とするテストは、そのアセットがない環境ではスキップします。Loot の実アセット検証は `BINBUN_VFX_ROOT=/path/to/BinbunVFX npm test` で有効にします。過去に外部 TSCN 53 件を Node.js 上で読み込み、構文エラーと読み込み例外がないことを確認しましたが、全件のブラウザ描画を確認した結果ではありません。実物がない参照や未対応の Godot 機能は警告として残ります。

DarkMagicFX の `dark_magic_fx_scene_free.tscn` も実際のフォルダからブラウザに読み込み、３つのシーンインスタンスと５つのアニメーションを確認しました。各インスタンスのトラックを UUID に結び付け、同名の内部ノードがある場合も別々に再生できます。無料フォルダに存在しない有料版シーンへの参照は、フォルダ全体の参照問題として別途表示します。

Godot 4.7.2 の実行結果とも比較しました。地上爆発の 512×512 ノイズ画像は、Godot 生成画像と各画素を比較し、core/smoke とも最大差 1/255、99.99% 以上の画素が一致しました。炎・煙の配置や最終描画全体の一致を示す数値ではありません。添付 GIF の床と視点を参考にしています。

以下は完全再現していません。

- GPU 粒子の乱数列、衝突・吸引・乱流、全ての放出形状やサブエミッターモード、複数 draw pass。
- GDScript の一般実行、物理、音声再生、シグナル接続、CanvasItem。
- Godot の GI・SSR・SSAO・SSIL・ボリュームフォグ・影の完全な描画。WorldEnvironment のパノラマ・回転・露出・距離フォグ（Godot の指数減衰）・空への霧は変換し、プレビューでは bloom でグローを近似します。ボリュームフォグは均一な吸収として近似し、色付きの散乱や局所ライトの霧への光照射、カスタムシェーダーへの環境光照射には差異が残ります。
- Godot シェーダー言語全体、画面/深度テクスチャ、全 render_mode、完全な PBR 光照射。
- Godot VisualShader のノードグラフ、埋め込みバイナリ ArrayMesh と Skeleton3D / AnimationTree、Node2D の描画、任意 GDScript の実行。
- アニメーションのBezier/method トラック、全プロパティと全 AnimationPlayer 設定。
- Gradient の全補間モード・色空間、全基本メッシュの UV 完全一致。

未対応ノード、見つからないリソース、変換不能シェーダー等は警告または例外で報告します。変換可能な機能でも上記の描画差は残るため、警告なしを Godot と画素単位で一致する意味には使わないでください。

## 構成とライセンス

TSCNParser、TSCNLoader、GodotResourceResolver と各種コンバーターは、プレビューと class 変換を行うアプリ内部の処理です。利用側へ Loader パッケージとして提供する構成ではありません。

FastNoiseLite の公式 TypeScript 実装を MIT ライセンスで同梱し、ソース内の著作権表示を保持しています。[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を参照してください。元の VFX アセットのライセンスは `examples/assets/ExplosionFX/license.txt` にあります。


### DarkMagicFX の表示調整

Godot 4.7.2 の実インスタンスを headless モードでも確認し、保存時に省略される Omni/SpotLight3D の既定 range=5、attenuation=1 を反映しています。spatial シェーダーにはラフネスを使った Burley 拡散光、Godot のライト減衰・コーン減衰、距離に比例する指数フォグを適用します。`fog_disabled` はフォグを除外します。`ambient_light_source=3` と `reflected_light_source=2` では環境光・環境反射を無効にします。霧が空全体にかかるシーンでは、明るい HDR 背景を霧の色に置き換えます。

`Transform3D` と数値形式の `Basis` は、Godot のテキスト保存順（行順）で読み込みます。実際の DarkMagic のスポットライトが下向きになることを Godot 本体の `basis.z` と照合し、回帰テストを追加しました。

床の `NoiseTexture2D_wejg2`（法線）と `NoiseTexture2D_2ukpv`（ラフネス）は、Godot 本体が生成した 512×512 RGBA8 画像と比較し、両方とも全ピクセル・全チャンネルが一致しました。法線は前方差分、Y 成分の符号、端の折り返し、8bit 切り捨てを再現しています。カラーランプの出力も Godot に合わせて切り捨てます。

これらは変換式とプロパティの修正です。DarkMagicFX の Godot 実行画像との同一フレーム比較は、Godot の GUI 操作エラーによりまだ完了していません。「ほぼ一致」を画像比較で確認したという意味ではありません。


### プレビューでのカスタマイズと class 書き出し

「カスタマイズ」を開き、対象ノードを選ぶと、変換済み ShaderMaterial の色・数値・真偽値・Vector2/3/4 を編集できます。ノイズ倍率・スクロール速度・発光など、実際のシェーダーにある項目を表示します。内部描画用 uniform は編集項目から除外します。テクスチャの項目では画像ファイルを選択して差し替えます。「戻す」は選択したエフェクトの全パラメータとテクスチャを読み込み時の値に戻します。共有マテリアルを使うノードでは変更も共有されます。

「全体の Hue」スライダーは、表示中のアセットの色パラメータ、PBR マテリアルの色・発光色、ライトの実際の RGB 値を調整します。「色に適用」で値を確定し、スライダーを 0° に戻します。確定した色は再生中も維持されます。「Hue を戻す」は未確定の調整を取り消し、「戻す」は確定した色も読み込み時の値へ戻します。「すべてのエフェクト」表示中はすべてに適用します。画像テクスチャのピクセル、シェーダー内の固定色、フォグ、背景色は書き換えません。

「WebGL class を書き出す」または「WebGPU class を書き出す」を押すと、選択中のエフェクトを Three.js class として保存します。プレビューの床・カメラ・照明は含みません。書き出しには TSCNLoader の利用は必要ありません。生成 class と `AbstractVFXMesh.min.js` を同じフォルダーに置き、three.js が解決できる環境で import してください。

編集値はプレビューへ反映されます。書き出した class は Three.js のアプリへ組み込んで利用します。


### 画像・音声ファイルの差し替え

カスタマイズの texture 項目から PNG/JPEG/WebP など、ブラウザが読み込める画像を選択できます。元テクスチャの色空間・ラップ・向き・ミップマップ設定を引き継ぎます。「音声の差し替え」で音声ノードを選び、ファイルを選択するとデコードして立体音響で再生します。音量（倍率）・速度・ループを設定できます。再生・停止、プレビューの一時停止・再開・最初からにも対応します。音声はブラウザの操作後に有効になります。

画像はプレビュー中のテクスチャに反映されます。音声差し替えはプレビュー確認用で、Three.js class への音声再生機能の書き出しには対応していません。選択したファイルをサーバーへアップロードする機能はありません。音声形式のデコード可否はブラウザによります。


### エフェクトフォルダの追加ドロップ

プロジェクトのエフェクトフォルダ一式を画面にドロップすると、内側の `.tscn`・`.tres`・`.gdshader`・画像などを再帰的に読み込み、既存のシーン一覧に追加します。`.tscn` 単体・複数ファイルも追加できます。「フォルダを追加」「ファイルを追加」でも選択できます。「元のアセット」で追加分を解除します。

追加前のシーン ID を維持し、同じパスのファイルは更新します。フォルダ外の `shared` やテクスチャを参照している場合、ブラウザはそのファイルを自動取得できません。不足パスを警告として表示するので、依存リソースも追加するか、プロジェクトルート・アセットフォルダ全体をドロップしてください。後から依存ファイルを追加すると警告も再計算します。


### ビルドしたアプリをローカルで開く

```sh
npm run preview
```

`http://127.0.0.1:5173/` を開きます。起動前に Vite でビルドし、Three.js のモジュールもローカルから配信します。停止は Ctrl+C です。外部公開せず、127.0.0.1 にだけ接続を待ち受けます。

- `/`: TSCN プレビュー
- `/three-class/`: 書き出した Three.js class のプレビュー
- `/vendor/three/`: インストール済み three.js
- `/examples/assets/`: このリポジトリに同梱した VFX アセットと共通リソース
- `/godot/`: `GODOT_ROOT` で指定した外部 Godot プロジェクトのリソース（指定時のみ）

別のプロジェクトを配信する場合:

```sh
GODOT_ROOT=/path/to/godot-project npm run preview -- --port 5174
```

`GODOT_ROOT` は `res://` に対応するプロジェクトルートです。フォルダドロップも引き続き利用できます。ドロップしたファイルはブラウザ内で読むため、自動的にサーバーへ保存されません。差し替えファイルの URL 配信が必要な場合は、対応する配信先にファイルを配置してください。

### StatusFX の深度フェード

StatusFXFree の実際の `streaks.gdshader` と `aura_particle.gdshader` にある `hint_depth_texture`、`SCREEN_UV`、`INV_PROJECTION_MATRIX`、fragment ステージの `VERTEX` を変換します。Godot の深度復元式は three.js の WebGL 深度（NDC -1〜1）に合わせます。`MODEL_NORMAL_MATRIX` も頂点ステージで変換します。

プレビューはアプリ内部の `GodotDepthPass` で不透明な床・メッシュの深度を先に描き、VFX に渡します。生成 class を使うときも、深度テクスチャを参照するシェーダーでは同等の深度処理が必要です。これは TSCNLoader の利用とは別の描画補助です。

`StatusFX/effects/status/vfx_status_shatter.tscn` と `StatusFX/status_fx_free.tscn` を、実際のリソース（HDR・GLB を含む）からブラウザに読み込み、シェーダーコンパイルエラーがないことを確認しました。StatusFX の既知スクリプトの色・ノイズなどのシェーダー設定も反映します。人物の埋め込み ArrayMesh・Skeleton3D・AnimationTree、Godot の高度な環境描画は引き続き未対応です。無料フォルダ内に存在しない `poison_overlay.tres` の参照は不足警告になります。深度パスは標準の不透明ジオメトリを対象とし、独自シェーダーの頂点変形・アルファ切り抜きの完全再現は含みません。


### BinbunVFX の Loot エフェクト

`BinbunVFX` フォルダ一式を追加できます。浮遊型・地面型それぞれ Common / Uncommon / Rare / Epic / Legendary / Mythic の 12 エフェクトと、`loot_effects/loot_vfx_scene.tscn` の一覧シーンを実ファイルから確認しました。12 エフェクトは変換警告・ブラウザのシェーダーコンパイルエラーなしで描画でき、粒子と TIME による発光・揺れを再生します。AnimationPlayer を持たないエフェクトでも `result.updateTime(timeSeconds)` を毎フレーム呼びます。

共通 `.gdshaderinc` の読み込み、TorusMesh、粒子描画時の `INSTANCE_ID`、`VFXLoot` / `VFXEffect` の既知の設定処理に対応しています。色・発光・shine_direction・粒子テクスチャ・放出量・寿命・半径・放射加速度・ライト設定の保存値を反映します。任意の GDScript の実行には対応していません。シェーダーの色やノイズなどは既存のカスタマイズ UI で変更できます。

一覧シーンの SSR・SSAO・SDFGI・ボリュームフォグは引き続き近似／未対応として警告します。Godot と同じ乱数配置や環境描画までの一致は保証しません。外部アセットが存在する環境では `tests/GodotLoot.test.ts` が実際の 12 シーンを読み込む統合テストを実行し、存在しない環境ではこの実アセットのテストのみスキップします。
