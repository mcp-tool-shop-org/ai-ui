// @ts-check
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt();

/** Sections whose children are treated as feature candidates. */
const FEATURE_SECTIONS = [
  'features', 'commands', 'tools', 'api', 'usage',
  'what\'s inside', 'capabilities', 'plugins', 'modules',
  'principles', 'design tokens', 'highlights', 'overview',
];

/**
 * @typedef {Object} ExtractedItem
 * @property {'heading'|'bullet'|'tag'} type
 * @property {string} text
 * @property {number} line - 1-based line number
 * @property {string|null} section - Parent heading text
 * @property {number} [level] - Heading level (1-6), only for headings
 * @property {string} [tagId] - Feature ID from <!-- ai-ui:feature ... --> tag
 */

/**
 * Parse markdown content and extract feature-relevant items:
 * headings, bullets under feature sections, and ai-ui:feature tags.
 *
 * @param {string} content - Raw markdown string
 * @param {string} filePath - Source file path (for reference)
 * @returns {ExtractedItem[]}
 */
export function parseMarkdown(content, filePath) {
  const tokens = md.parse(content, {});
  /** @type {ExtractedItem[]} */
  const items = [];

  // Track section context as a stack of { level, text, isFeature }
  // When we see a heading at level N, pop everything >= N, then push.
  /** @type {{ level: number, text: string, isFeature: boolean }[]} */
  const sectionStack = [];

  function currentSection() {
    return sectionStack.length > 0 ? sectionStack[sectionStack.length - 1].text : null;
  }

  function inFeatureSection() {
    // Any ancestor in the stack is a feature section
    return sectionStack.some(s => s.isFeature);
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // --- ai-ui:feature tags (HTML comments) ---
    if (token.type === 'html_block' || token.type === 'inline') {
      const tagMatches = token.content.matchAll(/<!--\s*ai-ui:feature\s+([\w.-]+)\s*-->/g);
      for (const m of tagMatches) {
        items.push({
          type: 'tag',
          text: m[1],
          line: (token.map?.[0] ?? 0) + 1,
          section: currentSection(),
          tagId: m[1],
        });
      }
    }

    // --- Headings ---
    if (token.type === 'heading_open') {
      const level = parseInt(token.tag.slice(1), 10);
      const inline = tokens[i + 1];
      if (inline?.type === 'inline' && inline.content) {
        const headingText = inline.content.trim();
        const line = (token.map?.[0] ?? 0) + 1;

        const isFeatureHeading = FEATURE_SECTIONS.some(s =>
          headingText.toLowerCase().includes(s)
        );

        // If we're inside a feature section and this is a deeper heading,
        // it's a sub-feature candidate
        if (inFeatureSection() && sectionStack.length > 0 && level > sectionStack[sectionStack.length - 1].level) {
          items.push({
            type: 'heading',
            text: headingText,
            line,
            section: currentSection(),
            level,
          });
        }

        // Pop headings at same or higher level, then push this one
        while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) {
          sectionStack.pop();
        }
        sectionStack.push({ level, text: headingText, isFeature: isFeatureHeading });
      }
    }

    // --- Bullet items under feature sections ---
    // Token sequence is: list_item_open → paragraph_open → inline
    if (token.type === 'inline' && inFeatureSection()) {
      const prev1 = tokens[i - 1];
      const prev2 = tokens[i - 2];
      if (prev1?.type === 'paragraph_open' && prev2?.type === 'list_item_open') {
        const text = extractPlainText(token.content).trim();
        if (text && text.length > 2 && text.length < 200) {
          items.push({
            type: 'bullet',
            text,
            line: (prev2.map?.[0] ?? 0) + 1,
            section: currentSection(),
          });
        }
      }
    }
  }

  return items;
}

/**
 * Strip markdown inline formatting to get plain text.
 * @param {string} md
 * @returns {string}
 */
function extractPlainText(md) {
  return md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links
    .replace(/[*_~`]+/g, '')                    // bold/italic/strikethrough/code
    .replace(/<[^>]+>/g, '')                    // HTML tags
    .trim();
}
