import axios from 'axios';

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");

function join(a: string, b: string) {
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

function normalize(base: string, override?: string) {
  if (!override) return base;                    // no override → use base as-is
  if (/^https?:\/\//i.test(override)) return override;  // absolute URL
  return join(BASE, override);                   // '/api' or 'api' → '/staging/api' (staging) or '/api' (prod)
}

const backendBase   = normalize(join(BASE, 'api'),        import.meta.env.VITE_BACKEND_URL);
const analyticsBase = normalize(join(BASE, 'analytics'),  import.meta.env.VITE_ANALYTICS_URL);

export const api = axios.create({ baseURL: BASE });

