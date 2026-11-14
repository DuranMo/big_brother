import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeDomain, normalizeAllowedPath, buildRules, createNavigationCheck, ADDITION_COOLDOWN } from "../domains.js";

test("domain normalization and validation", () => {
  for (const [input, expected] of [
    [" Example.COM ", "example.com"],
    ["example.com.", "example.com"],
    ["https://WWW.Example.com/a?b=c#d", "www.example.com"],
    ["http://example.com:80", "example.com"],
    ["bücher.de", "xn--bcher-kva.de"],
    ["a.b.example.com", "a.b.example.com"]
  ]) assert.equal(normalizeDomain(input), expected);

  for (const input of [
    "", null, 42, "com", "localhost", "127.0.0.1", "0x7f000001", "[::1]",
    "*.example.com", ".example.com", "example..com", "example.com..",
    "-bad.example", "bad-.example", "bad_name.example", "a".repeat(64) + ".com",
    "example.com/path", "example.com:8080", "https://example.com:8080",
    "https://user:pass@example.com", "ftp://example.com", "https://example.com\\evil",
    "example.com\n.evil.org", "example.com?x=1", "example.com#hash"
  ]) assert.throws(() => normalizeDomain(input), undefined, String(input));
});

test("rules use domain boundaries and cannot redirect the extension itself", () => {
  assert.deepEqual(buildRules([]), []);
  const rules = buildRules([{ domain: "example.com", addedAt: 0 }]);
  assert.equal(rules.length, 2);
  const redirect = rules.find(rule => rule.action.type === "redirect");
  const block = rules.find(rule => rule.action.type === "block");
  assert.equal(redirect.action.redirect.extensionPath, "/blocked.html");
  assert.deepEqual(redirect.condition.resourceTypes, ["main_frame"]);
  assert.deepEqual(block.condition.excludedResourceTypes, ["main_frame"]);
  for (const url of [
    "https://example.com/", "http://sub.example.com/", "https://a.b.example.com/path",
    "https://example.com:8443/", "https://example.com./", "https://EXAMPLE.COM/",
    "https://user:pass@sub.example.com/", "https://example.com"
  ]) {
    assert.ok(matchesRequest(rules, url, "main_frame", "redirect"), url);
    assert.ok(matchesRequest(rules, url, "script", "block"), url);
  }
  for (const url of [
    "https://notexample.com/", "https://example.com.other.org/", "https://exampleXcom/",
    "https://example.org/example.com", "https://example.org/?url=https://example.com/",
    "https://example.com@other.org/", "https://other.org/#https://example.com/",
    "chrome-extension://example.com/blocked.html", "safari-web-extension://example.com/blocked.html",
    "https://example.com-other.org/", "https://other.org/", "https://other.org/example.com/file.js"
  ]) {
    assert.ok(!matchesRequest(rules, url, "main_frame"), url);
    assert.ok(!matchesRequest(rules, url, "script"), url);
  }
  assert.ok(matchesRequest(rules, "wss://sub.example.com/socket", "websocket", "block"));
  assert.ok(!matchesRequest(rules, "wss://other.org/socket", "websocket"));
  // Even an engine ignoring requestDomains must still scope every rule by URL.
  assert.ok(rules.every(rule => !rule.condition.requestDomains && rule.condition.regexFilter));
  const many = buildRules([{ domain: "example.org" }, { domain: "example.com" }]);
  assert.equal(new Set(many.map(rule => rule.id)).size, many.length);
  assertRulesFor(many, ["example.com", "example.org"]);
});

test("allowed paths normalize URLs, reject broad wildcards and stay on the blocked domain", () => {
  for (const [value, expected] of [
    ["/section/", "/section"], [" /section/* ", "/section/*"],
    ["https://www.example.com/section/*", "/section/*"], ["/a+b", "/a+b"], ["/", "/"]
  ]) assert.equal(normalizeAllowedPath(value, "example.com"), expected);
  for (const value of ["", null, "/*", "*", "/foo*", "/foo/*/bar", "/**", "/foo?bar=1", "/foo#bar",
    "https://other.org/section/*", "//other.org/section/*", "https://example.com.evil.org/foo",
    "https://user@example.com/foo", "https://example.com:8080/foo", "ftp://example.com/foo", "/foo\\bar"])
    assert.throws(() => normalizeAllowedPath(value, "example.com"), undefined, String(value));
});

