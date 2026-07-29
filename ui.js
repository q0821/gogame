import { EMPTY, BLACK, WHITE, getGroup } from './rules.js';
import { drawStonePixel } from './stone.js';
import { paintBoardBase, paintWoodGrain, paintVignette } from './board-texture.js';
import { prefersReducedMotion } from './motion.js';
import { hidpiScale, setupHiDPICanvas, makeHiDPIOffscreen } from './canvas-dpr.js';

// ——— Liberty map for emotion mode ———
function computeLibertyMap(board, size) {
  const map = Array.from({ length: size }, () => new Array(size).fill(0));
  const visited = new Set();
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (board[x][y] === EMPTY) continue;
      const key = x * size + y;
      if (visited.has(key)) continue;
      const { stones, liberties } = getGroup(board, size, x, y);
      const count = liberties.size;
      for (const [sx, sy] of stones) {
        map[sx][sy] = count;
        visited.add(sx * size + sy);
      }
    }
  }
  return map;
}

// Offscreen canvas cache for static board background (wood texture + grid + stars + labels)
let _bgCache = null;
let _bgCacheKey = '';

// ——— Dirty-rect / resize optimisation ———
// We track whether the canvas *layout* (size or board dimensions) has changed
// since the last draw.  resizeCanvas is only called when needed instead of on
// every draw tick.
let _lastCanvasKey = '';

