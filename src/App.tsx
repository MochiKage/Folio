import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ReaderViewport from './components/ReaderViewport'
import StatusBar from './components/StatusBar'
import ContextMenu from './components/ContextMenu'

export default function App() {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <ReaderViewport />
      </div>
      <StatusBar />
      <ContextMenu />
    </div>
  )
}
