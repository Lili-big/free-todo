import { NavLink, Outlet } from 'react-router-dom'
import { formatDate } from '../utils/date'
import appIcon from '../assets/app-icon.png'

const primaryNavigation = [
  { to: '/today', icon: '☀', label: '今日' },
  { to: '/quadrants', icon: '▥', label: '四象限' },
  { to: '/planning', icon: '◇', label: '待分配' },
  { to: '/tasks', icon: '☷', label: '任务总览' },
  { to: '/calendar', icon: '▦', label: '日历' }
]

const directionNavigation = [
  { to: '/projects', icon: '□', label: '项目' },
  { to: '/goals', icon: '◎', label: '目标' },
  { to: '/recurrences', icon: '↻', label: '重复系列' }
]

export function AppShell({ today, appVersion }: { today: string; appVersion?: string }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <img className="brand-mark brand-mark--small" src={appIcon} alt="" draggable={false} />
          <div><strong>逐个锤</strong></div>
        </div>
        <div className="sidebar__date"><span>今天</span><strong>{formatDate(today, { weekday: true })}</strong></div>
        <nav className="sidebar__nav" aria-label="主要导航">
          {primaryNavigation.map((item) => <NavigationItem {...item} key={item.to} />)}
        </nav>
        <span className="sidebar__section-label">方向与推进</span>
        <nav className="sidebar__nav" aria-label="方向与推进">
          {directionNavigation.map((item) => <NavigationItem {...item} key={item.to} />)}
        </nav>
        <div className="sidebar__spacer" />
        <nav className="sidebar__nav sidebar__nav--bottom" aria-label="设置">
          <NavigationItem to="/data" icon="⇄" label="数据管理" />
        </nav>
        <div className="sidebar__footer"><span className="status-dot status-dot--online" />本地数据已自动保存{appVersion ? <small>v{appVersion}</small> : null}</div>
      </aside>
      <main className="workspace"><Outlet /></main>
    </div>
  )
}

function NavigationItem({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => isActive ? 'nav-item is-active' : 'nav-item'}>
      <span className="nav-item__icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </NavLink>
  )
}
