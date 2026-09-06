// xiangqi-mode.js — 象棋模式控制器（比照 gomoku-mode）。
//
// 自管狀態與事件，畫面顯隱由 main.js 路由統一管理。棋規用 xiangqi-game（ffish），
// AI 用 xiangqi-engine（Fairy-Stockfish）。兩個 WASM 延遲載入：進模式先載 ffish 顯示盤面，
// 引擎在第一手 AI 才載（省首次進場等待）。
import * as Game from './xiangqi-game.js';
import * as Engine from './xiangqi-engine.js';
import * as Review from './xiangqi-review.js';
import * as Adaptive from './adaptive-chess.js';
import { resizeXiangqiCanvas, drawXiangqi, animateXiangqiMove, renderCapturedPieces, announceXiangqiCapture } from './xiangqi-ui.js';
import { loadSfxPack, playSfx, playVoice } from './audio-manager.js';
import { renderAudioControls } from './audio-settings-ui.js';
import { recordGame, totals, formatRecord, loadStats, saveStats } from './stats.js';

const SETTINGS_KEY = 'xiangqi-settings-v1';

let initialized = false;
let wired = false;
let dom = {};
let deps = null;

// ——— 對局狀態 ———
let selected = null;       // 選取的 square
let legalTargets = null;   // 目的 square 陣列
let lastMove = null;       // [from, to]
let checkRC = null;        // 被將將帥的 {row,col}（將軍高亮）
let aiBusy = false;        // AI 思考中
let moving = false;        // 棋子移動動畫中（鎖操作避免競態）
let gameOver = false;
let boardReady = false;
let generation = 0;
let animation = null;
let initialFen = '';

// ——— 建議走法（AI 建議按鈕，教學用途，固定高強度）———
let hintMove = null;        // { from, to } 供 view.pv 箭頭；null=無顯示
let hintBusy = false;       // 建議請求進行中
let hintReq = null;         // 目前 in-flight 的 Engine.hint() 控制物件（{promise, cancel}）

// ——— 覆盤 ———
let reviewMode = false;
let reviewMoves = [];
let reviewFens = [];
let reviewPly = 0;
let reviewNodes = null;     // analyzeGame 結果（null = 尚未分析）
let reviewAnalyzing = false;

// ——— 設定 ———
let mode = 'pvc';          // 'pvc' | 'pvp'
let playerRed = true;      // pvc 時玩家是否執紅（先手）
let level = 2;             // 手動難度下拉 1=簡單 2=普通 3=困難
let autoMode = false;      // 自動調整難度（電腦連敗升級・連勝降級）
let autoLevel = Adaptive.DEFAULT_LEVEL; // 自動模式目前連續等級
let streak = 0;            // 連勝/連敗計數（>0 電腦連敗朝升級、<0 連勝朝降級）
let adaptiveApplied = false; // 本局是否已套用升降（避免同局重複）

const $ = (id) => document.getElementById(id);

function cacheDom() {
  dom = {
    screen: $('xiangqiScreen'), canvas: $('xiangqiBoard'), status: $('xiangqiStatus'),
    restart: $('xiangqiRestart'), undo: $('xiangqiUndo'), home: $('xiangqiHome'),
    mode: $('xiangqiMode'), color: $('xiangqiColor'), level: $('xiangqiLevel'),
    auto: $('xiangqiAuto'), autoLevelGroup: $('xiangqiAutoLevelGroup'),
    autoLevelLabel: $('xiangqiAutoLevel'), autoReset: $('xiangqiAutoReset'),
    settingsBtn: $('xiangqiSettingsBtn'), settingsModal: $('xiangqiSettingsModal'),
    hint: $('xiangqiHint'),
    thinking: $('xiangqiThinking'), checkBanner: $('xiangqiCheck'),
    endOverlay: $('xiangqiEnd'), endTitle: $('xiangqiEndTitle'), endSub: $('xiangqiEndSub'), endBtn: $('xiangqiEndBtn'),
    endStats: $('xiangqiEndStats'),
    reviewBtn: $('xiangqiReviewBtn'), controls: $('xiangqiControls'),
    review: $('xiangqiReview'), rvSlider: $('xiangqiReviewSlider'), rvInfo: $('xiangqiReviewInfo'),
    rvFirst: $('xqRvFirst'), rvPrev: $('xqRvPrev'), rvNext: $('xqRvNext'), rvLast: $('xqRvLast'),
    rvAnalyze: $('xqRvAnalyze'), rvExit: $('xqRvExit'), evalGraph: $('xiangqiEvalGraph'),
    audioSettings: $('xiangqiAudioSettings'),
    infobar: $('xiangqiInfobar'), turnBadge: $('xiangqiTurnBadge'), moveCount: $('xiangqiMoveCount'),
    redLost: $('xiangqiRedLost'), blackLost: $('xiangqiBlackLost'),
    captured: $('xqCaptured'), captureFeedback: $('xqCaptureFeedback'),
  };
  dom.settings = dom.screen?.querySelector('.gomoku-settings');
  dom.statusrow = dom.screen?.querySelector('.xiangqi-statusrow');
}


