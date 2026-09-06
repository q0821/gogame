// xiangqi-puzzle-mode.js — 象棋殘局練習控制器。
//
// 給殘局（FEN），玩家執先手方求殺/求勝；引擎（Fairy-Stockfish）一人分飾三角：
// 解答（提示最佳手）、對手（防守方最佳手）、裁判（判定勝勢是否保住 / 是否將死）。
// 重用 xiangqi-game 的獨立 board 與純工具、xiangqi-engine 的 analyze、xiangqi-ui 的 drawXiangqi。
import * as Game from './xiangqi-game.js';
import * as Engine from './xiangqi-engine.js';
import * as Progress from './xiangqi-puzzle-progress.js';
import { resizeXiangqiCanvas, drawXiangqi, animateXiangqiMove, renderCapturedPieces, announceXiangqiCapture } from './xiangqi-ui.js';
import { loadSfxPack, playSfx } from './audio-manager.js';

const WIN_CP = 150;     // 起始 ≥ 此值視為「求勝」題
const FAIL_CP = 0;      // 求勝題：玩家走後己方評估掉到 < 此值 → 視為丟失勝勢

let initialized = false;
let wired = false;
let dom = {};
let deps = null;

// ——— 題庫 ———
let index = null;        // [{key,title,count}]
let catKey = null;
let puzzles = [];        // 目前分類題目 [{fen,name}]
let pIdx = 0;

// ——— 單題狀態 ———
let board = null;        // 獨立 ffish board
let playerRed = true;    // 玩家方（= 題目 FEN 先手方）
let objective = 'win';   // 'win' | 'draw'
let selected = null;
let legalTargets = null;
let lastMove = null;
let checkRC = null;
let hintMove = null;     // [from,to]
let busy = false;        // 載入/思考/判定中，鎖操作
let finished = false;    // 本題已解出或判失敗
let generation = 0;
let animation = null;
let initialFen = '';
let puzzleReady = false;
let pendingReply = false;

const $ = (id) => document.getElementById(id);

function cacheDom() {
  dom = {
    screen: $('xqpScreen'), canvas: $('xqpBoard'), status: $('xqpStatus'), thinking: $('xqpThinking'),
    category: $('xqpCategory'), info: $('xqpInfo'),
    prev: $('xqpPrev'), next: $('xqpNext'), random: $('xqpRandom'), reset: $('xqpReset'), hint: $('xqpHint'), home: $('xqpHome'),
    end: $('xqpEnd'), endTitle: $('xqpEndTitle'), endSub: $('xqpEndSub'), endBtn: $('xqpEndBtn'),
    captured: $('xqpCaptured'), captureFeedback: $('xqpCaptureFeedback'),
  };
}

function evalCp(a) {
  if (a.mate != null) return a.mate > 0 ? 30000 - a.mate * 100 : -30000 - a.mate * 100;
  return a.cp == null ? 0 : a.cp;
}

// ——— 渲染 ———

function view() {
  return {
    grid: Game.gridFromFen(board.fen()),
    selected, legalTargets, lastMove, checkRC,
    pv: hintMove ? [{ from: hintMove[0], to: hintMove[1] }] : null,
    rc: (sq) => Game.squareToRC(sq),
  };
}
function render() {
  if (!board) return;
  const w = Math.min((dom.screen?.clientWidth || window.innerWidth) - 24, window.innerWidth - 32, 480);
  resizeXiangqiCanvas(deps, w);
  drawXiangqi(deps, view());
  renderCapturedPieces(dom.captured, board.fen(), initialFen);
}

function setStatus(msg) { if (dom.status) dom.status.textContent = msg; }
function showThinking(b) { if (dom.thinking) dom.thinking.style.display = b ? 'inline-flex' : 'none'; }
function updateInfo() {
  if (!dom.info) return;
  if (!puzzles.length) { dom.info.textContent = ''; return; }
  const done = Progress.solvedCount(puzzles.map((p) => p.fen));
  const mark = Progress.isSolved(puzzles[pIdx].fen) ? '　✓已解' : '';
  dom.info.textContent = `${puzzles[pIdx].name}　(${pIdx + 1}/${puzzles.length}・已解 ${done})${mark}`;
}

