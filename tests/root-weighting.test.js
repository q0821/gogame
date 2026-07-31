/**
 * KataGo root 加權統計的手番對稱性測試。
 *
 * 背景（port bug）：pruneNoiseWeight 與 downweightBadChildrenAndNormalizeWeight 兩個
 * 加權函式都是「selfUtility 越高、權重越大」的單調函式，上游 C++ 刻意讓它們
 * player-agnostic，手番翻號放在填 MoreNodeStats 的地方：
 *
 *   cpp/search/searchupdatehelpers.cpp  recomputeNodeStats()
 *   stats.selfUtility = node.nextPla == P_WHITE ? childUtility : -childUtility;
 *
 * 本 port 的 utilitySum 累加的是「黑方視角」效用（Node.utilitySum 註解、
 * computeBlackUtilityFromEval 最後 return -whiteUtility），原本卻直接把它當成
 * selfUtility 丟進加權，等於永遠假設 root 手番是黑——白先的 root 加權方向相反，
 * 回報的黑勝率一律偏高。selfUtilityForRoot() 就是把上游那行翻號補回來。
 *
 * 測試手法：餵完全鏡像的合成資料（黑方視角的 value / scoreLead / scoreMean /
 * blackUtility 全部翻號，policy 與 visits 不變，scoreMeanSq 因為是平方平均所以是翻號
 * 不變量），黑先與白先算出的黑勝率必須互補相加為 1。修好之後兩邊餵進加權的
 * selfUtility 完全相同（位元級），所以誤差是精確的 0，容差用 1e-12。
 *
 * 注意：computeWeightedRootStats 會就地改寫 children（權重會被覆寫、陣列會被
 * pruneNoiseWeight 重新排序），每次呼叫都必須用全新建構的物件。
 */
const { sandboxWithRootWeighting } = require('./helpers');

let ctx;
let selfUtilityForRoot, computeWeightedRootStats, tDistCdf3, pruneNoiseWeight;

beforeAll(() => {
  ctx = sandboxWithRootWeighting();
  selfUtilityForRoot = ctx.selfUtilityForRoot;
  computeWeightedRootStats = ctx.computeWeightedRootStats;
  tDistCdf3 = ctx.tDistCdf3;
  pruneNoiseWeight = ctx.pruneNoiseWeight;
});

/**
 * 五組場景，一律以「黑先」的黑方視角描述。鏡像版本由 buildInput() 產生。
 * child: policy / visits / value（黑視角 [-1,1]）/ blackUtility / scoreLead /
 *        scoreMean / scoreStdev（stdev 為翻號不變量，用來組 scoreMeanSq）
 */
