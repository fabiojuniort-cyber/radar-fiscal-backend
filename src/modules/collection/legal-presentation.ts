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

/**
 * Paragraph styles of official legal portals (CONFAZ "estilos das leis").
 * Only these class names survive sanitization; the site styles them per
 * source so the text keeps the official visual identity.
 */
export const LEGAL_PRESENTATION_CLASSES = new Set([
  'TituloAcordo',
  'AcordoTipo',
  'Ementa',
  'DataPublicao',
  'A2DataPublicacao',
  'TextoAcordo',
  'A5-1TextoAcordo',
  'RedaoAnt',
  'A8-3RedacaoAnt',
  'Remisso',
  'A8-1Remissao',
  'RemissoAnt',
  'A8-2RemissaoAnt',
]);

/**
 * CONFAZ prints previous wordings (and the notes about them) in its "Ant"
 * paragraph styles and, inside annex tables, in the green ("verde") table
 * styles. They stay on the page as history but are not the act in force.
 */
const PREVIOUS_WORDING_CLASSES = new Set([
  'RedaoAnt',
  'A8-3RedacaoAnt',
  'RemissoAnt',
  'A8-2RemissaoAnt',
]);
const PREVIOUS_WORDING_TABLE_CLASS = /^(?:A\d+-\d+)?Tabela[A-Za-z]*verde$/;
const NON_NORMATIVE_PRESENTATION_CLASSES = new Set([
  'TituloAcordo',
  'AcordoTipo',
  'Ementa',
  'DataPublicao',
  'A2DataPublicacao',
  'Remisso',
  'A8-1Remissao',
]);

export function isPreviousWordingClass(token: string): boolean {
  return PREVIOUS_WORDING_CLASSES.has(token) || PREVIOUS_WORDING_TABLE_CLASS.test(token);
}

function isNonNormativePresentationClass(token: string): boolean {
  return NON_NORMATIVE_PRESENTATION_CLASSES.has(token) || isPreviousWordingClass(token);
}

const REVOKED_PLACEHOLDER =
  /^(?:(?:cl[áa]usula|art(?:igo)?\.?|par[áa]grafo|inciso|al[íi]nea|item)\s+[\p{L}\p{N}º°ª.-]+|§\s*\d+[º°ª]?|[ivxlcdm]+|[a-z]|\d+[º°ª]?)\s*(?:[-–—:]\s*)?revogad[oa]s?\.?$/iu;

function isRevokedPlaceholder(text: string): boolean {
  return REVOKED_PLACEHOLDER.test(text.replace(/\s+/g, ' ').trim());
}

function allowedClasses(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const kept = raw
    .split(/\s+/)
    .filter((token) => LEGAL_PRESENTATION_CLASSES.has(token) || PREVIOUS_WORDING_TABLE_CLASS.test(token));
  return kept.length ? [...new Set(kept)].join(' ') : undefined;
}

function allowedAttributes(
  name: string,
  attributes: Record<string, string>,
): string {
  const output: string[] = [];

  const classes = allowedClasses(attributes.class);
  if (classes) {
    output.push(`class="${escapeAttribute(classes)}"`);
  }

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

const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section']);

/**
 * Operative legal text of a sanitized presentation. CONFAZ headings,
 * ementa/publication-history blocks, editorial remission notes and previous
 * wordings are not normative content and therefore cannot classify or mark
 * taxonomy tags. Previous-wording styles inside annex tables exclude the
 * whole row. Returns undefined only when the page exposes none of these
 * source-specific markers, so callers can safely fall back to stored text.
 */
export function currentWordingText(html: string | null | undefined): string | undefined {
  if (!html) return undefined;

  type Frame = { tag: string; text: string; excluded: boolean };
  const frames: Frame[] = [];
  let output = '';
  let filtered = false;

  const append = (text: string) => {
    const top = frames[frames.length - 1];
    if (top) top.text += text;
    else output += text;
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase();
        const classes = (attributes.class ?? '').split(/\s+/).filter(Boolean);
        const previous = classes.some(isPreviousWordingClass);
        const excluded = classes.some(isNonNormativePresentationClass);
        if (excluded) filtered = true;

        const row = [...frames].reverse().find((frame) => frame.tag === 'tr');
        if (previous && row) row.excluded = true;

        if (tag === 'tr' || tag === 'p' || excluded) {
          // Editorial notes are excluded even when nested in a current table
          // row. Only previous-wording markers poison the whole row.
          frames.push({ tag, text: '', excluded });
        }
        if (tag === 'br') append('\n');
      },
      ontext(text) {
        append(text);
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        const separator = BLOCK_TAGS.has(tag) ? '\n' : tag === 'td' || tag === 'th' ? ' ' : '';
        const index = frames.map((frame) => frame.tag).lastIndexOf(tag);
        if (index < 0 || index !== frames.length - 1) {
          if (separator && tag !== 'br') append(separator);
          return;
        }
        const frame = frames.pop()!;
        if (!frame.excluded && !(frame.tag === 'p' && isRevokedPlaceholder(frame.text))) {
          append(frame.text + separator);
        } else if (frame.tag === 'p' && isRevokedPlaceholder(frame.text)) {
          filtered = true;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  parser.end(html);
  while (frames.length > 0) {
    const frame = frames.pop()!;
    if (!frame.excluded && !(frame.tag === 'p' && isRevokedPlaceholder(frame.text))) {
      append(frame.text);
    } else if (frame.tag === 'p' && isRevokedPlaceholder(frame.text)) {
      filtered = true;
    }
  }

  if (!filtered) return undefined;
  return output
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
