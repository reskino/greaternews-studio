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
  // Optional: Serper.dev (real Google Images, CORS-enabled). Simpler than Google's own API
  // (no Cloud project / CSE / enablement). The key can't be domain-restricted, so it's
  // visible in the bundle — fine for a personal tool; rotate it if the free quota gets abused.
  readonly VITE_SERPER_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
