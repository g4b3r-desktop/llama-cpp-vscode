function reciprocalRankFusion(first, second, limit) {
  const scores = new Map();
  const items = new Map();
  for (const list of [first, second]) {
    list.forEach((item, index) => {
      const key = item.id || (item.sourceId ? item.sourceId + ':' + item.filename + ':' + item.hash + ':' + item.title + ':' + item.section + ':' + item.text : item.uri + '#' + item.startLine + ':' + item.endLine);
      items.set(key, item);
      scores.set(key, (scores.get(key) || 0) + 1 / (61 + index));
    });
  }
  return [...items.entries()]
    .map(([key, item]) => ({ ...item, score: scores.get(key), retrieval: 'hybrid' }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function diversifyResults(results, topK) {
  const groups = new Set(results.map(item => item.sourceId || '__workspace'));
  if (groups.size < 2) return results.slice(0, topK);
  const maxPerGroup = Math.max(1, Math.ceil(topK / groups.size) + 1);
  const counts = new Map();
  const selected = [];
  const deferred = [];
  for (const item of results) {
    const group = item.sourceId || '__workspace';
    const count = counts.get(group) || 0;
    if (count < maxPerGroup && selected.length < topK) {
      selected.push(item);
      counts.set(group, count + 1);
    } else deferred.push(item);
  }
  if (selected.length < topK) selected.push(...deferred.slice(0, topK - selected.length));
  return selected;
}

module.exports = { reciprocalRankFusion, diversifyResults };
