// electron.vite.config.ts
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// src/shared/renderer-security-policy.ts
var RENDERER_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file: videorc-asset: http://127.0.0.1:* http://localhost:*",
  "font-src 'self' data:",
  "media-src 'self' data: blob: file: videorc-asset:",
  "connect-src 'self' videorc-asset: https://www.videorc.com http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");
function rendererDocumentCspWithScriptHash(scriptHash, allowSmokeRendererEvaluation = false) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(scriptHash)) {
    throw new Error("Renderer CSP script hash is invalid.");
  }
  const evaluationSource = allowSmokeRendererEvaluation ? " 'unsafe-eval'" : "";
  return RENDERER_DOCUMENT_CSP.replace(
    "script-src 'self'",
    `script-src 'self' 'sha256-${scriptHash}'${evaluationSource}`
  );
}

// electron.vite.config.ts
var reactRefreshPreamble = react.preambleCode.replace("__BASE__", "/");
var reactRefreshPreambleHash = createHash("sha256").update(reactRefreshPreamble).digest("base64");
var smokeRendererEvaluationAllowed = process.env.VIDEORC_SMOKE_COMMAND_SERVER === "1" || process.env.VIDEORC_SMOKE_PREVIEW_MOTION === "1";
var rendererDevelopmentCsp = rendererDocumentCspWithScriptHash(
  reactRefreshPreambleHash,
  smokeRendererEvaluationAllowed
);
var developmentRendererCspPlugin = {
  name: "videorc-development-renderer-csp",
  apply: "serve",
  transformIndexHtml(html) {
    return html.replace(RENDERER_DOCUMENT_CSP, rendererDevelopmentCsp);
  }
};
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve("src/renderer"),
    server: {
      // Vite injects React Refresh before the document's CSP meta tag. A
      // response header enforces the policy from byte zero; only that exact
      // static preamble receives a hash exception in development.
      headers: {
        "Content-Security-Policy": rendererDevelopmentCsp
      }
    },
    resolve: {
      alias: {
        "@": resolve("src/renderer/src")
      }
    },
    plugins: [developmentRendererCspPlugin, react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          comments: resolve("src/renderer/comments.html"),
          captions: resolve("src/renderer/captions.html")
        }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
