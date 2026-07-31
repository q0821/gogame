/**
 * KataGo root 加權統計（vendored port）。
 *
 * 對應上游：
 *   cpp/search/searchupdatehelpers.cpp  recomputeNodeStats()
 *   cpp/search/searchresults.cpp        getRootValues() 等
 *
 * 這些函式全部是 player-agnostic 的：它們只知道 `selfUtility` 是「root 手番方視角」的
 * 效用值，不知道誰執黑誰執白。手番翻號一律在填 ChildWeightStats 的地方做（見
 * selfUtilityForRoot），與上游把翻號放在 MoreNodeStats 填值處的結構一致，方便日後
 * 對照上游 diff。
 *
 * 【為什麼是 .js 而不是 .ts】本專案 jest 測試以 vm sandbox + @babel/preset-env 載入原
 * 始檔，沒有安裝任何 TypeScript transform（見 tests/helpers.js 註解），.ts 檔在測試環
 * 境無法載入。這幾個純函式必須能被單元測試直接載入，故刻意以純 JavaScript 撰寫，型別
 * 以 JSDoc typedef 標註。請勿改回 .ts。
 */

/**
 * @typedef {object} ChildWeightStats
 * @property {number} weightAdjusted 該子節點的權重（初始為 visits），會被本模組就地改寫。
 * @property {number} selfUtility    root 手番方視角的平均效用（見 selfUtilityForRoot）。
 * @property {number} policy         policy prior。
 * @property {number} value          黑方視角的平均 value（[-1, 1]）。
 * @property {number} scoreLead      黑方視角的平均 scoreLead。
 * @property {number} scoreMean      黑方視角的平均 selfplay score。
 * @property {number} scoreMeanSq    score 的平方平均（翻號不變量）。
 */

/**
 * @typedef {object} RootSelfStats
 * @property {number} value
 * @property {number} scoreLead
 * @property {number} scoreMean
 * @property {number} scoreMeanSq
 * @property {number} utility     保留欄位，computeWeightedRootStats 不讀取。
 * @property {number} weight
 */

export const VALUE_WEIGHT_EXPONENT = 0.25;
export const USE_NOISE_PRUNING = true;
export const NOISE_PRUNE_UTILITY_SCALE = 0.15;
export const NOISE_PRUNING_CAP = 1e50;

const SQRT_3 = Math.sqrt(3);

/**
 * 把「黑方視角」的平均效用換算成「root 手番方視角」的 selfUtility。
 *
 * 對應上游 cpp/search/searchupdatehelpers.cpp recomputeNodeStats()：
 *   stats.selfUtility = node.nextPla == P_WHITE ? childUtility : -childUtility;
 * （上游的 utilityAvg 是白方視角，本 port 的 utilitySum 是黑方視角，故條件相反。）
 *
 * 本模組其餘加權函式一律 player-agnostic，翻號只在這裡做，與上游結構一致。
 *
 * @param {number} blackUtility 黑方視角的平均效用。
 * @param {boolean} rootPlayerIsBlack root 手番是否為黑。
 * @returns {number}
 */
export function selfUtilityForRoot(blackUtility, rootPlayerIsBlack) {
  return rootPlayerIsBlack ? blackUtility : -blackUtility;
}

/**
 * 自由度 3 的 t 分布 CDF（閉式解）。
 * 上游用 valueWeightDistribution->getCdf(z) 查表，那張表就是自由度 3 的 t 分布。
 * @param {number} z
 * @returns {number}
 */
export function tDistCdf3(z) {
  const u = z / SQRT_3;
  const term = u / (1 + u * u);
  return 0.5 + (Math.atan(u) + term) / Math.PI;
}

/**
 * 就地調整 stats 的 weightAdjusted（雜訊剪枝），回傳剪枝後的總權重。
 * @param {ChildWeightStats[]} stats 會被就地改寫並重新排序。
 * @returns {number}
 */
