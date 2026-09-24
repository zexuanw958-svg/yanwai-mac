/* Display-only rounding; raw probabilities and confidence remain untouched. */
(function (root) {
  'use strict';
  function formatDistribution(values, expected = []) {
    const empty = (note) => ({ rows: [], totalUnits: 0, note });
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length)
      return empty('暂无意图概率分布');
    if (!expected.every(key => Object.hasOwn(values, key)))
      return empty('意图概率不完整，暂不展示分布');
    const entries = Object.entries(values);
    if (entries.some(([key, value]) => !key.trim() || !Number.isFinite(value) || value < 0 || value > 1))
      return empty('意图概率异常，暂不展示分布');
    const total = entries.reduce((sum, [, value]) => sum + value, 0);
    if (total <= 0 || Math.abs(total - 1) > 1e-6)
      return empty('意图概率总和异常，暂不展示分布');
    entries.sort((a, b) => b[1] - a[1]);
    const smallest = Math.min(...entries.filter(([, value]) => value > 0).map(([, value]) => value * 100));
    let decimals = 0;
    while (decimals < 6 && smallest * 10 ** decimals < 1) decimals++;
    const scale = 10 ** decimals, totalUnits = 100 * scale;
    const exact = entries.map(([, value]) => value / total * totalUnits);
    const units = exact.map(Math.floor);
    const order = entries.map((_, i) => i).sort((a, b) => (exact[b] - units[b]) - (exact[a] - units[a]));
    const remaining = totalUnits - units.reduce((sum, value) => sum + value, 0);
    for (let i = 0; i < remaining; i++) units[order[i]]++;
    const number = (value) => String(Number(value.toFixed(decimals)));
    const rows = entries.map(([key, raw], i) => ({ key, raw, units: units[i],
      percent: raw > 0 && units[i] === 0 ? `<${(1 / scale).toFixed(decimals)}%` : `${number(units[i] / scale)}%` }));
    return { rows, totalUnits, note: rows.some(row => row.percent.startsWith('<'))
      ? '合计 100%（舍入；微小项以 < 标出）' : '合计 100%' };
  }
  if (typeof module === 'object' && module.exports) module.exports = { formatDistribution };
  else root.formatDistribution = formatDistribution;
})(globalThis);
