import type { IncomingMessage } from "node:http";

const DEFAULT_SLACK_REQUEST_MAX_BYTES = 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes.`);
    this.name = "RequestBodyTooLargeError";
  }
}

export async function readLimitedRequestBody(
  request: Request,
  maxBytes = getSlackRequestMaxBytes()
) {
  rejectLargeContentLength(request.headers.get("content-length"), maxBytes);

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const chunk = Buffer.from(value);
    totalBytes += chunk.byteLength;

    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError(maxBytes);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export function readLimitedNodeRequestBody(
  request: IncomingMessage,
  maxBytes = getSlackRequestMaxBytes()
) {
  rejectLargeContentLength(request.headers["content-length"], maxBytes);

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;

      if (totalBytes > maxBytes) {
        request.destroy(new RequestBodyTooLargeError(maxBytes));
        return;
      }

      chunks.push(buffer);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks, totalBytes).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function rejectLargeContentLength(value: string | string[] | undefined | null, maxBytes: number) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const contentLength = Number(rawValue ?? "0");

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }
}

export function getSlackRequestMaxBytes() {
  const rawValue = process.env.SLACK_REQUEST_MAX_BYTES;
  const value = rawValue ? Number(rawValue) : DEFAULT_SLACK_REQUEST_MAX_BYTES;

  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SLACK_REQUEST_MAX_BYTES;
}