export function pruneNoiseWeight(stats) {
  if (stats.length <= 1) return stats.reduce((acc, s) => acc + s.weightAdjusted, 0);
  stats.sort((a, b) => b.policy - a.policy);

  let utilitySumSoFar = 0;
  let weightSumSoFar = 0;
  let rawPolicySumSoFar = 0;

  for (const s of stats) {
    const utility = s.selfUtility;
    const oldWeight = s.weightAdjusted;
    const rawPolicy = Math.max(1e-30, s.policy);
    let newWeight = oldWeight;

    if (weightSumSoFar > 0 && rawPolicySumSoFar > 0) {
      const avgUtilitySoFar = utilitySumSoFar / weightSumSoFar;
      const utilityGap = avgUtilitySoFar - utility;
      if (utilityGap > 0) {
        const weightShareFromRawPolicy = (weightSumSoFar * rawPolicy) / rawPolicySumSoFar;
        const lenientWeightShareFromRawPolicy = 2.0 * weightShareFromRawPolicy;
        if (oldWeight > lenientWeightShareFromRawPolicy) {
          const excessWeight = oldWeight - lenientWeightShareFromRawPolicy;
          let weightToSubtract = excessWeight * (1.0 - Math.exp(-utilityGap / NOISE_PRUNE_UTILITY_SCALE));
          if (weightToSubtract > NOISE_PRUNING_CAP) weightToSubtract = NOISE_PRUNING_CAP;
          newWeight = oldWeight - weightToSubtract;
          s.weightAdjusted = newWeight;
        }
      }
    }

    utilitySumSoFar += utility * newWeight;
    weightSumSoFar += newWeight;
    rawPolicySumSoFar += rawPolicy;
  }

  return weightSumSoFar;
}

/**
 * 就地把「相對表現差」的子節點降權，並把總權重正規化回 desiredTotalWeight。
 * @param {{ stats: ChildWeightStats[], currentTotalWeight: number, desiredTotalWeight: number, amountToSubtract: number, amountToPrune: number }} args
 * @returns {void}
 */
export function downweightBadChildrenAndNormalizeWeight(args) {
  const stats = args.stats;
  const desiredTotalWeight = args.desiredTotalWeight;
  if (stats.length === 0 || args.currentTotalWeight <= 0) return;

  if (VALUE_WEIGHT_EXPONENT === 0) {
    let currentTotalWeight = args.currentTotalWeight;
    for (const s of stats) {
      if (s.weightAdjusted < args.amountToPrune) {
        currentTotalWeight -= s.weightAdjusted;
        s.weightAdjusted = 0;
        continue;
      }
      const newWeight = s.weightAdjusted - args.amountToSubtract;
      if (newWeight <= 0) {
        currentTotalWeight -= s.weightAdjusted;
        s.weightAdjusted = 0;
      } else {
        currentTotalWeight -= args.amountToSubtract;
        s.weightAdjusted = newWeight;
      }
    }

    if (currentTotalWeight > 0 && currentTotalWeight !== desiredTotalWeight) {
      const factor = desiredTotalWeight / currentTotalWeight;
      for (const s of stats) s.weightAdjusted *= factor;
    }
    return;
  }

  const stdevs = new Array(stats.length);
  let simpleValueSum = 0;
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    const weight = s.weightAdjusted;
    if (weight <= 0) continue;
    const precision = 1.5 * Math.sqrt(weight);
    stdevs[i] = Math.sqrt(1e-8 + 1.0 / precision);
    simpleValueSum += s.selfUtility * weight;
  }

  const simpleValue = simpleValueSum / args.currentTotalWeight;
  let totalNewUnnormWeight = 0;

  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    if (s.weightAdjusted < args.amountToPrune) {
      s.weightAdjusted = 0;
      continue;
    }
    const newWeight = s.weightAdjusted - args.amountToSubtract;
    if (newWeight <= 0) {
      s.weightAdjusted = 0;
      continue;
    }
    s.weightAdjusted = newWeight;

    const stdev = stdevs[i];
    if (!stdev || stdev <= 0) continue;
    const z = (s.selfUtility - simpleValue) / stdev;
    const p = tDistCdf3(z) + 0.0001;
    s.weightAdjusted *= Math.pow(p, VALUE_WEIGHT_EXPONENT);
    totalNewUnnormWeight += s.weightAdjusted;
  }

  if (totalNewUnnormWeight <= 0) return;
  const factor = desiredTotalWeight / totalNewUnnormWeight;
  for (const s of stats) s.weightAdjusted *= factor;
}

