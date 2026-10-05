// Output helpers that scrub registered secrets from everything written to the console or to disk.

const secretPatterns = [];

/** Register a secret so any later occurrence (with or without 0x, any case) prints as [REDACTED]. */
export function registerSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) return;
  const bare = secret.startsWith('0x') || secret.startsWith('0X') ? secret.slice(2) : secret;
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  secretPatterns.push(new RegExp(`(0x)?${escaped}`, 'gi'));
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  } catch {
    return String(value);
  }
}

export function redact(value) {
  let text = stringify(value);
  for (const pattern of secretPatterns) text = text.replace(pattern, '[REDACTED]');
  return text;
}

/** Route every console method and uncaught error through redact(). */
export function installRedaction() {
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(...args.map(redact));
  }
  const crash = (err) => {
    console.error(`Fatal: ${redact(err?.shortMessage || err?.message || err)}`);
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
}

/** Short, single-line description of an ethers/RPC error (never includes signer material). */
export function describeError(err) {
  const parts = [];
  const msg = err?.shortMessage || err?.message || String(err);
  parts.push(msg.split('\n')[0]);
  if (err?.reason && !msg.includes(err.reason)) parts.push(`reason: ${err.reason}`);
  if (err?.receipt?.hash) parts.push(`tx: ${err.receipt.hash}`);
  return redact(parts.join(' | ')).slice(0, 500);
}
