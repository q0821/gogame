// event-handlers.js — all DOM event listeners for the game canvas and controls.
// Called once from main.js after initialisation.

export function registerEventHandlers(app) {
  const { canvas } = app;

  // ——— Mouse / touch helpers ———
  function getBoardPositionFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const point = e.touches?.[0] || e.changedTouches?.[0] || e;
    // HiDPI 後 canvas.width 是裝置解析度；點擊需換算到「CSS 邏輯座標」（cellSize/padding 所在座標系）
    const logicalW = parseFloat(canvas.style.width) || canvas.width;
    const logicalH = parseFloat(canvas.style.height) || canvas.height;
    const scaleX = rect.width > 0 ? logicalW / rect.width : 1;
    const scaleY = rect.height > 0 ? logicalH / rect.height : 1;
    const mx = (point.clientX - rect.left) * scaleX;
    const my = (point.clientY - rect.top) * scaleY;
    const x = Math.round((my - app.padding) / app.cellSize);
    const y = Math.round((mx - app.padding) / app.cellSize);
    return app.inBounds(x, y) ? [x, y] : null;
  }

  function handleBoardInteraction(e) {
    const pos = getBoardPositionFromEvent(e);
    if (!pos) return;
    const [x, y] = pos;

    if (app.isScoring) {
      if (app.board[x][y] !== app.EMPTY) {
        const group = app.getGroup(app.board, x, y);
        const result = app.toggleDeadGroup(group.stones);
        if (!result.ok) return;
        app.updateScoringDisplay();
        app.drawBoard();
      }
      return;
    }

    // pvc 模式只在輪到你時才允許手動落子。原本僅靠 isAIThinking 旗標擋，旗標若因
    // AI 出錯被清掉、但仍停在 AI 回合時就會破防 → 玩家點擊會幫 AI 下子弄亂棋局。
    // 改以「是否輪到玩家」為準（AI 透過 app.placeStone 落子不經此處，不受影響）。
    if (app.gameMode === 'pvc' && app.currentPlayer !== app.playerColor) return;

    app.placeStone(x, y);
  }

  // ——— Mouse events ———
  let _mouseMoveRaf = null;
  canvas.addEventListener('mousemove', (e) => {
    if (_mouseMoveRaf) return;
    _mouseMoveRaf = requestAnimationFrame(() => {
      _mouseMoveRaf = null;
      const pos = getBoardPositionFromEvent(e);
      app.hoverPos = pos;
      app.drawBoard();
    });
  });

  canvas.addEventListener('mouseleave', () => {
    app.hoverPos = null;
    app.drawBoard();
  });

  // ——— Touch events ———
  let lastTouchInteractionAt = 0;

  canvas.addEventListener('click', (e) => {
    if (Date.now() - lastTouchInteractionAt < 500) return;
    handleBoardInteraction(e);
  });

  canvas.addEventListener('touchstart', (e) => {
    const pos = getBoardPositionFromEvent(e);
    app.hoverPos = pos;
    app.drawBoard();
  }, { passive: true });

  canvas.addEventListener('touchend', (e) => {
    lastTouchInteractionAt = Date.now();
    app.hoverPos = null; // clear hover ghost after touch
    e.preventDefault();
    handleBoardInteraction(e);
  }, { passive: false });

  // ——— Settings visibility toggles ———
  document.getElementById('gameMode').addEventListener('change', (e) => {
    const isPvC = e.target.value === 'pvc';
    document.getElementById('playerColorGroup').style.display = isPvC ? 'block' : 'none';
    document.getElementById('aiStrengthGroup').style.display = isPvC ? 'block' : 'none';
    const hg = document.getElementById('handicapGroup');
    if (hg) hg.style.display = isPvC ? 'block' : 'none';
  });

  // 讓子 > 0 時固定執黑（人拿讓子）：鎖住執子選單並設為黑。
  const handicapEl = document.getElementById('handicap');
  if (handicapEl) {
    handicapEl.addEventListener('change', (e) => {
      const on = (parseInt(e.target.value) || 0) >= 2;
      const pc = document.getElementById('playerColor');
      if (pc) { if (on) pc.value = '1'; pc.disabled = on; }
    });
  }

  document.getElementById('emotionToggle').addEventListener('change', (e) => {
    app.emotionEnabled = e.target.checked;
    app.drawBoard();
  });

  document.getElementById('timerToggle').addEventListener('change', (e) => {
    const show = e.target.checked;
    document.getElementById('timerSettings').style.display = show ? 'block' : 'none';
    document.getElementById('timerArea').style.display = show ? 'block' : 'none';
  });

  // ——— Keyboard shortcuts for review ———
  document.addEventListener('keydown', (e) => {
    if (!app.isReviewing) return;
    if (e.key === 'ArrowLeft') app.reviewGo(app.currentReviewMove - 1);
    else if (e.key === 'ArrowRight') app.reviewGo(app.currentReviewMove + 1);
    else if (e.key === 'Home') app.reviewGo(0);
    else if (e.key === 'End') app.reviewGo(app.moveHistory.length);
  });

  // ——— Resize ———
  window.addEventListener('resize', () => {
    // 只有對弈棋盤已初始化時才重繪；在首頁/死活畫面 board 為空，重繪會讀到 undefined
    if (app.board && app.board.length) app.drawBoard();
  });
}
