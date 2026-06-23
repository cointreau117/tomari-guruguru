import React from 'react';
import ReactDOM from 'react-dom/client';
import charConfig from './character-config';

const { useState, useEffect, useRef, useMemo } = React;

const DEFAULTS = /*EDITMODE-BEGIN*/{
  "followRange": 340,
  "smoothing": 0.3,
  "charSize": 64,
  "bgColor": "#FFF8EE",
  "micGain": 1.6,
  "release": 0.12,
  "autoBlink": true,
  "beatSensitivity": 0.6,
  "bounce": 30,
  "accentFreq": 0.8,
  "accentGain": 2.2,
  "smileWhenDancing": true,
  "smileBreakFreq": 0.4,
  "particles": true,
  "showDebug": false
}/*EDITMODE-END*/;

const { rows: ROWS, cols: COLS } = charConfig;
// 目開け（口とじ）= A, 目閉じ（口とじ）= D の2シートのみ使用。
const SHEET_OPEN = charConfig.sheets.eyesOpen.close;    // A
const SHEET_BLINK = charConfig.sheets.eyesClosed.close; // D
const SHEET_SMILE = charConfig.sheets.eyesOpen.half;    // B（笑顔・目を閉じた素材。踊り中に使用）
const SRC = (sheet, r, c) => charConfig.src(sheet, r, c);
const BG_OPTIONS = ['#FFF8EE', '#F4EFFD', '#EEFBF3', '#2B2926'];
const NOTES = ['♪', '♫', '♬', '♩'];
const DANCE_WARMUP_MS = 2000; // 踊り出してから笑顔になるまでの間（最初は通常顔で踊る）

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

// ---- 音声エンジン（曲再生の音量・帯域を解析。出力先はモーション/演出） ----
function makeAudioEngine() {
  const st = {
    ctx: null, micAnalyser: null, micStream: null,
    fileAnalyser: null, fileSourceMade: false, buf: null, freqBuf: null
  };
  function ctx() {
    if (!st.ctx) st.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return st.ctx;
  }
  function active() { return st.fileAnalyser || st.micAnalyser; }
  function levelOf(analyser) {
    if (!analyser) return 0;
    if (!st.buf || st.buf.length !== analyser.fftSize) st.buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(st.buf);
    let sum = 0;
    for (let i = 0; i < st.buf.length; i++) sum += st.buf[i] * st.buf[i];
    return Math.sqrt(sum / st.buf.length);
  }
  // 指定ビン範囲の平均エネルギー（0..1）。fftSize=1024・~44-48kHz 想定でビン幅 ≈ 約46Hz。
  function bandEnergy(fromBin, toBin) {
    const an = active();
    if (!an) return 0;
    const bins = an.frequencyBinCount;
    if (!st.freqBuf || st.freqBuf.length !== bins) st.freqBuf = new Uint8Array(bins);
    an.getByteFrequencyData(st.freqBuf);
    let sum = 0, n = 0;
    for (let i = fromBin; i <= toBin && i < bins; i++) { sum += st.freqBuf[i]; n++; }
    return n ? (sum / n) / 255 : 0;
  }
  return {
    attachAudioEl(el) {
      if (st.fileSourceMade) return;
      const c = ctx();
      const src = c.createMediaElementSource(el);
      const an = c.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.2; // 既定0.8だとキックの瞬発が潰れるため下げる
      src.connect(an);
      an.connect(c.destination);
      st.fileAnalyser = an;
      st.fileSourceMade = true;
    },
    resume() { if (st.ctx) st.ctx.resume(); },
    level() { return levelOf(active()); },
    // low: ベース/キック帯（~47-235Hz）, high: 高域（~1.9-5.6kHz）
    bands() { return { low: bandEnergy(1, 5), high: bandEnergy(40, 120) }; }
  };
}

