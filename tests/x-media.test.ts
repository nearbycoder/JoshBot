import assert from "node:assert/strict";
import test from "node:test";
import {
  extractXMedia,
  parseXPostId,
  uploadXMedia,
  XMediaError,
} from "../lib/x-media.js";
import { handleSlackSlashCommandPayload } from "../lib/slack-commands.js";

const id = "1546621144358391808";
const photo = {
  type: "photo",
  url: "https://pbs.twimg.com/media/photo.jpg",
  altText: "A galaxy",
};
const video = {
  type: "video",
  url: "https://video.twimg.com/ext_tw_video/1/pu/vid/movie.mp4?tag=12",
};
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const mp4 = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);
const request = {
  postId: id,
  userId: "U123",
  channelId: "C123",
  teamId: "T123",
};
const body = (items: unknown[] = [photo, video]) => ({
  code: 200,
  status: { id, type: "status", text: "", media: { all: items } },
});
const allow = async () => ({ allowed: true });
const response = (file = jpeg, type = "image/jpeg", headers = {}) =>
  new Response(file, { headers: { "content-type": type, ...headers } });

test("X links accept normal, mobile, legacy, i/web, media suffix and Slack-wrapped forms", () => {
  for (const link of [
    `https://x.com/NASA/status/${id}?s=20`,
    `https://twitter.com/NASA/status/${id}/photo/2`,
    `https://mobile.twitter.com/NASA/status/${id}`,
    `https://x.com/i/web/status/${id}`,
    `https://x.com/i/status/${id}/video/1`,
    `<https://x.com/NASA/status/${id}|NASA>`,
  ])
    assert.equal(parseXPostId(link), id);
  for (const link of [
    `http://x.com/u/status/${id}`,
    `https://x.com.evil.test/u/status/${id}`,
    `https://x.com@evil.test/u/status/${id}`,
    `https://u:p@x.com/u/status/${id}`,
    `https://x.com:123/u/status/${id}`,
    "https://x.com/NASA",
    "https://t.co/abc",
    `https://x.com/u/status/${id} more words`,
    "file:///etc/passwd",
    "https://127.0.0.1/u/status/12",
    `https://x.com/u/status/${id}/anything`,
  ])
    assert.throws(() => parseXPostId(link), XMediaError);
});

test("metadata preserves mixed-media order without fetching quoted posts, thumbnails, or duplicate arrays", () => {
  const data = body([video, photo, { ...video, type: "gif" }]);
  Object.assign(data.status.media, { photos: [photo], videos: [video] });
  assert.deepEqual(
    extractXMedia(data, id).map((x) => x.type),
    ["video", "photo", "gif"],
  );
  assert.equal(
    extractXMedia(
      {
        code: 200,
        status: { id, media: { photos: [photo], videos: [video] } },
      },
      id,
    ).length,
    2,
  );
  for (const data of [
    { code: 404 },
    { code: 401 },
    { code: 429 },
    { code: 500 },
    {},
    { code: 200, status: { id: "other" } },
    body([]),
    body(Array(5).fill(photo)),
  ]) {
    assert.throws(() => extractXMedia(data, id), XMediaError);
  }
});

test("metadata rejects untrusted hosts, credentials, ports, external embeds, playlists and malformed objects", () => {
  for (const url of [
    "https://127.0.0.1/media/x",
    "http://pbs.twimg.com/media/x",
    "https://pbs.twimg.com.evil.test/media/x",
    "https://u:p@pbs.twimg.com/media/x",
    "https://pbs.twimg.com:99/media/x",
    "https://pbs.twimg.com/profile_images/x",
  ]) {
    assert.throws(
      () => extractXMedia(body([{ ...photo, url }]), id),
      XMediaError,
    );
  }
  for (const item of [
    null,
    "bad",
    { type: "photo" },
    { type: "mosaic_photo" },
    { ...video, url: "https://video.twimg.com/movie.m3u8" },
  ]) {
    assert.throws(() => extractXMedia(body([item]), id), XMediaError);
  }
});

