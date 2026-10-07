// =============================================================================
// Log line parser (v0.5.2).
// =============================================================================
//
// Parses a raw log line into a normalized shape for the Logs terminal view.
//
// Rules (apply in order, fall through on no-match):
//   1. JSON-line lines (start with `{` or `[`) — JSON.parse, then pull common
//      fields (ts/timestamp/time, level/severity, category/source, msg, and —
//      for admin audit lines — method/path/status).
//   2. Plain text with a leading ISO-ish timestamp at the start of the line.
//   3. Plain text with a timestamp embedded later in the message body.
//   4. Lines containing "[w3log]" — strip from rendered message (keep raw).
//   5. Missing timestamp → carry forward the previous parsed line's timestamp.
//   6. Missing category → opts.selectedCategory ?? opts.fallbackCategory.
//   7. Missing level → "INFO".
//   8. Level inference from message words (only when level is missing).
//
// Robust + graceful: never throws. Malformed lines render with
// category=SYSTEM, level=INFO, message=raw.

export interface ParsedLogLine {
  timestamp: string | null;
  category: string;
  level: string;
  message: string;
  raw: string;
  method?: string;
  path?: string;
  status?: number;
}

const TS_LEADING_RE =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
const TS_EMBEDDED_RE =
  /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

const KNOWN_CATEGORIES = new Set([
  'INFO',
  'SUCCESS',
  'WARN',
  'ERROR',
  'DEPLOY',
  'BACKUP',
  'SECURITY',
  'DATABASE',
  'SYSTEM',
  'GITHUB',
  'PACKAGE',
  'AUTH'
]);

function inferLevel(message: string): string {
  const m = message.toLowerCase();
  if (/\b(error|failed|failure|exception|fatal)\b/.test(m)) return 'ERROR';
  if (/\b(warn|warning)\b/.test(m)) return 'WARN';
  if (/\b(complete|completed|success|succeeded|finished|done|ok)\b/.test(m)) return 'SUCCESS';
  if (/\b(debug|trace)\b/.test(m)) return 'DEBUG';
  return 'INFO';
}

function normalizeLevel(raw: string): string {
  const v = raw.trim().toUpperCase();
  if (v === 'FATAL') return 'ERROR';
  if (v === 'WARNING') return 'WARN';
  if (v === 'OK') return 'SUCCESS';
  if (v === 'TRACE') return 'DEBUG';
  if (v === '') return '';
  return v;
}

function classifyCategoryFromText(text: string): string {
  const hay = text.toLowerCase();
  if (hay.includes('deploy')) return 'DEPLOY';
  if (hay.includes('backup') || hay.includes('restore')) return 'BACKUP';
  if (hay.includes('security') || hay.includes('forbidden') || hay.includes('denied'))
    return 'SECURITY';
  if (hay.includes('database') || hay.includes('postgres') || hay.includes(' db ')) return 'DATABASE';
  if (hay.includes('github') || hay.includes(' git ')) return 'GITHUB';
  if (hay.includes('package') || hay.includes('.tar.gz')) return 'PACKAGE';
  if (hay.includes('auth') || hay.includes('login') || hay.includes('admin/')) return 'AUTH';
  return 'SYSTEM';
}

function stripW3logTag(s: string): string {
  return s.replace(/\[w3log\]\s*/gi, '').trim();
}

interface ParseOpts {
  fallbackCategory: string;
  previousTimestamp?: string | null;
  selectedCategory?: string;
}

