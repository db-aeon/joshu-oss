/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_JOSHU_FILES_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
