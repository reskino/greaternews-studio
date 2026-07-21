/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Optional: enables the browser-side Claude query resolver when no local
  // resolver is running. Exposed in the JS bundle — personal/local use only.
  readonly VITE_ANTHROPIC_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
