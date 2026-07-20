import { describe, expect, test } from 'bun:test';
import {
  buildErrorLogSummary,
  parseErrorLogContent,
  parseErrorLogFilename,
} from '../src/pages/hooks/errorLogParsing';

describe('parseErrorLogFilename', () => {
  test('parses per-request filename with path, timestamp and request id', () => {
    const parsed = parseErrorLogFilename(
      'error-v1-messages-2026-01-10T021624-74ca64cc.log'
    );
    expect(parsed.path).toBe('/v1/messages');
    expect(parsed.timestamp).toBe('2026-01-10 02:16:24');
    expect(parsed.requestId).toBe('74ca64cc');
  });

  test('parses multi-segment paths like chat completions', () => {
    const parsed = parseErrorLogFilename(
      'error-v1-chat-completions-2026-02-06T051701-3f60e5b3.log'
    );
    expect(parsed.path).toBe('/v1/chat/completions');
    expect(parsed.timestamp).toBe('2026-02-06 05:17:01');
    expect(parsed.requestId).toBe('3f60e5b3');
  });

  test('parses daily aggregate filename', () => {
    const parsed = parseErrorLogFilename('error-2024-05-20.log');
    expect(parsed.path).toBeUndefined();
    expect(parsed.timestamp).toBe('2024-05-20');
    expect(parsed.requestId).toBeUndefined();
  });

  test('returns raw name for unrecognized patterns', () => {
    const parsed = parseErrorLogFilename('something-else.txt');
    expect(parsed.rawName).toBe('something-else.txt');
    expect(parsed.path).toBeUndefined();
  });
});

describe('parseErrorLogContent', () => {
  const sample = `=== REQUEST INFO ===
Version: 6.6.22
URL: /v1/chat/completions
Method: POST
Timestamp: 2025-12-17T13:18:32.8195707+03:00

=== HEADERS ===
User-Agent: oai-compatible-copilot/0.1.8
Content-Type: application/json

=== REQUEST BODY ===
{"model":"gemini-claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}

=== API RESPONSE ===
HTTP 400 INVALID_ARGUMENT
{"error":{"message":"messages.3.content.0.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'","type":"invalid_request_error"}}
`;

  test('extracts model, path, method, status and error message', () => {
    const parsed = parseErrorLogContent(sample);
    expect(parsed.model).toBe('gemini-claude-sonnet-4-5');
    expect(parsed.path).toBe('/v1/chat/completions');
    expect(parsed.method).toBe('POST');
    expect(parsed.statusCode).toBe(400);
    expect(parsed.errorMessage).toContain('tool_use.id');
    expect(parsed.timestamp).toContain('2025-12-17');
  });

  test('handles missing response section gracefully', () => {
    const text = `=== REQUEST INFO ===
URL: /v1/messages
Method: POST

=== REQUEST BODY ===
{"model":"claude-opus-4-5-20251101"}
`;
    const parsed = parseErrorLogContent(text);
    expect(parsed.model).toBe('claude-opus-4-5-20251101');
    expect(parsed.path).toBe('/v1/messages');
    expect(parsed.statusCode).toBeUndefined();
    expect(parsed.errorMessage).toBeUndefined();
  });

  test('falls back to model scan when body is not pure JSON', () => {
    const text = `=== REQUEST BODY ===
truncated body... "model":"gpt-4.1-mini" trailing
=== RESPONSE ===
status: 429
{"error":{"message":"Rate limit exceeded"}}
`;
    const parsed = parseErrorLogContent(text);
    expect(parsed.model).toBe('gpt-4.1-mini');
    expect(parsed.statusCode).toBe(429);
    expect(parsed.errorMessage).toBe('Rate limit exceeded');
  });

  test('prefers upstream model from API REQUEST over client REQUEST BODY alias', () => {
    const text = `=== REQUEST INFO ===
URL: /v1/messages?beta=true
Method: POST
Timestamp: 2026-07-20T09:28:43.189030811+08:00

=== REQUEST BODY ===
{"model":"claude-opus-4-8","messages":[{"role":"user","content":"hi"}]}

=== API REQUEST 1 ===
Upstream URL: https://api-inference.modelscope.cn/v1/messages?beta=true
Body:
{"model":"stepfun-ai/Step-3.7-Flash","messages":[{"role":"user","content":"hi"}]}

=== API RESPONSE ===
{"type":"error","error":{"type":"api_error","message":"<html>\\r\\n<head><title>502 Bad Gateway</title></head>\\r\\n<body>\\r\\n<center><h1>502 Bad Gateway</h1></center>\\r\\n</body>\\r\\n</html>"}}

=== RESPONSE ===
Status: 502
{"type":"error","error":{"type":"api_error","message":"<html>\\r\\n<head><title>502 Bad Gateway</title></head></html>"}}
`;
    const parsed = parseErrorLogContent(text);
    expect(parsed.model).toBe('stepfun-ai/Step-3.7-Flash');
    expect(parsed.path).toBe('/v1/messages');
    expect(parsed.method).toBe('POST');
    expect(parsed.statusCode).toBe(502);
    expect(parsed.errorMessage).toBe('502 Bad Gateway');
  });
});

describe('buildErrorLogSummary', () => {
  test('merges filename and content fields with content preferred for path/model', () => {
    const summary = buildErrorLogSummary(
      'error-v1-messages-2026-01-10T021624-74ca64cc.log',
      `=== REQUEST INFO ===
URL: /v1/messages
Method: POST
=== REQUEST BODY ===
{"model":"claude-sonnet-4-6"}
=== RESPONSE ===
HTTP 500
{"error":{"message":"upstream failed"}}
`
    );
    expect(summary.model).toBe('claude-sonnet-4-6');
    expect(summary.path).toBe('/v1/messages');
    expect(summary.method).toBe('POST');
    expect(summary.statusCode).toBe(500);
    expect(summary.requestId).toBe('74ca64cc');
    expect(summary.errorMessage).toBe('upstream failed');
  });

  test('uses filename-only data when content is absent', () => {
    const summary = buildErrorLogSummary(
      'error-v1-chat-completions-2026-02-06T051701-3f60e5b3.log'
    );
    expect(summary.model).toBeUndefined();
    expect(summary.path).toBe('/v1/chat/completions');
    expect(summary.requestId).toBe('3f60e5b3');
    expect(summary.timestamp).toBe('2026-02-06 05:17:01');
  });
});