function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (s) {
      if (s.mode === 'pvp' || s.mode === 'pvc') mode = s.mode;
      if (typeof s.playerRed === 'boolean') playerRed = s.playerRed;
      if (s.level >= 1 && s.level <= 3) level = s.level;
      if (typeof s.autoMode === 'boolean') autoMode = s.autoMode;
      if (Number.isFinite(s.autoLevel)) autoLevel = Adaptive.clampLevel(s.autoLevel);
      if (Number.isFinite(s.streak)) streak = s.streak;
    }
  } catch { /* ignore */ }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mode, playerRed, level, autoMode, autoLevel, streak })); } catch { /* ignore */ }
}

function isActive() { return dom.screen && dom.screen.style.display !== 'none'; }
function isPlayerTurn() { return mode === 'pvp' || Game.turn() === playerRed; }

// ——— 渲染 ———

function view() {
  return {
    grid: Game.piecesGrid(),
    selected, legalTargets, lastMove, checkRC,
    pv: hintMove ? [hintMove] : null, // 重用既有 PV 箭頭繪製（見 xiangqi-ui.js）
    rc: (sq) => Game.squareToRC(sq),
  };
}

/** 重算尺寸 + 重畫（一般用）。
 *  寬度量測來源用 screen 容器（非 canvas 的 inline-block wrap，否則會回饋縮小）。 */
function render() {
  if (!boardReady) return;
  const avail = (dom.screen?.clientWidth || window.innerWidth) - 24;
  const w = Math.min(avail, window.innerWidth - 32, 480);
  resizeXiangqiCanvas(deps, w);
  drawXiangqi(deps, view());
}

/** 只重畫（不重算尺寸），可帶覆寫（動畫用，避免每幀 resize 抖動）。 */
function draw(extra) {
  if (!boardReady) return;
  drawXiangqi(deps, { ...view(), ...(extra || {}) });
}


function updateCheck() {
  if (!gameOver && Game.isCheck()) {
    const sq = Game.checkedSquares()[0];
    checkRC = sq ? Game.squareToRC(sq) : null;
  } else {
    checkRC = null;
  }
}

function showThinking(b) { if (dom.thinking) dom.thinking.style.display = b ? 'inline-flex' : 'none'; }

function flashCheck() {
  playVoice('voice-xiangqi-check');
  if (!dom.checkBanner) return;
  dom.checkBanner.classList.remove('show');
  void dom.checkBanner.offsetWidth; // reflow 重啟動畫
  dom.checkBanner.classList.add('show');
}

function showEnd() {
  if (!dom.endOverlay) return;
  const r = Game.result();
  const title = r === '1-0' ? '紅方勝' : r === '0-1' ? '黑方勝' : '和局';
  let sub = '';
  if (mode === 'pvc' && r !== '1/2-1/2') sub = ((r === '1-0') === playerRed) ? '你贏了！' : '電腦獲勝';
  const adaptMsg = maybeApplyAdaptive(r);   // 自動難度升降（每局僅一次）
  if (adaptMsg) sub = sub ? `${sub}　${adaptMsg}` : adaptMsg;
  if (dom.endTitle) dom.endTitle.textContent = title;
  if (dom.endSub) dom.endSub.textContent = sub;
  dom.endOverlay.style.display = 'flex';
}
function hideEnd() { if (dom.endOverlay) dom.endOverlay.style.display = 'none'; }

