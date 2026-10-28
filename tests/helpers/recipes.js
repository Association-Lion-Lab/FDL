// Valid recipe fields for publishVersion, with overrides.
export const recipe = (overrides = {}) => ({
  title: 'Soupe de légumes',
  minutes: 30,
  servings: 4,
  diet: 'vegan',
  tags: ['soupe'],
  seasons: [],
  ingredients: [{ name: 'carotte', amount: 3, unit: '', preparation: 'raw' }],
  steps: [{ kind: 'cook', instruction: 'Cuire.', minutes: 20 }],
  provenance: 'Recette de famille',
  ...overrides,
});