function goalText() {
  const who = playerRed ? '紅方' : '黑方';
  return objective === 'win' ? `${who}先行，求殺取勝` : `${who}先行，守和不敗`;
}

// ——— 結束卡片（共用 .board-end）———
function showEnd(ok, msg) {
  if (ok && puzzles[pIdx]) { Progress.markSolved(puzzles[pIdx].fen); updateInfo(); }
  playSfx(ok ? 'game-win' : 'game-lose'); // 殘局為單人求殺/守和練習，無 PvP／和局概念：解出=win，失敗=lose
  if (!dom.end) return;
  dom.endTitle.textContent = ok ? '解出！' : '再接再厲';
  dom.endSub.textContent = msg || '';
  dom.endBtn.textContent = ok ? '下一題' : '重試本題';
  dom.end._ok = ok;
  dom.end.style.display = 'flex';
}
function hideEnd() { if (dom.end) dom.end.style.display = 'none'; }

// ——— 載入 ———

async function loadIndex() {
  if (index) return;
  index = await (await fetch('/xiangqi-puzzles/index.json')).json();
  if (dom.category) {
    dom.category.textContent = '';
    for (const c of index) {
      const o = document.createElement('option');
      o.value = c.key; o.textContent = `${c.title}（${c.count}）`;
      dom.category.append(o);
    }
  }
}

async function loadCategory(key) {
  const token = invalidate();
  busy = true;
  hideEnd();
  clearSel();
  hintMove = null;
  if (board) render();
  catKey = key;
  puzzles = [];
  if (dom.category) dom.category.value = key;
  setStatus('載入中…');
  try {
    const response = await fetch(`/xiangqi-puzzles/${key}.json`);
    const loaded = await response.json();
    if (token !== generation) return;
    puzzles = loaded;
    await loadPuzzle(0);
  } catch (err) {
    if (token !== generation) return;
    busy = false;
    setStatus('題目載入失敗：' + (err?.message || err));
  }
}

function clearSel() { selected = null; legalTargets = null; }

function invalidate() {
  generation++;
  animation?.cancel();
  animation = null;
  showThinking(false);
  if (dom.captureFeedback) dom.captureFeedback.textContent = '';
  return generation;
}

async function loadPuzzle(i) {
  if (!puzzles.length) return;
  const token = invalidate();
  busy = true;
  finished = false;
  puzzleReady = false;
  pendingReply = false;
  hideEnd();
  hintMove = null;
  clearSel();
  lastMove = null;
  checkRC = null;
  pIdx = Math.max(0, Math.min(puzzles.length - 1, i | 0));
  const fen = puzzles[pIdx].fen;
  updateInfo();
  setStatus('載入中…');
  showThinking(true);
  if (board) { board.delete(); board = null; }
  try {
    const loaded = await Game.newRawBoard(fen);
    if (token !== generation) { loaded.delete(); return; }
    board = loaded;
    initialFen = board.fen();
    playerRed = board.turn();
    render();
    try {
      const a = await Engine.analyze({ fen: initialFen, movetimeMs: 500 });
      if (token !== generation) return;
      objective = evalCp(a) >= WIN_CP ? 'win' : 'draw';
    } catch {
      if (token !== generation) return;
      objective = 'win';
    }
    showThinking(false);
    puzzleReady = true;
    busy = false;
    setStatus(goalText());
    render();
  } catch (err) {
    if (token !== generation) return;
    showThinking(false);
    busy = false;
    setStatus('題目載入失敗：' + (err?.message || err));
  }
}

// ——— 對局邏輯 ———

