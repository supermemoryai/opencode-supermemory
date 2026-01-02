/**
 * Parses JSONC content, removing comments and trailing commas.
 * Respects string boundaries for both operations.
 * 
 * Handles:
 * - // single-line comments
 * - /* multi-line comments
 * - Trailing commas before } or ]
 * - Escaped quotes and URLs in strings
 */
export function parseJsonc(content: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let inSingleLineComment = false;
  let inMultiLineComment = false;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (!inSingleLineComment && !inMultiLineComment) {
      if (char === '"') {
        // Count consecutive backslashes before this quote
        let backslashCount = 0;
        let j = i - 1;
        while (j >= 0 && content[j] === "\\") {
          backslashCount++;
          j--;
        }
        // Quote is escaped only if preceded by ODD number of backslashes
        // e.g., \" = escaped, \\" = not escaped (escaped backslash + quote)
        if (backslashCount % 2 === 0) {
          inString = !inString;
        }
        result += char;
        i++;
        continue;
      }
    }

    if (inString) {
      result += char;
      i++;
      continue;
    }

    if (!inSingleLineComment && !inMultiLineComment) {
      if (char === "/" && nextChar === "/") {
        inSingleLineComment = true;
        i += 2;
        continue;
      }

      if (char === "/" && nextChar === "*") {
        inMultiLineComment = true;
        i += 2;
        continue;
      }
    }

    if (inSingleLineComment) {
      if (char === "\n") {
        inSingleLineComment = false;
        result += char;
      }
      i++;
      continue;
    }

    if (inMultiLineComment) {
      if (char === "*" && nextChar === "/") {
        inMultiLineComment = false;
        i += 2;
        continue;
      }
      if (char === "\n") {
        result += char;
      }
      i++;
      continue;
    }

    // Trailing comma detection
    if (char === ",") {
      // Look ahead: skip whitespace and comments, check for ] or }
      let k = i + 1;
      while (k < content.length) {
        const lookaheadChar = content[k]!;
        if (/\s/.test(lookaheadChar)) {
          k++;
          continue;
        }
        // Skip // comments
        if (lookaheadChar === "/" && content[k + 1] === "/") {
          k += 2;
          while (k < content.length && content[k] !== "\n") k++;
          if (k < content.length) k++; // skip newline
          continue;
        }
        // Skip /* */ comments
        if (lookaheadChar === "/" && content[k + 1] === "*") {
          k += 2;
          let foundClosing = false;
          while (k < content.length) {
            if (content[k] === "*" && content[k + 1] === "/") {
              foundClosing = true;
              k += 2;
              break;
            }
            k++;
          }
          if (!foundClosing) {
            throw new Error("Unclosed multi-line comment in JSONC content");
          }
          continue;
        }
        break;
      }
      if (k < content.length && (content[k] === "}" || content[k] === "]")) {
        i++;
        while (i < content.length && content[i] === " ") i++;
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}
