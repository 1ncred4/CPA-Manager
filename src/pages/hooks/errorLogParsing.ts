/**
 * Parse CLIProxyAPI request-error log filenames and file contents into structured fields.
 *
 * Filename forms:
 *   error-v1-messages-2026-01-10T021624-74ca64cc.log
 *   error-v1-chat-completions-2026-02-06T051701-3f60e5b3.log
 *   error-2024-05-20.log  (daily aggregate)
 *
 * Content sections typically look like:
 *   === REQUEST INFO ===
 *   === HEADERS ===
 *   === REQUEST BODY ===
 *   === RESPONSE === / === API RESPONSE ===
 */

export interface ParsedErrorLogFilename {
  rawName: string;
  path?: string;
  timestamp?: string;
  requestId?: string;
}

export interface ParsedErrorLogContent {
  path?: string;
  method?: string;
  model?: string;
  statusCode?: number;
  errorMessage?: string;
  requestId?: string;
  timestamp?: string;
}

export interface ErrorLogSummary extends ParsedErrorLogContent {
  rawName: string;
  fromFilename: ParsedErrorLogFilename;
}

const FILENAME_SUFFIX = '.log';
const ERROR_PREFIX = 'error-';
// Full token when not split: 2026-01-10T021624
const TIMESTAMP_TOKEN_REGEX = /^\d{4}-\d{2}-\d{2}T\d{6}$/;
// After split('-'): ['2026', '01', '10T021624']
const TIMESTAMP_YEAR_REGEX = /^\d{4}$/;
const TIMESTAMP_MONTH_REGEX = /^\d{2}$/;
const TIMESTAMP_DAY_TIME_REGEX = /^\d{2}T\d{6}$/;
const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_ID_REGEX = /^[a-f0-9]{6,32}$/i;
const SECTION_SPLIT_REGEX = /^===\s*([^=]+?)\s*===\s*$/gm;
const HTTP_STATUS_PATTERNS: RegExp[] = [
  /\bHTTP(?:\/[\d.]+)?\s+([1-5]\d{2})\b/i,
  /\bstatus(?:\s*code)?[:\s]+([1-5]\d{2})\b/i,
  /\b([1-5]\d{2})\s+(?:OK|Created|Accepted|No Content|Moved|Found|Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
  /^\s*([1-5]\d{2})\b/m,
];
const ERROR_MESSAGE_MAX = 200;

const formatFilenameTimestamp = (token: string): string => {
  // 2026-01-10T021624 → 2026-01-10 02:16:24
  const match = token.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return token;
  return `${match[1]} ${match[2]}:${match[3]}:${match[4]}`;
};

const pathFromSegments = (segments: string[]): string | undefined => {
  if (segments.length === 0) return undefined;
  // API paths almost always start with "v1" / "v0" / similar versioned prefixes.
  return `/${segments.join('/')}`;
};

export const parseErrorLogFilename = (name: string): ParsedErrorLogFilename => {
  const rawName = name.trim();
  const result: ParsedErrorLogFilename = { rawName };

  if (!rawName.toLowerCase().startsWith(ERROR_PREFIX) || !rawName.toLowerCase().endsWith(FILENAME_SUFFIX)) {
    return result;
  }

  // Strip "error-" prefix and ".log" suffix.
  const core = rawName.slice(ERROR_PREFIX.length, rawName.length - FILENAME_SUFFIX.length);
  if (!core) return result;

  // Daily aggregate: error-YYYY-MM-DD.log
  if (DAILY_DATE_REGEX.test(core)) {
    result.timestamp = core;
    return result;
  }

  const parts = core.split('-').filter(Boolean);
  if (parts.length < 2) return result;

  // Walk from the end: [..., path..., YYYY, MM, DDTHHMMSS, requestId]
  // Note: split('-') breaks "2026-01-10T021624" into ["2026","01","10T021624"].
  let requestId: string | undefined;
  let timestampToken: string | undefined;
  let pathEnd = parts.length;

  const last = parts[parts.length - 1];
  if (REQUEST_ID_REGEX.test(last)) {
    requestId = last;
    pathEnd = parts.length - 1;
  }

  // Prefer reassembled split timestamp: year-month-dayTime
  if (pathEnd >= 3) {
    const year = parts[pathEnd - 3];
    const month = parts[pathEnd - 2];
    const dayTime = parts[pathEnd - 1];
    if (
      TIMESTAMP_YEAR_REGEX.test(year) &&
      TIMESTAMP_MONTH_REGEX.test(month) &&
      TIMESTAMP_DAY_TIME_REGEX.test(dayTime)
    ) {
      timestampToken = `${year}-${month}-${dayTime}`;
      pathEnd -= 3;
    }
  }

  // Unsplit full token (defensive — normally '-' already split it).
  if (!timestampToken && pathEnd > 0) {
    const candidate = parts[pathEnd - 1];
    if (TIMESTAMP_TOKEN_REGEX.test(candidate)) {
      timestampToken = candidate;
      pathEnd -= 1;
    }
  }

  // Bare date: YYYY-MM-DD split into three parts, or single daily token.
  if (!timestampToken && pathEnd >= 3) {
    const year = parts[pathEnd - 3];
    const month = parts[pathEnd - 2];
    const day = parts[pathEnd - 1];
    if (
      TIMESTAMP_YEAR_REGEX.test(year) &&
      TIMESTAMP_MONTH_REGEX.test(month) &&
      /^\d{2}$/.test(day)
    ) {
      timestampToken = `${year}-${month}-${day}`;
      pathEnd -= 3;
    }
  }

  if (!timestampToken && pathEnd > 0 && DAILY_DATE_REGEX.test(parts[pathEnd - 1])) {
    timestampToken = parts[pathEnd - 1];
    pathEnd -= 1;
  }

  const pathSegments = parts.slice(0, pathEnd);
  const path = pathFromSegments(pathSegments);

  if (path) result.path = path;
  if (timestampToken) {
    result.timestamp = TIMESTAMP_TOKEN_REGEX.test(timestampToken)
      ? formatFilenameTimestamp(timestampToken)
      : timestampToken;
  }
  if (requestId) result.requestId = requestId;

  return result;
};

const splitSections = (text: string): Record<string, string> => {
  const sections: Record<string, string> = {};
  const matches = [...text.matchAll(SECTION_SPLIT_REGEX)];
  if (matches.length === 0) {
    sections[''] = text;
    return sections;
  }

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const name = match[1].trim().toUpperCase();
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    sections[name] = text.slice(start, end).trim();
  }
  return sections;
};

