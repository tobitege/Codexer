import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AUTO_DETAIL_PARSE_LIMIT_BYTES,
  MAX_JSONL_LINE_BYTES_HARD,
  exportSessionJsonlToMarkdown,
  findCodexSessions,
  getSessionDetailMetrics,
  readSessionTokenUsage,
} from "./codlogs-core.ts";
import {
  buildCodexCurrentDayRolloutPath,
  buildCodexRolloutFileName,
  formatCodexRolloutTimestamp,
  generateUuidV7String,
} from "./codex-rollout.ts";
import {
  type OriginalResponseItemSlot,
  type SanitizedResponseItem,
  extractCompactionEncryptedContentFromJsonlLine,
  extractResponseItemMetadataFromJsonlLine,
  mapSanitizedResponseItemTimestamps,
  mergeSanitizedResponseItemsWithOriginalSequence,
  reconstructSanitizedResponseItems,
  sanitizeCompactedRolloutLine,
  sanitizeEventMsgJsonlLine,
  sanitizeResponseItemJsonlLine,
  sanitizeTurnContextJsonlLine,
} from "./sanitized-session.ts";
import {
  MAX_SESSION_TITLE_LENGTH,
  normalizeSessionTitle,
  sanitizeSessionTitleInput,
} from "./session-title.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) {
      continue;
    }

    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

