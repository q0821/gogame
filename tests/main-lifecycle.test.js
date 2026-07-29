const { sandboxWithMainLifecycle, createMockLocalStorage } = require('./helpers');

const AI_LEVEL_KEY = 'gogame_ai_level';
const SAVE_KEY = 'gogame_state';

function savedGame({
  aiLevel = 9,
  currentPlayer = 1,
  gameMode = 'pvc',
  playerColor = 1,
  timerEnabled = false,
  timerSeconds = { 1: 600, 2: 600 },
  gameOver = false,
  passCount = 0,
  isAIThinking = false
} = {}) {
  const size = 9;
  const board = Array.from({ length: size }, () => Array(size).fill(0));
  board[0][0] = 1;
  return {
    size,
    board,
    currentPlayer,
    captures: { 1: 0, 2: 0 },
    moveHistory: [{ x: 0, y: 0, player: 1, captured: 0 }],
    boardHistory: [],
    koPoint: null,
    passCount,
    gameOver,
    lastMove: [0, 0],
    gameMode,
    playerColor,
    aiLevel,
    timerEnabled,
    timerSeconds,
    gameRules: 'chinese',
    komi: 7.5,
    handicap: 0,
    isReviewing: false,
    currentReviewMove: 0,
    isScoring: false,
    deadStones: [],
    isAIThinking
  };
}

function startTimedGame(sandbox, { minutes = 5, gameMode = 'pvp' } = {}) {
  sandbox.ctx.document.getElementById('timerToggle').checked = true;
  sandbox.ctx.document.getElementById('timerMinutes').value = String(minutes);
  sandbox.ctx.document.getElementById('gameMode').value = gameMode;
  sandbox.ctx.startNewGame();
}

function readSavedGame(localStorage) {
  return JSON.parse(localStorage.getItem(SAVE_KEY));
}

/**
 * 開一局 PvC。playerColor=2（人類執白）時 AI 執黑先手，startNewGame() 會排一次開局求手；
 * 先把該排程跑掉並清空 mock，後續斷言的呼叫次數才只反映被測路徑。
 */
function startPvcGame(sandbox, { playerColor = 1 } = {}) {
  sandbox.ctx.document.getElementById('gameMode').value = 'pvc';
  sandbox.ctx.document.getElementById('playerColor').value = String(playerColor);
  sandbox.ctx.startNewGame();
  sandbox.clock.runTimeouts();
  sandbox.requestAIMove.mockClear();
}

