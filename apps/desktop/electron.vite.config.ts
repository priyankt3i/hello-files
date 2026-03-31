import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@fschat/shared"] })],
    resolve: {
      alias: {
        "@fschat/shared": resolve(__dirname, "../../packages/shared/src/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@fschat/shared"] })],
    build: {
      rollupOptions: {
        output: {
          format: "cjs"
        }
      }
    },
    resolve: {
      alias: {
        "@fschat/shared": resolve(__dirname, "../../packages/shared/src/index.ts")
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
        "@fschat/shared": resolve(__dirname, "../../packages/shared/src/index.ts")
      }
    }
  }
});
