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
    const rootSelfBlack = buildInput(SCENARIOS[0], true).rootSelf;
    const rootSelfWhite = buildInput(SCENARIOS[0], false).rootSelf;
    const b = computeWeightedRootStats({ children: [], rootSelf: rootSelfBlack });
    const w = computeWeightedRootStats({ children: [], rootSelf: rootSelfWhite });

    // 無子節點時直接原樣回傳 root 自身統計，不經過任何加權。
    expect(b.rootValue).toBe(rootSelfBlack.value);
    expect(b.rootScoreLead).toBe(rootSelfBlack.scoreLead);
    expect(b.rootScoreSelfplay).toBe(rootSelfBlack.scoreMean);
    expect(w.rootValue).toBe(rootSelfWhite.value);
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

/**
 * 方向性斷言：鏡像對稱性只釘住「模組是 player-agnostic」與「翻號一致」，對任何
 * player-agnostic 的變換都成立，所以它抓不到「加權方向本身反了」這種錯（例如把
 * z = (selfUtility - simpleValue) 寫成 (simpleValue - selfUtility)）——那跟本次修的
 * 是同一類錯（符號方向）。這裡直接釘住加權的方向語意。
 *
 * 注意前提：只有在「其餘條件完全相同」時才能斷言單調。實戰中最終權重同時取決於
 * 初始 visits 與 policy，高效用但 visits 極少的子節點權重當然可能比較低。所以這組
 * 資料刻意讓 visits 與 policy 全部相等，只有 selfUtility 不同。
 */
describe('加權的方向性', () => {
  test('其餘條件完全相同時，selfUtility 越高的子節點最終權重越高', () => {
    const utilities = [-0.6, -0.2, 0.0, 0.3, 0.75];
    const children = utilities.map((u) => ({
      weightAdjusted: 200,
      selfUtility: u,
      policy: 0.2,
      value: u,
      scoreLead: 10 * u,
      scoreMean: 10 * u,
      scoreMeanSq: 100 * u * u + 144,
    }));
    computeWeightedRootStats({
      children,
      rootSelf: { value: 0.05, scoreLead: 0.5, scoreMean: 0.5, scoreMeanSq: 144.25, utility: 0.05, weight: 1 },
    });

    // computeWeightedRootStats 會就地改寫並重排 children，故依 selfUtility 重新排序後再檢查。
    const bySelfUtility = [...children].sort((a, b) => a.selfUtility - b.selfUtility);
    for (let i = 1; i < bySelfUtility.length; i++) {
      expect(bySelfUtility[i].weightAdjusted).toBeGreaterThan(bySelfUtility[i - 1].weightAdjusted);
    }
    // 最高與最低效用之間必須有明顯落差，避免「幾乎沒有加權」也能矇混過關。
    expect(bySelfUtility[4].weightAdjusted / bySelfUtility[0].weightAdjusted).toBeGreaterThan(1.1);
  });

  test('效用低於加權平均的子節點被降權、高於的被升權（總權重守恆）', () => {
    const children = [-0.6, -0.2, 0.0, 0.3, 0.75].map((u) => ({
      weightAdjusted: 200,
      selfUtility: u,
      policy: 0.2,
      value: u,
      scoreLead: 10 * u,
      scoreMean: 10 * u,
      scoreMeanSq: 100 * u * u + 144,
    }));
    const totalBefore = children.reduce((a, c) => a + c.weightAdjusted, 0);
    computeWeightedRootStats({
      children,
      rootSelf: { value: 0.05, scoreLead: 0.5, scoreMean: 0.5, scoreMeanSq: 144.25, utility: 0.05, weight: 1 },
    });
    const totalAfter = children.reduce((a, c) => a + c.weightAdjusted, 0);
    // 本組資料不會觸發 pruneNoiseWeight（policy 與 visits 全等），故總權重被正規化回原值。
    expect(totalAfter).toBeCloseTo(totalBefore, 8);

    const best = children.find((c) => c.selfUtility === 0.75);
    const worst = children.find((c) => c.selfUtility === -0.6);
    expect(best.weightAdjusted).toBeGreaterThan(200);
    expect(worst.weightAdjusted).toBeLessThan(200);
  });
});

