import { fileURLToPath } from 'node:url';

import { createPool, migrate } from '../src/db.js';
import { DIETS, SEASONS, publishVersion } from '../src/recipes.js';

const UNIVERSES = [['quotidien', 'Cuisine du quotidien'], ['patisserie', 'Pâtisserie'], ['monde', 'Cuisine du monde']];
const DISHES = ['Poireaux vinaigrette', 'Pâtes au pesto', 'Soupe de potiron', 'Tarte aux pommes', 'Curry de lentilles',
  'Gratin dauphinois', 'Salade de betteraves', 'Risotto aux champignons', 'Crumble de poires', 'Taboulé'];
const INGREDIENTS = ['poireau', 'pâtes', 'potiron', 'pomme', 'lentilles', 'pomme de terre', 'betterave', 'riz', 'poire', 'semoule'];

// Deterministic variety: recipe i cycles through diets, durations, seasons and universes.
const demo = (i) => ({
  title: i < DISHES.length ? DISHES[i] : `${DISHES[i % DISHES.length]} n° ${i + 1}`,
  minutes: [10, 20, 30, 45, 90][i % 5],
  servings: 2 + (i % 5),
  diet: DIETS[i % DIETS.length],
  tags: ['démo'],
  seasons: i % 3 === 0 ? [] : [SEASONS[i % 4], SEASONS[(i + 1) % 4]],
  universe: UNIVERSES[i % UNIVERSES.length][0],
  ingredients: [
    { name: INGREDIENTS[i % INGREDIENTS.length], amount: 500, unit: 'g', preparation: 'raw' },
    { name: 'sel', amount: 1, unit: 'pincée', preparation: 'unknown' },
  ],
  steps: [
    { kind: 'prep', instruction: 'Préparer les ingrédients.', minutes: 5 },
    { kind: 'cook', instruction: 'Cuire doucement.', minutes: null },
  ],
  provenance: 'Démonstration',
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    if (process.env.NODE_ENV === 'production') throw new Error('réservé au développement (NODE_ENV=production).');
    const count = Number(process.argv[2] ?? 30);
    if (!Number.isInteger(count) || count < 1) throw new Error('Usage : npm run seed:demo -- <nombre>');
    pool = createPool();
    await migrate(pool);
    for (const [slug, label] of UNIVERSES) {
      await pool.query('INSERT INTO universes (slug, label) VALUES ($1, $2) ON CONFLICT DO NOTHING', [slug, label]);
    }
    for (let i = 0; i < count; i++) await publishVersion(pool, { fields: demo(i) });
    console.log(`${count} recettes de démonstration créées.`);
  } catch (error) {
    console.error(`Démonstration impossible : ${String(error.message).trim().split('\n')[0]}`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