function App() {
  const [t, setTweak] = useTweaks(DEFAULTS);
  const [cell, setCell] = useState({ r: 2, c: 2 });
  const [blink, setBlink] = useState(false);
  const [fileName, setFileName] = useState('');
  const [playing, setPlaying] = useState(false);
  const [particles, setParticles] = useState([]);
  const [dancing, setDancing] = useState(false);     // 踊り中（拍検出中）= 笑顔の起点
  const [smileBreak, setSmileBreak] = useState(false); // 踊り中に一瞬だけ通常顔へ戻す

  const charRef = useRef(null);
  const audioElRef = useRef(null);
  const meterRef = useRef(null);
  const engine = useMemo(() => makeAudioEngine(), []);
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });
  const env = useRef(0);            // 音量エンベロープ
  const pressedRef = useRef(false); // 押下状態（transform はrAFで駆動）
  const pressScale = useRef(1);
  const lowMean = useRef(0);        // 低域エネルギーの平均（適応しきい値の基準）
  const lowVar = useRef(0);         // 低域エネルギーの分散
  const lastBeat = useRef(0);
  const lastStrength = useRef(1);   // 直近検出拍の強さ（クロック発火時の高さに使う）
  const clockPeriod = useRef(500);  // ms: テンポ位相クロックの周期（推定拍間隔）
  const clockPhase = useRef(0);     // ms: クロックの位相（0..clockPeriod）
  const lastAccent = useRef(0);     // ms: 直近のアクセント大ジャンプ時刻（連発防止）
  const hopY = useRef(0);           // px: 現在の縦オフセット（正=上）
  const hopV = useRef(0);           // px/s: 縦速度
  const hopG = useRef(0);           // px/s^2: 重力（拍ごとに高さ/間隔から逆算）
  const lastNow = useRef(0);        // 前フレーム時刻（dt算出用）
  const pid = useRef(0);
  const tweaksRef = useRef(t);
  tweaksRef.current = t;
  const playingRef = useRef(false); // クロックを回す条件（再生中のみ）。rAFからの参照用
  playingRef.current = playing;
  const dancingRef = useRef(false); // 「踊り中（笑顔）」state の前回値（変化時のみ setState する用）
  const clockActiveRef = useRef(false); // 拍検出中（踊り出し）の前回値。ウォームアップ計測用
  const danceStartAt = useRef(0);   // ms: 今回の踊り出し時刻（ウォームアップ起点）

  function spawnParticles() {
    if (!tweaksRef.current.particles) return;
    const n = 1 + Math.floor(Math.random() * 2); // 1〜2個
    // 色相を「オレンジ→赤→紫→青→緑」の経路（長い側・270°アーク）でテンポに連動させる。
    // 速い拍(周期小)＝オレンジ寄り、遅い拍(周期大)＝緑寄り。各粒に±ジッタでランダム性。
    // 実測の clockPeriod は速め(〜500ms)に寄りがちで、上限800まで届かず寒色が出にくい。
    // そこでマッピングのレンジを上限側に狭め、遅め(〜600ms)で緑に達するようにする。
    const HUE_PMIN = 340, HUE_PMAX = 600;
    const period = clamp(clockPeriod.current, HUE_PMIN, HUE_PMAX);
    const centerHue = 30 - (period - HUE_PMIN) / (HUE_PMAX - HUE_PMIN) * 270; // 340ms→30(橙) … 600ms→120(緑)
    const light = tweaksRef.current.bgColor === '#2B2926' ? 66 : 52; // 背景に応じて視認性を確保
    const add = [];
    for (let i = 0; i < n; i++) {
      const hue = ((centerHue + (Math.random() * 2 - 1) * 30) % 360 + 360) % 360; // ±30 ランダム、0..360へ正規化
      add.push({
        id: pid.current++,
        left: 28 + Math.random() * 44,                 // %
        dx: Math.round((Math.random() * 2 - 1) * 46),  // px 横ドリフト
        dr: Math.round((Math.random() * 2 - 1) * 40),  // deg 回転
        note: NOTES[Math.floor(Math.random() * NOTES.length)],
        color: `hsl(${hue.toFixed(0)}, 80%, ${light}%)`,
        dur: 1000 + Math.round(Math.random() * 600)
      });
    }
    setParticles((p) => [...p, ...add]);
    add.forEach((pt) => setTimeout(() => {
      setParticles((p) => p.filter((x) => x.id !== pt.id));
    }, pt.dur));
  }

  // audio プレーヤーの初期音量（マウント時に一度だけ。以後のユーザー操作は維持）
  useEffect(() => {
    if (audioElRef.current) audioElRef.current.volume = 0.5;
  }, []);

  // マウス追従
  useEffect(() => {
    function onMove(e) {
      const el = charRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height * 0.45;
      const range = tweaksRef.current.followRange;
      target.current.x = clamp((e.clientX - cx) / range, -1, 1);
      target.current.y = clamp((e.clientY - cy) / range, -1, 1);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
    };
  }, []);

  // メインループ: 追従 + 音量/ビート → モーション（バウンド・拍動・揺れ）
  useEffect(() => {
    let raf;
    let last = { r: 2, c: 2 };
    function tick(now) {
      const tw = tweaksRef.current;

      // フレーム経過時間（クロック前進・物理積分で共用）。タブ復帰の大ジャンプは抑制。
      let frameMs = now - lastNow.current;
      lastNow.current = now;
      frameMs = clamp(frameMs, 0, 50);
      const dtSec = frameMs / 1000;

      // --- マウス追従 → 25方向フレーム ---
      current.current.x += (target.current.x - current.current.x) * tw.smoothing;
      current.current.y += (target.current.y - current.current.y) * tw.smoothing;
      const c = clamp(Math.round((current.current.x + 1) / 2 * (COLS - 1)), 0, COLS - 1);
      const r = clamp(Math.round((current.current.y + 1) / 2 * (ROWS - 1)), 0, ROWS - 1);
      if (r !== last.r || c !== last.c) { last = { r, c }; setCell(last); }

      // --- 音量エンベロープ（attack 速い / release 可変） ---
      const raw = engine.level() * tw.micGain;
      if (raw > env.current) env.current += (raw - env.current) * 0.6;
      else env.current += (raw - env.current) * tw.release;
      if (meterRef.current) {
        meterRef.current.style.width = `${clamp(env.current / 0.4, 0, 1) * 100}%`;
      }

      // --- ビート検出（統計ベースの適応しきい値: 平均 + k×標準偏差の外れ値） ---
      // 比率比較だと連続ベースで有効幅が狭く二極端になるため、ばらつき(σ)で自動スケール。
      const low = engine.bands().low;
      if (lowMean.current === 0 && low > 0) lowMean.current = low; // コールドスタート暴発防止
      lowMean.current += (low - lowMean.current) * 0.04;
      const d = low - lowMean.current;
      lowVar.current += (d * d - lowVar.current) * 0.04;
      const std = Math.sqrt(lowVar.current);
      // beatSensitivity(0..1): 高いほど k が小さく拍が増える
      const k = 2.2 - 1.7 * tw.beatSensitivity; // 0.5..2.2
      const thr = lowMean.current + k * std;
      // 検出した拍は「直接跳ねる」のではなく、内部クロックの周期と位相の補正に使う（案2/PLL）。
      if (low > thr && low > lowMean.current * 1.06 && low > 0.04 && now - lastBeat.current > 180) {
        const dt = now - lastBeat.current;
        lastBeat.current = now;
        // d/σ = 平均から何σ上か。音量を変えても不変（再生音量に非依存）。
        const sigmaAbove = d / (std + 1e-4);
        lastStrength.current = clamp(0.7 + sigmaAbove * 0.25, 0.6, 1.4);
        // テンポ(周期)推定: おおよそ1拍ぶんの間隔だけ採用（倍/半テンポの取り違えを避ける）
        if (dt > clockPeriod.current * 0.6 && dt < clockPeriod.current * 1.5) {
          clockPeriod.current = clamp(clockPeriod.current + (dt - clockPeriod.current) * 0.15, 300, 800);
        }
        // 位相補正(PLL): 検出拍がクロックの拍境界に合うよう位相を少しずつ寄せる。
        const P = clockPeriod.current;
        let err = clockPhase.current;     // 直近の拍境界からの経過
        if (err > P / 2) err -= P;        // [-P/2, P/2] に折り返す＝符号付き位相誤差
        clockPhase.current -= 0.1 * err;  // 誤差の一部だけ補正（急がず同期）

        // 強拍アクセント: 飛び抜けて強い拍のとき、クロックとは別に「大ジャンプ」を即興で差し込む。
        // 定常リズムは保ったまま抑揚を足す。頻度スライダーでしきい値σと連発間隔を可変
        // （最小では非常に高いσ＝発火しづらく、ほぼOFF相当になる）。
        const accentSigma = 4.5 - 2.3 * tw.accentFreq; // freq0→4.5σ(ほぼOFF) … freq1→2.2σ
        const accentGap = 1800 - 900 * tw.accentFreq;  // ms: 連発防止間隔
        if (playingRef.current && sigmaAbove > accentSigma && now - lastAccent.current > accentGap) {
          lastAccent.current = now;
          const Ta = clamp(clockPeriod.current * 1.1, 260, 700) / 1000; // やや長め＝ふわっと高く
          const aStrength = clamp(tw.accentGain + (sigmaAbove - accentSigma) * 0.4, tw.accentGain, tw.accentGain + 1.2);
          const Ha = aStrength * tw.bounce;
          const va = 4 * Ha / Ta;
          // 上昇中でも、今より大きい初速なら上書きして“ポップ”させる（アクセントは稀なので暴走しない）。
          if (va > hopV.current) { hopV.current = va; hopG.current = 8 * Ha / (Ta * Ta); }
          spawnParticles();
        }
      }

      // --- テンポ位相クロック: 検出に同期しつつ惰性で回り、拍ごとにバウンド＋演出を発火 ---
      // 直近に拍を検出している間（再生中）だけ回す。検出が一時的に抜けても惰性で拍を打ち続ける。
      const clockActive = playingRef.current && (now - lastBeat.current < 2000);
      // 踊り出し(clockActive)の立ち上がりでウォームアップ計測を開始。
      if (clockActive && !clockActiveRef.current) danceStartAt.current = now;
      clockActiveRef.current = clockActive;
      // 笑顔は踊り出しから DANCE_WARMUP_MS 経過後に解禁（踊り始めて少し経って楽しくなる感じ）。
      // 表情切替に再描画が要るので、変化時のみ setState（setCell と同方針）。
      const danceSmile = clockActive && (now - danceStartAt.current > DANCE_WARMUP_MS);
      if (danceSmile !== dancingRef.current) { dancingRef.current = danceSmile; setDancing(danceSmile); }
      if (clockActive) {
        clockPhase.current += frameMs;
        if (clockPhase.current >= clockPeriod.current) {
          clockPhase.current -= clockPeriod.current;
          // クロックの拍でバウンド発火。滞空時間は周期に追従、高さは直近検出の強さ。
          const T = clamp(clockPeriod.current * 0.9, 220, 650) / 1000; // 滞空秒
          const H = lastStrength.current * tw.bounce; // 頂点高(px)
          // 上昇中(hopV>0)は再インパルスを無視（際限なく上がり続けるのを防ぐ）。
          if (hopV.current <= 0) {
            hopV.current = 4 * H / T;
            hopG.current = 8 * H / (T * T);
          }
          spawnParticles();
        }
      } else {
        clockPhase.current = 0; // 停止中は位相をリセット
      }

      // --- モーション: 重力積分バウンド（位置・速度を連続更新）＋押下スケール ---
      const dt = dtSec;
      hopV.current -= hopG.current * dt;
      hopY.current += hopV.current * dt;
      if (hopY.current <= 0) { hopY.current = 0; if (hopV.current < 0) hopV.current = 0; } // 着地で停止
      const pressTarget = pressedRef.current ? 0.94 : 1;
      pressScale.current += (pressTarget - pressScale.current) * 0.25;
      const jump = hopY.current;
      const el = charRef.current;
      if (el) {
        el.style.transform = `translateY(${(-jump).toFixed(2)}px) scale(${pressScale.current.toFixed(4)})`;
      }

      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  // 自動まばたき（自然なゆらぎ: 不規則な間隔 + 二度瞬き + ゆっくり瞬き）
  useEffect(() => {
    if (!t.autoBlink) { setBlink(false); return; }
    let alive = true;
    let timer;
    const rand = (a, b) => a + Math.random() * (b - a);
    function blinkOnce(dur, after) {
      setBlink(true);
      timer = setTimeout(() => {
        if (!alive) return;
        setBlink(false);
        timer = setTimeout(after, rand(120, 220));
      }, dur);
    }
    function doBlink() {
      if (!alive) return;
      const roll = Math.random();
      if (roll < 0.22) {
        blinkOnce(rand(80, 120), () => { if (alive) blinkOnce(rand(70, 110), schedule); });
      } else if (roll < 0.28) {
        blinkOnce(rand(260, 420), schedule);
      } else {
        blinkOnce(rand(90, 150), schedule);
      }
    }
    function schedule() {
      if (!alive) return;
      const u = Math.random();
      let wait;
      if (u < 0.12) wait = rand(700, 1500);
      else if (u < 0.82) wait = rand(1800, 4500);
      else wait = rand(4500, 9000);
      timer = setTimeout(doBlink, wait);
    }
    schedule();
    return () => { alive = false; clearTimeout(timer); };
  }, [t.autoBlink]);

  // 笑顔ほどけ: 踊り中、不規則な間隔で一瞬だけ通常顔へ戻す（常時笑顔の単調さ回避）。
  // まばたきスケジューラと同型。頻度スライダーで間隔を可変（最小でほぼ常時笑顔）。
  useEffect(() => {
    if (!dancing || !t.smileWhenDancing) { setSmileBreak(false); return; }
    let alive = true;
    let timer;
    const rand = (a, b) => a + Math.random() * (b - a);
    function schedule() {
      const f = tweaksRef.current.smileBreakFreq;  // スライダーは次回スケジュールから反映
      const base = 9000 - 7000 * f;                // freq0≈9s(ほぼ常時笑顔) … freq1≈2s
      timer = setTimeout(() => {
        if (!alive) return;
        setSmileBreak(true);
        // 通常顔は 1〜1.8 秒キープ（短スパンの笑顔⇔通常の切替を防ぐ）。
        timer = setTimeout(() => { if (!alive) return; setSmileBreak(false); schedule(); }, rand(1000, 1800));
      }, rand(base, base * 1.8));
    }
    schedule();
    return () => { alive = false; clearTimeout(timer); };
  }, [dancing, t.smileWhenDancing]);

  function onFilePick(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const el = audioElRef.current;
    engine.attachAudioEl(el);
    engine.resume();
    el.src = URL.createObjectURL(f);
    el.play().catch(() => {});
    setFileName(f.name);
  }

  // 描画フレーム: A（目開け）/ D（目閉じ）/ B（笑顔）の3シート×25=75枚
  const allFrames = useMemo(() => {
    const arr = [];
    for (const s of [SHEET_OPEN, SHEET_BLINK, SHEET_SMILE]) {
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) arr.push({ s, r, c });
    }
    return arr;
  }, []);
  const gridCells = useMemo(() => {
    const arr = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) arr.push({ r, c });
    return arr;
  }, []);
  // 踊り中（拍検出中）かつほどけ中でなければ笑顔(B)。笑顔表示中は blink を無視＝まばたき抑止。
  const activeSheet = (dancing && t.smileWhenDancing && !smileBreak)
    ? SHEET_SMILE
    : (blink ? SHEET_BLINK : SHEET_OPEN);

  const dark = t.bgColor === '#2B2926';
  const inkColor = dark ? 'rgba(255,248,238,0.85)' : 'rgba(60,48,38,0.8)';
  const subColor = dark ? 'rgba(255,248,238,0.45)' : 'rgba(60,48,38,0.45)';
  const panelBg = dark ? 'rgba(48,45,42,0.92)' : 'rgba(255,255,255,0.88)';
  const lineColor = dark ? 'rgba(255,248,238,0.14)' : 'rgba(60,48,38,0.12)';

  const sizeVmin = t.charSize * 4 / 3;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: t.bgColor,
      overflow: 'hidden', transition: 'background 0.4s ease',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'crosshair', fontFamily: "'Zen Maru Gothic', sans-serif"
    }}>
      <div ref={charRef} className={playing ? '' : 'bob'}
        onPointerDown={() => { pressedRef.current = true; }}
        onPointerUp={() => { pressedRef.current = false; }}
        onPointerLeave={() => { pressedRef.current = false; }}
        style={{
          position: 'relative',
          width: `${sizeVmin}vmin`, height: `${sizeVmin}vmin`,
          maxWidth: 1200, maxHeight: 1200,
          userSelect: 'none', touchAction: 'none', willChange: 'transform'
        }}>
        {allFrames.map(({ s, r, c }) => (
          <img key={`${s}${r}${c}`} src={SRC(s, r, c)} alt="" draggable="false" style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            opacity: s === activeSheet && r === cell.r && c === cell.c ? 1 : 0,
            pointerEvents: 'none'
          }}></img>
        ))}
        {particles.map((p) => (
          <span key={p.id} style={{
            position: 'absolute', left: `${p.left}%`, top: '28%',
            fontSize: 'clamp(40px, 6.4vmin, 76px)', color: p.color,
            pointerEvents: 'none', willChange: 'transform, opacity',
            animation: `floatUp ${p.dur}ms ease-out forwards`,
            '--dx': `${p.dx}px`, '--dr': `${p.dr}deg`
          }}>{p.note}</span>
        ))}
      </div>

      <div style={{ position: 'absolute', top: '3.5vh', left: 0, right: 0, textAlign: 'center', pointerEvents: 'none' }}>
        <div style={{ fontSize: 'clamp(18px, 2.4vmin, 26px)', fontWeight: 700, color: inkColor, letterSpacing: '0.18em' }}>ぐるぐるDancin'なぎさん</div>
        <div style={{ fontSize: 'clamp(12px, 1.6vmin, 16px)', color: subColor, marginTop: 4, letterSpacing: '0.08em' }}>音楽を読み込むと リズムに乗って踊るよ</div>
      </div>

      <div style={{
        position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 14,
        background: panelBg, backdropFilter: 'blur(10px)',
        border: `1px solid ${lineColor}`, borderRadius: 18,
        padding: '12px 18px', cursor: 'default',
        boxShadow: '0 6px 24px rgba(60,48,38,0.10)'
      }}>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontWeight: 700, fontSize: 14, color: inkColor,
          border: `1.5px solid ${lineColor}`, borderRadius: 12,
          padding: '9px 16px', cursor: 'pointer', minHeight: 44, boxSizing: 'border-box'
        }}>
          ♪ 音楽ファイルを読み込む
          <input type="file" accept="audio/*" onChange={onFilePick} style={{ display: 'none' }}></input>
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 150 }}>
          <div style={{ fontSize: 11, color: subColor, letterSpacing: '0.06em' }}>音量</div>
          <div style={{ position: 'relative', height: 10, borderRadius: 5, background: lineColor, overflow: 'hidden' }}>
            <div ref={meterRef} style={{
              position: 'absolute', left: 0, top: 0, bottom: 0, width: '0%',
              borderRadius: 5, background: 'linear-gradient(90deg, #8FBC8F, #E8B04B, #D96C4F)'
            }}></div>
          </div>
        </div>
      </div>
      <audio ref={audioElRef} controls
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        style={{
          position: 'absolute', bottom: 20, left: 20, width: 300,
          display: fileName ? 'block' : 'none', cursor: 'default'
        }}></audio>

      {t.showDebug ? (
        <div style={{
          position: 'absolute', top: 16, left: 16,
          background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 10,
          padding: '10px 12px', fontSize: 12, fontFamily: 'ui-monospace, monospace',
          pointerEvents: 'none', lineHeight: 1.5
        }}>
          <div>row {cell.r} / col {cell.c}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 14px)', gap: 3, marginTop: 6 }}>
            {gridCells.map(({ r, c }) => (
              <div key={`d${r}-${c}`} style={{
                width: 14, height: 14, borderRadius: 3,
                background: r === cell.r && c === cell.c ? '#FFB13D' : 'rgba(255,255,255,0.22)'
              }}></div>
            ))}
          </div>
        </div>
      ) : null}

      <TweaksPanel>
        <TweakSection label="演出（音楽反応）"></TweakSection>
        <TweakSlider label="ビート感度（高いほど反応）" value={t.beatSensitivity} min={0} max={1} step={0.05}
          onChange={(v) => setTweak('beatSensitivity', v)}></TweakSlider>
        <TweakSlider label="跳ねる強さ" value={t.bounce} min={0} max={80} step={1} unit="px"
          onChange={(v) => setTweak('bounce', v)}></TweakSlider>
        <TweakSlider label="強拍アクセントの頻度" value={t.accentFreq} min={0} max={1} step={0.05}
          onChange={(v) => setTweak('accentFreq', v)}></TweakSlider>
        <TweakSlider label="強拍アクセントの大きさ" value={t.accentGain} min={1.2} max={3.5} step={0.1}
          onChange={(v) => setTweak('accentGain', v)}></TweakSlider>
        <TweakToggle label="踊り中に笑顔" value={t.smileWhenDancing}
          onChange={(v) => setTweak('smileWhenDancing', v)}></TweakToggle>
        <TweakSlider label="通常顔に戻る頻度（高いほど頻繁）" value={t.smileBreakFreq} min={0} max={1} step={0.05}
          onChange={(v) => setTweak('smileBreakFreq', v)}></TweakSlider>
        <TweakToggle label="音符パーティクル" value={t.particles}
          onChange={(v) => setTweak('particles', v)}></TweakToggle>
        <TweakSection label="音声"></TweakSection>
        <TweakSlider label="音量感度" value={t.micGain} min={0.3} max={5} step={0.1}
          onChange={(v) => setTweak('micGain', v)}></TweakSlider>
        <TweakSlider label="音量追従の戻り速さ" value={t.release} min={0.03} max={0.4} step={0.01}
          onChange={(v) => setTweak('release', v)}></TweakSlider>
        <TweakSection label="動き"></TweakSection>
        <TweakSlider label="追従範囲" value={t.followRange} min={120} max={1200} step={10} unit="px"
          onChange={(v) => setTweak('followRange', v)}></TweakSlider>
        <TweakSlider label="追従速度" value={t.smoothing} min={0.04} max={0.5} step={0.01}
          onChange={(v) => setTweak('smoothing', v)}></TweakSlider>
        <TweakToggle label="自動まばたき" value={t.autoBlink}
          onChange={(v) => setTweak('autoBlink', v)}></TweakToggle>
        <TweakSection label="見た目"></TweakSection>
        <TweakSlider label="キャラサイズ" value={t.charSize} min={30} max={92} unit="vmin"
          onChange={(v) => setTweak('charSize', v)}></TweakSlider>
        <TweakColor label="背景色" value={t.bgColor} options={BG_OPTIONS}
          onChange={(v) => setTweak('bgColor', v)}></TweakColor>
        <TweakSection label="デバッグ"></TweakSection>
        <TweakToggle label="グリッド表示" value={t.showDebug}
          onChange={(v) => setTweak('showDebug', v)}></TweakToggle>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
