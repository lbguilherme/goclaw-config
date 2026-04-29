export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function safeFolderName(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const slug = slugify(candidate);
    if (slug) return slug;
  }
  return "unnamed";
}
