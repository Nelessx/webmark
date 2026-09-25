import { useEffect, useMemo } from 'react';
import { PriorityIcon } from '@/components/PriorityIcon';
import { pinNumber } from '@/lib/constants';
import { formatRelativeTime } from '@/lib/format';
import { PRIORITY_LABELS, STATUS_LABELS } from '@/lib/noteMeta';
import type { Note } from '@/lib/types';
import { pinRowPositions, placeTooltip, type Point } from '../geometry';
import type { LayoutSnapshot } from '../layout';
import { hasPin, outsideModal } from '../store';
import { useAppState, useLayout, useWebmark } from './context';

const TOOLTIP_WIDTH = 260;
const PREVIEW_CHARS = 120;

interface PlacedPin {
  note: Note;
  number: number;
  position: Point;
}

interface PinGroup {
  element: Element;
  notes: Note[];
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

/** "WebMark note 3, In progress, high priority: Revenue card". */
function pinLabel(number: number, note: Note): string {
  const priority = note.priority === 'high' ? ', high priority' : '';
  return `WebMark note ${number}, ${STATUS_LABELS[note.status]}${priority}: ${note.label}`;
}

/** Group the found notes that get a pin (not archived ones) by element, in pin-number order. */
function useGroups(): PinGroup[] {
  const notes = useAppState((s) => s.notes);
  const resolved = useAppState((s) => s.resolved);
  return useMemo(() => {
    const groups = new Map<Element, Note[]>();
    for (const note of notes) {
      const el = hasPin(note) ? resolved.get(note.id) : undefined;
      if (!el) continue;
      const list = groups.get(el);
      if (list) list.push(note);
      else groups.set(el, [note]);
    }
    return [...groups].map(([element, list]) => ({ element, notes: list }));
  }, [notes, resolved]);
}

/**
 * Pins for every visible annotated element; several notes on one element sit
 * in a row. Numbers count every note of the page, archived ones included, so
 * "#3" is the same note everywhere.
 */
function placePins(groups: PinGroup[], notes: Note[], layout: LayoutSnapshot, modal: Element | null): PlacedPin[] {
  const placed: PlacedPin[] = [];
  for (const group of groups) {
    if (outsideModal(modal, group.element)) continue;
    const box = layout.boxes.get(group.element);
    if (!box?.visible) continue;
    const positions = pinRowPositions(box, group.notes.length, layout.viewport);
    group.notes.forEach((note, i) => {
      const position = positions[i];
      if (position) placed.push({ note, number: pinNumber(note.id, notes), position });
    });
  }
  return placed;
}

export function Pins() {
  const { actions } = useWebmark();
  const notes = useAppState((s) => s.notes);
  const pinsVisible = useAppState((s) => s.settings.pinsVisible);
  const hoverNoteId = useAppState((s) => s.hoverNoteId);
  const editingId = useAppState((s) => s.editor?.noteId);
  const layout = useLayout();
  const groups = useGroups();

  const modal = useAppState((s) => s.modal);
  const placed = pinsVisible ? placePins(groups, notes, layout, modal) : [];
  const hovered = placed.find((p) => p.note.id === hoverNoteId);
  const hoveredPinGone = !!hoverNoteId && !hovered;

  // A pin that disappears under the pointer (element scrolled away, pins hidden) never gets mouseleave.
  useEffect(() => {
    if (hoveredPinGone) actions.setHover(null);
  }, [actions, hoveredPinGone]);

  if (!placed.length) return null;

  return (
    <div className="wm-pins" data-wm-pins="">
      {placed.map(({ note, number, position }) => (
        <button
          key={note.id}
          type="button"
          className="wm-pin"
          data-wm-pin={note.id}
          data-status={note.status}
          data-priority={note.priority}
          aria-label={pinLabel(number, note)}
          style={{ translate: `${position.left}px ${position.top}px` }}
          onClick={() => actions.openNote(note.id)}
          onMouseEnter={() => actions.setHover(note.id)}
          onMouseLeave={() => actions.setHover(null)}
          onFocus={() => actions.setHover(note.id)}
          onBlur={() => actions.setHover(null)}
        >
          {number}
        </button>
      ))}
      {hovered && hovered.note.id !== editingId && <PinTooltip pin={hovered} layout={layout} />}
    </div>
  );
}

function PinTooltip({ pin, layout }: { pin: PlacedPin; layout: LayoutSnapshot }) {
  const place = placeTooltip(pin.position, TOOLTIP_WIDTH, layout.viewport);
  const { note } = pin;
  return (
    <div
      className="wm-tooltip"
      role="tooltip"
      data-wm-tooltip={note.id}
      style={{ left: place.left, top: place.top, bottom: place.bottom, width: TOOLTIP_WIDTH }}
    >
      <div className="wm-tooltip__head">
        <span className="wm-tooltip__num" data-status={note.status}>
          #{pin.number}
        </span>
        <span className="wm-tooltip__label">{note.label}</span>
      </div>
      {note.body && <div className="wm-tooltip__body">{preview(note.body)}</div>}
      <div className="wm-tooltip__props">
        <span className="wm-tooltip__status" data-status={note.status}>
          {STATUS_LABELS[note.status]}
        </span>
        <span className="wm-tooltip__priority" data-priority={note.priority}>
          <PriorityIcon priority={note.priority} />
          {PRIORITY_LABELS[note.priority]} priority
        </span>
      </div>
      <div className="wm-tooltip__meta">
        {note.author ? `${note.author} · ` : ''}
        {formatRelativeTime(note.updatedAt)}
      </div>
    </div>
  );
}
