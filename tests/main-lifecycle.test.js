const { sandboxWithMainLifecycle } = require('./helpers');

const AI_LEVEL_KEY = 'gogame_ai_level';
const SAVE_KEY = 'gogame_state';

function savedGame({ aiLevel = 9 } = {}) {
  const size = 9;
  const board = Array.from({ length: size }, () => Array(size).fill(0));
  board[0][0] = 1;
  return {
    size,
    board,
    currentPlayer: 1,
    captures: { 1: 0, 2: 0 },
    moveHistory: [{ x: 0, y: 0, player: 1, captured: 0 }],
    boardHistory: [],
    koPoint: null,
    passCount: 0,
    gameOver: false,
    lastMove: [0, 0],
    gameMode: 'pvc',
    playerColor: 1,
    aiLevel,
    timerEnabled: false,
    timerSeconds: { 1: 600, 2: 600 },
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
});
