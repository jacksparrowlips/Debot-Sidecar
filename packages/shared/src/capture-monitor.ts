export interface CaptureRecord {
  id: number;
  url: string;
  kind: string;
  capturedAt: number;
  receivedAt: number;
  observedAt: number | null;
  delayMs: number | null;
  status: "processed" | "duplicate" | "unrecognized" | "error";
  results: Record<string, number>;
  missing: string[];
  symbols: string[];
  error?: string;
}
export interface CaptureSnapshot {
  pageHealth: { tabId: number; loginState: "ok" | "expired" | "unknown"; receivedAt: number }[];
  startedAt: number;
  now: number;
  extensionConnections: number;
  lastReceivedAt: number | null;
  received: number;
  errors: number;
  perMinute: number;
  items: CaptureRecord[];
}
export interface CaptureDetail extends CaptureRecord {
  raw: string;
  parsed: string;
  truncated: boolean;
}