// ——— 落子 scale-in / 提子淡出動畫 ———
// 事件觸發才跑：偵測到 state.lastMove 變動（新落子）或棋子從盤面消失（被提）時各自
// 起一段短動畫，rAF 只在動畫進行中才被排程（透過 deps.scheduleRedraw 借用呼叫端既有的
// 重繪節流），動畫結束即不再排程，靜止時無常駐 loop。prefers-reduced-motion 時完全跳過，
// 直接呈現終態（不畫任何過場）。
const PLACE_ANIM_MS = 150;
const CAPTURE_FADE_MS = 220;
let _placeAnimKey = null;   // `${x},${y}` 最近一次觸發動畫的 lastMove（避免同一手重複觸發）
let _placeAnimStart = 0;
let _placeAnimRunning = false;
let _prevBoardFlat = null;  // 上次繪製時的盤面快照（扁平陣列），用來偵測被提走的子
let _captureFade = null;    // { stones: [{x,y,color}], start }
const _easeOutBack = (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

function _layoutKey(deps, state) {
  return `${window.innerWidth}_${window.innerHeight}_${state.size}_${hidpiScale()}`;
}

// 從 canvas 自身推導 CSS 尺寸與 dpr（attr = css × dpr，見 resizeCanvas）。
// 不能依賴 deps.dpr：main.js 每次 drawBoard 都重建 deps 物件，只回存 cellSize/padding，
// 掛在 deps 上的值第二幀就消失——曾造成「第二幀起 transform 退回 1x、盤面縮到左上角」。
function canvasCssMetrics(canvas) {
  const cssW = parseFloat(canvas.style.width) || canvas.width;
  return { cssW, dpr: cssW > 0 ? canvas.width / cssW : 1 };
}

function renderBoardBackground(deps, state) {
  // 全程以 CSS 像素座標作畫；offscreen 內部為 HiDPI 解析度（ctx 已預先 scale）。
  const { cssW: w, dpr } = canvasCssMetrics(deps.canvas);
  const cacheKey = `${w}_${dpr}_${state.size}`;
  if (_bgCache && _bgCacheKey === cacheKey) return _bgCache;

  const { off: offscreen, ctx } = makeHiDPIOffscreen(w, w);

  paintBoardBase(ctx, w, w);
  // 低對比 procedural 木紋（纖維弧線＋木孔斑），一次畫進快取，不每 frame 重算
  paintWoodGrain(ctx, w, w, { seed: 5, grainColor: 'rgba(90,64,24,0.12)', speckColor: 'rgba(255,244,214,0.10)' });

  ctx.strokeStyle = '#5a4420';
  ctx.lineWidth = 1;
  for (let i = 0; i < state.size; i++) {
    const pos = deps.padding + i * deps.cellSize;
    ctx.beginPath();
    ctx.moveTo(deps.padding, pos);
    ctx.lineTo(deps.padding + (state.size - 1) * deps.cellSize, pos);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pos, deps.padding);
    ctx.lineTo(pos, deps.padding + (state.size - 1) * deps.cellSize);
    ctx.stroke();
  }

  const stars = deps.starPoints[state.size] || [];
  for (const [x, y] of stars) {
    ctx.fillStyle = '#5a4420';
    ctx.beginPath();
    ctx.arc(deps.padding + y * deps.cellSize, deps.padding + x * deps.cellSize, deps.cellSize * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#3a2010';
  ctx.font = `bold ${Math.max(9, Math.min(deps.cellSize * 0.35, deps.padding * 0.4))}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const letters = 'ABCDEFGHJKLMNOPQRST';
  const labelOffset = deps.padding * 0.5;
  for (let i = 0; i < state.size; i++) {
    const pos = deps.padding + i * deps.cellSize;
    ctx.fillText(letters[i], pos, labelOffset);
    ctx.fillText(letters[i], pos, deps.padding + (state.size - 1) * deps.cellSize + labelOffset);
    ctx.fillText(state.size - i, labelOffset, pos);
    ctx.fillText(state.size - i, deps.padding + (state.size - 1) * deps.cellSize + labelOffset, pos);
  }

  // 外圍柔和 vignette（角落微暗，桌面實木棋盤的立體感）
  paintVignette(ctx, w, w);

  _bgCache = offscreen;
  _bgCacheKey = cacheKey;
  return offscreen;
}

// ——— 共用棋盤 toast（五子棋/黑白棋等沒有專屬 #goToast 元素的畫面用）———
// 動態建立一個 .board-toast 節點掛在傳入的 container（需 position:relative，
// 各棋種 .board-wrap 已符合），樣式全部 inline（不依賴 style.css），與圍棋既有
// #goToast 視覺一致，避免另外改 index.html/style.css。
const _boardToastTimers = new WeakMap();
export function showBoardToast(container, msg) {
  if (!container) return;
  let el = container.querySelector(':scope > .board-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'board-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'assertive');
    container.appendChild(el);
  }
  el.textContent = msg;
  Object.assign(el.style, {
    display: 'block',
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    padding: '14px 26px',
    background: 'rgba(178, 58, 46, 0.95)',
    color: '#fff',
    fontSize: '18px',
    fontWeight: '700',
    letterSpacing: '1px',
    borderRadius: '12px',
    boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
    zIndex: '70',
    pointerEvents: 'none',
    // .board-wrap 有 line-height:0（消 canvas 間隙），不覆寫會讓換行文字兩行相疊；
    // width:max-content 修正絕對定位＋left:50% 的「可用寬度剩一半」換行問題。
    lineHeight: '1.5',
    width: 'max-content',
    maxWidth: '88vw',
    textAlign: 'center',
  });
  const prevTimer = _boardToastTimers.get(container);
  if (prevTimer) clearTimeout(prevTimer);
  const t = setTimeout(() => { el.style.display = 'none'; }, 1800);
  _boardToastTimers.set(container, t);
}

// 徽章直接反映 state.isAIThinking，不做任何 normalization。
// 舊實作是 `!!state.isAIThinking && state.currentPlayer !== BLACK`，等於硬編碼
// 「AI 一定執白」：人類執白時 AI 執黑，AI 思考中的 currentPlayer 是 BLACK，條件變 false，
// 徽章顯示「黑方」；而同一畫面的狀態列走 getStatusMessage()，讀的是未 normalize 的
// isAIThinking，老實顯示「AI 思考中...」——同一時刻兩處互相矛盾。
// PvP 從不寫入 isAIThinking（只有 ai-controller 與 loadGame 會動它），故毋需額外的模式判斷。
export function updateHUD(state) {
  const mt = document.getElementById('mobileTurn');
  if (state.gameOver) {
    mt.textContent = '遊戲結束';
    mt.className = 'turn-badge';
  } else if (state.isAIThinking) {
    mt.textContent = 'AI 思考中';
    mt.className = 'turn-badge';
  } else {
    mt.textContent = state.currentPlayer === BLACK ? '黑方' : '白方';
    mt.className = 'turn-badge ' + (state.currentPlayer === BLACK ? 'black' : 'white');
  }

  document.getElementById('mobileBlackCap').textContent = state.captures[BLACK];
  document.getElementById('mobileWhiteCap').textContent = state.captures[WHITE];
  document.getElementById('mobileMoveCount').textContent = state.moveHistory.length;
}

export function setStatus(message) {
  const a = document.getElementById('statusMsg');     // 桌機舊面板（圍棋新版已移除，保留 guard）
  if (a) a.textContent = message;
  const b = document.getElementById('mobileStatus');  // 單欄狀態列
  if (b) b.textContent = message;
}

export function getStatusMessage(state, fallbackMessage = '') {
  if (fallbackMessage) return fallbackMessage;
  if (state.gameOver) return '遊戲結束 — 可覆盤或開始新局';
  if (state.isScoring) return '已自動估算死子，可點擊修正，然後確認結果';
  if (state.isReviewing) return '覆盤模式';
  if (state.isAIThinking) return 'AI 思考中...';
  return `${state.currentPlayer === BLACK ? '黑' : '白'}方回合`;
}

export function syncStatus(state, fallbackMessage = '') {
  setStatus(getStatusMessage(state, fallbackMessage));
}

export function updateReviewInfo(state) {
  const slider = document.getElementById('reviewSlider');
  if (slider) {
    slider.max = state.moveHistory.length;
    slider.value = state.currentReviewMove;
  }
  const info = document.getElementById('reviewInfo');
  if (state.currentReviewMove === 0) {
    info.textContent = '開始位置';
    return;
  }

  const move = state.moveHistory[state.currentReviewMove - 1];
  const letters = 'ABCDEFGHJKLMNOPQRST';
  const moveStr = move.pass ? 'Pass' : `${letters[move.y]}${state.size - move.x}`;
  info.textContent = `第 ${state.currentReviewMove} 手 / ${state.moveHistory.length} - ${move.player === BLACK ? '黑' : '白'} ${moveStr}`;
}

export function updateScoringDisplay(state, score) {
  document.getElementById('blackScore').textContent = score.black.toFixed(1);
  if (state.gameRules === 'japanese') {
    document.getElementById('blackScoreLabel').textContent = '　目+提子';
    document.getElementById('whiteScoreLabel').textContent = '　目+提子（含貼目）';
    document.getElementById('blackDetail').textContent = `目 ${score.blackTerritory} + 提子 ${score.blackStones}`;
    document.getElementById('whiteDetail').textContent = `目 ${score.whiteTerritory} + 提子 ${score.whiteStones} + 貼目 ${state.komi}`;
  } else {
    document.getElementById('blackScoreLabel').textContent = '　棋子+目';
    document.getElementById('whiteScoreLabel').textContent = '　棋子+目（含貼目）';
    document.getElementById('blackDetail').textContent = `${score.blackStones} + ${score.blackTerritory}`;
    document.getElementById('whiteDetail').textContent = `${score.whiteStones} + ${score.whiteTerritory} + ${state.komi}`;
  }

  document.getElementById('whiteScore').textContent = score.white.toFixed(1);
  const diff = score.black - score.white;
  const resultStr = diff > 0
    ? `黑勝 ${diff.toFixed(1)} 目`
    : diff < 0
    ? `白勝 ${Math.abs(diff).toFixed(1)} 目`
    : '和棋';
  document.getElementById('resultText').textContent = resultStr;
  // 手機數目結果列（不開選單也看得到）
  const mobileResult = document.getElementById('mobileScoreResult');
  if (mobileResult) {
    mobileResult.textContent = `黑 ${score.black.toFixed(1)}　白 ${score.white.toFixed(1)}（含貼目）　→　${resultStr}`;
  }
}


export function resizeCanvas(deps, state) {
  // 單欄置中版面（.go-screen max-width 700、左右 padding 16 → 內容約 668）。盤面寬度以此為上限，
  // 避免 canvas 內部解析度大於顯示寬度被 CSS 縮放 → 點擊座標錯位。再以視窗高度約束、留資訊列/功能列空間。
  const isMobile = window.innerWidth <= 900;
  const maxW = Math.min(window.innerWidth - 24, 668);
  const maxH = window.innerHeight - (isMobile ? 200 : 150);
  const maxSize = Math.max(280, Math.min(maxW, maxH));
  const s = state.size - 1;
  const minPadding = Math.ceil((0.88 * maxSize + 16 * s) / (s + 1.76));
  deps.padding = Math.max(30, minPadding);
  const cellSize = Math.floor((maxSize - deps.padding * 2) / s);
  const canvasSize = cellSize * s + deps.padding * 2;
  deps.cssSize = canvasSize;
  deps.dpr = setupHiDPICanvas(deps.canvas, canvasSize, canvasSize);
  return cellSize;
}

export function drawStone(deps, x, y, color, isDead, scale = 1, alpha = 1) {
  // origin 偏移：死活局部裁切時，deps.originRow/originCol 為視窗左上角的盤面座標；
  // 對弈不傳 → 預設 0 → 行為與原本完全相同（x=row 對應垂直、y=col 對應水平）。
  const ox = deps.originRow || 0;
  const oy = deps.originCol || 0;
  const cx = deps.padding + (y - oy) * deps.cellSize;
  const cy = deps.padding + (x - ox) * deps.cellSize;
  const r = deps.cellSize * 0.44;
  const ctx = deps.ctx;

  // 共用棋子視覺（柔邊投影 + 三段暖漸層 + 高光，見 stone.js）；scale≠1 用於落子 scale-in 動畫。
  if (scale !== 1) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(Math.max(0.02, scale), Math.max(0.02, scale));
    ctx.translate(-cx, -cy);
    drawStonePixel(ctx, cx, cy, r, color === BLACK, alpha);
    ctx.restore();
  } else {
    drawStonePixel(ctx, cx, cy, r, color === BLACK, alpha);
  }

  if (isDead) {
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2.5;
    const d = r * 0.5;
    ctx.beginPath();
    ctx.moveTo(cx - d, cy - d);
    ctx.lineTo(cx + d, cy + d);
    ctx.moveTo(cx + d, cy - d);
    ctx.lineTo(cx - d, cy + d);
    ctx.stroke();
  }
}

/**
 * 偵測落子（lastMove 變動）與提子（棋子從盤面消失），起 scale-in / 淡出動畫。
 * 事件觸發才寫入動畫狀態；prefers-reduced-motion 時直接跳過，只更新比對基準。
 */
function _detectBoardChanges(state) {
  const size = state.size;
  const flat = new Array(size * size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) flat[x * size + y] = state.displayBoard[x][y];
  }

  const reduceMotion = prefersReducedMotion();
  const sameSize = _prevBoardFlat && _prevBoardFlat.length === flat.length;

  if (!reduceMotion && sameSize) {
    // 提子：上次有子、這次變空 → 淡出
    const removed = [];
    for (let i = 0; i < flat.length; i++) {
      if (_prevBoardFlat[i] !== EMPTY && flat[i] === EMPTY) {
        removed.push({ x: Math.floor(i / size), y: i % size, color: _prevBoardFlat[i] });
      }
    }
    if (removed.length > 0) _captureFade = { stones: removed, start: performance.now() };
  }

  // 落子：lastMove 座標變動且該點現在有子 → scale-in
  if (state.lastMove) {
    const [lx, ly] = state.lastMove;
    const key = `${lx},${ly}`;
    if (key !== _placeAnimKey) {
      _placeAnimKey = key;
      if (!reduceMotion && state.displayBoard[lx] && state.displayBoard[lx][ly] !== EMPTY) {
        _placeAnimStart = performance.now();
        _placeAnimRunning = true;
      } else {
        _placeAnimRunning = false;
      }
    }
  } else {
    _placeAnimKey = null;
    _placeAnimRunning = false;
  }

  _prevBoardFlat = flat;
}

export function drawBoard(deps, state) {
  // ——— Dirty-rect: only resize when the viewport or board size changed ———
  const layoutKey = _layoutKey(deps, state);
  if (layoutKey !== _lastCanvasKey) {
    deps.cellSize = resizeCanvas(deps, state);
    _lastCanvasKey = layoutKey;
    // Invalidate background cache whenever layout changes
    _bgCache = null;
    _bgCacheKey = '';
  }

  _detectBoardChanges(state);
  const now = performance.now();

  const ctx = deps.ctx;
  const canvas = deps.canvas;
  // HiDPI：以 dpr transform 讓後續所有繪圖沿用 CSS 像素座標（cellSize/padding 不變）。
  const { cssW: w, dpr } = canvasCssMetrics(canvas);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.drawImage(renderBoardBackground(deps, state), 0, 0, w, w);

  if (state.isScoring && state.scoreData) {
    for (let x = 0; x < state.size; x++) {
      for (let y = 0; y < state.size; y++) {
        if (state.displayBoard[x][y] === EMPTY && state.scoreData.territory[x][y] !== 0) {
          const cx = deps.padding + y * deps.cellSize;
          const cy = deps.padding + x * deps.cellSize;
          ctx.fillStyle = state.scoreData.territory[x][y] === BLACK ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.4)';
          ctx.fillRect(cx - deps.cellSize * 0.2, cy - deps.cellSize * 0.2, deps.cellSize * 0.4, deps.cellSize * 0.4);
        }
      }
    }
  }

  // 覆盤領地覆蓋層（2c-2）：KataGo ownership（+1 黑、-1 白），畫在棋子下方。
  // ownership 索引 = row*size + col（= 本專案 x*size + y）。
  if (state.ownership && !state.isScoring) {
    const own = state.ownership;
    const s = deps.cellSize * 0.52;
    for (let x = 0; x < state.size; x++) {
      for (let y = 0; y < state.size; y++) {
        const o = own[x * state.size + y];
        if (o == null) continue;
        const a = Math.min(0.5, Math.abs(o) * 0.5);
        if (a < 0.06) continue;
        const cx = deps.padding + y * deps.cellSize;
        const cy = deps.padding + x * deps.cellSize;
        ctx.fillStyle = o > 0 ? `rgba(20,16,12,${a})` : `rgba(250,248,242,${a})`;
        ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
      }
    }
  }

  // 提子淡出：畫已從盤面消失、動畫尚未結束的子（見 _detectBoardChanges）
  let captureAnimActive = false;
  if (_captureFade) {
    const elapsed = now - _captureFade.start;
    if (elapsed < CAPTURE_FADE_MS) {
      const alpha = 1 - elapsed / CAPTURE_FADE_MS;
      for (const s of _captureFade.stones) drawStone(deps, s.x, s.y, s.color, false, 1, alpha);
      captureAnimActive = true;
    } else {
      _captureFade = null;
    }
  }

  let placeAnimActive = false;
  for (let x = 0; x < state.size; x++) {
    for (let y = 0; y < state.size; y++) {
      if (state.displayBoard[x][y] === EMPTY) continue;
      let scale = 1;
      if (_placeAnimRunning && state.lastMove && state.lastMove[0] === x && state.lastMove[1] === y) {
        const elapsed = now - _placeAnimStart;
        if (elapsed < PLACE_ANIM_MS) {
          scale = Math.max(0.05, _easeOutBack(Math.min(1, elapsed / PLACE_ANIM_MS)));
          placeAnimActive = true;
        } else {
          _placeAnimRunning = false;
        }
      }
      drawStone(deps, x, y, state.displayBoard[x][y], state.deadStones.has(x * state.size + y), scale);
    }
  }

  // 動畫進行中才排下一幀（借用呼叫端既有的重繪節流），靜止時不留常駐 rAF loop。
  if ((placeAnimActive || captureAnimActive) && deps.scheduleRedraw) {
    requestAnimationFrame(() => deps.scheduleRedraw());
  }

  if (state.emotionEnabled && !state.isScoring) {
    // Liberty count drawn directly with the canvas, not as emoji — colour-emoji
    // fonts render unreliably on canvas in mobile browsers (esp. iOS Safari),
    // so we render the气 count as a number tinted by danger level instead.
    const libertyMap = computeLibertyMap(state.displayBoard, state.size);
    const fontSize = Math.max(9, Math.min(deps.cellSize * 0.5, 18));
    ctx.save();
    ctx.font = `bold ${fontSize}px -apple-system,"Segoe UI",Roboto,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let x = 0; x < state.size; x++) {
      for (let y = 0; y < state.size; y++) {
        const color = state.displayBoard[x][y];
        if (color === EMPTY) continue;
        const libs = libertyMap[x][y];
        // Danger-graded colour: red (atari) → orange → yellow → green (safe)
        ctx.fillStyle = libs === 1 ? '#ff5252' : libs === 2 ? '#ffa726'
          : libs === 3 ? '#ffee58' : '#69f0ae';
        const cx = deps.padding + y * deps.cellSize;
        const cy = deps.padding + x * deps.cellSize;
        // Subtle backing so the number stays legible on both stone colours
        ctx.shadowColor = color === BLACK ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 2;
        ctx.fillText(String(libs), cx, cy);
      }
    }
    ctx.restore();
  }

  if (state.lastMove) {
    const [lx, ly] = state.lastMove;
    if (state.displayBoard[lx][ly] !== EMPTY) {
      const mcx = deps.padding + ly * deps.cellSize;
      const mcy = deps.padding + lx * deps.cellSize;
      const isBlackStone = state.displayBoard[lx][ly] === BLACK;
      // 最後一手標記：對比色實心點 + 細圈，比純點更好辨識、與朱砂印章語彙呼應
      ctx.save();
      ctx.strokeStyle = isBlackStone ? 'rgba(255,255,255,0.55)' : 'rgba(178,58,46,0.6)';
      ctx.lineWidth = Math.max(1, deps.cellSize * 0.035);
      ctx.beginPath();
      ctx.arc(mcx, mcy, deps.cellSize * 0.24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = isBlackStone ? '#fff' : '#b23a2e';
      ctx.beginPath();
      ctx.arc(mcx, mcy, deps.cellSize * 0.13, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // 劫爭禁著點常駐小標記（下一手解消：applyMove/applyPass 都會清 koPoint）。
  if (state.koPoint && !state.gameOver && !state.isReviewing && !state.isScoring) {
    const [kx, ky] = state.koPoint;
    const cx = deps.padding + ky * deps.cellSize;
    const cy = deps.padding + kx * deps.cellSize;
    ctx.save();
    ctx.strokeStyle = '#b23a2e'; // --seal
    ctx.lineWidth = 2;
    const s = deps.cellSize * 0.16;
    ctx.strokeRect(cx - s, cy - s, s * 2, s * 2);
    ctx.restore();
  }

  // 禁著點落子失敗：交叉點紅 X 閃現約 600ms（main.js 觸發後由計時器清除）。
  if (state.invalidFlash) {
    const [ix, iy] = state.invalidFlash;
    const cx = deps.padding + iy * deps.cellSize;
    const cy = deps.padding + ix * deps.cellSize;
    ctx.save();
    ctx.strokeStyle = '#b23a2e'; // --seal
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    const r = deps.cellSize * 0.3;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
    ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
    ctx.stroke();
    ctx.restore();
  }

  if (state.showingHint && !state.gameOver && !state.isReviewing && !state.isScoring && !state.isAIThinking) {
    for (const [hx, hy] of state.captureHints || []) {
      const cx = deps.padding + hy * deps.cellSize;
      const cy = deps.padding + hx * deps.cellSize;
      ctx.save();
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(cx, cy, deps.cellSize * 0.38, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff4444';
      ctx.font = `bold ${Math.max(10, deps.cellSize * 0.35)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', cx, cy);
      ctx.restore();
    }
  }

  // KataGo 建議走法：只標建議手藍圈「薦」（不畫後續預想線——低 visits 下後續手不可靠）。
  if (state.suggestMove && !state.gameOver && !state.isReviewing && !state.isScoring) {
    const [sx, sy] = state.suggestMove;
    const cx = deps.padding + sy * deps.cellSize;
    const cy = deps.padding + sx * deps.cellSize;
    ctx.save();
    ctx.strokeStyle = '#2e7dd1';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, deps.cellSize * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#2e7dd1';
    ctx.font = `bold ${Math.max(10, deps.cellSize * 0.32)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('薦', cx, cy);
    ctx.restore();
  }

  if (state.hoverPos && !state.gameOver && !state.isReviewing && !state.isScoring && !state.isAIThinking) {
    const [hx, hy] = state.hoverPos;
    if (state.board[hx][hy] === EMPTY) {
      ctx.globalAlpha = 0.4;
      drawStone(deps, hx, hy, state.currentPlayer, false);
      ctx.globalAlpha = 1.0;
    }
  }
}

// ——— 覆盤分析（2c）：每手影響文字 + 勝率曲線 ———
// analysis[k] = { wr: 黑勝率 0..1, lead: 黑領先目數 }（KataGo，黑方觀點）。

const _pct = (w) => `${Math.round(w * 100)}%`;

// 依勝率落差分類（誠實、以勝率為主訊號；目數為估計）
function _classifyLoss(wrLoss) {
  if (wrLoss >= 0.10) return { tag: '疑問手', cls: 'bad' };
  if (wrLoss >= 0.04) return { tag: '可再想', cls: 'warn' };
  return { tag: '', cls: 'good' };
}

export function updateReviewAnalysisInfo(state) {
  const el = document.getElementById('reviewAnalysisInfo');
  if (!el) return;
  const { currentReviewMove: m, moveHistory, analysis } = state;
  if (!analysis || !analysis[m]) { el.textContent = ''; el.className = 'move-info'; return; }

  if (m === 0) {
    el.textContent = `本局開始 — 黑勝率 ${_pct(analysis[0].wr)}`;
    el.className = 'move-info';
    return;
  }
  const move = moveHistory[m - 1];
  const after = analysis[m];
  const before = analysis[m - 1] || after;
  const isBlack = move.player === BLACK;
  // 該手玩家的勝率損失（正＝下完後對自己變差）；黑看 wr 下降、白看 wr 上升
  const wrLoss = isBlack ? before.wr - after.wr : after.wr - before.wr;
  const leadLoss = isBlack ? before.lead - after.lead : after.lead - before.lead;
  const who = isBlack ? '黑' : '白';
  const { tag, cls } = _classifyLoss(wrLoss);
  let txt = `第 ${m} 手（${who}）— 黑勝率 ${_pct(after.wr)}`;
  if (wrLoss > 0.005) {
    txt += `；這手約失 ${(wrLoss * 100).toFixed(0)}% 勝率`;
    if (leadLoss > 0.5) txt += `（≈ ${leadLoss.toFixed(1)} 目，估計）`;
    if (tag) txt += ` · ${tag}`;
  }
  el.textContent = txt;
  el.className = 'move-info ' + cls;
}

export function drawWinrateGraph(canvas, analysis, cursor) {
  if (!canvas || !analysis || analysis.length === 0) return;
  const ctx = canvas.getContext('2d');
  // HiDPI：以顯示尺寸（CSS px，.winrate-graph 為 width:100%）為邏輯座標、內部解析度 × dpr。
  // rect 為 0（尚未顯示）時退回既有屬性尺寸，行為與原本相同。
  const rect = canvas.getBoundingClientRect();
  const dpr = hidpiScale();
  const W = Math.round(rect.width) || canvas.width;
  const H = Math.round(rect.height) || canvas.height;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const N = analysis.length - 1; // 位置 0..N
  ctx.clearRect(0, 0, W, H);

  // 底 + 中線（50%）
  ctx.fillStyle = '#f4ecda';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#cabd9f';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

  const xAt = (k) => (N === 0 ? 0 : (k / N) * (W - 2) + 1);
  const yAt = (wr) => (1 - wr) * (H - 2) + 1; // wr=1（黑全勝）在上

  // 黑勝率折線
  ctx.strokeStyle = '#2c2417';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let k = 0; k <= N; k++) {
    const p = analysis[k];
    if (!p) continue;
    const x = xAt(k), y = yAt(p.wr);
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 標出勝率大跌的關鍵手（紅點）
  ctx.fillStyle = '#b23a2e';
  for (let k = 1; k <= N; k++) {
    const a = analysis[k], b = analysis[k - 1];
    if (!a || !b) continue;
    if (Math.abs(a.wr - b.wr) >= 0.12) {
      ctx.beginPath(); ctx.arc(xAt(k), yAt(a.wr), 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // 游標（目前這手）
  if (cursor >= 0 && cursor <= N) {
    ctx.strokeStyle = '#856219';
    ctx.lineWidth = 1.5;
    const cx = xAt(cursor);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  }
}

export const GoUI = {
  updateHUD, setStatus, getStatusMessage, syncStatus, updateReviewInfo,
  updateReviewAnalysisInfo, drawWinrateGraph,
  updateScoringDisplay,
  resizeCanvas, drawStone, drawBoard, showBoardToast
};
