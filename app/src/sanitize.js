const SAFE_BITMAP_DATA_URL_RE =
  /^data:image\/(?:png|jpeg|jpg|webp|gif|bmp);base64,[A-Za-z0-9+/=\s]+$/i;

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isImageAvatar(val) {
  if (typeof val !== 'string') return false;
  return SAFE_BITMAP_DATA_URL_RE.test(val.trim());
}

function generateNonce(avoidText) {
  const mk = () => {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
        const buf = new Uint32Array(3);
        globalThis.crypto.getRandomValues(buf);
        return Array.from(buf, (n) => n.toString(16).padStart(8, '0')).join('');
      }
    } catch {
      // fallback below
    }
    return (
      Math.random().toString(16).slice(2) +
      Math.random().toString(16).slice(2) +
      Date.now().toString(16)
    );
  };
  let nonce = mk();
  while (avoidText.includes(nonce)) {
    nonce = mk();
  }
  return nonce;
}

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function renderMarkdown(md) {
  if (!md) return '';
  const safeInput = esc(md);
  const nonce = generateNonce(safeInput);
  const blocks = [];
  const safe = safeInput.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre><code>${code}</code></pre>`);
    return `SD_BLK_${nonce}_${idx}_END`;
  });
  const lines = safe.split(/\r?\n/);
  const out = [];
  let inList = false;
  for (const line of lines) {
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inlineMd(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (/^###\s+/.test(line)) out.push(`<h3>${inlineMd(line.slice(4))}</h3>`);
    else if (/^##\s+/.test(line)) out.push(`<h2>${inlineMd(line.slice(3))}</h2>`);
    else if (/^#\s+/.test(line)) out.push(`<h1>${inlineMd(line.slice(2))}</h1>`);
    else if (line.trim() !== '') out.push(`<p>${inlineMd(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  const restoreRe = new RegExp(`SD_BLK_${nonce}_(\\d+)_END`, 'g');
  return out.join('').replace(restoreRe, (_, i) => blocks[Number(i)] || '');
}
