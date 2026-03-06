"use client";

import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Session {
  id: string;
  engine: string;
  source: string;
  employee: string | null;
  status: "idle" | "running" | "error";
  lastActivity: string;
}

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  idle: "secondary",
  running: "default",
  error: "destructive",
};

const statusLabel: Record<string, string> = {
  idle: "Idle",
  running: "Running",
  error: "Error",
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <Card>
        <CardContent>
          <div
            style={{
              textAlign: "center",
              padding: "var(--space-6)",
              color: "var(--text-tertiary)",
              fontSize: "var(--text-body)",
            }}
          >
            No sessions found
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
      }}
    >
      {sessions.map((s) => (
        <Card
          key={s.id}
          className="py-3 cursor-pointer transition-colors"
          onClick={() => onSelect(s.id)}
          style={{
            cursor: "pointer",
            borderColor:
              selectedId === s.id
                ? "var(--accent)"
                : undefined,
            background:
              selectedId === s.id
                ? "color-mix(in srgb, var(--accent) 5%, var(--bg-card, var(--bg)))"
                : undefined,
          }}
        >
          <CardContent className="flex items-center justify-between gap-4">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                flex: 1,
                minWidth: 0,
              }}
            >
              {/* Engine icon */}
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "var(--radius-sm, 8px)",
                  background: "var(--fill-secondary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-caption1)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--text-secondary)",
                  flexShrink: 0,
                  textTransform: "uppercase",
                }}
              >
                {s.engine.charAt(0)}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    marginBottom: 2,
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-body)",
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--text-primary)",
                      textTransform: "capitalize",
                    }}
                  >
                    {s.engine}
                  </span>
                  <Badge variant={statusVariant[s.status] ?? "secondary"}>
                    {statusLabel[s.status] || s.status}
                  </Badge>
                </div>
                <div
                  style={{
                    fontSize: "var(--text-caption1)",
                    color: "var(--text-tertiary)",
                    display: "flex",
                    gap: "var(--space-3)",
                  }}
                >
                  <span>{s.source}</span>
                  <span>{s.employee || "Jimmy"}</span>
                </div>
              </div>
            </div>

            {/* Time */}
            <span
              style={{
                fontSize: "var(--text-caption2)",
                color: "var(--text-quaternary)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {relativeTime(s.lastActivity)}
            </span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
