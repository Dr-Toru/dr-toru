export function normalizeSearchText(value: string): string {
  const lowered = value.toLowerCase().trim();
  if (!lowered) {
    return "";
  }
  return lowered.split(/\s+/u).join(" ");
}
