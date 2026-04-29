const QUALITY_TOKENS = ['UHD', '4K', 'FHD', 'HD', 'SD', 'H265', 'HEVC'];
const QUALITY_REGEX = /\b(UHD|4K|FHD|HD|SD|H265|HEVC)\b/i;
const QUALITY_STRIP_REGEX = /\b(UHD|4K|FHD|HD|SD|H265|HEVC)\b/gi;
const SPECIAL_CHARS_REGEX = /[,\-()\[\]]/g;

function detectQuality(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const m = String(c).match(QUALITY_REGEX);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function stripSpecials(s) {
  return String(s).replace(SPECIAL_CHARS_REGEX, ' ').replace(/\s+/g, ' ').trim();
}

function applyCase(s, mode) {
  if (!s) return s;
  switch (mode) {
    case 'upper': return s.toLocaleUpperCase('pt-BR');
    case 'lower': return s.toLocaleLowerCase('pt-BR');
    case 'capital':
      return s.toLocaleLowerCase('pt-BR').replace(/(^|\s|[,\-()\[\]/])([\p{L}\p{N}])/gu, (_, sep, ch) => sep + ch.toLocaleUpperCase('pt-BR'));
    default: return s;
  }
}

function normalizeDisplayName(name, opts) {
  if (!name) return name;
  let out = String(name);
  if (opts.stripSpecials) out = stripSpecials(out);
  out = applyCase(out, opts.caseMode || 'none');
  return out.trim() || null;
}

function epgNormalize(name) {
  if (!name) return '';
  let s = String(name);
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(QUALITY_STRIP_REGEX, ' ');
  s = s.replace(SPECIAL_CHARS_REGEX, ' ');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.toLowerCase();
  s = s.replace(/\s+/g, '').trim();
  return s;
}

const TOKEN_STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'la', 'le', 'tv']);

const QUALITY_TOKENS_LOWER = new Set(QUALITY_TOKENS.map(t => t.toLowerCase()));

function epgTokens(name) {
  if (!name) return [];
  let s = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.toLowerCase();
  const parts = s.split(/\s+/)
    .filter(Boolean)
    .filter(t => !TOKEN_STOPWORDS.has(t) && !QUALITY_TOKENS_LOWER.has(t));
  return Array.from(new Set(parts));
}

function epgQuality(name) {
  if (!name) return null;
  const m = String(name).match(QUALITY_REGEX);
  return m ? m[1].toUpperCase() : null;
}

module.exports = {
  QUALITY_TOKENS,
  QUALITY_REGEX,
  detectQuality,
  stripSpecials,
  applyCase,
  normalizeDisplayName,
  epgNormalize,
  epgTokens,
  epgQuality,
};
