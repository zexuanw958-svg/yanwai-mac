const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDistribution } = require('../renderer/probabilities');
const { demoResult, examples } = require('../panel-policy');

test('all options, including low and zero values, survive without mutating raw data', () => {
  const values = Object.freeze({ a: .72, b: .2, c: .07, d: .009, e: .001, f: 0 });
  const result = formatDistribution(values, Object.keys(values));
  assert.equal(result.rows.length, 6);
  assert.deepEqual(Object.fromEntries(result.rows.map(row => [row.key, row.raw])), values);
  assert.equal(result.rows.find(row => row.key === 'e').percent, '0.1%');
  assert.equal(result.rows.at(-1).percent, '0%');
  assert.equal(result.rows.reduce((sum, row) => sum + row.units, 0), result.totalUnits);
});
test('rounding totals 100 percent and tiny positives get precision or an explicit small value', () => {
  for (const values of [{ a: 1/3, b: 1/3, c: 1/3 }, { a: .99999999, b: .00000001 },
    { a: 1 - 1e-12, b: 1e-12 }, { a: .3333333, b: .3333333, c: .3333333 }]) {
    const result = formatDistribution(values);
    assert.equal(result.rows.length, Object.keys(values).length);
    assert.equal(result.rows.reduce((sum, row) => sum + row.units, 0), result.totalUnits);
    assert(result.rows.every(row => row.percent !== '0%'));
  }
  assert.deepEqual(formatDistribution({a: 1/3,b: 1/3,c: 1/3}).rows.map(row => row.percent), ['34%','33%','33%']);
});
test('missing, partial, nonnumeric, invalid and zero distributions never become fixture percentages', () => {
  for (const values of [undefined, null, {}, [], {a: 0}, {a: -1}, {a: NaN}, {a: Infinity},
    {a: 2}, {a: '1'}, {a: true}, {a: .72,b: .2}, {'': 1}]) assert.equal(formatDistribution(values).rows.length, 0);
  assert.equal(formatDistribution({a: 1}, ['a','b']).rows.length, 0);
  assert.equal(formatDistribution(demoResult('work').intentProbabilities).rows.length, 0);
});
test('romance fixture has the requested full distribution and reply order, original examples remain', () => {
  const r = demoResult('romance');
  assert.equal(examples.romance.text, '女朋友：周末吃什么，你是不是又等我来安排？');
  assert.equal(r.kind, 'demo');
  assert.deepEqual(formatDistribution(r.intentProbabilities).rows.map(row => row.percent), ['72%','20%','8%']);
  assert.deepEqual(r.replies, ['这次我来安排，今晚把餐厅和时间发你，你负责来吃。',
    '火锅还是日料？你选一个，剩下的我来安排。', '你挑想吃的，我负责找店和订位。']);
  r.intentProbabilities['希望你主动安排'] = 0;
  assert.equal(demoResult('romance').intentProbabilities['希望你主动安排'], .72);
  for (const scenario of ['work','life']) assert.equal(demoResult(scenario).replies.length, 3);
});
