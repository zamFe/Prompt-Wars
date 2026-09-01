// Loading a project .env, with the precedence made explicit.

import fs from 'node:fs';

/**
 * Parse dotenv-style text. Supports `KEY=value`, `export KEY=value`, comments,
 * blank lines, and quoted values (single or double). Returns entries in file
 * order so a later line wins over an earlier one, like a shell would.
 */
export function parseEnvFile(text) {
  const entries = new Map();

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2];
    } else {
      // An unquoted value ends at an inline comment.
      value = value.replace(/\s+#.*$/, '').trim();
    }
    entries.set(match[1], value);
  }
  return entries;
}

/**
 * Apply a .env over the process environment.
 *
 * The file wins. This is a local development server and the file was written
 * by hand for this project, so a stale shell variable quietly beating it is
 * the worse failure - it is exactly how a stub URL ends up pointed at the real
 * API. Every override is reported so nothing about it is silent.
 */
export function loadDotEnv(file, env = process.env) {
  if (!fs.existsSync(file)) return { loaded: false, set: [], overridden: [] };

  const entries = parseEnvFile(fs.readFileSync(file, 'utf8'));
  const set = [];
  const overridden = [];

  for (const [key, value] of entries) {
    if (key in env && env[key] !== value) overridden.push({ key, was: env[key], now: value });
    else set.push(key);
    env[key] = value;
  }
  return { loaded: true, set, overridden, count: entries.size };
}

/** Values that would leak a secret if printed. */
const SECRET = /KEY|TOKEN|SECRET|PASSWORD/i;
export const maskValue = (key, value) =>
  SECRET.test(key) ? `${String(value).slice(0, 4)}…` : value;
