const { sandboxWithGameState } = require('./helpers');

let GameState, GoRules;
beforeEach(() => {
  // Fresh sandbox per test so state doesn't leak between tests
  ({ GameState, GoRules } = sandboxWithGameState());
});

const BLACK = 1;
const WHITE = 2;

// ─── createInitialState / resetState ─────────────────────────────────────────

describe('createInitialState', () => {
  test('defaults to 19×19 board', () => {
    const s = GameState.createInitialState();
    expect(s.size).toBe(19);
    expect(s.board).toHaveLength(19);
    expect(s.board[0]).toHaveLength(19);
  });

  test('respects custom size', () => {
    const s = GameState.createInitialState({ size: 9 });
    expect(s.size).toBe(9);
    expect(s.board).toHaveLength(9);
  });

  test('default currentPlayer is BLACK', () => {
    const s = GameState.createInitialState();
    expect(s.currentPlayer).toBe(BLACK);
  });

  test('default gameMode is pvc', () => {
    const s = GameState.createInitialState();
    expect(s.gameMode).toBe('pvc');
  });

  test('default komi 7.5 for chinese rules', () => {
    const s = GameState.createInitialState({ gameRules: 'chinese' });
    expect(s.komi).toBe(7.5);
  });

  test('default komi 6.5 for japanese rules', () => {
    const s = GameState.createInitialState({ gameRules: 'japanese' });
    expect(s.komi).toBe(6.5);
  });

  test('captures start at zero', () => {
    const s = GameState.createInitialState();
    expect(s.captures[BLACK]).toBe(0);
    expect(s.captures[WHITE]).toBe(0);
  });

  test('game flags all false', () => {
    const s = GameState.createInitialState();
    expect(s.gameOver).toBe(false);
    expect(s.isScoring).toBe(false);
    expect(s.isReviewing).toBe(false);
    expect(s.isAIThinking).toBe(false);
  });
});

describe('resetState', () => {
  test('resets board and history', () => {
    GameState.applyMove(3, 3);
    GameState.resetState({ size: 9 });
    const s = GameState.getState();
    expect(s.moveHistory).toHaveLength(0);
    expect(s.boardHistory).toHaveLength(0);
    expect(s.passCount).toBe(0);
    expect(s.size).toBe(9);
  });
});

// ─── applyMove ───────────────────────────────────────────────────────────────

