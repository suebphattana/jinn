
import { type ReactNode } from 'react'
import { Plus, Menu } from 'lucide-react'
import { type ChatTab } from '@/hooks/use-chat-tabs'
import { cn } from '@/lib/utils'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'

// ---- Frosted pill primitives (mockup _shared.css `.pill` recipe) ----
// backdrop-blur(20px) saturate(1.3) over a theme-aware translucent material,
// 0.5px theme-aware border, overlay shadow, full radius. The material + border
// flip with the active theme via --pill-bg / --pill-border (globals.css).
export const PILL_CLASS =
  "pointer-events-auto inline-flex items-center gap-0.5 rounded-full border-[0.5px] border-[var(--pill-border)] " +
  "bg-[var(--pill-bg)] p-1 shadow-[var(--shadow-overlay)] " +
  "[backdrop-filter:blur(20px)_saturate(1.3)] [-webkit-backdrop-filter:blur(20px)_saturate(1.3)]"

export function PillButton({
  onClick,
  title,
  ariaLabel,
  className,
  children,
}: {
  onClick?: () => void
  title?: string
  ariaLabel?: string
  className?: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className={cn(
        // D1: 36px tap target at base (Apple HIG floor); tighten to 32px on desktop.
        "inline-flex size-9 lg:size-8 shrink-0 items-center justify-center rounded-full transition-colors",
        "text-[var(--text-secondary)]",
        "hover:bg-[var(--fill-secondary)] hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  )
}

export interface ChatHeaderPillsProps {
  /** Left pill */
  sidebarCollapsed?: boolean
  /** Hamburger → toggles/opens the chat list (desktop collapse, mobile view swap). */
  onToggleSidebar?: () => void
  /** Employee name (used as the avatar slug fallback). */
  employeeName?: string
  /** Avatar slug — the left pill always shows the avatar, never a title. */
  avatarName?: string
  /** Hide both pills on mobile (e.g. over the chat-list view, which has its own header). */
  hideOnMobile?: boolean

  /** Right pill. Tab state is retained for callers, but the in-header tab
   *  switcher UI was removed — tabs are managed elsewhere. */
  tabs: ChatTab[]
  activeIndex: number
  onSwitch: (index: number) => void
  onClose: (index: number) => void
  onNew: () => void
  /** Existing "more" (…) menu element, rendered as the last pill control. */
  moreMenu?: ReactNode
}

export function ChatHeaderPills({
  onToggleSidebar,
  employeeName,
  avatarName,
  hideOnMobile,
  onNew,
  moreMenu,
}: ChatHeaderPillsProps) {
  const hideCls = hideOnMobile ? "hidden lg:block" : ""
  return (
    <>
      {/* LEFT pill — hamburger (opens chat list) + employee avatar (always).
          D2: top/left respect the safe-area on notched devices (Dynamic Island),
          composing max(inset,12px) at the call site; desktop stays at the tight 4. */}
      <div className={cn("pointer-events-none absolute left-[max(var(--safe-left),12px)] top-[max(var(--safe-top),12px)] z-10 lg:left-4 lg:top-4", hideCls)}>
        <div className={PILL_CLASS}>
          {onToggleSidebar && (
            <PillButton onClick={onToggleSidebar} title="Chats" ariaLabel="Toggle chat list">
              <Menu size={17} />
            </PillButton>
          )}
          {/* D5: avatar is purely identity, not a control — de-emphasize so it
              reads as non-interactive next to the live hamburger (no hover/cursor
              affordance, slightly recessed, unselectable). */}
          <span className="flex size-7 select-none items-center justify-center pr-1 pl-0.5 opacity-80">
            <EmployeeAvatar name={avatarName || employeeName || ''} size={24} />
          </span>
        </div>
      </div>

      {/* RIGHT pill — new · more */}
      <div className={cn("pointer-events-none absolute right-[max(var(--safe-right),12px)] top-[max(var(--safe-top),12px)] z-10 lg:right-4 lg:top-4", hideCls)}>
        <div className={PILL_CLASS}>
          <PillButton onClick={onNew} title="New Chat (N)" ariaLabel="New chat">
            <Plus size={18} strokeWidth={2.4} />
          </PillButton>
          {moreMenu}
        </div>
      </div>
    </>
  )
}
