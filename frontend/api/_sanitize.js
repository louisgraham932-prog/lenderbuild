/**
 * Input sanitization utilities — strip HTML tags and dangerous characters
 * from user-supplied strings before persisting to the database.
 */

/**
 * Sanitize a single string value.
 * - Strips all HTML tags (prevents stored XSS)
 * - Strips C0/C1 control characters (keeps \n, \r, \t for legitimate multi-line text)
 * - Trims surrounding whitespace
 * - Enforces a maximum length
 */
function sanitizeStr(val, maxLen = 2000) {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/<[^>]*>/g, "")                       // strip HTML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // strip control chars
    .trim()
    .slice(0, maxLen);
}

/**
 * Sanitize all string fields in a plain object.
 * Non-string values (numbers, booleans, arrays) are left untouched.
 *
 * @param {object} obj         The raw request body object
 * @param {object} fieldLimits Optional map of { fieldName: maxLength }
 */
function sanitizeBody(obj, fieldLimits = {}) {
  if (!obj || typeof obj !== "object") return {};
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "string") {
      result[key] = sanitizeStr(val, fieldLimits[key] ?? 2000);
    } else {
      result[key] = val;
    }
  }
  return result;
}

module.exports = { sanitizeStr, sanitizeBody };
