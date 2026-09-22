/**
 * Reading a usage export: CSV, JSONL, or JSON.
 *
 * WHY THE CSV READER IS HAND-WRITTEN AND NOT A SPLIT ON COMMAS
 *
 * LiteLLM's spend log carries `metadata` and `request_tags` as JSON *inside* a
 * CSV cell. Those cells contain commas, quotes and sometimes newlines, so a
 * naive split shifts every column after them and the tool reads a model name
 * out of a cost column. It would not error; it would produce a confident,
 * wrong variance, which is the one outcome this tool cannot have.
 *
 * So: RFC 4180 proper — quoted fields, doubled quotes inside them, embedded
 * newlines, CRLF, and a UTF-8 BOM that Excel adds and nothing else expects.
 *
 * Zero dependencies, deliberately. This is a tool people run once against a
 * file they exported by hand; a dependency tree is a reason not to run it.
 */

export class UsageFileError extends Error {}

export type Row = Record<string, unknown>;

/** Strip the BOM Excel writes, which otherwise becomes part of column one. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * RFC 4180 CSV into rows of cells.
 *
 * Ends with the trailing-newline case handled explicitly: a file ending in a
 * newline must not produce a final empty row, and a file that does not end in
 * one must not lose its last row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    // A line that is entirely empty is a blank line, not a row of one empty
    // cell. Exports often end with several.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  const source = stripBom(text);

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      continue;
    }
    if (char === ",") {
      endField();
      continue;
    }
    if (char === "\r") {
      if (source[i + 1] === "\n") i += 1;
      endRow();
      continue;
    }
    if (char === "\n") {
      endRow();
      continue;
    }

    fieldStarted = true;
    field += char;
  }

  // Whatever is left is the last row, unless the file ended on a newline and
  // left nothing behind.
  if (field !== "" || row.length > 0 || quoted) endRow();

  return rows;
}

function csvToRows(text: string): Row[] {
  const table = parseCsv(text);
  if (table.length === 0) return [];

  const header = (table[0] ?? []).map((name) => name.trim());
  if (header.every((name) => name === "")) {
    throw new UsageFileError("The first line of the CSV is empty; a header row is required.");
  }

  return table.slice(1).map((cells) => {
    const row: Row = {};
    header.forEach((name, index) => {
      if (name) row[name] = cells[index] ?? "";
    });
    return row;
  });
}

function jsonlToRows(text: string): Row[] {
  const rows: Row[] = [];
  const lines = stripBom(text).split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new UsageFileError(
        `Line ${index + 1} is not valid JSON. A .jsonl file holds one JSON object per line.`,
      );
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as Row);
  });

  return rows;
}

/**
 * A JSON document, which arrives in three shapes in practice: a bare array, or
 * an object wrapping one under a key that varies by exporter.
 */
function jsonToRows(text: string): Row[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (error) {
    throw new UsageFileError(`The file is not valid JSON: ${(error as Error).message}`);
  }

  if (Array.isArray(parsed)) return parsed.filter(isRow);

  if (parsed && typeof parsed === "object") {
    for (const key of ["data", "observations", "rows", "items", "results", "logs"]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value.filter(isRow);
    }
  }

  throw new UsageFileError(
    "The JSON file is neither an array of rows nor an object wrapping one " +
      "(looked for `data`, `observations`, `rows`, `items`, `results`, `logs`).",
  );
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type UsageFormat = "csv" | "jsonl" | "json";

/** Guess the file format from its name, then from its first non-blank byte. */
export function detectFormat(path: string, text: string): UsageFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return "csv";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  if (lower.endsWith(".json")) return "json";

  const head = stripBom(text).trimStart();
  if (head.startsWith("[")) return "json";
  if (head.startsWith("{")) {
    // One object per line is JSONL; one object spanning lines is JSON. The
    // difference is whether the first line closes on its own.
    const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
    try {
      JSON.parse(firstLine);
      return "jsonl";
    } catch {
      return "json";
    }
  }
  return "csv";
}

export function readRows(path: string, text: string, format?: UsageFormat): Row[] {
  const chosen = format ?? detectFormat(path, text);
  if (chosen === "csv") return csvToRows(text);
  if (chosen === "jsonl") return jsonlToRows(text);
  return jsonToRows(text);
}
