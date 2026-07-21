/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Optional: enables the browser-side Claude query resolver when no local
  // resolver is running. Exposed in the JS bundle — personal/local use only.
  readonly VITE_ANTHROPIC_API_KEY?: string;
  // Optional: Google Programmable Search (Custom Search JSON API) for broad web
  // image results. The key must be referrer-restricted to the studio's domain and
  // limited to the Custom Search API — then it is safe to ship in the bundle.
  readonly VITE_GOOGLE_CSE_KEY?: string;
  readonly VITE_GOOGLE_CSE_CX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
