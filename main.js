// main.js — entry point; wires modules together and manages shared game state.

import { EMPTY, BLACK, WHITE, opponent, inBounds as _inBounds, getNeighbors as _getNeighbors, getGroup as _getGroup, getLegalMoves as _getLegalMoves, tryPlaceStone as _tryPlaceStone, calculateScore, placeHandicap, handicapPoints } from './rules.js';
import * as GameStateModule from './game-state.js';
import { GoUI } from './ui.js';
import { GoSound } from './sound.js';
import { GoTimer } from './timer.js';
import { GoHints } from './hints.js';
import { GoReview } from './review.js';
import { buildSGF } from './sgf.js';
import { shareOrDownloadSgf } from './sgf-export.js';
import { openGoSettings, closeGoSettings, toggleGoSettings } from './go-settings.js';
import { makeAiController } from './ai-controller.js';
import { registerEventHandlers } from './event-handlers.js';
import { enterGomokuMode } from './gomoku-mode.js';
import { enterConnect6Mode } from './connect6-mode.js';
import { enterOthelloMode } from './othello-mode.js';
// 死活的已解題數用薄薄的 progress 模組同步取得（不牽動 tsumego-mode 全模組）；
// 死活/象棋/將棋/西洋棋/象棋殘局的進入點改為 applyRoute 內動態 import（見下），
// 讓 iOS build（__IOS_STORE__）能 DCE 掉 GPL 模組。tsumego-progress 無 GPL，靜態引入無妨。
import { loadProgress as loadTsumegoProgress, totalSolved as tsumegoTotalSolved } from './tsumego-progress.js';
import { playTitleReveal, startAmbient, playTransition } from './ink-fx.js';
import * as KataGo from './katago-service.js';
import { nextLevelForMode, kyuLabel, levelConfig, MIN_LEVEL, MAX_LEVEL } from './adaptive-difficulty.js';
import { formatPositionEstimate, isAnalysisRequestCurrent } from './position-estimate.js';
import { isPremium, remainingQuota, consumeQuota } from './entitlements.js';
import * as Store from './store-service.js';
import { initAudio, loadSfxPack, playSfx } from './audio-manager.js';
import { renderAudioControls, initAudioMuteButtons } from './audio-settings-ui.js';
import { recordGame, totals, formatRecord, loadStats, saveStats } from './stats.js';

// ==================== CONSTANTS ====================
const AI_MOVE_DELAY_MS       = 100;
const AI_INIT_DELAY_MS       = 300;
const COORD_LETTERS = 'ABCDEFGHJKLMNOPQRST';

const VALID_BOARD_SIZES = [9, 13, 19];
const VALID_GAME_MODES  = ['pvc', 'pvp'];

const STAR_POINTS = {
  9:  [[2,2],[2,6],[4,4],[6,2],[6,6]],
  13: [[3,3],[3,6],[3,9],[6,3],[6,6],[6,9],[9,3],[9,6],[9,9]],
  19: [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]]
};

// ==================== GAME STATE ====================
// 自適應難度：aiLevel 現在是「電腦等級」(1..MAX)，依戰績自動升降，獨立存於 localStorage。
// aiLevelMode：'auto'（自適應升降）| 'manual'（手動選級、不升降），同樣持久化。
const AI_LEVEL_KEY = 'gogame_ai_level';
const AI_LEVEL_MODE_KEY = 'gogame_ai_level_mode';
let aiLevelMode = loadAiLevelMode();
let showingHint = false;
let suggestMove = null; // KataGo 建議走法 [row,col]，null=不顯示
let _suggestBusy = false;
let liveOwnership = null; // 對局中形勢判斷的領地覆蓋層（KataGo ownership），落子/虛手/悔棋即清除
let _estimateBusy = false;

let invalidFlash = null; // 禁著點落子失敗時短暫閃現的紅 X [x,y]，null=不顯示
let _invalidFlashTimer = null;

let emotionEnabled = false;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
let cellSize = 30;
let padding = 40;
let hoverPos = null;

// ==================== GameState proxy ====================
const GameState = GameStateModule;

function getGoState() {
  return GameState.getState();
}

// ==================== BOARD / RULES ENGINE ====================
function inBounds(x, y)          { return _inBounds(getGoState().size, x, y); }
function getNeighbors(x, y)      { return _getNeighbors(getGoState().size, x, y); }
function getGroup(b, x, y)       { return _getGroup(b, getGoState().size, x, y); }
function tryPlaceStone(b, x, y, player, ko) { return _tryPlaceStone(b, getGoState().size, x, y, player, ko); }
function getLegalMoves(b, player, ko)       { return _getLegalMoves(b, getGoState().size, player, ko); }

function isGameBlocked() {
  const state = getGoState();
  return state.gameOver || state.isReviewing || state.isScoring;
}

// AI 求手一律經 setTimeout 延遲（AI_MOVE_DELAY_MS／AI_INIT_DELAY_MS）才真的開始，
// 「已排程但還沒開始思考」這段窗口內 isAIThinking 仍是 false，gameOver／isScoring 也都
// false，isGameBusy() 會回 false 讓使用者操作整個穿過去（虛手那一手還會被記成 AI 的顏色，
// 污染棋譜與 SGF 匯出）。這個旗標就是那段窗口的唯一表示。
//
// 刻意留在 main.js、不進 GameState：它是暫時性的控制狀態，不是對局狀態，也絕不能進
// snapshot（gogame_state 格式已上架，不得變動）。頁面重載時自然回到 false。
let aiMoveScheduled = false;

function isGameBusy()    { return isGameBlocked() || getGoState().isAIThinking || aiMoveScheduled; }

// ==================== APP CONTEXT (shared with sub-modules) ====================
// The `app` object provides sub-modules with access to mutable state and helpers.
const app = {
  // Constants
  EMPTY, BLACK, WHITE,
  AI_MOVE_DELAY_MS, AI_INIT_DELAY_MS,
  COORD_LETTERS, STAR_POINTS,

  // State getters (re-read live values)
  get size()              { return getGoState().size; },
  get board()             { return getGoState().board; },
  get currentPlayer()     { return getGoState().currentPlayer; },
  get captures()          { return getGoState().captures; },
  get moveHistory()       { return getGoState().moveHistory; },
  get koPoint()           { return getGoState().koPoint; },
  get gameOver()          { return getGoState().gameOver; },
  get gameMode()          { return getGoState().gameMode; },
  get playerColor()       { return getGoState().playerColor; },
  get aiLevel()           { return getGoState().aiLevel; },
  get isAIThinking()      { return getGoState().isAIThinking; },
  get timerEnabled()      { return getGoState().timerEnabled; },
  get timerSeconds()      { return getGoState().timerSeconds; },
  get gameRules()         { return getGoState().gameRules; },
  get komi()              { return getGoState().komi; },
  get isReviewing()       { return getGoState().isReviewing; },
  get currentReviewMove() { return getGoState().currentReviewMove; },
  get isScoring()         { return getGoState().isScoring; },
  get deadStones()        { return getGoState().deadStones; },
  get showingHint()       { return showingHint; },
  get emotionEnabled()    { return emotionEnabled; },
  get canvas()            { return canvas; },
  get padding()           { return padding; },
  get cellSize()          { return cellSize; },
  get hoverPos()          { return hoverPos; },

  // State setters
  set emotionEnabled(v)   { emotionEnabled = v; },
  set hoverPos(v)         { hoverPos = v; },

  // References to modules
  GoUI, GoSound, GoTimer, GoHints, GoReview,

  // Functions (bound below)
  inBounds, getGroup,
  isGameBlocked, isGameBusy,
  placeStone: (...args) => placeStone(...args),
  doPass: (...args) => doPass(...args),
  setAIThinking: (value) => GameState.setAIThinking(value),
  // 死子標記是數目期間唯一會改動狀態的使用者操作（進入點只有棋盤點擊，見
  // event-handlers.js）。成功切換後存檔，reload 才保得住手動修正的死子。
  toggleDeadGroup: (stones) => {
    const result = GameState.toggleDeadGroup(stones);
    if (result.ok) saveGame();
    return result;
  },
  updateUI: () => updateUI(),
  updateScoringDisplay: () => updateScoringDisplay(),
  syncStatus: (...args) => syncStatus(...args),
  setStatus: (msg) => setStatus(msg),
  drawBoard: () => drawBoard(),
  reviewGo: (n) => reviewGo(n),
  scheduleAIMove: (delayMs) => scheduleAIMove(delayMs),
  closeGoSettings,
};

// ==================== AI CONTROLLER ====================
const aiController = makeAiController(app);
app.aiController = aiController;

// 所有 AI 求手排程的唯一入口。設下 aiMoveScheduled 讓 isGameBusy() 把延遲窗口也算成忙碌，
// 並在真正呼叫 requestAIMove() 之前解除（不能改用 setAIThinking(true) 代替：requestAIMove()
// 開頭是 `if (app.gameOver || app.isAIThinking) return;`，提早設會讓它自己直接 return）。
//
// 同時具備冪等性：已有排程時直接忽略，重複呼叫不會排出兩次求手。
let _aiMoveTimer = null;
function scheduleAIMove(delayMs = AI_MOVE_DELAY_MS) {
  if (aiMoveScheduled) return;
  aiMoveScheduled = true;
  _aiMoveTimer = setTimeout(() => {
    _aiMoveTimer = null;
    aiMoveScheduled = false;   // 必須在呼叫之前解除，否則 AI 落子後旗標永遠留著
    aiController.requestAIMove();
  }, delayMs);
}

// 換局（開新局／載入存檔／覆盤分支）時取消殘留排程。不取消有兩個後果：舊局的排程會對著
// 新局叫一次 AI；而且冪等性守門會把新局自己的排程吞掉，AI 從此不動。
function cancelScheduledAIMove() {
  if (_aiMoveTimer) clearTimeout(_aiMoveTimer);
  _aiMoveTimer = null;
  aiMoveScheduled = false;
}

// ==================== CAPTURE HINTS ====================
function showHintOnce() {
  if (isGameBusy()) return;
  showingHint = true;
  drawBoard();
}

function clearHint() {
  if (showingHint) { showingHint = false; drawBoard(); }
}

// 棋盤中央短暫浮現的醒目提示（如「電腦虛手」），約 1.8 秒後淡出。
// 樣式以 inline 設定（不依賴 style.css），確保任何部署狀態都能正確顯示。
let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('goToast');
  if (!el) return;
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
    // .board-wrap 有 line-height:0（消 canvas 間隙），不覆寫的話文字換行會兩行疊在一起；
    // width:max-content 修正絕對定位＋left:50% 造成「可用寬度只剩容器一半、字多必換行」的問題。
    lineHeight: '1.5',
    width: 'max-content',
    maxWidth: '88vw',
    textAlign: 'center',
  });
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.display = 'none'; }, 1800);
}

