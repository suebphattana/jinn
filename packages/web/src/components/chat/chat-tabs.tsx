
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X, Plus, PanelLeftOpen, PanelLeftClose, Menu, Search, LayoutGrid, FileText } from 'lucide-react'
import { tabKey, type ChatTab } from '@/hooks/use-chat-tabs'
import { cn } from '@/lib/utils'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { cleanPreview } from '@/lib/clean-preview'

// ---- Frosted pill primitives (mockup _shared.css `.pill` recipe) ----
// backdrop-blur(20px) saturate(1.3) over ~55% charcoal, 0.5px white border,
// overlay shadow, full radius.
const PILL_CLASS =
  "pointer-events-auto inline-flex items-center gap-0.5 rounded-full border-[0.5px] border-white/10 " +
  "bg-[rgba(30,28,22,0.55)] p-1 shadow-[var(--shadow-overlay)] " +
  "[backdrop-filter:blur(20px)_saturate(1.3)] [-webkit-backdrop-filter:blur(20px)_saturate(1.3)]"

function PillButton({
  onClick,
  title,
  ariaLabel,
  accent,
  className,
  children,
}: {
  onClick?: () => void
  title?: string
  ariaLabel?: string
  accent?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
        accent ? "text-[var(--accent)]" : "text-[var(--text-secondary)]",
        "hover:bg-[var(--fill-secondary)] hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  )
}

const PillSep = () => <span className="mx-1 h-[18px] w-px shrink-0 bg-white/10" />

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-blue-500 animate-pulse',
  error: 'bg-red-500',
  idle: 'bg-zinc-500',
}

// Compact popover listing the open tabs — replaces the old horizontal tab strip
// now that the header is a pair of pills. Switch on click; close with the ×.
function TabSwitcher({
  tabs,
  activeIndex,
  onSwitch,
  onClose,
  onNew,
}: {
  tabs: ChatTab[]
  activeIndex: number
  onSwitch: (i: number) => void
  onClose: (i: number) => void
  onNew: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <PillButton
        onClick={() => setOpen((v) => !v)}
        title="Open tabs"
        ariaLabel="Open tabs"
        className={open ? "bg-[var(--fill-secondary)] text-foreground" : undefined}
      >
        <LayoutGrid size={17} />
        {tabs.length > 1 && (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-[14px] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-bold leading-[14px] text-[var(--accent-contrast)]">
            {tabs.length}
          </span>
        )}
      </PillButton>

      {open && (
        <div className="absolute right-0 top-full z-[200] mt-2 max-h-[60vh] w-[280px] overflow-y-auto rounded-[var(--radius-md)] border border-border bg-[var(--material-thick)] p-1 shadow-[var(--shadow-overlay)] [backdrop-filter:blur(20px)]">
          {tabs.length === 0 ? (
            <div className="px-3 py-3 text-center text-xs text-[var(--text-quaternary)]">No open tabs</div>
          ) : (
            tabs.map((tab, i) => (
              <div
                key={tabKey(tab)}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs transition-colors",
                  i === activeIndex ? "bg-[var(--fill-secondary)] text-foreground" : "text-[var(--text-secondary)] hover:bg-accent",
                )}
                onClick={() => { onSwitch(i); setOpen(false) }}
              >
                {tab.kind === 'session' ? (
                  <span className={`size-1.5 shrink-0 rounded-full ${STATUS_COLORS[tab.status] || STATUS_COLORS.idle}`} />
                ) : (
                  <FileText size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                )}
                {tab.kind === 'session' && tab.employeeName && <EmployeeAvatar name={tab.employeeName} size={16} />}
                <span className={cn("min-w-0 flex-1 truncate", tab.pinned ? "font-medium" : "font-normal")}>
                  {tab.kind === 'file' ? tab.label : cleanPreview(tab.label) || 'Untitled'}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onClose(i) }}
                  aria-label="Close tab"
                  className="rounded-sm p-0.5 text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100"
                >
                  <X size={12} />
                </button>
              </div>
            ))
          )}
          <button
            onClick={() => { onNew(); setOpen(false) }}
            className="mt-1 flex w-full items-center gap-2 rounded-[var(--radius-sm)] border-t border-border px-2 py-2 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus size={13} /> New chat
          </button>
        </div>
      )}
    </div>
  )
}

