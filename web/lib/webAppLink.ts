/**
 * Where a share page's "Open in web app" goes. The web app (/app) mirrors
 * the share pages' paths, so /c/<id> opens /app/c/<id>, /u/<handle>
 * /app/u/<handle> and /m/<id> /app/m/<id>. Null when the deploy names no web
 * app (NEXT_PUBLIC_WEB_APP_URL unset). Pure; tested in the BFF repo.
 */
export function webAppHref(base: string | null | undefined, kind: "c" | "u" | "m", id: string): string | null {
  const root = base?.trim().replace(/\/+$/, "");
  if (!root) return null;
  // Only a same-site path or an http(s) URL: never a javascript: or other scheme.
  if (!root.startsWith("/") && !/^https?:\/\//i.test(root)) return null;
  if (root.startsWith("//")) return null;
  return `${root}/${kind}/${encodeURIComponent(id.replace(/^@+/, ""))}`;
}
