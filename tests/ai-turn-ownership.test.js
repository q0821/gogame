const { sandboxWithMainLifecycle, sandboxWithAiController } = require('./helpers');

function koGame() {
  const sandbox = sandboxWithMainLifecycle({ hash: '#play' });
  const board = Array.from({ length: 9 }, () => Array(9).fill(0));
  board[1][1] = 2;
  for (const [x, y] of [[0, 1], [2, 1], [1, 0]]) board[x][y] = 1;
  for (const [x, y] of [[0, 2], [2, 2], [1, 3]]) board[x][y] = 2;
  sandbox.GameState.startGame({ size: 9, board, currentPlayer: 1, gameMode: 'pvc', playerColor: 1, aiLevel: 13 });
  sandbox.GameState.applyMove(1, 2);
  return sandbox;
}

function controllerFor(sandbox, candidates) {
  const engine = {
    ensureReady: async () => {},
    genmoveCandidates: async () => candidates,
    reset: () => {}
  };
  return sandboxWithAiController(engine).makeAiController(sandbox.app);
}

describe('AI 禁著點不轉交玩家執子權', () => {
  test('候選含立即回提禁著點時，AI 選合法白子並真正交回黑方', async () => {
    const sandbox = koGame();
    const controller = controllerFor(sandbox, [
      { x: 1, y: 1, pointsLost: 0, order: 0 },
      { x: 5, y: 5, pointsLost: 1, order: 1 }
    ]);
    await controller.requestAIMove();
    const state = sandbox.GameState.getState();
    expect(state.board[1][1]).toBe(0);
    expect(state.board[5][5]).toBe(2);
    expect(state.playerColor).toBe(1);
    expect(state.currentPlayer).toBe(1);
    expect(state.moveHistory.map(move => move.player)).toEqual([1, 2]);
  }, 10000);

  test('AI 手被拒絕後仍是白方回合，不向黑方玩家提供白子預覽', async () => {
    const sandbox = koGame();
    await controllerFor(sandbox, [{ x: 1, y: 1, pointsLost: 0, order: 0 }]).requestAIMove();
    const state = sandbox.GameState.getState();
    expect(state.playerColor).toBe(1);
    expect(state.currentPlayer).toBe(2);
    expect(state.moveHistory).toHaveLength(1);
    sandbox.app.hoverPos = [5, 5];
    let displayed;
    sandbox.app.GoUI.drawBoard = (_deps, view) => { displayed = view; };
    sandbox.ctx.dispatchEvent({ type: 'resize' });
    expect(displayed.hoverPos).toBeNull();
  }, 10000);

  test('AI 手被拒絕後，玩家不能用虛手替白方走棋', async () => {
    const sandbox = koGame();
    await controllerFor(sandbox, [{ x: 1, y: 1, pointsLost: 0, order: 0 }]).requestAIMove();
    sandbox.ctx.doPass();
    expect(sandbox.GameState.getState().currentPlayer).toBe(2);
    expect(sandbox.GameState.getState().moveHistory).toHaveLength(1);
  }, 10000);
});
