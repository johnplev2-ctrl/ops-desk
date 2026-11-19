// Builds the six bundled sample proof photos as SVG illustrations (deterministic, no external assets).
// Run: node scripts/make-photos.mjs  → public/photos/p1.svg … p6.svg
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "photos");
mkdirSync(out, { recursive: true });

const frame = (title, bg, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" role="img" aria-labelledby="t">
<title id="t">${title}</title>
<rect width="400" height="300" fill="${bg}"/>
${body}
<rect x="0.5" y="0.5" width="399" height="299" fill="none" stroke="#000" stroke-opacity=".12"/>
</svg>
`;

const tiles = (color, line) => {
  let s = `<rect width="400" height="190" fill="${color}"/>`;
  for (let x = 0; x <= 400; x += 50) s += `<line x1="${x}" y1="0" x2="${x}" y2="190" stroke="${line}" stroke-width="2"/>`;
  for (let y = 0; y <= 190; y += 38) s += `<line x1="0" y1="${y}" x2="400" y2="${y}" stroke="${line}" stroke-width="2"/>`;
  return s;
};

const photos = {
  p1: frame(
    "Sample photo: tap after the repair, no drips",
    "#dfe7ec",
    `${tiles("#eef3f6", "#cfdbe3")}
<rect x="0" y="190" width="400" height="110" fill="#9aa9b4"/>
<path d="M70 196 h260 l-22 70 h-216 z" fill="#c9d3da" stroke="#6f7f8b" stroke-width="3"/>
<ellipse cx="200" cy="214" rx="104" ry="12" fill="#b5c1ca"/>
<circle cx="200" cy="228" r="7" fill="#5d6b76"/>
<rect x="186" y="96" width="28" height="60" rx="6" fill="#b8c4cc" stroke="#55636e" stroke-width="3"/>
<path d="M200 104 h62 a14 14 0 0 1 14 14 v22" fill="none" stroke="#55636e" stroke-width="16" stroke-linecap="round"/>
<path d="M200 104 h62 a14 14 0 0 1 14 14 v22" fill="none" stroke="#c3ced6" stroke-width="9" stroke-linecap="round"/>
<rect x="168" y="82" width="64" height="14" rx="7" fill="#55636e"/>
<circle cx="276" cy="168" r="9" fill="none" stroke="#2f7a52" stroke-width="3"/>
<path d="M271 168 l4 4 l7 -8" fill="none" stroke="#2f7a52" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  p2: frame(
    "Sample photo: flour delivery checked in on the storeroom shelf",
    "#e9e2d6",
    `<rect x="20" y="70" width="360" height="12" fill="#8a6a48"/>
<rect x="20" y="210" width="360" height="12" fill="#8a6a48"/>
<rect x="28" y="82" width="10" height="200" fill="#6f5338"/><rect x="362" y="82" width="10" height="200" fill="#6f5338"/>
${[0, 1, 2].map((i) => `<g transform="translate(${60 + i * 98} 112)"><path d="M6 0 h72 q8 0 8 10 v78 q0 10 -10 10 h-68 q-10 0 -10 -10 v-78 q0 -10 8 -10z" fill="#f4efe4" stroke="#b9a988" stroke-width="3"/><rect x="18" y="34" width="50" height="26" fill="#fff" stroke="#b9a988" stroke-width="2"/><text x="43" y="52" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="700" fill="#5a4a33">25 kg</text></g>`).join("")}
<rect x="250" y="236" width="110" height="46" fill="#c79b5e" stroke="#8a6a48" stroke-width="3"/>
<rect x="268" y="248" width="74" height="22" fill="#f6efe0"/>
<path d="M290 259 l6 6 l12 -12" fill="none" stroke="#2f7a52" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  p3: frame(
    "Sample photo: new LED tube fitted in the storeroom ceiling",
    "#3b4650",
    `<rect width="400" height="70" fill="#56626c"/>
<path d="M0 70 L120 300 H0z" fill="#46525c"/><path d="M400 70 L280 300 H400z" fill="#46525c"/>
<path d="M90 92 L20 300 H380 L310 92z" fill="#fff6d6" opacity=".22"/>
<rect x="80" y="70" width="240" height="14" fill="#9aa6b0"/>
<rect x="90" y="84" width="220" height="18" rx="9" fill="#fffbe9"/>
<rect x="90" y="84" width="220" height="18" rx="9" fill="none" stroke="#e8dca8" stroke-width="2"/>
<rect x="40" y="200" width="90" height="100" fill="#6b5a46"/><rect x="270" y="190" width="100" height="110" fill="#6b5a46"/>
<rect x="48" y="210" width="74" height="30" fill="#c9b48e"/><rect x="280" y="200" width="80" height="34" fill="#d8c7a4"/>`,
  ),
  p4: frame(
    "Sample photo: espresso machine after a deep clean",
    "#e7e3df",
    `<rect x="0" y="232" width="400" height="68" fill="#7d6a5a"/>
<rect x="70" y="60" width="260" height="150" rx="12" fill="#c8ced3" stroke="#5f6870" stroke-width="3"/>
<rect x="70" y="60" width="260" height="34" rx="12" fill="#a9b2b9"/>
<path d="M92 76 h216" stroke="#eef2f5" stroke-width="5" stroke-linecap="round"/>
${[0, 1].map((i) => `<g transform="translate(${120 + i * 120} 128)"><rect x="-26" y="0" width="52" height="22" rx="5" fill="#59636b"/><rect x="-40" y="22" width="80" height="12" rx="6" fill="#2f363c"/><rect x="34" y="24" width="44" height="8" rx="4" fill="#2f363c"/></g>`).join("")}
<rect x="60" y="210" width="280" height="22" rx="4" fill="#8d979e" stroke="#5f6870" stroke-width="3"/>
<path d="M300 120 q24 0 24 30 v40" fill="none" stroke="#5f6870" stroke-width="6" stroke-linecap="round"/>
<path d="M150 98 l18 -14 M250 98 l18 -14" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity=".9"/>`,
  ),
  p5: frame(
    "Sample photo: twenty receipt paper rolls stocked under the till",
    "#d9dee2",
    `<rect x="40" y="120" width="320" height="150" fill="#b98f5c" stroke="#7a5a34" stroke-width="3"/>
<rect x="40" y="120" width="320" height="22" fill="#a37b4a"/>
${Array.from({ length: 10 }, (_, i) => {
  const x = 78 + (i % 5) * 61;
  const y = i < 5 ? 176 : 232;
  return `<circle cx="${x}" cy="${y}" r="26" fill="#fbfbf8" stroke="#a7aaa8" stroke-width="2"/><circle cx="${x}" cy="${y}" r="9" fill="#d8d2c4" stroke="#a7aaa8" stroke-width="2"/>`;
}).join("")}
<rect x="250" y="40" width="110" height="64" rx="6" fill="#4b5560"/><rect x="262" y="52" width="86" height="26" fill="#9fd3b0"/>`,
  ),
  p6: frame(
    "Sample photo: window table fixed, spirit level reads level",
    "#e8e4dc",
    `<rect x="0" y="0" width="400" height="150" fill="#cfe0ea"/>
<rect x="30" y="20" width="160" height="120" fill="#e9f2f7" stroke="#8aa1b0" stroke-width="6"/><rect x="210" y="20" width="160" height="120" fill="#e9f2f7" stroke="#8aa1b0" stroke-width="6"/>
<rect x="0" y="150" width="400" height="150" fill="#b79d7f"/>
<rect x="60" y="150" width="280" height="20" rx="3" fill="#8b6a48"/>
<rect x="84" y="170" width="16" height="110" fill="#6e5236"/><rect x="300" y="170" width="16" height="110" fill="#6e5236"/>
<rect x="296" y="276" width="24" height="6" rx="2" fill="#3c3c3c"/>
<rect x="130" y="128" width="140" height="22" rx="4" fill="#f2c94c" stroke="#a2852c" stroke-width="2"/>
<rect x="182" y="132" width="36" height="14" rx="7" fill="#d7f0c8" stroke="#6f8f5a" stroke-width="2"/>
<circle cx="200" cy="139" r="4.5" fill="#ffffff" stroke="#6f8f5a" stroke-width="1.5"/>
<line x1="192" y1="132" x2="192" y2="146" stroke="#6f8f5a" stroke-width="1.5"/><line x1="208" y1="132" x2="208" y2="146" stroke="#6f8f5a" stroke-width="1.5"/>`,
  ),
};

for (const [id, svg] of Object.entries(photos)) writeFileSync(join(out, `${id}.svg`), svg);
console.log(`wrote ${Object.keys(photos).length} photos to ${out}`);
