import type { RPCSchema } from "electrobun/view";
import type { FindCodexSessionsResult } from "./codex-core.ts";

export type CodexerRPC = {
  bun: RPCSchema<{
    requests: {
      loadSessions: {
        params: {
          codexHome: string | null;
          targetDirectory: string | null;
          cwdOnly: boolean;
        };
        response: FindCodexSessionsResult;
      };
      pickDirectory: {
        params: {
          startingFolder: string | null;
        };
        response: {
          path: string | null;
        };
      };
      exportSessionMarkdown: {
        params: {
          sessionFilePath: string;
          includeImages: boolean;
          includeToolCallResults: boolean;
        };
        response: {
          outputPath: string;
        };
      };
      revealPath: {
        params: {
          path: string;
        };
        response: {
          ok: boolean;
        };
      };
      openPath: {
        params: {
          path: string;
        };
        response: {
          ok: boolean;
        };
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};
