import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Gauge,
  RefreshCw,
  TimerReset,
  WalletCards,
} from "lucide-react"
import { api } from "@/lib/api"
import type {
  EngineLimitBucket,
  EngineLimitEngineSnapshot,
  EngineLimitsResponse,
  EngineLimitWindow,
} from "@/lib/api"
import { PageLayout, ToolbarActions } from "@/components/page-layout"

const FEATURED_ENGINES = ["claude", "codex"]

function formatDate(value?: string) {
  if (!value) return "Unknown"
  return new Date(value).toLocaleString()
}

function formatDuration(minutes?: number) {
  if (!minutes) return ""
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function windowLabel(window: EngineLimitWindow) {
  return window.windowDurationMins ? formatDuration(window.windowDurationMins) : window.name
}

function clampPercent(value?: number) {
  return Math.max(0, Math.min(100, value ?? 0))
}

function gaugeColor(value?: number) {
  if (value === undefined) return "var(--text-quaternary)"
  if (value >= 90) return "var(--system-red)"
  if (value >= 70) return "var(--system-orange)"
  return "var(--system-green)"
}

function statusLabel(engine: EngineLimitEngineSnapshot) {
  if (engine.status === "live") return "Live"
  if (engine.status === "snapshot") return "Captured"
  if (engine.status === "error") return "Error"
  return "Waiting for data"
}

function statusColor(engine: EngineLimitEngineSnapshot) {
  if (engine.status === "error") return "var(--system-red)"
  if (engine.status === "live") return "var(--system-green)"
  if (engine.status === "snapshot") return "var(--accent)"
  return "var(--text-tertiary)"
}

function topWindow(engines: EngineLimitEngineSnapshot[]) {
  return engines
    .flatMap((engine) => (engine.windows || []).map((window) => ({ engine, window })))
    .filter((item) => item.window.usedPercent !== undefined)
    .sort((a, b) => (b.window.usedPercent || 0) - (a.window.usedPercent || 0))[0]
}

function nextReset(engines: EngineLimitEngineSnapshot[]) {
  return engines
    .flatMap((engine) => engine.windows || [])
    .map((window) => window.resetsAtIso)
    .filter(Boolean)
    .sort()[0]
}

function SummaryStrip({ engines }: { engines: EngineLimitEngineSnapshot[] }) {
  const highest = topWindow(engines)
  const reset = nextReset(engines)
  const live = engines.filter((engine) => engine.status === "live" || engine.status === "snapshot").length

  return (
    <div className="grid gap-[var(--space-3)] lg:grid-cols-3">
      <SummaryTile
        icon={Gauge}
        label="Highest usage"
        value={highest ? `${highest.window.usedPercent}%` : "Unknown"}
        detail={highest ? `${highest.engine.name} ${windowLabel(highest.window)}` : "No observed quota windows"}
      />
      <SummaryTile
        icon={TimerReset}
        label="Next reset"
        value={formatDate(reset)}
        detail="Earliest observed quota reset"
      />
      <SummaryTile
        icon={CheckCircle2}
        label="Observed engines"
        value={`${live}/${engines.length}`}
        detail="Claude and Codex only"
      />
    </div>
  )
}

function SummaryTile({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Gauge
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-regular)] p-[var(--space-4)] min-w-0">
      <div className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        <Icon size={14} />
        <span>{label}</span>
      </div>
      <div className="mt-[var(--space-2)] text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)] truncate">
        {value}
      </div>
      <div className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">{detail}</div>
    </div>
  )
}

function CircularGauge({ window }: { window: EngineLimitWindow }) {
  const used = clampPercent(window.usedPercent)
  const color = gaugeColor(window.usedPercent)
  const observed = window.usedPercent !== undefined

  return (
    <div className="flex flex-col items-center text-center min-w-0">
      <div
        className="relative w-[164px] h-[164px] rounded-full flex items-center justify-center"
        style={{
          background: observed
            ? `conic-gradient(${color} ${used * 3.6}deg, var(--material-thin) 0deg)`
            : "conic-gradient(var(--text-quaternary) 0deg, var(--material-thin) 0deg)",
        }}
      >
        <div className="absolute inset-[12px] rounded-full bg-[var(--material-regular)] border border-[var(--separator)]" />
        <div className="relative z-10">
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{windowLabel(window)}</div>
          <div className="mt-1 text-[length:var(--text-title1)] font-[var(--weight-bold)] text-[var(--text-primary)]">
            {observed ? `${window.usedPercent}%` : "-"}
          </div>
          <div className="mt-1 text-[length:var(--text-caption1)]" style={{ color }}>
            {observed ? `${100 - used}% left` : "pending"}
          </div>
        </div>
      </div>
      <div className="mt-[var(--space-3)] text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
        {window.name}
      </div>
      <div className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        Resets {formatDate(window.resetsAtIso)}
      </div>
    </div>
  )
}