const SCENARIOS = [
  {
    name: '均衡、候選之間差距小',
    children: [
      { policy: 0.35, visits: 420, value: 0.04, blackUtility: 0.06, scoreLead: 0.8, scoreMean: 0.9, scoreStdev: 12.0 },
      { policy: 0.22, visits: 260, value: 0.02, blackUtility: 0.03, scoreLead: 0.5, scoreMean: 0.6, scoreStdev: 12.2 },
      { policy: 0.15, visits: 150, value: -0.01, blackUtility: 0.0, scoreLead: 0.1, scoreMean: 0.2, scoreStdev: 12.5 },
      { policy: 0.1, visits: 90, value: -0.05, blackUtility: -0.04, scoreLead: -0.4, scoreMean: -0.3, scoreStdev: 12.8 },
      { policy: 0.06, visits: 40, value: -0.09, blackUtility: -0.08, scoreLead: -0.9, scoreMean: -0.8, scoreStdev: 13.0 },
    ],
    rootSelf: { value: 0.03, blackUtility: 0.05, scoreLead: 0.7, scoreMean: 0.8, scoreStdev: 12.1 },
  },
  {
    name: '均衡、候選之間差距大',
    children: [
      { policy: 0.4, visits: 600, value: 0.3, blackUtility: 0.34, scoreLead: 5.2, scoreMean: 5.5, scoreStdev: 11.0 },
      { policy: 0.2, visits: 180, value: 0.05, blackUtility: 0.07, scoreLead: 1.1, scoreMean: 1.3, scoreStdev: 11.8 },
      { policy: 0.14, visits: 100, value: -0.12, blackUtility: -0.1, scoreLead: -2.0, scoreMean: -1.8, scoreStdev: 12.4 },
      { policy: 0.09, visits: 60, value: -0.35, blackUtility: -0.33, scoreLead: -6.1, scoreMean: -5.9, scoreStdev: 13.2 },
      { policy: 0.05, visits: 25, value: -0.55, blackUtility: -0.52, scoreLead: -9.4, scoreMean: -9.1, scoreStdev: 14.0 },
    ],
    rootSelf: { value: 0.22, blackUtility: 0.25, scoreLead: 4.0, scoreMean: 4.3, scoreStdev: 11.4 },
  },
  {
    // 最有鑑別力的一組：唯一的好手 policy 低但 visits 高，其餘全是輸棋，
    // pruneNoiseWeight 的剪枝與 downweight 的降權都被強烈觸發。
    name: '一手定生死（唯一好手 policy 低、visits 高）',
    children: [
      { policy: 0.12, visits: 900, value: 0.62, blackUtility: 0.7, scoreLead: 14.5, scoreMean: 15.0, scoreStdev: 9.0 },
      { policy: 0.46, visits: 60, value: -0.88, blackUtility: -0.93, scoreLead: -22.0, scoreMean: -21.5, scoreStdev: 8.0 },
      { policy: 0.2, visits: 25, value: -0.9, blackUtility: -0.95, scoreLead: -23.5, scoreMean: -23.0, scoreStdev: 8.2 },
      { policy: 0.1, visits: 10, value: -0.92, blackUtility: -0.96, scoreLead: -24.0, scoreMean: -23.8, scoreStdev: 8.4 },
      { policy: 0.04, visits: 5, value: -0.94, blackUtility: -0.97, scoreLead: -25.0, scoreMean: -24.6, scoreStdev: 8.6 },
    ],
    rootSelf: { value: 0.1, blackUtility: 0.12, scoreLead: 2.0, scoreMean: 2.4, scoreStdev: 12.0 },
  },
  {
    name: '訪問數少而分散',
    children: [
      { policy: 0.18, visits: 9, value: 0.15, blackUtility: 0.18, scoreLead: 2.4, scoreMean: 2.7, scoreStdev: 13.0 },
      { policy: 0.17, visits: 8, value: 0.02, blackUtility: 0.04, scoreLead: 0.3, scoreMean: 0.5, scoreStdev: 13.3 },
      { policy: 0.16, visits: 7, value: -0.1, blackUtility: -0.08, scoreLead: -1.6, scoreMean: -1.4, scoreStdev: 13.6 },
      { policy: 0.15, visits: 6, value: -0.22, blackUtility: -0.2, scoreLead: -3.5, scoreMean: -3.2, scoreStdev: 13.9 },
      { policy: 0.14, visits: 5, value: -0.31, blackUtility: -0.29, scoreLead: -5.0, scoreMean: -4.7, scoreStdev: 14.2 },
      { policy: 0.1, visits: 3, value: -0.44, blackUtility: -0.41, scoreLead: -7.2, scoreMean: -6.9, scoreStdev: 14.6 },
    ],
    rootSelf: { value: 0.05, blackUtility: 0.07, scoreLead: 0.9, scoreMean: 1.2, scoreStdev: 13.1 },
  },
  {
    name: '黑大優',
    children: [
      { policy: 0.55, visits: 800, value: 0.86, blackUtility: 0.91, scoreLead: 19.0, scoreMean: 19.6, scoreStdev: 7.5 },
      { policy: 0.2, visits: 120, value: 0.78, blackUtility: 0.83, scoreLead: 16.2, scoreMean: 16.8, scoreStdev: 8.0 },
      { policy: 0.12, visits: 60, value: 0.7, blackUtility: 0.74, scoreLead: 13.5, scoreMean: 14.0, scoreStdev: 8.4 },
      { policy: 0.07, visits: 25, value: 0.55, blackUtility: 0.58, scoreLead: 10.0, scoreMean: 10.5, scoreStdev: 9.0 },
      { policy: 0.03, visits: 8, value: 0.3, blackUtility: 0.32, scoreLead: 5.5, scoreMean: 6.0, scoreStdev: 9.8 },
    ],
    rootSelf: { value: 0.82, blackUtility: 0.87, scoreLead: 17.5, scoreMean: 18.0, scoreStdev: 7.8 },
  },
];

/**
 * 依手番建出 computeWeightedRootStats 的輸入。
 * rootPlayerIsBlack=false 時整個局面鏡像：所有黑方視角的量翻號，policy／visits 不變。
 * 每次呼叫都建全新物件（computeWeightedRootStats 會就地改寫輸入）。
 */
function buildInput(scenario, rootPlayerIsBlack, flip = selfUtilityForRoot) {
  const sgn = rootPlayerIsBlack ? 1 : -1;
  const children = scenario.children.map((c) => {
    const scoreMean = sgn * c.scoreMean;
    return {
      weightAdjusted: c.visits,
      selfUtility: flip(sgn * c.blackUtility, rootPlayerIsBlack),
      policy: c.policy,
      value: sgn * c.value,
      scoreLead: sgn * c.scoreLead,
      scoreMean,
      scoreMeanSq: scoreMean * scoreMean + c.scoreStdev * c.scoreStdev,
    };
  });
  const r = scenario.rootSelf;
  const rootScoreMean = sgn * r.scoreMean;
  return {
    children,
    rootSelf: {
      value: sgn * r.value,
      scoreLead: sgn * r.scoreLead,
      scoreMean: rootScoreMean,
      scoreMeanSq: rootScoreMean * rootScoreMean + r.scoreStdev * r.scoreStdev,
      utility: sgn * r.blackUtility,
      weight: 1,
    },
  };
}

