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
  gameOver = false
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
    passCount: 0,
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
    isAIThinking: false
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
});
