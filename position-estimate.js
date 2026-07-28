// position-estimate.js — 對局中「形勢判斷」的文字格式化（純邏輯、無 DOM）。
//
// 輸入為 KataGo 黑方視角的數值：winrate = 黑勝率(0..1)、scoreLead = 黑領先目數（負=白領先）。
// 輸出白話一句，例：「黑勝率 62%・黑領先約 3.5 目」。差距 < 0.5 目時不硬給領先方，
// 顯示「局勢接近」（引擎在細微差距下的目數並不可靠，誠實以對）。

export function formatPositionEstimate({ winrate, scoreLead }) {
  if (typeof winrate !== 'number' || typeof scoreLead !== 'number') return null;
  const pct = Math.round(winrate * 100);
  const lead = Math.abs(scoreLead);
  const leadTxt = lead < 0.5
    ? '局勢接近'
    : `${scoreLead > 0 ? '黑' : '白'}領先約 ${lead.toFixed(1)} 目`;
  return `黑勝率 ${pct}%・${leadTxt}`;
}

export function isAnalysisRequestCurrent(latestState, requestBoard, requestMoveCount, requestPlayer) {
  return latestState.board === requestBoard
    && latestState.moveHistory.length === requestMoveCount
    && latestState.currentPlayer === requestPlayer
    && !latestState.gameOver;
}
