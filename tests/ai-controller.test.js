// ai-controller.test.js — makeAiController() 的重試／watchdog／恢復行為測試。
//
// 背景（實機回報 bug）：PvC 對弈中，AI 回合的 katagoMove()（→ katago-service.js →
// katago-engine 的 Worker）若因 Worker 意外死掉（iOS 實機常見：WebGPU device lost、記憶體
// 不足被系統砍掉整個 worker）而永遠不 resolve 也不 reject，requestAIMove() 會卡在
// `await katagoMove()` 上動也不動：isAIThinking 永遠卡 true，isGameBusy() 因此擋死玩家
// 所有操作（悔棋／認輸／落子皆無反應），AI 也真的再也不會動——症狀是「AI 突然死掉，
// 兩邊都點不動，不是虛手」。
//
// 根因：katago-engine 的 Worker（client.ts）完全沒掛 onerror/onmessageerror，Worker 真的
// 死掉時沒有人 reject 對應的 pending promise。ai-controller.js 原本的 try/catch 只能接住
// reject，接不住「永遠 pending」。
//
// 修法：加一層 watchdog（withWatchdog），把「永遠不 settle」轉成「逾時視為一次失敗」，
// 讓既有的重試／reset／恢復機制能接手善後，不讓 UI 真的卡死。
const { sandboxWithAiController } = require('./helpers');

/** 建一個可控制、可觀察呼叫紀錄的假 app context（比照 main.js 的 app 物件形狀）。 */
function makeApp(overrides = {}) {
  const state = {
    gameOver: false,
    isAIThinking: false,
    gameMode: 'pvc',
    currentPlayer: 2,   // WHITE：非玩家色，AI 該下
    playerColor: 1,     // BLACK
    aiLevel: 5,
    board: [],
    size: 9,
    moveHistory: [],
    komi: 7.5,
    gameRules: 'chinese',
    aiMoveWatchdogMs: 20, // 測試用短逾時，避免真的等 20 秒
    ...overrides
  };
  const calls = { setAIThinking: [], placeStone: [], doPassCount: 0, setStatus: [] };
  const app = {
    get gameOver() { return state.gameOver; },
    get isAIThinking() { return state.isAIThinking; },
    get gameMode() { return state.gameMode; },
    get currentPlayer() { return state.currentPlayer; },
    get playerColor() { return state.playerColor; },
    get aiLevel() { return state.aiLevel; },
    get board() { return state.board; },
    get size() { return state.size; },
    get moveHistory() { return state.moveHistory; },
    get komi() { return state.komi; },
    get gameRules() { return state.gameRules; },
    get aiMoveWatchdogMs() { return state.aiMoveWatchdogMs; },
    setAIThinking(value) {
      calls.setAIThinking.push(value);
      state.isAIThinking = value;
    },
    syncStatus() {},
    updateUI() {},
    setStatus(msg) { calls.setStatus.push(msg); },
    placeStone(x, y) { calls.placeStone.push([x, y]); return true; }
  };
  Object.defineProperty(app, 'doPass', { value: () => { calls.doPassCount += 1; } });
  return { app, state, calls };
}

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('requestAIMove watchdog：Worker 卡死不 settle 時不永久卡住', () => {
  test('genmoveCandidates 永遠不 resolve → 逾時後 isAIThinking 最終釋放為 false，不會卡死', async () => {
    const mockKataGo = {
      ensureReady: () => Promise.resolve(),
      genmoveCandidates: () => new Promise(() => {}), // 永遠不 settle：模擬 Worker 意外掛掉
      reset: jest.fn()
    };
    const ctx = sandboxWithAiController(mockKataGo);
    const { app, calls } = makeApp();
    const controller = ctx.makeAiController(app);

    const movePromise = controller.requestAIMove();

    // 一開始（同步跑到 katagoMove() 之前）isAIThinking 應已設為 true
    await tick(5);
    expect(app.isAIThinking).toBe(true);

    // 等過兩次 attempt 的 watchdog + 重試延遲（20ms watchdog ×2 + 400ms 重試等待）、
    // 再等一輪自動恢復（1500ms）＋ 第二輪同樣兩次 watchdog，才會走到終局訊息。
    // 用輪詢取代固定 sleep，避免時間抓太緊 flaky。
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const last = calls.setStatus[calls.setStatus.length - 1] || '';
      if (last.includes('請點「開始新遊戲」重試')) break;
      await tick(50);
    }

    const finalStatus = calls.setStatus[calls.setStatus.length - 1] || '';
    expect(finalStatus).toContain('請點「開始新遊戲」重試');
    // 核心迴歸斷言：即使底層 promise 永遠不 settle，isAIThinking 最終仍會被釋放，
    // 不會讓 isGameBusy() 永久擋死玩家操作。
    expect(app.isAIThinking).toBe(false);
    expect(calls.setAIThinking[0]).toBe(true);
    expect(calls.setAIThinking[calls.setAIThinking.length - 1]).toBe(false);
    // 逾時應觸發過引擎 reset（比照既有「AI 連線異常」重試路徑）。
    expect(mockKataGo.reset).toHaveBeenCalled();
    // 從未真的落子（因為從未拿到手）。
    expect(calls.placeStone).toEqual([]);

    return movePromise;
  }, 15000);
});

