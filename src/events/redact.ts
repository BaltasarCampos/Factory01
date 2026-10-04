// Secrets are removed from event text before it is written (data-model.md § Event). The
// patterns err towards redacting too much: a lost word in telemetry costs nothing, a leaked
// token in a repository costs a rotation.
const MASK = '[REDACTED]';

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, MASK);
  // `Authorization: Bearer <token>` and `token <token>`
  out = out.replace(/\b(Bearer|token)(\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, `$1$2${MASK}`);
  // `NAME=value` env assignments, as in `env` output or `GH_TOKEN=… gh …`: keep the name.
  out = out.replace(/\b([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s"']+)/g, `$1=${MASK}`);
  return out;
}
