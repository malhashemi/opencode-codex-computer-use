import { runOnHost, type Host } from "./host"

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

// On-device text recognition with macOS's Vision framework, run through JavaScript for Automation. The image
// arrives on stdin, so the same command works on this machine and over SSH without temporary files; osascript
// prints the JSON the script returns.
const SCRIPT = `ObjC.import("Vision"); ObjC.import("AppKit");
(() => {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const image = $.NSImage.alloc.initWithData(data);
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
})()`

/** Recognizes the text in a screenshot on the machine that runs Computer Use. */
export async function recognizeText(host: Host, image: Uint8Array, timeoutMs = 30_000): Promise<OcrResult> {
  if ((await host.info()).platform !== "darwin") {
    throw new Error("on-device OCR needs macOS on the Computer Use machine; use the accessibility tree")
  }
  const stdout = await runOnHost(host, "/usr/bin/osascript", ["-l", "JavaScript", "-e", SCRIPT], {
    input: image,
    timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(stdout) as OcrResult
}

/** Reading order: top to bottom, then left to right within roughly the same row. */
export function formatOcr(result: OcrResult, index: number): string {
  const rowHeight = Math.max(4, Math.round(result.height / 150))
  const lines = result.lines.toSorted((a, b) => Math.round(a.y / rowHeight) - Math.round(b.y / rowHeight) || a.x - b.x)
  const header =
    `Screenshot ${index} as text (on-device OCR, ${result.width}x${result.height} px; ` +
    "[x,y] is the center of each line in screenshot pixels):"
  if (lines.length === 0) return `${header}\n(no text recognized)`
  return [header, ...lines.map((line) => `[${line.x},${line.y}] ${line.text}`)].join("\n")
}
