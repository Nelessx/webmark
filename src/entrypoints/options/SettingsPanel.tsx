import { useEffect, useState } from 'react';
import { useSettings } from '@/components/hooks';
import { Switch } from '@/components/Switch';
import { DEFAULT_SHORTCUTS } from '@/lib/constants';

export function SettingsPanel() {
  const [settings, update, loading] = useSettings();
  const [author, setAuthor] = useState(settings.authorName);

  // Sync the draft once stored settings arrive (or change in another tab).
  useEffect(() => setAuthor(settings.authorName), [settings.authorName]);

  function saveAuthor() {
    const name = author.trim().slice(0, 60);
    if (name !== settings.authorName) void update({ authorName: name });
  }

  if (loading) return null;

  return (
    <section className="wm-allnotes__settings" aria-label="Settings">
      <label className="wm-allnotes__field">
        <span>Your name</span>
        <input
          type="text"
          placeholder="Shown on notes you write, e.g. in exported reports"
          value={author}
          maxLength={60}
          onChange={(e) => setAuthor(e.target.value)}
          onBlur={saveAuthor}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </label>
      <Switch
        checked={settings.captureScreenshots}
        onChange={(captureScreenshots) => void update({ captureScreenshots })}
        label="Save a screenshot of the element with each new note"
      />
      <Switch
        checked={settings.pinsVisible}
        onChange={(pinsVisible) => void update({ pinsVisible })}
        label="Show note pins on pages"
      />
      <p className="wm-allnotes__hint">
        Shortcuts: {DEFAULT_SHORTCUTS.startPicker} adds a note, {DEFAULT_SHORTCUTS.togglePins} shows or hides pins. Change
        them in your browser's extension shortcut settings.
      </p>
    </section>
  );
}
