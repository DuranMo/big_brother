export const ADDITION_COOLDOWN = 24 * 60 * 60 * 1000;

export function normalizeDomain(input) {
  if (typeof input !== "string" || !input.trim() || /\s/.test(input.trim())) {
    throw new Error("Enter a valid domain, such as example.com.");
  }
  const value = input.trim();
  const isURL = /^https?:\/\//i.test(value);
  // Bare domains cannot contain URL syntax, wildcards, ports or credentials.
  if (!isURL && /[/:?#@\\]/.test(value)) {
    throw new Error("Enter a domain or an HTTP(S) URL.");
  }
  let url;
  try {
    url = new URL(isURL ? value : `https://${value}`);
  } catch {
    throw new Error("Enter a valid domain.");
  }
  if (url.username || url.password || url.port || value.includes("\\")) {
    throw new Error("Use a domain without credentials or a port.");
  }
  // URL converts international names to ASCII (punycode).
  const domain = url.hostname.toLowerCase().replace(/\.$/, "");
  const labels = domain.split(".");
  if (domain.length > 253 || labels.length < 2 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /^\d+$/.test(labels.at(-1))) {
    throw new Error("Enter a valid website domain; IP addresses are not supported.");
  }
  return domain;
}

export function buildRules(entries) {
  return entries.map(entry => entry.domain).sort().flatMap((domain, index) => {
    // Keep the hostname in the URL pattern itself: Safari versions differ in
    // requestDomains support. A scheme-only filter could otherwise match all sites.
    const host = domain.replace(/\./g, "\\.");
    const authority = `([^/?#]*@)?([^./:@?#]+\\.)*${host}\\.?(:[0-9]+)?([/?#].*)?$`;
    return [
      {
        id: index * 2 + 1,
        priority: 1,
        action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
        condition: {
          regexFilter: `^https?://${authority}`,
          isUrlFilterCaseSensitive: false,
          resourceTypes: ["main_frame"]
        }
      },
      {
        id: index * 2 + 2,
        priority: 1,
        action: { type: "block" },
        condition: {
          regexFilter: `^[a-z]+://${authority}`,
          isUrlFilterCaseSensitive: false,
          excludedResourceTypes: ["main_frame"]
        }
      }
    ];
  });
}
