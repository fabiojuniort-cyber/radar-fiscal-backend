import { Parser } from 'htmlparser2';

const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'section',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

const VOID_TAGS = new Set([
  'br',
  'hr',
]);

const HIDDEN_TAGS = new Set([
  'aside',
  'button',
  'footer',
  'form',
  'head',
  'header',
  'iframe',
  'nav',
  'noscript',
  'object',
  'script',
  'style',
  'svg',
  'template',
]);

const MAX_PRESENTATION_HTML_BYTES =
  2 * 1024 * 1024;

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttribute(
  value: string,
): string {
  return escapeText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHref(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' ||
      url.protocol === 'http:'
    ) {
      return url.toString();
    }
  } catch {
    // Relative links are intentionally omitted:
    // presentation must not invent a base URL.
  }

  return undefined;
}

function allowedAttributes(
  name: string,
  attributes: Record<string, string>,
): string {
  const output: string[] = [];

  if (name === 'a') {
    const href = safeHref(
      attributes.href,
    );
    if (href) {
      output.push(
        `href="${escapeAttribute(href)}"`,
        'target="_blank"',
        'rel="noreferrer"',
      );
    }
  }

  if (
    name === 'td' ||
    name === 'th'
  ) {
    for (const attribute of [
      'colspan',
      'rowspan',
    ]) {
      const raw = attributes[attribute];
      if (
        raw &&
        /^\d{1,2}$/.test(raw)
      ) {
        output.push(
          `${attribute}="${raw}"`,
        );
      }
    }

    if (
      name === 'th' &&
      ['row', 'col'].includes(
        attributes.scope ?? '',
      )
    ) {
      output.push(
        `scope="${attributes.scope}"`,
      );
    }
  }

  return output.length
    ? ' ' + output.join(' ')
    : '';
}

export function sanitizeLegalPresentationHtml(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;

  if (
    Buffer.byteLength(value, 'utf8') >
    MAX_PRESENTATION_HTML_BYTES
  ) {
    return undefined;
  }

  let output = '';
  let hiddenDepth = 0;
  const openAllowedTags: string[] = [];

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag =
          name.toLowerCase();

        if (
          HIDDEN_TAGS.has(tag)
        ) {
          hiddenDepth += 1;
          return;
        }

        if (hiddenDepth > 0) {
          return;
        }

        if (
          !ALLOWED_TAGS.has(tag)
        ) {
          return;
        }

        output +=
          '<' +
          tag +
          allowedAttributes(
            tag,
            attributes,
          ) +
          '>';

        if (
          !VOID_TAGS.has(tag)
        ) {
          openAllowedTags.push(tag);
        }
      },
      ontext(text) {
        if (hiddenDepth === 0) {
          output += escapeText(text);
        }
      },
      onclosetag(name) {
        const tag =
          name.toLowerCase();

        if (
          HIDDEN_TAGS.has(tag)
        ) {
          hiddenDepth = Math.max(
            0,
            hiddenDepth - 1,
          );
          return;
        }

        if (
          hiddenDepth > 0 ||
          !ALLOWED_TAGS.has(tag) ||
          VOID_TAGS.has(tag)
        ) {
          return;
        }

        const index =
          openAllowedTags.lastIndexOf(
            tag,
          );

        if (index < 0) {
          return;
        }

        for (
          let cursor =
            openAllowedTags.length - 1;
          cursor >= index;
          cursor -= 1
        ) {
          const closing =
            openAllowedTags.pop();
          if (closing) {
            output +=
              '</' + closing + '>';
          }
        }
      },
    },
    {
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
      recognizeSelfClosing: true,
    },
  );

  parser.end(value);

  while (
    openAllowedTags.length > 0
  ) {
    output +=
      '</' +
      openAllowedTags.pop() +
      '>';
  }

  const trimmed = output.trim();

  return trimmed || undefined;
}
