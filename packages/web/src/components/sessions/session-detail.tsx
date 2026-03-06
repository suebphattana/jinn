"use client";

import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  source: string;
  sourceRef: string;
  employee: string | null;
  model: string | null;
  status: "idle" | "running" | "error";
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
}

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  idle: "secondary",
  running: "default",
  error: "destructive",
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: "var(--space-3)",
        padding: "var(--space-2) 0",
        borderBottom: "1px solid var(--separator)",
      }}
    >
      <span
        style={{
          fontSize: "var(--text-caption1)",
          fontWeight: "var(--weight-medium)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-tertiary)",
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: "var(--text-body)",
          color: "var(--text-primary)",
          textAlign: "right",
          wordBreak: "break-all",
        }}
      >
        {value || (
          <span style={{ color: "var(--text-quaternary)" }}>--</span>
        )}
      </span>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function SessionDetail({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle
          style={{
            fontSize: "var(--text-headline)",
            color: "var(--text-primary)",
          }}
        >
          Session Detail
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Field
            label="Session ID"
            value={
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-caption1)",
                }}
              >
                {session.id}
              </span>
            }
          />
          <Field
            label="Engine"
            value={
              <span style={{ textTransform: "capitalize" }}>
                {session.engine}
                {session.model ? ` (${session.model})` : ""}
              </span>
            }
          />
          <Field label="Source" value={session.source} />
          <Field
            label="Source Ref"
            value={
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-caption1)",
                }}
              >
                {session.sourceRef}
              </span>
            }
          />
          <Field label="Employee" value={session.employee || "Jimmy"} />
          <Field
            label="Status"
            value={
              <Badge variant={statusVariant[session.status] ?? "secondary"}>
                {session.status.charAt(0).toUpperCase() +
                  session.status.slice(1)}
              </Badge>
            }
          />
          <Field label="Created" value={formatDate(session.createdAt)} />
          <Field
            label="Last Activity"
            value={formatDate(session.lastActivity)}
          />

          {session.lastError && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <span
                style={{
                  fontSize: "var(--text-caption1)",
                  fontWeight: "var(--weight-medium)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--system-red)",
                  display: "block",
                  marginBottom: "var(--space-2)",
                }}
              >
                Last Error
              </span>
              <div
                style={{
                  fontSize: "var(--text-caption1)",
                  fontFamily: "var(--font-mono)",
                  color: "var(--system-red)",
                  background:
                    "color-mix(in srgb, var(--system-red) 10%, transparent)",
                  borderRadius: "var(--radius-sm, 8px)",
                  padding: "var(--space-3)",
                }}
              >
                {session.lastError}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
