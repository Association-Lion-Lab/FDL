// ponytail: compteur en mémoire, remis à zéro au redémarrage ; passer en base si plusieurs processus.
export function createLimiter({ max = 10, windowMs = 15 * 60 * 1000, maxKeys = 50000 } = {}) {
  const entries = new Map();
  let lastPrune = 0;
  return {
    get size() {
      return entries.size;
    },
    // Counts one attempt; true once more than `max` were counted in the current window.
    // When the map is full of live keys, new keys are refused (true) instead of growing it.
    hit(key) {
      const now = Date.now();
      let entry = entries.get(key);
      if (!entry || entry.until <= now) {
        if (!entry && entries.size >= maxKeys) {
          // Prune at most once per window so a flood cannot force a full scan per request.
          if (now - lastPrune >= windowMs) {
            lastPrune = now;
            for (const [k, e] of entries) if (e.until <= now) entries.delete(k);
          }
          if (entries.size >= maxKeys) return true;
        }
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