/** PvP 一律播「勝」音；PvC 依人類是否為贏家算 win/lose；和局播 draw。 */
function playEndSound(r) {
  if (mode !== 'pvc') { playSfx('game-win'); return; }
  if (r === '1/2-1/2') { playSfx('game-draw'); return; }
  playSfx(((r === '1-0') === playerRed) ? 'game-win' : 'game-lose');
}

/** 局面剛結束（gameOver 由 false→true 那一刻）才呼叫一次：終局音效＋將死語音，再顯示結束卡片。
 *  和 showEnd() 分開，避免覆盤結束後 exitReview() 重顯結束卡片時重播音效/語音。
 *  同一原因：對電腦累計戰績也記在這裡（單次觸發保證），不記在 showEnd()。 */
function onGameOver() {
  const r = Game.result();
  playEndSound(r);
  // 將死不播語音（使用者決定：TTS「死棋」語音質感不到位，終局結果由畫面終局卡片呈現即可）
  recordStats(r);
  showEnd();
}

/** 只記 pvc；pvp 結束卡片的戰績行清空。 */
function recordStats(r) {
  if (mode !== 'pvc') {
    if (dom.endStats) dom.endStats.textContent = '';
    return;
  }
  const outcome = r === '1/2-1/2' ? 'draw' : (((r === '1-0') === playerRed) ? 'win' : 'loss');
  const s = recordGame(loadStats(), 'xiangqi', outcome);
  saveStats(s);
  if (dom.endStats) dom.endStats.textContent = formatRecord(totals(s, 'xiangqi'));
}

// ——— 自動難度（連勝連敗階梯，見 adaptive-chess.js）———

/** pvc + 自動模式時，依本局結果升降等級；回傳升降提示字（無變動回空字）。每局僅套用一次。 */
function maybeApplyAdaptive(r) {
  if (mode !== 'pvc' || !autoMode || adaptiveApplied || !r) return '';
  adaptiveApplied = true;
  const outcome = r === '1/2-1/2' ? 'draw' : ((r === '1-0') === playerRed ? 'ai-lost' : 'ai-won');
  const res = Adaptive.nextLevel(autoLevel, streak, outcome);
  autoLevel = res.level; streak = res.streak;
  saveSettings();
  updateAutoLevelDisplay();
  if (res.change === 'up') return `電腦升級 → ${Adaptive.levelLabel(autoLevel)}`;
  if (res.change === 'down') return `電腦降級 → ${Adaptive.levelLabel(autoLevel)}`;
  return '';
}

function updateAutoLevelDisplay() {
  if (dom.autoLevelLabel) dom.autoLevelLabel.textContent = Adaptive.levelLabel(autoLevel);
}

function resetAutoLevel() {
  autoLevel = Adaptive.DEFAULT_LEVEL;
  streak = 0;
  saveSettings();
  updateAutoLevelDisplay();
}

/** 實際送進引擎的難度等級：自動模式用浮動等級，否則手動下拉映射到固定等級。 */
function effectiveLevel() {
  return autoMode ? autoLevel : (Adaptive.MANUAL_TO_LEVEL[level] ?? Adaptive.DEFAULT_LEVEL);
}

// ——— 覆盤 ———

function setReviewUI(on) {
  reviewMode = on;
  if (dom.infobar) dom.infobar.style.display = on ? 'none' : '';
  if (dom.settings) dom.settings.style.display = on ? 'none' : '';
  if (dom.statusrow) dom.statusrow.style.display = on ? 'none' : '';
  if (dom.controls) dom.controls.style.display = on ? 'none' : '';
  if (dom.review) dom.review.style.display = on ? 'flex' : 'none';
  updateHintBtn();
}

async function enterReview() {
  const token = generation;
  await Game.ensureReady();
  if (token !== generation || !isActive()) return;
  reviewMoves = Game.moveStackList();
  if (!reviewMoves.length) return;
  reviewFens = Game.fensForMoves(reviewMoves);
  reviewNodes = null;
  hideEnd();
  if (dom.evalGraph) dom.evalGraph.style.display = 'none';
  if (dom.rvSlider) dom.rvSlider.max = String(reviewMoves.length);
  setReviewUI(true);
  reviewGoTo(reviewMoves.length);
}

function exitReview() {
  setReviewUI(false);
  if (dom.captureFeedback) dom.captureFeedback.textContent = '';
  updateInfobar();
  render();                 // 回到實際對局（結束）局面
  if (gameOver) showEnd();
}

