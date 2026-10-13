import { Parser } from 'htmlparser2';
import { isPreviousWordingClass } from './legal-presentation.js';

/**
 * TAX13 Fase 1 — optional parser for visual diagnostic/regression ONLY.
 * This file is intentionally not referenced by global NCM, classification,
 * product matching or publication persistence. A CSS/HTML status attribute
 * is not legal proof; no output from this helper may be marked "vigente".
 * Keep separate from currentWordingText used by existing workers.
 */
const MAX_PRESENTATION_HTML_BYTES = 2 * 1024 * 1024;

const NON_NORMATIVE_PRESENTATION_CLASSES = new Set([
  'TituloAcordo',
  'AcordoTipo',
  'Ementa',
  'DataPublicao',
  'A2DataPublicacao',
  'Remisso',
  'A8-1Remissao',
  'Subtitulo',
  'A6-1Subtitulo',
]);

function isNonNormativePresentationClass(token: string): boolean {
  return NON_NORMATIVE_PRESENTATION_CLASSES.has(token) || isPreviousWordingClass(token);
}

/**
 * Normalized legal segment status, produced by a source-aware adapter using
 * evidence from the official act. This is independent of portal CSS classes.
 * A missing status is NOT evidence that a segment is currently in force.
 */
const LEGAL_SEGMENT_STATUSES = new Set(['current', 'previous', 'revoked', 'editorial', 'unverified']);

function legalSegmentStatus(value: string | undefined): string | undefined {
  return value && LEGAL_SEGMENT_STATUSES.has(value) ? value : undefined;
}

const REVOKED_PLACEHOLDER =
  /^(?:(?:cl[áa]usula|art(?:igo)?\.?|par[áa]grafo|inciso|al[íi]nea|item)\s+[\p{L}\p{N}º°ª.-]+|§\s*\d+[º°ª]?|[ivxlcdm]+|[a-z]|\d+[º°ª]?)\s*(?:[-–—:]\s*)?revogad[oa]s?\.?$/iu;

function isRevokedPlaceholder(text: string): boolean {
  return REVOKED_PLACEHOLDER.test(text.replace(/\s+/g, ' ').trim());
}

/**
 * Standalone act identifiers and editorial references occur in portals that
 * do not expose the CONFAZ-specific CSS classes. This does NOT establish that
 * any other segment is in force; positive vigência still needs source evidence.
 */
const ACT_IDENTIFIER_HEADING =
  /^(?:lei(?:\s+complementar)?|decreto(?:-lei)?|portaria|instrução\s+normativa(?:\s+[A-Z]{2,8})?|resolução(?:\s+[A-Z]{2,8})?|convênio(?:\s+icms)?|ajuste\s+sinief|ato\s+cotepe(?:\/icms)?|medida\s+provisória)\s+(?:n[ºo°.]?\s*)?\d+(?:[./-]\d+)*(?:\s*,?\s+de\s+\d{1,2}\s+de\s+[\p{L}]+\s+de\s+\d{4})?\.?$/iu;
const EDITORIAL_REFERENCE_LINE =
  /^(?:publicad[oa]s?\s+(?:no|na|em)|ratificad[oa]s?\s+(?:no|na|pel[oa]s?)|alterad[oa]s?\s+(?:pel[oa]s?|por)|prorrogad[oa]s?\s+at[eé]|vide\s+(?:o|a|os|as|cl[áa]usula|art)|redação\s+anterior\b|texto\s+anterior\b|nova\s+redação\s+dada\s+pel[oa])/iu;

function isNonNormativeStandaloneLine(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  return ACT_IDENTIFIER_HEADING.test(clean) || EDITORIAL_REFERENCE_LINE.test(clean);
}

/**
 * Annex headings are metadata, not a taxonomy hit. A revoked or historical
 * annex suppresses its contents until the next annex heading, including rows
 * whose HTML class is indistinguishable from the current version. An active
 * annex, including its tables, remains in scope.
 *
 * Deliberately require a heading delimiter: "Anexo I dispõe ..." is a
 * normative sentence, not the beginning of an annex section.
 */
