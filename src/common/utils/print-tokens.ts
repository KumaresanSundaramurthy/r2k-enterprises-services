// Print-template helpers (CI3 print_helper.php), shared by every receipt / document that renders template HTML.

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function words(n: number): string {
  if (n === 0) return "";
  if (n < 20) return `${ONES[n]} `;
  if (n < 100) return `${TENS[Math.floor(n / 10)]} ${words(n % 10)}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} Hundred ${words(n % 100)}`;
  if (n < 100000) return `${words(Math.floor(n / 1000))}Thousand ${words(n % 1000)}`;
  if (n < 10000000) return `${words(Math.floor(n / 100000))}Lakh ${words(n % 100000)}`;
  return `${words(Math.floor(n / 10000000))}Crore ${words(n % 10000000)}`;
}

// print_number_to_words — Indian numbering: "One Thousand Two Hundred Rupees and Fifty Paise Only"
export function numberToWords(amount: number): string {
  const rupees = Math.trunc(amount);
  const paise = Math.round((amount - rupees) * 100);
  const rupeeWords = words(rupees).trim();
  let result = rupeeWords ? `${rupeeWords} Rupees` : "Zero Rupees";
  if (paise > 0) result += ` and ${words(paise).trim()} Paise`;
  return `${result} Only`;
}

const escapeHtmlAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#039;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// print_build_qr_html — a UPI payment QR (qrserver.com) with the organisation logo over its centre; "" without a UPI ID
export function buildQrHtml(upiId: string, amount: number, orgName: string, orgLogo = ""): string {
  if (!upiId) return "";
  const upi = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(orgName)}&am=${(Math.round(amount * 100) / 100).toFixed(2)}&cu=INR`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&ecc=H&data=${encodeURIComponent(upi)}`;
  const logo = orgLogo
    ? '<div class="qr-logo-overlay" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:38px;height:38px;' +
      `background:#fff;border-radius:4px;padding:3px;box-sizing:border-box;"><img src="${escapeHtmlAttr(orgLogo)}" style="width:100%;height:100%;object-fit:contain;"></div>`
    : "";
  return `<div style="position:relative;display:inline-block;line-height:0;"><img src="${qrUrl}" width="150" height="150">${logo}</div>`;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * print_apply_tokens — {{IF:TOKEN}}…{{/IF:TOKEN}} keeps its content when the token has a value and is removed
 * otherwise (unknown tokens count as empty); then every {{TOKEN}} is replaced.
 */
export function applyTokens(html: string, tokens: Record<string, string>): string {
  let out = html;
  for (const [tag, value] of Object.entries(tokens)) {
    const match = /^\{\{([A-Z0-9_]+)\}\}$/.exec(tag);
    if (!match) continue;
    const open = `{{IF:${match[1]}}}`;
    const close = `{{/IF:${match[1]}}}`;
    if (!out.includes(open)) continue;
    if (value.trim() !== "") out = out.split(open).join("").split(close).join("");
    else out = out.replace(new RegExp(`${escapeRegex(open)}[\\s\\S]*?${escapeRegex(close)}`, "g"), "");
  }
  if (out.includes("{{IF:")) out = out.replace(/\{\{IF:[A-Z0-9_]+\}\}[\s\S]*?\{\{\/IF:[A-Z0-9_]+\}\}/g, "");
  for (const [tag, value] of Object.entries(tokens)) out = out.split(tag).join(value);
  return out;
}
