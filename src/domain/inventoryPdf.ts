/**
 * Text extraction for the ReVamp Material Tracker's printed PDF. pdf.js gives
 * positioned text runs; runs sharing a baseline are joined left-to-right into
 * lines, which the inventory parser then reads like pasted text (the trailing
 * number on a line is the count).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * pdf.js's Node "fake worker" imports its worker module from disk. Resolve it
 * from node_modules in dev, or from the file copied next to the serverless
 * function entry by scripts/build-vercel.mjs (cwd = /var/task on Vercel).
 */
function resolveWorkerSrc(): string | null {
  const candidates = [
    process.env.PDF_WORKER_PATH,
    process.env.LAMBDA_TASK_ROOT &&
      path.join(process.env.LAMBDA_TASK_ROOT, "pdf.worker.mjs"),
    path.join(process.cwd(), "pdf.worker.mjs"),
    (() => {
      try {
        return createRequire(import.meta.url).resolve(
          "pdfjs-dist/legacy/build/pdf.worker.mjs"
        );
      } catch {
        return undefined;
      }
    })(),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return pathToFileURL(p).href;
  }
  return null;
}

interface TextRun {
  x: number;
  w: number;
  s: string;
}

/**
 * Join a baseline's runs left-to-right. The tracker's PDFs split words into
 * many tiny runs, so a space is only real when there's an actual horizontal
 * gap between one run's end and the next run's start.
 */
function joinRuns(runs: TextRun[]): string {
  const sorted = [...runs].sort((a, b) => a.x - b.x);
  let out = "";
  let end = null as number | null;
  for (const r of sorted) {
    if (end !== null) {
      const gap = r.x - end;
      if (gap > 1.5) out += " ";
    }
    out += r.s;
    end = r.x + r.w;
  }
  return out.replace(/\s+/g, " ").trim();
}

export async function pdfToTextLines(data: Uint8Array): Promise<string[]> {
  // Dynamic import keeps pdf.js out of the startup path — it's only paid for
  // when someone actually uploads a PDF.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerSrc = resolveWorkerSrc();
  if (workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
  }).promise;

  const lines: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();

      // Bucket runs by baseline y (±2pt tolerance).
      const rows = new Map<number, TextRun[]>();
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const y = item.transform[5] as number;
        let key: number | undefined;
        for (const k of rows.keys()) {
          if (Math.abs(k - y) <= 2) {
            key = k;
            break;
          }
        }
        key ??= Math.round(y);
        const runs = rows.get(key) ?? [];
        runs.push({
          x: item.transform[4] as number,
          w: (item.width as number) || 0,
          s: item.str,
        });
        rows.set(key, runs);
      }

      // Top of the page has the largest y.
      for (const [, runs] of [...rows.entries()].sort((a, b) => b[0] - a[0])) {
        const line = joinRuns(runs);
        if (line) lines.push(line);
      }
    }
  } finally {
    await doc.destroy();
  }
  return lines;
}