function EngineGaugePanel({ engine }: { engine: EngineLimitEngineSnapshot }) {
  const windows = engine.windows || []
  const source = engine.source.replace(" account/rateLimits/read", "")
  const tone = statusColor(engine)
  const context = engine.context
  const note = engine.error || (engine.stale ? "Latest snapshot is older than 30 minutes." : null)

  return (
    <section className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-regular)] overflow-hidden">
      <div className="px-[var(--space-5)] py-[var(--space-4)] border-b border-[var(--separator)] flex flex-wrap items-start justify-between gap-[var(--space-3)]">
        <div>
          <div className="flex items-center gap-[var(--space-3)]">
            <h2 className="text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)] capitalize">
              {engine.name}
            </h2>
            <span
              className="inline-flex items-center rounded-[var(--radius-sm)] px-2 py-1 text-[length:var(--text-caption1)] font-[var(--weight-semibold)]"
              style={{ color: tone, background: "color-mix(in srgb, currentColor 10%, transparent)" }}
            >
              {statusLabel(engine)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-[var(--space-3)] gap-y-1 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
            <span>{source}</span>
            {engine.accountPlan && (
              <span className="inline-flex items-center gap-1">
                <WalletCards size={13} />
                {engine.accountPlan}
              </span>
            )}
          </div>
        </div>
        <div className="text-right text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          <div>Updated</div>
          <div>{formatDate(engine.refreshedAt)}</div>
        </div>
      </div>

      <div className="p-[var(--space-5)] grid gap-[var(--space-5)]">
        <div className="grid gap-[var(--space-5)] sm:grid-cols-2">
          {windows.map((window) => (
            <CircularGauge key={`${engine.name}-${window.name}`} window={window} />
          ))}
        </div>

        <div className="grid gap-[var(--space-3)] md:grid-cols-3">
          {context && (
            <InfoCell
              label="Context"
              value={context.usedPercent === undefined ? "Unknown" : `${context.usedPercent}%`}
              detail={context.contextWindowSize ? `${context.contextWindowSize.toLocaleString()} token window` : "Window unknown"}
            />
          )}
          {engine.credits && (
            <InfoCell
              label="Credits"
              value={engine.credits.balance ? `Balance ${engine.credits.balance}` : engine.credits.hasCredits === false ? "None" : "Unknown"}
              detail={engine.credits.unlimited ? "Unlimited" : "Account credits"}
            />
          )}
          {engine.costUsd !== undefined && (
            <InfoCell label="Session cost" value={`$${engine.costUsd.toFixed(4)}`} detail="Latest captured session" />
          )}
        </div>

        <ExtraBuckets buckets={engine.buckets || []} />

        {note && (
          <div className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)] p-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            {note}
          </div>
        )}
      </div>
    </section>
  )
}

function InfoCell({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)] p-[var(--space-3)] min-w-0">
      <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{label}</div>
      <div className="mt-1 text-[length:var(--text-callout)] font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">
        {value}
      </div>
      <div className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">{detail}</div>
    </div>
  )
}

function ExtraBuckets({ buckets }: { buckets: EngineLimitBucket[] }) {
  const extra = buckets.filter((bucket) => bucket.id !== "codex")
  if (extra.length === 0) return null
  return (
    <div className="grid gap-[var(--space-2)]">
      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
        Extra Codex buckets
      </div>
      {extra.map((bucket) => (
        <div key={bucket.id} className="grid gap-[var(--space-3)] md:grid-cols-[220px_1fr_1fr] border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)] p-[var(--space-3)]">
          <div className="min-w-0">
            <div className="font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">{bucket.name || bucket.id}</div>
            <div className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{bucket.planType || "bucket"}</div>
          </div>
          {bucket.primary && <MiniWindow window={bucket.primary} />}
          {bucket.secondary && <MiniWindow window={bucket.secondary} />}
        </div>
      ))}
    </div>
  )
}

function MiniWindow({ window }: { window: EngineLimitWindow }) {
  const used = clampPercent(window.usedPercent)
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-[var(--space-2)] text-[length:var(--text-caption1)]">
        <span className="text-[var(--text-secondary)]">{window.name}</span>
        <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{window.usedPercent ?? 0}%</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-[var(--material-regular)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${used}%`, background: gaugeColor(window.usedPercent) }} />
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

  const engines = useMemo(
    () => FEATURED_ENGINES.map((name) => data?.engines[name]).filter(Boolean) as EngineLimitEngineSnapshot[],
    [data],
  )

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
            <div className="min-w-0">
              <h1 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] text-[var(--text-primary)] leading-[var(--leading-tight)]">
                Claude / Codex Limits
              </h1>
              <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] mt-[var(--space-1)]">
                {data ? `Generated ${formatDate(data.generatedAt)}` : "Loading live quota telemetry"}
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

        <main className="flex-1 overflow-y-auto px-[var(--space-6)] pt-[var(--space-4)] pb-[var(--space-6)]">
          {error && (
            <div className="mb-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--system-red)] text-[length:var(--text-footnote)] text-[var(--system-red)]">
              {error}
            </div>
          )}

          {loading ? (
            <div className="h-[220px] flex items-center justify-center text-[var(--text-tertiary)]">Loading...</div>
          ) : (
            <div className="grid gap-[var(--space-4)]">
              <SummaryStrip engines={engines} />
              <div className="grid gap-[var(--space-4)] xl:grid-cols-2 items-start">
                {engines.map((engine) => (
                  <EngineGaugePanel key={engine.name} engine={engine} />
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </PageLayout>
  )
}
