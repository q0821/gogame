window.GnuGoService = (function () {
  const LETTERS = 'abcdefghijklmnopqrs';

  let gnugoModule = null;
  let gnugoReady = false;
  let gnugoLoadingPromise = null;

  function buildSGF(moveHistory, size, komi) {
    let sgf = `(;GM[1]FF[4]SZ[${size}]KM[${komi}]`;
    for (const m of moveHistory) {
      const color = m.player === 1 ? 'B' : 'W';
      if (m.pass) {
        sgf += `;${color}[]`;
      } else {
        sgf += `;${color}[${LETTERS[m.y]}${LETTERS[m.x]}]`;
      }
    }
    sgf += ')';
    return sgf;
  }

  function buildSGFUpTo(moveHistory, size, komi, count) {
    return buildSGF(moveHistory.slice(0, count), size, komi);
  }

  function parseMoveFromSgfResponse(sgfResponse, expectedMoveCount, size) {
    const expected = expectedMoveCount ?? 0;
    const movePattern = /;([BW])\[([a-s]{0,2})\]/g;
    const allMoves = [];
    let match;

    while ((match = movePattern.exec(sgfResponse)) !== null) {
      allMoves.push({ color: match[1], coord: match[2] });
    }

    if (allMoves.length <= expected) return null;

    const gnugoMove = allMoves[allMoves.length - 1];
    if (!gnugoMove.coord || gnugoMove.coord.length < 2) return null;

    const col = LETTERS.indexOf(gnugoMove.coord[0]);
    const row = LETTERS.indexOf(gnugoMove.coord[1]);
    if (col < 0 || row < 0 || col >= size || row >= size) return null;

    return [row, col];
  }

  function ensureReady(setStatus) {
    if (gnugoReady) return Promise.resolve();
    if (gnugoLoadingPromise) return gnugoLoadingPromise;

    if (typeof setStatus === 'function') {
      setStatus('⏳ 載入 GnuGo AI 引擎...');
    }

    const Module = {};
    Module.locateFile = function (path) {
      if (path === 'gnugo.wasm') return 'gnugo.wasm';
      return path;
    };

    gnugoLoadingPromise = fetch('gnugo.wasm')
      .then(response => response.arrayBuffer())
      .then(bytes => {
        Module.wasmBinary = new Uint8Array(bytes);
        GnuGoLoader.init(Module);
        gnugoModule = Module;
        gnugoReady = true;
        if (typeof setStatus === 'function') {
          setStatus('GnuGo AI 引擎載入完成！');
        }
      })
      .catch(err => {
        gnugoLoadingPromise = null;
        if (typeof setStatus === 'function') {
          setStatus('⚠️ AI 引擎載入失敗，請確認 gnugo.wasm 檔案存在');
        }
        throw err;
      });

    return gnugoLoadingPromise;
  }

  function play(level, sgf, expectedMoveCount, size) {
    if (!gnugoReady || !gnugoModule) {
      throw new Error('GnuGo not ready');
    }
    const result = gnugoModule.ccall('play', 'string', ['number', 'string'], [level, sgf]);
    return {
      raw: result,
      move: parseMoveFromSgfResponse(result, expectedMoveCount, size)
    };
  }

  function getTopMoves(moveHistory, size, komi, currentPlayer, count) {
    const hints = [];
    const sgfBase = buildSGF(moveHistory, size, komi);
    const first = play(10, sgfBase, moveHistory.length, size).move;
    if (!first) return hints;

    const color = currentPlayer === 1 ? 'B' : 'W';
    const oppColor = currentPlayer === 1 ? 'W' : 'B';

    hints.push(first);

    const sgfForSecond = buildSGF(moveHistory, size, komi).slice(0, -1) +
      `;${color}[${LETTERS[first[1]]}${LETTERS[first[0]]}]` +
      `;${oppColor}[])`;
    const second = play(10, sgfForSecond, moveHistory.length + 2, size).move;
    if (second && (second[0] !== first[0] || second[1] !== first[1])) {
      hints.push(second);
    }

    if (count >= 3 && hints.length >= 2) {
      const secondMove = hints[1];
      const sgfForThird = buildSGF(moveHistory, size, komi).slice(0, -1) +
        `;${color}[${LETTERS[first[1]]}${LETTERS[first[0]]}]` +
        `;${oppColor}[]` +
        `;${color}[${LETTERS[secondMove[1]]}${LETTERS[secondMove[0]]}]` +
        `;${oppColor}[])`;
      const third = play(10, sgfForThird, moveHistory.length + 4, size).move;
      if (third && !hints.some(m => m[0] === third[0] && m[1] === third[1])) {
        hints.push(third);
      }
    }

    return hints.slice(0, count);
  }

  return {
    ensureReady,
    isReady: () => gnugoReady,
    buildSGF,
    buildSGFUpTo,
    parseMoveFromSgfResponse,
    play,
    getTopMoves
  };
})();
