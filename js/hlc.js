/* Hybrid Logical Clock (HLC)
 * 为每个操作提供全局全序时间戳：{ t: 物理毫秒, c: 逻辑计数, n: 节点ID }
 * 全序比较：先比 t，再比 c，最后比节点ID（字典序），保证任意两个操作可比较。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HLC = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function now() { return Date.now(); }

  function create(nodeId, restored) {
    return {
      nodeId,
      t: restored && restored.t ? restored.t : 0,
      c: restored && restored.c ? restored.c : 0,
    };
  }

  // 本地产生新事件：t 取 max(物理时间, 当前t)，若 t 未推进则 c+1
  function tick(state) {
    const pt = now();
    if (pt > state.t) {
      state.t = pt;
      state.c = 0;
    } else {
      state.c += 1;
    }
    return { t: state.t, c: state.c, n: state.nodeId };
  }

  // 观察到远端时间戳后合并时钟
  function observe(state, ts) {
    if (!ts) return;
    const pt = now();
    const maxT = Math.max(state.t, ts.t, pt);
    if (maxT === state.t && maxT === ts.t) {
      state.c = Math.max(state.c, ts.c) + 1;
    } else if (maxT === state.t) {
      state.c = state.c + 1;
    } else if (maxT === ts.t) {
      state.c = ts.c + 1;
    } else {
      state.c = 0;
    }
    state.t = maxT;
  }

  // 全序比较：a<b 返回负数，a==b 返回 0，a>b 返回正数
  function compare(a, b) {
    if (a.t !== b.t) return a.t - b.t;
    if (a.c !== b.c) return a.c - b.c;
    const an = String(a.n), bn = String(b.n);
    return an < bn ? -1 : an > bn ? 1 : 0;
  }

  function isNewer(a, b) { return compare(a, b) > 0; }

  function toString(ts) { return ts.t + ':' + ts.c + ':' + ts.n; }

  return { create, tick, observe, compare, isNewer, toString, now };
});