async function writeSessionMetaFile(options: {
  codexHome: string;
  rootName: "sessions" | "archived_sessions";
  folderDate: string;
  id: string;
  cwd: string;
  metadataTimestamp: string;
}): Promise<string> {
  const [year = "0000", month = "00", day = "00"] = options.folderDate.split("-");
  const sessionDirectory = path.join(options.codexHome, options.rootName, year, month, day);
  const sessionPath = path.join(sessionDirectory, `${options.id}.jsonl`);
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(
    sessionPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: options.id,
        cwd: options.cwd,
        timestamp: options.metadataTimestamp,
      },
    })}\n`,
  );
  return sessionPath;
}

describe("codex rollout naming helpers", () => {
  test("formats canonical rollout timestamps with local second precision", () => {
    const date = new Date(2026, 2, 17, 9, 8, 7, 654);

    expect(formatCodexRolloutTimestamp(date)).toBe("2026-03-17T09-08-07");
  });

  test("generates UUIDv7 thread ids", () => {
    const threadId = generateUuidV7String(
      new Date(2026, 2, 17, 9, 8, 7, 654),
      new Uint8Array([
        0x10, 0x11, 0x12, 0x13,
        0x14, 0x15, 0x16, 0x17,
        0x18, 0x19, 0x1a, 0x1b,
        0x1c, 0x1d, 0x1e, 0x1f,
      ]),
    );

    expect(threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("builds canonical current-day rollout paths", () => {
    const date = new Date(2026, 2, 17, 9, 8, 7, 654);
    const threadId = "0195a7d2-93f1-7abc-8def-0123456789ab";

    expect(buildCodexRolloutFileName(threadId, date)).toBe(
      "rollout-2026-03-17T09-08-07-0195a7d2-93f1-7abc-8def-0123456789ab.jsonl",
    );
    expect(buildCodexCurrentDayRolloutPath("C:\\Users\\tobias\\.codex", threadId, date)).toBe(
      path.join(
        "C:\\Users\\tobias\\.codex",
        "sessions",
        "2026",
        "03",
        "17",
        "rollout-2026-03-17T09-08-07-0195a7d2-93f1-7abc-8def-0123456789ab.jsonl",
      ),
    );
  });
});

describe("session title sanitization", () => {
  test("removes control and bidi characters and collapses whitespace", () => {
    expect(
      sanitizeSessionTitleInput("  Hello\u0000\tworld\u202E  from\r\nCodex  "),
    ).toBe("Hello world from Codex");
  });

  test("returns null for empty sanitized titles and caps length", () => {
    expect(normalizeSessionTitle(" \n\t ")).toBeNull();
    expect(
      sanitizeSessionTitleInput("x".repeat(MAX_SESSION_TITLE_LENGTH + 20)).length,
    ).toBe(MAX_SESSION_TITLE_LENGTH);
  });
});

describe("session discovery filters", () => {
  test("filters sessions by Codex folder date before metadata timestamps", async () => {
    const tempDir = await createTempDir("codlogs-date-filter-");
    const codexHome = path.join(tempDir, ".codex");
    const repoPath = path.join(tempDir, "repo");
    await fs.mkdir(repoPath, { recursive: true });

    await writeSessionMetaFile({
      codexHome,
      rootName: "sessions",
      folderDate: "2026-03-27",
      id: "folder-date-match",
      cwd: repoPath,
      metadataTimestamp: "2026-04-30T10:00:00.000Z",
    });
    await writeSessionMetaFile({
      codexHome,
      rootName: "sessions",
      folderDate: "2026-04-30",
      id: "metadata-only-match",
      cwd: repoPath,
      metadataTimestamp: "2026-03-27T10:00:00.000Z",
    });
    await writeSessionMetaFile({
      codexHome,
      rootName: "archived_sessions",
      folderDate: "2026-03-27",
      id: "archived-folder-date-match",
      cwd: repoPath,
      metadataTimestamp: "2026-04-30T11:00:00.000Z",
    });

    const result = await findCodexSessions({
      codexHome,
      currentWorkingDirectory: repoPath,
      dateFrom: "2026-03-27",
      dateTo: "2026-03-27",
    });

    expect(result.sessions.map((session) => session.id).sort()).toEqual([
      "archived-folder-date-match",
      "folder-date-match",
    ]);
  });
});

describe("large-session hardening", () => {
  test("skips automatic detail analysis for oversized files", async () => {
    const tempDir = await createTempDir("codlogs-large-session-");
    const sessionPath = path.join(tempDir, "too-large.jsonl");

    await fs.writeFile(sessionPath, "");
    await fs.truncate(sessionPath, AUTO_DETAIL_PARSE_LIMIT_BYTES + 1);

    const metrics = await getSessionDetailMetrics(sessionPath);

    expect(metrics.analysisKind).toBe("skipped");
    expect(metrics.fileSizeBytes).toBe(AUTO_DETAIL_PARSE_LIMIT_BYTES + 1);
    expect(metrics.skipReason).toContain("Automatic analysis is disabled");
    expect(metrics.interactionCount).toBe(0);
    expect(metrics.toolCallCount).toBe(0);
    expect(metrics.tokenUsage).toBeNull();
  });

  test("returns the latest cumulative token usage from token count rows", async () => {
    const tempDir = await createTempDir("codlogs-token-usage-");
    const sessionPath = path.join(tempDir, "token-usage.jsonl");

    const userMessage = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      timestamp: "2026-03-14T12:00:00.000Z",
    });
    const tokenCount = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 40657493,
            cached_input_tokens: 38628608,
            output_tokens: 138294,
            reasoning_output_tokens: 56128,
            total_tokens: 40795787,
          },
        },
      },
      timestamp: "2026-03-14T12:01:00.000Z",
    });

    await fs.writeFile(sessionPath, `${userMessage}\n${tokenCount}\n`);

    const metrics = await getSessionDetailMetrics(sessionPath);

    expect(metrics.interactionCount).toBe(1);
    expect(metrics.tokenUsage).toEqual({
      inputTokens: 40657493,
      cachedInputTokens: 38628608,
      outputTokens: 138294,
      reasoningOutputTokens: 56128,
      totalTokens: 40795787,
    });
  });

  test("scans token usage without parsing unrelated transcript rows", async () => {
    const tempDir = await createTempDir("codlogs-token-scan-");
    const sessionPath = path.join(tempDir, "token-scan.jsonl");

    const unrelatedRow = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "x".repeat(1024),
      },
    });
    const tokenCount = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 12,
            reasoning_output_tokens: 5,
            total_tokens: 112,
          },
        },
      },
    });

    await fs.writeFile(sessionPath, `${unrelatedRow}\n${tokenCount}\n`);

    const progressEvents: number[] = [];
    const result = await readSessionTokenUsage(sessionPath, {
      onProgress: (progress) => {
        progressEvents.push(progress.bytesProcessed);
      },
    });

    expect(result.tokenCountRows).toBe(1);
    expect(result.oversizedLineCount).toBe(0);
    expect(result.tokenUsage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 12,
      reasoningOutputTokens: 5,
      totalTokens: 112,
    });
    expect(progressEvents.at(-1)).toBe(result.fileSizeBytes);
  });

  test("returns partial detail metrics when a row exceeds the bounded line limit", async () => {
    const tempDir = await createTempDir("codlogs-oversized-row-");
    const sessionPath = path.join(tempDir, "oversized-row.jsonl");
    const fileHandle = await fs.open(sessionPath, "w");

    const userMessage = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello from a normal row" }],
      },
      timestamp: "2026-03-14T12:00:00.000Z",
    });

    try {
      await fileHandle.writeFile(`${userMessage}\n`);
      const oversizedRow = new Uint8Array(MAX_JSONL_LINE_BYTES_HARD + 1024);
      oversizedRow.fill(120);
      await fileHandle.writeFile(oversizedRow);
      await fileHandle.writeFile("\n");
    } finally {
      await fileHandle.close();
    }

    const metrics = await getSessionDetailMetrics(sessionPath, {
      forceDeepAnalysis: true,
    });

    expect(metrics.analysisKind).toBe("partial");
    expect(metrics.interactionCount).toBe(1);
    expect(metrics.toolCallCount).toBe(0);
    expect(metrics.oversizedLineCount).toBe(1);
    expect(metrics.largestParsedLineBytes).toBeGreaterThan(MAX_JSONL_LINE_BYTES_HARD);
    expect(metrics.skipReason).toContain("oversized row");
  }, 20000);

  test("streams markdown export for a normal session transcript", async () => {
    const tempDir = await createTempDir("codlogs-export-");
    const sessionPath = path.join(tempDir, "normal-session.jsonl");

    const sessionMeta = JSON.stringify({
      type: "session_meta",
      payload: {
        id: "session-test-id",
        cwd: "D:\\github\\codlogs",
      },
      timestamp: "2026-03-14T12:00:00.000Z",
    });
    const userMessage = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello from the user" }],
      },
      timestamp: "2026-03-14T12:01:00.000Z",
    });
    const assistantMessage = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello from the assistant" }],
      },
      timestamp: "2026-03-14T12:02:00.000Z",
    });

    await fs.writeFile(
      sessionPath,
      `${sessionMeta}\n${userMessage}\n${assistantMessage}\n`,
      "utf8",
    );

    const outputPath = await exportSessionJsonlToMarkdown(sessionPath);
    const markdown = await fs.readFile(outputPath, "utf8");

    expect(outputPath.endsWith(".md")).toBe(true);
    expect(markdown).toContain("Hello from the user");
    expect(markdown).toContain("Hello from the assistant");
  });

  test("extracts encrypted compaction payloads without parsing the full row", () => {
    const line =
      '{"timestamp":"2026-03-16T12:00:00.000Z","type":"response_item","payload":{"type":"compaction","encrypted_content":"gAAAAABexamplePayload=="}}';

    expect(extractCompactionEncryptedContentFromJsonlLine(line)).toBe(
      "gAAAAABexamplePayload==",
    );
  });

  test("extracts response-item timestamp metadata without parsing the full row", () => {
    const line =
      '{"timestamp":"2026-03-16T12:01:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}';

    expect(extractResponseItemMetadataFromJsonlLine(line)).toEqual({
      timestamp: "2026-03-16T12:01:02.000Z",
      payloadType: "message",
    });
  });

  test("reconstructs a text-only history from readable thread items", () => {
    const reconstructed = reconstructSanitizedResponseItems({
      turns: [
        {
          items: [
            {
              type: "userMessage",
              content: [
                { type: "text", text: "Please explain this screenshot" },
                { type: "image", url: "data:image/png;base64,AAAA" },
              ],
            },
            {
              type: "reasoning",
              summary: ["Inspecting the screenshot"],
              content: ["The UI shows a warning banner."],
            },
            {
              type: "agentMessage",
              text: "The screenshot shows a warning banner about skipped analysis.",
            },
            {
              type: "commandExecution",
              command: "rg skipped src",
              cwd: "d:\\github\\codlogs",
              status: "completed",
            },
            {
              type: "contextCompaction",
            },
          ],
        },
      ],
    });

    expect(reconstructed.stats.droppedInputImageCount).toBe(1);
    expect(reconstructed.stats.preservedReasoningCount).toBe(1);
    expect(reconstructed.stats.preservedCommandExecutionCount).toBe(1);
    expect(reconstructed.stats.omittedThreadItemCounts.contextCompaction).toBe(1);
    expect(reconstructed.responseItems).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Please explain this screenshot\n<image removed>",
          },
        ],
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Inspecting the screenshot" }],
        content: [{ type: "text", text: "The UI shows a warning banner." }],
        encrypted_content: null,
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "The screenshot shows a warning banner about skipped analysis.",
          },
        ],
      },
      {
        type: "local_shell_call",
        call_id: null,
        status: "completed",
        action: {
          type: "exec",
          command: ["rg skipped src"],
          timeout_ms: null,
          working_directory: "d:\\github\\codlogs",
          env: null,
          user: null,
        },
      },
    ]);
  });

  test("maps reconstructed items back to original response-item timestamps", () => {
    const responseItems: SanitizedResponseItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "thinking" }],
        content: [{ type: "text", text: "details" }],
        encrypted_content: null,
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    ];

    const timestamps = mapSanitizedResponseItemTimestamps(responseItems, [
      { timestamp: "2026-03-14T12:01:00.000Z", payloadType: "message" },
      { timestamp: "2026-03-14T12:01:30.000Z", payloadType: "compaction" },
      { timestamp: "2026-03-14T12:02:00.000Z", payloadType: "reasoning" },
      { timestamp: "2026-03-14T12:03:00.000Z", payloadType: "message" },
    ]);

    expect(timestamps).toEqual([
      "2026-03-14T12:01:00.000Z",
      "2026-03-14T12:02:00.000Z",
      "2026-03-14T12:03:00.000Z",
    ]);
  });

  test("keeps original compaction rows in the sanitized write sequence", () => {
    const responseItems: SanitizedResponseItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    ];
    const originalSlots: OriginalResponseItemSlot[] = [
      {
        kind: "sanitizable",
        timestamp: "2026-03-14T12:01:00.000Z",
        payloadType: "message",
      },
      {
        kind: "compaction",
        line: '{"timestamp":"2026-03-14T12:01:30.000Z","type":"response_item","payload":{"type":"compaction","encrypted_content":"gAAAAABexamplePayload=="}}',
        timestamp: "2026-03-14T12:01:30.000Z",
        payloadType: "compaction",
      },
      {
        kind: "sanitizable",
        timestamp: "2026-03-14T12:02:00.000Z",
        payloadType: "message",
      },
    ];
    const compactionLine =
      '{"timestamp":"2026-03-14T12:01:30.000Z","type":"response_item","payload":{"type":"compaction","encrypted_content":"gAAAAABexamplePayload=="}}';

    originalSlots[1] = {
      kind: "compaction",
      line: compactionLine,
      timestamp: "2026-03-14T12:01:30.000Z",
      payloadType: "compaction",
    };

    expect(
      mergeSanitizedResponseItemsWithOriginalSequence(responseItems, originalSlots),
    ).toEqual([
      {
        kind: "sanitized",
        timestamp: "2026-03-14T12:01:00.000Z",
        payload: responseItems[0],
      },
      {
        kind: "raw",
        line: compactionLine,
      },
      {
        kind: "sanitized",
        timestamp: "2026-03-14T12:02:00.000Z",
        payload: responseItems[1],
      },
    ]);
  });

  test("sanitizes compacted rollout replacement history while preserving the row", () => {
    const line = JSON.stringify({
      type: "compacted",
      payload: {
        message: "Context compacted.",
        replacement_history: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Look at this" },
              { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            ],
          },
          {
            type: "compaction",
            encrypted_content: "gAAAAABexamplePayload==",
          },
        ],
      },
    });

    expect(sanitizeCompactedRolloutLine(line)).toBe(
      JSON.stringify({
        type: "compacted",
        payload: {
          message: "Context compacted.",
          replacement_history: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Look at this\n<image removed>",
                },
              ],
            },
            {
              type: "compaction",
              encrypted_content: "gAAAAABexamplePayload==",
            },
          ],
        },
      }),
    );
  });

  test("does not blob-strip compacted replacement history when aggressive mode is enabled", () => {
    const encryptedContent = "g".repeat(7000);
    const line = JSON.stringify({
      type: "compacted",
      payload: {
        message: "Context compacted.",
        replacement_history: [
          {
            type: "reasoning",
            summary: [],
            content: null,
            encrypted_content: encryptedContent,
          },
        ],
      },
    });

    expect(
      sanitizeCompactedRolloutLine(line, {
        stripBlobContent: true,
      }),
    ).toBe(line);
  });

  test("sanitizes response-item message rows in place without changing line order", () => {
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:02:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<image>" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_text", text: "</image>" },
          { type: "input_text", text: "caption" },
        ],
      },
    });

    expect(sanitizeResponseItemJsonlLine(line)).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<image removed>\ncaption",
            },
          ],
        },
      }),
    );
  });

  test("sanitizes event-msg user-message rows with inline image arrays", () => {
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:02:30.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "please inspect",
        images: ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"],
        local_images: ["C:\\temp\\capture.png"],
      },
    });

    expect(sanitizeEventMsgJsonlLine(line)).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:02:30.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message:
            "please inspect\n<image removed>\n<image removed>\n<local image removed>",
          images: [],
          local_images: [],
        },
      }),
    );
  });

  test("strips large response-item blobs when blob stripping is enabled", () => {
    const largeOutput = JSON.stringify({
      output: "x".repeat(6000),
      metadata: {
        exit_code: 0,
        duration_seconds: 1.25,
      },
    });
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:02:45.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_123",
        output: largeOutput,
      },
    });

    expect(
      sanitizeResponseItemJsonlLine(line, {
        stripBlobContent: true,
      }),
    ).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:02:45.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_123",
          output: JSON.stringify({
            output: `<tool output removed: ${Buffer.byteLength(largeOutput, "utf8")} bytes>`,
            metadata: {
              exit_code: 0,
              duration_seconds: 1.25,
            },
          }),
        },
      }),
    );
  });

  test("strips encrypted reasoning blobs when blob stripping is enabled", () => {
    const encryptedContent = "g".repeat(7000);
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:03:00.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [],
        content: null,
        encrypted_content: encryptedContent,
      },
    });

    expect(
      sanitizeResponseItemJsonlLine(line, {
        stripBlobContent: true,
      }),
    ).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:03:00.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [],
          content: null,
          encrypted_content: `<reasoning blob removed: ${Buffer.byteLength(encryptedContent, "utf8")} bytes>`,
        },
      }),
    );
  });

  test("strips token-count event payloads when blob stripping is enabled", () => {
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:03:15.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 12345,
          },
        },
      },
    });

    expect(
      sanitizeEventMsgJsonlLine(line, {
        stripBlobContent: true,
      }),
    ).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:03:15.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
        },
      }),
    );
  });

  test("strips large turn-context instruction dumps when blob stripping is enabled", () => {
    const instructions = "rule\n".repeat(1500);
    const line = JSON.stringify({
      timestamp: "2026-03-14T12:03:30.000Z",
      type: "turn_context",
      payload: {
        turn_id: "turn_123",
        cwd: "d:\\github\\codlogs",
        collaboration_mode: {
          mode: "default",
          settings: {
            developer_instructions: instructions,
          },
        },
      },
    });

    expect(
      sanitizeTurnContextJsonlLine(line, {
        stripBlobContent: true,
      }),
    ).toBe(
      JSON.stringify({
        timestamp: "2026-03-14T12:03:30.000Z",
        type: "turn_context",
        payload: {
          turn_id: "turn_123",
          cwd: "d:\\github\\codlogs",
          collaboration_mode: {
            mode: "default",
            settings: {
              developer_instructions: `<turn context blob removed: ${Buffer.byteLength(instructions, "utf8")} bytes>`,
            },
          },
        },
      }),
    );
  });

  test("keeps sanitized compacted rows in the write sequence", () => {
    const responseItems: SanitizedResponseItem[] = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "after compacted" }],
      },
    ];
    const compactedLine = JSON.stringify({
      type: "compacted",
      payload: {
        message: "Context compacted.",
        replacement_history: [],
      },
    });
    const originalSlots: OriginalResponseItemSlot[] = [
      {
        kind: "compacted",
        line: compactedLine,
      },
      {
        kind: "sanitizable",
        timestamp: "2026-03-14T12:02:00.000Z",
        payloadType: "message",
      },
    ];

    expect(
      mergeSanitizedResponseItemsWithOriginalSequence(responseItems, originalSlots),
    ).toEqual([
      {
        kind: "raw",
        line: compactedLine,
      },
      {
        kind: "sanitized",
        timestamp: "2026-03-14T12:02:00.000Z",
        payload: responseItems[0],
      },
    ]);
  });
});
