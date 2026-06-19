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
  "particles": true,
  "showDebug": false
}/*EDITMODE-END*/;

const { rows: ROWS, cols: COLS } = charConfig;
// 目開け（口とじ）= A, 目閉じ（口とじ）= D の2シートのみ使用。
const SHEET_OPEN = charConfig.sheets.eyesOpen.close;    // A
const SHEET_BLINK = charConfig.sheets.eyesClosed.close; // D
const SRC = (sheet, r, c) => charConfig.src(sheet, r, c);
const BG_OPTIONS = ['#FFF8EE', '#FDEFEF', '#EEF4FB', '#2B2926'];
const NOTES = ['♪', '♫', '♬', '♩'];

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
  const beatInterval = useRef(500); // ms: 推定ビート間隔（テンポ追従用）
  const hopStart = useRef(-1e9);    // 放物線ホップの開始時刻
  const hopDur = useRef(380);       // ms: ホップ1回の長さ
  const hopStrength = useRef(1);    // ホップの高さ係数（音の強さ）
  const pid = useRef(0);
  const tweaksRef = useRef(t);
  tweaksRef.current = t;

  function spawnParticles() {
    if (!tweaksRef.current.particles) return;
    const n = 1 + Math.floor(Math.random() * 2); // 1〜2個
    const add = [];
    for (let i = 0; i < n; i++) {
      add.push({
        id: pid.current++,
        left: 28 + Math.random() * 44,                 // %
        dx: Math.round((Math.random() * 2 - 1) * 46),  // px 横ドリフト
        dr: Math.round((Math.random() * 2 - 1) * 40),  // deg 回転
        note: NOTES[Math.floor(Math.random() * NOTES.length)],
        dur: 1000 + Math.round(Math.random() * 600)
      });
    }
    setParticles((p) => [...p, ...add]);
    add.forEach((pt) => setTimeout(() => {
      setParticles((p) => p.filter((x) => x.id !== pt.id));
    }, pt.dur));
  }

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
      if (low > thr && low > lowMean.current * 1.06 && low > 0.04 && now - lastBeat.current > 180) {
        const dt = now - lastBeat.current;
        if (dt > 150 && dt < 1500) beatInterval.current += (dt - beatInterval.current) * 0.3; // BPM推定
        lastBeat.current = now;
        // 放物線ホップ開始。長さはビート間隔に追従（テンポに合わせてゆったり〜素早く）
        hopStart.current = now;
        hopDur.current = clamp(beatInterval.current * 0.9, 220, 650);
        // d/σ = 平均から何σ上か。音量を変えても不変なので、跳ねる高さが音量に依存しない
        hopStrength.current = clamp(0.7 + (d / (std + 1e-4)) * 0.25, 0.6, 1.4);
        spawnParticles();
      }

      // --- モーション: 放物線バウンド 4p(1-p)（translateY）＋押下スケール ---
      const pressTarget = pressedRef.current ? 0.94 : 1;
      pressScale.current += (pressTarget - pressScale.current) * 0.25;
      const p = (now - hopStart.current) / hopDur.current;
      const arc = (p >= 0 && p <= 1) ? 4 * p * (1 - p) : 0; // 0→1→0 の弧（頂点 p=0.5）
      const jump = arc * hopStrength.current * tw.bounce;
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

  // 描画フレーム: A（目開け）と D（目閉じ）の2シート×25=50枚のみ
  const allFrames = useMemo(() => {
    const arr = [];
    for (const s of [SHEET_OPEN, SHEET_BLINK]) {
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) arr.push({ s, r, c });
    }
    return arr;
  }, []);
  const gridCells = useMemo(() => {
    const arr = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) arr.push({ r, c });
    return arr;
  }, []);
  const activeSheet = blink ? SHEET_BLINK : SHEET_OPEN;

  const dark = t.bgColor === '#2B2926';
  const inkColor = dark ? 'rgba(255,248,238,0.85)' : 'rgba(60,48,38,0.8)';
  const subColor = dark ? 'rgba(255,248,238,0.45)' : 'rgba(60,48,38,0.45)';
  const panelBg = dark ? 'rgba(48,45,42,0.92)' : 'rgba(255,255,255,0.88)';
  const lineColor = dark ? 'rgba(255,248,238,0.14)' : 'rgba(60,48,38,0.12)';
  const noteColor = dark ? '#FFD9A0' : '#D96C4F';

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
            fontSize: 'clamp(20px, 3.2vmin, 38px)', color: noteColor,
            pointerEvents: 'none', willChange: 'transform, opacity',
            animation: `floatUp ${p.dur}ms ease-out forwards`,
            '--dx': `${p.dx}px`, '--dr': `${p.dr}deg`
          }}>{p.note}</span>
        ))}
      </div>

      <div style={{ position: 'absolute', top: '3.5vh', left: 0, right: 0, textAlign: 'center', pointerEvents: 'none' }}>
        <div style={{ fontSize: 'clamp(18px, 2.4vmin, 26px)', fontWeight: 700, color: inkColor, letterSpacing: '0.18em' }}>トマリ</div>
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
