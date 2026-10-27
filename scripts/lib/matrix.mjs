// scripts/lib/matrix.mjs — P-443: category × layer confusion matrix.
const LAYERS = ['preprocess', 'multi', 'quantity', 'canon', 'classifier', 'queue'];

export function buildMatrix(failures) {
  const matrix = {}; const byCategory = {}; const byLayer = {}; let ambiguous = 0;
  for (const f of failures) {
    matrix[f.category] = matrix[f.category] || Object.fromEntries(LAYERS.map(l => [l, 0]));
    matrix[f.category][f.layer]++;
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    if (f.ambiguous) ambiguous++;
    else byLayer[f.layer] = (byLayer[f.layer] || 0) + 1;
  }
  return { matrix, byCategory, byLayer, ambiguous,
           order: { layers: LAYERS, upstream: ['preprocess', 'multi', 'quantity', 'canon', 'classifier', 'queue'] } };
}

/** Pick the target cell: highest failing count; tie-break upstream-first. */
export function pickTargetCell(m) {
  const rank = Object.fromEntries(m.order.upstream.map((l, i) => [l, i]));
  let best = null;
  for (const [cat, row] of Object.entries(m.matrix))
    for (const [layer, n] of Object.entries(row)) {
      if (n === 0) continue;
      const better = !best || n > best.count ||
        (n === best.count && rank[layer] < rank[best.layer]);
      if (better) best = { category: cat, layer, count: n };
    }
  return best;
}
