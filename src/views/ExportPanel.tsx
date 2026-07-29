import { useMemo, useState } from "react";
import { useApp } from "../App";
import { api } from "../lib/api";
import { getSlot, iterateSlots, slotName } from "../lib/album";

export function ExportPanel({ onClose }: { onClose: () => void }) {
  const { slug, project, photosByUuid } = useApp();
  const [command, setCommand] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [finishLog, setFinishLog] = useState<string | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [padColor, setPadColor] = useState("FFFFFF");

  const BG_OPTIONS = [
    { hex: "FFFFFF", label: "White" },
    { hex: "FBF6EA", label: "Cream" },
    { hex: "12307A", label: "Deep blue" },
    { hex: "000000", label: "Black" },
  ];

  const items = useMemo(() => {
    const out: any[] = [];
    for (const ref of iterateSlots(project.album.sheets.length)) {
      const uuid = getSlot(project.album.sheets, ref);
      if (!uuid) continue;
      const ph = photosByUuid.get(uuid);
      out.push({
        uuid,
        name: slotName(ref, ph?.dayIndex),
        caption: project.photos[uuid]?.caption || "",
        dayIndex: ph?.dayIndex,
        date: ph?.date,
        folha: ref.sheet + 1,
        side: ref.side,
        slot: ref.pos + 1,
        width: ph?.width || 0,
        height: ph?.height || 0,
      });
    }
    return out;
  }, [project, photosByUuid]);

  const vertCount = useMemo(() => items.filter((it) => it.height > it.width && it.width > 0).length, [items]);

  const prepare = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.exportPrepare(slug, items, { matteVertical: true, padColor });
      setCommand(r.command);
      setCount(r.count);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.exportFinish(slug);
      setFinishLog(r.log);
    } catch (e: any) {
      setErr(e.body?.stderr || e.body?.log || e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const backup = async () => {
    const r = await api.backup(slug);
    setBackupMsg(`Backup saved to ${r.file}`);
  };

  const copy = () => {
    if (command) navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>Export for printing</h2>
        <p className="muted">
          {items.length} photo(s) placed in the album. This downloads the originals in high resolution and names each
          print file by sheet, side and slot.
        </p>

        {vertCount > 0 && (
          <div className="matte-box">
            <div className="matte-title">
              🖼️ {vertCount} vertical photo(s) will be <b>matted onto a horizontal background</b> (nothing is cropped).
            </div>
            <div className="matte-colors">
              <span className="muted">Background color:</span>
              {BG_OPTIONS.map((c) => (
                <button
                  key={c.hex}
                  className={padColor === c.hex ? "swatch on" : "swatch"}
                  style={{ background: `#${c.hex}` }}
                  onClick={() => setPadColor(c.hex)}
                  title={c.label}
                >
                  {padColor === c.hex ? "✓" : ""}
                </button>
              ))}
              <span className="matte-colorname">{BG_OPTIONS.find((c) => c.hex === padColor)?.label}</span>
            </div>
          </div>
        )}

        <ol className="steps">
          <li className={command ? "step done" : "step"}>
            <div className="step-head">
              <span className="step-n">1</span> Prepare the list
            </div>
            <button className="btn-primary" onClick={prepare} disabled={busy || items.length === 0}>
              {command ? "List ready ✓" : "Prepare"}
            </button>
          </li>

          {command && (
            <li className="step">
              <div className="step-head">
                <span className="step-n">2</span> Run in your terminal ({count} photos, downloads originals from iCloud)
              </div>
              <div className="cmd">
                <code>{command}</code>
                <button className="btn-copy" onClick={copy}>{copied ? "copied ✓" : "copy"}</button>
              </div>
            </li>
          )}

          {command && (
            <li className="step">
              <div className="step-head">
                <span className="step-n">3</span> Finish (rename + generate captions)
              </div>
              <button className="btn-primary" onClick={finish} disabled={busy}>
                I ran it — finish
              </button>
              {finishLog && (
                <pre className="finish-log">{finishLog}
{"\n"}Files in: trips/{slug}/export/  ·  Captions: captions.html</pre>
              )}
            </li>
          )}
        </ol>

        {err && <p className="err-msg">Error: {err}</p>}

        <div className="modal-foot">
          <button className="btn-ghost" onClick={backup}>Back up progress</button>
          {backupMsg && <span className="muted">{backupMsg}</span>}
        </div>
      </div>
    </div>
  );
}