// 走法提示：用 KataGo 算「現在這手該下哪」+ 數據理由（值幾目）。
// 注意：此處用全力最佳手、不套用對弈的隨機弱化，所以建議與對手強度無關。
async function requestMoveHint() {
  const state = getGoState();
  if (isGameBusy() || _suggestBusy) return;
  if (state.gameMode === 'pvc' && state.currentPlayer !== state.playerColor) return; // 只在輪到你時
  const requestBoard = state.board;
  const requestMoveCount = state.moveHistory.length;
  const requestPlayer = state.currentPlayer;
  _suggestBusy = true;
  setStatus('AI 思考建議走法中…');
  try {
    const r = await KataGo.suggest({
      board: state.board,
      size: state.size,
      currentPlayer: state.currentPlayer,
      moveHistory: state.moveHistory,
      komi: state.komi,
      gameRules: state.gameRules,
      onStatus: setStatus,
    }, { visits: 24 });
    const latest = getGoState();
    if (!isAnalysisRequestCurrent(latest, requestBoard, requestMoveCount, requestPlayer)) {
      return;
    }
    if (r.move) {
      suggestMove = [r.move.x, r.move.y];
      setStatus(describeSuggestion(r));
    } else {
      suggestMove = null;
      setStatus('AI 建議虛手（pass）');
    }
    drawBoard();
  } catch (err) {
    console.error('move hint error:', err);
    setStatus('建議走法失敗，請稍候再試');
  } finally {
    _suggestBusy = false;
  }
}

// 把 KataGo 數據翻成白話（誠實、只用真實數值）：座標、領先目數、後續手數。
function describeSuggestion(r) {
  const state = getGoState();
  const coord = `${COORD_LETTERS[r.move.y]}${state.size - r.move.x}`;
  // scoreLead 是黑領先目數；換成「當前玩家」視角
  let leadTxt = '';
  if (typeof r.scoreLead === 'number') {
    const mine = state.currentPlayer === BLACK ? r.scoreLead : -r.scoreLead;
    leadTxt = mine >= 0 ? `下了約領先 ${mine.toFixed(0)} 目` : `下了仍落後約 ${(-mine).toFixed(0)} 目`;
  }
  return `建議走法：${coord}（藍圈）${leadTxt ? '，' + leadTxt : ''}`;
}

function clearSuggest() {
  suggestMove = null;
}

// ——— 完整版（premium）gating ———
// 免費版：進階功能每日試用額度；完整版不限。旗標之後由商店 IAP 寫入（見 entitlements.js）。
const FREE_DAILY_ANALYSIS = 1; // 「分析本局」每日免費次數
const FREE_DAILY_ESTIMATE = 1; // 「形勢判斷」每日免費次數

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hasPremium() {
  try { return isPremium(localStorage); } catch (_) { return false; }
}

// 完整版判定：付費只存在於原生 App（商店可購買）；Web 版全功能免費——
// 它是導流與 SEO 入口、也沒有購買管道，鎖了只會做出「永遠解不開的鎖」。
function premiumUnlocked() {
  return !Store.storeAvailable() || hasPremium();
}

function openPremiumModal(reason) {
  const el = document.getElementById('premiumReason');
  if (el) el.textContent = reason || '';
  // 原生 App 內顯示購買/恢復按鈕（價格非同步從商店帶入）；Web 版只顯示說明。
  const actions = document.getElementById('premiumActions');
  const foot = document.getElementById('premiumFootnote');
  const canBuy = Store.storeAvailable();
  if (actions) actions.style.display = canBuy ? '' : 'none';
  if (foot) foot.style.display = canBuy ? 'none' : '';
  if (canBuy) {
    Store.getFullVersionPrice().then((p) => {
      const btn = document.getElementById('buyFullBtn');
      if (btn && p) btn.textContent = `購買完整版 ${p}`;
    });
  }
  document.getElementById('premiumModal')?.classList.add('show');
}

function closePremiumModal() {
  document.getElementById('premiumModal')?.classList.remove('show');
}

async function buyFullVersion() {
  const btn = document.getElementById('buyFullBtn');
  const el = document.getElementById('premiumReason');
  if (btn) btn.disabled = true;
  const r = await Store.purchaseFullVersion();
  if (btn) btn.disabled = false;
  if (r.ok) {
    if (el) el.textContent = '已解鎖完整版，感謝支持！';
    updateHomePremiumEntry();
    setTimeout(() => closePremiumModal(), 1200);
  } else if (el) {
    el.textContent = r.cancelled ? '已取消購買' : `購買失敗：${r.message}`;
  }
}

async function restorePurchase() {
  const el = document.getElementById('premiumReason');
  if (el) el.textContent = '恢復購買中…';
  const r = await Store.restoreFullVersion();
  if (el) el.textContent = r.message;
  if (r.owned) setTimeout(() => closePremiumModal(), 1200);
  updateHomePremiumEntry();
}

// 首頁「完整版」入口：只在原生 App（可購買）且尚未解鎖時顯示。
// Web 版全功能免費、已購買者都不需要看到購買入口。
function updateHomePremiumEntry() {
  const btn = document.getElementById('homePremiumEntry');
  if (btn) btn.style.display = (Store.storeAvailable() && !hasPremium()) ? '' : 'none';
}

// 形勢判斷：對局中隨時評估目前盤面。顯示黑方視角勝率＋領先目數，並以領地覆蓋層
// 上色（重用覆盤的 ownership 繪圖）；下一手（落子/虛手/悔棋）即自動清除覆蓋層。
async function requestPositionEstimate() {
  const state = getGoState();
  if (isGameBusy() || _estimateBusy) return;
  if (state.moveHistory.length === 0) { setStatus('盤面還是空的，先下幾手再判斷形勢'); return; }
  if (!premiumUnlocked() && remainingQuota(localStorage, 'estimate', FREE_DAILY_ESTIMATE, todayStr()) <= 0) {
    openPremiumModal('免費版每天可用 1 次「形勢判斷」，今天的額度已用完。');
    return;
  }
  const requestBoard = state.board;
  const requestMoveCount = state.moveHistory.length;
  const requestPlayer = state.currentPlayer;
  _estimateBusy = true;
  setStatus('形勢判斷中…');
  try {
    await KataGo.ensureReady(setStatus);
    const readyState = getGoState();
    if (!isAnalysisRequestCurrent(readyState, requestBoard, requestMoveCount, requestPlayer)) {
      return;
    }
    const a = await KataGo.evaluate({
      board: readyState.board,
      size: readyState.size,
      currentPlayer: readyState.currentPlayer,
      moveHistory: readyState.moveHistory,
      komi: readyState.komi,
      gameRules: readyState.gameRules,
    }, { visits: 24 });
    const latest = getGoState();
    if (!isAnalysisRequestCurrent(latest, requestBoard, requestMoveCount, requestPlayer)) {
      return;
    }
    const txt = formatPositionEstimate({ winrate: a?.rootWinRate, scoreLead: a?.rootScoreLead });
    liveOwnership = a?.ownership || null;
    setStatus(txt || '形勢判斷失敗，請稍候再試');
    drawBoard();
    if (txt && !premiumUnlocked()) consumeQuota(localStorage, 'estimate', todayStr());
  } catch (err) {
    console.error('position estimate error:', err);
    setStatus('形勢判斷失敗，請稍候再試');
  } finally {
    _estimateBusy = false;
  }
}

// 禁著點/無效點擊回饋：該交叉點紅 X 閃現約 600ms（見 ui.js drawBoard 的 invalidFlash）。
function flashInvalid(x, y) {
  invalidFlash = [x, y];
  drawBoard();
  if (_invalidFlashTimer) clearTimeout(_invalidFlashTimer);
  _invalidFlashTimer = setTimeout(() => {
    invalidFlash = null;
    drawBoard();
  }, 600);
}

// 落子失敗原因 → 使用者看得懂的中文提示。
function invalidMoveReasonText(reason) {
  if (reason === 'occupied') return '此處已有棋子';
  if (reason === 'suicide') return '禁著點：自殺手';
  if (reason === 'ko') return '打劫禁著點，需先在他處下一手';
  return '此處不能下子';
}

function getCaptureHints(board, player) {
  const state = getGoState();
  return GoHints.getCaptureHints(board, state.size, player, state.koPoint);
}

// ==================== RENDERING ====================
function buildBoardViewState() {
  const state = getGoState();
  const displayBoard = state.isReviewing
    ? GoReview.getReviewBoard(state.moveHistory, state.currentReviewMove, state.size)
    : state.board;
  const scoreData = state.isScoring
    ? calculateScore(
        state.board,
        state.size,
        state.deadStones,
        state.captures,
        state.gameRules,
        state.komi
      )
    : null;
  const captureHints = showingHint
    && !state.gameOver
    && !state.isReviewing
    && !state.isScoring
    && !state.isAIThinking
      ? getCaptureHints(state.board, state.currentPlayer)
      : [];
  const lastMove = state.isReviewing
    ? GoReview.getReviewLastMove(state.moveHistory, state.currentReviewMove)
    : state.lastMove;

  return {
    ...state,
    displayBoard,
    lastMove,
    scoreData,
    showingHint,
    captureHints,
    suggestMove,
    emotionEnabled,
    hoverPos,
    invalidFlash,
    ownership: (
      state.isReviewing
      && reviewOwnershipOn
      && reviewAnalysis
      && reviewAnalysis[state.currentReviewMove]
    )
      ? reviewAnalysis[state.currentReviewMove].ownership
      : (!state.isReviewing && !state.isScoring ? liveOwnership : null),
  };
}

let _drawRaf = null;
function drawBoard() {
  if (_drawRaf) return;
  _drawRaf = requestAnimationFrame(() => {
    _drawRaf = null;
    // scheduleRedraw：借給 ui.js 的落子 scale-in / 提子淡出動畫用，動畫進行中才會被呼叫
    // （drawBoard 本身已有 _drawRaf 節流 guard，不會疊加出常駐 loop）。
    const deps = { canvas, ctx, padding, cellSize, starPoints: STAR_POINTS, scheduleRedraw: drawBoard };
    GoUI.drawBoard(deps, buildBoardViewState());
    cellSize = deps.cellSize;
    padding = deps.padding;
  });
}

// ==================== GAME ACTIONS ====================
function placeStone(x, y) {
  const before = getGoState();
  if (isGameBlocked()) return false;
  if (before.isAIThinking && before.gameMode === 'pvc') return false;

  const result = GameState.applyMove(x, y);
  if (!result.ok) {
    flashInvalid(x, y);
    showToast(invalidMoveReasonText(result.reason));
    playSfx('invalid-move');
    return false;
  }

  showingHint = false;
  suggestMove = null;
  liveOwnership = null;

  const after = getGoState();
  updateUI();
  const willRequestAI = after.gameMode === 'pvc'
    && after.currentPlayer !== after.playerColor
    && !after.gameOver;
  syncStatus(willRequestAI ? 'AI 思考中...' : '');
  drawBoard();
  playSfx('stone-place');
  if (result.captured > 0) setTimeout(() => playSfx('stone-capture'), 80);
  if (after.timerEnabled) switchTimer();
  saveGame();
  if (willRequestAI) {
    scheduleAIMove();
  }
  return true;
}

