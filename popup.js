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

async function request(type, domain) {
  const response = await extension.runtime.sendMessage({ type, domain });
  if (!response?.ok) throw new Error(response?.error || "Could not contact the background worker.");
  return response.domains;
}

function render(entries) {
  list.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("li");
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
    list.append(row);
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

async function mutate(type, domain) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach(button => { button.disabled = true; });
  showError();
  try {
    const entries = await request(type, domain);
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
