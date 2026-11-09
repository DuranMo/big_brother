import { normalizeDomain, buildRules, ADDITION_COOLDOWN } from "./domains.js";
import { createDailyPainting } from "./daily-painting.js";

const extension = globalThis.browser ?? globalThis.chrome;
const getDailyPainting = createDailyPainting({
  storage: extension.storage.local,
  async loadCatalog() {
    const response = await fetch(extension.runtime.getURL("paintings.json"));
    if (!response.ok) throw new Error("Could not load the artwork catalog.");
    return response.json();
  }
});
const DEADLINE_ALARM = "cooldown-deadline";
const RETRY_ALARM = "reconcile";
let queue = Promise.resolve();

// Every event uses the same queue, so simultaneous popup requests cannot lose writes.
function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch(error => console.error("big_brother:", error));
  return result;
}

async function reconcile() {
  // A persistent safety check also retries transient storage/rule/alarm failures.
  if (!await extension.alarms.get(RETRY_ALARM)) {
    await extension.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
  }
  const { domains = [] } = await extension.storage.local.get("domains");
  const now = Date.now();
  // Older versions did not record addition times. Keep their pending deadline,
  // or start a one-time cooldown on upgrade if no deadline was recorded.
  const entries = domains.map(entry => Number.isFinite(entry.addedAt) ? entry : {
    domain: entry.domain,
    addedAt: Number.isFinite(entry.removeAt) ? entry.removeAt - ADDITION_COOLDOWN : now
  });
  if (entries.some((entry, index) => entry !== domains[index])) {
    await extension.storage.local.set({ domains: entries });
  }
  await extension.alarms.clear("removal-deadline");
  const deadlines = entries.map(entry => entry.addedAt + ADDITION_COOLDOWN).filter(deadline => deadline > now);
  if (deadlines.length) {
    const when = Math.min(...deadlines);
    const alarm = await extension.alarms.get(DEADLINE_ALARM);
    if (!alarm || alarm.scheduledTime !== when) {
      await extension.alarms.create(DEADLINE_ALARM, { when });
    }
  } else {
    await extension.alarms.clear(DEADLINE_ALARM);
  }

  const rules = buildRules(entries);
  const current = await extension.declarativeNetRequest.getDynamicRules();
  // Chrome may return object keys in a different order. Compare by value.
  if (canonical(current) !== canonical(rules)) {
    await extension.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: current.map(rule => rule.id), addRules: rules
    });
  }
  return entries;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function handleMessage(message) {
  let entries = await reconcile();
  if (message.type === "list") return entries;
  const domain = normalizeDomain(message.domain);
  const existing = entries.find(entry => entry.domain === domain);
  if (message.type === "add") {
    if (existing) throw new Error("That domain is already blocked.");
    entries = [...entries, { domain, addedAt: Date.now() }];
  } else {
    if (!existing) throw new Error("That domain is no longer in the list.");
    if (Date.now() < existing.addedAt + ADDITION_COOLDOWN) {
      throw new Error("This domain cannot be removed until 24 hours after it was added.");
    }
    entries = entries.filter(entry => entry.domain !== domain);
  }
  await extension.storage.local.set({ domains: entries });
  try {
    return await reconcile();
  } catch (error) {
    console.error("big_brother:", error);
    throw new Error("Saved, but browser synchronization failed. Reopen the popup to retry.");
  }
}

extension.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "dailyPainting" && sender.id === extension.runtime.id &&
      sender.url === extension.runtime.getURL("blocked.html")) {
    getDailyPainting().then(
      selection => sendResponse({ ok: true, ...selection }),
      error => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }
  // The web-accessible blocked page cannot mutate the list.
  if (sender.id !== extension.runtime.id || sender.url !== extension.runtime.getURL("popup.html") ||
      !["list", "add", "remove"].includes(message?.type)) return false;
  enqueue(() => handleMessage(message)).then(
    domains => sendResponse({ ok: true, domains }),
    error => sendResponse({ ok: false, error: error.message || "Browser operation failed. Please retry." })
  );
  return true;
});

extension.alarms.onAlarm.addListener(alarm => {
  if ([DEADLINE_ALARM, RETRY_ALARM].includes(alarm.name)) enqueue(reconcile);
});
extension.runtime.onStartup.addListener(() => { enqueue(reconcile); });
extension.runtime.onInstalled.addListener(() => { enqueue(reconcile); });
extension.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.domains) enqueue(reconcile);
});
// Runs on every worker wake, including wakes after missing alarms or a restart.
enqueue(reconcile);