function doPass() {
  if (isGameBusy()) return;

  showingHint = false;
  suggestMove = null;
  liveOwnership = null;

  const result = GameState.applyPass();
  if (!result.ok) return;
  playSfx('pass');

  if (result.endedByDoublePass) {
    endGameByScoring();
    return;
  }

  const state = getGoState();
  updateUI();
  const willRequestAI = state.gameMode === 'pvc'
    && state.currentPlayer !== state.playerColor
    && !state.gameOver;
  // In pvc, if after this pass it's the player's turn and no AI move is queued,
  // the AI was the one that just passed — guide the player on how to finish.
  const aiJustPassed = state.gameMode === 'pvc'
    && !willRequestAI
    && state.currentPlayer === state.playerColor
    && !state.gameOver;
  if (aiJustPassed) {
    setStatus('AI 虛手了 — 你也虛手即可數目，或按「申請數目」直接計算結果');
    showToast('電腦虛手（Pass）');   // 醒目提示，避免誤以為電腦還沒下
  } else {
    syncStatus(willRequestAI ? 'AI 思考中...' : '');
    // 虛手預警：這手是「單次虛手」（非雙虛手終局，上面已提早 return），提醒再一次就進數目。
    // AI 虛手已在上面分支顯示過提示，這裡只在非 AI 虛手時顯示，避免同一時刻兩個 toast。
    if (state.passCount === 1) {
      showToast('再虛手一次將進入數目');
    }
  }
  drawBoard();

  if (state.timerEnabled) switchTimer();
  saveGame();

  if (willRequestAI) {
    scheduleAIMove();
  }
}

function doUndo() {
  // 注意：不能只擋 isGameBlocked()。AI 回合中（isAIThinking=true）悔棋會在 aiController
  // 的 katagoMove() promise 還吊在半空時把 boardHistory／currentPlayer 往回轉，等該 promise
  // 事後才 resolve，會把「早已不合時宜」的一手用回轉後的 currentPlayer 誤植進棋譜（實測重現：
  // 原本一手黑棋落子後，會多冒出一手不明的黑子＋一手白子）。isGameBusy() 才會把 isAIThinking
  // 一併擋下。
  if (isGameBusy()) return;
  showingHint = false;
  suggestMove = null;
  liveOwnership = null;
  if (!document.getElementById('undoToggle').checked) {
    setStatus('悔棋功能已關閉，可在設定中開啟');
    return;
  }
  const state = getGoState();
  if (state.boardHistory.length === 0) return;

  const result = GameState.undo({ gameMode: state.gameMode });
  if (!result.ok) return;
  const undoState = getGoState();
  if (undoState.timerEnabled) switchTimer();

  updateUI();
  syncStatus();
  drawBoard();
  setStatus('已退回一手');
  saveGame();

  // 悔棋還原後可能輪到 AI，但沒有任何人會替 AI 推進：棋盤點擊被 event-handlers.js 的手番
  // 守門擋住、AI 也沒被喚醒，對局就停住。比照 loadGame() 的做法，還原後輪到 AI 就排一次
  // 求手。PvC 的 undo() 在 boardHistory.length >= 2 時一次悔兩手，而 applyMove() 與
  // applyPass() 都換手，pop 兩次剛好抵銷，手番保持不變，所以真正會落到「輪 AI」的是：
  //   (a) boardHistory.length === 1，只悔一手——盤上僅有 AI 的開局單手（人類執白、
  //       或讓子局白先），還原後回到 AI 的開局手番；
  //   (b) 悔棋前就已經卡在 AI 手番（例如 AI 求手中斷後恢復），悔兩手後仍是 AI 手番。
  const afterUndo = getGoState();
  if (
    afterUndo.gameMode === 'pvc'
    && !afterUndo.gameOver
    && afterUndo.currentPlayer !== afterUndo.playerColor
  ) {
    scheduleAIMove();
  }
}

function doResign() {
  // 同 doUndo()：AI 回合中（isAIThinking=true）認輸會在 katagoMove() 仍在跑時就把
  // gameOver 設為 true，該 promise 事後 resolve 時 aiController 仍會嘗試 placeStone，
  // 對已結束的對局動手。isGameBusy() 才會把 isAIThinking 一併擋下。
  if (isGameBusy()) return;
  // 認輸不可逆且會影響自適應等級，先確認避免誤觸（比照「重新開始」的既有做法）。
  if (!window.confirm('確定要認輸嗎？這局將以對方獲勝結束。')) return;
  const state = getGoState();
  const winner = opponent(state.currentPlayer);
  // 認輸視為大敗/大勝：認輸者的對手贏。以人類視角換算 margin 給自適應難度。
  const humanWon = (winner === state.playerColor);
  applyResultToLevel(humanWon ? 30 : -30);
  endGame(`${winner === BLACK ? '黑方' : '白方'}勝`, `${state.currentPlayer === BLACK ? '黑' : '白'}方認輸`, outcomeFor(winner));
}

// 依對局模式與人類執子換算終局音效結果：PvP 一律視為「勝」音（無輸家視角）；
// PvC 依人類是否為贏家算 win/lose，winnerColor 為 null 代表和局。
function outcomeFor(winnerColor) {
  const state = getGoState();
  if (state.gameMode !== 'pvc') return 'win';
  if (winnerColor === null) return 'draw';
  return winnerColor === state.playerColor ? 'win' : 'lose';
}

// ——— 自適應難度（電腦等級依戰績升降） ———
// 持久化的等級一律夾在合法範圍再回傳：這是 GameState.aiLevel 的主要來源（開機、開新局的
// 自動模式、恢復對局都經過這裡），夾在源頭才能讓等級顯示、手動選單與新局狀態拿到同一個
// 合法值。只夾下界的話，被寫壞成超出上限的值會流進 <select>.value（瀏覽器會靜默變成空
// 字串）與「第 999 級」這種顯示。AI 強度不受影響：levelConfig() 與 nextLevelForMode()
// 本來就各自夾過範圍。
function loadAiLevel() {
  try {
    const v = parseInt(localStorage.getItem(AI_LEVEL_KEY));
    if (Number.isFinite(v)) return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, v));
  } catch (_) {}
  return MIN_LEVEL; // 預設從最低級開始往上爬
}

function saveAiLevel(level) {
  try { localStorage.setItem(AI_LEVEL_KEY, String(level)); } catch (_) {}
}

function loadAiLevelMode() {
  try {
    if (localStorage.getItem(AI_LEVEL_MODE_KEY) === 'manual') return 'manual';
  } catch (_) {}
  return 'auto';
}

function saveAiLevelMode() {
  try { localStorage.setItem(AI_LEVEL_MODE_KEY, aiLevelMode); } catch (_) {}
}

// 更新設定面板的「電腦等級」顯示。
function updateAiLevelDisplay() {
  const level = getGoState().aiLevel;
  const el = document.getElementById('aiLevelDisplay');
  if (el) el.textContent = `第 ${level} 級（${kyuLabel(level)}）`;
}

// 初始化「電腦等級」設定控件：填手動選級下拉（1..MAX 級＋約當級位）、還原持久化的
// 模式與等級、依模式切換自動/手動兩組 UI 的顯示。
function initAiLevelControls() {
  const modeSel = document.getElementById('aiLevelMode');
  const manualSel = document.getElementById('aiManualLevel');
  if (!modeSel || !manualSel) return;

  for (let lv = MIN_LEVEL; lv <= MAX_LEVEL; lv++) {
    const opt = document.createElement('option');
    opt.value = String(lv);
    opt.textContent = `第 ${lv} 級（${kyuLabel(lv)}）`;
    manualSel.appendChild(opt);
  }
  // 完整版旗標若已失效（換裝置/尚未恢復購買），持久化的手動模式退回自動。
  if (aiLevelMode === 'manual' && !premiumUnlocked()) { aiLevelMode = 'auto'; saveAiLevelMode(); }
  modeSel.value = aiLevelMode;
  const level = getGoState().aiLevel;
  manualSel.value = String(Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, level)));

  const syncVisibility = () => {
    const manual = modeSel.value === 'manual';
    manualSel.style.display = manual ? '' : 'none';
    const autoRow = document.getElementById('aiAutoRow');
    if (autoRow) autoRow.style.display = manual ? 'none' : '';
  };
  modeSel.addEventListener('change', () => {
    if (modeSel.value === 'manual' && !premiumUnlocked()) {
      modeSel.value = 'auto';
      openPremiumModal('電腦等級手動任選（1–13 級）為完整版功能。免費版由電腦依戰績自動調整。');
    }
    syncVisibility();
  });
  syncVisibility();
}

let _pendingLevelMsg = null; // 升降訊息，於結束彈窗顯示

// 依「人類視角勝負目數」調整等級，回傳是否有變動，並備妥明示訊息。
function applyResultToLevel(humanMargin) {
  const state = getGoState();
  if (state.gameMode !== 'pvc') return; // 只在人機對局調整
  const result = nextLevelForMode(state.aiLevel, humanMargin, aiLevelMode);
  GameState.setAiLevel(result.level);
  saveAiLevel(result.level);
  updateAiLevelDisplay();
  if (result.change === 'up') {
    _pendingLevelMsg = `你贏得漂亮！電腦升到第 ${result.level} 級（${kyuLabel(result.level)}）`;
  } else if (result.change === 'down') {
    _pendingLevelMsg = `電腦降到第 ${result.level} 級（${kyuLabel(result.level)}），調整步調再來`;
  } else if (aiLevelMode === 'manual') {
    _pendingLevelMsg = `電腦固定第 ${result.level} 級（${kyuLabel(result.level)}，手動選級）`;
  } else {
    _pendingLevelMsg = `電腦維持第 ${result.level} 級（${kyuLabel(result.level)}）`;
  }
}

function resetAiLevel() {
  GameState.setAiLevel(MIN_LEVEL);
  saveAiLevel(MIN_LEVEL);
  updateAiLevelDisplay();
  setStatus(`已重設：電腦回到第 ${MIN_LEVEL} 級（${kyuLabel(MIN_LEVEL)}）`);
}

// End the game by counting territory, without needing the double-pass dance.
// Lets the player settle the result and see who won by how many points.
function finishGame() {
  if (isGameBusy()) return;
  const state = getGoState();
  if (state.moveHistory.length === 0) {
    setStatus('還沒有落子，無法數目');
    return;
  }
  endGameByScoring();
}

// 用 KataGo 的 ownership 推導死子：盤上某顆棋子若所在點被對方明確佔有（|own| 夠大且歸對方），
// 即判為死子。ownership：+1 黑佔 / -1 白佔，黑視角，index = row*size+col。
function deadStonesFromOwnership(ownership) {
  const state = getGoState();
  const dead = new Set();
  if (!ownership) return dead;
  const TH = 0.5; // 歸屬信心門檻；> 0.5 視為該方明確佔有
  for (let x = 0; x < state.size; x++) {
    for (let y = 0; y < state.size; y++) {
      const v = state.board[x][y];
      if (v === EMPTY) continue;
      const own = ownership[x * state.size + y]; // +黑 / -白
      // 黑子落在白佔區 → 黑子死；白子落在黑佔區 → 白子死
      if (v === BLACK && own < -TH) dead.add(x * state.size + y);
      else if (v === WHITE && own > TH) dead.add(x * state.size + y);
    }
  }
  return dead;
}