/**
 * Golden values：釘住 port 對上游的「數值保真度」。
 *
 * 對稱性與方向性斷言都只約束結構性質，對「係數被改掉」「剪枝被關掉」「CDF 換成另一個
 * 同樣單調的函式」這類改動完全無感。這組 golden 直接鎖住實際輸出數值，任何會改變
 * 加權結果的改動都會紅。
 *
 * 說明其侷限：golden 是從目前實作產生的，所以它證明的是「沒有人在無意間動到這條
 * 數值路徑」，不是「這條路徑等於上游 C++」。後者由 batch 1 的字元級搬移比對，以及
 * 這些函式本身逐行對照上游來保證。兩者互補。
 *
 * 這組資料刻意讓最後一個子節點（policy 0.03、visits 500、selfUtility -0.50）觸發
 * pruneNoiseWeight 的剪枝分支，否則 NOISE_PRUNE_UTILITY_SCALE 與 USE_NOISE_PRUNING
 * 都不會被走到。
 */
describe('golden values（數值保真度）', () => {
  const makeGoldenChildren = () =>
    [
      { policy: 0.5, visits: 80, u: 0.4, value: 0.36, lead: 6.0, mean: 6.4, sd: 11.0 },
      { policy: 0.3, visits: 60, u: 0.3, value: 0.27, lead: 4.5, mean: 4.9, sd: 11.3 },
      { policy: 0.03, visits: 500, u: -0.5, value: -0.46, lead: -8.5, mean: -8.1, sd: 12.6 },
      { policy: 0.1, visits: 40, u: 0.1, value: 0.09, lead: 1.5, mean: 1.9, sd: 11.9 },
      { policy: 0.05, visits: 20, u: -0.2, value: -0.18, lead: -3.0, mean: -2.6, sd: 12.2 },
    ].map((c) => ({
      weightAdjusted: c.visits,
      selfUtility: c.u,
      policy: c.policy,
      value: c.value,
      scoreLead: c.lead,
      scoreMean: c.mean,
      scoreMeanSq: c.mean * c.mean + c.sd * c.sd,
    }));

  const GOLDEN_ROOT_SELF = {
    value: 0.2,
    scoreLead: 3.4,
    scoreMean: 3.8,
    scoreMeanSq: 3.8 * 3.8 + 11.5 * 11.5,
    utility: 0.22,
    weight: 1,
  };

  test('computeWeightedRootStats 的輸出數值', () => {
    const r = computeWeightedRootStats({ children: makeGoldenChildren(), rootSelf: GOLDEN_ROOT_SELF });
    expect(r.rootValue).toBeCloseTo(0.21065197148431575, 12);
    expect(r.rootWinRate).toBeCloseTo(0.6053259857421579, 12);
    expect(r.rootScoreLead).toBeCloseTo(3.470978126276197, 12);
    expect(r.rootScoreSelfplay).toBeCloseTo(3.870978126276198, 12);
    expect(r.rootScoreStdev).toBeCloseTo(11.9882840677385, 12);
  });

  test('每個子節點加權後的最終權重（含剪枝分支）', () => {
    const children = makeGoldenChildren();
    computeWeightedRootStats({ children, rootSelf: GOLDEN_ROOT_SELF });
    // 呼叫後 children 已被 pruneNoiseWeight 依 policy 遞減重排。
    const actual = children.map((c) => [c.policy, c.weightAdjusted]);
    const expected = [
      [0.5, 88.265293580725],
      [0.3, 63.36893533319771],
      [0.1, 33.78989341126161],
      [0.05, 15.349829149486528],
      [0.03, 10.227597932246892],
    ];
    expect(actual.map((a) => a[0])).toEqual(expected.map((e) => e[0]));
    for (let i = 0; i < expected.length; i++) {
      expect(actual[i][1]).toBeCloseTo(expected[i][1], 8);
    }
    // 剪枝確實有發生：低 policy、低效用、高 visits 的那手權重從 500 被砍到兩位數。
    expect(actual[4][1]).toBeLessThan(20);
  });

  test('tDistCdf3 的輸出數值（自由度 3 的 t 分布）', () => {
    const expected = [
      [-3, 0.028834442811218552],
      [-1, 0.19550110947788524],
      [-0.25, 0.40936461121441475],
      [0, 0.5],
      [0.25, 0.5906353887855852],
      [1, 0.8044988905221148],
      [3, 0.9711655571887814],
    ];
    for (const [z, want] of expected) {
      expect(tDistCdf3(z)).toBeCloseTo(want, 14);
    }
  });
});
