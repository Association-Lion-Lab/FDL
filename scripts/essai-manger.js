import { fileURLToPath } from 'node:url';

import { saveDraft, submitVersion } from '../src/contributions.js';
import { createPool } from '../src/db.js';
import { decide } from '../src/moderation.js';

// Drives FDL through its own functions, without HTTP, for the FDL <-> Manger! test
// (docs/ESSAI-MANGER.md). The account acts as author and moderator: decide() does not
// check roles, the HTTP routes do.
const USAGE = 'Usage : node scripts/essai-manger.js creer <compte> | version <recette> <compte> | retirer <recette> <compte>';

const draft = (title) => ({
  title, minutes: 20, servings: 4, diet: 'vegetarian', tags: ['test'], seasons: [], universe: 'quotidien',
  ingredients: [{ name: 'lentilles', amount: 250, unit: 'g', preparation: 'raw' }, { name: 'oignon', amount: 1, unit: '', preparation: 'raw' }],
  steps: [{ kind: 'prep', instruction: 'Rincer les lentilles.', minutes: 5 }, { kind: 'cook', instruction: 'Cuire 20 minutes.', minutes: 20 }],
  provenance: 'Essai Manger!',
});

async function publish(pool, recipeId, accountId) {
  const { id } = await saveDraft(pool, { recipeId, authorId: accountId, draft: draft(recipeId ? 'Dahl de lentilles (nouvelle version)' : 'Dahl de lentilles') });
  await submitVersion(pool, { recipeId: id, authorId: accountId, mode: 'public', dataDir: process.env.FDL_DATA_DIR });
  const { rows: [{ v }] } = await pool.query('SELECT max(version) AS v FROM recipe_versions WHERE recipe_id = $1', [id]);
  const result = await decide(pool, { moderatorId: accountId, kind: 'accept', recipeId: id, version: v, reason: 'Essai Manger!' });
  return { recette: id, version: v, ...result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    if (process.env.NODE_ENV === 'production') throw new Error('réservé au développement (NODE_ENV=production).');
    const [step, a, b] = process.argv.slice(2);
    const ids = [a, b].filter(Boolean).map(Number);
    if (!ids.every(Number.isSafeInteger)) throw new Error(USAGE);
    pool = createPool();
    if (step === 'creer' && ids.length === 1) console.log(await publish(pool, null, ids[0]));
    else if (step === 'version' && ids.length === 2) console.log(await publish(pool, ids[0], ids[1]));
    else if (step === 'retirer' && ids.length === 2) {
      console.log(await decide(pool, { moderatorId: ids[1], kind: 'remove', recipeId: ids[0], reason: 'Essai Manger! : retrait' }));
    } else throw new Error(USAGE);
  } catch (error) {
    console.error(`Essai impossible : ${String(error.message).trim().split('\n')[0]}`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
