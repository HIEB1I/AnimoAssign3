const backendBase = import.meta.env.VITE_BACKEND_URL;
const analyticsBase = import.meta.env.VITE_ANALYTICS_URL;

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