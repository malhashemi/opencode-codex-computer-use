import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface OcrLine {
  text: string
  /** Center of the line in screenshot pixels. */
  x: number
  y: number
}

export interface OcrResult {
  width: number
  height: number
  lines: OcrLine[]
}

// On-device text recognition with macOS's Vision framework, run through JavaScript for Automation.
const SCRIPT = `
ObjC.import("Vision"); ObjC.import("AppKit");
function run(argv) {
  const image = $.NSImage.alloc.initWithContentsOfURL($.NSURL.fileURLWithPath(argv[0]));
  const cg = image.CGImageForProposedRectContextHints(null, $(), $());
  const w = Number($.CGImageGetWidth(cg)), h = Number($.CGImageGetHeight(cg));
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = true;
  $.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $()).performRequestsError($([request]), $());
  const lines = [];
  const results = request.results;
  for (let i = 0; i < results.count; i++) {
    const item = results.objectAtIndex(i);
    const box = item.boundingBox;
    lines.push({
      text: item.topCandidates(1).objectAtIndex(0).string.js,
      x: Math.round((box.origin.x + box.size.width / 2) * w),
      y: Math.round((1 - box.origin.y - box.size.height / 2) * h),
    });
  }
  return JSON.stringify({ width: w, height: h, lines });
}`

export async function recognizeText(image: Uint8Array, timeoutMs = 30_000): Promise<OcrResult> {
  if (process.platform !== "darwin") {
    throw new Error("on-device OCR is currently only available on macOS; use the accessibility tree")
  }
  const directory = await mkdtemp(join(tmpdir(), "codex-cu-ocr-"))
  try {
    const imagePath = join(directory, "screenshot")
    const scriptPath = join(directory, "ocr.js")
    await Promise.all([writeFile(imagePath, image), writeFile(scriptPath, SCRIPT)])
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        "/usr/bin/osascript",
        ["-l", "JavaScript", scriptPath, imagePath],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, out, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(out)),
      ),
    )
    return JSON.parse(stdout) as OcrResult
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Reading order: top to bottom, then left to right within roughly the same row. */
export function formatOcr(result: OcrResult, index: number): string {
  const rowHeight = Math.max(4, Math.round(result.height / 150))
  const lines = [...result.lines].sort(
    (a, b) => Math.round(a.y / rowHeight) - Math.round(b.y / rowHeight) || a.x - b.x,
  )
  const header =
    `Screenshot ${index} as text (on-device OCR, ${result.width}x${result.height} px; ` +
    "[x,y] is the center of each line in screenshot pixels):"
  if (lines.length === 0) return `${header}\n(no text recognized)`
  return [header, ...lines.map((line) => `[${line.x},${line.y}] ${line.text}`)].join("\n")
}
