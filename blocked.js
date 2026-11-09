import { localDateKey, nextMidnight } from "./daily-painting.js";

const extension = globalThis.browser ?? globalThis.chrome;
const artwork = document.querySelector("#artwork");
const image = document.querySelector("#painting");
const fallback = document.querySelector("#image-fallback");
let displayedDate;
let loading = false;
let timer;

async function refresh() {
  if (loading) return;
  clearTimeout(timer);
  if (displayedDate !== localDateKey()) {
    loading = true;
    try {
      const selection = await extension.runtime.sendMessage({ type: "dailyPainting" });
      if (!selection?.ok) throw new Error(selection?.error || "Artwork unavailable.");
      const { painting } = selection;
      document.querySelector("#painting-title").textContent = painting.title;
      document.querySelector("#painting-artist").textContent = `${painting.artist} · ${painting.date}`;
      for (const [id, text] of [
        ["painting-context", [painting.type, painting.culture, painting.medium].filter(Boolean).join(" · ")],
        ["painting-measurements", painting.measurements],
        ["painting-description", painting.description],
        ["painting-fact", painting.fact ? `Did you know? ${painting.fact}` : ""]
      ]) {
        const element = document.querySelector(`#${id}`);
        element.textContent = text || "";
        element.hidden = !element.textContent;
      }
      artwork.hidden = false;
      image.hidden = true;
      fallback.hidden = true;
      image.alt = `${painting.title} — ${painting.artist}`;
      image.onload = () => { image.hidden = false; fallback.hidden = true; };
      image.onerror = () => { image.hidden = true; fallback.hidden = false; };
      image.src = painting.image;
      displayedDate = selection.date;
    } catch (error) {
      // The original message remains useful even if storage or the catalog fails.
      console.error("big_brother artwork:", error);
      artwork.hidden = true;
    } finally {
      loading = false;
    }
  }
  // Recompute in local time (including DST), rather than adding 24 hours.
  const delay = displayedDate && displayedDate !== localDateKey()
    ? 1000 : nextMidnight().getTime() - Date.now();
  timer = setTimeout(refresh, Math.max(1000, delay));
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
window.addEventListener("focus", refresh);
window.addEventListener("online", () => {
  displayedDate = undefined;
  refresh();
});
refresh();
