// extension/shared/update-url.js
// The update banner only follows links from the GitHub release feed. Anything
// that is not an https github.com URL (or cannot be parsed) falls back to the
// releases page instead of injecting a hostile href. Shared by the service
// worker (which stores the URL) and the popup (which renders it) so the two
// allowlists cannot drift.
export const UPDATE_REPO = "xhang1108/opencode-usage";
export const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;

export function safeReleaseUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && (u.hostname === "github.com" || u.hostname === "www.github.com")) return u.href;
  } catch (e) {}
  return RELEASES_URL;
}