function reviewGoTo(ply) {
  reviewPly = Math.max(0, Math.min(reviewMoves.length, ply | 0));
  if (dom.rvSlider) dom.rvSlider.value = String(reviewPly);
  renderReview();
  updateReviewInfo();
  if (dom.captureFeedback) dom.captureFeedback.textContent = '';
  updateInfobar();
  if (reviewNodes) drawEvalGraph();
}

function renderReview() {
  const w = Math.min((dom.screen?.clientWidth || window.innerWidth) - 24, window.innerWidth - 32, 480);
  resizeXiangqiCanvas(deps, w);
  const grid = Game.gridFromFen(reviewFens[reviewPly]);
  const last = reviewPly > 0 ? Game.splitMove(reviewMoves[reviewPly - 1]) : null;
  // 最佳變化預想：分析後，取目前局面的 PV 前 3 手畫成箭頭
  let pv = null;
  const node = reviewNodes && reviewNodes[reviewPly];
  if (node && node.pv && node.pv.length) {
    pv = node.pv.slice(0, 3).map((uci) => { const m = Game.splitMove(uci); return { from: m.from, to: m.to }; });
  }
  drawXiangqi(deps, {
    grid, selected: null, legalTargets: null, checkRC: null,
    lastMove: last ? [last.from, last.to] : null,
    pv,
    rc: (sq) => Game.squareToRC(sq),
  });
}

