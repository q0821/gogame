// ai-controller.js — AI move requests.
// Imported by main.js; accesses shared mutable state via the `app` context object.
//
// 對手引擎：KataGo（vendored web-katrain，較強且可給誠實評估）。引擎內建
// WebGPU → WASM → CPU 後端 fallback，毋需另一套引擎兜底。
import * as KataGo from './katago-service.js';
import { levelConfig, pickMove } from './adaptive-difficulty.js';
import { isAnalysisRequestCurrent } from './position-estimate.js';
import { inBounds, tryPlaceStone } from './rules.js';

export function makeAiController(app) {
  // 用 KataGo 求一手，依自適應等級做隨機弱化。回傳 {x,y}|{pass:true}。
  async function katagoMove() {
    await KataGo.ensureReady(app.setStatus);
    const cfg = levelConfig(app.aiLevel);
    const position = {
      board: app.board,
      size: app.size,
      currentPlayer: app.currentPlayer,
      moveHistory: app.moveHistory,
      komi: app.komi,
      gameRules: app.gameRules,
      onStatus: app.setStatus,
      koPoint: app.koPoint,
    };
    const cands = await KataGo.genmoveCandidates(position, { visits: cfg.visits });
    if (!cands.length) return { pass: true };
    // 引擎候選也須遵守本局規則；弱化挑手不可選到劫、自殺或已佔位置。
    const legal = cands.filter(m => m.pass || (
      Number.isInteger(m.x) && Number.isInteger(m.y)
      && inBounds(position.size, m.x, m.y)
      && tryPlaceStone(position.board, position.size, m.x, m.y,
        position.currentPlayer, position.koPoint).valid
    ));
    if (!legal.length) throw new Error('AI 回傳的候選手皆為禁著點');
    const m = pickMove(legal, app.aiLevel);
    if (!m || m.pass) return { pass: true };
    return { x: m.x, y: m.y };
  }

  // ——— AI move ———
  // 整輪失敗後自動恢復重試的次數上限（每輪內部已含一次 reset+重試）。
  const MAX_RECOVER = 1;
  // 整輪失敗後自動恢復重試的延遲，讓重置後的引擎有時間就緒。
  const AI_RECOVER_DELAY_MS = 1500;
  let recoverAttempts = 0;

  // Watchdog：katagoMove() 底層是 Worker postMessage/onmessage 配對（katago-service.js →
  // katago-engine/engine/katago/client.ts）。client.ts 完全沒掛 worker.onerror／
  // onmessageerror——若 Worker 執行緒本身意外死掉（iOS 實機常見：WebGPU device lost、
  // 記憶體不足被系統直接砍掉整個 worker），對應的 pending promise 永遠不會 resolve
  // 也不會 reject，katagoMove() 會卡在 await 上動也不動。requestAIMove() 的 try/catch
  // 只能接住「reject」，接不住「永遠 pending」，isAIThinking 會卡 true 到天荒地老，
  // isGameBusy() 因此擋死玩家所有操作、AI 也真的再也不會動——症狀正是「AI 突然死掉、
  // 兩邊都點不動」。加這層逾時把「永遠不 settle」轉成「逾時視為一次失敗」，讓下面既有
  // 的重試／reset／恢復流程能接手，不讓 UI 真的卡死。
  // 可由 app.aiMoveWatchdogMs 覆寫（測試用短逾時，避免測試真的等 20 秒）。
  const AI_MOVE_WATCHDOG_MS = app.aiMoveWatchdogMs ?? 20000;
  function withWatchdog(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`AI 引擎逾時無回應（超過 ${ms}ms，可能是 Worker 已死掉）`));
      }, ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  async function requestAIMove() {
    if (app.gameOver || app.isAIThinking) return;
    // 只有「不是玩家回合」時 AI 才該落子。防止失敗後自動重試的排程在使用者已開新局／
    // 已輪到玩家時誤觸發 AI 幫玩家下子。
    if (app.gameMode === 'pvc' && app.currentPlayer === app.playerColor) return;

    app.setAIThinking(true);
    app.syncStatus();
    app.updateUI();

    // 送出求手前先記下「這一手是為哪一個局面算的」。求手期間對局可能已被別人推進或整個換掉
    // （計時超時判負 → endGame()；使用者按「開始新遊戲」→ GameState.startGame() 建立全新
    // 狀態，這條路徑不受 isGameBusy() 守門），回來時必須重新確認才准落子。
    // 沿用 position-estimate.js 既有的 isAnalysisRequestCurrent()（形勢判斷／建議走法也是
    // 同一個問題類型），不另造第二套機制；board 走物件識別比對，GameState 每次落子／悔棋／
    // 開新局／還原都會換掉 board 物件，識別不同即代表「已經不是當初那一局」。
    const requestBoard = app.board;
    const requestMoveCount = app.moveHistory.length;
    const requestPlayer = app.currentPlayer;

    try {
      // 給人類般的停頓（1–3s），引擎自身運算時間計入其中，避免瞬間落子。
      const thinkStart = Date.now();
      const minThinkMs = 1000 + Math.floor(Math.random() * 2000);

      // 引擎推論偶發失敗（WebGPU device lost / worker 推論錯誤）多為 transient，
      // 重試一次往往就過；重試前 reset 引擎，避免一直用壞掉的 worker。
      const MAX_ATTEMPTS = 2;
      let move = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          move = await withWatchdog(katagoMove(), AI_MOVE_WATCHDOG_MS);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          console.error(`AI move error (attempt ${attempt}/${MAX_ATTEMPTS}):`, err);
          if (attempt < MAX_ATTEMPTS) {
            app.setStatus('AI 連線異常，重置引擎重試中…');
            KataGo.reset();
            await new Promise((r) => setTimeout(r, 400));
          }
        }
      }
      if (lastErr) throw lastErr;

      const remaining = minThinkMs - (Date.now() - thinkStart);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));

      if (!isAnalysisRequestCurrent(app, requestBoard, requestMoveCount, requestPlayer)) return;
      app.setAIThinking(false);
      app.updateUI();

      if (move && !move.pass) {
        if (!app.placeStone(move.x, move.y)) throw new Error('AI 落子被本局規則拒絕');
      } else app.doPass();
      recoverAttempts = 0; // 實際落子成功才算恢復，不能只以取得候選手判定。

      if (!app.gameOver && !app.isAIThinking) {
        app.updateUI();
      }
    } catch (err) {
      if (!isAnalysisRequestCurrent(app, requestBoard, requestMoveCount, requestPlayer)) return;
      console.error('AI move failed after retries:', err);
      // 重置引擎，讓後續重試／開始新遊戲能重建乾淨 worker 恢復，毋需整頁重整。
      try { KataGo.reset(); } catch { /* noop */ }
      app.setAIThinking(false);
      app.updateUI();
      const detail = (err && err.message) ? err.message : String(err);

      if (recoverAttempts < MAX_RECOVER) {
        // 整輪失敗：引擎已重置，延遲後自動再算一輪，不丟失當前對局。
        // 經由 app.scheduleAIMove() 排程（不自己 setTimeout）：這 1.5 秒同樣是「AI 已排程
        // 但還沒開始思考」的窗口，isAIThinking 為 false，不納入 main.js 的排程旗標的話
        // isGameBusy() 會回 false，使用者按虛手會穿過去、該手被記成 AI 的顏色。
        // 與 main.js 的另外 7 個排程點是同一個問題類型，用同一套機制處理。
        recoverAttempts += 1;
        app.setStatus(`AI 發生錯誤（${detail}）— 已重置引擎，自動重試中…`);
        app.scheduleAIMove(AI_RECOVER_DELAY_MS);
      } else {
        // 連自動恢復都失敗（多半是持續性問題），引導開新局；引擎已 reset，新局可恢復。
        recoverAttempts = 0;
        app.setStatus(`AI 持續發生錯誤（${detail}）— 請點「開始新遊戲」重試`);
      }
    }
  }

  return {
    requestAIMove,
  };
}
