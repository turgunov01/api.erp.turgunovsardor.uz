// Minimal HTML sanitizer for user-authored document bodies (rendered with v-html).
// Strips executable/dangerous constructs while keeping formatting markup. Not a full
// DOM sanitizer, but removes the XSS vectors that matter for trusted internal content.
export function sanitizeHtml(html: string): string {
  if (!html) return '';
  return html
    // Drop script/style/embed-like elements entirely (with their content).
    .replace(/<(script|style|iframe|object|embed|link|meta|base)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|link|meta|base)\b[^>]*\/?>/gi, '')
    // Remove inline event handlers (onclick=, onerror=, …).
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    // Neutralise javascript:/data: URLs in href/src.
    .replace(/\s(href|src)\s*=\s*"(?:javascript|data):[^"]*"/gi, ' $1="#"')
    .replace(/\s(href|src)\s*=\s*'(?:javascript|data):[^']*'/gi, " $1='#'");
}