const findSection = (sections: Record<string, string>, ...names: string[]): string | undefined => {
  for (const name of names) {
    const key = name.toUpperCase();
    if (sections[key]) return sections[key];
  }
  // Fuzzy: allow partial key match (e.g. "API RESPONSE" vs "RESPONSE")
  const keys = Object.keys(sections);
  for (const name of names) {
    const upper = name.toUpperCase();
    const hit = keys.find((key) => key.includes(upper));
    if (hit && sections[hit]) return sections[hit];
  }
  return undefined;
};

const extractField = (block: string, field: string): string | undefined => {
  const regex = new RegExp(`^\\s*${field}\\s*[:=]\\s*(.+?)\\s*$`, 'im');
  const match = block.match(regex);
  return match?.[1]?.trim() || undefined;
};

const tryParseJson = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Prefer the first {...} / [...] block if the section has a prologue.
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const start =
    objectStart >= 0 && arrayStart >= 0
      ? Math.min(objectStart, arrayStart)
      : Math.max(objectStart, arrayStart);

  const candidates = start >= 0 ? [trimmed.slice(start), trimmed] : [trimmed];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const extractModelFromBody = (body: unknown): string | undefined => {
  if (!isRecord(body)) return undefined;
  const candidates = [body.model, body.model_name, body.modelName];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // Nested OpenAI-compat variants
  if (isRecord(body.params)) {
    const nested = extractModelFromBody(body.params);
    if (nested) return nested;
  }
  return undefined;
};

const extractStatusCode = (text: string): number | undefined => {
  for (const pattern of HTTP_STATUS_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const code = Number.parseInt(match[1], 10);
    if (Number.isFinite(code) && code >= 100 && code <= 599) return code;
  }
  return undefined;
};