/**
 * 以加權後的子節點統計 + root 自身統計算出 root 的黑方視角評估。
 * 注意：args.children 會被就地改寫（權重、排序），呼叫端每次都要給全新的物件。
 * @param {{ children: ChildWeightStats[], rootSelf: RootSelfStats }} args
 * @returns {{ rootValue: number, rootWinRate: number, rootScoreLead: number, rootScoreSelfplay: number, rootScoreStdev: number }}
 */
export function computeWeightedRootStats(args) {
  const stats = args.children;
  if (stats.length === 0) {
    const rootValue = args.rootSelf.value;
    const rootScoreSelfplay = args.rootSelf.scoreMean;
    const rootScoreMeanSq = args.rootSelf.scoreMeanSq;
    const rootScoreStdev = Math.sqrt(Math.max(0, rootScoreMeanSq - rootScoreSelfplay * rootScoreSelfplay));
    return {
      rootValue,
      rootWinRate: (rootValue + 1) * 0.5,
      rootScoreLead: args.rootSelf.scoreLead,
      rootScoreSelfplay,
      rootScoreStdev,
    };
  }

  let totalWeight = 0;
  for (const s of stats) totalWeight += s.weightAdjusted;
  if (USE_NOISE_PRUNING) totalWeight = pruneNoiseWeight(stats);

  downweightBadChildrenAndNormalizeWeight({
    stats,
    currentTotalWeight: totalWeight,
    desiredTotalWeight: totalWeight,
    amountToSubtract: 0,
    amountToPrune: 0,
  });

  let weightSum = 0;
  let valueSum = 0;
  let scoreMeanSum = 0;
  let scoreMeanSqSum = 0;
  let scoreLeadSum = 0;

  for (const s of stats) {
    if (s.weightAdjusted <= 0) continue;
    weightSum += s.weightAdjusted;
    valueSum += s.weightAdjusted * s.value;
    scoreMeanSum += s.weightAdjusted * s.scoreMean;
    scoreMeanSqSum += s.weightAdjusted * s.scoreMeanSq;
    scoreLeadSum += s.weightAdjusted * s.scoreLead;
  }

  weightSum += args.rootSelf.weight;
  valueSum += args.rootSelf.weight * args.rootSelf.value;
  scoreMeanSum += args.rootSelf.weight * args.rootSelf.scoreMean;
  scoreMeanSqSum += args.rootSelf.weight * args.rootSelf.scoreMeanSq;
  scoreLeadSum += args.rootSelf.weight * args.rootSelf.scoreLead;

  if (weightSum <= 0) {
    const rootValue = args.rootSelf.value;
    const rootScoreSelfplay = args.rootSelf.scoreMean;
    const rootScoreMeanSq = args.rootSelf.scoreMeanSq;
    const rootScoreStdev = Math.sqrt(Math.max(0, rootScoreMeanSq - rootScoreSelfplay * rootScoreSelfplay));
    return {
      rootValue,
      rootWinRate: (rootValue + 1) * 0.5,
      rootScoreLead: args.rootSelf.scoreLead,
      rootScoreSelfplay,
      rootScoreStdev,
    };
  }

  const rootValue = valueSum / weightSum;
  const rootScoreSelfplay = scoreMeanSum / weightSum;
  const rootScoreMeanSq = scoreMeanSqSum / weightSum;
  const rootScoreStdev = Math.sqrt(Math.max(0, rootScoreMeanSq - rootScoreSelfplay * rootScoreSelfplay));
  return {
    rootValue,
    rootWinRate: (rootValue + 1) * 0.5,
    rootScoreLead: scoreLeadSum / weightSum,
    rootScoreSelfplay,
    rootScoreStdev,
  };
}
