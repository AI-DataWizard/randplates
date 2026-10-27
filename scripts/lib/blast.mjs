// scripts/lib/blast.mjs — P-443: five-bucket blast radius per P-432 §2.
import { isSafetyFixture } from './safety.mjs';
import { evaluate } from './redteam-corpus.mjs';

export async function blast(corpus, baselineMod, patchedMod, resolve) {
  const out = { fixes: [], regressions: [], safetyRegressions: [], safeFlips: [], noise: [], details: [] };
  for (const fx of corpus) {
    const b = evaluate(fx, baselineMod, resolve);
    const p = evaluate(fx, patchedMod, resolve);
    const isSafety = isSafetyFixture(fx);
    let bucket;
    if (!b.pass && p.pass) bucket = 'fixes';
    else if (b.pass && !p.pass) {
      bucket = 'regressions';
      if (isSafety) out.safetyRegressions.push(fx.id);
    } else if (!b.pass && !p.pass) {
      bucket = JSON.stringify(b.draft) === JSON.stringify(p.draft) ? 'noise' : 'safeFlips';
    } else bucket = 'noise';
    out[bucket].push(fx.id);
    if (bucket !== 'noise') out.details.push({ id: fx.id, corpus: fx.corpus, category: fx.category, bucket, why: (p.why || b.why || '').slice(0, 200) });
  }
  return out;
}
