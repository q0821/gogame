(function(global) {
  const BLACK = 1;
  const WHITE = 2;

  let state = null;

  function cloneBoard(board) {
    return board.map(row => [...row]);
  }

  function cloneCaptures(captures) {
    return { [BLACK]: captures[BLACK] || 0, [WHITE]: captures[WHITE] || 0 };
  }

  function cloneBoardHistory(boardHistory) {
    return (boardHistory || []).map(entry => ({
      board: cloneBoard(entry.board),
      captures: cloneCaptures(entry.captures || {}),
      koPoint: entry.koPoint ? [...entry.koPoint] : null,
      currentPlayer: entry.currentPlayer,
      lastMove: entry.lastMove ? [...entry.lastMove] : null,
      passCount: entry.passCount || 0
    }));
  }

  function cloneMoveHistory(moveHistory) {
    return (moveHistory || []).map(move => ({ ...move }));
  }

  function createInitialState(options = {}) {
    const size = options.size || 19;
    const createBoard = global.GoRules && global.GoRules.createBoard
      ? global.GoRules.createBoard
      : (n => Array.from({ length: n }, () => Array(n).fill(0)));

    return {
      size,
      board: options.board ? cloneBoard(options.board) : createBoard(size),
      currentPlayer: options.currentPlayer || BLACK,
      captures: cloneCaptures(options.captures || {}),
      moveHistory: cloneMoveHistory(options.moveHistory || []),
      boardHistory: cloneBoardHistory(options.boardHistory || []),
      koPoint: options.koPoint ? [...options.koPoint] : null,
      passCount: options.passCount || 0,
      gameOver: options.gameOver || false,
      lastMove: options.lastMove ? [...options.lastMove] : null,
      gameMode: options.gameMode || 'pvc',
      playerColor: options.playerColor || BLACK,
      aiLevel: options.aiLevel || 10,
      timerEnabled: options.timerEnabled || false,
      timerSeconds: options.timerSeconds
        ? { [BLACK]: options.timerSeconds[BLACK] || 0, [WHITE]: options.timerSeconds[WHITE] || 0 }
        : { [BLACK]: 600, [WHITE]: 600 },
      gameRules: options.gameRules || 'chinese',
      komi: options.komi !== undefined ? options.komi : ((options.gameRules || 'chinese') === 'japanese' ? 6.5 : 7.5),
      isReviewing: options.isReviewing || false,
      currentReviewMove: options.currentReviewMove || 0,
      isScoring: options.isScoring || false,
      deadStones: new Set(options.deadStones || [])
    };
  }

  function resetState(options = {}) {
    state = createInitialState(options);
    return getState();
  }

  function ensureState() {
    if (!state) {
      state = createInitialState();
    }
    return state;
  }

  function getState() {
    return ensureState();
  }

  function getSnapshot() {
    const current = ensureState();
    return {
      size: current.size,
      board: cloneBoard(current.board),
      currentPlayer: current.currentPlayer,
      captures: { 1: current.captures[BLACK], 2: current.captures[WHITE] },
      moveHistory: cloneMoveHistory(current.moveHistory),
      koPoint: current.koPoint ? [...current.koPoint] : null,
      passCount: current.passCount,
      gameOver: current.gameOver,
      lastMove: current.lastMove ? [...current.lastMove] : null,
      gameMode: current.gameMode,
      playerColor: current.playerColor,
      aiLevel: current.aiLevel,
      timerEnabled: current.timerEnabled,
      gameRules: current.gameRules,
      komi: current.komi,
      timerSeconds: { 1: current.timerSeconds[BLACK], 2: current.timerSeconds[WHITE] },
      boardHistory: current.boardHistory.map(entry => ({
        board: cloneBoard(entry.board),
        captures: { 1: entry.captures[BLACK], 2: entry.captures[WHITE] },
        koPoint: entry.koPoint ? [...entry.koPoint] : null,
        currentPlayer: entry.currentPlayer,
        lastMove: entry.lastMove ? [...entry.lastMove] : null,
        passCount: entry.passCount || 0
      }))
    };
  }

  function restoreSnapshot(snapshot = {}) {
    state = createInitialState({
      size: snapshot.size,
      board: snapshot.board,
      currentPlayer: snapshot.currentPlayer,
      captures: { [BLACK]: snapshot.captures?.['1'] ?? 0, [WHITE]: snapshot.captures?.['2'] ?? 0 },
      moveHistory: snapshot.moveHistory || [],
      boardHistory: (snapshot.boardHistory || []).map(entry => ({
        board: entry.board,
        captures: { [BLACK]: entry.captures?.['1'] ?? 0, [WHITE]: entry.captures?.['2'] ?? 0 },
        koPoint: entry.koPoint || null,
        currentPlayer: entry.currentPlayer,
        lastMove: entry.lastMove || null,
        passCount: entry.passCount || 0
      })),
      koPoint: snapshot.koPoint,
      passCount: snapshot.passCount || 0,
      gameOver: snapshot.gameOver || false,
      lastMove: snapshot.lastMove || null,
      gameMode: snapshot.gameMode || 'pvp',
      playerColor: snapshot.playerColor || BLACK,
      aiLevel: snapshot.aiLevel || 10,
      timerEnabled: snapshot.timerEnabled || false,
      timerSeconds: {
        [BLACK]: snapshot.timerSeconds?.['1'] ?? 600,
        [WHITE]: snapshot.timerSeconds?.['2'] ?? 600
      },
      gameRules: snapshot.gameRules || 'chinese',
      komi: snapshot.komi,
      isReviewing: false,
      currentReviewMove: 0,
      isScoring: false,
      deadStones: []
    });
    return getState();
  }

  function sync(partialState = {}) {
    const current = ensureState();
    if (Object.prototype.hasOwnProperty.call(partialState, 'board')) current.board = cloneBoard(partialState.board);
    if (Object.prototype.hasOwnProperty.call(partialState, 'currentPlayer')) current.currentPlayer = partialState.currentPlayer;
    if (Object.prototype.hasOwnProperty.call(partialState, 'captures')) current.captures = cloneCaptures(partialState.captures);
    if (Object.prototype.hasOwnProperty.call(partialState, 'moveHistory')) current.moveHistory = cloneMoveHistory(partialState.moveHistory);
    if (Object.prototype.hasOwnProperty.call(partialState, 'boardHistory')) current.boardHistory = cloneBoardHistory(partialState.boardHistory);
    if (Object.prototype.hasOwnProperty.call(partialState, 'koPoint')) current.koPoint = partialState.koPoint ? [...partialState.koPoint] : null;
    if (Object.prototype.hasOwnProperty.call(partialState, 'passCount')) current.passCount = partialState.passCount;
    if (Object.prototype.hasOwnProperty.call(partialState, 'gameOver')) current.gameOver = partialState.gameOver;
    if (Object.prototype.hasOwnProperty.call(partialState, 'lastMove')) current.lastMove = partialState.lastMove ? [...partialState.lastMove] : null;
    if (Object.prototype.hasOwnProperty.call(partialState, 'gameMode')) current.gameMode = partialState.gameMode;
    if (Object.prototype.hasOwnProperty.call(partialState, 'playerColor')) current.playerColor = partialState.playerColor;
    if (Object.prototype.hasOwnProperty.call(partialState, 'aiLevel')) current.aiLevel = partialState.aiLevel;
    if (Object.prototype.hasOwnProperty.call(partialState, 'timerEnabled')) current.timerEnabled = partialState.timerEnabled;
    if (Object.prototype.hasOwnProperty.call(partialState, 'timerSeconds')) {
      current.timerSeconds = {
        [BLACK]: partialState.timerSeconds[BLACK] ?? partialState.timerSeconds[1] ?? current.timerSeconds[BLACK],
        [WHITE]: partialState.timerSeconds[WHITE] ?? partialState.timerSeconds[2] ?? current.timerSeconds[WHITE]
      };
    }
    if (Object.prototype.hasOwnProperty.call(partialState, 'gameRules')) current.gameRules = partialState.gameRules;
    if (Object.prototype.hasOwnProperty.call(partialState, 'komi')) current.komi = partialState.komi;
    if (Object.prototype.hasOwnProperty.call(partialState, 'isReviewing')) current.isReviewing = partialState.isReviewing;
    if (Object.prototype.hasOwnProperty.call(partialState, 'currentReviewMove')) current.currentReviewMove = partialState.currentReviewMove;
    if (Object.prototype.hasOwnProperty.call(partialState, 'isScoring')) current.isScoring = partialState.isScoring;
    if (Object.prototype.hasOwnProperty.call(partialState, 'deadStones')) current.deadStones = new Set(partialState.deadStones);
    return current;
  }

  function buildUndoEntry(current) {
    return {
      board: cloneBoard(current.board),
      captures: cloneCaptures(current.captures),
      koPoint: current.koPoint ? [...current.koPoint] : null,
      currentPlayer: current.currentPlayer,
      lastMove: current.lastMove ? [...current.lastMove] : null,
      passCount: current.passCount || 0
    };
  }

  function applyMove(x, y) {
    const current = ensureState();
    const result = global.GoRules.tryPlaceStone(current.board, current.size, x, y, current.currentPlayer, current.koPoint);
    if (!result.valid) return { ok: false };

    current.boardHistory.push(buildUndoEntry(current));
    current.board = cloneBoard(result.newBoard);
    current.captures[current.currentPlayer] = (current.captures[current.currentPlayer] || 0) + result.captured;
    current.koPoint = result.newKo || null;
    current.lastMove = [x, y];
    current.passCount = 0;
    current.moveHistory.push({ x, y, player: current.currentPlayer, captured: result.captured });
    current.currentPlayer = global.GoRules.opponent(current.currentPlayer);

    return {
      ok: true,
      captured: result.captured,
      currentPlayer: current.currentPlayer,
      gameOver: current.gameOver
    };
  }

  function applyPass() {
    const current = ensureState();
    current.boardHistory.push(buildUndoEntry(current));
    current.passCount += 1;
    current.moveHistory.push({ x: -1, y: -1, player: current.currentPlayer, pass: true });
    current.koPoint = null;
    current.lastMove = null;

    if (current.passCount >= 2) {
      return {
        ok: true,
        endedByDoublePass: true,
        currentPlayer: current.currentPlayer,
        passCount: current.passCount
      };
    }

    current.currentPlayer = global.GoRules.opponent(current.currentPlayer);
    return {
      ok: true,
      endedByDoublePass: false,
      currentPlayer: current.currentPlayer,
      passCount: current.passCount
    };
  }

  function undo(options = {}) {
    const current = ensureState();
    if (!current.boardHistory.length) return { ok: false };

    const undoCount = (options.gameMode === 'pvc' && current.boardHistory.length >= 2) ? 2 : 1;
    for (let i = 0; i < undoCount && current.boardHistory.length > 0; i++) {
      const previous = current.boardHistory.pop();
      current.board = cloneBoard(previous.board);
      current.captures = cloneCaptures(previous.captures);
      current.koPoint = previous.koPoint ? [...previous.koPoint] : null;
      current.currentPlayer = previous.currentPlayer;
      current.lastMove = previous.lastMove ? [...previous.lastMove] : null;
      current.passCount = previous.passCount || 0;
      current.moveHistory.pop();
    }

    return {
      ok: true,
      undoCount,
      currentPlayer: current.currentPlayer
    };
  }

  function startGame(options = {}) {
    state = createInitialState({
      size: options.size,
      gameMode: options.gameMode || 'pvc',
      playerColor: options.playerColor || BLACK,
      aiLevel: options.aiLevel || 10,
      timerEnabled: options.timerEnabled || false,
      timerSeconds: options.timerSeconds || { [BLACK]: 600, [WHITE]: 600 },
      gameRules: options.gameRules || 'chinese',
      komi: options.komi
    });
    return getState();
  }

  function beginScoring() {
    const current = ensureState();
    current.isScoring = true;
    current.deadStones = new Set();
    return {
      ok: true,
      isScoring: current.isScoring
    };
  }

  function cancelScoring() {
    const current = ensureState();
    current.isScoring = false;
    current.deadStones = new Set();
    return {
      ok: true,
      isScoring: current.isScoring
    };
  }

  function confirmScoring() {
    const current = ensureState();
    current.isScoring = false;
    current.gameOver = true;
    return {
      ok: true,
      gameOver: current.gameOver
    };
  }

  function toggleDeadGroup(groupStones = []) {
    const current = ensureState();
    if (!current.isScoring) return { ok: false };
    if (!groupStones.length) return { ok: false };

    const key0 = groupStones[0][0] * current.size + groupStones[0][1];
    const allDead = current.deadStones.has(key0);
    for (const [x, y] of groupStones) {
      const key = x * current.size + y;
      if (allDead) current.deadStones.delete(key);
      else current.deadStones.add(key);
    }

    return {
      ok: true,
      deadStones: Array.from(current.deadStones)
    };
  }

  function enterReview() {
    const current = ensureState();
    current.isReviewing = true;
    current.currentReviewMove = current.moveHistory.length;
    return {
      ok: true,
      currentReviewMove: current.currentReviewMove
    };
  }

  function exitReview() {
    const current = ensureState();
    current.isReviewing = false;
    return {
      ok: true,
      isReviewing: current.isReviewing
    };
  }

  function reviewGo(n) {
    const current = ensureState();
    if (!current.isReviewing) return { ok: false };
    current.currentReviewMove = Math.max(0, Math.min(n, current.moveHistory.length));
    return {
      ok: true,
      currentReviewMove: current.currentReviewMove
    };
  }

  resetState();

  global.GameState = {
    createInitialState,
    resetState,
    getState,
    getSnapshot,
    restoreSnapshot,
    sync,
    applyMove,
    applyPass,
    undo,
    startGame,
    beginScoring,
    cancelScoring,
    confirmScoring,
    toggleDeadGroup,
    enterReview,
    exitReview,
    reviewGo
  };
})(window);
