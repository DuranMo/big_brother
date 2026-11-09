import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createDailyPainting, localDateKey } from "../daily-painting.js";

const catalog = [1, 2, 3].map(id => ({
  id, title: `Painting ${id}`, artist: "An artist", date: "1900",
  image: `https://openaccess-cdn.clevelandart.org/test/${id}.jpg`,
  description: "", fact: "", license: "CC0"
}));
catalog[1] = {
  ...catalog[1], description: "A complete museum description.", fact: "A separate museum fact.",
  culture: "Japan, Muromachi period", medium: "Ink on paper", measurements: "40 x 60 cm"
};

function memoryStorage() {
  const data = { domains: [{ domain: "example.com", addedAt: 123 }] };
  return {
    data,
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(values) { Object.assign(data, structuredClone(values)); }
  };
}

test("one persistent painting per local day, including concurrent tabs and worker restarts", async () => {
  const storage = memoryStorage();
  let date = new Date(2026, 10, 8, 0, 0, 0);
  let loads = 0;
  const options = {
    storage, now: () => date, random: () => 0,
    loadCatalog: async () => { loads++; return catalog; }
  };
  const get = createDailyPainting(options);
  const simultaneous = await Promise.all(Array.from({ length: 20 }, () => get()));
  assert.ok(simultaneous.every(selection => selection.painting.id === 1));
  assert.equal(loads, 1);
  assert.equal(storage.data.dailyPainting.history.length, 1);
  date = new Date(2026, 10, 8, 23, 59, 59);
  assert.equal((await get()).painting.id, 1);
  const restarted = createDailyPainting({ ...options, loadCatalog: () => { throw new Error("must use persisted painting"); } });
  assert.equal((await restarted()).painting.id, 1);
  date = new Date(2026, 10, 9, 0, 0, 0);
  assert.equal((await get()).painting.id, 2);
  date = new Date(2026, 10, 10);
  assert.equal((await createDailyPainting(options)()).painting.id, 3);
  date = new Date(2026, 10, 11);
  assert.equal((await get()).painting.id, 1, "start a new cycle only after exhausting the catalog");
  assert.deepEqual(storage.data.domains, [{ domain: "example.com", addedAt: 123 }]);
});

test("selection retries after storage/catalog failures and supports a single painting", async () => {
  const storage = memoryStorage();
  let failed = true;
  const get = createDailyPainting({
    storage, loadCatalog: async () => {
      if (failed) throw new Error("catalog error");
      return [catalog[0]];
    }
  });
  await assert.rejects(get(), /catalog error/);
  failed = false;
  assert.equal((await get()).painting.id, 1);
  const tomorrow = createDailyPainting({ storage, loadCatalog: async () => [catalog[0]], now: () => new Date(2099, 0, 1) });
  assert.equal((await tomorrow()).painting.id, 1);
  const originalSet = storage.set;
  storage.set = async () => { throw new Error("storage error"); };
  const later = createDailyPainting({ storage, loadCatalog: async () => catalog, now: () => new Date(2099, 0, 2), random: () => 0 });
  await assert.rejects(later(), /storage error/);
  storage.set = originalSet;
  assert.equal((await later()).painting.id, 2);
});

test("catalog updates enrich today's painting without changing its selection or history", async () => {
  const storage = memoryStorage();
  const today = new Date(2026, 10, 8);
  storage.data.dailyPainting = {
    date: localDateKey(today), painting: { id: 2, title: "Painting 2", description: "Old shortened text" }, history: [1, 2]
  };
  const updated = createDailyPainting({ storage, loadCatalog: async () => catalog, now: () => today });
  const selection = await updated();
  assert.equal(selection.painting.id, 2);
  assert.equal(selection.painting.description, catalog[1].description);
  assert.equal(selection.painting.culture, "Japan, Muromachi period");
  assert.deepEqual(selection.history, [1, 2]);
  const restarted = createDailyPainting({
    storage, now: () => today, loadCatalog: () => { throw new Error("must use enriched stored selection"); }
  });
  assert.deepEqual(await restarted(), selection);
});