async function endGameByScoring() {
  stopTimer();
  saveGame();
  GameState.beginScoring();
  // 進入數目的狀態（isScoring + 估算出的 deadStones）立刻寫進 snapshot，reload 才回得到
  // 數目畫面。上面那次 saveGame() 是在 beginScoring() 之前，存進去的 isScoring 還是 false。
  saveGame();
  const scoringState = getGoState();
  document.getElementById('scoringPanel').style.display = 'block';
  // 進入數目那一刻就把最新狀態推給資訊列。雙虛手路徑的 applyPass() 已換手並多記一手，
  // 不推的話 #mobileTurn 與手數會停在虛手前的陳舊值（實測：顯示白方、3 手，實際黑方、4 手）。
  // 必須排在第一個 await（KataGo.scoreGame）之前，否則整段數目運算期間畫面都還是舊值。
  updateUI();
  // 先用舊估算顯示「計算中」基準，再用 KataGo ownership 覆蓋成準確結果。
  updateScoringDisplay();
  setStatus('AI 數目中…');
  drawBoard();

  try {
    const { ownership } = await KataGo.scoreGame({
      board: scoringState.board,
      size: scoringState.size,
      currentPlayer: scoringState.currentPlayer,
      moveHistory: scoringState.moveHistory,
      komi: scoringState.komi,
      gameRules: scoringState.gameRules,
      onStatus: setStatus,
    });
    const latest = getGoState();
    if (!latest.isScoring) return;
    if (ownership) {
      const dead = deadStonesFromOwnership(ownership);
      GameState.setDeadStones(dead);
      _lastOwnership = ownership;
      // KataGo ownership 推導出的死子比 beginScoring() 的純 JS 估算準，覆蓋後要再存一次，
      // 否則 reload 拿到的是精算前的估算值。
      saveGame();
    }
  } catch (err) {
    const latest = getGoState();
    if (!latest.isScoring) return;
    console.error('KataGo scoring failed, fallback to JS estimate:', err);
    // 失敗則沿用 beginScoring 的純 JS 估算（已在 deadStones 內）
  }

  const latest = getGoState();
  if (!latest.isScoring) return;
  updateScoringDisplay();
  applyUnfinishedWarning();
  drawBoard();
  showScoringResultModal();
}
let _lastOwnership = null;

// 數目結果置中彈窗：算完直接彈在畫面中央（結果只放下方 panel 會被沒捲動的人漏看）。
function showScoringResultModal() {
  const state = getGoState();
  const score = calculateScore(
    state.board,
    state.size,
    state.deadStones,
    state.captures,
    state.gameRules,
    state.komi
  );
  const diff = score.black - score.white;
  const resEl = document.getElementById('scoringModalResult');
  const detEl = document.getElementById('scoringModalDetail');
  const warnEl = document.getElementById('scoringModalWarn');
  if (resEl) {
    resEl.textContent = diff > 0 ? `黑勝 ${diff.toFixed(1)} 目`
      : diff < 0 ? `白勝 ${(-diff).toFixed(1)} 目` : '和局';
  }
  if (detEl) detEl.textContent = `黑 ${score.black.toFixed(1)}・白 ${score.white.toFixed(1)}（白含貼目 ${state.komi}）`;
  if (warnEl) {
    const neutral = countNeutralEmpty(score);
    if (neutral > state.size) {
      warnEl.textContent = `尚未終局？還有 ${neutral} 個雙方交界的空點未圍定，目前結果可能不準，建議按「繼續對弈」收完官子再數。`;
      warnEl.style.display = 'block';
    } else {
      warnEl.style.display = 'none';
    }
  }
  document.getElementById('scoringModal')?.classList.add('show');
}

// 關閉結果彈窗回棋盤標記死子；下方 scoringPanel 顯示即時明細，標完按「查看結果」
// 回到結果彈窗確認（閉環：彈窗 ↔ 盤面修正，最終動作都在彈窗完成）。
function adjustDeadStones() {
  document.getElementById('scoringModal')?.classList.remove('show');
  setStatus('點擊棋盤上的死子標記／取消標記，完成後按「查看結果」');
}

function updateScoringDisplay() {
  const state = getGoState();
  const score = calculateScore(
    state.board,
    state.size,
    state.deadStones,
    state.captures,
    state.gameRules,
    state.komi
  );
  GoUI.updateScoringDisplay({ gameRules: state.gameRules, komi: state.komi }, score);
}

// 數「中立空點」＝空且不屬任一方領地的點。多 → 邊界沒收完、尚未終局。純規則。
function countNeutralEmpty(score) {
  const state = getGoState();
  if (!score || !score.territory) return 0;
  let n = 0;
  for (let x = 0; x < state.size; x++) {
    for (let y = 0; y < state.size; y++) {
      if (state.board[x][y] === EMPTY && score.territory[x][y] === 0) n++;
    }
  }
  return n;
}

// 數目時若還有很多中立空點，提示尚未終局（避免拿過早的比分當定局）。
function applyUnfinishedWarning() {
  const state = getGoState();
  const score = calculateScore(
    state.board,
    state.size,
    state.deadStones,
    state.captures,
    state.gameRules,
    state.komi
  );
  const neutral = countNeutralEmpty(score);
  const warnEl = document.getElementById('scoringWarn');
  const mHint = document.getElementById('mobileScoringHint');
  const defaultHint = '已自動估算死子；點棋盤上的死子可修正';
  if (neutral > state.size) {
    const msg = `尚未終局？還有 ${neutral} 個雙方交界的空點未圍定，建議先收完官子再數目，目前結果可能不準。`;
    if (warnEl) { warnEl.textContent = msg; warnEl.style.display = 'block'; }
    if (mHint) mHint.textContent = msg;
    setStatus(msg);
  } else {
    if (warnEl) warnEl.style.display = 'none';
    if (mHint) mHint.textContent = defaultHint;
    setStatus('已自動估算死子，可點擊修正，然後確認結果');
  }
}

function confirmScoring() {
  const state = getGoState();
  document.getElementById('scoringModal')?.classList.remove('show');
  const score = calculateScore(
    state.board,
    state.size,
    state.deadStones,
    state.captures,
    state.gameRules,
    state.komi
  );
  const diff = score.black - score.white;
  const winner = diff > 0 ? '黑方' : '白方';
  const detail = `黑 ${score.black.toFixed(1)} vs 白 ${score.white.toFixed(1)}（含貼目 ${state.komi}）`;
  // 人類視角的勝負目數（人執 playerColor）：正=人贏 N 目、負=人輸 N 目。
  const humanMargin = state.playerColor === BLACK ? diff : -diff;
  applyResultToLevel(humanMargin);
  GameState.confirmScoring();
  document.getElementById('scoringPanel').style.display = 'none';
  const winnerColor = diff > 0 ? BLACK : diff < 0 ? WHITE : null;
  endGame(`${winner}勝`, detail, outcomeFor(winnerColor));
}

function cancelScoring() {
  document.getElementById('scoringModal')?.classList.remove('show');
  GameState.cancelScoring();
  const state = getGoState();
  if (state.timerEnabled) {
    startTimer();
  }
  saveGame();
  document.getElementById('scoringPanel').style.display = 'none';
  setStatus('已取消數目，繼續對弈');
  // 雙虛手進入數目時 applyPass() 已換手，取消後 currentPlayer 與上一次寫進 HUD 的值不同；
  // 少了這行，回合徽章（#mobileTurn，唯一寫入點是 GoUI.updateHUD()）會停在舊的一方，
  // 使用者以為輪白、點下去卻出現黑子，直到下一手落子才更新。
  updateUI();
  drawBoard();

  // 取消數目讓對局從「不可下」回到「可下」，手番也可能落在 AI 身上：雙虛手進入數目時
  // 第二個虛手方若是人類（PvC 人類執白，也正是 doPass() 提示「AI 虛手了 — 你也虛手即可
  // 數目」引導的流程），換手後就輪 AI。此處不排求手，棋盤點擊會被 event-handlers.js 的
  // 手番守門擋住、AI 也不會動，對局停住。比照 loadGame() 的做法補上排程。
  const afterCancel = getGoState();
  if (
    afterCancel.gameMode === 'pvc'
    && !afterCancel.gameOver
    && afterCancel.currentPlayer !== afterCancel.playerColor
  ) {
    scheduleAIMove();
  }
}

function endGame(title, detail, outcome) {
  GameState.markGameOver();
  const state = getGoState();
  stopTimer();
  saveGame();
  document.getElementById('modalTitle').textContent = '遊戲結束';
  document.getElementById('modalResult').textContent = title;
  document.getElementById('modalDetail').textContent = detail;
  // 客觀對局摘要（純規則，不做形勢/勝率臆測）
  const sm = document.getElementById('modalSummary');
  if (sm) {
    const s = GoReview.summarizeGame(state.moveHistory, state.size);
    let txt = `全 ${s.totalMoves} 手・黑提 ${s.blackCaptured} 子、白提 ${s.whiteCaptured} 子`;
    if (s.biggest) {
      txt += `・最大一次：第 ${s.biggest.moveNumber} 手${s.biggest.byPlayer === BLACK ? '黑' : '白'}提 ${s.biggest.count} 子`;
    }
    sm.textContent = txt;
  }
  // 自適應難度：明示電腦升/降級
  if (_pendingLevelMsg) {
    const sm2 = document.getElementById('modalSummary');
    if (sm2) sm2.textContent = (sm2.textContent ? sm2.textContent + '\n' : '') + _pendingLevelMsg;
    _pendingLevelMsg = null;
  }
  // 累計戰績：只記 pvc（含認輸/超時/數目，皆經此函式），pvp 該行清空。
  const modalStats = document.getElementById('modalStats');
  if (modalStats) {
    if (state.gameMode === 'pvc') {
      const statsOutcome = outcome === 'lose' ? 'loss' : outcome; // outcome 為 'win'|'lose'|'draw'
      const st = recordGame(loadStats(), 'go', statsOutcome);
      saveStats(st);
      modalStats.textContent = formatRecord(totals(st, 'go'));
    } else {
      modalStats.textContent = '';
    }
  }
  const reviewOn = document.getElementById('reviewToggle').checked;
  document.getElementById('modalReviewBtn').style.display = reviewOn ? 'block' : 'none';
  document.getElementById('resultModal').classList.add('show');
  if (reviewOn) {
    document.getElementById('reviewBtn').style.display = 'block';
  }
  document.getElementById('exportSgfBtn').style.display = 'block';
  setStatus(`遊戲結束 - ${title}`);
  // 終局是 gameOver=true 的唯一入口（認輸、超時、確認數目都走這裡），不推的話資訊列會停在
  // 上一次 updateUI() 的值：#mobileTurn 仍顯示某一方的回合而不是「遊戲結束」，手數也可能
  // 落後（雙虛手路徑的第二個虛手、數目期間的變動都不經 updateUI()）。
  updateUI();
  drawBoard();
  playSfx(`game-${outcome || 'win'}`);
}

async function exportSGF() {
  if (!premiumUnlocked()) {
    openPremiumModal('SGF 棋譜匯出為完整版功能。');
    return;
  }
  const state = getGoState();
  const handicapStones = state.handicap >= 2 ? handicapPoints(state.size, state.handicap) : [];
  const sgf = buildSGF(state.moveHistory, state.size, state.komi, handicapStones);
  const date = new Date().toISOString().slice(0, 10);
  const result = await shareOrDownloadSgf(sgf, `gogame_${date}_${state.size}x${state.size}.sgf`);
  if (result === 'shared') setStatus('SGF 已分享');
  else if (result === 'downloaded') setStatus('SGF 已下載');
}

