export function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function nextMidnight(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

// A fixed ordering plus the local calendar day gives every device the same
// artwork, without accounts, network calls, or device-specific browsing history.
function rotationKey(id) {
  let hash = 2166136261;
  for (const char of `big_brother:${id}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

const DRAWN_TYPES = new Set(["Painting", "Drawing", "Print", "Calligraphy", "Portrait Miniature", "Monotype", "Miniature", "Woodblock", "Illumination"]);

export function isDrawnArtwork(artwork) {
  return DRAWN_TYPES.has(artwork.type);
}

export function selectDailyArtwork(catalog, date) {
  if (!catalog.length) throw new Error("The artwork catalog is empty.");
  const ordered = [...catalog].sort((a, b) => rotationKey(a.id) - rotationKey(b.id) || a.id - b.id);
  const drawn = ordered.filter(isDrawnArtwork);
  const other = ordered.filter(artwork => !isDrawnArtwork(artwork));
  const rotation = [];
  for (let i = 0, j = 0; i < drawn.length || j < other.length; i += 4, j++) {
    rotation.push(...drawn.slice(i, i + 4));
    if (j < other.length) rotation.push(other[j]);
  }
  // UTC is used only for calendar arithmetic; the year/month/day remain local.
  // This advances by one on DST changes and skips no entries in a full cycle.
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return rotation[((day % rotation.length) + rotation.length) % rotation.length];
}

// The background owns this queue; pages never read-modify-write selection state.
const CATALOG_VERSION = 5;

export function createDailyPainting({ storage, loadCatalog, now = () => new Date() }) {
  let queue = Promise.resolve();
  let catalog;
  async function select() {
    const { dailyPainting } = await storage.get("dailyPainting");
    const today = now();
    const date = localDateKey(today);
    const isToday = dailyPainting?.date === date && dailyPainting.painting;
    if (isToday && dailyPainting.catalogVersion === CATALOG_VERSION) return dailyPainting;
    // Keep the bundled catalog in memory only while the worker is alive.
    catalog ??= await loadCatalog();
    if (!catalog.length) throw new Error("The artwork catalog is empty.");
    const painting = selectDailyArtwork(catalog, today);
    const ids = new Set(catalog.map(painting => painting.id));
    const history = (dailyPainting?.history ?? []).filter(id => ids.has(id) && id !== painting.id);
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