test("path allow rules have priority without allowing neighboring paths or unrelated domains", () => {
  const rules = buildRules([{ domain: "example.com", allowedPaths: ["/section/*", "/exact", "/a+b"] }]);
  const action = url => rules.filter(rule => matchesRequest([rule], url, "main_frame"))
    .sort((a, b) => b.priority - a.priority)[0]?.action.type;
  const shouldBlock = createNavigationCheck(rules);
  for (const url of ["https://example.com/section", "https://example.com/section/", "https://www.example.com/section/123",
    "https://example.com/section/sub/path?x=1", "https://example.com/exact/", "https://example.com/exact?x=1", "https://example.com/a+b"])
    { assert.equal(action(url), "allowAllRequests", url); assert.equal(shouldBlock(url), false, url); }
  for (const url of ["https://example.com/", "https://example.com/section-other", "https://example.com/exact/child",
    "https://example.com/Section/1", "https://example.com/aaab", "https://example.com/?url=/section/123"])
    { assert.equal(action(url), "redirect", url); assert.equal(shouldBlock(url), true, url); }
  for (const url of ["https://other.org/section/123", "https://notexample.com/section/123", "https://example.com.other.org/section/123"])
    { assert.equal(action(url), undefined, url); assert.equal(shouldBlock(url), false, url); }
  assert.equal(shouldBlock("https://EXAMPLE.COM/section/1"), false);
  assert.equal(shouldBlock("https://example.com/section/../feed"), true);
  assert.equal(shouldBlock("chrome-extension://example.com/blocked.html"), false);
  assert.equal(shouldBlock("not a URL"), false);
  assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length);
  assert.ok(rules.filter(rule => rule.action.type === "allowAllRequests").every(rule =>
    rule.condition.resourceTypes.length === 1 && rule.condition.resourceTypes[0] === "main_frame"));
});

function matchesRequest(rules, url, resourceType, action) {
  return rules.some(rule => (!action || rule.action.type === action) &&
    (!rule.condition.resourceTypes || rule.condition.resourceTypes.includes(resourceType)) &&
    !rule.condition.excludedResourceTypes?.includes(resourceType) &&
    new RegExp(rule.condition.regexFilter, rule.condition.isUrlFilterCaseSensitive ? "" : "i").test(url));
}

function assertRulesFor(rules, domains) {
  assert.equal(rules.length, domains.length * 2);
  for (const domain of ["example.com", "example.org", "example.net", "example.edu", "example.io", "other.org"]) {
    assert.equal(matchesRequest(rules, `https://${domain}/`, "main_frame", "redirect"), domains.includes(domain), domain);
    assert.equal(matchesRequest(rules, `https://${domain}/script.js`, "script", "block"), domains.includes(domain), domain);
  }
}

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map(listener => listener(...args)); }
  };
}

function mockChrome() {
  const state = { domains: [], rules: [], alarms: new Map(), failRules: false, failStorage: false,
    tabs: new Map(), tabReads: 0, tabUpdates: [] };
  const changed = event();
  const api = {
    runtime: {
      id: "test-extension",
      getURL: path => `chrome-extension://test-extension/${path}`,
      onMessage: event(), onStartup: event(), onInstalled: event()
    },
    tabs: {
      onUpdated: event(),
      async get(tabId) {
        state.tabReads++;
        if (!state.tabs.has(tabId)) throw new Error("Tab closed");
        return structuredClone(state.tabs.get(tabId));
      },
      async update(tabId, update) {
        state.tabUpdates.push({ tabId, ...update });
        Object.assign(state.tabs.get(tabId), update);
        api.tabs.onUpdated.emit(tabId, update);
      }
    },
    storage: {
      onChanged: changed,
      local: {
        async get() {
          if (state.failStorage) throw new Error("Storage unavailable");
          return { domains: structuredClone(state.domains), dailyPainting: structuredClone(state.dailyPainting) };
        },
        async set({ domains, dailyPainting }) {
          if (state.failStorage) throw new Error("Storage unavailable");
          if (dailyPainting) { state.dailyPainting = structuredClone(dailyPainting); return; }
          const oldValue = state.domains;
          state.domains = structuredClone(domains);
          changed.emit({ domains: { oldValue, newValue: domains } }, "local");
        }
      }
    },
    alarms: {
      onAlarm: event(),
      async get(name) { return state.alarms.get(name); },
      async create(name, options) {
        state.alarms.set(name, { name, scheduledTime: options.when, ...options });
      },
      async clear(name) { return state.alarms.delete(name); }
    },
    declarativeNetRequest: {
      async getDynamicRules() { return structuredClone(state.rules); },
      async updateDynamicRules({ removeRuleIds, addRules }) {
        if (state.failRules) throw new Error("Rules unavailable");
        state.rules = [...state.rules.filter(rule => !removeRuleIds.includes(rule.id)), ...structuredClone(addRules)];
      }
    }
  };
  function message(type, domain, sender = { id: api.runtime.id, url: api.runtime.getURL("popup.html") }, path) {
    return new Promise(resolve => {
      const responses = api.runtime.onMessage.emit({ type, domain, path }, sender, resolve);
      if (!responses.includes(true)) resolve(undefined);
    });
  }
  return { api, state, message };
}