test("slash command and existing help alias return an authorized channel-bound media task and private progress", async () => {
  for (const [command, text] of [
    ["/nobo-x", `https://x.com/NASA/status/${id}`],
    ["/nobo-help", `x https://x.com/NASA/status/${id}`],
  ]) {
    const result = await handleSlackSlashCommandPayload(
      { command, text, channel_id: "C123", user_id: "U123", team_id: "T123" },
      { evaluateAccess: allow },
    );
    assert.deepEqual(result.media, request);
    assert.equal(result.response.response_type, "ephemeral");
    assert.equal(result.task, undefined);
  }
  for (const text of ["", "help", "https://example.com/unsafe"]) {
    assert.equal(
      (
        await handleSlackSlashCommandPayload(
          { command: "/nobo-x", text },
          { evaluateAccess: allow },
        )
      ).media,
      undefined,
    );
  }
  assert.equal(
    (
      await handleSlackSlashCommandPayload(
        {
          command: "/nobo-x",
          text: `https://x.com/u/status/${id}`,
          channel_id: "C123",
          user_id: "U123",
          team_id: "T123",
        },
        { evaluateAccess: async () => ({ allowed: false }) },
      )
    ).media,
    undefined,
  );
});

test("transfer downloads all media before one native upload, with no URL, post text, or auth sent to lookup", async () => {
  const calls: string[] = [];
  const count = await uploadXMedia(
    request,
    {
      filesUploadV2: async (args) => {
        calls.push("upload");
        assert.equal(args.channel_id, "C123");
        assert.equal(args.initial_comment, undefined);
        assert.equal(args.blocks, undefined);
        assert.ok("file_uploads" in args);
        assert.equal(args.file_uploads.length, 2);
        assert.equal(args.file_uploads[0].filename, `x-${id}-1.jpg`);
        assert.equal(args.file_uploads[1].filename, `x-${id}-2.mp4`);
        assert.equal(args.file_uploads[0].alt_text, "A galaxy");
        assert.ok("file" in args.file_uploads[0]);
        assert.ok("file" in args.file_uploads[1]);
        assert.deepEqual(args.file_uploads[0].file, jpeg);
        assert.deepEqual(args.file_uploads[1].file, mp4);
        return { ok: true, files: [] };
      },
    },
    {
      access: async (subject) => {
        calls.push("access");
        assert.equal(subject.teamId, "T123");
        return { allowed: true };
      },
      fetch: async (url, options) => {
        calls.push(String(url));
        assert.equal(options?.redirect, "error");
        assert.deepEqual(Object.keys(options?.headers ?? {}), ["User-Agent"]);
        assert.ok(options?.signal);
        if (String(url).includes("api.fxtwitter.com"))
          return Response.json(body());
        return String(url).includes("video.twimg.com")
          ? response(mp4, "video/mp4")
          : response();
      },
    },
  );
  assert.equal(count, 2);
  assert.deepEqual(calls, [
    "access",
    `https://api.fxtwitter.com/2/status/${id}`,
    photo.url,
    video.url,
    "access",
    "upload",
  ]);
});

test("failed, empty, oversized and non-media downloads never upload a partial set", async () => {
  for (const invalid of [
    () => new Response("no", { status: 403 }),
    () => response(Buffer.from("<html>no</html>"), "text/html"),
    () => response(Buffer.from("<html>fake jpeg</html>")),
    () => response(Buffer.alloc(0)),
    () =>
      response(jpeg, "image/jpeg", {
        "content-length": String(51 * 1024 * 1024),
      }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(50 * 1024 * 1024 + 1));
            controller.close();
          },
        }),
        { headers: { "content-type": "image/jpeg" } },
      ),
  ]) {
    let calls = 0;
    await assert.rejects(
      uploadXMedia(
        request,
        {
          filesUploadV2: async () => {
            assert.fail("must not upload");
          },
        },
        {
          access: allow,
          fetch: async () =>
            ++calls === 1
              ? Response.json(body([photo, photo]))
              : calls === 2
                ? response()
                : invalid(),
        },
      ),
      XMediaError,
    );
  }
});

