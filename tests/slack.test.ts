import assert from "node:assert/strict";
import test from "node:test";
import { __testing, isSlackDirectMessage } from "../lib/slack.js";

test("detects Slack IM events by channel_type", () => {
  assert.equal(
    isSlackDirectMessage({
      channel: "C123",
      channel_type: "im",
      text: "hello",
      ts: "1000.000"
    }),
    true
  );
});

test("detects Slack D-prefixed direct message channels", () => {
  assert.equal(
    isSlackDirectMessage({
      channel: "D123",
      text: "hello",
      ts: "1000.000"
    }),
    true
  );
});

test("does not classify normal channel messages as direct messages", () => {
  assert.equal(
    isSlackDirectMessage({
      channel: "C123",
      channel_type: "channel",
      text: "hello",
      ts: "1000.000"
    }),
    false
  );
});

test("uses one idempotency lock key for the same Slack message across handlers", () => {
  const event = {
    channel: "C123",
    text: "<@U999> hello",
    thread_ts: "1000.000",
    ts: "1001.000"
  };

  assert.equal(
    __testing.getSlackEventLockKey(event, "mention"),
    __testing.getSlackEventLockKey(event, "thread-reply")
  );
  assert.equal(
    __testing.getSlackEventLockKey(event, "mention"),
    "slack-event-lock:C123:1000.000:1001.000"
  );
});

test("active listening reply slots cap concurrent channel replies", () => {
  const originalLimit = process.env.NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES;
  process.env.NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES = "2";

  const first = __testing.acquireActiveListeningReplySlot("C-SLOTS");
  const second = __testing.acquireActiveListeningReplySlot("C-SLOTS");
  const third = __testing.acquireActiveListeningReplySlot("C-SLOTS");

  try {
    assert.equal(__testing.getActiveListeningMaxConcurrentReplies(), 2);
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, true);
    assert.equal(third.acquired, false);

    first.release();
    const afterRelease = __testing.acquireActiveListeningReplySlot("C-SLOTS");

    try {
      assert.equal(afterRelease.acquired, true);
    } finally {
      afterRelease.release();
    }
  } finally {
    first.release();
    second.release();

    if (originalLimit === undefined) {
      delete process.env.NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES;
    } else {
      process.env.NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES = originalLimit;
    }
  }
});