/** 優勢曲線：每手紅方視角評估分，紅優正、黑優負；標目前手。 */
function drawEvalGraph() {
  const cv = dom.evalGraph;
  if (!cv || !reviewNodes) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = 5, mid = H / 2, CLAMP = 800;
  const N = reviewMoves.length;
  const xOf = (k) => pad + (N ? k / N : 0) * (W - 2 * pad);
  const yOf = (cp) => mid - (Math.max(-CLAMP, Math.min(CLAMP, cp)) / CLAMP) * (H / 2 - pad);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(192,57,43,0.10)'; ctx.fillRect(0, 0, W, mid);       // 上半=紅優
  ctx.fillStyle = 'rgba(44,36,23,0.12)'; ctx.fillRect(0, mid, W, H - mid);  // 下半=黑優
  ctx.strokeStyle = 'rgba(91,68,35,0.45)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
  ctx.strokeStyle = '#7a5a18'; ctx.lineWidth = 1.8; ctx.beginPath();
  reviewNodes.forEach((n, k) => { const x = xOf(k), y = yOf(n.redCp); k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.stroke();
  const cx = xOf(reviewPly);
  ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  ctx.fillStyle = '#c0392b';
  ctx.beginPath(); ctx.arc(cx, yOf(reviewNodes[reviewPly].redCp), 3.5, 0, Math.PI * 2); ctx.fill();
}

function onGraphClick(e) {
  if (!reviewNodes) return;
  const r = dom.evalGraph.getBoundingClientRect();
  const frac = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
  reviewGoTo(Math.round(Math.max(0, Math.min(1, frac)) * reviewMoves.length));
}

/** 紅方視角評估分（centipawn）→ 友善文字。 */
function fmtEval(redCp) {
  if (redCp >= 20000) return '紅方勝勢';
  if (redCp <= -20000) return '黑方勝勢';
  const v = redCp / 100;
  if (Math.abs(v) < 0.2) return '均勢';
  return (v > 0 ? '紅優 +' : '黑優 +') + Math.abs(v).toFixed(1);
}

function sqArrow(uci) { const m = Game.splitMove(uci); return `${m.from}→${m.to}`; }

function updateReviewInfo() {
  const el = dom.rvInfo;
  if (!el) return;
  el.textContent = '';
  const N = reviewMoves.length;
  // 第一行：手數 + 本手著法
  const l1 = document.createElement('div');
  l1.append('第 ');
  const b = document.createElement('b'); b.textContent = String(reviewPly); l1.append(b);
  l1.append(` / ${N} 手`);
  if (reviewPly > 0) {
    const mover = (reviewPly % 2 === 1) ? '紅' : '黑'; // 第 ply 手：ply1=紅
    l1.append(`　${mover}方 ${sqArrow(reviewMoves[reviewPly - 1])}`);
  }
  el.append(l1);
  if (reviewNodes) {
    const l2 = document.createElement('div');
    l2.textContent = '局面評估：' + fmtEval(reviewNodes[reviewPly].redCp);
    el.append(l2);
    if (reviewPly > 0) {
      const m = reviewNodes[reviewPly - 1]; // 描述「這手」的損失
      const l3 = document.createElement('div');
      l3.append('這手 ');
      const span = document.createElement('span');
      span.className = 'xq-cls ' + m.cls.key; // key 為內部常數，非外部輸入
      span.textContent = m.cls.label;
      l3.append(span);
      if (m.loss >= 30) l3.append(`（丟約 ${(m.loss / 100).toFixed(1)} 分）`);
      if (m.bestmove) l3.append('・最佳 ' + sqArrow(m.bestmove));
      el.append(l3);
    }
  } else {
    const hint = document.createElement('div');
    hint.style.color = 'var(--text-muted)';
    hint.textContent = '按「分析本局」評估每手好壞';
    el.append(hint);
  }
}

async function analyzeReview() {
  if (reviewAnalyzing || !reviewMoves.length) return;
  const token = generation;
  reviewAnalyzing = true;
  updateHintBtn();
  if (dom.rvAnalyze) dom.rvAnalyze.disabled = true;
  try {
    const nodes = await Review.analyzeGame(reviewMoves, {
      movetimeMs: 400,
      onProgress: (k, n) => { if (token === generation && dom.rvInfo) dom.rvInfo.textContent = `分析中… ${k}/${n}`; },
    });
    if (token !== generation) return;
    reviewNodes = nodes;
    if (dom.evalGraph) dom.evalGraph.style.display = 'block';
    drawEvalGraph();
    renderReview();   // 重繪以顯示 PV 箭頭
    updateReviewInfo();
  } catch (err) {
    if (token !== generation) return;
    if (dom.rvInfo) dom.rvInfo.textContent = 'AI 分析失敗：' + (err?.message || err);
    Engine.reset();
  } finally {
    if (token !== generation) return;
    reviewAnalyzing = false;
    updateHintBtn();
    if (dom.rvAnalyze) dom.rvAnalyze.disabled = false;
  }
}

/** 更新悔棋按鈕可用狀態（思考/動畫/無手/結束時不可悔）。 */
function updateUndoBtn() {
  if (!dom.undo) return;
  dom.undo.disabled = !boardReady || aiBusy || moving || gameOver || Game.gamePly() === 0;
}

/** 更新「建議走法」按鈕可用狀態：AI 思考中／覆盤分析中／覆盤模式中／終局後皆不可按。 */
function updateHintBtn() {
  if (!dom.hint) return;
  dom.hint.disabled = !boardReady || moving || hintBusy || aiBusy || reviewAnalyzing || reviewMode || gameOver;
}

/** 更新「覆盤」按鈕可用狀態：常駐於功能列，終局前 disabled（title 已註明「終局後可用」）。 */
function updateReviewBtn() {
  if (!dom.reviewBtn) return;
  dom.reviewBtn.disabled = !boardReady || !gameOver;
}

/** 資訊列：回合徽章 + 手數 + 雙方被吃子摘要（PRD §7）。棋盤未就緒（載入中）時略過，避免呼叫 Game 拋錯。 */
function updateInfobar() {
  if (!boardReady || !initialFen) return;
  const fen = reviewMode ? reviewFens[reviewPly] : Game.fen();
  const red = reviewMode ? fen.split(' ')[1] === 'w' : Game.turn();
  if (dom.turnBadge) {
    dom.turnBadge.textContent = red ? '紅方' : '黑方';
    dom.turnBadge.className = 'turn-badge ' + (red ? 'red' : 'black');
  }
  if (dom.moveCount) dom.moveCount.textContent = String(reviewMode ? reviewPly : Game.gamePly());
  const c = renderCapturedPieces(dom.captured, fen, reviewMode ? reviewFens[0] : initialFen);
  if (dom.redLost) dom.redLost.textContent = String(c.redLost);
  if (dom.blackLost) dom.blackLost.textContent = String(c.blackLost);
}

/** 清除目前顯示的建議走法箭頭，並取消尚在等待中的建議請求（引擎仍會跑完，但結果會被丟棄）。 */
function clearHint() {
  if (hintReq) { hintReq.cancel(); hintReq = null; }
  hintMove = null;
  hintBusy = false;
  if (!aiBusy) showThinking(false);
}

/** 按下「建議走法」：固定 movetime、引擎全力（不吃 adaptive 難度削弱），教學用途。 */
async function requestHint() {
  if (!dom.hint || dom.hint.disabled) return;
  clearHint();
  hintBusy = true;
  updateHintBtn();
  showThinking(true);
  const fenAtRequest = Game.fen();
  const req = Engine.hint({ fen: fenAtRequest, variant: 'xiangqi', movetime: 1500 });
  hintReq = req;
  try {
    const result = await req.promise;
    if (hintReq !== req) return; // 這期間已被 clearHint() 取消或被新請求取代，共用狀態不再歸這次請求管
    hintReq = null;
    hintBusy = false;
    showThinking(false);
    updateHintBtn();
    if (!isActive() || Game.fen() !== fenAtRequest) return; // 局面已變，丟棄不畫
    if (result) { hintMove = { from: result.from, to: result.to }; draw(); }
  } catch (err) {
    if (hintReq !== req) return; // 同上：晚到的 settle，共用狀態已不歸這次請求管
    hintReq = null;
    hintBusy = false;
    showThinking(false);
    updateHintBtn();
    if (err?.cancelled) return; // 使用者取消／局面已變導致的取消，靜默
    console.error('hint error:', err);
    setStatus('建議走法失敗，請稍候再試');
  }
}

/** 悔棋：pvc 退回玩家可下的時機（連 AI 那手一起退）。 */
function undoMove() {
  if (aiBusy || moving || !boardReady || Game.gamePly() === 0) return;
  clearHint();
  generation++;
  if (dom.captureFeedback) dom.captureFeedback.textContent = '';
  Game.undo();
  // pvc 若退完仍非玩家回合（剛退掉的是玩家手、輪到玩家對手）→ 再退一手回到玩家
  if (mode === 'pvc' && Game.gamePly() > 0 && Game.turn() !== playerRed) Game.undo();
  gameOver = false;
  hideEnd();
  clearSelection();
  const lm = Game.lastMoveUci();
  lastMove = lm ? [Game.splitMove(lm).from, Game.splitMove(lm).to] : null;
  updateCheck();
  setStatus();
  render();
  // 玩家執黑、退到開局（輪到紅=AI）→ 讓 AI 重新先手
  if (mode === 'pvc' && !gameOver && Game.turn() !== playerRed) maybeAiMove();
}

function setStatus(msg) {
  updateUndoBtn();
  updateHintBtn();
  updateReviewBtn();
  updateInfobar();
  if (!dom.status) return;
  if (msg) { dom.status.textContent = msg; return; }
  if (gameOver) {
    const r = Game.result();
    dom.status.textContent = r === '1-0' ? '紅方勝！' : r === '0-1' ? '黑方勝！' : '和局';
    return;
  }
  const who = Game.turn() ? '紅方' : '黑方';
  dom.status.textContent = Game.isCheck() ? `${who}回合 — 將軍！` : `${who}回合`;
}

// ——— 對局邏輯 ———

function clearSelection() { selected = null; legalTargets = null; }

async function doMove(uci) {
  if (!Game.legalMoves().includes(uci)) return false;
  const token = generation;
  const parts = Game.splitMove(uci);
  const grid = Game.piecesGrid();
  moving = true;
  clearSelection();
  clearHint();
  if (dom.captureFeedback) dom.captureFeedback.textContent = '';
  updateUndoBtn();
  updateHintBtn();
  animation = animateXiangqiMove(deps, grid, uci, {
    onContact(victim) {
      if (token !== generation || !isActive() || !Game.move(uci)) return false;
      lastMove = [parts.from, parts.to];
      if (!document.hidden) playSfx(victim ? 'shogi-capture' : 'shogi-place');
      announceXiangqiCapture(dom.captureFeedback, victim);
      return true;
    },
    onFinish(committed) {
      if (token !== generation) return;
      moving = false;
      if (committed) {
        gameOver = Game.isGameOver();
        updateCheck();
      }
      setStatus();
      render();
      if (committed && gameOver) onGameOver();
      else if (committed && Game.isCheck()) flashCheck();
    },
  });
  const current = animation;
  const committed = await current.promise;
  if (animation === current) animation = null;
  return token === generation && committed;
}

async function onPoint(row, col) {
  if (reviewMode || gameOver || aiBusy || moving || !boardReady) return;
  if (mode === 'pvc' && !isPlayerTurn()) return;
  const sq = Game.rcToSquare(row, col);
  // 已選子 → 點到合法目的就走
  if (selected && legalTargets && legalTargets.includes(sq)) {
    if (await doMove(selected + sq)) maybeAiMove();
    return;
  }
  // 否則嘗試選取（只有「輪到的一方」且有合法手的子能選）
  const targets = Game.legalTargetsFrom(sq);
  if (targets.length) { selected = sq; legalTargets = targets; }
  else { clearSelection(); }
  render();
}

function maybeAiMove() {
  if (mode !== 'pvc' || !boardReady || aiBusy || moving || gameOver || isPlayerTurn() || !isActive()) return;
  const token = generation;
  const fen = Game.fen();
  aiBusy = true;
  showThinking(true);
  setStatus('電腦思考中…');
  // 思考總時間 1.1–2.5 秒：引擎實算不足的差額補等待，讓 AI 有「在想」的感覺。
  const minDelay = 1100 + Math.floor(Math.random() * 1400);
  const t0 = performance.now();
  (async () => {
    try {
      const mv = await Engine.bestMove({ fen, level: effectiveLevel() });
      if (token !== generation) return;
      const rest = minDelay - (performance.now() - t0);
      if (rest > 0) await new Promise((r) => setTimeout(r, rest));
      if (token !== generation || Game.fen() !== fen) return;
      showThinking(false);
      aiBusy = false;
      if (!isActive() || gameOver) return;
      if (mv) await doMove(mv);
      else { gameOver = true; setStatus(); onGameOver(); }
    } catch (err) {
      if (token !== generation) return;
      showThinking(false);
      aiBusy = false;
      setStatus('AI 出錯：' + (err?.message || err) + '（請重新開始）');
      Engine.reset();
    }
  })();
}

async function newGame() {
  const token = ++generation;
  animation?.cancel();
  animation = null;
  boardReady = false;
  aiBusy = false;
  moving = false;
  reviewAnalyzing = false;
  if (dom.rvAnalyze) dom.rvAnalyze.disabled = false;
  dom.checkBanner?.classList.remove('show');
  if (dom.captureFeedback) dom.captureFeedback.textContent = '';
  if (reviewMode) setReviewUI(false);
  reviewNodes = null;
  adaptiveApplied = false;
  clearHint();
  hintBusy = false;
  hideEnd();
  showThinking(false);
  setStatus('載入棋盤中…');
  await Game.ensureReady();
  if (token !== generation || !isActive()) return;
  await Game.newGame();
  if (token !== generation || !isActive()) return;
  initialFen = Game.fen();
  boardReady = true;
  clearSelection();
  lastMove = null;
  checkRC = null;
  aiBusy = false;
  moving = false;
  gameOver = false;
  setStatus();
  render();
  maybeAiMove(); // pvc 玩家執黑時，紅（AI）先手
}

// ——— 設定 UI ———

function applySettingsToControls() {
  if (dom.mode) dom.mode.value = mode;
  if (dom.color) dom.color.value = playerRed ? 'red' : 'black';
  if (dom.level) dom.level.value = String(level);
  if (dom.auto) dom.auto.value = autoMode ? 'on' : 'off';
  const pvc = mode === 'pvc';
  dom.color?.closest('.control-group')?.style.setProperty('display', pvc ? '' : 'none');
  dom.level?.closest('.control-group')?.style.setProperty('display', (pvc && !autoMode) ? '' : 'none'); // 自動時隱藏手動難度
  dom.auto?.closest('.control-group')?.style.setProperty('display', pvc ? '' : 'none');
  dom.autoLevelGroup?.style.setProperty('display', (pvc && autoMode) ? '' : 'none');
  updateAutoLevelDisplay();
}

// ——— 設定彈窗 ———
function openSettings() { applySettingsToControls(); dom.settingsModal?.classList.add('show'); }
function closeSettings() { dom.settingsModal?.classList.remove('show'); }

// ——— 事件 ———

function pointFromEvent(e) {
  const rect = dom.canvas.getBoundingClientRect();
  const pt = e.changedTouches?.[0] || e.touches?.[0] || e;
  const mx = pt.clientX - rect.left;
  const my = pt.clientY - rect.top;
  const col = Math.round((mx - deps.padding) / deps.cellSize);
  const row = Math.round((my - deps.padding) / deps.cellSize);
  if (col < 0 || col >= Game.COLUMNS || row < 0 || row >= Game.ROWS) return null;
  return { row, col };
}

function wireEvents() {
  if (wired) return;
  wired = true;
  let lastTouchAt = 0;
  dom.canvas.addEventListener('click', (e) => {
    if (Date.now() - lastTouchAt < 500) return;
    const p = pointFromEvent(e); if (p) onPoint(p.row, p.col);
  });
  dom.canvas.addEventListener('touchend', (e) => {
    lastTouchAt = Date.now(); e.preventDefault();
    const p = pointFromEvent(e); if (p) onPoint(p.row, p.col);
  }, { passive: false });

  dom.restart?.addEventListener('click', () => newGame());
  dom.undo?.addEventListener('click', () => undoMove());
  dom.hint?.addEventListener('click', () => requestHint());
  dom.endBtn?.addEventListener('click', () => newGame());
  dom.home?.addEventListener('click', () => { location.hash = '#home'; });
  // 覆盤
  dom.reviewBtn?.addEventListener('click', () => enterReview());
  dom.rvExit?.addEventListener('click', () => exitReview());
  dom.rvFirst?.addEventListener('click', () => reviewGoTo(0));
  dom.rvPrev?.addEventListener('click', () => reviewGoTo(reviewPly - 1));
  dom.rvNext?.addEventListener('click', () => reviewGoTo(reviewPly + 1));
  dom.rvLast?.addEventListener('click', () => reviewGoTo(reviewMoves.length));
  dom.rvSlider?.addEventListener('input', () => reviewGoTo(Number(dom.rvSlider.value)));
  dom.rvAnalyze?.addEventListener('click', () => analyzeReview());
  dom.evalGraph?.addEventListener('click', onGraphClick);
  dom.mode?.addEventListener('change', () => { mode = dom.mode.value === 'pvp' ? 'pvp' : 'pvc'; saveSettings(); applySettingsToControls(); newGame(); });
  dom.color?.addEventListener('change', () => { playerRed = dom.color.value !== 'black'; saveSettings(); newGame(); });
  dom.level?.addEventListener('change', () => { level = Math.min(3, Math.max(1, Number(dom.level.value) || 2)); saveSettings(); });
  dom.auto?.addEventListener('change', () => { autoMode = dom.auto.value === 'on'; saveSettings(); applySettingsToControls(); });
  dom.autoReset?.addEventListener('click', () => resetAutoLevel());
  dom.settingsBtn?.addEventListener('click', () => openSettings());
  dom.settingsModal?.addEventListener('click', (e) => { if (e.target === dom.settingsModal) closeSettings(); });
  dom.settingsModal?.querySelector('[data-close-settings]')?.addEventListener('click', () => closeSettings());
  window.addEventListener('resize', () => { if (isActive()) (reviewMode ? renderReview() : render()); });
}

// ——— 進入 ———

export async function enterXiangqiMode() {
  if (!initialized) {
    cacheDom();
    loadSettings();
    deps = { canvas: dom.canvas, ctx: dom.canvas.getContext('2d'), padding: 22, cellSize: 32 };
    applySettingsToControls();
    wireEvents();
    renderAudioControls(dom.audioSettings);
    initialized = true;
  }
  loadSfxPack('xiangqi');
  loadSfxPack('common');
  if (!boardReady) await newGame();
  else {
    (reviewMode ? renderReview : render)();
    setStatus();
    maybeAiMove();
  }
}

export function leaveXiangqiMode() {
  animation?.cancel();
  animation = null;
  generation++;
  clearHint();
  hintBusy = false;
  aiBusy = false;
  moving = false;
  reviewAnalyzing = false;
  if (dom.rvAnalyze) dom.rvAnalyze.disabled = false;
  dom.checkBanner?.classList.remove('show');
  showThinking(false);
  closeSettings();
  if (dom.captureFeedback) dom.captureFeedback.textContent = '';
  if (boardReady) (reviewMode ? renderReview : render)();
}

export const XiangqiMode = { enterXiangqiMode, leaveXiangqiMode };
