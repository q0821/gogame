const { sandboxWithGoUI } = require('./helpers');

const BLACK = 1;
const WHITE = 2;

/** 組一份 updateHUD / getStatusMessage 需要的最小狀態（欄位名與 GameState 一致）。 */
function hudState(overrides = {}) {
  return {
    size: 9,
    currentPlayer: BLACK,
    captures: { [BLACK]: 0, [WHITE]: 0 },
    moveHistory: [],
    gameOver: false,
    isAIThinking: false,
    isScoring: false,
    isReviewing: false,
    ...overrides
  };
}

describe('ui.js 渲染層（純 DOM 的 8 個 export）', () => {
  // ——— updateHUD：#mobileTurn 回合徽章 ———
  // 此徽章是使用者判斷「該誰下」的唯一依據，三條分支各自的文字與 class 都釘住。
  describe('updateHUD 的回合徽章', () => {
    test('終局時顯示「遊戲結束」，不再顯示任何一方', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateHUD(hudState({ gameOver: true, currentPlayer: WHITE }));
      expect({
        text: elements.mobileTurn.textContent,
        cls: elements.mobileTurn.className
      }).toEqual({ text: '遊戲結束', cls: 'turn-badge' });
    });

    test('終局優先於 AI 思考中', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateHUD(hudState({ gameOver: true, isAIThinking: true, currentPlayer: WHITE }));
      expect(elements.mobileTurn.textContent).toBe('遊戲結束');
    });

    test('AI 思考中且輪白時顯示「AI 思考中」', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateHUD(hudState({ isAIThinking: true, currentPlayer: WHITE }));
      expect({
        text: elements.mobileTurn.textContent,
        cls: elements.mobileTurn.className
      }).toEqual({ text: 'AI 思考中', cls: 'turn-badge' });
    });

    test('AI 思考中但輪黑時顯示「黑方」（isAIThinking 被 normalize 掉）', () => {
      // updateHUD 內的 `!!isAIThinking && currentPlayer !== BLACK` 是現行真實規則：
      // 人類執黑時即使 isAIThinking 殘留為真，徽章仍顯示黑方。此處只凍結行為、不改行為。
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateHUD(hudState({ isAIThinking: true, currentPlayer: BLACK }));
      expect({
        text: elements.mobileTurn.textContent,
        cls: elements.mobileTurn.className
      }).toEqual({ text: '黑方', cls: 'turn-badge black' });
    });

    test('一般對局依 currentPlayer 顯示黑方／白方並帶對應 class', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateHUD(hudState({ currentPlayer: BLACK }));
      const black = { text: elements.mobileTurn.textContent, cls: elements.mobileTurn.className };
      GoUI.updateHUD(hudState({ currentPlayer: WHITE }));
      const white = { text: elements.mobileTurn.textContent, cls: elements.mobileTurn.className };
      expect({ black, white }).toEqual({
        black: { text: '黑方', cls: 'turn-badge black' },
        white: { text: '白方', cls: 'turn-badge white' }
      });
    });

    test('數目中沒有專屬分支，徽章照常顯示當手方', () => {
      // updateHUD 不看 isScoring；數目的提示由狀態列（getStatusMessage）負責。
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateHUD(hudState({ isScoring: true, currentPlayer: WHITE }));
      expect(elements.mobileTurn.textContent).toBe('白方');
    });
  });

  test('updateHUD 把提子數與手數寫進手機資訊列', () => {
    const { GoUI, elements } = sandboxWithGoUI();
    GoUI.updateHUD(hudState({
      captures: { [BLACK]: 3, [WHITE]: 5 },
      moveHistory: [{}, {}, {}, {}, {}, {}, {}]
    }));
    expect({
      black: elements.mobileBlackCap.textContent,
      white: elements.mobileWhiteCap.textContent,
      moves: elements.mobileMoveCount.textContent
    }).toEqual({ black: 3, white: 5, moves: 7 });
  });

  // ——— 狀態列 ———
  test('setStatus 同時寫入 #statusMsg 與 #mobileStatus', () => {
    const { GoUI, elements } = sandboxWithGoUI();
    GoUI.setStatus('測試訊息');
    expect({
      desktop: elements.statusMsg.textContent,
      mobile: elements.mobileStatus.textContent
    }).toEqual({ desktop: '測試訊息', mobile: '測試訊息' });
  });

  test('getStatusMessage 的優先序：fallback > 終局 > 數目 > 覆盤 > AI > 回合', () => {
    const { GoUI } = sandboxWithGoUI();
    const all = hudState({ gameOver: true, isScoring: true, isReviewing: true, isAIThinking: true });
    expect({
      fallback: GoUI.getStatusMessage(all, '自訂訊息'),
      gameOver: GoUI.getStatusMessage(all),
      scoring: GoUI.getStatusMessage(hudState({ isScoring: true, isReviewing: true, isAIThinking: true })),
      reviewing: GoUI.getStatusMessage(hudState({ isReviewing: true, isAIThinking: true })),
      aiThinking: GoUI.getStatusMessage(hudState({ isAIThinking: true })),
      black: GoUI.getStatusMessage(hudState({ currentPlayer: BLACK })),
      white: GoUI.getStatusMessage(hudState({ currentPlayer: WHITE }))
    }).toEqual({
      fallback: '自訂訊息',
      gameOver: '遊戲結束 — 可覆盤或開始新局',
      scoring: '已自動估算死子，可點擊修正，然後確認結果',
      reviewing: '覆盤模式',
      aiThinking: 'AI 思考中...',
      black: '黑方回合',
      white: '白方回合'
    });
  });

  test('syncStatus 把 getStatusMessage 的結果寫進狀態列', () => {
    const { GoUI, elements } = sandboxWithGoUI();
    GoUI.syncStatus(hudState({ currentPlayer: WHITE }));
    expect(elements.mobileStatus.textContent).toBe('白方回合');
    GoUI.syncStatus(hudState({ currentPlayer: WHITE }), '覆寫訊息');
    expect(elements.mobileStatus.textContent).toBe('覆寫訊息');
  });

  // ——— 覆盤資訊列 ———
  describe('updateReviewInfo', () => {
    const moves = [
      { x: 2, y: 3, player: BLACK },
      { pass: true, player: WHITE }
    ];

    test('第 0 手顯示「開始位置」，並同步 slider 的 max/value', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateReviewInfo(hudState({ moveHistory: moves, currentReviewMove: 0 }));
      expect({
        text: elements.reviewInfo.textContent,
        max: elements.reviewSlider.max,
        value: elements.reviewSlider.value
      }).toEqual({ text: '開始位置', max: 2, value: 0 });
    });

    test('落子手顯示座標（縱線字母跳過 I）', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateReviewInfo(hudState({ moveHistory: moves, currentReviewMove: 1 }));
      expect(elements.reviewInfo.textContent).toBe('第 1 手 / 2 - 黑 D7');
    });

    test('虛手顯示 Pass', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateReviewInfo(hudState({ moveHistory: moves, currentReviewMove: 2 }));
      expect(elements.reviewInfo.textContent).toBe('第 2 手 / 2 - 白 Pass');
    });
  });

  // ——— 數目結果 ———
  describe('updateScoringDisplay', () => {
    const score = {
      black: 40.0, white: 32.5,
      blackTerritory: 20, whiteTerritory: 15,
      blackStones: 20, whiteStones: 10
    };

    test('中國規則顯示「棋子+目」的分項', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateScoringDisplay({ gameRules: 'chinese', komi: 7.5 }, score);
      expect({
        blackLabel: elements.blackScoreLabel.textContent,
        whiteLabel: elements.whiteScoreLabel.textContent,
        blackDetail: elements.blackDetail.textContent,
        whiteDetail: elements.whiteDetail.textContent,
        blackScore: elements.blackScore.textContent,
        whiteScore: elements.whiteScore.textContent
      }).toEqual({
        blackLabel: '　棋子+目',
        whiteLabel: '　棋子+目（含貼目）',
        blackDetail: '20 + 20',
        whiteDetail: '10 + 15 + 7.5',
        blackScore: '40.0',
        whiteScore: '32.5'
      });
    });

    test('日本規則顯示「目+提子」的分項', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateScoringDisplay({ gameRules: 'japanese', komi: 6.5 }, score);
      expect({
        blackLabel: elements.blackScoreLabel.textContent,
        whiteLabel: elements.whiteScoreLabel.textContent,
        blackDetail: elements.blackDetail.textContent,
        whiteDetail: elements.whiteDetail.textContent
      }).toEqual({
        blackLabel: '　目+提子',
        whiteLabel: '　目+提子（含貼目）',
        blackDetail: '目 20 + 提子 20',
        whiteDetail: '目 15 + 提子 10 + 貼目 6.5'
      });
    });

    test('勝負字串涵蓋黑勝／白勝／和棋三種結果', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      const state = { gameRules: 'chinese', komi: 7.5 };
      const readResult = (black, white) => {
        GoUI.updateScoringDisplay(state, { ...score, black, white });
        return elements.resultText.textContent;
      };
      expect({
        blackWins: readResult(40, 32.5),
        whiteWins: readResult(30, 32.5),
        draw: readResult(32.5, 32.5)
      }).toEqual({
        blackWins: '黑勝 7.5 目',
        whiteWins: '白勝 2.5 目',
        draw: '和棋'
      });
    });

    test('手機數目結果列同時帶雙方目數與勝負', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateScoringDisplay({ gameRules: 'chinese', komi: 7.5 }, score);
      expect(elements.mobileScoreResult.textContent)
        .toBe('黑 40.0　白 32.5（含貼目）　→　黑勝 7.5 目');
    });
  });

  // ——— 覆盤逐手分析 ———
  describe('updateReviewAnalysisInfo', () => {
    const moveHistory = [{ x: 2, y: 3, player: BLACK }];

    test('沒有分析資料時清空文字與 class', () => {
      const { ctx, GoUI, elements } = sandboxWithGoUI();
      // elements 是首次 getElementById 才建立，先取一次再塞殘留值。
      ctx.document.getElementById('reviewAnalysisInfo').textContent = '殘留';
      GoUI.updateReviewAnalysisInfo(hudState({ moveHistory, currentReviewMove: 1, analysis: null }));
      expect({
        text: elements.reviewAnalysisInfo.textContent,
        cls: elements.reviewAnalysisInfo.className
      }).toEqual({ text: '', cls: 'move-info' });
    });

    test('第 0 手顯示開局勝率', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateReviewAnalysisInfo(hudState({
        moveHistory, currentReviewMove: 0, analysis: [{ wr: 0.5, lead: 0 }]
      }));
      expect(elements.reviewAnalysisInfo.textContent).toBe('本局開始 — 黑勝率 50%');
    });

    test('黑方大失分的手會標記為疑問手並附勝率損失', () => {
      const { GoUI, elements } = sandboxWithGoUI();
      GoUI.updateReviewAnalysisInfo(hudState({
        moveHistory,
        currentReviewMove: 1,
        analysis: [{ wr: 0.60, lead: 5 }, { wr: 0.40, lead: 0 }]
      }));
      expect({
        text: elements.reviewAnalysisInfo.textContent,
        cls: elements.reviewAnalysisInfo.className
      }).toEqual({
        text: '第 1 手（黑）— 黑勝率 40%；這手約失 20% 勝率（≈ 5.0 目，估計） · 疑問手',
        cls: 'move-info bad'
      });
    });
  });
});
