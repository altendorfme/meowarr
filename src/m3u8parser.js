const ATTR_REGEX = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

function parseExtinf(line) {
  const body = line.slice(line.indexOf(':') + 1);
  const commaIdx = findAttrsCommaEnd(body);
  const attrsPart = commaIdx >= 0 ? body.slice(0, commaIdx) : body;
  const displayName = commaIdx >= 0 ? body.slice(commaIdx + 1).trim() : '';

  const spaceIdx = attrsPart.indexOf(' ');
  const duration = spaceIdx >= 0 ? attrsPart.slice(0, spaceIdx).trim() : attrsPart.trim();
  const attrsStr = spaceIdx >= 0 ? attrsPart.slice(spaceIdx + 1) : '';

  const attrs = {};
  let m;
  ATTR_REGEX.lastIndex = 0;
  while ((m = ATTR_REGEX.exec(attrsStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return { duration: duration || '-1', attrs, displayName };
}

function findAttrsCommaEnd(body) {
  let inQuote = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) return i;
  }
  return -1;
}

function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  let hasHeader = false;
  let hasExtinf = false;
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith('#EXTM3U')) hasHeader = true;
    else if (t.startsWith('#EXTINF')) { hasExtinf = true; break; }
  }
  if (!hasHeader && !hasExtinf) {
    throw new Error('not a valid M3U playlist (no #EXTM3U header and no #EXTINF entries)');
  }

  const channels = [];
  let pending = null;
  let extras = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF')) {
      pending = parseExtinf(line);
      extras = [];
      continue;
    }
    if (line.startsWith('#')) {
      if (pending) extras.push(line);
      continue;
    }
    if (pending) {
      const { attrs, displayName, duration } = pending;
      channels.push({
        tvg_id: attrs['tvg-id'] || null,
        tvg_name: attrs['tvg-name'] || null,
        tvg_logo: attrs['tvg-logo'] || null,
        group_title: attrs['group-title'] || null,
        display_name: displayName || null,
        url: line,
        raw_attrs: JSON.stringify(attrs),
        extra_lines: extras.length ? extras.join('\n') : null,
        duration,
      });
      pending = null;
      extras = [];
    }
  }
  return channels;
}

function escapeAttr(v) {
  if (v == null) return '';
  return String(v)
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

function serializeChannel(c) {
  const attrs = [];
  if (c.tvg_id) attrs.push(`tvg-id="${escapeAttr(c.tvg_id)}"`);
  if (c.tvg_name) attrs.push(`tvg-name="${escapeAttr(c.tvg_name)}"`);
  if (c.tvg_logo) attrs.push(`tvg-logo="${escapeAttr(c.tvg_logo)}"`);
  if (c.group_title) attrs.push(`group-title="${escapeAttr(c.group_title)}"`);
  const duration = c.duration || '-1';
  const attrsStr = attrs.length ? ' ' + attrs.join(' ') : '';
  const display = (c.display_name || c.tvg_name || '').replace(/[\r\n]+/g, ' ');
  let line = `#EXTINF:${duration}${attrsStr},${display}\n`;
  if (c.extra_lines) line += c.extra_lines + '\n';
  line += c.url + '\n';
  return line;
}

function buildM3U(channels) {
  let out = '#EXTM3U\n';
  for (const c of channels) out += serializeChannel(c);
  return out;
}

const fs = require('fs');

async function streamM3UToFile(channels, file, opts) {
  const { onChunk, chunkSize } = opts || {};
  const CHUNK = chunkSize || 2000;
  const tmp = `${file}.tmp`;
  const stream = fs.createWriteStream(tmp, { encoding: 'utf8' });
  const writeStr = (s) => new Promise((resolve, reject) => {
    if (stream.write(s)) resolve();
    else stream.once('drain', resolve);
    stream.once('error', reject);
  });
  try {
    await writeStr('#EXTM3U\n');
    let buf = '';
    for (let i = 0; i < channels.length; i++) {
      buf += serializeChannel(channels[i]);
      if ((i + 1) % CHUNK === 0) {
        await writeStr(buf);
        buf = '';
        if (onChunk) await onChunk(i + 1, channels.length);
      }
    }
    if (buf.length) await writeStr(buf);
    await new Promise((resolve, reject) => stream.end(err => err ? reject(err) : resolve()));
  } catch (err) {
    try { stream.destroy(); } catch (_) { /* noop */ }
    try { fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    throw err;
  }
  fs.renameSync(tmp, file);
  if (onChunk) await onChunk(channels.length, channels.length);
}

module.exports = { parseM3U, buildM3U, streamM3UToFile, serializeChannel, escapeAttr };
