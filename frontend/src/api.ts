const backendBase = import.meta.env.VITE_BACKEND_URL ?? "/api";
const analyticsBase = import.meta.env.VITE_ANALYTICS_URL ?? "/analytics";

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

// frontend/src/api/index.ts
export type AnalyticsTerm = { term: string; count: number };
export type AnalyticsDaily = { date: string; count: number };
export type AnalyticsSummary = {
  totalRecords: number;
  generatedAt: string;
  topTerms: AnalyticsTerm[];
  dailyIngest: AnalyticsDaily[];
};

export async function fetchAnalyticsSummary(): Promise<AnalyticsSummary> {
  const res = await fetch("/analytics/summary", {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Analytics failed (${res.status}): ${text || res.statusText}`);
  }
  const data = (await res.json()) as AnalyticsSummary;
  // minimal shape check to avoid white screens
  if (
    typeof data?.totalRecords !== "number" ||
    typeof data?.generatedAt !== "string" ||
    !Array.isArray(data?.topTerms) ||
    !Array.isArray(data?.dailyIngest)
  ) {
    throw new Error("Unexpected analytics summary shape");
  }
  return data;
}


export async function createRecord(payload: RecordPayload): Promise<RecordItem> {
  const response = await fetch(`${backendBase}/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to create record");
  }

  return response.json();
}

export async function listRecords(limit = 20): Promise<RecordItem[]> {
  const response = await fetch(`${backendBase}/records?limit=${limit}`);
  if (!response.ok) {
    throw new Error("Failed to load records");
  }
  const payload = await response.json();
  return payload.items ?? [];
}

export async function searchRecords(query: string): Promise<SearchResponse> {
  const params = new URLSearchParams();
  if (query.trim().length > 0) {
    params.set("q", query.trim());
  }

  const response = await fetch(
    `${backendBase}/records/search${params.toString() ? `?${params}` : ""}`,
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to search records");
  }

  return response.json();
}
