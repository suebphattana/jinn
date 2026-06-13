import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Cpu,
  Database,
  Gauge,
  RefreshCw,
} from "lucide-react"
import { api } from "@/lib/api"
import type {
  EngineLimitBucket,
  EngineLimitEngineSnapshot,
  EngineLimitsResponse,
  EngineLimitWindow,
} from "@/lib/api"
import { PageLayout, ToolbarActions } from "@/components/page-layout"

function formatDate(value?: string) {
  if (!value) return "Unknown"
  return new Date(value).toLocaleString()
}

function formatPercent(value?: number) {
  return value === undefined ? "Unknown" : `${value}%`
}

function statusColor(engine: EngineLimitEngineSnapshot) {
  if (!engine.available || engine.status === "unsupported") return "var(--text-tertiary)"
  if (engine.status === "error") return "var(--system-red)"
  if (engine.stale) return "var(--system-orange)"
  if (engine.status === "live") return "var(--system-green)"
  return "var(--accent)"
}

function statusIcon(engine: EngineLimitEngineSnapshot) {
  if (engine.status === "error") return AlertTriangle
  if (!engine.available || engine.status === "unsupported") return Database
  if (engine.status === "live") return CheckCircle2
  return Clock3
}

function WindowMeter({ window }: { window: EngineLimitWindow }) {
  const used = Math.max(0, Math.min(100, window.usedPercent ?? 0))
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-[var(--space-3)] text-[length:var(--text-footnote)]">
        <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{window.name}</span>
        <span className="text-[var(--text-secondary)]">{formatPercent(window.usedPercent)}</span>
      </div>
      <div className="mt-[var(--space-2)] h-2 rounded-full bg-[var(--material-thin)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${used}%`,
            background:
              used >= 90
                ? "var(--system-red)"
                : used >= 70
                  ? "var(--system-orange)"
                  : "var(--system-green)",
          }}
        />
      </div>
      <div className="mt-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        Resets {formatDate(window.resetsAtIso)}
      </div>
    </div>
  )
}

function BucketRow({ bucket }: { bucket: EngineLimitBucket }) {
  return (
    <div className="border border-[var(--separator)] rounded-[var(--radius-md)] p-[var(--space-3)] bg-[var(--material-thin)]">
      <div className="flex flex-wrap items-center gap-[var(--space-2)] mb-[var(--space-3)]">
        <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{bucket.name || bucket.id}</span>
        {bucket.planType && (
          <span className="text-[length:var(--text-caption1)] px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--material-regular)] text-[var(--text-secondary)]">
            {bucket.planType}
          </span>
        )}
      </div>
      <div className="grid gap-[var(--space-3)] md:grid-cols-2">
        {bucket.primary && <WindowMeter window={{ ...bucket.primary, name: "Primary" }} />}
        {bucket.secondary && <WindowMeter window={{ ...bucket.secondary, name: "Secondary" }} />}
      </div>
    </div>
  )
}

