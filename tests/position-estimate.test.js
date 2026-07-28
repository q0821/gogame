// position-estimate：對局中形勢判斷的文字格式化（黑方視角的 winrate/scoreLead → 白話）。
const { sandboxWithPositionEstimate } = require('./helpers');

let formatPositionEstimate;
let isAnalysisRequestCurrent;
beforeAll(() => {
  const ctx = sandboxWithPositionEstimate();
  formatPositionEstimate = ctx.formatPositionEstimate;
  isAnalysisRequestCurrent = ctx.isAnalysisRequestCurrent;
});

test('黑領先：勝率取整數百分比、目數一位小數', () => {
  expect(formatPositionEstimate({ winrate: 0.62, scoreLead: 3.5 }))
    .toBe('黑勝率 62%・黑領先約 3.5 目');
});

test('白領先：目數取絕對值、標示白方', () => {
  expect(formatPositionEstimate({ winrate: 0.3, scoreLead: -7.2 }))
    .toBe('黑勝率 30%・白領先約 7.2 目');
});

test('差距小於 0.5 目視為局勢接近', () => {
  expect(formatPositionEstimate({ winrate: 0.5, scoreLead: 0.2 }))
    .toBe('黑勝率 50%・局勢接近');
});

test('缺少數值時回傳 null（引擎未給出評估）', () => {
  expect(formatPositionEstimate({ winrate: null, scoreLead: 3 })).toBeNull();
  expect(formatPositionEstimate({ winrate: 0.5, scoreLead: undefined })).toBeNull();
});

test('手數與行棋方相同但棋盤已替換時，丟棄舊分析結果', () => {
  const requestBoard = [[1, 0], [0, 0]];
  const latestState = {
    board: [[0, 1], [0, 0]],
    moveHistory: [{ x: 0, y: 1, player: 1 }],
    currentPlayer: 2,
    gameOver: false,
  };
  const staleResult = { ownership: [0.8, -0.2, 0.1, -0.1] };
  let visibleOwnership = null;

  if (isAnalysisRequestCurrent(latestState, requestBoard, 1, 2)) {
    visibleOwnership = staleResult.ownership;
  }

  expect(visibleOwnership).toBeNull();
});
