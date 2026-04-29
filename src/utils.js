const { FIELDS_SET, OPERATORS_SET } = require('./constants');

function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
}

function ruleMatch(channel, rule) {
  const value = channel[rule.field];
  if (value == null) return false;
  const target = String(value);
  const needle = rule.value;
  switch (rule.operator) {
    case 'contains': return target.toLowerCase().includes(needle.toLowerCase());
    case 'equals': return target.toLowerCase() === needle.toLowerCase();
    case 'starts_with': return target.toLowerCase().startsWith(needle.toLowerCase());
    case 'regex':
      try { return new RegExp(needle, 'i').test(target); } catch { return false; }
  }
  return false;
}

function parseRulesArray(rules, label = 'Filter') {
  if (!Array.isArray(rules)) throw new Error(`${label}: must be an array`);
  return rules.map((r, i) => {
    const field = String(r.field || '').trim();
    const operator = String(r.operator || '').trim();
    const value = String(r.value == null ? '' : r.value);
    if (!FIELDS_SET.has(field)) throw new Error(`${label} ${i + 1}: invalid field`);
    if (!OPERATORS_SET.has(operator)) throw new Error(`${label} ${i + 1}: invalid operator`);
    if (!value.length) throw new Error(`${label} ${i + 1}: empty value`);
    if (operator === 'regex') {
      try { new RegExp(value); } catch { throw new Error(`${label} ${i + 1}: invalid regex`); }
    }
    return { field, operator, value };
  });
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

function publicBaseUrl(req, configuredBase) {
  if (configuredBase) return configuredBase;
  const xfProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const xfHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const proto = (xfProto === 'http' || xfProto === 'https') ? xfProto : req.protocol;
  const host = xfHost || req.get('host');
  return `${proto}://${host}`;
}

module.exports = { slugify, ruleMatch, parseRulesArray, escapeXml, publicBaseUrl };