test("local date and midnight follow the user's timezone and daylight saving changes", () => {
  const moduleURL = new URL("../daily-painting.js", import.meta.url).href;
  const script = `
    import { localDateKey, nextMidnight } from ${JSON.stringify(moduleURL)};
    const spring = new Date(2026, 2, 8);
    const autumn = new Date(2026, 10, 1);
    console.log(JSON.stringify([
      localDateKey(new Date('2026-11-09T02:00:00Z')),
      (nextMidnight(spring) - spring) / 3600000,
      (nextMidnight(autumn) - autumn) / 3600000
    ]));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TZ: "America/Chicago" }, encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ["2026-11-08", 23, 25]);
});

test("bundled catalog contains 500 unique, documented CC0 museum paintings", async () => {
  const paintings = JSON.parse(await readFile(new URL("../paintings.json", import.meta.url), "utf8"));
  assert.equal(paintings.length, 500);
  assert.equal(new Set(paintings.map(painting => painting.id)).size, paintings.length);
  for (const painting of paintings) {
    assert.equal(painting.license, "CC0");
    assert.equal(new URL(painting.image).origin, "https://openaccess-cdn.clevelandart.org");
    assert.ok(painting.title && painting.artist && painting.date);
    assert.ok(painting.width > 0 && painting.height > 0);
    assert.ok(painting.description || painting.fact);
    assert.ok(!/<[^>]+>/.test(painting.description + painting.fact));
    assert.equal(typeof painting.culture, "string");
    assert.equal(typeof painting.medium, "string");
    assert.equal(typeof painting.measurements, "string");
  }
  assert.ok(paintings.some(painting => painting.description.length > 650), "full museum descriptions are retained");
});

test("blocked page keeps metadata on image failure, rotates at midnight and survives selection errors", async t => {
  const originals = Object.fromEntries(["chrome", "browser", "document", "window", "setTimeout", "clearTimeout", "Date"].map(key => [key, globalThis[key]]));
  const originalError = console.error;
  t.after(() => { Object.assign(globalThis, originals); console.error = originalError; });
  let timestamp = new originals.Date(2026, 10, 8, 23, 59, 59).getTime();
  globalThis.Date = class extends originals.Date {
    constructor(...args) { super(...(args.length ? args : [timestamp])); }
    static now() { return timestamp; }
  };
  const elements = Object.fromEntries([
    "artwork", "painting", "image-fallback", "painting-title", "painting-artist", "painting-description",
    "painting-fact", "painting-context", "painting-measurements"
  ].map(id => [id, { hidden: true, textContent: "" }]));
  const events = {};
  globalThis.document = {
    hidden: false,
    querySelector: selector => elements[selector.slice(1)],
    addEventListener: (event, handler) => { events[event] = handler; }
  };
  globalThis.window = { addEventListener: (event, handler) => { events[event] = handler; } };
  let alarm;
  globalThis.setTimeout = (handler, delay) => { alarm = { handler, delay }; return 1; };
  globalThis.clearTimeout = () => {};
  globalThis.browser = undefined;
  let unavailable = false;
  const get = createDailyPainting({ storage: memoryStorage(), loadCatalog: async () => catalog, random: () => 0 });
  globalThis.chrome = { runtime: { sendMessage: async () => {
    if (unavailable) return { ok: false, error: "Storage unavailable" };
    return { ok: true, ...await get() };
  } } };
  console.error = () => {};
  await import("../blocked.js?test=page");
  await new Promise(setImmediate);
  assert.equal(elements.artwork.hidden, false);
  assert.equal(elements["painting-title"].textContent, "Painting 1");
  assert.equal(elements["painting-description"].hidden, true, "missing descriptions leave no empty paragraph");
  assert.equal(elements["painting-fact"].hidden, true);
  assert.equal(elements["painting-context"].hidden, true);
  assert.equal(elements["painting-measurements"].hidden, true);
  elements.painting.onerror();
  assert.equal(elements.painting.hidden, true);
  assert.equal(elements["image-fallback"].hidden, false);
  assert.equal(elements["painting-title"].textContent, "Painting 1");
  events.online();
  await new Promise(setImmediate);
  assert.equal(elements["painting-title"].textContent, "Painting 1", "reconnecting retries the same daily artwork");
  elements.painting.onload();
  assert.equal(elements["image-fallback"].hidden, true);
  assert.equal(alarm.delay, 1000);
  timestamp += 1000;
  await alarm.handler();
  assert.equal(elements["painting-title"].textContent, "Painting 2");
  assert.equal(elements["painting-description"].textContent, "A complete museum description.");
  assert.equal(elements["painting-fact"].textContent, "Did you know? A separate museum fact.");
  assert.equal(elements["painting-context"].textContent, "Japan, Muromachi period · Ink on paper");
  assert.equal(elements["painting-measurements"].textContent, "40 x 60 cm");
  assert.equal(elements["painting-fact"].hidden, false);
  elements.painting.onload();
  assert.equal(elements.painting.hidden, false);
  assert.equal(elements["image-fallback"].hidden, true);
  unavailable = true;
  timestamp += 24 * 3600000;
  await events.focus();
  assert.equal(elements.artwork.hidden, true, "original message remains when selection is unavailable");
  assert.equal(localDateKey(), "2026-11-10");
});