describe('圍棋主流程狀態生命週期', () => {
  test('實際棋譜已有落子時，重新開始會先確認並在取消後保留對局', () => {
    const { ctx, GameState, confirm } = sandboxWithMainLifecycle({ confirmResult: false });
    GameState.applyMove(0, 0);

    ctx.newGame();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(GameState.getState().moveHistory).toHaveLength(1);
    expect(GameState.getState().board[0][0]).toBe(1);
  });

  test('控制項初始化時，持久化 AI 等級會成為 GameState 與顯示的共同值', () => {
    const { GameState, elements } = sandboxWithMainLifecycle({
      storage: { [AI_LEVEL_KEY]: '4' }
    });

    expect(GameState.getState().aiLevel).toBe(4);
    expect(elements.aiLevelDisplay.textContent).toBe('第 4 級（約 16 級）');
    expect(elements.aiManualLevel.value).toBe('4');
  });

  test('手動選級開新局後，GameState 與等級顯示使用新局等級', () => {
    const { ctx, GameState, elements } = sandboxWithMainLifecycle({
      storage: { [AI_LEVEL_KEY]: '4' }
    });
    elements.aiLevelMode.value = 'manual';
    elements.aiManualLevel.value = '6';

    ctx.startNewGame();

    expect(GameState.getState().aiLevel).toBe(6);
    expect(elements.aiLevelDisplay.textContent).toBe('第 6 級（約 11 級）');
    expect(elements.aiManualLevel.value).toBe('6');
  });

  test('載入舊棋局時，跨對局持久化 AI 等級覆蓋 snapshot 並同步控制項', () => {
    const { GameState, elements } = sandboxWithMainLifecycle({
      hash: '#play',
      storage: {
        [AI_LEVEL_KEY]: '4',
        [SAVE_KEY]: JSON.stringify(savedGame({ aiLevel: 9 }))
      }
    });

    expect(GameState.getState().moveHistory).toHaveLength(1);
    expect(GameState.getState().aiLevel).toBe(4);
    expect(elements.aiLevelDisplay.textContent).toBe('第 4 級（約 16 級）');
    expect(elements.aiManualLevel.value).toBe('4');
  });

  // 持久化的 gogame_ai_level 只夾下界，被寫壞成超出上限的值時會原封不動流進 GameState，
  // 再從那裡散到等級顯示、手動選單與新局／恢復對局寫入的控制項值。實際瀏覽器裡
  // <select>.value 收到不存在的選項會靜默變成空字串，等級顯示則會出現「第 999 級」。
  test('持久化 AI 等級超出上限時，GameState 與控制項都夾在合法範圍', () => {
    const { GameState, elements } = sandboxWithMainLifecycle({
      storage: { [AI_LEVEL_KEY]: '999' }
    });

    expect({
      stateAiLevel: GameState.getState().aiLevel,
      display: elements.aiLevelDisplay.textContent,
      manualValue: elements.aiManualLevel.value
    }).toEqual({
      stateAiLevel: 13,
      display: '第 13 級（約 1 級）',
      manualValue: '13'
    });
  });

  test('持久化 AI 等級超出上限時，開新局與恢復對局寫進手動選單的值仍在合法範圍', () => {
    const fresh = sandboxWithMainLifecycle({
      storage: { [AI_LEVEL_KEY]: '999' }
    });
    fresh.ctx.startNewGame(); // 自動模式：新局等級取自 loadAiLevel()

    const restored = sandboxWithMainLifecycle({
      hash: '#play',
      storage: {
        [AI_LEVEL_KEY]: '999',
        [SAVE_KEY]: JSON.stringify(savedGame({ aiLevel: 9 }))
      }
    });

    expect({
      newGameManualValue: fresh.elements.aiManualLevel.value,
      newGameStateAiLevel: fresh.GameState.getState().aiLevel,
      loadedManualValue: restored.elements.aiManualLevel.value,
      loadedStateAiLevel: restored.GameState.getState().aiLevel
    }).toEqual({
      newGameManualValue: '13',
      newGameStateAiLevel: 13,
      loadedManualValue: '13',
      loadedStateAiLevel: 13
    });
  });

  test('計時對局在 pagehide 後重新載入，活動方剩餘時間不會倒退', () => {
    const sharedStorage = createMockLocalStorage();
    const firstPage = sandboxWithMainLifecycle({ sharedStorage, useRealTimer: true });
    startTimedGame(firstPage);
    firstPage.clock.advance(149_000);
    firstPage.clock.tick();
    const beforeReload = firstPage.GameState.getState().timerSeconds[1];
    expect(beforeReload).toBe(151);
    expect(firstPage.elements.blackTimer.textContent).toBe('02:31');

    firstPage.ctx.dispatchEvent({ type: 'pagehide' });
    const secondPage = sandboxWithMainLifecycle({
      sharedStorage,
      hash: '#play',
      useRealTimer: true,
      now: 1_149_000
    });

    expect(secondPage.GameState.getState().timerSeconds[1]).toBeLessThanOrEqual(beforeReload);
    expect(secondPage.elements.blackTimer.textContent).toBe('02:31');
  });

  test('頁面進入 hidden 時，活動方最新秒數會寫入 snapshot', () => {
    const sandbox = sandboxWithMainLifecycle({ useRealTimer: true });
    startTimedGame(sandbox);
    sandbox.clock.advance(55_000);
    sandbox.ctx.document.visibilityState = 'hidden';

    sandbox.ctx.document.dispatchEvent({ type: 'visibilitychange' });

    expect(readSavedGame(sandbox.localStorage).timerSeconds['1']).toBe(245);
  });

  test('載入未終局的計時對局後，目前玩家會繼續走鐘', () => {
    const sandbox = sandboxWithMainLifecycle({
      hash: '#play',
      useRealTimer: true,
      storage: {
        [SAVE_KEY]: JSON.stringify(savedGame({
          gameMode: 'pvp',
          timerEnabled: true,
          timerSeconds: { 1: 151, 2: 300 }
        }))
      }
    });
    sandbox.clock.advance(1_000);

    sandbox.clock.tick();

    expect(sandbox.GameState.getState().timerSeconds[1]).toBe(150);
    expect(sandbox.GameState.getState().timerSeconds[2]).toBe(300);
  });

  test('計時歸零後，snapshot 保存 0 秒與已終局狀態', () => {
    const sandbox = sandboxWithMainLifecycle({ useRealTimer: true });
    startTimedGame(sandbox, { minutes: 1 });
    sandbox.clock.advance(60_000);

    sandbox.clock.tick();

    expect(sandbox.GameState.getState().gameOver).toBe(true);
    expect(readSavedGame(sandbox.localStorage)).toMatchObject({
      gameOver: true,
      timerSeconds: { 1: 0, 2: 60 }
    });
  });

  test('計時悔棋後，PvP 與 PvC 都只為還原後的目前玩家走鐘', () => {
    const actual = ['pvp', 'pvc'].map((gameMode) => {
      const sandbox = sandboxWithMainLifecycle({ useRealTimer: true });
      startTimedGame(sandbox, { gameMode });
      sandbox.GameState.applyMove(0, 0);
      sandbox.GameState.applyMove(1, 0);

      sandbox.ctx.doUndo();
      sandbox.clock.advance(5_000);
      sandbox.clock.tick();

      const state = sandbox.GameState.getState();
      return {
        gameMode,
        currentPlayer: state.currentPlayer,
        blackSeconds: state.timerSeconds[1],
        whiteSeconds: state.timerSeconds[2]
      };
    });

    expect(actual).toEqual([
      { gameMode: 'pvp', currentPlayer: 2, blackSeconds: 300, whiteSeconds: 295 },
      { gameMode: 'pvc', currentPlayer: 1, blackSeconds: 295, whiteSeconds: 300 }
    ]);
  });

  test('取消數目後，目前玩家重新走鐘且取消狀態會儲存', () => {
    const sandbox = sandboxWithMainLifecycle({ useRealTimer: true });
    startTimedGame(sandbox);
    sandbox.ctx.doPass();
    sandbox.ctx.finishGame();
    expect(sandbox.GameState.getState().isScoring).toBe(true);

    sandbox.ctx.cancelScoring();
    sandbox.clock.advance(5_000);
    sandbox.clock.tick();

    const state = sandbox.GameState.getState();
    const snapshot = readSavedGame(sandbox.localStorage);
    expect({
      currentPlayer: state.currentPlayer,
      blackSeconds: state.timerSeconds[1],
      whiteSeconds: state.timerSeconds[2],
      savedPassCount: snapshot.passCount,
      savedIsScoring: snapshot.isScoring
    }).toEqual({
      currentPlayer: 2,
      blackSeconds: 300,
      whiteSeconds: 295,
      savedPassCount: 0,
      savedIsScoring: false
    });
  });

  test('進入數目前先保存最新計時，pagehide 與 hidden 期間重新載入停在數目狀態且秒數不再流逝', () => {
    const sharedStorage = createMockLocalStorage();
    const firstPage = sandboxWithMainLifecycle({ sharedStorage, useRealTimer: true });
    startTimedGame(firstPage);
    firstPage.ctx.doPass();
    firstPage.clock.advance(55_000);

    firstPage.ctx.finishGame();
    expect(firstPage.GameState.getState().isScoring).toBe(true);
    firstPage.ctx.dispatchEvent({ type: 'pagehide' });
    firstPage.ctx.document.visibilityState = 'hidden';
    firstPage.ctx.document.dispatchEvent({ type: 'visibilitychange' });

    const secondPage = sandboxWithMainLifecycle({
      sharedStorage,
      hash: '#play',
      useRealTimer: true,
      now: 1_055_000
    });
    expect(secondPage.GameState.getState()).toMatchObject({
      currentPlayer: 2,
      passCount: 1,
      gameOver: false,
      // 數目狀態現在會持久化並還原（見「數目狀態持久化」一節）。此測試的核心是計時：
      // 進入數目時已停鐘定格，pagehide／hidden 期間的 checkpoint 不得再改動秒數。
      isScoring: true,
      timerSeconds: { 1: 300, 2: 245 }
    });
  });

  test('非計時對局取消數目後，重新載入會保留已取消狀態', () => {
    const sharedStorage = createMockLocalStorage();
    const firstPage = sandboxWithMainLifecycle({ sharedStorage });
    firstPage.ctx.document.getElementById('gameMode').value = 'pvp';
    firstPage.ctx.startNewGame();
    firstPage.ctx.doPass();
    firstPage.ctx.finishGame();

    firstPage.ctx.cancelScoring();

    const secondPage = sandboxWithMainLifecycle({ sharedStorage, hash: '#play' });
    expect(secondPage.GameState.getState()).toMatchObject({
      passCount: 0,
      gameOver: false,
      isScoring: false
    });
  });

  test('載入 AI 思考中的計時 snapshot 會清除舊 lock，並讓 AI 求手排程進入 controller 邊界', () => {
    const sandbox = sandboxWithMainLifecycle({
      hash: '#play',
      useRealTimer: true,
      storage: {
        [SAVE_KEY]: JSON.stringify(savedGame({
          currentPlayer: 2,
          gameMode: 'pvc',
          playerColor: 1,
          timerEnabled: true,
          timerSeconds: { 1: 300, 2: 245 },
          isAIThinking: true
        }))
      }
    });

    expect(sandbox.GameState.getState().isAIThinking).toBe(false);
    sandbox.clock.runTimeouts();
    expect(sandbox.requestAIMove).toHaveBeenCalledTimes(1);
  });

  test('雙虛手觸發數目後重新載入，currentPlayer 與 passCount 回到合法可續弈狀態', () => {
    const sharedStorage = createMockLocalStorage();
    const firstPage = sandboxWithMainLifecycle({ sharedStorage });
    firstPage.ctx.document.getElementById('gameMode').value = 'pvp';
    firstPage.ctx.startNewGame();

    firstPage.ctx.doPass(); // 黑虛手：currentPlayer -> 白
    firstPage.ctx.doPass(); // 白虛手：雙虛手，進入數目
    expect(firstPage.GameState.getState().isScoring).toBe(true);

    const secondPage = sandboxWithMainLifecycle({ sharedStorage, hash: '#play' });
    const restored = secondPage.GameState.getState();
    expect(restored).toMatchObject({
      currentPlayer: 1, // 黑：白剛虛手完，下一手輪到黑
      passCount: 0,
      isScoring: true,  // 數目狀態會持久化並還原（見「數目狀態持久化」一節）
      gameOver: false
    });
    // 上面 currentPlayer／passCount／gameOver 與「全新一局」同值，單靠它們無法分辨
    // 「還原了雙虛手 snapshot」與「根本沒載入、開了新局」；用棋譜長度／內容釘住
    // 確實載入的是雙虛手那一局。
    expect(restored.moveHistory.map((m) => ({ player: m.player, pass: !!m.pass }))).toEqual([
      { player: 1, pass: true },
      { player: 2, pass: true }
    ]);

    // 取消數目回到對局後，再虛手一次不應該立即被判定為雙虛手終局
    //（passCount 不應殘留在 2）。
    secondPage.ctx.cancelScoring();
    secondPage.ctx.doPass();
    expect(secondPage.GameState.getState()).toMatchObject({
      isScoring: false,
      passCount: 1
    });
  });

  test('雙虛手觸發數目後重新載入，悔棋會回到「只有黑虛手一次」的自洽狀態', () => {
    const sharedStorage = createMockLocalStorage();
    const firstPage = sandboxWithMainLifecycle({ sharedStorage });
    firstPage.ctx.document.getElementById('gameMode').value = 'pvp';
    firstPage.ctx.startNewGame();

    firstPage.ctx.doPass(); // 黑虛手
    firstPage.ctx.doPass(); // 白虛手，雙虛手，進入數目

    const secondPage = sandboxWithMainLifecycle({ sharedStorage, hash: '#play' });
    secondPage.ctx.document.getElementById('undoToggle').checked = true;
    // 還原後停在數目狀態（見「數目狀態持久化」一節），doUndo() 走 isGameBusy() 會被
    // isScoring 擋住，先取消數目回到對局。
    secondPage.ctx.cancelScoring();

    secondPage.ctx.doUndo(); // 悔掉白的虛手

    expect(secondPage.GameState.getState()).toMatchObject({
      currentPlayer: 2, // 白：悔掉白虛手後，回到白虛手前、輪白落子
      passCount: 1,      // 只剩黑那一次虛手
      isScoring: false
    });
    expect(secondPage.GameState.getState().moveHistory).toHaveLength(1);
    expect(secondPage.GameState.getState().moveHistory[0]).toMatchObject({ player: 1, pass: true });
  });

  test('雙虛手後取消數目，currentPlayer 回到正確的下一位落子方', () => {
    const sandbox = sandboxWithMainLifecycle({});
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();

    sandbox.ctx.doPass(); // 黑虛手
    sandbox.ctx.doPass(); // 白虛手，雙虛手進入數目
    expect(sandbox.GameState.getState().isScoring).toBe(true);

    sandbox.ctx.cancelScoring();

    expect(sandbox.GameState.getState()).toMatchObject({
      currentPlayer: 1, // 黑：取消數目後應輪到黑，而非讓白再下一手
      passCount: 0,
      isScoring: false
    });
  });

  test('PvC 雙虛手取消數目後，輪到 AI 就排求手、輪到人類就不排', () => {
    const actual = [1, 2].map((playerColor) => {
      const sandbox = sandboxWithMainLifecycle({ useRealTimer: true });
      startPvcGame(sandbox, { playerColor });

      sandbox.ctx.doPass(); // 黑虛手（人類執黑時是人類；人類執白時是 AI）
      // 人類執黑時，上一手虛手後會排一次 AI 求手，該排程窗口內 isGameBusy() 為 true，
      // 第二次 doPass() 會被擋掉（正是排程旗標要擋的事）。先把排程跑掉，模擬「AI 回合
      // 真的來了」，第二手虛手才是合法的下一步。
      sandbox.clock.runTimeouts();
      sandbox.ctx.doPass(); // 白虛手 → 雙虛手進入數目
      expect(sandbox.GameState.getState().isScoring).toBe(true);
      sandbox.clock.runTimeouts();
      sandbox.requestAIMove.mockClear();

      sandbox.ctx.cancelScoring();
      sandbox.clock.runTimeouts();

      const state = sandbox.GameState.getState();
      return {
        playerColor,
        currentPlayer: state.currentPlayer,
        aiCalls: sandbox.requestAIMove.mock.calls.length,
        moveHistory: state.moveHistory.map((m) => ({ player: m.player, pass: !!m.pass }))
      };
    });

    // 棋譜必須恰好是「黑虛手、白虛手」，不會多出顏色掛錯的第三手虛手。
    const doublePass = [{ player: 1, pass: true }, { player: 2, pass: true }];
    expect(actual).toEqual([
      // 人類執黑：AI 是第二個虛手方，取消後輪回人類，不該叫 AI。
      { playerColor: 1, currentPlayer: 1, aiCalls: 0, moveHistory: doublePass },
      // 人類執白：人類是第二個虛手方，取消後輪到 AI（黑），沒人叫 AI 棋局就停住。
      { playerColor: 2, currentPlayer: 1, aiCalls: 1, moveHistory: doublePass }
    ]);
  });

  test('雙虛手取消數目後，UI 層收到的回合與 GameState 一致', () => {
    const sandbox = sandboxWithMainLifecycle({});
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();

    sandbox.ctx.doPass(); // 黑虛手 → UI 收到「輪白」
    sandbox.ctx.doPass(); // 白虛手 → 雙虛手進入數目（此路徑不經 updateUI）
    expect(sandbox.GameState.getState().isScoring).toBe(true);

    sandbox.ctx.cancelScoring();

    // 回合徽章（#mobileTurn）的唯一寫入點是 ui.js 的 updateHUD()，而 updateHUD() 只由
    // updateUI() 呼叫。取消數目後 currentPlayer 已換手成黑，若沒有把最新狀態送進 UI 層，
    // 徽章會停在上一次寫入的「白方」，使用者以為輪白、點下去卻出現黑子。
    const state = sandbox.GameState.getState();
    const lastHud = sandbox.hudUpdates[sandbox.hudUpdates.length - 1];
    expect({
      uiCurrentPlayer: lastHud.currentPlayer,
      stateCurrentPlayer: state.currentPlayer
    }).toEqual({
      uiCurrentPlayer: 1,
      stateCurrentPlayer: 1
    });
  });

  test('雙虛手進入數目後，UI 層收到的回合與手數等於 GameState 實際值', () => {
    const sandbox = sandboxWithMainLifecycle({});
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();
    sandbox.GameState.applyMove(0, 0); // 黑第 1 手
    sandbox.GameState.applyMove(1, 0); // 白第 2 手

    sandbox.ctx.doPass(); // 黑虛手（第 3 手）→ UI 收到「輪白、3 手」
    sandbox.ctx.doPass(); // 白虛手（第 4 手）→ 雙虛手進入數目，此路徑不經 doPass() 的 updateUI()
    expect(sandbox.GameState.getState().isScoring).toBe(true);

    // applyPass() 已換手並多記一手；進入數目那一刻若沒把最新狀態推給資訊列，
    // #mobileTurn 會停在「白方」、#mobileMoveCount 停在 3，直到取消數目或終局才更新。
    const state = sandbox.GameState.getState();
    const lastHud = sandbox.hudUpdates[sandbox.hudUpdates.length - 1];
    expect({
      uiCurrentPlayer: lastHud.currentPlayer,
      uiMoveCount: lastHud.moveCount,
      stateCurrentPlayer: state.currentPlayer,
      stateMoveCount: state.moveHistory.length
    }).toEqual({
      uiCurrentPlayer: 1,
      uiMoveCount: 4,
      stateCurrentPlayer: 1,
      stateMoveCount: 4
    });
    // 數目期間沒有 AI 在算下一手，思考遮罩不該被打開。
    expect(sandbox.elements.aiThinkingOverlay.style.display).toBe('none');
  });

  test('「申請數目」進入數目後，UI 層收到的值與 GameState 一致（該路徑不動 currentPlayer）', () => {
    const sandbox = sandboxWithMainLifecycle({});
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();
    sandbox.GameState.applyMove(0, 0); // 黑第 1 手
    sandbox.GameState.applyMove(1, 0); // 白第 2 手
    sandbox.ctx.doPass();              // 黑虛手（第 3 手）→ UI 收到「輪白、3 手」

    sandbox.ctx.finishGame();          // 申請數目：不動 currentPlayer、不加手數
    expect(sandbox.GameState.getState().isScoring).toBe(true);

    const state = sandbox.GameState.getState();
    const lastHud = sandbox.hudUpdates[sandbox.hudUpdates.length - 1];
    expect({
      uiCurrentPlayer: lastHud.currentPlayer,
      uiMoveCount: lastHud.moveCount,
      stateCurrentPlayer: state.currentPlayer,
      stateMoveCount: state.moveHistory.length
    }).toEqual({
      uiCurrentPlayer: 2,
      uiMoveCount: 3,
      stateCurrentPlayer: 2,
      stateMoveCount: 3
    });
  });

  // ——— 資訊列 DOM 實際內容（真實 ui.js 渲染層，端到端）———
  // 上面幾個測試斷言的是「main.js 送進 UI 層的資料」，攔在 updateHUD() 的入口。
  // 以下改斷言「真實 ui.js 寫進 DOM 之後的文字」，補上渲染層本身的覆蓋——
  // 終局徽章顯示錯誤的一方，正是先前只靠瀏覽器 smoke 才抓到的缺陷類型。
  test('終局後 #mobileTurn 顯示「遊戲結束」而非某一方的回合', () => {
    const sandbox = sandboxWithMainLifecycle({});
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();
    sandbox.ctx.doPass(); // 黑虛手
    sandbox.ctx.doPass(); // 白虛手 → 雙虛手進入數目
    sandbox.ctx.confirmScoring();

    // 防斷言落空：確認真的走到終局，否則下面的徽章斷言只是在測初始值。
    expect(sandbox.GameState.getState().gameOver).toBe(true);
    expect(sandbox.elements.mobileTurn.textContent).toBe('遊戲結束');
    expect(sandbox.elements.mobileTurn.className).toBe('turn-badge');
  });

  test('數目期間 #mobileTurn 仍顯示當手方，狀態列改顯示數目提示', () => {
    const sandbox = sandboxWithMainLifecycle({});
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();
    sandbox.ctx.doPass(); // 黑虛手 → 輪白
    sandbox.ctx.doPass(); // 白虛手 → 雙虛手進入數目，換手回黑

    expect(sandbox.GameState.getState().isScoring).toBe(true);
    // updateHUD() 沒有 isScoring 分支：徽章照常顯示當手方，數目的提示走狀態列。
    expect(sandbox.elements.mobileTurn.textContent).toBe('黑方');
    expect(sandbox.elements.mobileTurn.className).toBe('turn-badge black');
    // 進入數目先同步寫下「AI 數目中…」，待 KataGo 死子估算的 promise 回來才改寫成
    // 「已自動估算死子…」。此處是同步時點，斷言的就是前者（getStatusMessage 的
    // isScoring 分支另在 tests/ui.test.js 直接覆蓋）。
    expect(sandbox.elements.mobileStatus.textContent).toBe('AI 數目中…');
  });

  test('一般對局時提子數與手數的 DOM 文字與 GameState 一致', () => {
    const sandbox = sandboxWithMainLifecycle({});
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();
    // 黑 (0,0) 在角上只有兩口氣；白補上 (0,1)(1,0) 兩口，第 4 手真的提掉一子。
    sandbox.GameState.applyMove(0, 0); // 黑 (0,0)
    sandbox.GameState.applyMove(0, 1); // 白，堵第一口氣
    sandbox.GameState.applyMove(5, 5); // 黑，別處
    sandbox.GameState.applyMove(1, 0); // 白，堵第二口氣 → 提黑一子
    sandbox.ctx.doPass();              // 黑虛手（第 5 手），讓 main.js 走一次 updateUI()

    const state = sandbox.GameState.getState();
    // 防斷言落空：提子數若是 0，下面的「與 GameState 一致」用兩個 0 也會通過，
    // 等於連「有沒有讀錯邊」都測不出來。先確認真的提到子、而且提子記在白方名下。
    expect(state.board[0][0]).toBe(0);
    expect(state.captures).toEqual({ 1: 0, 2: 1 });

    expect({
      blackCap: sandbox.elements.mobileBlackCap.textContent,
      whiteCap: sandbox.elements.mobileWhiteCap.textContent,
      moves: sandbox.elements.mobileMoveCount.textContent,
      turn: sandbox.elements.mobileTurn.textContent
    }).toEqual({
      blackCap: state.captures[1],
      whiteCap: state.captures[2],
      moves: state.moveHistory.length,
      turn: '白方'
    });
  });

  // ——— 終局入口的資訊列同步 ———
  // 盤上狀態轉成 gameOver=true 的入口只有 endGame()（GameState.markGameOver() 的唯一呼叫點），
  // 認輸、超時、確認數目三條路徑都收斂到它；loadGame() 與 doUndo() 也能還原出 gameOver=true，
  // 但那兩條各自已呼叫 updateUI()。因此以下每個入口都斷言「UI 層最後收到的狀態＝GameState」。
  // 註：ui.js 的 updateHUD() 在 gameOver 時把 #mobileTurn 寫成「遊戲結束」，不再顯示某一方的
  // 回合，所以這裡連 gameOver 旗標一起斷言——徽章文字由該旗標決定。
  test('認輸終局後，UI 層收到的狀態與 GameState 一致', () => {
    const sandbox = sandboxWithMainLifecycle({});
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();
    sandbox.GameState.applyMove(0, 0); // 黑第 1 手 → 輪白

    sandbox.ctx.doResign();

    const state = sandbox.GameState.getState();
    const lastHud = sandbox.hudUpdates[sandbox.hudUpdates.length - 1];
    expect({
      uiGameOver: lastHud.gameOver,
      uiCurrentPlayer: lastHud.currentPlayer,
      uiMoveCount: lastHud.moveCount,
      stateGameOver: state.gameOver,
      stateCurrentPlayer: state.currentPlayer,
      stateMoveCount: state.moveHistory.length
    }).toEqual({
      uiGameOver: true,
      uiCurrentPlayer: 2,
      uiMoveCount: 1,
      stateGameOver: true,
      stateCurrentPlayer: 2,
      stateMoveCount: 1
    });
  });

  test('雙虛手進入數目、確認結果終局後，UI 層收到的狀態與 GameState 一致', () => {
    const sandbox = sandboxWithMainLifecycle({});
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();
    sandbox.GameState.applyMove(0, 0); // 黑第 1 手
    sandbox.GameState.applyMove(1, 0); // 白第 2 手
    sandbox.ctx.doPass();              // 黑虛手（第 3 手）
    sandbox.ctx.doPass();              // 白虛手（第 4 手）→ 雙虛手進入數目
    expect(sandbox.GameState.getState().isScoring).toBe(true);

    sandbox.ctx.confirmScoring();

    const state = sandbox.GameState.getState();
    const lastHud = sandbox.hudUpdates[sandbox.hudUpdates.length - 1];
    expect({
      uiGameOver: lastHud.gameOver,
      uiCurrentPlayer: lastHud.currentPlayer,
      uiMoveCount: lastHud.moveCount,
      stateGameOver: state.gameOver,
      stateCurrentPlayer: state.currentPlayer,
      stateMoveCount: state.moveHistory.length
    }).toEqual({
      uiGameOver: true,
      uiCurrentPlayer: 1,
      uiMoveCount: 4,
      stateGameOver: true,
      stateCurrentPlayer: 1,
      stateMoveCount: 4
    });
  });

  // 與上一條共用同一段 production 路徑（confirmScoring() → endGame()），差別只在進入數目的
  // 方式：這條走「申請數目」按鈕，不換手也不加手數，因此期望值與雙虛手那條不同。
  test('「申請數目」後確認結果終局，UI 層收到的狀態與 GameState 一致', () => {
    const sandbox = sandboxWithMainLifecycle({});
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();
    sandbox.GameState.applyMove(0, 0); // 黑第 1 手
    sandbox.GameState.applyMove(1, 0); // 白第 2 手
    sandbox.ctx.finishGame();
    expect(sandbox.GameState.getState().isScoring).toBe(true);

    sandbox.ctx.confirmScoring();

    const state = sandbox.GameState.getState();
    const lastHud = sandbox.hudUpdates[sandbox.hudUpdates.length - 1];
    expect({
      uiGameOver: lastHud.gameOver,
      uiCurrentPlayer: lastHud.currentPlayer,
      uiMoveCount: lastHud.moveCount,
      stateGameOver: state.gameOver,
      stateCurrentPlayer: state.currentPlayer,
      stateMoveCount: state.moveHistory.length
    }).toEqual({
      uiGameOver: true,
      uiCurrentPlayer: 1,
      uiMoveCount: 2,
      stateGameOver: true,
      stateCurrentPlayer: 1,
      stateMoveCount: 2
    });
  });

  test('計時歸零終局後，UI 層收到的狀態與 GameState 一致', () => {
    const sandbox = sandboxWithMainLifecycle({ useRealTimer: true });
    startTimedGame(sandbox, { minutes: 1 });
    sandbox.clock.advance(60_000);

    sandbox.clock.tick(); // 黑方時間歸零 → onTimeout → endGame()

    const state = sandbox.GameState.getState();
    const lastHud = sandbox.hudUpdates[sandbox.hudUpdates.length - 1];
    expect({
      uiGameOver: lastHud.gameOver,
      uiCurrentPlayer: lastHud.currentPlayer,
      uiMoveCount: lastHud.moveCount,
      stateGameOver: state.gameOver,
      stateCurrentPlayer: state.currentPlayer,
      stateMoveCount: state.moveHistory.length
    }).toEqual({
      uiGameOver: true,
      uiCurrentPlayer: 1,
      uiMoveCount: 0,
      stateGameOver: true,
      stateCurrentPlayer: 1,
      stateMoveCount: 0
    });
  });

  test('計時對局後開一局不計時新局，不會把上一局剩餘秒數帶進新局', () => {
    const sandbox = sandboxWithMainLifecycle({ useRealTimer: true });
    startTimedGame(sandbox, { minutes: 5 });
    sandbox.clock.advance(60_000);
    sandbox.clock.tick();
    expect(sandbox.GameState.getState().timerSeconds[1]).toBe(240);

    sandbox.ctx.document.getElementById('timerToggle').checked = false;
    sandbox.ctx.startNewGame();

    // 新局是 startGame() 寫入的 600／600；停掉上一局的鐘不該把舊局殘餘秒數回寫進新局狀態，
    // 也不該被存進 snapshot。
    const state = sandbox.GameState.getState();
    const snapshot = readSavedGame(sandbox.localStorage);
    expect({ live: state.timerSeconds, saved: snapshot.timerSeconds }).toEqual({
      live: { 1: 600, 2: 600 },
      saved: { 1: 600, 2: 600 }
    });
  });

  test('計時對局後再開一局不同時長的計時新局，雙方時鐘全部重置且只有當手方倒數', () => {
    const sandbox = sandboxWithMainLifecycle({ useRealTimer: true });
    startTimedGame(sandbox, { minutes: 5 });
    sandbox.clock.advance(60_000);
    sandbox.clock.tick();
    expect(sandbox.GameState.getState().timerSeconds).toEqual({ 1: 240, 2: 300 });

    // 直接接一局 3 分鐘的計時新局（計時 → 計時，兩局時長不同）。
    startTimedGame(sandbox, { minutes: 3 });

    const started = sandbox.GameState.getState();
    expect({
      seconds: started.timerSeconds,
      enabled: started.timerEnabled,
      saved: readSavedGame(sandbox.localStorage).timerSeconds,
      // GoTimer.updateDisplay() 是 #blackTimer/#whiteTimer 的唯一寫入點；
      // 狀態重置但畫面停在舊局殘值同樣是使用者看得到的 bug，所以連 DOM 一起釘。
      blackDisplay: sandbox.elements.blackTimer.textContent,
      whiteDisplay: sandbox.elements.whiteTimer.textContent
    }).toEqual({
      seconds: { 1: 180, 2: 180 },
      enabled: true,
      saved: { 1: 180, 2: 180 },
      blackDisplay: '03:00',
      whiteDisplay: '03:00'
    });

    // 只有當手方（黑）在走鐘，白方維持定格。
    sandbox.clock.advance(1_000);
    sandbox.clock.tick();
    expect(sandbox.GameState.getState().timerSeconds).toEqual({ 1: 179, 2: 180 });
    expect(sandbox.elements.blackTimer.textContent).toBe('02:59');

    // 釘住 wall-clock 的冪等性：剩餘秒數由「這手起始時間戳 + 起始剩餘」回推，
    // 不是每 tick 減一。所以不推進時間、連 tick 兩次，秒數必須完全不動；
    // 會動就代表有人改回了「把 tick 次數當時間來源」的算法（＝重複扣秒）。
    //
    // 注意這條**守不住 interval 清理**：正因為算式冪等，上一局殘留的 interval 多跑
    // 幾輪也會算出同樣的數字。實測拿掉 GoTimer.stop() 的 clearInterval 後本測試照樣全綠，
    // 變紅的是 tests/timer.test.js 的「時間到觸發 onTimeout、定格 0、停鐘」——
    // interval 清理由那條守，兩者分工不同，別把本測試當成它的替代品。
    sandbox.clock.tick();
    sandbox.clock.tick();
    expect(sandbox.GameState.getState().timerSeconds).toEqual({ 1: 179, 2: 180 });
  });

  test('PvC 悔棋後輪到 AI 就排求手、輪到人類就不排', () => {
    const actual = [1, 2].map((playerColor) => {
      const sandbox = sandboxWithMainLifecycle({ useRealTimer: true });
      startPvcGame(sandbox, { playerColor });
      sandbox.GameState.applyMove(0, 0); // 黑第一手
      sandbox.GameState.applyMove(1, 0); // 白第二手

      sandbox.ctx.doUndo(); // PvC 一次悔兩手
      sandbox.clock.runTimeouts();

      const state = sandbox.GameState.getState();
      return {
        playerColor,
        currentPlayer: state.currentPlayer,
        moves: state.moveHistory.length,
        aiCalls: sandbox.requestAIMove.mock.calls.length
      };
    });

    expect(actual).toEqual([
      // 人類執黑：悔兩手後回到開局，仍輪人類，不該叫 AI。
      { playerColor: 1, currentPlayer: 1, moves: 0, aiCalls: 0 },
      // 人類執白：AI 執黑先手，悔兩手後回到開局仍輪 AI，沒人叫 AI 棋局就停住。
      { playerColor: 2, currentPlayer: 1, moves: 0, aiCalls: 1 }
    ]);
  });

  // ——— AI 求手排程窗口（「已排程但還沒開始思考」）———
  // AI 求手一律經 setTimeout 延遲 100ms（AI_MOVE_DELAY_MS）或 300ms（AI_INIT_DELAY_MS）
  // 才真的開始。這段窗口內 isAIThinking 還是 false、gameOver／isScoring 也都 false，
  // isGameBusy() 因此回 false，使用者的虛手／認輸等操作會整個穿過去（虛手那一手還會被
  // 記成 AI 的顏色，污染棋譜與 SGF 匯出）。排程旗標就是要讓這段窗口也算「忙碌」。
  describe('AI 求手排程窗口', () => {
    test('排程窗口內按虛手不會穿過去', () => {
      const sandbox = sandboxWithMainLifecycle({});
      startPvcGame(sandbox, { playerColor: 1 });

      sandbox.ctx.doPass();   // 人類（黑）虛手 → 輪 AI（白），排一次求手
      sandbox.ctx.doPass();   // 排程窗口內再按一次：這手若穿過去會被記成白（AI）的虛手

      const state = sandbox.GameState.getState();
      expect({
        moves: state.moveHistory.length,
        passCount: state.passCount,
        isScoring: state.isScoring
      }).toEqual({ moves: 1, passCount: 1, isScoring: false });

      // 排程本身仍要照常執行，別把窗口關成「AI 永遠不動」。
      sandbox.clock.runTimeouts();
      expect(sandbox.requestAIMove).toHaveBeenCalledTimes(1);
    });

    test('排程執行後旗標即解除，操作重新可用', () => {
      const sandbox = sandboxWithMainLifecycle({});
      startPvcGame(sandbox, { playerColor: 1 });

      sandbox.ctx.doPass();     // 排一次 AI 求手
      sandbox.ctx.doResign();   // 窗口內：認輸應被擋（doResign 走 isGameBusy()）
      const blocked = sandbox.GameState.getState().gameOver;

      sandbox.clock.runTimeouts();  // 排程執行，旗標必須在此解除
      sandbox.ctx.doResign();       // 旗標若卡住，這裡也會被擋 → 棋盤永遠點不動
      const afterRelease = sandbox.GameState.getState().gameOver;

      expect({ blocked, afterRelease }).toEqual({ blocked: false, afterRelease: true });
    });

    test('取消數目連呼叫兩次只排一次 AI 求手', () => {
      const sandbox = sandboxWithMainLifecycle({});
      startPvcGame(sandbox, { playerColor: 1 });
      sandbox.GameState.applyMove(0, 0);   // 黑（人類）一手 → 輪白（AI）
      sandbox.ctx.finishGame();            // 申請數目
      expect(sandbox.GameState.getState().isScoring).toBe(true);

      sandbox.ctx.cancelScoring();
      sandbox.ctx.cancelScoring();         // 冪等性：第二次不該再排一次
      sandbox.clock.runTimeouts();

      expect(sandbox.requestAIMove).toHaveBeenCalledTimes(1);
    });

    test('開新局會取消舊局殘留的 AI 排程', () => {
      const sandbox = sandboxWithMainLifecycle({});
      startPvcGame(sandbox, { playerColor: 1 });
      sandbox.ctx.doPass();          // 舊局排了一次 AI 求手，尚未執行

      sandbox.ctx.startNewGame();    // 新局人類執黑先手，不需要 AI 求手
      sandbox.clock.runTimeouts();
      // 舊局的排程若沒被取消，會對著新局叫一次 AI。
      expect(sandbox.requestAIMove).toHaveBeenCalledTimes(0);

      // 且旗標不能被舊局的排程卡住，否則新局從第一手就點不動。
      sandbox.ctx.doPass();
      expect(sandbox.GameState.getState().moveHistory).toHaveLength(1);
    });
  });

  // ——— 數目狀態的持久化與還原 ———
  // getSnapshot()／restoreSnapshot() 早就有 isScoring 與 deadStones 兩個欄位（格式不動、
  // 不需 migration）；卡住的是 saveGame() 遇到 isScoring 就早退，所以 isScoring: true
  // 從來寫不出去，數目期間 reload 會退回對局狀態。
  describe('數目狀態持久化', () => {
    /** 開一局 pvp、下一手、申請數目，回傳停在數目畫面的 sandbox。 */
    function gameInScoring(sharedStorage) {
      const sandbox = sandboxWithMainLifecycle({ sharedStorage, hash: '#play' });
      sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
      sandbox.ctx.startNewGame();
      sandbox.GameState.applyMove(4, 4);
      sandbox.ctx.finishGame();
      return sandbox;
    }

    test('進入數目後重新載入，回到數目畫面而不是對局', () => {
      const sharedStorage = createMockLocalStorage();
      const first = gameInScoring(sharedStorage);
      expect(first.GameState.getState().isScoring).toBe(true);

      const saved = readSavedGame(sharedStorage);
      expect(saved.isScoring).toBe(true);

      const second = sandboxWithMainLifecycle({ sharedStorage, hash: '#play' });
      const restored = second.GameState.getState();
      expect({
        isScoring: restored.isScoring,
        deadStones: Array.from(restored.deadStones),
        moves: restored.moveHistory.length
      }).toEqual({
        isScoring: true,
        deadStones: Array.from(first.GameState.getState().deadStones),
        moves: 1
      });
      // 數目面板必須重新顯示，否則畫面停在對局樣子、狀態卻是數目中，點棋盤會變成標死子。
      // 用 getElementById 取（而非 elements 快取）：元素是 lazy 建立的，沒被碰過時
      // elements 上根本沒有這個 key，斷言會爆 TypeError 而不是給出可讀的期望值差異。
      const panel = second.ctx.document.getElementById('scoringPanel');
      expect(panel.style.display).toBe('block');
      // 分數用本地 calculateScore() 重算即可，不需重跑 KataGo ownership。
      expect(second.ctx.document.getElementById('blackScore').textContent).toBe(
        first.ctx.document.getElementById('blackScore').textContent
      );
    });

    test('數目期間標記死子會即時寫進 snapshot', () => {
      const sharedStorage = createMockLocalStorage();
      const sandbox = gameInScoring(sharedStorage);
      const app = sandbox.app;
      const before = readSavedGame(sharedStorage).deadStones;

      const group = app.getGroup(app.board, 4, 4);
      app.toggleDeadGroup(group.stones);

      const after = readSavedGame(sharedStorage).deadStones;
      expect(after).not.toEqual(before);
      expect(after).toEqual(Array.from(sandbox.GameState.getState().deadStones));
    });

    test('還原數目狀態時不排 AI 求手也不起鐘', () => {
      const sharedStorage = createMockLocalStorage();
      sharedStorage.setItem(SAVE_KEY, JSON.stringify({
        ...savedGame({
          gameMode: 'pvc',
          playerColor: 1,
          currentPlayer: 2,           // 輪 AI
          timerEnabled: true,
          timerSeconds: { 1: 280, 2: 300 }
        }),
        isScoring: true,
        deadStones: []
      }));

      const sandbox = sandboxWithMainLifecycle({
        sharedStorage, hash: '#play', useRealTimer: true
      });

      // 數目畫面不該讓 AI 求手：requestAIMove() 只擋 gameOver／isAIThinking，不看
      // isScoring，放行等於白白跑一次引擎推論、還讓「AI 思考中」蓋在數目畫面上。
      sandbox.clock.runTimeouts();
      expect(sandbox.requestAIMove).toHaveBeenCalledTimes(0);

      // 數目期間不走鐘（進入數目時已停鐘），還原也不該重新起鐘。
      sandbox.clock.advance(30_000);
      sandbox.clock.tick();
      expect(sandbox.GameState.getState().timerSeconds).toEqual({ 1: 280, 2: 300 });
    });

    test('舊版 snapshot（沒有 isScoring 欄位）照原本路徑還原', () => {
      const sharedStorage = createMockLocalStorage();
      const legacy = savedGame({ gameMode: 'pvc', playerColor: 1, currentPlayer: 2 });
      delete legacy.isScoring;
      delete legacy.deadStones;
      sharedStorage.setItem(SAVE_KEY, JSON.stringify(legacy));

      const sandbox = sandboxWithMainLifecycle({ sharedStorage, hash: '#play' });
      const state = sandbox.GameState.getState();

      expect({
        isScoring: state.isScoring,
        deadStones: Array.from(state.deadStones),
        moves: state.moveHistory.length
      }).toEqual({ isScoring: false, deadStones: [], moves: 1 });
      // 輪到 AI 就照常求手（原本的行為不受影響）。
      sandbox.clock.runTimeouts();
      expect(sandbox.requestAIMove).toHaveBeenCalledTimes(1);
    });
  });

  // ——— 離開／回到對弈畫面的計時生命週期 ———
  describe('離開 #play 的計時處理', () => {
    /** 切換 hash 路由：比照瀏覽器先改 location.hash 再發 hashchange。 */
    function navigate(sandbox, hash) {
      sandbox.ctx.location.hash = hash;
      sandbox.ctx.dispatchEvent({ type: 'hashchange' });
    }

    test('離開對弈畫面停鐘並定格秒數，切回來自動續鐘', () => {
      const sandbox = sandboxWithMainLifecycle({ hash: '#play', useRealTimer: true });
      startTimedGame(sandbox, { minutes: 5 });   // 黑白各 300 秒
      sandbox.clock.advance(20_000);
      sandbox.clock.tick();
      expect(sandbox.GameState.getState().timerSeconds).toEqual({ 1: 280, 2: 300 });

      navigate(sandbox, '#gomoku');

      // 停鐘當下的精確剩餘要寫進 snapshot，否則得等下一次圍棋操作才定格。
      expect(readSavedGame(sandbox.localStorage).timerSeconds).toEqual({ 1: 280, 2: 300 });

      // 在別的棋種畫面燒掉 60 秒，圍棋的鐘不能跟著走。
      sandbox.clock.advance(60_000);
      sandbox.clock.tick();
      expect(sandbox.GameState.getState().timerSeconds).toEqual({ 1: 280, 2: 300 });

      // 而且 visibilitychange checkpoint 也不能把這 60 秒寫進 snapshot。
      sandbox.ctx.document.visibilityState = 'hidden';
      sandbox.ctx.document.dispatchEvent({ type: 'visibilitychange' });
      expect(readSavedGame(sandbox.localStorage).timerSeconds).toEqual({ 1: 280, 2: 300 });

      // 切回對弈：對局仍在進行，自動續鐘（否則對局等於被無故中斷）。
      navigate(sandbox, '#play');
      sandbox.clock.advance(10_000);
      sandbox.clock.tick();
      expect(sandbox.GameState.getState().timerSeconds).toEqual({ 1: 270, 2: 300 });
    });

    test('離開後 AI 那一手才回來，也不會把鐘重新啟動', () => {
      // PvC 是預設模式：人類落子後 AI 求手要 1–3 秒，這段期間使用者切到別的棋種很正常。
      // AI 那一手回來時走的是 placeStone()／doPass()，兩者都會 switchTimer() →
      // GoTimer.start() → 重新 setInterval，等於在別的棋種畫面上把圍棋的鐘又打開。
      // 光在 leavePlayMode() 停鐘擋不住這條，因為停鐘發生在 AI 落子之前。
      const sandbox = sandboxWithMainLifecycle({ hash: '#play', useRealTimer: true });
      sandbox.ctx.document.getElementById('timerToggle').checked = true;
      sandbox.ctx.document.getElementById('timerMinutes').value = '5';
      sandbox.ctx.document.getElementById('gameMode').value = 'pvc';
      sandbox.ctx.document.getElementById('playerColor').value = '1';
      sandbox.ctx.startNewGame();

      sandbox.clock.advance(20_000);
      sandbox.app.placeStone(3, 3);   // 人類（黑）落子 → 換手給 AI（白），排一次求手
      expect(sandbox.GameState.getState().timerSeconds).toEqual({ 1: 280, 2: 300 });

      navigate(sandbox, '#gomoku');   // AI 還在思考時切去五子棋
      const frozen = { ...sandbox.GameState.getState().timerSeconds };

      sandbox.clock.advance(10_000);
      sandbox.app.placeStone(4, 4);   // AI 那一手在離開之後才回來
      sandbox.clock.advance(30_000);
      sandbox.clock.tick();

      expect(sandbox.GameState.getState().timerSeconds).toEqual(frozen);
      expect(readSavedGame(sandbox.localStorage).timerSeconds).toEqual(frozen);
    });

    test('離開對弈畫面後，取消數目也不會把鐘重新啟動', () => {
      // cancelScoring() 走的是 startTimer()（不是 switchTimer()），所以兩個入口都要擋。
      const sandbox = sandboxWithMainLifecycle({ hash: '#play', useRealTimer: true });
      startTimedGame(sandbox, { minutes: 5 });
      sandbox.clock.advance(20_000);
      sandbox.GameState.applyMove(4, 4);
      sandbox.ctx.finishGame();       // 進入數目，endGameByScoring() 會停鐘

      navigate(sandbox, '#gomoku');
      const frozen = { ...sandbox.GameState.getState().timerSeconds };

      sandbox.ctx.cancelScoring();
      sandbox.clock.advance(30_000);
      sandbox.clock.tick();

      expect(sandbox.GameState.getState().timerSeconds).toEqual(frozen);
    });

    test('終局後離開再切回來不會重新起鐘', () => {
      const sandbox = sandboxWithMainLifecycle({ hash: '#play', useRealTimer: true });
      startTimedGame(sandbox, { minutes: 5 });
      sandbox.clock.advance(20_000);
      sandbox.ctx.doResign();   // 終局，endGame() 會停鐘
      const atEnd = { ...sandbox.GameState.getState().timerSeconds };

      navigate(sandbox, '#gomoku');
      navigate(sandbox, '#play');
      sandbox.clock.advance(30_000);
      sandbox.clock.tick();

      expect(sandbox.GameState.getState().timerSeconds).toEqual(atEnd);
    });
  });

  // ——— 覆盤「換個下法試試」→「返回原始棋譜」———
  /**
   * 建一局 pvp 原譜（3 手落子 + 1 手虛手，最後一手經 doPass 觸發存檔），
   * 進覆盤退到第 2 手後分支出練習局，並在練習局虛手一次讓分支被寫進 snapshot。
   * 回傳的 sandbox 停在「練習分支已持久化、尚未按返回原譜」的狀態。
   */
  function branchedPracticeGame(sharedStorage) {
    const sandbox = sandboxWithMainLifecycle({ sharedStorage });
    sandbox.ctx.document.getElementById('gameMode').value = 'pvp';
    sandbox.ctx.startNewGame();
    sandbox.GameState.applyMove(0, 0);
    sandbox.GameState.applyMove(1, 1);
    sandbox.GameState.applyMove(2, 2);
    sandbox.ctx.doPass();          // 第 4 手；doPassAndSave 把 4 手原譜寫進 snapshot

    sandbox.ctx.enterReview();
    sandbox.ctx.reviewGo(2);       // 退到第 2 手
    sandbox.ctx.replayFromHere();  // 由第 2 手分支出練習局（pvc）
    sandbox.ctx.doPass();          // 練習局第 3 手，寫進 snapshot
    return sandbox;
  }

  test('返回原譜前，持久化的是練習分支（前置條件）', () => {
    const sharedStorage = createMockLocalStorage();
    const sandbox = branchedPracticeGame(sharedStorage);

    expect(readSavedGame(sharedStorage).moveHistory).toHaveLength(3);
    expect(sandbox.GameState.getState().moveHistory).toHaveLength(3);
  });

  test('返回原譜會存檔，重新載入回到原始棋譜而非練習分支', () => {
    const sharedStorage = createMockLocalStorage();
    const sandbox = branchedPracticeGame(sharedStorage);

    sandbox.ctx.returnToOriginal();

    // 存檔內容必須是 4 手原譜。注意光補 saveGame() 是不夠的：restoreSnapshot() 還原的
    // 快照是 replayFromHere() 在 GameState.exitReview() **之前**拍的，isReviewing 為
    // true，而 saveGame() 開頭就有 `if (state.isReviewing) return;`，補上去會是靜默 no-op。
    const saved = readSavedGame(sharedStorage);
    expect(saved.moveHistory).toHaveLength(4);
    // 存檔不得帶著覆盤狀態：loadGame() 沒有重建覆盤 UI 的路徑，還原成 isReviewing=true
    // 會變成「盤面停在覆盤游標、卻沒有任何覆盤控制項」的死狀態。
    expect(saved.isReviewing).toBe(false);

    // 跨文件重新載入：真的回到原譜。
    const reloaded = sandboxWithMainLifecycle({ sharedStorage, hash: '#play' });
    expect(reloaded.GameState.getState().moveHistory).toHaveLength(4);
    expect(reloaded.GameState.getState().isReviewing).toBe(false);
  });
});
