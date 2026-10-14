export function idFromText(text) {
  const clean = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  return clean || "task";
}

export function plistEscape(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function scriptQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