function EnginePanel({ engine }: { engine: EngineLimitEngineSnapshot }) {
  const Icon = statusIcon(engine)
  const visibleBuckets = (engine.buckets || []).filter((bucket) => bucket.id !== "codex")
  const context = engine.context
  return (
    <section className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-regular)] overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-4)] border-b border-[var(--separator)]">
        <div className="flex items-start gap-[var(--space-3)] min-w-0">
          <div
            className="w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0"
            style={{ color: statusColor(engine), background: "color-mix(in srgb, currentColor 10%, transparent)" }}
          >
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)] capitalize">
              {engine.name}
            </h2>
            <div className="mt-1 flex flex-wrap gap-x-[var(--space-3)] gap-y-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
              <span>{engine.status}</span>
              <span>{engine.source}</span>
              {engine.accountPlan && <span>{engine.accountPlan}</span>}
            </div>
          </div>
        </div>
        <div className="text-right text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          <div>Updated</div>
          <div>{formatDate(engine.refreshedAt)}</div>
        </div>
      </div>

      <div className="p-[var(--space-4)] grid gap-[var(--space-4)]">
        {engine.windows && engine.windows.length > 0 && (
          <div className="grid gap-[var(--space-4)] md:grid-cols-2">
            {engine.windows.map((window) => (
              <WindowMeter key={window.name} window={window} />
            ))}
          </div>
        )}

        {context && (
          <div className="grid gap-[var(--space-3)] md:grid-cols-3">
            <Metric label="Context used" value={formatPercent(context.usedPercent)} />
            <Metric label="Context window" value={context.contextWindowSize?.toLocaleString() || "Unknown"} />
            <Metric label="Input tokens" value={context.totalInputTokens?.toLocaleString() || "Unknown"} />
          </div>
        )}

        {visibleBuckets.length > 0 && (
          <div className="grid gap-[var(--space-3)]">
            {visibleBuckets.map((bucket) => (
              <BucketRow key={bucket.id} bucket={bucket} />
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-[var(--space-2)]">
          {engine.models.map((model) => (
            <span
              key={model.id}
              className="text-[length:var(--text-caption1)] px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--material-thin)] text-[var(--text-secondary)] border border-[var(--separator)]"
            >
              {model.label || model.id}
              {model.contextWindow ? ` · ${model.contextWindow.toLocaleString()}` : ""}
            </span>
          ))}
        </div>

        {(engine.unsupportedReason || engine.error || engine.stale) && (
          <div className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] border border-[var(--separator)] rounded-[var(--radius-md)] p-[var(--space-3)] bg-[var(--material-thin)]">
            {engine.error || engine.unsupportedReason || "Latest snapshot is older than 30 minutes."}
          </div>
        )}
      </div>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[var(--separator)] rounded-[var(--radius-md)] p-[var(--space-3)] bg-[var(--material-thin)] min-w-0">
      <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{label}</div>
      <div className="mt-1 text-[length:var(--text-callout)] font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">
        {value}
      </div>
    </div>
  )
}

export default function LimitsPage() {
  const [data, setData] = useState<EngineLimitsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setRefreshing(true)
    setError(null)
    api
      .refreshEngineLimits()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load engine limits"))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const engines = useMemo(() => Object.values(data?.engines || {}), [data])
  const liveCount = engines.filter((engine) => engine.status === "live" || engine.status === "snapshot").length
  const errorCount = engines.filter((engine) => engine.status === "error").length
  const unavailableCount = engines.filter((engine) => !engine.available).length

  return (
    <PageLayout>
      <div className="h-full flex flex-col overflow-hidden animate-fade-in bg-[var(--bg)]">
        <header
          className="sticky top-0 z-10 flex-shrink-0 bg-[var(--material-regular)] border-b border-[var(--separator)]"
          style={{
            backdropFilter: "blur(40px) saturate(180%)",
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
          }}
        >
          <div className="flex items-center justify-between px-[var(--space-6)] py-[var(--space-4)]">
            <div>
              <h1 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] text-[var(--text-primary)] leading-[var(--leading-tight)]">
                Engine Limits
              </h1>
              <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] mt-[var(--space-1)]">
                {data ? `Generated ${formatDate(data.generatedAt)}` : "Loading engine telemetry"}
              </p>
            </div>
            <ToolbarActions>
              <button
                onClick={refresh}
                className="focus-ring w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer transition-colors duration-150 ease-[var(--ease-smooth)]"
                aria-label="Refresh engine limits"
              >
                <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
              </button>
            </ToolbarActions>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-[var(--space-6)] pt-[var(--space-4)] pb-[var(--space-6)]">
          {error && (
            <div className="mb-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--system-red)] text-[length:var(--text-footnote)] text-[var(--system-red)]">
              {error}
            </div>
          )}

          {loading ? (
            <div className="h-[200px] flex items-center justify-center text-[var(--text-tertiary)]">Loading...</div>
          ) : (
            <div className="grid gap-[var(--space-4)]">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-[var(--space-3)]">
                <Metric label="Engines" value={String(engines.length)} />
                <Metric label="Live snapshots" value={String(liveCount)} />
                <Metric label="Errors" value={String(errorCount)} />
                <Metric label="Unavailable" value={String(unavailableCount)} />
              </div>

              {engines.map((engine) => (
                <EnginePanel key={engine.name} engine={engine} />
              ))}

              {engines.length === 0 && (
                <div className="h-[200px] flex flex-col items-center justify-center text-[var(--text-tertiary)] gap-[var(--space-2)]">
                  <Gauge size={22} />
                  <span>No engines found</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