function legalTargetsFrom(sq) {
  return board.legalMoves().split(/\s+/).filter(Boolean).map(Game.splitMove).filter((m) => m.from === sq).map((m) => m.to);
}
function updateCheck() {
  if (board.isCheck()) { const sq = board.checkedPieces().split(/\s+/).filter(Boolean)[0]; checkRC = sq ? Game.squareToRC(sq) : null; }
  else checkRC = null;
}

function onPoint(row, col) {
  if (busy || finished || !board) return;
  if (board.turn() !== playerRed) return; // 只在玩家回合
  const sq = Game.rcToSquare(row, col);
  if (selected && legalTargets && legalTargets.includes(sq)) {
    playerMove(selected + sq);
    return;
  }
  const targets = legalTargetsFrom(sq);
  if (targets.length) { selected = sq; legalTargets = targets; hintMove = null; }
  else clearSel();
  render();
}

function isWinResult() { const r = board.result(); return (playerRed && r === '1-0') || (!playerRed && r === '0-1'); }

async function movePiece(uci, token) {
  if (token !== generation || !board.legalMoves().split(/\s+/).includes(uci)) return false;
  const currentBoard = board;
  const parts = Game.splitMove(uci);
  if (dom.captureFeedback) dom.captureFeedback.textContent = '';
  animation = animateXiangqiMove(deps, Game.gridFromFen(board.fen()), uci, {
    onContact(victim) {
      if (token !== generation || board !== currentBoard || !currentBoard.push(uci)) return false;
      lastMove = [parts.from, parts.to];
      pendingReply = currentBoard.turn() !== playerRed;
      if (!document.hidden) playSfx(victim ? 'shogi-capture' : 'shogi-place');
      announceXiangqiCapture(dom.captureFeedback, victim);
      return true;
    },
    onFinish(committed) {
      if (token !== generation) return;
      if (committed) updateCheck();
      render();
    },
  });
  const current = animation;
  const committed = await current.promise;
  if (animation === current) animation = null;
  return token === generation && committed;
}

async function playerMove(uci) {
  const token = generation;
  busy = true;
  clearSel();
  hintMove = null;
  if (!await movePiece(uci, token)) {
    if (token === generation) busy = false;
    return;
  }
  await completePlayerTurn(token);
}

async function completePlayerTurn(token) {
  if (token !== generation) return;
  busy = true;
  // 玩家直接將死 → 解出
  if (board.isGameOver()) {
    const win = isWinResult();
    finished = true; busy = false;
    setStatus(win ? '將死對方，解出！' : '對局結束');
    showEnd(win, win ? goalLabelDone() : '本題結束');
    return;
  }
  if (!pendingReply) { busy = false; setStatus(goalText()); return; }
  // 判定 + 取防守手（一次 analyze 兼得）
  showThinking(true); setStatus('電腦思考中…');
  try {
    const a = await Engine.analyze({ fen: board.fen(), movetimeMs: 600 });
    if (token !== generation) return;
    const playerEval = -evalCp(a);      // a 為對手視角 → 取負為玩家視角
    showThinking(false);
    if (objective === 'win' && playerEval < FAIL_CP) {
      finished = true; busy = false;
      setStatus('這手把勝勢走丟了');
      showEnd(false, '可惜，這手丟了勝勢，再試一次');
      return;
    }
    if (objective === 'draw' && playerEval < -200) {
      finished = true; busy = false;
      setStatus('這手落入敗勢');
      showEnd(false, '守和失敗，再試一次');
      return;
    }
    // 引擎防守（用 analyze 的最佳手＝全強度）
    if (a.bestmove) {
      if (!await movePiece(a.bestmove, token)) {
        if (token === generation) busy = false;
        return;
      }
    }
    busy = false;
    if (board.isGameOver()) {
      const win = isWinResult();
      finished = true;
      setStatus(win ? '解出！' : '對局結束');
      showEnd(win, win ? goalLabelDone() : '本題結束');
      return;
    }
    setStatus(goalText());
    render();
  } catch (err) {
    if (token !== generation) return;
    showThinking(false); busy = false;
    setStatus('AI 出錯：' + (err?.message || err));
    Engine.reset();
  }
}

