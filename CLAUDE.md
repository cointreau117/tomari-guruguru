# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

ブラウザ上のキャラクターアバター。マウスに追従して25方向に振り向き（ぐるぐる版）、音声に合わせて口パク・まばたきする（トーク版）。**Live2D/Spine のような骨格アニメではなく、向き・表情ごとの静止画を `<img>` で重ねて切り替える「画像差し替え式」**である点が全体設計を貫く前提。

進行中の方針: このリポジトリを下敷きに「口パク」を廃し「**音楽に反応して踊る／演出する**」アバターへ改造する計画がある。設計議論は `handover-notes.md` に集約。トーク版の `AnalyserNode` 配線（音量解析）を流用し、出力先を「口の開閉」から「モーション/演出」へ差し替えるのが核。

## コマンド

```bash
npm install
npm run dev        # Vite dev server (127.0.0.1:5173)、talk.html を自動で開く
npm run build      # dist/ を生成（base=/tomari-guruguru/）
npm run preview    # ビルド結果を base=/tomari-guruguru/ で確認（4173）
npm run verify:pages  # dist/ の Pages 成果物を検証（build 後に実行）
```

- dev と build で **base path が異なる**: dev は `/`、build は `/tomari-guruguru/`（GitHub Pages 用）。`preview` は `--base /tomari-guruguru/` を明示しないと壊れる。
- テストランナーは無い。検証は `verify:pages`（dist のHTML/画像の整合）と手動目視。
- マイク入力は `localhost` か HTTPS でのみ動作。Google Fonts は CDN 読み込みのため初回はネット接続が必要。
- 単体テストの仕組みは無いので、変更確認は `npm run dev` でブラウザを開いて目視するのが基本。

## アーキテクチャ

### エントリポイント（マルチページ）
Vite のマルチページ構成。`vite.config.js` の `rollupOptions.input` に3つを登録:
- `index.html` — `talk.html` へリダイレクトするだけ
- `talk.html` — トーク版（`src/talk-app.jsx`）
- `guruguru.html` — ぐるぐる版（`src/app.jsx`）

各 HTML は `src/tweaks-panel.jsx` を**先に**、続いて各アプリ JSX を `<script type="module">` で読む。この読み込み順が重要（下記）。

### 画像フレームの仕組み（最重要）
- 向き = **5列×5行の25方向**。`r{0-4}c{0-4}`（row=上下: 0上→4下、col=左右: 0左→4右）。
- 表情 = **A〜F の6状態**（目開け/閉じ × 口とじ/中間/開け）。
- 画像パス例: `slices2/A/r2c2.webp`（正面・水平・目開け口とじ）。実体は `public/slices2/`。
- **`src/character-config.js` が画像参照の唯一の真実源**。`basePath`・`ext`・グリッド寸法・シート名（A〜F）を集約。キャラ差し替え時はここを書き換えるだけ。`charConfig.src(sheet, r, c)` がパスを生成する。
- レンダリングは「全フレームを `<img>` で重ねて配置し、アクティブな1枚だけ `opacity:1`、他は `0`」方式。`talk-app.jsx` は6シート×25=150枚を全て描画して切り替える。
- **設計判断: スプライトシート（1枚に複数フレームを敷き詰め、CSS `background-position` / Canvas `drawImage` で1セルだけ表示）方式は当面採用しない**。キャラ素材を GPT Image 2 で生成しており、出力ごとに行・列の間隔が揃わず同一行でも数pxずれるため、固定グリッド前提のピボット合わせが破綻する。`tools/slice_character_sheets.py` の component mode はこのズレを吸収する用途なので、「個別フレームへ分割 → `<img>` で重ねる」現行方式を維持する。スプライトシート化を再検討するなら「踊る/演出版」でフレーム要件が固まってから（その際もシートは 4500×4500 のような巨大寸法を避け、GPU上限の実質下限 4096 未満＝2500×2500/500pxセル程度で十分。POTにする必要は無い）。

### 状態の更新ループ
両アプリとも `requestAnimationFrame` ループで:
- マウス座標 → 正規化(-1..1) → スムージング(`smoothing`) → 25グリッドの行/列に量子化 → `setCell`。
- まばたきは独立した `setTimeout` スケジューラ（不規則間隔・二度瞬き・ゆっくり瞬きの確率分岐）。
- トーク版は加えて `AnalyserNode` の RMS 音量 → エンベロープ追従（attack 速い/release 可変）→ しきい値2段（`thHalf`/`thFull`）で口の段階(0/1/2)を決定。`makeAudioEngine()` がマイクと音声ファイル両対応の音声エンジン。

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
