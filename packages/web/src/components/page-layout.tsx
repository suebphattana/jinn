
import { lazy, Suspense } from "react"
import { Link, useLocation } from "react-router-dom"
import { useSettings } from "@/routes/settings-provider"
import { PillNav } from "./pill-nav"
import { X } from "lucide-react"
import { NAV_ITEMS } from "@/lib/nav"
import { isNavItemActive } from "./pill-nav"
import { cn } from "@/lib/utils"

const GlobalSearch = lazy(() => import("./global-search").then(m => ({ default: m.GlobalSearch })))
const LiveStreamWidget = lazy(() => import("./live-stream-widget").then(m => ({ default: m.LiveStreamWidget })))
const OnboardingWizard = lazy(() => import("./onboarding-wizard").then(m => ({ default: m.OnboardingWizard })))

/**
 * Legacy mobile global-nav drawer (NAV_ITEMS), still consumed by the chat route
 * until it adopts the in-surface nav swap. Non-chat pages now reach nav through
 * the PillNav popover, so PageLayout no longer renders this itself.
 */
export function MobileNavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = useLocation().pathname
  const { settings } = useSettings()
  const emoji = settings.portalEmoji ?? "\u{1F9DE}"
  const portalName = settings.portalName ?? "Jinn"
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[120]">
      <div
        className="absolute inset-0 backdrop-blur-md"
        style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)" }}
        onClick={onClose}
      />
      <nav
        className="absolute inset-y-0 left-0 flex w-[260px] flex-col bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)]"
        style={{ animation: "slideInLeft 200ms var(--ease-smooth)" }}
      >
        <div className="flex items-center justify-between px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[22px]">{emoji}</span>
            <span className="text-base font-semibold text-foreground">{portalName}</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-1 p-2">
          {NAV_ITEMS.map((item) => {
            const isActive = isNavItemActive(item.href, pathname)
            const Icon = item.icon
            return (
              <Link
                key={item.href}
                to={item.href}
                onClick={onClose}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-[10px] px-3.5 text-[15px] transition-colors",
                  isActive
                    ? "bg-[var(--accent-fill)] font-semibold text-[var(--accent)]"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon size={18} className="shrink-0" />
                {item.label}
              </Link>
            )
          })}
        </div>
      </nav>
      <style>{`
        @keyframes slideInLeft {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}

export function ToolbarActions({ children }: { children?: React.ReactNode }) {
  return (
    <div className="hidden items-center gap-2 lg:flex">
      {children}
    </div>
  )
}

/**
 * App shell. The persistent left rail and the solid desktop/mobile header bars
 * are gone — every non-chat page now carries the pinned PillNav (left pill =
 * nav + page title, right pill = optional actions). Content clears the floating
 * pills with a top inset. `chromeless` routes (chat) draw their own pills.
 */
export function PageLayout({ children, headerActions, chromeless }: { children: React.ReactNode; headerActions?: React.ReactNode; chromeless?: boolean }) {
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Suspense fallback={null}>
        <GlobalSearch />
      </Suspense>
      <main className="relative flex flex-1 flex-col overflow-hidden">
        {!chromeless && <PillNav actions={headerActions} />}
        <div
          className={cn(
            "flex-1 overflow-hidden",
            // Clear the floating pills so content doesn't start under them.
            !chromeless && "pt-[calc(max(var(--safe-top),12px)+52px)]",
          )}
        >
          {children}
        </div>
      </main>
      <Suspense fallback={null}>
        <LiveStreamWidget />
      </Suspense>
      <Suspense fallback={null}>
        <OnboardingWizard />
      </Suspense>
    </div>
  )
}
