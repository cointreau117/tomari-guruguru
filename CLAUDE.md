# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

ブラウザ上のキャラクターアバター。マウスに追従して25方向に振り向き、自動でまばたきする。**Live2D/Spine のような骨格アニメではなく、向き・表情ごとの静止画を `<img>` で重ねて切り替える「画像差し替え式」**である点が全体設計を貫く前提。かつての「ぐるぐる版」「トーク版」は1つのアプリ（`src/avatar-app.jsx`）に統合済み。

進行中の方針: 「口パク」を廃し「**音楽に反応して踊る／演出する**」アバターへ改造中。設計議論は `handover-notes.md` に集約。**踊る版 v1（最小コア）は実装済み**＝読み込んだ曲のビートでキャラが跳ね、音符パーティクルを飛ばす。詳細は下記「音楽反応（踊る版 v1）」。

## コマンド

```bash
npm install
npm run dev        # Vite dev server (127.0.0.1:5173)、index.html を自動で開く
npm run build      # dist/ を生成（base=/tomari-guruguru/）
npm run preview    # ビルド結果を base=/tomari-guruguru/ で確認（4173）
npm run verify:pages  # dist/ の Pages 成果物を検証（build 後に実行）
```

- dev と build で **base path が異なる**: dev は `/`、build は `/tomari-guruguru/`（GitHub Pages 用）。`preview` は `--base /tomari-guruguru/` を明示しないと壊れる。
- テストランナーは無い。検証は `verify:pages`（dist のHTML/画像の整合）と手動目視。
- マイク入力は `localhost` か HTTPS でのみ動作。Google Fonts は CDN 読み込みのため初回はネット接続が必要。
- 単体テストの仕組みは無いので、変更確認は `npm run dev` でブラウザを開いて目視するのが基本。

## アーキテクチャ

### エントリポイント（単一ページ）
Vite の単一エントリ構成。`vite.config.js` の `rollupOptions.input` は `index.html` のみ:
- `index.html` — 統合アプリ（`src/avatar-app.jsx`）

かつては talk版（`src/talk-app.jsx`）/ ぐるぐる版（`src/app.jsx`）のマルチページだったが、変更点がぼけ不具合の温床になるため **talk版を土台に1本化**した。ぐるぐる版固有の「押下スケール演出」「デバッググリッド」は統合版へ移植済み。音声解析（`AnalyserNode`）の配線は残しつつ、**口パク出力（音量→口シート切替）は無効化**し、口シートB/C/E/Fは未使用（A=目開け・D=目閉じの2枚のみ描画）。これは「踊る/演出版」で出力先をモーションへ差し替える前提。

HTML は `src/tweaks-panel.jsx` を**先に**、続いて `src/avatar-app.jsx` を `<script type="module">` で読む。この読み込み順が重要（下記）。

### 画像フレームの仕組み（最重要）
- 向き = **5列×5行の25方向**。`r{0-4}c{0-4}`（row=上下: 0上→4下、col=左右: 0左→4右）。
- 表情 = **A〜F の6状態**（目開け/閉じ × 口とじ/中間/開け）。
- 画像パス例: `slices2/A/r2c2.webp`（正面・水平・目開け口とじ）。実体は `public/slices2/`。
- **`src/character-config.js` が画像参照の唯一の真実源**。`basePath`・`ext`・グリッド寸法・シート名（A〜F）を集約。キャラ差し替え時はここを書き換えるだけ。`charConfig.src(sheet, r, c)` がパスを生成する。
- レンダリングは「全フレームを `<img>` で重ねて配置し、アクティブな1枚だけ `opacity:1`、他は `0`」方式。統合版 `avatar-app.jsx` は A/D の2シート×25=50枚を描画して切り替える（口パク無効のため口シートは未描画）。
- **表示サイズの仕組み（素材差し替え時の勘所）**: キャラの土台 `<div>` は `width/height: ${charSize * 4/3}vmin`＋`maxWidth/maxHeight: 1200`。各 `<img>` は `width/height: 100%` で土台にフィットするだけなので、**素材のピクセル解像度と画面表示サイズは分離**している（解像度は鮮明さ・メモリにのみ影響）。
  - `vmin`＝ビューポート短辺の1%。画面サイズに追従して拡縮し、`width=height` で正方形を保つ。
  - `* 4/3` は**フレーム内の余白補正**（スライダー値＝体感サイズに対し、枠は一回り大きく取る）。新素材で余白割合が変わればこの係数を調整。
  - マウス追従の中心 `rect.height * 0.45` は**フレーム内の顔の縦位置**基準。顔位置が変われば調整。
  - **素材の native 解像度を変えたら合わせるべきは `maxWidth/maxHeight`**（px絶対の上限＝拡大ボケ防止の天井）。Tweaks の `charSize` の `min/max`（vmin）は「画面占有率＝見た目の大きさ」の意図であり、素材pxとは無関係（見た目を変えたいときだけ触る）。
- **設計判断: スプライトシート（1枚に複数フレームを敷き詰め、CSS `background-position` / Canvas `drawImage` で1セルだけ表示）方式は当面採用しない**。キャラ素材を GPT Image 2 で生成しており、出力ごとに行・列の間隔が揃わず同一行でも数pxずれるため、固定グリッド前提のピボット合わせが破綻する。`tools/slice_character_sheets.py` の component mode はこのズレを吸収する用途なので、「個別フレームへ分割 → `<img>` で重ねる」現行方式を維持する。スプライトシート化を再検討するなら「踊る/演出版」でフレーム要件が固まってから（その際もシートは 4500×4500 のような巨大寸法を避け、GPU上限の実質下限 4096 未満＝2500×2500/500pxセル程度で十分。POTにする必要は無い）。