test("builds Slack App Home dashboard sections", () => {
  const view = __testing.buildSlackAppHomeView({
    userId: "U123",
    memories: ["prefers concise updates"],
    schedules: [
      {
        id: "abcdef123456",
        summary: "one-time reminder for Jun 25, 2026, 12:00 PM: check logs",
        nextRunAt: "2026-06-25T17:00:00.000Z"
      }
    ],
    artifacts: [
      {
        id: "00000000-0000-4000-8000-000000000000",
        kind: "markdown",
        filename: "launch-plan.md",
        title: "launch plan",
        rawUrl: "https://example.test/artifacts/00000000-0000-4000-8000-000000000000/launch-plan.md",
        previewUrl: "https://example.test/artifacts/00000000-0000-4000-8000-000000000000/preview",
        path: "/tmp/launch-plan.md",
        createdAt: "2026-06-25T15:00:00.000Z",
        updatedAt: "2026-06-25T15:00:00.000Z",
        bytes: 12,
        shortId: "00000000",
        expired: false
      }
    ],
    channelStatuses: [
      {
        channelId: "C123",
        activeListening: true,
        memoryCount: 4,
        modelId: "deepseek-v4-pro",
        modelName: "DeepSeek V4 Pro",
        modelSource: "channel"
      }
    ],
    preferences: {
      timeZone: "America/Chicago",
      verbosity: "concise",
      newsInterests: ["ai"],
      reminderStyle: "gentle"
    },
    updatedAt: new Date("2026-06-25T16:00:00.000Z")
  });
  const rendered = JSON.stringify(view);

  assert.equal(view.type, "home");
  assert.match(rendered, /Reminders/);
  assert.match(rendered, /prefers concise updates/);
  assert.match(rendered, /<#C123> \(4\)/);
  assert.match(rendered, /DeepSeek V4 Pro/);
  assert.match(rendered, /deepseek-v4-pro/);
  assert.match(rendered, /launch plan/);
  assert.match(rendered, /Quick Actions/);
  assert.match(rendered, /nobo_open_modal:prefs/);
  assert.match(rendered, /\/nobo-channel-digest/);
  assert.match(rendered, /gentle/);
});

test("extracts text-like Slack uploads into message context", async (t) => {
  const originalFetch = globalThis.fetch;
  const downloadUrl = "https://files.slack.com/files-pri/T123-FCSV/download/report.csv";

  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), downloadUrl);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer xoxb-test");

    return new Response("name,total\nalpha,12\nbeta,9\n", {
      headers: {
        "content-length": "29",
        "content-type": "text/csv"
      }
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const content = await __testing.buildSlackMessageContent("xoxb-test", {
    text: "<@U999> summarize this",
    files: [
      {
        id: "FCSV",
        name: "report.csv",
        mimetype: "text/csv",
        filetype: "csv",
        pretty_type: "CSV",
        size: 29,
        url_private_download: downloadUrl
      }
    ]
  });

  assert.match(content, /summarize this/);
  assert.match(content, /Attached CSV: report\.csv/);
  assert.match(content, /Attachment metadata: MIME text\/csv; Slack type csv; size 29 B/);
  assert.match(content, /Attachment extracted text:\nname,total\nalpha,12\nbeta,9/);
});

test("uses Slack previews and reports current binary document limits", async () => {
  const pdfContent = await __testing.buildSlackMessageContent("xoxb-test", {
    files: [
      {
        id: "FPDF",
        name: "brief.pdf",
        mimetype: "application/pdf",
        filetype: "pdf",
        pretty_type: "PDF",
        preview_plain_text: "Quarterly findings and risks."
      }
    ]
  });

  assert.match(pdfContent, /Attached PDF: brief\.pdf/);
  assert.match(pdfContent, /Attachment extracted text:\nQuarterly findings and risks\./);
  assert.doesNotMatch(pdfContent, /limited to Slack-provided previews/);

  const xlsxContent = await __testing.buildSlackMessageContent("xoxb-test", {
    files: [
      {
        id: "FXLSX",
        name: "forecast.xlsx",
        mimetype: "application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filetype: "xlsx",
        pretty_type: "Excel Spreadsheet"
      }
    ]
  });

  assert.match(xlsxContent, /Attached Excel Spreadsheet: forecast\.xlsx/);
  assert.match(xlsxContent, /binary spreadsheet extraction is limited/);
});

test("keeps image parts while adding text attachment context", async (t) => {
  const originalFetch = globalThis.fetch;
  const imageUrl = "https://files.slack.com/files-pri/T123-FIMG/download/photo.png";
  const textUrl = "https://files.slack.com/files-pri/T123-FTXT/download/notes.txt";
  const imageBytes = new Uint8Array([137, 80, 78, 71]);

  globalThis.fetch = (async (input) => {
    const url = String(input);

    if (url === imageUrl) {
      return new Response(imageBytes, {
        headers: {
          "content-length": String(imageBytes.byteLength),
          "content-type": "image/png"
        }
      });
    }

    if (url === textUrl) {
      return new Response("first note\nsecond note", {
        headers: {
          "content-length": "22",
          "content-type": "text/plain"
        }
      });
    }

    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const content = await __testing.buildLiveUserContent(
    "xoxb-test",
    {
      channel: "D123",
      channel_type: "im",
      text: "what is here?",
      ts: "1000.000",
      user: "U123",
      files: [
        {
          id: "FIMG",
          name: "photo.png",
          mimetype: "image/png",
          filetype: "png",
          pretty_type: "PNG",
          url_private_download: imageUrl
        },
        {
          id: "FTXT",
          name: "notes.txt",
          mimetype: "text/plain",
          filetype: "text",
          pretty_type: "Plain Text",
          url_private_download: textUrl
        }
      ]
    },
    "U123"
  );

  assert.ok(Array.isArray(content));

  const imagePart = content.find((part) => part.type === "image");
  assert.ok(imagePart);
  assert.deepEqual(imagePart.image, Buffer.from(imageBytes));

  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.match(text, /Current user \(U123\): what is here\?/);
  assert.match(text, /Attachment extracted text:\nfirst note\nsecond note/);
});
