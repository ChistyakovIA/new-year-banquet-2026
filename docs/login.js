export async function accountEmail(surname) {
  const login = surname.normalize("NFKC").trim().toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е").replace(/\s+/g, " ").replace(/[‐‑–]/g, "-");
  if (!login || login.length > 80) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(login));
  const alias = Array.from(new Uint8Array(digest).slice(0, 24), byte => byte.toString(16).padStart(2, "0")).join("");
  return alias + "@banquet-login.invalid";
}

export function loginPassword(value) {
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return value;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 11 && (digits[0] === "7" || (!trimmed.startsWith("+") && digits[0] === "8"))) {
    return digits.slice(1);
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : value;
}