describe('applyMove', () => {
  beforeEach(() => GameState.resetState({ size: 9 }));

  test('valid move returns ok:true with captured count', () => {
    const result = GameState.applyMove(4, 4);
    expect(result.ok).toBe(true);
    expect(result.captured).toBe(0);
  });

  test('stone appears on board', () => {
    GameState.applyMove(4, 4);
    const s = GameState.getState();
    expect(s.board[4][4]).toBe(BLACK);
  });

  test('currentPlayer toggles after move', () => {
    GameState.applyMove(4, 4);
    expect(GameState.getState().currentPlayer).toBe(WHITE);
  });

  test('move is recorded in moveHistory', () => {
    GameState.applyMove(2, 3);
    const s = GameState.getState();
    expect(s.moveHistory).toHaveLength(1);
    expect(s.moveHistory[0]).toMatchObject({ x: 2, y: 3, player: BLACK });
  });

  test('lastMove is updated', () => {
    GameState.applyMove(5, 6);
    expect(GameState.getState().lastMove).toEqual([5, 6]);
  });

  test('occupied cell returns ok:false', () => {
    GameState.applyMove(4, 4);
    const result = GameState.applyMove(4, 4); // WHITE tries same cell
    expect(result.ok).toBe(false);
  });

  test('occupied cell returns reason:occupied', () => {
    GameState.applyMove(4, 4);
    const result = GameState.applyMove(4, 4); // WHITE tries same cell
    expect(result.reason).toBe('occupied');
  });

  test('suicide move returns reason:suicide', () => {
    // Surround (0,0) with WHITE on a 9x9 so BLACK playing there is suicide.
    // B(0,0) 相鄰: (0,1) 與 (1,0)；先讓白佔滿即可構造自殺手。
    GameState.sync({
      board: (() => {
        const b = GoRules.createBoard(9);
        b[0][1] = WHITE;
        b[1][0] = WHITE;
        return b;
      })(),
      currentPlayer: BLACK,
    });
    const result = GameState.applyMove(0, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('suicide');
  });

  test('ko point move returns reason:ko', () => {
    // 用實際打劫棋形：黑吃白單子後產生劫，白立刻回吃被禁。
    //  . B W .
    //  B W . W  <- black plays at (1,2) captures W at (1,1) → ko at (1,1)
    //  . B W .
    GameState.resetState({ size: 7 });
    const b = GoRules.createBoard(7);
    b[0][1] = BLACK; b[2][1] = BLACK; b[1][0] = BLACK;
    b[1][1] = WHITE;
    b[0][2] = WHITE; b[2][2] = WHITE; b[1][3] = WHITE;
    GameState.sync({ board: b, currentPlayer: BLACK });
    const capture = GameState.applyMove(1, 2); // BLACK captures, sets koPoint at (1,1)
    expect(capture.ok).toBe(true);
    expect(GameState.getState().koPoint).toEqual([1, 1]);

    const result = GameState.applyMove(1, 1); // WHITE tries to immediately recapture
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ko');
  });

  test('boardHistory grows after each move', () => {
    GameState.applyMove(0, 0);
    GameState.applyMove(8, 8);
    expect(GameState.getState().boardHistory).toHaveLength(2);
  });

  test('capture is counted', () => {
    // Surround a white stone with black (9×9)
    GameState.resetState({ size: 9 });
    const s = GameState.getState();
    // Manually place for test: use sync to set up board
    // B plays (4,3)
    GameState.applyMove(4, 3); // B
    GameState.applyMove(4, 4); // W — white at (4,4)
    GameState.applyMove(3, 4); // B
    GameState.applyMove(8, 8); // W — dummy move
    GameState.applyMove(5, 4); // B
    GameState.applyMove(7, 7); // W — dummy
    GameState.applyMove(4, 5); // B — captures W at (4,4)
    const state = GameState.getState();
    expect(state.captures[BLACK]).toBeGreaterThan(0);
    expect(state.board[4][4]).toBe(0); // captured stone removed
  });
});

// ─── applyPass ───────────────────────────────────────────────────────────────

describe('applyPass', () => {
  beforeEach(() => GameState.resetState({ size: 9 }));

  test('single pass returns ok:true, endedByDoublePass:false', () => {
    const result = GameState.applyPass();
    expect(result.ok).toBe(true);
    expect(result.endedByDoublePass).toBe(false);
  });

  test('pass is recorded in moveHistory', () => {
    GameState.applyPass();
    const m = GameState.getState().moveHistory[0];
    expect(m.pass).toBe(true);
  });

  test('double pass returns endedByDoublePass:true', () => {
    GameState.applyPass();
    const result = GameState.applyPass();
    expect(result.endedByDoublePass).toBe(true);
  });

  test('single pass increments passCount', () => {
    GameState.applyPass();
    expect(GameState.getState().passCount).toBe(1);
  });

  test('pass clears koPoint', () => {
    GameState.sync({ koPoint: [3, 3] });
    GameState.applyPass();
    expect(GameState.getState().koPoint).toBeNull();
  });

  test('pass clears lastMove', () => {
    GameState.applyMove(4, 4);
    GameState.applyPass();
    expect(GameState.getState().lastMove).toBeNull();
  });
});

// ─── undo ─────────────────────────────────────────────────────────────────────

describe('undo', () => {
  beforeEach(() => GameState.resetState({ size: 9 }));

  test('returns ok:false on empty history', () => {
    const result = GameState.undo({});
    expect(result.ok).toBe(false);
  });

  test('undoes a single move', () => {
    GameState.applyMove(4, 4);
    GameState.undo({});
    const s = GameState.getState();
    expect(s.board[4][4]).toBe(0);
    expect(s.moveHistory).toHaveLength(0);
  });

  test('restores currentPlayer', () => {
    GameState.applyMove(4, 4); // B plays → now W's turn
    GameState.undo({});
    expect(GameState.getState().currentPlayer).toBe(BLACK);
  });

  test('pvp mode undoes 1 move', () => {
    GameState.applyMove(4, 4);
    GameState.applyMove(4, 5);
    const result = GameState.undo({ gameMode: 'pvp' });
    expect(result.undoCount).toBe(1);
    expect(GameState.getState().moveHistory).toHaveLength(1);
  });

  test('pvc mode undoes 2 moves when history has ≥ 2 entries', () => {
    GameState.applyMove(4, 4); // B
    GameState.applyMove(4, 5); // W
    const result = GameState.undo({ gameMode: 'pvc' });
    expect(result.undoCount).toBe(2);
    expect(GameState.getState().moveHistory).toHaveLength(0);
  });

  test('pvc mode undoes only 1 when only 1 entry', () => {
    GameState.applyMove(4, 4);
    const result = GameState.undo({ gameMode: 'pvc' });
    expect(result.undoCount).toBe(1);
  });
});

// ─── beginScoring / cancelScoring / confirmScoring ───────────────────────────

describe('scoring lifecycle', () => {
  beforeEach(() => GameState.resetState({ size: 9 }));

  test('beginScoring sets isScoring:true', () => {
    GameState.beginScoring();
    expect(GameState.getState().isScoring).toBe(true);
  });

  test('cancelScoring resets passCount to 0（取消數目後單次虛手不應立刻終局）', () => {
    GameState.applyMove(4, 4); // B
    GameState.applyMove(2, 2); // W
    GameState.applyPass();     // B pass, passCount=1
    GameState.applyPass();     // W pass, passCount=2 → beginScoring 情境（雙虛手）
    GameState.beginScoring();
    GameState.cancelScoring();
    expect(GameState.getState().passCount).toBe(0);

    const result = GameState.applyPass(); // 取消數目後只虛手一次
    expect(result.endedByDoublePass).toBe(false);
  });

  test('cancelScoring clears isScoring and deadStones', () => {
    GameState.beginScoring();
    GameState.cancelScoring();
    const s = GameState.getState();
    expect(s.isScoring).toBe(false);
    expect(s.deadStones.size).toBe(0);
  });

  test('confirmScoring sets gameOver:true and clears isScoring', () => {
    GameState.beginScoring();
    GameState.confirmScoring();
    const s = GameState.getState();
    expect(s.gameOver).toBe(true);
    expect(s.isScoring).toBe(false);
  });
});

// ─── toggleDeadGroup ─────────────────────────────────────────────────────────

describe('toggleDeadGroup', () => {
  beforeEach(() => {
    GameState.resetState({ size: 9 });
    GameState.beginScoring();
  });

  test('marks a group as dead', () => {
    const stones = [[2, 2]];
    GameState.toggleDeadGroup(stones);
    const key = 2 * 9 + 2;
    expect(GameState.getState().deadStones.has(key)).toBe(true);
  });

  test('toggling again removes the dead mark', () => {
    const stones = [[2, 2]];
    GameState.toggleDeadGroup(stones);
    GameState.toggleDeadGroup(stones);
    const key = 2 * 9 + 2;
    expect(GameState.getState().deadStones.has(key)).toBe(false);
  });

  test('returns ok:false when not in scoring', () => {
    GameState.cancelScoring();
    const result = GameState.toggleDeadGroup([[2, 2]]);
    expect(result.ok).toBe(false);
  });

  test('returns ok:false for empty group', () => {
    const result = GameState.toggleDeadGroup([]);
    expect(result.ok).toBe(false);
  });
});

// ─── review ──────────────────────────────────────────────────────────────────

describe('review', () => {
  beforeEach(() => {
    GameState.resetState({ size: 9 });
    GameState.applyMove(0, 0);
    GameState.applyMove(1, 1);
    GameState.applyMove(2, 2);
  });

  test('enterReview sets isReviewing:true and currentReviewMove to end', () => {
    GameState.enterReview();
    const s = GameState.getState();
    expect(s.isReviewing).toBe(true);
    expect(s.currentReviewMove).toBe(3);
  });

  test('exitReview clears isReviewing', () => {
    GameState.enterReview();
    GameState.exitReview();
    expect(GameState.getState().isReviewing).toBe(false);
  });

  test('reviewGo clamps to valid range', () => {
    GameState.enterReview();
    GameState.reviewGo(-5);
    expect(GameState.getState().currentReviewMove).toBe(0);
    GameState.reviewGo(999);
    expect(GameState.getState().currentReviewMove).toBe(3);
  });

  test('reviewGo returns ok:false when not in review mode', () => {
    const result = GameState.reviewGo(1);
    expect(result.ok).toBe(false);
  });

  test('reviewGo navigates to specific move', () => {
    GameState.enterReview();
    GameState.reviewGo(1);
    expect(GameState.getState().currentReviewMove).toBe(1);
  });
});

// ─── getSnapshot / restoreSnapshot ───────────────────────────────────────────

describe('getSnapshot / restoreSnapshot', () => {
  test('snapshot captures current state', () => {
    GameState.resetState({ size: 9 });
    GameState.applyMove(3, 3);
    const snap = GameState.getSnapshot();
    expect(snap.moveHistory).toHaveLength(1);
    expect(snap.size).toBe(9);
  });

  test('restoreSnapshot rebuilds state', () => {
    GameState.resetState({ size: 9 });
    GameState.applyMove(4, 4);
    const snap = GameState.getSnapshot();

    GameState.resetState({ size: 13 }); // change state
    GameState.restoreSnapshot(snap);

    const s = GameState.getState();
    expect(s.size).toBe(9);
    expect(s.board[4][4]).toBe(BLACK);
  });

  test('restoreSnapshot defaults gameMode to pvc', () => {
    GameState.restoreSnapshot({}); // empty snapshot
    expect(GameState.getState().gameMode).toBe('pvc');
  });

  test('snapshot board is independent (deep copy)', () => {
    GameState.resetState({ size: 9 });
    GameState.applyMove(4, 4);
    const snap = GameState.getSnapshot();
    snap.board[4][4] = 0; // mutate snapshot
    expect(GameState.getState().board[4][4]).toBe(BLACK); // original unchanged
  });

  test('restoreSnapshot 可載入缺少新欄位的舊資料', () => {
    const oldSnapshot = {
      size: 9,
      board: GoRules.createBoard(9),
      currentPlayer: BLACK,
      captures: { 1: 0, 2: 0 },
      moveHistory: []
    };
    GameState.restoreSnapshot(oldSnapshot);
    const state = GameState.getState();
    expect(state.timerSeconds).toEqual({ [BLACK]: 600, [WHITE]: 600 });
    expect(state.isAIThinking).toBe(false);
    expect(typeof state.deadStones.has).toBe('function');
  });
});

describe('semantic state mutations', () => {
  beforeEach(() => GameState.resetState({ size: 9, aiLevel: 4 }));

  test('setAIThinking 只更新思考狀態', () => {
    const boardBefore = GameState.getState().board;
    GameState.setAIThinking(true);
    expect(GameState.getState().isAIThinking).toBe(true);
    expect(GameState.getState().board).toBe(boardBefore);
  });

  test('setAiLevel 更新目前棋局等級', () => {
    GameState.setAiLevel(7);
    expect(GameState.getState().aiLevel).toBe(7);
  });

  test('setTimerSeconds 複製輸入，外部後續修改不影響 store', () => {
    const seconds = { [BLACK]: 123, [WHITE]: 456 };
    GameState.setTimerSeconds(seconds);
    seconds[BLACK] = 0;
    expect(GameState.getState().timerSeconds).toEqual({ [BLACK]: 123, [WHITE]: 456 });
  });

  test('setDeadStones 建立自己的 Set', () => {
    const stones = new Set([5, 10]);
    GameState.setDeadStones(stones);
    stones.add(20);
    const stored = GameState.getState().deadStones;
    expect(stored.has(5)).toBe(true);
    expect(stored.has(10)).toBe(true);
    expect(stored.has(20)).toBe(false);
  });

  test('markGameOver 結束棋局並釋放 AI 鎖', () => {
    GameState.setAIThinking(true);
    GameState.markGameOver();
    expect(GameState.getState().gameOver).toBe(true);
    expect(GameState.getState().isAIThinking).toBe(false);
  });
});

// ─── sync ────────────────────────────────────────────────────────────────────

describe('sync', () => {
  beforeEach(() => GameState.resetState({ size: 9 }));

  test('sync updates specified fields', () => {
    GameState.sync({ passCount: 1, gameOver: true });
    const s = GameState.getState();
    expect(s.passCount).toBe(1);
    expect(s.gameOver).toBe(true);
  });

  test('sync does not touch unspecified fields', () => {
    GameState.applyMove(4, 4);
    const before = GameState.getState().board[4][4];
    GameState.sync({ passCount: 2 });
    expect(GameState.getState().board[4][4]).toBe(before);
  });

  test('sync with deadStones stores a Set-like object', () => {
    GameState.sync({ deadStones: [5, 10] });
    const ds = GameState.getState().deadStones;
    // Use duck-typing: vm sandbox Set !== outer Set, so avoid instanceof
    expect(typeof ds.has).toBe('function');
    expect(ds.has(5)).toBe(true);
    expect(ds.has(10)).toBe(true);
  });
});
