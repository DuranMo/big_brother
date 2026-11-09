export function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function nextMidnight(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

// The background owns this queue; pages never read-modify-write selection state.
const CATALOG_VERSION = 2;

export function createDailyPainting({ storage, loadCatalog, now = () => new Date(), random = Math.random }) {
  let queue = Promise.resolve();
  let catalog;
  async function select() {
    const { dailyPainting } = await storage.get("dailyPainting");
    const date = localDateKey(now());
    const isToday = dailyPainting?.date === date && dailyPainting.painting;
    if (isToday && dailyPainting.catalogVersion === CATALOG_VERSION) return dailyPainting;
    // Keep the bundled catalog in memory only while the worker is alive.
    catalog ??= await loadCatalog();
    if (!catalog.length) throw new Error("The painting catalog is empty.");
    if (isToday) {
      // Enrich today's stored selection after an update without changing the artwork.
      const selection = {
        ...dailyPainting,
        painting: catalog.find(painting => painting.id === dailyPainting.painting.id) ?? dailyPainting.painting,
        catalogVersion: CATALOG_VERSION
      };
      await storage.set({ dailyPainting: selection });
      return selection;
    }
    const ids = new Set(catalog.map(painting => painting.id));
    let history = (dailyPainting?.history ?? []).filter(id => ids.has(id));
    const seen = new Set(history);
    let available = catalog.filter(painting => !seen.has(painting.id));
    if (!available.length) {
      history = [];
      available = catalog.filter(painting => catalog.length === 1 || painting.id !== dailyPainting?.painting.id);
    }
    const painting = available[Math.floor(random() * available.length)];
    const selection = { date, painting, history: [...history, painting.id], catalogVersion: CATALOG_VERSION };
    await storage.set({ dailyPainting: selection });
    return selection;
  }
  return function getDailyPainting() {
    const result = queue.then(select);
    queue = result.catch(() => {});
    return result;
  };
}