function closeModal() {
  document.getElementById('resultModal').classList.remove('show');
}

// ==================== TIMER ====================
function _timerOnTimeout(losingPlayer) {
  const winner = opponent(losingPlayer);
  const state = getGoState();
  applyResultToLevel(winner === state.playerColor ? 30 : -30);
  endGame(`${winner === BLACK ? '黑方' : '白方'}勝`, `${losingPlayer === BLACK ? '黑' : '白'}方超時`, outcomeFor(winner));
}

function timerOptions() {
  return {
    getTimerSeconds: () => getGoState().timerSeconds,
    setTimerSeconds: (seconds) => GameState.setTimerSeconds(seconds),
    getCurrentPlayer: () => getGoState().currentPlayer,
    onTimeout: _timerOnTimeout
  };
}

function initTimer() {
  const minutes = parseInt(document.getElementById('timerMinutes').value);
  GoTimer.init(minutes, timerOptions().setTimerSeconds);
}

function startTimer() {
  if (!getGoState().timerEnabled) return;
  GoTimer.start(timerOptions());
}

function switchTimer() {
  if (!getGoState().timerEnabled) return;
  GoTimer.switch(timerOptions());
}

function stopTimer() {
  GoTimer.stop();
}

function updateTimerDisplay() {
  GoTimer.updateDisplay(getGoState().timerSeconds);
}

// ==================== REVIEW ====================
function enterReview() {
  if (!document.getElementById('reviewToggle').checked) return;
  const result = GameState.enterReview();
  if (!result.ok) return;
  document.getElementById('reviewBar').style.display = 'block';
  document.getElementById('reviewBtn').style.display = 'none';
  document.getElementById('exitReviewBtn').style.display = 'block';
  updateReviewInfo();
  drawBoard();
}

function exitReview() {
  const result = GameState.exitReview();
  if (!result.ok) return;
  const state = getGoState();
  document.getElementById('reviewBar').style.display = 'none';
  document.getElementById('exitReviewBtn').style.display = 'none';
  if (state.gameOver) document.getElementById('reviewBtn').style.display = 'block';
  drawBoard();
}

function reviewGo(n) {
  const result = GameState.reviewGo(n);
  if (!result.ok) return;
  updateReviewInfo();
  drawBoard();
}

function updateReviewInfo() {
  const state = getGoState();
  GoUI.updateReviewInfo({
    currentReviewMove: state.currentReviewMove,
    moveHistory: state.moveHistory,
    size: state.size,
  });
  if (reviewAnalysis) {
    GoUI.updateReviewAnalysisInfo({
      currentReviewMove: state.currentReviewMove,
      moveHistory: state.moveHistory,
      analysis: reviewAnalysis,
    });
    GoUI.drawWinrateGraph(document.getElementById('winrateGraph'), reviewAnalysis, state.currentReviewMove);
  }
}

// ==================== LEARNING MODE ====================
let savedOriginalGame = null;

// 覆盤分析（2c）：每個位置（第 0..N 手後）的黑方勝率/分數，由 KataGo 逐手算出。
// reviewAnalysis[k] = { wr: 黑勝率 0..1, lead: 黑領先目數 }。null = 尚未分析。
let reviewAnalysis = null;
let reviewAnalyzing = false;
let reviewOwnershipOn = false;

function clearReviewAnalysis() {
  reviewAnalysis = null;
  reviewOwnershipOn = false;
  const g = document.getElementById('winrateGraph');
  if (g) g.style.display = 'none';
  const info = document.getElementById('reviewAnalysisInfo');
  if (info) info.textContent = '';
  const ob = document.getElementById('ownershipBtn');
  if (ob) { ob.style.display = 'none'; ob.classList.remove('active'); }
}

function toggleReviewOwnership() {
  if (!reviewAnalysis) return;
  reviewOwnershipOn = !reviewOwnershipOn;
  const ob = document.getElementById('ownershipBtn');
  if (ob) ob.classList.toggle('active', reviewOwnershipOn);
  drawBoard();
}

// 用 KataGo 誠實逐手分析本局（opt-in；低 visits；黑方觀點，不宣稱精確目數）。
async function analyzeReview() {
  const state = getGoState();
  if (!state.isReviewing || reviewAnalyzing) return;
  if (!premiumUnlocked() && remainingQuota(localStorage, 'analysis', FREE_DAILY_ANALYSIS, todayStr()) <= 0) {
    openPremiumModal('免費版每天可用 1 次「分析本局」，今天的額度已用完。');
    return;
  }
  reviewAnalyzing = true;
  const btn = document.getElementById('analyzeReviewBtn');
  if (btn) btn.disabled = true;
  try {
    await KataGo.ensureReady(setStatus);
    const readyState = getGoState();
    if (!readyState.isReviewing) return;
    const N = readyState.moveHistory.length;
    const results = new Array(N + 1).fill(null);
    for (let k = 0; k <= N; k++) {
      const analysisState = getGoState();
      if (!analysisState.isReviewing) return;
      setStatus(`分析中… ${k}/${N}`);
      const b = GoReview.getReviewBoard(analysisState.moveHistory, k, analysisState.size);
      const player = (k % 2 === 0) ? BLACK : WHITE; // 第 k 手後輪到誰
      const a = await KataGo.evaluate({
        board: b,
        size: analysisState.size,
        currentPlayer: player,
        moveHistory: analysisState.moveHistory.slice(0, k),
        komi: analysisState.komi,
        gameRules: analysisState.gameRules,
      }, { visits: 12 });
      if (!getGoState().isReviewing) return;
      results[k] = { wr: a.rootWinRate, lead: a.rootScoreLead, ownership: a.ownership };
    }
    if (!getGoState().isReviewing) return;
    reviewAnalysis = results;
    if (!premiumUnlocked()) consumeQuota(localStorage, 'analysis', todayStr());
    setStatus('分析完成 — 逐手切換看勝率與失分，或點曲線跳手');
    const g = document.getElementById('winrateGraph');
    if (g) g.style.display = 'block';
    const ob = document.getElementById('ownershipBtn');
    if (ob) ob.style.display = '';
    updateReviewInfo();
  } catch (err) {
    if (!getGoState().isReviewing) return;
    console.error('Review analysis error:', err);
    setStatus('分析失敗：' + (err && err.message ? err.message : String(err)));
  } finally {
    reviewAnalyzing = false;
    if (btn) btn.disabled = false;
  }
}

function onWinrateGraphClick(e) {
  const state = getGoState();
  if (!reviewAnalysis) return;
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
  const N = state.moveHistory.length;
  reviewGo(Math.max(0, Math.min(N, Math.round(frac * N))));
}

// Branch the game from the current review position so the player can try a
// different move and keep playing the AI, without losing the original record.
function replayFromHere() {
  const state = getGoState();
  if (!state.isReviewing) return;
  const cut = state.currentReviewMove;
  savedOriginalGame = GameState.getSnapshot();
  const original = savedOriginalGame;
  const movesToReplay = original.moveHistory.slice(0, cut);
  const sideToMove = (cut % 2 === 0) ? BLACK : WHITE;

  GameState.exitReview();
  cancelScheduledAIMove();   // 換局：清掉舊局殘留排程，見 cancelScheduledAIMove()
  GameState.startGame({
    size: original.size,
    gameMode: 'pvc',
    playerColor: sideToMove,
    aiLevel: original.aiLevel,
    timerEnabled: false,
    timerSeconds: { [BLACK]: 600, [WHITE]: 600 },
    gameRules: original.gameRules,
    komi: original.komi,
  });
  for (const m of movesToReplay) {
    if (m.pass) GameState.applyPass();
    else GameState.applyMove(m.x, m.y);
  }
  const replayState = getGoState();

  document.getElementById('reviewBar').style.display = 'none';
  document.getElementById('exitReviewBtn').style.display = 'none';
  document.getElementById('reviewBtn').style.display = 'none';
  document.getElementById('returnOriginalBtn').style.display = 'block';
  clearReviewAnalysis();

  setStatus('練習模式：換個下法試試，再與 AI 繼續對弈');
  updateUI();
  drawBoard();
  if (
    replayState.gameMode === 'pvc'
    && replayState.currentPlayer !== replayState.playerColor
    && !replayState.gameOver
  ) {
    scheduleAIMove();
  }
}

function returnToOriginal() {
  if (!savedOriginalGame) return;
  GameState.restoreSnapshot(savedOriginalGame);
  // savedOriginalGame 是 replayFromHere() 在 GameState.exitReview() **之前**拍的快照，
  // isReviewing 為 true、currentReviewMove 停在分支點。還原後必須退出覆盤狀態，理由有二：
  //   1. 本函式接著就把 reviewBar／exitReviewBtn 收起來、把「覆盤」鈕放回去，狀態留在
  //      isReviewing=true 等於「盤面停在覆盤游標、卻沒有任何覆盤控制項」的死狀態。
  //   2. saveGame() 開頭是 `if (state.isReviewing) return;`，不退出的話下面那行存檔會是
  //      靜默 no-op，snapshot 留著練習分支，reload 就回不到原譜（本函式要修的正是這個）。
  GameState.exitReview();
  savedOriginalGame = null;
  const state = getGoState();
  document.getElementById('returnOriginalBtn').style.display = 'none';
  if (state.gameOver && document.getElementById('reviewToggle').checked) {
    document.getElementById('reviewBtn').style.display = 'block';
  }
  setStatus('已返回原始棋譜');
  updateUI();
  drawBoard();
  // 不存檔的話 snapshot 仍停在練習分支，reload 會回到分支而不是原譜。
  saveGame();
}

// ==================== UI ====================
function updateUI() {
  const state = getGoState();
  const overlay = document.getElementById('aiThinkingOverlay');
  if (overlay) overlay.style.display = state.isAIThinking ? 'flex' : 'none';
  GoUI.updateHUD(state);
}

function setStatus(msg) { GoUI.setStatus(msg); }

function syncStatus(message = '') {
  GoUI.syncStatus(getGoState(), message);
}

// ==================== NEW GAME ====================
// 進行中對局誤觸保護：有落子且尚未結束時，先確認再開新局，避免清掉進度。
function newGame() {
  const state = getGoState();
  if (state.moveHistory.length > 0 && !state.gameOver) {
    if (!window.confirm('目前有進行中的對局，開新局會清掉它。確定要重新開始嗎？')) return;
  }
  startNewGame();
}