export interface ChatHeaderPillsProps {
  /** Left pill */
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  /** Mobile-only global-nav trigger (≡). Desktop reaches nav via the 56px rail. */
  onOpenNav?: () => void
  /** Breadcrumb: employee crumb + chat title. */
  employeeName?: string
  crumbLabel?: string
  title?: string
  /** Avatar slug for the scrolled/collapsed state. */
  avatarName?: string
  /** When the thread is scrolled, the left pill sheds its title → toggle + avatar. */
  scrolled?: boolean
  /** Hide both pills on mobile (e.g. over the chat-list view, which has its own header). */
  hideOnMobile?: boolean

  /** Right pill */
  tabs: ChatTab[]
  activeIndex: number
  onSwitch: (index: number) => void
  onClose: (index: number) => void
  onNew: () => void
  onSearch?: () => void
  /** Existing "more" (…) menu element, rendered as the last pill control. */
  moreMenu?: ReactNode
}

export function ChatHeaderPills({
  sidebarCollapsed,
  onToggleSidebar,
  onOpenNav,
  employeeName,
  crumbLabel,
  title,
  avatarName,
  scrolled,
  hideOnMobile,
  tabs,
  activeIndex,
  onSwitch,
  onClose,
  onNew,
  onSearch,
  moreMenu,
}: ChatHeaderPillsProps) {
  const hasTitle = !!(title || crumbLabel)
  const hideCls = hideOnMobile ? "hidden lg:block" : ""
  return (
    <>
      {/* LEFT pill — collapse toggle + breadcrumb (sheds title on scroll) */}
      <div className={cn("pointer-events-none absolute left-3 top-3 z-10 lg:left-4", hideCls)}>
        <div className={PILL_CLASS}>
          {onOpenNav && (
            <PillButton onClick={onOpenNav} title="Menu" ariaLabel="Open navigation" className="lg:hidden">
              <Menu size={17} />
            </PillButton>
          )}
          {onToggleSidebar && (
            <PillButton
              onClick={onToggleSidebar}
              title={sidebarCollapsed ? "Show chats" : "Hide chats"}
              ariaLabel={sidebarCollapsed ? "Show chats" : "Hide chats"}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </PillButton>
          )}
          {scrolled || !hasTitle ? (
            <span className="flex size-7 items-center justify-center pr-1 pl-0.5">
              <EmployeeAvatar name={avatarName || employeeName || ''} size={24} />
            </span>
          ) : (
            <span className="max-w-[42vw] truncate whitespace-nowrap px-2 text-xs font-semibold tracking-[-0.2px] text-foreground lg:max-w-[420px]">
              {crumbLabel && <span className="font-medium text-[var(--text-tertiary)]">{crumbLabel}&nbsp;&nbsp;/&nbsp;&nbsp;</span>}
              {title}
            </span>
          )}
        </div>
      </div>

      {/* RIGHT pill — search · tabs · new · more */}
      <div className={cn("pointer-events-none absolute right-3 top-3 z-10 lg:right-4", hideCls)}>
        <div className={PILL_CLASS}>
          {onSearch && (
            <PillButton onClick={onSearch} title="Search (⌘K)" ariaLabel="Search">
              <Search size={17} />
            </PillButton>
          )}
          <TabSwitcher tabs={tabs} activeIndex={activeIndex} onSwitch={onSwitch} onClose={onClose} onNew={onNew} />
          <PillSep />
          <PillButton onClick={onNew} accent title="New Chat (N)" ariaLabel="New chat">
            <Plus size={18} strokeWidth={2.4} />
          </PillButton>
          {moreMenu}
        </div>
      </div>
    </>
  )
}