describe('requestAIMove 正常路徑：watchdog 不誤觸發', () => {
  test('genmoveCandidates 很快 resolve 時，AI 仍正常落子', async () => {
    const mockKataGo = {
      ensureReady: () => Promise.resolve(),
      genmoveCandidates: () => Promise.resolve([{ x: 3, y: 4, pointsLost: 0, order: 0 }]),
      reset: jest.fn()
    };
    const ctx = sandboxWithAiController(mockKataGo);
    const { app, calls } = makeApp();
    const controller = ctx.makeAiController(app);

    await controller.requestAIMove();

    expect(calls.placeStone).toEqual([[3, 4]]);
    expect(app.isAIThinking).toBe(false);
    expect(calls.setAIThinking).toEqual([true, false]);
    expect(mockKataGo.reset).not.toHaveBeenCalled();
  }, 10000);

  test('已在 isAIThinking 時再次呼叫是 no-op（避免重入併發求手）', async () => {
    const mockKataGo = {
      ensureReady: jest.fn(() => Promise.resolve()),
      genmoveCandidates: jest.fn(() => Promise.resolve([{ x: 0, y: 0, pointsLost: 0, order: 0 }])),
      reset: jest.fn()
    };
    const ctx = sandboxWithAiController(mockKataGo);
    const { app } = makeApp({ isAIThinking: true });
    const controller = ctx.makeAiController(app);

    await controller.requestAIMove();

    expect(mockKataGo.ensureReady).not.toHaveBeenCalled();
  });
});

// ——— 非同步邊界回來後重新確認對局仍在進行 ———
// problem class：requestAIMove() 在 `await katagoMove()` 期間，對局可能已被別人推進或換掉
// （計時超時判負、使用者按「開始新遊戲」）。求手回來時若不重新確認，那一手會落在「已經不是
// 當初送出這次求手」的對局上。守門必須在 app.placeStone()／app.doPass() 之前，不能倚賴
// 呼叫端自己擋（main.js 的 placeStone() 雖有 isGameBlocked() 擋 gameOver，但擋不住「已換成
// 另一局」，而且把不變式放在被呼叫端等於每個新呼叫端都要重新踩一次雷）。
describe('requestAIMove 的非同步邊界守門', () => {
  /** 造一個可由測試控制 resolve 時機的 genmoveCandidates。 */
  function deferredKataGo() {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    return {
      mock: {
        ensureReady: () => Promise.resolve(),
        genmoveCandidates: () => pending,
        reset: jest.fn()
      },
      release: (cands) => release(cands)
    };
  }

  function emptyBoard(size = 9) {
    return Array.from({ length: size }, () => new Array(size).fill(0));
  }

  test('求手期間對局結束（計時超時判負）→ 回來後不落子', async () => {
    const { mock, release } = deferredKataGo();
    const ctx = sandboxWithAiController(mock);
    const { app, state, calls } = makeApp({ board: emptyBoard() });
    const controller = ctx.makeAiController(app);

    const movePromise = controller.requestAIMove();
    await tick(5);
    expect(app.isAIThinking).toBe(true);

    // 求手還吊在半空時計時器超時：_timerOnTimeout() → endGame() → markGameOver()。
    state.gameOver = true;
    state.isAIThinking = false;   // markGameOver() 同時解除 lock
    release([{ x: 3, y: 4, pointsLost: 0, order: 0 }]);
    await movePromise;

    expect({ placed: calls.placeStone, passes: calls.doPassCount })
      .toEqual({ placed: [], passes: 0 });
  }, 10000);

  test('求手期間使用者開新局 → 那一手不會落到新局上', async () => {
    const { mock, release } = deferredKataGo();
    const ctx = sandboxWithAiController(mock);
    const { app, state, calls } = makeApp({ board: emptyBoard() });
    const controller = ctx.makeAiController(app);

    const movePromise = controller.requestAIMove();
    await tick(5);

    // 「開始新遊戲」不受 isGameBusy() 守門，AI 思考中也按得下去。GameState.startGame()
    // 會建立全新狀態：board 換成另一個物件、棋譜歸零、lock 也清掉。
    state.board = emptyBoard();
    state.moveHistory = [];
    state.isAIThinking = false;
    release([{ x: 3, y: 4, pointsLost: 0, order: 0 }]);
    await movePromise;

    expect(calls.placeStone).toEqual([]);
  }, 10000);

  test('求手期間對局結束 → 回來後即使該虛手也不虛手', async () => {
    const { mock, release } = deferredKataGo();
    const ctx = sandboxWithAiController(mock);
    const { app, state, calls } = makeApp({ board: emptyBoard() });
    const controller = ctx.makeAiController(app);

    const movePromise = controller.requestAIMove();
    await tick(5);

    state.gameOver = true;
    state.isAIThinking = false;
    release([]);            // 無候選手 → katagoMove() 回傳 { pass: true }
    await movePromise;

    expect(calls.doPassCount).toBe(0);
  }, 10000);

  test('對局未變動時照常落子（守門不誤擋正常路徑）', async () => {
    const { mock, release } = deferredKataGo();
    const ctx = sandboxWithAiController(mock);
    const { app, calls } = makeApp({ board: emptyBoard() });
    const controller = ctx.makeAiController(app);

    const movePromise = controller.requestAIMove();
    await tick(5);
    release([{ x: 3, y: 4, pointsLost: 0, order: 0 }]);
    await movePromise;

    expect(calls.placeStone).toEqual([[3, 4]]);
  }, 10000);
});
