const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIST_DIR = path.join(__dirname, '..', 'public', 'dist');

function hashFile(rel) {
  const abs = path.join(DIST_DIR, rel);
  try {
    const buf = fs.readFileSync(abs);
    return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  } catch {
    return String(Date.now());
  }
}

const versions = {
  appCss: hashFile('app.css'),
  appJs: hashFile('app.js'),
  bootstrapJs: hashFile('vendor/bootstrap.bundle.min.js'),
};

function url(rel, version) {
  return `/static/dist/${rel}?v=${version}`;
}

module.exports = {
  versions,
  appCss: url('app.css', versions.appCss),
  appJs: url('app.js', versions.appJs),
  bootstrapJs: url('vendor/bootstrap.bundle.min.js', versions.bootstrapJs),
};
