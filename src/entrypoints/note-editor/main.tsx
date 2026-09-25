import { createRoot } from 'react-dom/client';
import { pinNumber } from '@/lib/constants';
import { getNotesForPage, getSettings } from '@/lib/storage';
import { DEFAULT_SETTINGS } from '@/lib/types';
import { App } from './App';
import { connect, emit, takeToken } from './session';
import './style.css';

// First thing: the token must not linger in the URL.
const token = takeToken();

/**
 * Render the editor for the session named by the token. Without a session
 * WebMark's content script registered for this tab (someone else framed this
 * page, or opened it directly) the page stays blank.
 */
async function start(): Promise<void> {
  const container = document.getElementById('root');
  const session = token && container ? await connect(token) : undefined;
  if (!token || !container || !session) {
    document.body.setAttribute('data-wm-denied', '');
    return;
  }
  const { request } = session;
  const [notes, settings] = await Promise.all([
    request.mode === 'edit' ? getNotesForPage(request.page.pageKey).catch(() => []) : Promise.resolve([]),
    getSettings().catch(() => DEFAULT_SETTINGS),
  ]);
  const note = request.mode === 'edit' ? notes.find((n) => n.id === request.noteId) : undefined;
  if (request.mode === 'edit' && !note) {
    await emit(token, { kind: 'toast', text: 'This note no longer exists', tone: 'error' });
    await emit(token, { kind: 'closed' });
    return;
  }
  createRoot(container).render(
    <App
      token={token}
      session={session}
      note={note}
      number={note ? pinNumber(note.id, notes) : 0}
      authorName={settings.authorName}
    />,
  );
}

void start();