for (const namespace of ["chrome", "browser"]) {
test(`${namespace}: background enforces addition cooldowns and recovers across wakes`, async t => {
  const { api, state, message } = mockChrome();
  const originalChrome = globalThis.chrome;
  const originalBrowser = globalThis.browser;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalError = console.error;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  globalThis.chrome = namespace === "chrome" ? api : undefined;
  globalThis.browser = namespace === "browser" ? api : undefined;
  let catalogLoads = 0;
  globalThis.fetch = async url => {
    assert.equal(url, api.runtime.getURL("paintings.json"));
    catalogLoads++;
    return { ok: true, json: async () => [{ id: 1, title: "A painting" }] };
  };
  console.error = () => {}; // Expected API failure cases below.
  t.after(() => {
    Date.now = originalNow;
    globalThis.chrome = originalChrome;
    globalThis.browser = originalBrowser;
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });
  await import(`../background.js?namespace=${namespace}`);
  assert.deepEqual((await message("list")).domains, []);
  const blockedSender = { id: api.runtime.id, url: api.runtime.getURL("blocked.html") };
  assert.equal(await message("dailyPainting"), undefined, "only the blocked page can request artwork");
  const paintings = await Promise.all(Array.from({ length: 5 }, () => message("dailyPainting", undefined, blockedSender)));
  assert.ok(paintings.every(response => response.ok && response.painting.id === 1));
  assert.equal(catalogLoads, 1);
  assert.deepEqual(state.domains, []);

  const additions = await Promise.all([message("add", "EXAMPLE.COM"), message("add", "example.org")]);
  assert.ok(additions.every(response => response.ok));
  assert.equal(state.domains.length, 2);
  assertRulesFor(state.rules, ["example.com", "example.org"]);
  assert.equal((await message("add", "https://example.com/path")).ok, false);
  assert.equal((await message("add", "*.example.net")).ok, false);

  const addedAt = now;
  const deadline = addedAt + ADDITION_COOLDOWN;
  assert.equal(state.domains[0].addedAt, addedAt);
  assert.equal(state.alarms.get("cooldown-deadline").scheduledTime, deadline);
  const earlyRemoval = await message("remove", "example.com");
  assert.equal(earlyRemoval.ok, false, "background must reject early removal even without the popup");
  assert.match(earlyRemoval.error, /24 hours/);
  now += 1000;
  assert.equal((await message("remove", "example.com")).ok, false);
  assert.equal(state.domains[0].addedAt, addedAt, "removal attempts cannot restart the cooldown");
  assert.equal((await message("add", "example.com")).ok, false);

  state.alarms.clear(); // Simulate alarms lost during a browser restart.
  api.runtime.onStartup.emit();
  await message("list");
  assert.equal(state.alarms.get("cooldown-deadline").scheduledTime, deadline);

  now = deadline - 1;
  api.alarms.onAlarm.emit({ name: "cooldown-deadline" });
  await message("list");
  assert.equal((await message("remove", "example.com")).ok, false);
  assert.equal(state.domains.length, 2);
  assert.ok(matchesRequest(state.rules, "https://example.com/", "main_frame"));

  now = deadline;
  api.alarms.onAlarm.emit({ name: "cooldown-deadline" });
  await message("list");
  assert.equal(state.domains.length, 2, "cooldown expiration must not automatically unblock");
  assert.ok(matchesRequest(state.rules, "https://example.com/", "main_frame"));
  assert.equal((await message("remove", "example.com")).ok, true);
  assert.deepEqual(state.domains, [{ domain: "example.org", addedAt }]);
  assertRulesFor(state.rules, ["example.org"]);

  now += ADDITION_COOLDOWN + 60_000;
  state.alarms.clear();
  api.runtime.onStartup.emit();
  await message("list");
  assert.equal(state.domains.length, 1, "overdue cooldowns remain blocked after a restart");
  assert.ok(state.alarms.has("reconcile"));
  assert.ok(!state.alarms.has("cooldown-deadline"));
  await message("remove", "example.org");
  assert.deepEqual(state.domains, []);
  assert.deepEqual(state.rules, []);

  await message("add", "example.net");
  state.alarms.clear();
  api.runtime.onStartup.emit();
  await message("list");
  assert.equal(state.alarms.get("cooldown-deadline").scheduledTime, now + ADDITION_COOLDOWN);
  assert.ok(matchesRequest(state.rules, "https://example.net/", "main_frame"));

  state.failRules = true;
  const failedAdd = await message("add", "example.edu");
  assert.equal(failedAdd.ok, false);
  assert.match(failedAdd.error, /Saved/);
  assert.ok(state.domains.some(entry => entry.domain === "example.edu"));
  state.failRules = false;
  api.alarms.onAlarm.emit({ name: "reconcile" });
  await message("list");
  assert.ok(matchesRequest(state.rules, "https://example.edu/", "main_frame"));

  now += ADDITION_COOLDOWN;
  state.failRules = true;
  const failedRemoval = await message("remove", "example.net");
  assert.equal(failedRemoval.ok, false);
  assert.match(failedRemoval.error, /Saved/);
  assert.ok(!state.domains.some(entry => entry.domain === "example.net"));
  assert.ok(matchesRequest(state.rules, "https://example.net/", "main_frame"));
  state.failRules = false;
  api.alarms.onAlarm.emit({ name: "reconcile" });
  await message("list");
  assertRulesFor(state.rules, ["example.edu"]);

  state.failStorage = true;
  assert.equal((await message("add", "example.io")).ok, false);
  state.failStorage = false;
  assert.ok((await message("list")).ok, "queue recovers after an API rejection");

  const before = structuredClone(state.domains);
  assert.equal(await message("remove", "example.edu", { id: api.runtime.id, url: api.runtime.getURL("blocked.html") }), undefined);
  assert.equal(await message("cancel", "example.edu"), undefined);
  assert.deepEqual(state.domains, before);

  await message("remove", "example.edu");
  const readded = await message("add", "example.edu");
  assert.equal(readded.domains[0].addedAt, now, "re-adding starts a fresh cooldown");
  assert.equal((await message("remove", "example.edu")).ok, false);

  // A fresh module instance simulates a new worker, without startup/onInstalled events.
  api.runtime.onMessage = event();
  api.storage.onChanged = event();
  api.tabs.onUpdated = event();
  // Simulate persisted rules from the old Safari version before the worker wakes.
  state.rules = [{
    id: 1, priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
    condition: { requestDomains: ["example.edu"], regexFilter: "^https?://", resourceTypes: ["main_frame"] }
  }, {
    id: 2, priority: 1, action: { type: "block" },
    condition: { requestDomains: ["example.edu"], excludedResourceTypes: ["main_frame"] }
  }];
  state.alarms.clear();
  await import(`../background.js?wake=2&namespace=${namespace}`);
  await message("list");
  assert.equal(state.domains[0].addedAt, now);
  assertRulesFor(state.rules, ["example.edu"]);
  assert.equal((await message("remove", "example.edu")).ok, false);
  assert.equal(state.alarms.get("cooldown-deadline").scheduledTime, now + ADDITION_COOLDOWN);

  // Migrate old records once, without silently unblocking or resetting on every wake.
  await api.storage.local.set({ domains: [
    { domain: "example.com", removeAt: null },
    { domain: "example.org", removeAt: now + 1000 },
    { domain: "example.net", removeAt: now - 1000 }
  ] });
  const migrated = (await message("list")).domains;
  assert.deepEqual(migrated, [
    { domain: "example.com", addedAt: now },
    { domain: "example.org", addedAt: now + 1000 - ADDITION_COOLDOWN },
    { domain: "example.net", addedAt: now - 1000 - ADDITION_COOLDOWN }
  ]);
  assert.equal((await message("remove", "example.com")).ok, false);
  assert.equal((await message("remove", "example.org")).ok, false);
  assert.equal((await message("remove", "example.net")).ok, true);
  now += 1000;
  api.runtime.onStartup.emit();
  await message("list");
  assert.equal(state.domains[0].addedAt, migrated[0].addedAt);
  assert.equal((await message("remove", "example.org")).ok, true);

  const unchangedAddition = state.domains[0].addedAt;
  const paths = await Promise.all([
    message("allowPath", "example.com", undefined, "/section/*"),
    message("allowPath", "example.com", undefined, "https://www.example.com/exact/")
  ]);
  assert.ok(paths.every(response => response.ok));
  assert.deepEqual(state.domains[0].allowedPaths, ["/section/*", "/exact"]);
  assert.equal(state.domains[0].addedAt, unchangedAddition, "path changes preserve the domain cooldown");
  assert.equal((await message("remove", "example.com")).ok, false);
  assert.equal((await message("allowPath", "example.com", undefined, "/section/*")).ok, false);
  assert.equal((await message("allowPath", "example.com", undefined, "/*")).ok, false);
  assert.equal((await message("allowPath", "example.com", undefined, "https://other.org/section/*")).ok, false);
  assert.equal(await message("allowPath", "example.com", blockedSender, "/bypass"), undefined);
  api.runtime.onStartup.emit();
  await message("list");
  assert.equal(state.rules.filter(rule => rule.action.type === "allowAllRequests").length, 2);
  await message("removeAllowedPath", "example.com", undefined, "/section/*");
  assert.deepEqual(state.domains[0].allowedPaths, ["/exact"]);
  assert.equal(state.rules.filter(rule => rule.action.type === "allowAllRequests").length, 1);

  const allowed = "https://www.example.com/exact?view=1";
  state.tabs.set(1, { url: allowed });
  api.tabs.onUpdated.emit(1, { url: allowed });
  api.tabs.onUpdated.emit(1, { title: "Title update" });
  api.tabs.onUpdated.emit(2, { url: "https://other.org/" });
  api.tabs.onUpdated.emit(3, { url: api.runtime.getURL("blocked.html") });
  await message("list");
  assert.equal(state.tabReads, 0, "allowed/unrelated URL and title updates do not need tab API calls");
  const denied = "https://www.example.com/feed";
  state.tabs.set(1, { url: denied });
  api.tabs.onUpdated.emit(1, { url: denied });
  await message("list");
  assert.deepEqual(state.tabUpdates, [{ tabId: 1, url: api.runtime.getURL("blocked.html") }]);

  // An older queued URL event must not redirect a tab that has moved elsewhere.
  state.tabs.set(1, { url: allowed });
  api.tabs.onUpdated.emit(1, { url: denied });
  state.tabs.set(2, { url: denied, pendingUrl: allowed });
  api.tabs.onUpdated.emit(2, { url: denied });
  api.tabs.onUpdated.emit(999, { url: denied });
  await message("list");
  assert.equal(state.tabUpdates.length, 1, "stale, pending, and closed tabs are left alone");

  await message("removeAllowedPath", "example.com", undefined, "/exact");
  state.tabs.set(1, { url: allowed });
  api.tabs.onUpdated.emit(1, { url: allowed });
  await message("list");
  assert.equal(state.tabUpdates.length, 2, "editing paths refreshes the in-memory navigation policy");
});
}

test("manifest paths exist and the blocked page preserves the message without controls", async () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes("declarativeNetRequestWithHostAccess"));
  for (const path of [manifest.background.service_worker, manifest.action.default_popup,
    ...manifest.web_accessible_resources[0].resources]) {
    assert.ok((await readFile(new URL(path, root))).length);
  }
  const html = await readFile(new URL("blocked.html", root), "utf8");
  const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
  assert.match(body, /class="message">Not all those who wander are lost<\/p>/);
  assert.ok(!/<(button|a|nav)\b/.test(body));
  assert.match(body, /<img[^>]+id="painting"/);
});
