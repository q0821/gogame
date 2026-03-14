(function(global) {
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;

  function createBoard(size) {
    return Array.from({ length: size }, () => Array(size).fill(EMPTY));
  }

  function cloneBoard(board) {
    return board.map(row => [...row]);
  }

  function opponent(player) {
    return player === BLACK ? WHITE : BLACK;
  }

  function inBounds(size, x, y) {
    return x >= 0 && x < size && y >= 0 && y < size;
  }

  function getNeighbors(size, x, y) {
    return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([nx, ny]) => inBounds(size, nx, ny));
  }

  function getGroup(board, size, x, y) {
    const color = board[x][y];
    if (color === EMPTY) return { stones: [], liberties: new Set() };

    const visited = new Set();
    const stones = [];
    const liberties = new Set();
    const stack = [[x, y]];

    while (stack.length) {
      const [cx, cy] = stack.pop();
      const key = cx * size + cy;
      if (visited.has(key)) continue;
      visited.add(key);

      if (board[cx][cy] === color) {
        stones.push([cx, cy]);
        for (const [nx, ny] of getNeighbors(size, cx, cy)) {
          if (board[nx][ny] === EMPTY) liberties.add(nx * size + ny);
          else if (board[nx][ny] === color && !visited.has(nx * size + ny)) stack.push([nx, ny]);
        }
      }
    }

    return { stones, liberties };
  }

  function removeGroup(board, stones) {
    for (const [x, y] of stones) board[x][y] = EMPTY;
    return stones.length;
  }

  function boardToString(board) {
    return board.map(row => row.join('')).join('');
  }

  function tryPlaceStone(board, size, x, y, player, currentKo) {
    if (board[x][y] !== EMPTY) return { valid: false };

    const newBoard = cloneBoard(board);
    newBoard[x][y] = player;
    let captured = 0;
    let capturedSingle = null;
    const opp = opponent(player);

    for (const [nx, ny] of getNeighbors(size, x, y)) {
      if (newBoard[nx][ny] === opp) {
        const group = getGroup(newBoard, size, nx, ny);
        if (group.liberties.size === 0) {
          if (group.stones.length === 1) capturedSingle = group.stones[0];
          captured += removeGroup(newBoard, group.stones);
        }
      }
    }

    const selfGroup = getGroup(newBoard, size, x, y);
    if (selfGroup.liberties.size === 0) return { valid: false };

    if (currentKo && currentKo[0] === x && currentKo[1] === y) return { valid: false };

    let newKo = null;
    if (captured === 1 && capturedSingle && selfGroup.stones.length === 1 && selfGroup.liberties.size === 1) {
      newKo = capturedSingle;
    }

    return { valid: true, newBoard, captured, newKo };
  }

  function getLegalMoves(board, size, player, koPoint) {
    const moves = [];
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        if (tryPlaceStone(board, size, x, y, player, koPoint).valid) moves.push([x, y]);
      }
    }
    return moves;
  }

  function calculateScore(board, size, deadStones, captures, gameRules, komi) {
    const scored = cloneBoard(board);
    let deadBlack = 0;
    let deadWhite = 0;

    for (const key of deadStones) {
      const x = Math.floor(key / size);
      const y = key % size;
      const color = scored[x][y];
      if (color !== EMPTY) {
        if (color === BLACK) deadBlack++;
        else deadWhite++;
        scored[x][y] = EMPTY;
      }
    }

    const territory = Array.from({ length: size }, () => Array(size).fill(0));
    const visited = Array.from({ length: size }, () => Array(size).fill(false));

    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        if (visited[x][y] || scored[x][y] !== EMPTY) continue;

        const region = [];
        const borders = new Set();
        const stack = [[x, y]];

        while (stack.length) {
          const [cx, cy] = stack.pop();
          if (visited[cx][cy]) continue;
          visited[cx][cy] = true;

          if (scored[cx][cy] === EMPTY) {
            region.push([cx, cy]);
            for (const [nx, ny] of getNeighbors(size, cx, cy)) {
              if (scored[nx][ny] !== EMPTY) borders.add(scored[nx][ny]);
              else if (!visited[nx][ny]) stack.push([nx, ny]);
            }
          }
        }

        if (borders.size === 1) {
          const owner = [...borders][0];
          for (const [rx, ry] of region) territory[rx][ry] = owner;
        }
      }
    }

    let blackStones = 0;
    let whiteStones = 0;
    let blackTerritory = 0;
    let whiteTerritory = 0;

    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        if (scored[x][y] === BLACK) blackStones++;
        else if (scored[x][y] === WHITE) whiteStones++;
        if (territory[x][y] === BLACK) blackTerritory++;
        else if (territory[x][y] === WHITE) whiteTerritory++;
      }
    }

    if (gameRules === 'japanese') {
      const blackPrisoners = captures[BLACK] + deadWhite;
      const whitePrisoners = captures[WHITE] + deadBlack;
      return {
        black: blackTerritory + blackPrisoners,
        white: whiteTerritory + whitePrisoners + komi,
        blackStones: blackPrisoners,
        blackTerritory,
        whiteStones: whitePrisoners,
        whiteTerritory,
        territory
      };
    }

    return {
      black: blackStones + blackTerritory,
      white: whiteStones + whiteTerritory + komi,
      blackStones,
      blackTerritory,
      whiteStones,
      whiteTerritory,
      territory
    };
  }

  global.GoRules = {
    EMPTY,
    BLACK,
    WHITE,
    createBoard,
    cloneBoard,
    opponent,
    inBounds,
    getNeighbors,
    getGroup,
    removeGroup,
    boardToString,
    tryPlaceStone,
    getLegalMoves,
    calculateScore
  };
})(window);
