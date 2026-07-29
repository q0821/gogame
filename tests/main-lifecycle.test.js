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

  test('進入數目前先保存最新計時，pagehide 與 hidden 期間重新載入仍是可繼續的非數目狀態', () => {
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
      isScoring: false,
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
      isScoring: false,
      gameOver: false
    });
    // 上面 4 個欄位與「全新一局」同值，單靠它們無法分辨「還原了雙虛手 snapshot」
    // 與「根本沒載入、開了新局」；用棋譜長度／內容釘住確實載入的是雙虛手那一局。
    expect(restored.moveHistory.map((m) => ({ player: m.player, pass: !!m.pass }))).toEqual([
      { player: 1, pass: true },
      { player: 2, pass: true }
    ]);

    // 再虛手一次不應該立即被判定為雙虛手終局（passCount 不應殘留在 2）。
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
    // 白在 (0,1)(1,0) 圍住黑 (0,0)，第 4 手提掉一子。
    sandbox.GameState.applyMove(0, 0); // 黑
    sandbox.GameState.applyMove(0, 1); // 白
    sandbox.GameState.applyMove(5, 5); // 黑
    sandbox.ctx.doPass();              // 白虛手，讓 main.js 走一次 updateUI()

    const state = sandbox.GameState.getState();
    expect({
      cap: sandbox.elements.mobileBlackCap.textContent,
      moves: sandbox.elements.mobileMoveCount.textContent,
      turn: sandbox.elements.mobileTurn.textContent
    }).toEqual({
      cap: state.captures[1],
      moves: state.moveHistory.length,
      turn: '黑方'
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
});
