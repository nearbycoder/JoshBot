import type { PromptImage } from "@flue/runtime";

export type NoboTextPart = {
  type: "text";
  text: string;
};

export type NoboImagePart = {
  type: "image";
  image: Buffer;
  mediaType?: string;
};

export type NoboModelMessage = {
  role: "user" | "assistant";
  content: string | Array<NoboTextPart | NoboImagePart>;
};

export function modelMessagesToPrompt(messages: NoboModelMessage[]) {
  const lines: string[] = [];
  const images: PromptImage[] = [];

  for (const message of messages) {
    const label = message.role === "assistant" ? "Assistant" : "User";

    if (typeof message.content === "string") {
      if (message.content.trim()) {
        lines.push(`${label}: ${message.content.trim()}`);
      }
      continue;
    }

    const textParts: string[] = [];

    for (const part of message.content) {
      if (part.type === "text" && part.text.trim()) {
        textParts.push(part.text.trim());
      }

      if (part.type === "image") {
        images.push({
          type: "image",
          data: part.image.toString("base64"),
          mimeType: part.mediaType || "image/png"
        });
      }
    }

    if (textParts.length > 0) {
      lines.push(`${label}: ${textParts.join("\n")}`);
    } else if (message.role === "user") {
      lines.push("User shared an attachment.");
    }
  }

  return {
    text: lines.join("\n\n"),
    images
  };
}