function goalLabelDone() { return objective === 'win' ? '成功求勝' : '成功守和'; }

async function showHint() {
  if (busy || finished || !board || board.turn() !== playerRed) return;
  const token = generation;
  busy = true; showThinking(true); setStatus('提示計算中…');
  try {
    const a = await Engine.analyze({ fen: board.fen(), movetimeMs: 600 });
    if (token !== generation) return;
    showThinking(false); busy = false;
    if (a.bestmove) { const m = Game.splitMove(a.bestmove); hintMove = [m.from, m.to]; setStatus('提示：藍色箭頭為建議走法'); render(); }
    else setStatus(goalText());
  } catch {
    if (token !== generation) return;
    showThinking(false); busy = false; setStatus(goalText());
  }
}

// ——— 事件 ———

function pointFromEvent(e) {
  const rect = dom.canvas.getBoundingClientRect();
  const pt = e.changedTouches?.[0] || e.touches?.[0] || e;
  const col = Math.round((pt.clientX - rect.left - deps.padding) / deps.cellSize);
  const row = Math.round((pt.clientY - rect.top - deps.padding) / deps.cellSize);
  if (col < 0 || col >= Game.COLUMNS || row < 0 || row >= Game.ROWS) return null;
  return { row, col };
}

function wireEvents() {
  if (wired) return;
  wired = true;
  let lastTouchAt = 0;
  dom.canvas.addEventListener('click', (e) => { if (Date.now() - lastTouchAt < 500) return; const p = pointFromEvent(e); if (p) onPoint(p.row, p.col); });
  dom.canvas.addEventListener('touchend', (e) => { lastTouchAt = Date.now(); e.preventDefault(); const p = pointFromEvent(e); if (p) onPoint(p.row, p.col); }, { passive: false });

  dom.home?.addEventListener('click', () => { location.hash = '#home'; });
  dom.category?.addEventListener('change', () => loadCategory(dom.category.value));
  dom.prev?.addEventListener('click', () => { if (pIdx > 0) loadPuzzle(pIdx - 1); });
  dom.next?.addEventListener('click', () => { if (pIdx < puzzles.length - 1) loadPuzzle(pIdx + 1); });
  dom.random?.addEventListener('click', () => { if (puzzles.length) loadPuzzle(Math.floor((performance.now() * 7919) % puzzles.length)); });
  dom.reset?.addEventListener('click', () => { if (puzzles.length) loadPuzzle(pIdx); else if (catKey) loadCategory(catKey); });
  dom.hint?.addEventListener('click', () => showHint());
  dom.endBtn?.addEventListener('click', () => {
    const ok = dom.end._ok;
    hideEnd();
    if (ok) loadPuzzle(Math.min(pIdx + 1, puzzles.length - 1));
    else loadPuzzle(pIdx);
  });
  window.addEventListener('resize', () => { if (dom.screen && dom.screen.style.display !== 'none') render(); });
}

// ——— 進入 ———

export async function enterXiangqiPuzzleMode() {
  loadSfxPack('xiangqi');
  loadSfxPack('common');
  if (!initialized) {
    cacheDom();
    deps = { canvas: dom.canvas, ctx: dom.canvas.getContext('2d'), padding: 22, cellSize: 32 };
    wireEvents();
    initialized = true;
  }
  const token = generation;
  await loadIndex();
  if (token !== generation) return;
  if (!puzzles.length) await loadCategory(catKey || index[0].key);
  else if (!board || !puzzleReady) await loadPuzzle(pIdx);
  else {
    render();
    if (!finished) await completePlayerTurn(token);
  }
}

export function leaveXiangqiPuzzleMode() {
  invalidate();
  busy = false;
  clearSel();
  hintMove = null;
  if (board) { updateCheck(); render(); }
}

export const XiangqiPuzzleMode = { enterXiangqiPuzzleMode, leaveXiangqiPuzzleMode };
