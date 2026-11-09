"""One-time catalog refresh: python scripts/build_paintings.py (standard library only)."""
import hashlib
import html
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

API = "https://openaccess-api.clevelandart.org/api/artworks/"
OUTPUT = Path(__file__).resolve().parents[1] / "paintings.json"
FIELDS = "id,title,type,share_license_status,images,creators,creation_date,description,did_you_know,culture,technique,measurements,is_highlight"
COUNT = 500


def plain(value):
    text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", " ", value or ""))).strip()
    return text


def main():
    eligible = {}
    skip = 0
    while True:
        query = urllib.parse.urlencode({
            "cc0": 1, "has_image": 1,
            "fields": FIELDS, "limit": 1000, "skip": skip,
        })
        request = urllib.request.Request(API + "?" + query, headers={
            "User-Agent": "Mozilla/5.0 (big_brother catalog builder)", "Accept": "application/json",
        })
        with urllib.request.urlopen(request, timeout=60) as response:
            page = json.load(response)
        artworks = page["data"]
        for art in artworks:
            image = (art.get("images") or {}).get("web") or {}
            url = urllib.parse.urlparse(image.get("url", ""))
            if art.get("share_license_status") != "CC0":
                continue
            if url.scheme != "https" or url.hostname != "openaccess-cdn.clevelandart.org":
                continue
            width, height = int(image.get("width") or 0), int(image.get("height") or 0)
            if not width or not height or not 0.35 <= width / height <= 3.2:
                continue
            artists = [plain(creator.get("description", "").split(" (", 1)[0])
                       for creator in art.get("creators", []) if creator.get("use_in_caption") is not False]
            painting = {
                "id": art["id"], "title": plain(art.get("title")) or "Untitled",
                "type": plain(art.get("type")) or "Artwork",
                "artist": ", ".join(filter(None, artists)) or "Unknown artist",
                "date": plain(art.get("creation_date")) or "Date unknown",
                "description": plain(art.get("description")),
                "fact": plain(art.get("did_you_know")),
                "culture": "; ".join(plain(value) for value in art.get("culture") or []),
                "medium": plain(art.get("technique")),
                "measurements": plain(art.get("measurements")),
                "image": image["url"], "width": width, "height": height, "license": "CC0",
            }
            # Keep the museum's text complete; choose concise records for the
            # single-screen page rather than cutting off long descriptions.
            details = ("title", "artist", "date", "type", "description", "fact", "culture", "medium", "measurements")
            if sum(len(painting[key]) for key in details) > 2000:
                continue
            score = (len(painting["fact"]) >= 40) + (len(painting["description"]) >= 80)
            if not painting["description"] and not painting["fact"]:
                continue
            score += bool(art.get("is_highlight"))
            # Stable tie-breaking spreads the selection throughout the collection.
            tie = hashlib.sha256(str(art["id"]).encode()).hexdigest()
            eligible[art["id"]] = (score, tie, painting)
        skip += len(artworks)
        print("Read {} / {} artworks".format(skip, page["info"]["total"]), flush=True)
        if not artworks or skip >= page["info"]["total"]:
            break
    ranked = sorted(eligible.values(), key=lambda item: (-item[0], item[1]))
    # Round-robin across art forms so plentiful paintings/prints do not crowd out
    # sculpture, textiles, ceramics, photographs, and the rest of the collection.
    groups = {}
    for _, _, artwork in ranked:
        groups.setdefault(artwork["type"], []).append(artwork)
    catalog = []
    index = 0
    while len(catalog) < COUNT:
        batch = [group[index] for group in groups.values() if index < len(group)]
        if not batch:
            break
        catalog.extend(batch[:COUNT - len(catalog)])
        index += 1
    if len(catalog) < COUNT:
        raise RuntimeError("Not enough eligible artworks; existing catalog was not changed.")
    OUTPUT.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print("Wrote {} CC0 artworks across {} types ({} KiB)".format(
        len(catalog), len({art["type"] for art in catalog}), OUTPUT.stat().st_size // 1024))


if __name__ == "__main__":
    main()
