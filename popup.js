import { ADDITION_COOLDOWN } from "./domains.js";

const extension = globalThis.browser ?? globalThis.chrome;
const form = document.querySelector("#add-form");
const input = document.querySelector("#domain");
const list = document.querySelector("#domains");
const error = document.querySelector("#error");
let busy = false;
let refreshing = false;

function showError(message = "") {
  error.textContent = message;
  error.hidden = !message;
}

async function request(type, domain, path) {
  const response = await extension.runtime.sendMessage({ type, domain, path });
  if (!response?.ok) throw new Error(response?.error || "Could not contact the background worker.");
  return response.domains;
}

function render(entries) {
  const openDomains = new Set([...list.querySelectorAll("details[open]")].map(details => details.dataset.domain));
  list.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "domain-row";
    const label = document.createElement("span");
    label.textContent = entry.domain;
    row.append(label);
    const removableAt = entry.addedAt + ADDITION_COOLDOWN;
    if (Date.now() >= removableAt) {
      const button = document.createElement("button");
      button.textContent = "Remove";
      button.type = "button";
      button.disabled = busy;
      button.setAttribute("aria-label", `Remove ${entry.domain}`);
      button.addEventListener("click", () => mutate("remove", entry.domain));
      row.append(button);
    } else {
      const time = document.createElement("time");
      time.dataset.deadline = removableAt;
      time.dateTime = new Date(removableAt).toISOString();
      time.title = `Can remove after: ${new Date(removableAt).toLocaleString()}`;
      row.append(time);
    }
    const details = document.createElement("details");
    details.dataset.domain = entry.domain;
    details.open = openDomains.has(entry.domain);
    const summary = document.createElement("summary");
    const paths = entry.allowedPaths ?? [];
    summary.textContent = `Allowed paths (${paths.length})`;
    details.append(summary);
    const pathForm = document.createElement("form");
    const pathInput = document.createElement("input");
    pathInput.placeholder = "/section/*";
    pathInput.required = true;
    pathInput.autocomplete = "off";
    pathInput.spellcheck = false;
    pathInput.setAttribute("aria-label", `Allowed path on ${entry.domain}`);
    const allow = document.createElement("button");
    allow.type = "submit";
    allow.textContent = "Allow";
    allow.disabled = busy;
    pathForm.append(pathInput, allow);
    pathForm.addEventListener("submit", event => {
      event.preventDefault();
      mutate("allowPath", entry.domain, pathInput.value);
    });
    details.append(pathForm);
    const pathList = document.createElement("ul");
    pathList.className = "allowed-paths";
    for (const path of paths) {
      const pathRow = document.createElement("li");
      const text = document.createElement("code");
      text.textContent = path;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.disabled = busy;
      remove.setAttribute("aria-label", `Remove allowed path ${path} on ${entry.domain}`);
      remove.addEventListener("click", () => mutate("removeAllowedPath", entry.domain, path));
      pathRow.append(text, remove);
      pathList.append(pathRow);
    }
    details.append(pathList);
    item.append(row, details);
    list.append(item);
  }
  updateCountdowns();
}

async function refresh() {
  if (refreshing || busy) return;
  refreshing = true;
  try {
    render(await request("list"));
    showError();
  } catch (failure) {
    showError(failure.message);
  } finally {
    refreshing = false;
  }
}

async function mutate(type, domain, path) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach(button => { button.disabled = true; });
  showError();
  try {
    const entries = await request(type, domain, path);
    if (type === "add") input.value = "";
    render(entries);
  } catch (failure) {
    showError(failure.message);
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach(button => { button.disabled = false; });
  }
}

function updateCountdowns() {
  let overdue = false;
  for (const time of list.querySelectorAll("time")) {
    const seconds = Math.max(0, Math.ceil((Number(time.dataset.deadline) - Date.now()) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    time.textContent = `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")} until removable`;
    if (!seconds) overdue = true;
  }
  if (overdue) setTimeout(refresh, 0);
}

form.addEventListener("submit", event => {
  event.preventDefault();
  mutate("add", input.value);
});
extension.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.domains) refresh();
});
setInterval(updateCountdowns, 1000);
refresh();
