// ponytail: compteur en mémoire, remis à zéro au redémarrage ; passer en base si plusieurs processus.
export function createLimiter({ max = 10, windowMs = 15 * 60 * 1000, maxKeys = 50000 } = {}) {
  const entries = new Map();
  return {
    get size() {
      return entries.size;
    },
    // Counts one attempt; true once more than `max` were counted in the current window.
    // The map never exceeds maxKeys.
    hit(key) {
      const now = Date.now();
      let entry = entries.get(key);
      if (!entry || entry.until <= now) {
        // Full: evict the oldest key (Map keeps insertion order) rather than lock out new visitors.
        if (!entry && entries.size >= maxKeys) entries.delete(entries.keys().next().value);
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
