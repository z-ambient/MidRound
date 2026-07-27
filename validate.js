// MidRound — small request-body validation helpers.
//
// Each helper returns an error message (a string) when the value is invalid,
// or null when it is fine. Routes collect checks with firstError(...) and
// answer 400 with the message. Keeping the checks tiny and explicit beats a
// validation framework for a codebase this size.

function requiredString(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) return `${label} is required`;
  if (value.length > max) return `${label} must be at most ${max} characters`;
  return null;
}

// Missing/null is fine; when present it must be a string within the cap.
function optionalString(value, label, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return `${label} must be text`;
  if (value.length > max) return `${label} must be at most ${max} characters`;
  return null;
}

function oneOf(value, label, allowed) {
  if (!allowed.includes(value)) return `${label} must be one of: ${allowed.join(', ')}`;
  return null;
}

// Missing/null is fine; when present it must be in the allowed list.
function optionalOneOf(value, label, allowed) {
  if (value === undefined || value === null || value === '') return null;
  return oneOf(value, label, allowed);
}

// A database id: a positive integer (or numeric string).
function idNumber(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return `${label} must be a valid id`;
  return null;
}

function optionalIdNumber(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return idNumber(value, label);
}

function stringArray(value, label, { maxItems = 50, maxLen = 1000 } = {}) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return `${label} must be a list`;
  if (value.length > maxItems) return `${label} can have at most ${maxItems} entries`;
  for (const item of value) {
    if (typeof item !== 'string') return `${label} entries must be text`;
    if (item.length > maxLen) return `${label} entries must be at most ${maxLen} characters`;
  }
  return null;
}

function numberArray(value, label, { maxItems = 50 } = {}) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return `${label} must be a list`;
  if (value.length > maxItems) return `${label} can have at most ${maxItems} entries`;
  for (const item of value) {
    if (!Number.isInteger(Number(item)) || Number(item) <= 0) return `${label} entries must be ids`;
  }
  return null;
}

// Structured arrays (e.g. strategy roles) — bound the item count and the
// serialized size so a client can't stuff megabytes into one JSON column.
function objectArray(value, label, { maxItems = 50, maxJson = 20_000 } = {}) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return `${label} must be a list`;
  if (value.length > maxItems) return `${label} can have at most ${maxItems} entries`;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return `${label} contains invalid data`;
  }
  if (json.length > maxJson) return `${label} is too large`;
  return null;
}

// Only plain web links are allowed as attachment URLs. HTML-escaping is not
// enough for URLs: an href of "javascript:..." is perfectly valid HTML after
// escaping and still runs script when clicked, so the scheme itself must be
// whitelisted.
function safeUrl(url) {
  return /^https?:\/\//i.test(String(url).trim());
}

// Attachments: a list of { type, url, label } objects with http(s) URLs.
function attachmentList(value, { maxItems = 20 } = {}) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return 'Attachments must be a list';
  if (value.length > maxItems) return `Attachments can have at most ${maxItems} entries`;
  for (const a of value) {
    if (typeof a !== 'object' || a === null || Array.isArray(a)) {
      return 'Each attachment must have a url and an optional type/label';
    }
    const err =
      requiredString(a.url, 'Attachment URL', 500) ||
      optionalString(a.type, 'Attachment type', 30) ||
      optionalString(a.label, 'Attachment label', 200);
    if (err) return err;
    if (!safeUrl(a.url)) return 'Attachment URLs must start with http:// or https://';
  }
  return null;
}

// firstError(a, b, c) -> the first check that failed, or null. Falsy entries
// (false/undefined from conditional checks) are skipped, so routes can write:
//   firstError(hasName && requiredString(...), optionalString(...))
function firstError(...checks) {
  for (const err of checks) {
    if (typeof err === 'string') return err;
  }
  return null;
}

module.exports = {
  requiredString,
  optionalString,
  oneOf,
  optionalOneOf,
  idNumber,
  optionalIdNumber,
  stringArray,
  numberArray,
  objectArray,
  safeUrl,
  attachmentList,
  firstError,
};
