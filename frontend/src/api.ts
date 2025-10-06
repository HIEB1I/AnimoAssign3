const backendBase = import.meta.env.VITE_BACKEND_URL ?? "/api";
const analyticsBase = import.meta.env.VITE_ANALYTICS_URL ?? "/analytics";

export type ConnectivityTestPayload = {
  title: string;
  status: string;
  notes?: string | null;
};

export type ConnectivityServiceStatus = {
  service: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
};

export type ConnectivityResponse = {
  echo: ConnectivityTestPayload;
  services: ConnectivityServiceStatus[];
  latencyMs: number;
  timestamp: string;
};

export type Assignment = {
  _id: string;
  title: string;
  status: string;
  notes?: string | null;
};

export type AnalyticsStatusRow = {
  status: string;
  label: string;
  count: number;
  percentage: number;
};

export type AnalyticsSummary = {
  generatedAt: string;
  totalAssignments: number;
  diagnosticEventsStored: number;
  statusBreakdown: AnalyticsStatusRow[];
};

export async function fetchAssignments() {
  const response = await fetch(`${backendBase}/assignments`);
  if (!response.ok) throw new Error("Failed to load assignments");
  return response.json();
}

export async function fetchAssignmentTotals() {
  const response = await fetch(`${analyticsBase}/assignment-totals`);
  if (!response.ok) throw new Error("Failed to load analytics");
  return response.json();
}

export async function runConnectivityTest(
  payload: ConnectivityTestPayload
): Promise<ConnectivityResponse> {
  const response = await fetch(`${backendBase}/connectivity-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      message || "Connectivity test failed to complete. Check backend logs."
    );
  }

  return response.json();
}

export async function searchAssignments(query: string) {
  const params = new URLSearchParams();
  if (query.trim().length > 0) {
    params.set("q", query.trim());
  }

  const response = await fetch(
    `${backendBase}/assignments/search${params.toString() ? `?${params}` : ""}`,
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to search assignments");
  }

  return response.json();
}

export async function fetchAnalyticsSummary(): Promise<AnalyticsSummary> {
  const response = await fetch(`${analyticsBase}/summary`);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to load analytics summary");
  }

  return response.json();
}