import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "codexer",
    identifier: "dev.tobias.codexer",
    version: "0.2.0",
  },
  build: {
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
