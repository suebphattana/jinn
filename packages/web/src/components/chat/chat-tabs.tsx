
import { type ReactNode } from 'react'
import { Plus, Menu } from 'lucide-react'
import { type ChatTab } from '@/hooks/use-chat-tabs'
import { cn } from '@/lib/utils'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
// Frosted pill primitives now live in the shared cross-page pill system.
import { PILL_CLASS, PillButton } from '@/components/pill-nav'

export interface ChatHeaderPillsProps {
  /** Left pill — nav toggle: swaps the left surface (chat list ⇄ nav) on
   *  desktop, returns to the chat list on mobile. */
  onToggleSidebar?: () => void
  /** Employee name (used as the avatar slug fallback). */
  employeeName?: string
  /** Avatar slug — the left pill shows the avatar next to the title. */
  avatarName?: string
  /** Page title shown in the left pill (conversation title / "New chat"). */
  title?: string
  /** True when the left surface currently shows nav (styles the toggle active). */
  navActive?: boolean
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
  title,
  navActive,
  hideOnMobile,
  onNew,
  moreMenu,
}: ChatHeaderPillsProps) {
  const hideCls = hideOnMobile ? "hidden lg:block" : ""
  return (
    <>
      {/* LEFT pill — nav toggle (swaps the left surface list⇄nav) + employee
          avatar + conversation title.
          D2: top/left respect the safe-area on notched devices (Dynamic Island),
          composing max(inset,12px) at the call site; desktop stays at the tight 4. */}
      <div className={cn("pointer-events-none absolute left-[max(var(--safe-left),12px)] top-[max(var(--safe-top),12px)] z-10 lg:left-4 lg:top-4", hideCls)}>
        <div className={PILL_CLASS}>
          {onToggleSidebar && (
            <PillButton
              onClick={onToggleSidebar}
              title="Menu"
              ariaLabel="Toggle navigation"
              ariaExpanded={navActive}
              className={navActive ? "bg-[var(--fill-secondary)] text-foreground" : undefined}
            >
              <Menu size={17} />
            </PillButton>
          )}
          {/* D5: avatar is purely identity, not a control — de-emphasize so it
              reads as non-interactive next to the live nav toggle (no hover/cursor
              affordance, slightly recessed, unselectable). */}
          <span className="flex size-7 select-none items-center justify-center pl-0.5 opacity-80">
            <EmployeeAvatar name={avatarName || employeeName || ''} size={24} />
          </span>
          {title && (
            <span className="max-w-[42vw] select-none truncate pl-0.5 pr-2.5 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)] lg:max-w-[28vw]">
              {title}
            </span>
          )}
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
