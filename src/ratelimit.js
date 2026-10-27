// ponytail: compteur en mémoire, remis à zéro au redémarrage ; passer en base si plusieurs processus.
export function createLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const entries = new Map();
  return {
    // Counts one attempt; true once more than `max` were counted in the current window.
    hit(key) {
      const now = Date.now();
      if (entries.size > 10000) {
        for (const [k, e] of entries) if (e.until <= now) entries.delete(k);
      }
      let entry = entries.get(key);
      if (!entry || entry.until <= now) {
        entry = { count: 0, until: now + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      return entry.count > max;
    },
    reset(key) {
      entries.delete(key);
    },
  };
}
