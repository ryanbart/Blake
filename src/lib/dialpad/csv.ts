/**
 * Minimal RFC 4180 CSV reader for the Dialpad stats export.
 *
 * Hand-rolled rather than pulled in as a dependency because the export contains
 * disposition notes typed by reps — free text with embedded commas, quotes, and
 * newlines. A naive `split(",")` corrupts exactly the rows that matter most, so
 * the quoting rules are handled properly here and covered by tests.
 */

/** Split CSV text into rows of raw cells. Handles quotes, escaped quotes ("" ), CRLF. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // A leading BOM otherwise becomes part of the first header name.
  if (input.charCodeAt(0) === 0xfeff) i = 1;

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // Swallow CR; the LF that follows ends the row.
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Trailing row without a newline terminator.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Parse CSV into objects keyed by header.
 *
 * Rows with fewer cells than headers are padded rather than dropped: a rep who
 * left the trailing notes column empty should still produce a usable call row.
 */
export function parseCsvRecords(input: string): Record<string, string>[] {
  const rows = parseCsv(input).filter(
    (r) => r.length > 1 || (r[0] ?? "").trim() !== "",
  );
  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, idx) => {
      record[header] = (cells[idx] ?? "").trim();
    });
    return record;
  });
}
