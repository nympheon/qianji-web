import { createRoot } from 'react-dom/client';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-3 px-6">
      <h1 className="text-2xl font-semibold">钱迹</h1>
      <p>尚未连接</p>
    </main>,
  );
}
