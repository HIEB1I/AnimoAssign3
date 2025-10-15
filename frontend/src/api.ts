import axios from 'axios';

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");

function join(a: string, b: string) {
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

const backendBase =
  import.meta.env.VITE_BACKEND_URL || join(BASE, "api");
const analyticsBase =
  import.meta.env.VITE_ANALYTICS_URL || join(BASE, "analytics");

export const api = axios.create({ baseURL: BASE });

// ---- types ----
export type RecordPayload = {
  title: string;
  content: string;
};

export type RecordItem = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
};

export type SearchResponse = {
  items: RecordItem[];
  query: string;
  count: number;
};

// ---- calls ----
// Uses fetch; hits /staging/analytics/... on staging, /analytics/... elsewhere
export async function fetchAnalyticsSummary(): Promise<AnalyticsSummary> {
  const url = join(analyticsBase, "summary");
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Analytics failed (${res.status}): ${text || res.statusText}`);
  }
  const data = (await res.json()) as AnalyticsSummary;
  if (
    typeof data?.totalRecords !== "number" ||
    typeof data?.generatedAt !== "string" ||
    !Array.isArray(data?.topTerms) ||
    !Array.isArray(data?.dailyIngest)
  ) throw new Error("Unexpected analytics summary shape");
  return data;
}


// frontend/src/api/index.ts
export type AnalyticsTerm = { term: string; count: number };
export type AnalyticsDaily = { date: string; count: number };
export type AnalyticsSummary = {
  totalRecords: number;
  generatedAt: string;
  topTerms: AnalyticsTerm[];
  dailyIngest: AnalyticsDaily[];
};

export async function createRecord(payload: RecordPayload): Promise<RecordItem> {
  const res = await fetch(join(backendBase, "records"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error((await res.text()) || "Failed to create record");
  return res.json();
}

export async function listRecords(limit = 20): Promise<RecordItem[]> {
  const res = await fetch(join(backendBase, `records?limit=${limit}`));
  if (!res.ok) throw new Error("Failed to load records");
  const payload = await res.json();
  return payload.items ?? [];
}

export async function searchRecords(query: string): Promise<SearchResponse> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  const url = join(backendBase, `records/search${params.toString() ? `?${params}` : ""}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.text()) || "Failed to search records");
  return res.json();
}