const ANNEX_HEADING = /^anexo\s+(?:único|unico|[ivxlcdm]+|\d+)(?=\s*$|\s*[-–—:.(])/iu;
const HISTORICAL_ANNEX_HEADING =
  /\b(?:revogad[oa]s?|redação\s+(?:anterior|original)|texto\s+anterior|substitu[íi]d[oa]s?|sem\s+(?:efeito|vigência))\b/iu;

function excludeHistoricalAnnexes(lines: string[]): { lines: string[]; filtered: boolean } {
  const included: string[] = [];
  let historicalAnnex = false;
  let filtered = false;
  for (const line of lines) {
    if (ANNEX_HEADING.test(line)) {
      historicalAnnex = HISTORICAL_ANNEX_HEADING.test(line);
      filtered = true; // headings are not normative evidence, even for current annexes
      continue;
    }
    if (historicalAnnex) {
      filtered = true;
      continue;
    }
    included.push(line);
  }
  return { lines: included, filtered };
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
export function tax13ScopedPresentationText(html: string | null | undefined): string | undefined {
  if (!html || Buffer.byteLength(html, 'utf8') > MAX_PRESENTATION_HTML_BYTES) return undefined;

  type Frame = { tag: string; text: string; excluded: boolean; annexRestriction: 'previous' | 'revoked' | 'unverified' | null; legalStatus: string | undefined; currentCellText: string };
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
        const status = legalSegmentStatus(attributes['data-legal-status']);
        const annexRestriction = status === 'unverified' ? 'unverified'
          : status === 'revoked' ? 'revoked'
            : (previous || status === 'previous') ? 'previous' : null;
        const excluded = classes.some(isNonNormativePresentationClass) || (status !== undefined && status !== 'current');
        if (excluded || status !== undefined) filtered = true;

        const row = [...frames].reverse().find((frame) => frame.tag === 'tr');
        if (previous && row) row.excluded = true;

        if (tag === 'tr' || tag === 'p' || tag === 'td' || tag === 'th' || /^h[1-6]$/.test(tag) || excluded || status !== undefined) {
          // Historical styles in a mixed row make unverified sibling cells
          // ineligible, but an explicitly-current sibling must survive.
          frames.push({ tag, text: '', excluded, annexRestriction, legalStatus: status, currentCellText: '' });
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
        const standalone = frame.tag === 'p' || /^h[1-6]$/.test(frame.tag);
        const editorial = standalone && isNonNormativeStandaloneLine(frame.text);
        const revokedCell = (frame.tag === 'p' || frame.tag === 'td' || frame.tag === 'th')
          && isRevokedPlaceholder(frame.text);
        if (!frame.excluded && !revokedCell && !editorial) {
          if (frame.tag === 'tr' && frame.excluded) {
            append(frame.currentCellText + separator);
          } else {
            const row = [...frames].reverse().find((parent) => parent.tag === 'tr');
            if (row && (frame.tag === 'td' || frame.tag === 'th') && frame.legalStatus === 'current') {
              row.currentCellText += frame.text + separator;
              append(frame.text + separator);
            } else {
              append(frame.text + separator);
            }
          }
        } else if (frame.tag === 'tr' && frame.excluded) {
          append(frame.currentCellText + separator);
        } else if (frame.annexRestriction && ANNEX_HEADING.test(frame.text.trim())) {
          // Preserve an excluded annex heading only as a boundary signal.
          // This also keeps unverified annex rows out of taxonomy evidence.
          const reason = frame.annexRestriction === 'unverified'
            ? 'sem vigência confirmada' : frame.annexRestriction === 'revoked' ? 'revogado' : 'redação anterior';
          append(frame.text + ' — ' + reason + '\n');
        } else if (frame.excluded && ANNEX_HEADING.test(frame.text.trim())) {
          // The heading itself is editorial, but it starts a new annex section.
          append(frame.text + '\n');
        } else if (editorial || revokedCell) {
          filtered = true;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  parser.end(html);
  while (frames.length > 0) {
    const frame = frames.pop()!;
    const standalone = frame.tag === 'p' || /^h[1-6]$/.test(frame.tag);
    const editorial = standalone && isNonNormativeStandaloneLine(frame.text);
    const revokedCell = (frame.tag === 'p' || frame.tag === 'td' || frame.tag === 'th')
      && isRevokedPlaceholder(frame.text);
    if (!frame.excluded && !revokedCell && !editorial) {
      append(frame.tag === 'tr' && frame.excluded ? frame.currentCellText : frame.text);
    } else if (frame.tag === 'tr' && frame.excluded) {
      append(frame.currentCellText);
    } else if (frame.annexRestriction && ANNEX_HEADING.test(frame.text.trim())) {
      const reason = frame.annexRestriction === 'unverified'
        ? 'sem vigência confirmada' : frame.annexRestriction === 'revoked' ? 'revogado' : 'redação anterior';
      append(frame.text + ' — ' + reason + '\n');
    } else if (frame.excluded && ANNEX_HEADING.test(frame.text.trim())) {
      append(frame.text + '\n');
    } else if (editorial || revokedCell) {
      filtered = true;
    }
  }

  const lines = output
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean);
  const annexes = excludeHistoricalAnnexes(lines);
  if (!filtered && !annexes.filtered) return undefined;
  return annexes.lines.join('\n');
}
