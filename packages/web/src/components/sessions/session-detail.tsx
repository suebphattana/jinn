"use client";

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

const statusStyles: Record<string, { dot: string; bg: string; text: string }> = {
  idle: { dot: "bg-green-500", bg: "bg-green-50", text: "text-green-700" },
  running: { dot: "bg-yellow-500", bg: "bg-yellow-50", text: "text-yellow-700" },
  error: { dot: "bg-red-500", bg: "bg-red-50", text: "text-red-700" },
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="py-2.5 flex justify-between items-start gap-4">
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-400 shrink-0">
        {label}
      </span>
      <span className="text-sm text-neutral-700 text-right break-all">
        {value || <span className="text-neutral-300">--</span>}
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
  const style = statusStyles[session.status] || statusStyles.idle;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
      <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-800">
          Session Detail
        </h3>
        <button
          onClick={onClose}
          className="text-neutral-400 hover:text-neutral-600 text-lg leading-none"
        >
          &times;
        </button>
      </div>
      <div className="px-5 py-2 divide-y divide-neutral-100">
        <Field
          label="Session ID"
          value={
            <span className="font-mono text-xs">{session.id}</span>
          }
        />
        <Field
          label="Engine"
          value={
            <span className="capitalize">
              {session.engine}
              {session.model ? ` (${session.model})` : ""}
            </span>
          }
        />
        <Field label="Source" value={session.source} />
        <Field
          label="Source Ref"
          value={
            <span className="font-mono text-xs">{session.sourceRef}</span>
          }
        />
        <Field
          label="Employee"
          value={session.employee || "Jimmy"}
        />
        <Field
          label="Status"
          value={
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${style.bg} ${style.text}`}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${style.dot}`} />
              {session.status.charAt(0).toUpperCase() + session.status.slice(1)}
            </span>
          }
        />
        <Field label="Created" value={formatDate(session.createdAt)} />
        <Field label="Last Activity" value={formatDate(session.lastActivity)} />
        {session.lastError && (
          <div className="py-3">
            <span className="text-xs font-medium uppercase tracking-wide text-red-400 block mb-1">
              Last Error
            </span>
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 font-mono text-xs">
              {session.lastError}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
