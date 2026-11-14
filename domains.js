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

export function normalizeAllowedPath(input, domain) {
  if (typeof input !== "string" || !input.trim() || /\s|\\/.test(input.trim())) {
    throw new Error("Enter a path such as /section/* or a URL on this domain.");
  }
  const value = input.trim();
  const prefix = value.endsWith("/*");
  if (value.replace(/\/\*$/, "").includes("*") || (!value.startsWith("/") && !/^https?:\/\//i.test(value))) {
    throw new Error("Use a path with an optional /* at the end.");
  }
  let url;
  try {
    url = new URL(prefix ? value.slice(0, -1) : value, `https://${domain}`);
  } catch {
    throw new Error("Enter a valid path or URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port ||
      (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) || url.search || url.hash) {
    throw new Error("Use a URL on this domain without credentials, ports, queries, or fragments.");
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (prefix && path === "/") throw new Error("Choose a specific section, such as /section/*.");
  return prefix ? `${path}/*` : path;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildRules(entries) {
  let id = 1;
  return [...entries].sort((a, b) => a.domain.localeCompare(b.domain)).flatMap(({ domain, allowedPaths = [] }) => {
    // Keep the hostname in the URL pattern itself: Safari versions differ in
    // requestDomains support. A scheme-only filter could otherwise match all sites.
    const host = escapeRegex(domain);
    const authority = `([^/?#]*@)?([^./:@?#]+\\.)*${host}\\.?(:[0-9]+)?`;
    return [
      {
        id: id++,
        priority: 1,
        action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
        condition: {
          regexFilter: `^https?://${authority}([/?#].*)?$`,
          isUrlFilterCaseSensitive: false,
          resourceTypes: ["main_frame"]
        }
      },
      {
        id: id++,
        priority: 1,
        action: { type: "block" },
        condition: {
          regexFilter: `^[a-z]+://${authority}([/?#].*)?$`,
          isUrlFilterCaseSensitive: false,
          excludedResourceTypes: ["main_frame"]
        }
      },
      ...allowedPaths.map(pattern => {
        const prefix = pattern.endsWith("/*");
        const path = escapeRegex(prefix ? pattern.slice(0, -2) : pattern);
        const suffix = prefix ? "(/[^?#]*)?([?#].*)?$" : pattern === "/" ? "([?#].*)?$" : "/?([?#].*)?$";
        return {
          id: id++,
          priority: 2,
          action: { type: "allowAllRequests" },
          condition: {
            regexFilter: `^https?://${authority}${path}${suffix}`,
            isUrlFilterCaseSensitive: true,
            resourceTypes: ["main_frame"]
          }
        };
      })
    ];
  });
}

// Compile the same main-frame policy once, then reuse it for in-page URL changes.
export function createNavigationCheck(rules) {
  const policy = rules.filter(rule => rule.condition.resourceTypes?.includes("main_frame"))
    .sort((a, b) => b.priority - a.priority)
    .map(rule => ({
      regex: new RegExp(rule.condition.regexFilter, rule.condition.isUrlFilterCaseSensitive ? "" : "i"),
      blocked: rule.action.type === "redirect" || rule.action.type === "block"
    }));
  return value => {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return policy.find(rule => rule.regex.test(url.href))?.blocked ?? false;
  };
}
