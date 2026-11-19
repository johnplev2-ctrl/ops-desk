// RFC 4180 CSV with spreadsheet formula neutralisation.

export type Cell = string | number | null | undefined;

// A cell that starts with one of these is read as a formula by Excel / Sheets / LibreOffice.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "number" ? String(value) : value;
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 BOM first so Excel reads accents and the euro sign correctly. */
export function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function iso(ms: number | null | undefined): string {
  return typeof ms === "number" ? new Date(ms).toISOString() : "";
}
