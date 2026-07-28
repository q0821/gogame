// ai-controller.js — AI move requests.
// Imported by main.js; accesses shared mutable state via the `app` context object.
//
// 對手引擎：KataGo（vendored web-katrain，較強且可給誠實評估）。引擎內建
// WebGPU → WASM → CPU 後端 fallback，毋需另一套引擎兜底。
import * as KataGo from './katago-service.js';
import { levelConfig, pickMove } from './adaptive-difficulty.js';

export function makeAiController(app) {
  // 用 KataGo 求一手，依自適應等級做隨機弱化。回傳 {x,y}|{pass:true}。
  async function katagoMove() {
    await KataGo.ensureReady(app.setStatus);
    const cfg = levelConfig(app.aiLevel);
    const cands = await KataGo.genmoveCandidates({
      board: app.board,
      size: app.size,
      currentPlayer: app.currentPlayer,
      moveHistory: app.moveHistory,
      komi: app.komi,
      gameRules: app.gameRules,
      onStatus: app.setStatus,
    }, { visits: cfg.visits });
    if (!cands.length) return { pass: true };
    const m = pickMove(cands, app.aiLevel);
    if (!m || m.pass) return { pass: true };
    return { x: m.x, y: m.y };
  }

  // ——— AI move ———
  // 整輪失敗後自動恢復重試的次數上限（每輪內部已含一次 reset+重試）。
  const MAX_RECOVER = 1;
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
      recoverAttempts = 0; // 成功取得一手，恢復計數歸零

      const remaining = minThinkMs - (Date.now() - thinkStart);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));

      app.setAIThinking(false);
      app.updateUI();

      if (move && !move.pass) app.placeStone(move.x, move.y);
      else app.doPass();

      if (!app.gameOver && !app.isAIThinking) {
        app.updateUI();
      }
    } catch (err) {
      console.error('AI move failed after retries:', err);
      // 重置引擎，讓後續重試／開始新遊戲能重建乾淨 worker 恢復，毋需整頁重整。
      try { KataGo.reset(); } catch { /* noop */ }
      app.setAIThinking(false);
      app.updateUI();
      const detail = (err && err.message) ? err.message : String(err);

      if (recoverAttempts < MAX_RECOVER) {
        // 整輪失敗：引擎已重置，延遲後自動再算一輪，不丟失當前對局。
        recoverAttempts += 1;
        app.setStatus(`AI 發生錯誤（${detail}）— 已重置引擎，自動重試中…`);
        setTimeout(() => requestAIMove(), 1500);
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
