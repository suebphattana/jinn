"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { createGatewaySocket } from "@/lib/ws";
import { SessionList } from "@/components/sessions/session-list";
import { SessionDetail } from "@/components/sessions/session-detail";

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

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getSessions();
      setSessions(data as unknown as Session[]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Auto-refresh on WebSocket events related to sessions
  useEffect(() => {
    const socket = createGatewaySocket((event) => {
      if (event.startsWith("session")) {
        fetchSessions();
      }
    });
    return () => socket.close();
  }, [fetchSessions]);

  const selected = sessions.find((s) => s.id === selectedId) || null;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Sessions</h2>
          <p className="text-sm text-neutral-500 mt-1">
            Active and recent engine sessions
          </p>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            fetchSessions();
          }}
          className="px-3 py-1.5 text-sm font-medium text-neutral-600 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && sessions.length === 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-white px-5 py-12 text-center text-sm text-neutral-400">
          Loading sessions...
        </div>
      ) : (
        <div className="flex gap-6">
          <div className={selected ? "w-[60%]" : "w-full"}>
            <SessionList
              sessions={sessions}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
          {selected && (
            <div className="w-[40%]">
              <SessionDetail
                session={selected}
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
