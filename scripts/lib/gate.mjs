// scripts/lib/gate.mjs — P-443: the anti-overfit gate per P-432 §2.3.
// The fixes>=5 floor can drop to ceil(remaining/2) with --allow-tail when a
// layer-class is genuinely in its tail (owner flips it explicitly).
export function gate(r, ctx = {}) {
  if (r.safetyRegressions.length > 0) return { verdict: 'REJECT', reason: 'safety' };
  if (r.fixes.length - r.regressions.length <= 0) return { verdict: 'REJECT', reason: 'net-pass' };
  const floor = ctx.allowTail ? Math.max(1, Math.ceil((ctx.remaining ?? 5) / 2)) : 5;
  if (r.fixes.length < floor && r.regressions.length > 2) return { verdict: 'REJECT', reason: 'overfit', floor };
  const warnings = [];
  if (r.regressions.length > r.fixes.length / 2) warnings.push('HEAVY_TAIL');
  return { verdict: 'ACCEPT', net: r.fixes.length - r.regressions.length, warnings, floor };
}
