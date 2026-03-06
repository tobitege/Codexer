import * as path from "node:path";
import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import {
  exportSessionJsonlToMarkdown,
  findCodexSessions,
} from "../shared/codex-core.ts";
import type { CodexerRPC } from "../shared/rpc.ts";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: using Vite dev server at ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log("Vite dev server not running. Falling back to bundled mainview.");
    }
  }

  return "views://mainview/index.html";
}

function normalizeDialogResult(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function getAppWorkingDirectory(): string {
  const preferred =
    normalizeDialogResult(process.env.INIT_CWD) ??
    normalizeDialogResult(process.env.PWD) ??
    process.cwd();
  const normalized = path.resolve(preferred);
  const runtimeBuildMatch = normalized.match(
    /^(.*?)[\\/]build[\\/](?:dev|release)-[^\\/]+[\\/][^\\/]+[\\/]bin$/i,
  );
  return runtimeBuildMatch?.[1] ? path.resolve(runtimeBuildMatch[1]) : normalized;
}

function getStartingFolder(candidate: string | null): string {
  const trimmed = candidate?.trim() ?? "";
  return trimmed || getAppWorkingDirectory();
}

const rpc = BrowserView.defineRPC<CodexerRPC>({
  handlers: {
    requests: {
      loadSessions: async ({ codexHome, targetDirectory, cwdOnly }) =>
        findCodexSessions({
          codexHome,
          targetDirectory,
          cwdOnly,
          currentWorkingDirectory: getAppWorkingDirectory(),
        }),
      pickDirectory: async ({ startingFolder }) => {
        const [chosenPath] = await Utils.openFileDialog({
          startingFolder: getStartingFolder(startingFolder),
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });

        return {
          path: normalizeDialogResult(chosenPath),
        };
      },
      exportSessionMarkdown: async ({
        sessionFilePath,
        includeImages,
        includeToolCallResults,
      }) => {
        const outputPath = await exportSessionJsonlToMarkdown(sessionFilePath, {
          includeImages,
          includeToolCallResults,
        });
        Utils.showNotification({
          title: "codexer export ready",
          body: path.basename(outputPath),
        });
        return { outputPath };
      },
      revealPath: ({ path: targetPath }) => {
        Utils.showItemInFolder(targetPath);
        return { ok: true };
      },
      openPath: ({ path: targetPath }) => ({
        ok: Utils.openPath(targetPath),
      }),
    },
    messages: {},
  },
});

const url = await getMainViewUrl();

const mainWindow = new BrowserWindow({
  title: "codexer",
  url,
  rpc,
  frame: {
    width: 1600,
    height: 1000,
    x: 100,
    y: 60,
  },
});

mainWindow.webview.on("dom-ready", () => {
  console.log("codexer mainview ready");
});

console.log(`codexer started with ${url}`);