const digErrorMessage = (value: unknown, depth = 0): string | undefined => {
  if (depth > 4 || value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = digErrorMessage(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  const preferredKeys = ['message', 'error', 'detail', 'details', 'msg', 'reason', 'description'];
  for (const key of preferredKeys) {
    if (!(key in value)) continue;
    const found = digErrorMessage(value[key], depth + 1);
    if (found) return found;
  }

  // Anthropic-style { type, error: { type, message } } already covered via "error".
  // OpenAI-style { error: { message, type, code } } too.
  return undefined;
};

const truncateMessage = (message: string, max = ERROR_MESSAGE_MAX): string => {
  const compact = message.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
};

const firstNonEmptyLine = (text: string): string | undefined => {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip pure status/header lines we already use elsewhere.
    if (/^HTTP(?:\/[\d.]+)?\s+[1-5]\d{2}\b/i.test(trimmed)) continue;
    if (/^status(?:\s*code)?[:\s]+[1-5]\d{2}\b/i.test(trimmed)) continue;
    if (/^[1-5]\d{2}$/.test(trimmed)) continue;
    return trimmed;
  }
  return undefined;
};

export const parseErrorLogContent = (text: string): ParsedErrorLogContent => {
  const result: ParsedErrorLogContent = {};
  if (!text || !text.trim()) return result;

  const sections = splitSections(text);

  const requestInfo = findSection(sections, 'REQUEST INFO', 'REQUEST');
  if (requestInfo) {
    const url = extractField(requestInfo, 'URL') || extractField(requestInfo, 'Path');
    if (url) {
      // URL may be absolute; prefer the path portion when possible.
      try {
        if (/^https?:\/\//i.test(url)) {
          result.path = new URL(url).pathname || url;
        } else {
          result.path = url.split('?')[0] || url;
        }
      } catch {
        result.path = url;
      }
    }
    const method = extractField(requestInfo, 'Method');
    if (method) result.method = method.toUpperCase();
    const timestamp =
      extractField(requestInfo, 'Timestamp') ||
      extractField(requestInfo, 'Time') ||
      extractField(requestInfo, 'Date');
    if (timestamp) result.timestamp = timestamp;
    const requestId =
      extractField(requestInfo, 'Request-ID') ||
      extractField(requestInfo, 'Request ID') ||
      extractField(requestInfo, 'RequestId') ||
      extractField(requestInfo, 'request_id');
    if (requestId) result.requestId = requestId;
  }

  const requestBody = findSection(sections, 'REQUEST BODY', 'BODY', 'REQUEST PAYLOAD');
  if (requestBody) {
    const parsedBody = tryParseJson(requestBody);
    const model = extractModelFromBody(parsedBody);
    if (model) result.model = model;
  }

  const response =
    findSection(sections, 'API RESPONSE', 'RESPONSE', 'RESPONSE BODY', 'ERROR RESPONSE') ||
    // Fallback: scan whole text if section headers are missing
    undefined;

  const responseText = response ?? (Object.keys(sections).length <= 1 ? text : '');
  if (responseText) {
    const statusCode = extractStatusCode(responseText);
    if (statusCode !== undefined) result.statusCode = statusCode;

    const parsedResponse = tryParseJson(responseText);
    let errorMessage = digErrorMessage(parsedResponse);
    if (!errorMessage) {
      errorMessage = firstNonEmptyLine(responseText);
    }
    if (errorMessage) result.errorMessage = truncateMessage(errorMessage);
  }

  // If no dedicated response section yielded a status, try scanning whole file.
  if (result.statusCode === undefined) {
    const statusCode = extractStatusCode(text);
    if (statusCode !== undefined) result.statusCode = statusCode;
  }

  // Last-resort model scan if body section wasn't present as JSON.
  if (!result.model) {
    const modelMatch = text.match(/"model"\s*:\s*"([^"\\]+)"/);
    if (modelMatch?.[1]) result.model = modelMatch[1];
  }

  return result;
};

export const buildErrorLogSummary = (
  name: string,
  content?: string | null
): ErrorLogSummary => {
  const fromFilename = parseErrorLogFilename(name);
  const fromContent = content ? parseErrorLogContent(content) : {};

  return {
    rawName: name,
    fromFilename,
    path: fromContent.path || fromFilename.path,
    method: fromContent.method,
    model: fromContent.model,
    statusCode: fromContent.statusCode,
    errorMessage: fromContent.errorMessage,
    requestId: fromFilename.requestId || fromContent.requestId,
    timestamp: fromContent.timestamp || fromFilename.timestamp,
  };
};
