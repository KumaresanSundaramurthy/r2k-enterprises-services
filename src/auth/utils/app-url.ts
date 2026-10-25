// Links in emails and OAuth redirects point at the web app (CI3's base_url), not at this API.
export function appUrl(path = ""): string {
  const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/${path.replace(/^\/+/, "")}`;
}

export function apiUrl(path = ""): string {
  const base = (process.env.API_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 5000}`).replace(
    /\/+$/,
    ""
  );
  return `${base}/${path.replace(/^\/+/, "")}`;
}