export function parseLogLine(raw: string, opts: ParseOpts): ParsedLogLine {
  const trimmed = (raw ?? '').trimEnd();
  const fallbackCategory =
    opts.selectedCategory && opts.selectedCategory.trim()
      ? opts.selectedCategory.toUpperCase()
      : (opts.fallbackCategory || 'SYSTEM').toUpperCase();

  if (!trimmed) {
    return {
      timestamp: opts.previousTimestamp ?? null,
      category: fallbackCategory,
      level: 'INFO',
      message: '',
      raw
    };
  }

  // 1. JSON-line attempt.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const ts =
        (obj.ts as string) ||
        (obj.timestamp as string) ||
        (obj.time as string) ||
        (obj['@timestamp'] as string) ||
        null;

      const levelStr = normalizeLevel(
        String(obj.level ?? obj.severity ?? obj.lvl ?? '')
      );

      const sourceStr = String(obj.category ?? obj.source ?? obj.component ?? '').trim();
      let category =
        sourceStr && KNOWN_CATEGORIES.has(sourceStr.toUpperCase())
          ? sourceStr.toUpperCase()
          : '';
      const method = obj.method ? String(obj.method) : undefined;
      const reqPath = obj.path ? String(obj.path) : undefined;
      const status = typeof obj.status === 'number' ? obj.status : undefined;

      let message = String(obj.msg ?? obj.message ?? obj.event ?? '');
      if (!message && method && reqPath) message = `${method} ${reqPath}`;
      if (!message) message = trimmed;
      message = stripW3logTag(message);

      if (!category) {
        category =
          method && reqPath ? 'AUTH' : classifyCategoryFromText(`${sourceStr} ${message}`);
        if (category === 'SYSTEM' && !sourceStr) category = fallbackCategory;
      }

      const level = levelStr || inferLevel(message);

      return {
        timestamp: ts ?? opts.previousTimestamp ?? null,
        category,
        level,
        message,
        raw: trimmed,
        method,
        path: reqPath,
        status
      };
    } catch {
      // Fall through to plain-text handling.
    }
  }

  // 2. Plain text — extract leading ISO timestamp if present.
  let timestamp: string | null = null;
  let body = trimmed;
  const lead = body.match(TS_LEADING_RE);
  if (lead) {
    timestamp = lead[1];
    body = body.slice(lead[0].length).replace(/^[\s\-|:]+/, '');
  } else {
    // 3. Try embedded timestamp.
    const embed = body.match(TS_EMBEDDED_RE);
    if (embed) {
      timestamp = embed[1];
      body = (body.slice(0, embed.index) + body.slice((embed.index ?? 0) + embed[0].length))
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
  }

  // 4. Strip [w3log] tag.
  body = stripW3logTag(body);

  // 5. Carry forward timestamp.
  if (!timestamp) timestamp = opts.previousTimestamp ?? null;

  // 6 / 7 / 8 — category and level.
  const explicitLevelMatch = body.match(
    /\b(ERROR|FATAL|WARN|WARNING|INFO|DEBUG|TRACE|SUCCESS|OK|FAIL|FAILURE)\b/i
  );
  const level = explicitLevelMatch
    ? normalizeLevel(explicitLevelMatch[1])
    : inferLevel(body);

  const category =
    classifyCategoryFromText(body) === 'SYSTEM'
      ? fallbackCategory
      : classifyCategoryFromText(body);

  return {
    timestamp,
    category,
    level: level || 'INFO',
    message: body,
    raw: trimmed
  };
}

export function parseLogBuffer(
  lines: string[],
  opts: { selectedCategory: string }
): ParsedLogLine[] {
  const out: ParsedLogLine[] = [];
  let previousTimestamp: string | null = null;
  const fallbackCategory = opts.selectedCategory.toUpperCase();
  for (const raw of lines) {
    try {
      const parsed = parseLogLine(raw, {
        fallbackCategory,
        previousTimestamp,
        selectedCategory: opts.selectedCategory
      });
      out.push(parsed);
      if (parsed.timestamp) previousTimestamp = parsed.timestamp;
    } catch {
      // Hard fallback — never throw.
      out.push({
        timestamp: previousTimestamp,
        category: 'SYSTEM',
        level: 'INFO',
        message: raw,
        raw
      });
    }
  }
  return out;
}