function startNewGame() {
  const rawSize = parseInt(document.getElementById('boardSize').value);
  const selectedSize = VALID_BOARD_SIZES.includes(rawSize) ? rawSize : 19;

  const rawMode = document.getElementById('gameMode').value;
  const selectedMode = VALID_GAME_MODES.includes(rawMode) ? rawMode : 'pvc';

  let selectedPlayerColor = parseInt(document.getElementById('playerColor').value);
  // aiLevel：自動模式由自適應系統管理；手動模式由設定面板選定（該局不升降）。
  const levelModeElement = document.getElementById('aiLevelMode');
  aiLevelMode = (
    levelModeElement
    && levelModeElement.value === 'manual'
    && premiumUnlocked()
  ) ? 'manual' : 'auto';
  saveAiLevelMode();

  let selectedAiLevel;
  if (aiLevelMode === 'manual') {
    const manualLevel = parseInt(document.getElementById('aiManualLevel')?.value);
    selectedAiLevel = levelConfig(
      Number.isFinite(manualLevel) ? manualLevel : MIN_LEVEL
    ).level;
    saveAiLevel(selectedAiLevel);
  } else {
    selectedAiLevel = loadAiLevel();
  }

  const selectedTimerEnabled = document.getElementById('timerToggle').checked;
  const selectedRules = document.getElementById('gameRules').value;
  let selectedKomi = selectedRules === 'japanese' ? 6.5 : 7.5;

  // 讓子（S6）：只在 PvC 生效。讓子＝人執黑（拿讓子）、AI 執白先下、白貼 0.5 目。
  const handicapElement = document.getElementById('handicap');
  let handicap = handicapElement ? parseInt(handicapElement.value) || 0 : 0;
  if (selectedMode !== 'pvc' || handicap < 2) handicap = 0;

  let handicapBoard, handicapFirstPlayer;
  if (handicap >= 2) {
    selectedPlayerColor = BLACK;
    handicapBoard = placeHandicap(selectedSize, handicap);
    handicapFirstPlayer = WHITE;
    selectedKomi = 0.5;
  }

  const nextGame = {
    size: selectedSize,
    gameMode: selectedMode,
    playerColor: selectedPlayerColor,
    aiLevel: selectedAiLevel,
    timerEnabled: selectedTimerEnabled,
    timerSeconds: { [BLACK]: 600, [WHITE]: 600 },
    gameRules: selectedRules,
    komi: selectedKomi,
    handicap,
    board: handicapBoard,
    currentPlayer: handicapFirstPlayer,
  };

  // 必須在 startGame() 之前停鐘：GoTimer.stop() 會把「上一手開始剩餘 − 已流逝」回寫給
  // 目前的 activePlayer，而寫入端（timerOptions().setTimerSeconds）永遠指向當下的
  // GameState。排在 startGame() 之後停，等於把上一局的殘餘秒數寫進新局狀態（並被
  // saveGame() 存進 snapshot）。先停鐘則定格值落在即將被丟棄的舊局狀態上，語意正確。
  stopTimer();
  cancelScheduledAIMove();   // 換局：清掉舊局殘留排程，見 cancelScheduledAIMove()

  GameState.startGame(nextGame);
  updateAiLevelDisplay();
  const state = getGoState();
  const manualSel = document.getElementById('aiManualLevel');
  if (manualSel) manualSel.value = String(state.aiLevel);

  emotionEnabled  = document.getElementById('emotionToggle').checked;

  document.getElementById('scoringPanel').style.display = 'none';
  document.getElementById('reviewBar').style.display = 'none';
  document.getElementById('reviewBtn').style.display = 'none';
  document.getElementById('exitReviewBtn').style.display = 'none';
  document.getElementById('exportSgfBtn').style.display = 'none';
  document.getElementById('resultModal').classList.remove('show');
  clearReviewAnalysis();
  liveOwnership = null;

  if (state.timerEnabled) { initTimer(); startTimer(); }

  // AI 先手 = PvC 且開局輪到的不是玩家（含讓子局：白＝AI 先下）。
  const aiStartsGame = (
    state.gameMode === 'pvc'
    && state.currentPlayer !== state.playerColor
    && !state.gameOver
  );
  updateUI();
  syncStatus(aiStartsGame ? 'AI 思考中...' : '');
  drawBoard();
  clearSave();
  saveGame();

  // 不預載引擎；AI 先手時才求手（KataGo lazy 載入，模型約一次性下載 3.8MB）。
  if (aiStartsGame) {
    scheduleAIMove(AI_INIT_DELAY_MS);
  }
}

// ==================== SAVE / RESTORE ====================
const SAVE_KEY = 'gogame_state';

// 數目狀態（isScoring／deadStones）要能持久化，所以守門只擋覆盤。
// 選擇「放寬守門」而不是「只在 beginScoring() 之後補存一次」的理由：saveGame() 的呼叫端
// 很分散（死子標記、pagehide／visibilitychange checkpoint、離開對弈畫面、被擋下的
// doPassAndSave 尾巴），只補一處等於留下一堆「數目期間的變動存不進去」的縫。放寬後數目
// 期間的每次操作都會存檔，含死子切換——這正是我們要的保真度（reload 保留手動修正的死子）。
//
// 覆盤仍然不存：loadGame() 沒有重建覆盤 UI 的路徑，還原成 isReviewing=true 會變成
// 「盤面停在覆盤游標、卻沒有任何覆盤控制項」的死狀態。
function saveGame() {
  const state = getGoState();
  if (state.isReviewing) return;
  if (state.timerEnabled) GoTimer.sync();
  const snapshot = GameState.getSnapshot();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot));
  } catch (_) {}
}

function checkpointTimedGame() {
  const state = getGoState();
  if (!state.timerEnabled || state.gameOver) return;
  saveGame();
}

function checkpointHiddenTimedGame() {
  if (document.visibilityState === 'hidden') checkpointTimedGame();
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s || !s.board) return false;

    GameState.restoreSnapshot(s);
    GameState.setAIThinking(false);
    cancelScheduledAIMove();   // 換局：清掉殘留排程，見 cancelScheduledAIMove()
    GameState.setAiLevel(loadAiLevel());
    const state = getGoState();

    document.getElementById('boardSize').value = state.size;
    document.getElementById('gameMode').value = state.gameMode;
    document.getElementById('playerColor').value = state.playerColor;
    updateAiLevelDisplay();
    const manualSel = document.getElementById('aiManualLevel');
    if (manualSel) manualSel.value = String(state.aiLevel);
    document.getElementById('timerToggle').checked = state.timerEnabled;
    document.getElementById('gameRules').value = state.gameRules;
    document.getElementById('playerColorGroup').style.display = state.gameMode === 'pvc' ? 'block' : 'none';
    document.getElementById('aiStrengthGroup').style.display = state.gameMode === 'pvc' ? 'block' : 'none';
    const handicapState = state.handicap || 0;
    const hg = document.getElementById('handicapGroup');
    if (hg) hg.style.display = state.gameMode === 'pvc' ? 'block' : 'none';
    const hSel = document.getElementById('handicap');
    if (hSel) hSel.value = String(handicapState);
    document.getElementById('playerColor').disabled = handicapState >= 2;
    document.getElementById('timerSettings').style.display = state.timerEnabled ? 'block' : 'none';
    document.getElementById('timerArea').style.display = state.timerEnabled ? 'block' : 'none';
    if (state.timerEnabled) updateTimerDisplay();
    // 數目期間不走鐘（endGameByScoring() 進入數目時已停鐘），還原也不該重新起鐘。
    if (state.timerEnabled && !state.gameOver && !state.isScoring) startTimer();
    if (state.gameOver && document.getElementById('reviewToggle').checked) {
      document.getElementById('reviewBtn').style.display = 'block';
    }

    updateUI();
    drawBoard();
    if (state.isScoring) {
      // 重建數目畫面。分數用本地 calculateScore() 依還原的 deadStones 重算即可，不重跑
      // KataGo ownership——那是「進入數目那一刻」的精算，結果已經在 deadStones 裡，
      // 還原時再跑一次只是多花一次引擎推論、拿到同樣的東西。
      // 刻意不重開結果彈窗（showScoringResultModal）：每次 reload 都彈一次太擾人，
      // 使用者要看結果可按 scoringPanel 的「查看結果」。
      document.getElementById('scoringPanel').style.display = 'block';
      updateScoringDisplay();
      applyUnfinishedWarning();   // 內含 setStatus，故不再呼叫 syncStatus
    } else {
      syncStatus(state.gameOver ? '遊戲結束 — 可覆盤或開始新局' : `已恢復棋局（第 ${state.moveHistory.length} 手）`);
    }

    // 不預載引擎；若恢復後輪到 AI，直接求手（KataGo 優先、lazy）。
    // 數目中不求手：requestAIMove() 只擋 gameOver／isAIThinking、不看 isScoring，放行等於
    // 白跑一次引擎推論，還會把「AI 思考中」蓋在數目畫面上（那一手最後仍被 placeStone() 的
    // isGameBlocked() 擋掉，純屬白工）。
    if (
      state.gameMode === 'pvc'
      && !state.gameOver
      && !state.isScoring
      && state.currentPlayer !== state.playerColor
    ) {
      scheduleAIMove(AI_INIT_DELAY_MS);
    }
    return true;
  } catch(e) {
    console.error('Failed to load game:', e);
    return false;
  }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch(e) {}
}

// Wrap doPass/doUndo to also save
const _origDoPass = doPass;
function doPassAndSave() { _origDoPass(); saveGame(); }
const _origDoUndo = doUndo;
function doUndoAndSave() { _origDoUndo(); saveGame(); }

// ==================== PWA ====================
const VERSION_INFO_URL = 'version.json?t=' + Date.now();
const VERSION_FALLBACK = 'dev';

let _currentVersion = VERSION_FALLBACK;