describe('selfUtilityForRoot', () => {
  test('黑先：直接沿用黑方視角效用（黑先路徑必須位元級不變）', () => {
    for (const u of [-0.97, -0.5, -0.04, 0, 0.06, 0.7, 0.91]) {
      expect(selfUtilityForRoot(u, true)).toBe(u);
    }
  });

  test('白先：翻號成白方視角效用', () => {
    for (const u of [-0.97, -0.5, -0.04, 0.06, 0.7, 0.91]) {
      expect(selfUtilityForRoot(u, false)).toBe(-u);
    }
  });

  test('翻兩次回到原值（對合）', () => {
    for (const u of [-0.83, 0.12, 0.55]) {
      expect(selfUtilityForRoot(selfUtilityForRoot(u, false), false)).toBe(u);
    }
  });
});

describe('computeWeightedRootStats 的手番對稱性', () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      let black, white;
      beforeAll(() => {
        black = computeWeightedRootStats(buildInput(scenario, true));
        white = computeWeightedRootStats(buildInput(scenario, false));
      });

      test('黑先與白先的黑勝率互補相加為 1', () => {
        expect(black.rootWinRate + white.rootWinRate).toBeCloseTo(1, 12);
      });

      test('rootValue 完全相反', () => {
        expect(black.rootValue + white.rootValue).toBeCloseTo(0, 12);
      });

      test('rootScoreLead 完全相反', () => {
        expect(black.rootScoreLead + white.rootScoreLead).toBeCloseTo(0, 12);
      });

      test('rootScoreSelfplay 完全相反', () => {
        expect(black.rootScoreSelfplay + white.rootScoreSelfplay).toBeCloseTo(0, 12);
      });

      test('rootScoreStdev 相同', () => {
        expect(white.rootScoreStdev - black.rootScoreStdev).toBeCloseTo(0, 12);
      });
    });
  }

  test('沒有子節點時直接回傳 root 自身統計（兩手番都成立）', () => {
    const empty = { children: [], rootSelf: SCENARIOS[0].rootSelf };
    const b = computeWeightedRootStats({
      children: [],
      rootSelf: buildInput(SCENARIOS[0], true).rootSelf,
    });
    const w = computeWeightedRootStats({
      children: [],
      rootSelf: buildInput(SCENARIOS[0], false).rootSelf,
    });
    expect(empty.children).toHaveLength(0);
    expect(b.rootWinRate + w.rootWinRate).toBeCloseTo(1, 12);
  });
});

describe('tDistCdf3', () => {
  test('z = 0 時為 0.5，且對稱', () => {
    expect(tDistCdf3(0)).toBeCloseTo(0.5, 15);
    for (const z of [0.3, 1.0, 2.5, 6.0]) {
      expect(tDistCdf3(z) + tDistCdf3(-z)).toBeCloseTo(1, 12);
    }
  });

  test('單調遞增且落在 (0, 1)', () => {
    let prev = tDistCdf3(-20);
    expect(prev).toBeGreaterThan(0);
    for (let z = -19; z <= 20; z += 0.5) {
      const cur = tDistCdf3(z);
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
    expect(prev).toBeLessThan(1);
  });
});

describe('pruneNoiseWeight', () => {
  test('只有一個子節點時原封不動回傳其權重', () => {
    const stats = [{ weightAdjusted: 42, selfUtility: 0.3, policy: 0.5, value: 0.2, scoreLead: 1, scoreMean: 1, scoreMeanSq: 2 }];
    expect(pruneNoiseWeight(stats)).toBe(42);
    expect(stats[0].weightAdjusted).toBe(42);
  });

  test('低 policy、低效用卻分到過多權重的子節點會被剪枝，總權重下降', () => {
    const stats = [
      { weightAdjusted: 100, selfUtility: 0.5, policy: 0.9, value: 0.5, scoreLead: 5, scoreMean: 5, scoreMeanSq: 50 },
      { weightAdjusted: 400, selfUtility: -0.8, policy: 0.02, value: -0.8, scoreLead: -9, scoreMean: -9, scoreMeanSq: 90 },
    ];
    const before = stats[0].weightAdjusted + stats[1].weightAdjusted;
    const after = pruneNoiseWeight(stats);
    expect(after).toBeLessThan(before);
  });
});
