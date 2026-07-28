import { useEffect, useMemo, useState } from "react";
import { useApp } from "../App";
import { thumbUrl } from "../lib/api";
import type { Side, SlotRef } from "../lib/types";
import { autoFlow, getSlot, setSlot, swapSlots } from "../lib/album";

type DragData = { type: "slot"; ref: SlotRef } | { type: "tray"; uuid: string };

export function Album({ goCuradoria }: { goCuradoria: () => void }) {
  const { slug, project, chosenSorted, setProject, photosByUuid, patchPhoto } = useApp();
  const sheets = project.album.sheets;
  const [drag, setDrag] = useState<DragData | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const placedSet = useMemo(() => {
    const s = new Set<string>();
    sheets.forEach((sh) => [...sh.front, ...sh.back].forEach((u) => u && s.add(u)));
    return s;
  }, [sheets]);

  const tray = useMemo(() => chosenSorted.filter((p) => !placedSet.has(p.uuid)), [chosenSorted, placedSet]);

  // On open, scroll to where you left off (last sheet with content and an empty slot;
  // otherwise the next fully empty sheet; otherwise the last one).
  useEffect(() => {
    let lastPartial = -1;
    let firstEmpty = -1;
    sheets.forEach((s, i) => {
      const slots = [...s.front, ...s.back];
      const filled = slots.filter(Boolean).length;
      if (filled > 0 && filled < slots.length) lastPartial = i;
      if (firstEmpty === -1 && filled === 0) firstEmpty = i;
    });
    const target = lastPartial >= 0 ? lastPartial : firstEmpty >= 0 ? firstEmpty : sheets.length - 1;
    // espera o layout montar antes de rolar
    const id = window.setTimeout(() => {
      document.getElementById(`sheet-${target}`)?.scrollIntoView({ block: "start", behavior: "auto" });
    }, 50);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const autoFill = () => {
    if (placedSet.size > 0 && !confirm("This will redistribute all chosen photos in chronological order and overwrite the current arrangement. Continue?")) return;
    setProject((p) => ({ ...p, album: { sheets: autoFlow(p.album.sheets.length, chosenSorted.map((x) => x.uuid)) } }));
  };

  const appendNew = () => {
    // place tray photos into the next empty slots, in order
    setProject((p) => {
      let next = p.album.sheets.map((s) => ({ front: [...s.front], back: [...s.back] }));
      const empties: SlotRef[] = [];
      for (let sheet = 0; sheet < next.length; sheet++)
        for (const side of ["front", "back"] as Side[])
          for (const pos of [0, 1] as (0 | 1)[]) if (!next[sheet][side][pos]) empties.push({ sheet, side, pos });
      tray.forEach((ph, i) => {
        const ref = empties[i];
        if (ref) next[ref.sheet][ref.side][ref.pos] = ph.uuid;
      });
      return { ...p, album: { sheets: next } };
    });
  };

  const onDropSlot = (target: SlotRef) => {
    if (!drag) return;
    setProject((p) => {
      const cur = p.album.sheets;
      let next;
      if (drag.type === "slot") next = swapSlots(cur, drag.ref, target);
      else next = setSlot(cur, target, drag.uuid);
      return { ...p, album: { sheets: next } };
    });
    setDrag(null);
  };

  const onDropTray = () => {
    if (drag?.type === "slot") {
      setProject((p) => ({ ...p, album: { sheets: setSlot(p.album.sheets, drag.ref, null) } }));
    }
    setDrag(null);
  };

  return (
    <div className="album">
      <div className="album-toolbar">
        <div className="album-actions">
          <button className="btn-primary" onClick={autoFill}>
            ✦ Auto-fill chronologically
          </button>
          {tray.length > 0 && (
            <button className="btn-ghost" onClick={appendNew}>
              + Add {tray.length} new to the end
            </button>
          )}
        </div>
        {chosenSorted.length === 0 && (
          <p className="album-hint">
            No photos chosen yet. Go to <button className="link" onClick={goCuradoria}>Curate</button> and pick photos for each day.
          </p>
        )}
      </div>

      <div className="sheets">
        {sheets.map((sheet, i) => (
          <div className="sheet" key={i} id={`sheet-${i}`}>
            <div className="sheet-tab">Sheet {String(i + 1).padStart(2, "0")}</div>
            <div className="sheet-body">
              <SideView
                sheetIndex={i}
                side="front"
                slots={sheet.front}
                setDrag={setDrag}
                onDropSlot={onDropSlot}
                patchPhoto={patchPhoto}
              />
              <SideView
                sheetIndex={i}
                side="back"
                slots={sheet.back}
                setDrag={setDrag}
                onDropSlot={onDropSlot}
                patchPhoto={patchPhoto}
              />
            </div>
          </div>
        ))}
      </div>

      {chosenSorted.length > 0 && (
        <div
          className={drag?.type === "slot" ? "tray droppable" : "tray"}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDropTray}
        >
          <div className="tray-head">
            {tray.length > 0 ? `${tray.length} chosen not in the album — drag into a slot` : "All chosen photos are in the album ✓"}
            {drag?.type === "slot" && <span className="tray-drop-hint"> · drop here to remove</span>}
          </div>
          <div className="tray-strip">
            {tray.map((p) => (
              <div
                key={p.uuid}
                className="tray-thumb"
                draggable
                onDragStart={() => setDrag({ type: "tray", uuid: p.uuid })}
                onDragEnd={() => setDrag(null)}
                title={`Day ${p.dayIndex}`}
              >
                <img src={thumbUrl(slug, p.uuid)} loading="lazy" alt="" draggable={false} />
                <button
                  className="tray-remove"
                  onClick={(e) => { e.stopPropagation(); setConfirmRemove(p.uuid); }}
                  title="Remove from chosen"
                  aria-label="Remove from chosen"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {confirmRemove && (
        <div className="modal-overlay" onClick={() => setConfirmRemove(null)}>
          <div className="modal sm" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setConfirmRemove(null)}>✕</button>
            <h2>Remove from chosen?</h2>
            <p className="muted">
              It leaves the tray (un-chosen). The photo stays in your library and can be chosen again anytime.
            </p>
            <div className="dupe-actions">
              <button className="btn-danger" onClick={() => { patchPhoto(confirmRemove, { chosen: false }); setConfirmRemove(null); }}>
                Remove
              </button>
              <button className="btn-ghost dark" onClick={() => setConfirmRemove(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SideView({
  sheetIndex,
  side,
  slots,
  setDrag,
  onDropSlot,
  patchPhoto,
}: {
  sheetIndex: number;
  side: Side;
  slots: (string | null)[];
  setDrag: (d: DragData | null) => void;
  onDropSlot: (ref: SlotRef) => void;
  patchPhoto: (uuid: string, patch: { caption: string }) => void;
}) {
  const { slug, photosByUuid, project, setProject } = useApp();
  const sideLabel = side === "front" ? "Front" : "Back";

  const removeSlot = (pos: 0 | 1) =>
    setProject((p) => ({ ...p, album: { sheets: setSlot(p.album.sheets, { sheet: sheetIndex, side, pos }, null) } }));

  return (
    <div className={`side side-${side}`}>
      <div className="side-label">{sideLabel}</div>
      <div className="side-inner">
        <div className="pockets">
          {([0, 1] as (0 | 1)[]).map((pos) => {
            const uuid = slots[pos];
            const photo = uuid ? photosByUuid.get(uuid) : null;
            const ref: SlotRef = { sheet: sheetIndex, side, pos };
            return (
              <div
                key={pos}
                className={uuid ? "pocket filled" : "pocket"}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDropSlot(ref)}
              >
                {photo ? (
                  <div
                    className="pocket-photo"
                    draggable
                    onDragStart={() => setDrag({ type: "slot", ref })}
                    onDragEnd={() => setDrag(null)}
                  >
                    <img src={thumbUrl(slug, uuid!)} loading="lazy" alt="" draggable={false} />
                    <button className="pocket-remove" onClick={() => removeSlot(pos)} title="Remove from slot">
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="pocket-empty">
                    <span>{pos === 0 ? "top" : "bottom"}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="ruled">
          {([0, 1] as (0 | 1)[]).map((pos) => {
            const uuid = slots[pos];
            const cap = uuid ? project.photos[uuid]?.caption || "" : "";
            return (
              <div className="ruled-block" key={pos}>
                {uuid ? (
                  <textarea
                    className="ruled-text"
                    placeholder={pos === 0 ? "caption for the top photo…" : "caption for the bottom photo…"}
                    value={cap}
                    onChange={(e) => patchPhoto(uuid, { caption: e.target.value })}
                  />
                ) : (
                  <div className="ruled-empty" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
