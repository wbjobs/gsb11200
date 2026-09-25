/* Logoot 风格分数位置标识符
 *
 * 位置 = 分量数组 [{d: 数字, s: 节点ID}, ...]，按字典序比较（先比 d 再比 s）。
 * 任意两个不同位置之间总能生成新的中间位置，且全局唯一（携带节点ID），
 * 因此并发移动/插入最终排序一致。
 *
 * 不变式（保证稠密性与算法终止）：
 *  - 普通分量数字范围 1..BASE；
 *  - 虚拟边界分量 MIN={d:0,s:''} / MAX={d:BASE+1,s:''} 只会在下沉时被复制
 *    物化，且永远不会是位置的最后一个分量（最后一个分量一定是真实发射的
 *    {d:1..BASE, s:真实节点}）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Logoot = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BASE = 100; // 每层数字范围 1..BASE
  const MIN_COMP = { d: 0, s: '' };
  const MAX_COMP = { d: BASE + 1, s: '' };

  function cmpComp(a, b) {
    if (a.d !== b.d) return a.d - b.d;
    const as = String(a.s), bs = String(b.s);
    return as < bs ? -1 : as > bs ? 1 : 0;
  }

  // 字典序比较两个位置；短前缀小于长位置
  function compare(p, q) {
    const n = Math.min(p.length, q.length);
    for (let i = 0; i < n; i++) {
      const c = cmpComp(p[i], q[i]);
      if (c !== 0) return c;
    }
    return p.length - q.length;
  }

  function randBetween(lo, hi) { // 含两端，lo<=hi
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  // 在 prev 与 next 之间生成新位置（prev/next 为位置数组或 null 表示边界）
  // 要求 prev < next（或 null）。结果严格介于两者之间且全局唯一。
  function between(prev, next, site) {
    const pos = [];
    let p = prev, q = next; // null 表示该侧已无约束（虚拟 MIN/MAX 无限填充）
    for (;;) {
      const a = p && p.length ? p[0] : MIN_COMP;
      const b = q && q.length ? q[0] : MAX_COMP;
      const gap = b.d - a.d;
      if (gap > 1) {
        // 区间足够：取中点附近随机值，避免单调增长
        const lo = a.d + 1, hi = b.d - 1;
        const mid = (lo + hi) >> 1;
        const spread = Math.max(1, (hi - lo) >> 1);
        let d = mid + randBetween(-spread, spread);
        if (d < lo) d = lo;
        if (d > hi) d = hi;
        pos.push({ d, s: site });
        return pos;
      }
      if (gap === 1) {
        // 紧贴：继承 a 分量（可能是虚拟 MIN），此后仅 prev 侧约束（<next 已封定）
        pos.push({ d: a.d, s: a.s });
        p = p && p.length ? p.slice(1) : null;
        q = null;
        continue;
      }
      // gap === 0：同数字，按节点ID分侧
      if (a.s < b.s) {
        // a < b：结果取 a 后已确定 < next，仅 prev 侧约束
        pos.push({ d: a.d, s: a.s });
        p = p && p.length ? p.slice(1) : null;
        q = null;
        continue;
      }
      if (a.s > b.s) {
        // 合法输入（prev<next 且前缀全等）下不可达；防御：从 next 侧下沉
        pos.push({ d: b.d, s: b.s });
        p = null;
        q = q && q.length ? q.slice(1) : null;
        continue;
      }
      // 分量完全相等：两侧同时下沉
      pos.push({ d: a.d, s: a.s });
      p = p && p.length ? p.slice(1) : null;
      q = q && q.length ? q.slice(1) : null;
    }
  }

  // 生成列中 index 处插入的位置（list 为该列已排序位置数组）
  function atIndex(list, index, site) {
    const prev = index > 0 ? list[index - 1] : null;
    const next = index < list.length ? list[index] : null;
    return between(prev, next, site);
  }

  function toString(pos) {
    return pos.map((c) => c.d + '@' + c.s).join('/');
  }

  return { BASE, compare, between, atIndex, toString };
});
