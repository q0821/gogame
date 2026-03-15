(function (global) {
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;

  function updateHUD(state) {
    const normalizedState = {
      ...state,
      isAIThinking: !!state.isAIThinking && state.currentPlayer !== BLACK
    };

    const turnEl = document.getElementById('turnDisplay');
    if (normalizedState.gameOver) {
      turnEl.textContent = '遊戲結束';
      turnEl.className = 'current-turn';
    } else if (normalizedState.isAIThinking) {
      turnEl.textContent = '🤔 AI 思考中...';
      turnEl.className = 'current-turn';
    } else {
      turnEl.textContent = normalizedState.currentPlayer === BLACK ? '⚫ 黑方回合' : '⚪ 白方回合';
      turnEl.className = 'current-turn ' + (normalizedState.currentPlayer === BLACK ? 'black' : 'white');
    }

    document.getElementById('blackCaptures').textContent = normalizedState.captures[BLACK];
    document.getElementById('whiteCaptures').textContent = normalizedState.captures[WHITE];
    document.getElementById('moveCount').textContent = normalizedState.moveHistory.length;

    const mt = document.getElementById('mobileTurn');
    if (normalizedState.gameOver) {
      mt.textContent = '遊戲結束';
      mt.className = 'turn-badge';
    } else if (normalizedState.isAIThinking) {
      mt.textContent = '🤔 AI 思考中';
      mt.className = 'turn-badge';
    } else {
      mt.textContent = normalizedState.currentPlayer === BLACK ? '⚫ 黑方' : '⚪ 白方';
      mt.className = 'turn-badge ' + (normalizedState.currentPlayer === BLACK ? 'black' : 'white');
    }

    document.getElementById('mobileBlackCap').textContent = state.captures[BLACK];
    document.getElementById('mobileWhiteCap').textContent = state.captures[WHITE];
    document.getElementById('mobileMoveCount').textContent = state.moveHistory.length;
  }

  function setStatus(message) {
    document.getElementById('statusMsg').textContent = message;
    document.getElementById('mobileStatus').textContent = message;
  }

  function getStatusMessage(state, fallbackMessage = '') {
    if (fallbackMessage) return fallbackMessage;
    if (state.gameOver) return '遊戲已結束';
    if (state.isScoring) return '請標記死子，然後確認結果';
    if (state.isReviewing) return '覆盤模式';
    if (state.isAIThinking) return '🤔 GnuGo 思考中...';
    return `${state.currentPlayer === BLACK ? '黑' : '白'}方回合`;
  }

  function syncStatus(state, fallbackMessage = '') {
    setStatus(getStatusMessage(state, fallbackMessage));
  }

  function updateReviewInfo(state) {
    const info = document.getElementById('reviewInfo');
    if (state.currentReviewMove === 0) {
      info.textContent = '開始位置';
      return;
    }

    const move = state.moveHistory[state.currentReviewMove - 1];
    const letters = 'ABCDEFGHJKLMNOPQRST';
    const moveStr = move.pass ? 'Pass' : `${letters[move.y]}${state.size - move.x}`;
    info.textContent = `第 ${state.currentReviewMove} 手 / ${state.moveHistory.length} - ${move.player === BLACK ? '⚫' : '⚪'} ${moveStr}`;
  }

  function updateScoringDisplay(state, score) {
    document.getElementById('blackScore').textContent = score.black.toFixed(1);
    if (state.gameRules === 'japanese') {
      document.getElementById('blackScoreLabel').textContent = '　目+提子';
      document.getElementById('whiteScoreLabel').textContent = '　目+提子（含貼目）';
      document.getElementById('blackDetail').textContent = `目 ${score.blackTerritory} + 提子 ${score.blackStones}`;
      document.getElementById('whiteDetail').textContent = `目 ${score.whiteTerritory} + 提子 ${score.whiteStones} + 貼目 ${state.komi}`;
    } else {
      document.getElementById('blackScoreLabel').textContent = '　棋子+目';
      document.getElementById('whiteScoreLabel').textContent = '　棋子+目（含貼目）';
      document.getElementById('blackDetail').textContent = `${score.blackStones} + ${score.blackTerritory}`;
      document.getElementById('whiteDetail').textContent = `${score.whiteStones} + ${score.whiteTerritory} + ${state.komi}`;
    }

    document.getElementById('whiteScore').textContent = score.white.toFixed(1);
    const diff = score.black - score.white;
    document.getElementById('resultText').textContent = diff > 0
      ? `⚫ 黑勝 ${diff.toFixed(1)} 目`
      : diff < 0
      ? `⚪ 白勝 ${Math.abs(diff).toFixed(1)} 目`
      : '和棋';
  }

  function hideGuidanceTooltip() {
    document.getElementById('guidanceTooltip').style.display = 'none';
  }

  function showGuidanceTooltipAt(deps, hint) {
    const el = document.getElementById('guidanceTooltip');
    const rankNames = ['⭐ 最佳', '🔵 次佳', '🟢 可考慮'];
    const cx = deps.padding + hint.y * deps.cellSize;
    const cy = deps.padding + hint.x * deps.cellSize;
    const rect = deps.canvas.getBoundingClientRect();
    const left = rect.left + window.scrollX + cx;
    const top = rect.top + window.scrollY + cy - 35;
    el.textContent = `${rankNames[hint.rank] || ''} — ${hint.label}（點擊落子）`;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.transform = 'translateX(-50%)';
    el.style.display = 'block';
  }

  function resizeCanvas(deps, state) {
    const isMobile = window.innerWidth <= 900;
    let maxSize;
    if (isMobile) {
      const maxW = window.innerWidth - 20;
      const maxH = window.innerHeight - 160;
      maxSize = Math.max(280, Math.min(maxW, maxH));
    } else {
      const panelWidth = 260;
      const maxW = window.innerWidth - panelWidth * 2 - 80;
      const maxH = window.innerHeight - 120;
      maxSize = Math.max(400, Math.min(maxW, maxH, 800));
    }
    const cellSize = Math.floor((maxSize - deps.padding * 2) / (state.size - 1));
    const canvasSize = cellSize * (state.size - 1) + deps.padding * 2;
    deps.canvas.width = canvasSize;
    deps.canvas.height = canvasSize;
    deps.canvas.style.width = `${canvasSize}px`;
    deps.canvas.style.height = `${canvasSize}px`;
    return cellSize;
  }

  function drawStone(deps, x, y, color, isDead) {
    const cx = deps.padding + y * deps.cellSize;
    const cy = deps.padding + x * deps.cellSize;
    const r = deps.cellSize * 0.44;
    const ctx = deps.ctx;

    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(cx + 2, cy + 2, r, 0, Math.PI * 2);
    ctx.fill();

    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    if (color === BLACK) {
      grad.addColorStop(0, '#555');
      grad.addColorStop(1, '#111');
    } else {
      grad.addColorStop(0, '#fff');
      grad.addColorStop(1, '#ccc');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color === BLACK ? '#000' : '#aaa';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    if (isDead) {
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 2.5;
      const d = r * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx - d, cy - d);
      ctx.lineTo(cx + d, cy + d);
      ctx.moveTo(cx + d, cy - d);
      ctx.lineTo(cx - d, cy + d);
      ctx.stroke();
    }
  }

  function drawBoard(deps, state) {
    deps.cellSize = resizeCanvas(deps, state);
    const ctx = deps.ctx;
    const canvas = deps.canvas;
    const w = canvas.width;

    ctx.fillStyle = '#dcb35c';
    ctx.fillRect(0, 0, w, w);
    ctx.save();
    ctx.globalAlpha = 0.15;
    for (let i = 0; i < w; i += 8) {
      ctx.strokeStyle = i % 24 === 0 ? '#a08030' : '#c4a04c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(w, i + (Math.sin(i * 0.05) * 3));
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = '#5a4420';
    ctx.lineWidth = 1;
    for (let i = 0; i < state.size; i++) {
      const pos = deps.padding + i * deps.cellSize;
      ctx.beginPath();
      ctx.moveTo(deps.padding, pos);
      ctx.lineTo(deps.padding + (state.size - 1) * deps.cellSize, pos);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pos, deps.padding);
      ctx.lineTo(pos, deps.padding + (state.size - 1) * deps.cellSize);
      ctx.stroke();
    }

    const stars = deps.starPoints[state.size] || [];
    for (const [x, y] of stars) {
      ctx.fillStyle = '#5a4420';
      ctx.beginPath();
      ctx.arc(deps.padding + y * deps.cellSize, deps.padding + x * deps.cellSize, deps.cellSize * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#5a4420';
    ctx.font = `${Math.max(10, deps.cellSize * 0.35)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const letters = 'ABCDEFGHJKLMNOPQRST';
    for (let i = 0; i < state.size; i++) {
      const pos = deps.padding + i * deps.cellSize;
      ctx.fillText(letters[i], pos, deps.padding + (state.size - 1) * deps.cellSize + deps.cellSize * 0.7);
      ctx.fillText(state.size - i, deps.padding - deps.cellSize * 0.6, pos);
    }

    if (state.isScoring && state.scoreData) {
      for (let x = 0; x < state.size; x++) {
        for (let y = 0; y < state.size; y++) {
          if (state.displayBoard[x][y] === EMPTY && state.scoreData.territory[x][y] !== 0) {
            const cx = deps.padding + y * deps.cellSize;
            const cy = deps.padding + x * deps.cellSize;
            ctx.fillStyle = state.scoreData.territory[x][y] === BLACK ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.4)';
            ctx.fillRect(cx - deps.cellSize * 0.2, cy - deps.cellSize * 0.2, deps.cellSize * 0.4, deps.cellSize * 0.4);
          }
        }
      }
    }

    for (let x = 0; x < state.size; x++) {
      for (let y = 0; y < state.size; y++) {
        if (state.displayBoard[x][y] !== EMPTY) {
          drawStone(deps, x, y, state.displayBoard[x][y], state.deadStones.has(x * state.size + y));
        }
      }
    }

    if (state.lastMove) {
      const [lx, ly] = state.lastMove;
      if (state.displayBoard[lx][ly] !== EMPTY) {
        ctx.fillStyle = state.displayBoard[lx][ly] === BLACK ? '#fff' : '#000';
        ctx.beginPath();
        ctx.arc(deps.padding + ly * deps.cellSize, deps.padding + lx * deps.cellSize, deps.cellSize * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (state.isReviewing && state.analysisData && !state.isAnalyzing && state.currentReviewMove > 0) {
      const d = state.analysisData[state.currentReviewMove - 1];
      if (d && !d.move.pass) {
        const mx = d.move.x, my = d.move.y;
        const mcx = deps.padding + my * deps.cellSize;
        const mcy = deps.padding + mx * deps.cellSize;
        let markerColor = null;
        let markerLabel = '';
        if (d.rating === 'good') {
          markerColor = '#4caf50'; markerLabel = '✓';
        } else if (d.rating === 'question') {
          markerColor = '#ff9800'; markerLabel = '?';
        } else if (d.rating === 'bad') {
          markerColor = '#f44336'; markerLabel = '✗';
        }
        if (markerColor) {
          ctx.save();
          ctx.fillStyle = markerColor;
          ctx.font = `bold ${Math.max(12, deps.cellSize * 0.4)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(markerLabel, mcx, mcy);
          ctx.restore();
        }
        if (d.aiSuggestion && d.rating !== 'good') {
          const [ax, ay] = d.aiSuggestion;
          const acx = deps.padding + ay * deps.cellSize;
          const acy = deps.padding + ax * deps.cellSize;
          ctx.save();
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = '#4caf50';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(acx, acy, deps.cellSize * 0.38, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 0.8;
          ctx.fillStyle = '#4caf50';
          ctx.font = `bold ${Math.max(10, deps.cellSize * 0.3)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('AI', acx, acy);
          ctx.restore();
        }
      }
    }

    if (state.showingHint && !state.gameOver && !state.isReviewing && !state.isScoring && !state.isAIThinking) {
      for (const [hx, hy] of state.captureHints || []) {
        const cx = deps.padding + hy * deps.cellSize;
        const cy = deps.padding + hx * deps.cellSize;
        ctx.save();
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(cx, cy, deps.cellSize * 0.38, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ff4444';
        ctx.font = `bold ${Math.max(10, deps.cellSize * 0.35)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', cx, cy);
        ctx.restore();
      }
    }

    if (state.guidanceEnabled && !state.gameOver && !state.isReviewing && !state.isScoring) {
      if (state.guidanceLoading) {
        ctx.save();
        ctx.fillStyle = 'rgba(240,208,96,0.7)';
        ctx.font = `${Math.max(12, deps.cellSize * 0.4)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🔄 AI 分析中...', canvas.width / 2, canvas.height - 10);
        ctx.restore();
      }
      const rankStyles = [
        { color: '#ffd700', marker: '⭐', rankLabel: '最佳' },
        { color: '#4a9eff', marker: '🔵', rankLabel: '次佳' },
        { color: '#4caf50', marker: '🟢', rankLabel: '可考慮' }
      ];
      for (const hint of state.guidanceHints || []) {
        const cx = deps.padding + hint.y * deps.cellSize;
        const cy = deps.padding + hint.x * deps.cellSize;
        const style = rankStyles[hint.rank] || rankStyles[2];
        ctx.save();
        ctx.strokeStyle = style.color;
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(cx, cy, deps.cellSize * 0.4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = style.color;
        ctx.globalAlpha = 0.15;
        ctx.beginPath();
        ctx.arc(cx, cy, deps.cellSize * 0.38, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
        ctx.font = `${Math.max(12, deps.cellSize * 0.4)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(style.marker, cx, cy);
        ctx.fillStyle = style.color;
        ctx.font = `bold ${Math.max(9, deps.cellSize * 0.28)}px sans-serif`;
        ctx.fillText(hint.label, cx, cy + deps.cellSize * 0.5);
        ctx.restore();
      }
      if ((state.guidanceHints || []).length > 0) {
        ctx.save();
        const lx = canvas.width - 10;
        const ly = 10;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.font = `bold ${Math.max(10, deps.cellSize * 0.3)}px sans-serif`;
        for (let i = 0; i < rankStyles.length; i++) {
          const s = rankStyles[i];
          ctx.fillStyle = s.color;
          ctx.fillText(`${s.marker} ${s.rankLabel}`, lx, ly + i * (deps.cellSize * 0.38));
        }
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = `${Math.max(9, deps.cellSize * 0.22)}px sans-serif`;
        ctx.fillText('點擊標記查看說明', lx, ly + 3 * (deps.cellSize * 0.38));
        ctx.restore();
      }
    }

    if (state.hoverPos && !state.gameOver && !state.isReviewing && !state.isScoring && !state.isAIThinking) {
      const [hx, hy] = state.hoverPos;
      if (state.board[hx][hy] === EMPTY) {
        ctx.globalAlpha = 0.4;
        drawStone(deps, hx, hy, state.currentPlayer, false);
        ctx.globalAlpha = 1.0;
      }
    }
  }

  global.GoUI = {
    updateHUD,
    setStatus,
    getStatusMessage,
    syncStatus,
    updateReviewInfo,
    updateScoringDisplay,
    hideGuidanceTooltip,
    showGuidanceTooltipAt,
    resizeCanvas,
    drawStone,
    drawBoard
  };
})(window);