test("post summary accompanies the files in one upload, before a final access recheck", async () => {
  const calls: string[] = [];
  const data = body([photo]); data.status.text = "A new space telescope image has been released.";
  Object.assign(data.status, { quote: { text: "Unrelated quoted content" } });
  const count = await uploadXMedia(request, { filesUploadV2: async (args) => {
    calls.push("upload");
    assert.equal(args.initial_comment, undefined);
    assert.deepEqual(args.blocks, [{ type: "section", text: { type: "plain_text", text: "Post summary (AI)\nThe post announces a new telescope image." } }]);
    assert.ok("file_uploads" in args); assert.equal(args.file_uploads.length, 1);
    return { ok: true, files: [] };
  } }, { access: async () => { calls.push("access"); return { allowed: true }; },
    fetch: async url => String(url).includes("api.fxtwitter") ? Response.json(data) : response(),
    summarize: async (text, channelId) => { calls.push("summary"); assert.equal(text, data.status.text); assert.equal(channelId, "C123"); return "The post announces a new telescope image."; }
  });
  assert.equal(count, 1); assert.deepEqual(calls, ["access", "summary", "access", "upload"]);
});

test("summary failure still uploads files without a caption, never a raw tweet fallback", async () => {
  const data = body([photo]); data.status.text = "Do not copy the whole tweet as a fallback.";
  assert.equal(await uploadXMedia(request, { filesUploadV2: async args => {
    assert.equal(args.blocks, undefined); assert.equal(args.initial_comment, undefined);
    return { ok: true, files: [] };
  } }, { access: allow, summarize: async () => { throw new Error("private model failure"); },
    fetch: async url => String(url).includes("api.fxtwitter") ? Response.json(data) : response()
  }), 1);
});

test("policy changes during summarization prevent both files and summary being shared", async () => {
  let allowed = true;
  await assert.rejects(uploadXMedia(request, { filesUploadV2: async () => assert.fail("do not share") }, {
    access: async () => ({ allowed }), summarize: async () => { allowed = false; return "A summary"; },
    fetch: async url => String(url).includes("api.fxtwitter") ? Response.json(body([photo])) : response()
  }), /access changed/);
});

test("denial before download or changed policy before upload prevents sharing", async () => {
  for (const allowedAtFirst of [false, true]) {
    let checks = 0;
    await assert.rejects(
      uploadXMedia(
        request,
        { filesUploadV2: async () => assert.fail("must not upload") },
        {
          access: async () => ({ allowed: ++checks === 1 && allowedAtFirst }),
          fetch: async (url) => {
            assert.ok(allowedAtFirst);
            return String(url).includes("api.fxtwitter")
              ? Response.json(body([photo]))
              : response();
          },
        },
      ),
      /access/i,
    );
  }
});

test("transfer errors are useful, avoid leaking raw provider data, and always release the transfer slot", async () => {
  const deps = {
    access: allow,
    fetch: (async (url: unknown) =>
      String(url).includes("api.fxtwitter")
        ? Response.json(body([photo]))
        : response()) as typeof fetch,
  };
  for (const [error, expected] of [
    [{ data: { error: "missing_scope" } }, /files:write/],
    [{ data: { error: "not_in_channel" } }, /Invite NoBo/],
    [new Error("secret signed url token"), /Check the channel before retrying/],
  ] as const) {
    await assert.rejects(
      uploadXMedia(
        request,
        {
          filesUploadV2: async () => {
            throw error;
          },
        },
        deps,
      ),
      expected,
    );
  }
  assert.equal(
    await uploadXMedia(
      request,
      { filesUploadV2: async () => ({ ok: true, files: [] }) },
      deps,
    ),
    1,
  );
});

test("overlapping transfers are rejected rather than multiplying download memory", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = uploadXMedia(
    request,
    { filesUploadV2: async () => ({ ok: true, files: [] }) },
    {
      access: allow,
      fetch: async (url) => {
        await wait;
        return String(url).includes("api.fxtwitter")
          ? Response.json(body([photo]))
          : response();
      },
    },
  );
  try {
    await assert.rejects(
      uploadXMedia(request, { filesUploadV2: async () => assert.fail() }),
      /already transferring/,
    );
  } finally {
    release();
    await first;
  }
});