### 状態の更新ループ
`avatar-app.jsx` の `requestAnimationFrame` ループで:
- マウス座標 → 正規化(-1..1) → スムージング(`smoothing`) → 25グリッドの行/列に量子化 → `setCell`。
- まばたきは独立した `setTimeout` スケジューラ（不規則間隔・二度瞬き・ゆっくり瞬きの確率分岐）。
- `AnalyserNode` で音量(RMS)と低域エネルギーを解析。音量エンベロープ `env`（attack 速い/release 可変）は音量メーター表示に使用。低域はビート検出に使う（下記「音楽反応」）。`makeAudioEngine()` がファイル音声の解析エンジン（**音源は音声ファイル読み込みのみ**＝マイクUIは外した）。

### 音楽反応（踊る版 v1）
`avatar-app.jsx` のメインループ内に実装。**最小コア**＝バウンド＋音符パーティクルのみ（ビート駆動の25方向首振りは「標準」段階で先送り、口ずさみも無し＝A/Dのみ）。
- **ビート検出**: 低域(~47-235Hz)エネルギーの**適応しきい値「平均 + k×σ」**の外れ値判定。k は Tweaks「ビート感度」(0..1)で 2.2〜0.5 に写像（高いほど拍が増える）。`AnalyserNode.smoothingTimeConstant=0.2` でキックの瞬発を立てる。比率比較だと連続ベースで二極端になるため σ ベースにしている。
- **モーション**: 拍ごとに**放物線ホップ `4p(1-p)`** を `translateY` で。ホップ長 `hopDur` は**推定ビート間隔(BPM)に追従**。高さ `hopStrength` は `d/σ`（平均から何σ上か）基準。`transform` は再描画を避けるため rAF で `charRef.style` に直接書く（押下スケールもここで合成）。
- **演出**: 拍ごとに音符パーティクル（`index.html` の `floatUp` キーフレーム）。再生中は idle 浮遊（`bob` クラス）を停止（`<audio>` の play/pause/ended で `playing` 管理）。
- **音量と反応の責務分離（設計判断）**: 「音量感度→反応に効く／再生音量→反応に効かない」を実現したいが、再生音量をオーディオグラフで分離するには (a) Analyser 後段の GainNode＋自前スライダー＝**音量UIが2つに重複**、(b) 完全自前プレーヤー＝**ネイティブ再実装のリスク**、のいずれかで不採用。→ **再生音量はネイティブ `<audio controls>` 任せ**にし、代わりに**ダンス側をスケール不変に設計**して音量非依存を担保。ビート検出(平均+k×σ)も跳ね高さ(d/σ)も音量 g 倍で相殺されるため、**再生音量は音量メーター表示にのみ影響し、踊りのタイミング・高さは変わらない**。`micGain`(音量感度)は `level()` に掛かりメーター/`env`に作用。
- **UIレイアウト**: audio プレーヤー＝左下、コントロールバー(ファイル選択＋音量メーター)＝下中央、Tweaks＝右下（基盤 `tweaks-panel.jsx` は右下固定のまま）。互いに重ならないよう分散。

### Tweaks パネルと EDITMODE ブロック（注意が必要な仕組み）
`src/tweaks-panel.jsx` は外部プロトタイピング基盤（"omelette" scaffold）由来。**import されず、`Object.assign(window, {...})` で `useTweaks`/`TweaksPanel`/`TweakSlider` 等をグローバル公開する**。だから各アプリ JSX はこれらを import 無しで使える。HTML での読み込み順（tweaks-panel が先）が崩れると未定義になる。

各アプリ冒頭の `/*EDITMODE-BEGIN*/{...}/*EDITMODE-END*/` は tweak のデフォルト値。`useTweaks` の `setTweak` は `window.parent.postMessage({type:'__edit_mode_set_keys'})` でホストへ送り、ホストがこの JSON ブロックをディスク上に書き戻す前提。スタンドアロンで `npm run dev` する分にはメモリ内 state として動くだけで永続化はされない。この protocol/CSS は基盤由来なので通常いじらない。

## キャラ画像の生成（差し替え）
`tools/slice_character_sheets.py` が 4500×4500 の5×5シート6枚を 1200×1200 の個別フレームへスライスする。**ffmpeg/ffprobe が必要**。

- 単純な900pxセル切りではなく **component mode**（シート全体の連結成分を検出して25セルへ割当）が既定。隣キャラ混入・髪見切れを防ぐため。
- グレー背景の半透明残りは `--remove-gray-residue` で除去。
- 詳細手順・検証チェックリスト・ログの見方（`large=25`、各セル `1:xxxxx`）は `docs/新キャラ差し替え手順.md` を参照。

## デプロイ
`.github/workflows/pages.yml` が main への push で `npm ci → build → verify:pages → GitHub Pages へデプロイ`。PR では build と検証のみ（デプロイしない）。

## ライセンス（重要）
コードは MIT。ただし `public/slices2/` のキャラ画像・`docs/` の音声/生成素材は **MIT 対象外で流用禁止**（`ASSET_LICENSE.md`）。自作キャラへ差し替える前提で、トマリの素材は再配布・商用利用しないこと。