async function applyAppVersion() {
  try {
    const response = await fetch(VERSION_INFO_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('version fetch failed');
    const data = await response.json();
    const version = data?.version || VERSION_FALLBACK;
    _currentVersion = version;
    document.getElementById('versionFooter').textContent = `版本：${version}`;
    return version;
  } catch (_) {
    document.getElementById('versionFooter').textContent = `版本：${VERSION_FALLBACK}`;
    return VERSION_FALLBACK;
  }
}

// ==================== CHANGELOG ====================
// Minimal, escaped Markdown → HTML for the changelog modal (no deps).
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  const lines = md.split('\n');
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^###\s+/.test(line))      { closeList(); html += `<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`; }
    else if (/^##\s+/.test(line))  { closeList(); html += `<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`; }
    else if (/^#\s+/.test(line))   { closeList(); html += `<h1>${inline(line.replace(/^#\s+/, ''))}</h1>`; }
    else if (/^---+$/.test(line))  { closeList(); html += '<hr>'; }
    else if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`;
    }
    else if (line === '')          { closeList(); }
    else                           { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return html;
}

let _changelogLoaded = false;
async function loadChangelog() {
  if (_changelogLoaded) return;
  const body = document.getElementById('changelogBody');
  try {
    const res = await fetch('CHANGELOG.md?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('changelog fetch failed');
    const md = await res.text();
    body.innerHTML = renderMarkdown(md);
    _changelogLoaded = true;
  } catch (_) {
    body.textContent = '無法載入版本紀錄。';
  }
}

function openChangelog() {
  document.getElementById('changelogVersion').textContent = `目前版本：${_currentVersion}`;
  document.getElementById('changelogModal').classList.add('show');
  loadChangelog();
}

function closeChangelog() {
  document.getElementById('changelogModal').classList.remove('show');
}

function openAbout() {
  // 問題回報 mailto 的主旨帶當前版本與平台，來信不用再問「你哪一版」。
  const mail = document.getElementById('feedbackMailLink');
  if (mail) {
    const platform = location.port === '3333' ? 'App' : 'Web';
    const subject = encodeURIComponent(`弈樂問題回報（${platform} ${_currentVersion}）`);
    mail.href = `mailto:yile@jackie-yeh.com?subject=${subject}`;
  }
  document.getElementById('aboutModal').classList.add('show');
}

function closeAbout() {
  document.getElementById('aboutModal').classList.remove('show');
}

// ==================== 全域音訊設定 modal（首頁「設定」鈕）====================
function openAudioSettings() {
  document.getElementById('audioSettingsModal').classList.add('show');
}

function closeAudioSettings() {
  document.getElementById('audioSettingsModal').classList.remove('show');
}

// ==================== GLOBAL ERROR HANDLING ====================
window.addEventListener('error', (e) => {
  if (!e.filename || !e.filename.includes(location.hostname)) return;
  console.error('Uncaught error:', e.error || e.message);
  setStatus(`操作失敗：${e.message || '未知錯誤'}。遊戲已自動儲存，可重新整理頁面。`);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled promise rejection:', e.reason);
  const msg = e.reason?.message || String(e.reason) || '未知錯誤';
  setStatus(`操作失敗：${msg}。遊戲已自動儲存，可重新整理頁面。`);
});

// ==================== EXPOSE TO HTML onclick handlers ====================
// index.html uses onclick="..." so we expose top-level names on window.
Object.assign(window, {
  startNewGame,
  newGame,
  doPass: doPassAndSave,
  doUndo: doUndoAndSave,
  doResign,
  finishGame,
  resetAiLevel,
  showHintOnce,
  requestMoveHint,
  requestPositionEstimate,
  enterReview,
  exitReview,
  reviewGo,
  replayFromHere,
  returnToOriginal,
  analyzeReview,
  onWinrateGraphClick,
  toggleReviewOwnership,
  exportSGF,
  openPremiumModal,
  closePremiumModal,
  buyFullVersion,
  restorePurchase,
  closeModal,
  openChangelog,
  closeChangelog,
  openAbout,
  closeAbout,
  openAudioSettings,
  closeAudioSettings,
  confirmScoring,
  cancelScoring,
  adjustDeadStones,
  showScoringResult: showScoringResultModal,
  openGoSettings,
  closeGoSettings,
  toggleGoSettings,
  currentReviewMove: undefined, // overwritten via getter below
  moveHistory: undefined,       // overwritten via getter below
});
// Keep window.currentReviewMove and window.moveHistory in sync for inline onclick
// handlers in index.html (e.g. reviewGo(currentReviewMove-1)).
Object.defineProperty(window, 'currentReviewMove', {
  get() { return getGoState().currentReviewMove; },
  configurable: true
});
Object.defineProperty(window, 'moveHistory', {
  get() { return getGoState().moveHistory; },
  configurable: true
});

// ==================== INIT ====================
registerEventHandlers(app);
window.addEventListener('pagehide', checkpointTimedGame);
document.addEventListener('visibilitychange', checkpointHiddenTimedGame);
GameState.setAiLevel(loadAiLevel());
updateAiLevelDisplay();
initAiLevelControls();
// IAP 權益啟動校正（原生 App 內才有動作；失敗不影響啟動）；
// 首頁完整版入口先依 localStorage 快取顯示，權益校正完再更新一次
updateHomePremiumEntry();
Store.syncEntitlements().then(updateHomePremiumEntry);

// 全域音訊：掛一次性解鎖手勢＋背景/前景生命週期監聽；設定 UI 容器在頁面載入時就存在
// （各棋畫面雖隱藏但 DOM 已渲染），可一次性渲染，靠 audio-settings-ui.js 的
// audio-settings-changed 監聽自動與其他實例同步，不必等使用者進到該棋種畫面才建立。
initAudio();
renderAudioControls(document.getElementById('homeAudioSettings'));
renderAudioControls(document.getElementById('goAudioSettings'));
// 快捷靜音鈕（首頁 header／六棋 mode-header）：一次掃描整份 document 就好，
// 各棋畫面雖隱藏但按鈕 DOM 已存在，不必等進入該畫面才掛 listener。
initAudioMuteButtons();

// App 版（iOS/Android 內嵌 server，port 3333）不顯示 GitHub 連結（使用者要求）：
// 自家「原始碼」行整行移除、作者改純文字（含頁尾）；第三方授權標註保留文字但去連結化
// （GPL/MIT 署名合規）。另在關於頁加「網頁版」低調連結（外開瀏覽器；措辭刻意不做
// 功能/價格對比，避開 App Store 反規避條款的灰色地帶）。
if (location.port === '3333') {
  const src = document.getElementById('aboutSourceLine');
  if (src) src.remove();
  const author = document.getElementById('aboutAuthorLine');
  if (author) author.textContent = '作者：Jackie Yeh';
  // 頁尾的作者項在 App 內整個移除（使用者要求 App 不顯示作者/GitHub 導流；
  // 關於頁保留純文字作者資訊即可）。
  document.querySelector('.version-footer a[href*="github.com"]')?.remove();
  document.querySelectorAll('#aboutModal a[href*="github.com"]').forEach((a) => {
    const span = document.createElement('span');
    span.className = a.className;
    span.textContent = a.textContent;
    a.replaceWith(span);
  });
  if (author) {
    const web = document.createElement('p');
    web.append('網頁版： ');
    const link = document.createElement('a');
    link.href = 'https://yile.jackie-yeh.com';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'yile.jackie-yeh.com';
    web.appendChild(link);
    author.after(web);
  }
}

const _isLocalDev = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if ('serviceWorker' in navigator && _isLocalDev) {
  // 開發環境不註冊 SW，並清掉既有註冊與快取，避免一直吃到舊資源
  navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
  if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
}

// 先取得當前版本，再以「帶當前版號的 query」註冊 SW。
// 舊版寫死 'sw.js?v=v2026.03.15-9c49be6'：query 永不改變 → 瀏覽器更新檢查時被 HTTP 快取
// 餵回舊 sw.js bytes，新 SW 永遠裝不上去。舊 SW 會把 /img/* 漏接成 fallback HTML，
// 導致標題圖載入失敗、首頁毛筆字消失。改用 version.json 的當前版號，每次部署 query 都變，
// 強制瀏覽器抓新 sw.js，新 SW 才能接管（skipWaiting + clients.claim）。
applyAppVersion().then((version) => {
  if ('serviceWorker' in navigator && !_isLocalDev) {
    navigator.serviceWorker.register('sw.js?v=' + version).catch(() => {});
  }
});

// ==================== HOME / ROUTING ====================
// 以 location.hash 為單一路由來源：
//   ''/'#home' → 首頁、'#play' → 對弈、'#tsumego' → 死活練習。
// 對弈只在首次進入「對弈」時初始化（保留 loadGame 自動恢復未完成對局）。
// desc 寫成「上句，下句」對句（意象＋氣勢），renderHome 會固定在逗號處斷成兩行（對聯感、不孤字）。
// iOS App Store 版旗標（vite define 注入）。GPL 棋種與死活練習不進 iOS build。
// 直接用於 UI 過濾即可；動態 import 的守衛須直接寫 `__IOS_STORE__`（見 applyRoute）才會被 DCE。
const IOS_STORE = typeof __IOS_STORE__ !== 'undefined' ? __IOS_STORE__ : false;

// webOnly：GPL 授權（象棋/將棋/西洋棋/象棋殘局）或 iOS 不收錄（死活）→ iOS 版首頁不列。
const HOME_ITEMS = [
  { id: 'play',    title: '圍棋對弈', desc: '黑白手談，方圓論天地', hash: '#play',    img: 'img/cards/play.webp' },
  { id: 'tsumego', title: '死活練習', desc: '方寸之間，一子定生死', hash: '#tsumego', img: 'img/cards/tsumego.webp', webOnly: true },
  { id: 'xiangqi', title: '象棋對弈', desc: '楚河漢界，車馬論英雄', hash: '#xiangqi', img: 'img/cards/xiangqi.webp', webOnly: true },
  { id: 'xqpuzzle',title: '象棋殘局', desc: '古譜殘局，絕處覓殺機', hash: '#xqpuzzle', img: 'img/cards/xqpuzzle.webp', webOnly: true },
  { id: 'shogi',   title: '日本將棋', desc: '升變打入，俘子再成軍', hash: '#shogi',   img: 'img/cards/shogi.webp', webOnly: true },
  { id: 'gomoku',  title: '五子棋',   desc: '縱橫連珠，先連者為王', hash: '#gomoku',  img: 'img/cards/gomoku.webp' },
  { id: 'connect6',title: '連六棋',   desc: '雙落連橫，六子成龍', hash: '#connect6',img: 'img/cards/connect6.webp' },
  { id: 'othello', title: '黑白棋',   desc: '黑白翻覆，一夾定乾坤', hash: '#othello', img: 'img/cards/othello.webp' },
  { id: 'chess',   title: '西洋棋',   desc: '兩軍對壘，將死擒敵王', hash: '#chess',   img: 'img/cards/chess.webp', webOnly: true },
].filter(item => !(IOS_STORE && item.webOnly));

let playInited = false;

function hasUnfinishedGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    return !!(s && s.board && !s.gameOver && (s.moveHistory || []).length > 0);
  } catch (_) { return false; }
}

function homeItemHint(id) {
  if (id === 'play') return hasUnfinishedGame() ? '有對局可續弈' : '';
  if (id === 'tsumego') {
    const n = tsumegoTotalSolved(loadTsumegoProgress());
    return n > 0 ? `已解 ${n} 題` : '';
  }
  return '';
}

function renderHome() {
  const menu = document.getElementById('homeMenu');
  menu.innerHTML = '';
  for (const item of HOME_ITEMS) {
    const card = document.createElement('button');
    card.className = 'home-card';
    card.type = 'button';

    // 背景水墨圖層（裝飾性，不進無障礙樹）
    const bg = document.createElement('span');
    bg.className = 'home-card-bg';
    bg.setAttribute('aria-hidden', 'true');
    if (item.img) bg.style.backgroundImage = `url("${item.img}")`;
    card.appendChild(bg);

    // 文字層（疊在圖與遮罩之上）
    const body = document.createElement('span');
    body.className = 'home-card-body';

    const title = document.createElement('span');
    title.className = 'home-card-title';
    title.textContent = item.title;
    body.appendChild(title);

    const desc = document.createElement('span');
    desc.className = 'home-card-desc';
    const parts = item.desc.split(/[，、]/);
    if (parts.length === 2) {
      const top = document.createElement('span'); top.textContent = parts[0];
      const bottom = document.createElement('span'); bottom.textContent = parts[1];
      desc.append(top, bottom);
    } else {
      desc.textContent = item.desc;
    }
    body.appendChild(desc);

    const hint = homeItemHint(item.id);
    if (hint) {
      const tag = document.createElement('span');
      tag.className = 'home-card-hint';
      tag.textContent = hint;
      body.appendChild(tag);
    }

    card.appendChild(body);
    card.addEventListener('click', () => { location.hash = item.hash; });
    menu.appendChild(card);
  }
  if (homeArrowsInited) requestAnimationFrame(() => document.getElementById('homeMenu')?.dispatchEvent(new Event('scroll')));
}

let homeArrowsInited = false;
function initHomeArrows() {
  if (homeArrowsInited) return;
  const menu = document.getElementById('homeMenu');
  if (!menu || !menu.parentElement) return;
  homeArrowsInited = true;

  const mk = (dir, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `home-nav-arrow home-nav-${dir}`;
    b.setAttribute('aria-label', label);
    b.innerHTML = dir === 'prev'
      ? '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
    b.addEventListener('click', () => {
      const card = menu.querySelector('.home-card');
      const step = card ? card.getBoundingClientRect().width + 16 : menu.clientWidth * 0.8;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      menu.scrollBy({ left: dir === 'prev' ? -step : step, behavior: reduce ? 'auto' : 'smooth' });
    });
    return b;
  };

  const wrap = menu.parentElement;      // .home-screen
  const prev = mk('prev', '上一組棋');
  const next = mk('next', '下一組棋');
  wrap.appendChild(prev);
  wrap.appendChild(next);

  const update = () => {
    const atStart = menu.scrollLeft <= 2;
    const atEnd = menu.scrollLeft + menu.clientWidth >= menu.scrollWidth - 2;
    const overflowing = menu.scrollWidth > menu.clientWidth + 4;
    const prevHidden = !overflowing || atStart;
    const nextHidden = !overflowing || atEnd;
    prev.classList.toggle('is-hidden', prevHidden);
    next.classList.toggle('is-hidden', nextHidden);
    prev.tabIndex = prevHidden ? -1 : 0;
    next.tabIndex = nextHidden ? -1 : 0;
  };
  menu.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();

  // 滑鼠拖曳捲動：觸控裝置本就原生滑動，故僅處理 mouse pointer。
  // 「移動超過閾值才 setPointerCapture」→ 單純點擊不被捕獲、可正常進入棋種；
  // 真的拖曳過才捕獲並在其後抑制卡片 click（避免拖完誤觸）。
  let dragActive = false, dragCaptured = false, dragMoved = false;
  let dragStartX = 0, dragStartScroll = 0, dragPointer = null;
  menu.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    dragActive = true; dragCaptured = false; dragMoved = false;
    dragStartX = e.clientX; dragStartScroll = menu.scrollLeft; dragPointer = e.pointerId;
  });
  menu.addEventListener('pointermove', (e) => {
    if (!dragActive || e.pointerId !== dragPointer) return;
    const dx = e.clientX - dragStartX;
    if (!dragCaptured) {
      if (Math.abs(dx) <= 4) return;      // 閾值內視為點擊、不啟動拖曳
      dragCaptured = true; dragMoved = true;
      menu.setPointerCapture(dragPointer);
      menu.classList.add('dragging');
    }
    menu.scrollLeft = dragStartScroll - dx;
  });
  const endDrag = () => {
    if (!dragActive) return;
    dragActive = false;
    if (dragCaptured) {
      try { menu.releasePointerCapture(dragPointer); } catch (_) { /* 已釋放 */ }
      menu.classList.remove('dragging');
    }
  };
  menu.addEventListener('pointerup', endDrag);
  menu.addEventListener('pointercancel', endDrag);
  // 拖曳過才抑制隨後的卡片 click（capture 階段攔截，避免導航進棋種）
  menu.addEventListener('click', (e) => {
    if (dragMoved) { e.preventDefault(); e.stopPropagation(); dragMoved = false; }
  }, true);
}

// 目前顯示中的畫面。showScreen() 是所有路由切換的唯一收斂點（只被 applyRoute() 呼叫），
// 用它偵測「離開對弈畫面」比在 applyRoute 的每個分支各補一次可靠。
let _activeScreen = null;

function showScreen(name) {
  if (_activeScreen === 'play' && name !== 'play') leavePlayMode();
  _activeScreen = name;
  document.getElementById('homeScreen').style.display = name === 'home' ? 'flex' : 'none';
  document.getElementById('goScreen').style.display = name === 'play' ? 'flex' : 'none';
  document.getElementById('tsumegoScreen').style.display = name === 'tsumego' ? 'flex' : 'none';
  document.getElementById('gomokuScreen').style.display = name === 'gomoku' ? 'flex' : 'none';
  document.getElementById('connect6Screen').style.display = name === 'connect6' ? 'flex' : 'none';
  document.getElementById('xiangqiScreen').style.display = name === 'xiangqi' ? 'flex' : 'none';
  document.getElementById('shogiScreen').style.display = name === 'shogi' ? 'flex' : 'none';
  document.getElementById('chessScreen').style.display = name === 'chess' ? 'flex' : 'none';
  document.getElementById('othelloScreen').style.display = name === 'othello' ? 'flex' : 'none';
  document.getElementById('xqpScreen').style.display = name === 'xqpuzzle' ? 'flex' : 'none';
  const playHeader = document.getElementById('playHeader');
  if (playHeader) playHeader.style.display = name === 'play' ? 'flex' : 'none';
}

// 離開對弈畫面＝暫停對局：停鐘定格精確剩餘秒數，並存檔。
// 不停鐘的話，在別的棋種畫面待著也照樣扣圍棋的時間，而 pagehide／visibilitychange 的
// checkpoint 還會把那段燒掉的時間寫進 snapshot（連 reload 都救不回來）。
// 停鐘後補一次 saveGame() 把定格值寫進 snapshot；不補的話要等下一次圍棋操作才會寫，
// 期間關掉分頁就丟失定格結果。
function leavePlayMode() {
  if (!getGoState().timerEnabled) return;
  stopTimer();
  saveGame();
}

function enterPlayMode() {
  loadSfxPack('go');
  loadSfxPack('common');
  if (!playInited) {
    playInited = true;
    if (!loadGame()) startNewGame();
    return;   // loadGame()／startNewGame() 自己會起鐘
  }
  // 再次進入：離開時已由 leavePlayMode() 停鐘，對局若仍在進行就續鐘，否則對局等於被無故
  // 中斷、只能靠下一手落子才恢復計時。終局／數目／覆盤本來就不該走鐘（進入那些狀態時
  // 已各自停鐘），不在這裡重新起鐘。
  const state = getGoState();
  if (state.timerEnabled && !state.gameOver && !state.isScoring && !state.isReviewing) {
    startTimer();
  }
}

function goHome() { location.hash = '#home'; }

// 各路由的分頁標題（供瀏覽器分頁顯示，也讓 GA4「網頁標題」報表能區分各棋類——
// hash SPA 的 page_path 會被去掉 hash，否則各棋種在報表裡長一樣）。
const SITE_TITLE = '弈樂 · 多棋類線上對弈';
const ROUTE_TITLES = {
  '#tsumego': '圍棋死活', '#gomoku': '五子棋', '#connect6': '連六棋', '#xiangqi': '象棋對弈',
  '#shogi': '日本將棋', '#chess': '西洋棋', '#othello': '黑白棋',
  '#xqpuzzle': '象棋殘局', '#play': '圍棋對弈',
};

/** 對弈中切換棋種會送一次自訂事件 `spa_pageview`。Zaraz 的自動 Pageview 只記首次載入，
 *  hash SPA 換頁不會自動算，故在此補送。用獨立事件名（非 'Pageview'）避免與內建自動 Pageview
 *  撞名而重複計數；後台需建一個「Event Name equals spa_pageview」的觸發器掛到 GA 的 Pageview。
 *  用 optional chaining：Zaraz 未載入（含尚未在 Cloudflare 設好）時為 no-op、零風險。 */
function trackPageview() {
  try { window.zaraz?.track('spa_pageview'); } catch { /* 追蹤失敗不可影響對弈 */ }
}

// iOS 版未收錄的棋種 hash（GPL 棋種 + 死活）。舊書籤/殘留 hash 導回首頁，不顯示空畫面。
const IOS_EXCLUDED_HASHES = new Set(['#tsumego', '#xiangqi', '#shogi', '#chess', '#xqpuzzle']);

function applyRoute(animateTitle) {
  let hash = location.hash;
  if (IOS_STORE && IOS_EXCLUDED_HASHES.has(hash)) hash = '#home';
  document.title = ROUTE_TITLES[hash] ? `${ROUTE_TITLES[hash]} · 弈樂` : SITE_TITLE;
  const title = document.querySelector('h1');
  // 被排除棋種以動態 import 進場，並用 `if (!__IOS_STORE__)` 直接守衛（見檔頭）：
  // iOS build 時整段被 esbuild DCE，對應 chunk 不生成、GPL 碼不進包。
  if (hash === '#tsumego') {
    showScreen('tsumego');
    if (title) title.style.visibility = 'visible';
    if (!__IOS_STORE__) import('./tsumego-mode.js').then(m => m.enterTsumegoMode()).catch(err => { console.error('模式載入失敗', err); location.hash = '#home'; });
  } else if (hash === '#gomoku') {
    showScreen('gomoku');
    if (title) title.style.visibility = 'visible';
    enterGomokuMode();
  } else if (hash === '#connect6') {
    showScreen('connect6');
    if (title) title.style.visibility = 'visible';
    enterConnect6Mode();
  } else if (hash === '#xiangqi') {
    showScreen('xiangqi');
    if (title) title.style.visibility = 'visible';
    if (!__IOS_STORE__) import('./xiangqi-mode.js').then(m => m.enterXiangqiMode()).catch(err => { console.error('模式載入失敗', err); location.hash = '#home'; });
  } else if (hash === '#shogi') {
    showScreen('shogi');
    if (title) title.style.visibility = 'visible';
    if (!__IOS_STORE__) import('./shogi-mode.js').then(m => m.enterShogiMode()).catch(err => { console.error('模式載入失敗', err); location.hash = '#home'; });
  } else if (hash === '#chess') {
    showScreen('chess');
    if (title) title.style.visibility = 'visible';
    if (!__IOS_STORE__) import('./chess-mode.js').then(m => m.enterChessMode()).catch(err => { console.error('模式載入失敗', err); location.hash = '#home'; });
  } else if (hash === '#othello') {
    showScreen('othello');
    if (title) title.style.visibility = 'visible';
    enterOthelloMode();
  } else if (hash === '#xqpuzzle') {
    showScreen('xqpuzzle');
    if (title) title.style.visibility = 'visible';
    if (!__IOS_STORE__) import('./xiangqi-puzzle-mode.js').then(m => m.enterXiangqiPuzzleMode()).catch(err => { console.error('模式載入失敗', err); location.hash = '#home'; });
  } else if (hash === '#play') {
    showScreen('play');
    if (title) title.style.visibility = 'visible';
    enterPlayMode();
  } else {
    showScreen('home');
    renderHome();
    initHomeArrows();
    // 首次載入進首頁時標題水墨暈開；經由過渡切換進來則直接靜態顯示（過渡本身已是揭示）
    if (animateTitle) playTitleReveal(title, { force: true });
    else if (title) title.style.visibility = 'visible';
  }
}

window.goHome = goHome;
// 畫面切換用墨暈過渡；過渡覆蓋到中點時才換 DOM。換頁後補送一次 page_view
// （只在 hashchange 觸發＝不含初次載入，避免與 Zaraz 自動 Pageview 雙重計數）。
window.addEventListener('hashchange', () => playTransition(() => { applyRoute(false); trackPageview(); }));
// iOS 版：移除授權彈窗中僅適用 web 版的區塊（死活題庫、象棋殘局題庫、Fairy-Stockfish/GPL）。
if (IOS_STORE) document.querySelectorAll('[data-web-only]').forEach(el => el.remove());
applyRoute(true);   // 初始載入：標題暈開、不走過渡（page_view 由 Zaraz 自動 Pageview 記）
startAmbient();     // 背景墨雲飄動（桌機）
