import { useEffect, useRef, useState } from "react";

// carrega a IFrame API do YouTube uma única vez
function loadYT(): Promise<any> {
  const w = window as any;
  if (w.YT && w.YT.Player) return Promise.resolve(w.YT);
  return new Promise((resolve) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(w.YT);
    };
    if (!document.getElementById("yt-iframe-api")) {
      const s = document.createElement("script");
      s.id = "yt-iframe-api";
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    }
  });
}

export function Music({ videoId }: { videoId: string }) {
  const playerRef = useRef<any>(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [hint, setHint] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadYT().then((YT) => {
      if (cancelled) return;
      playerRef.current = new YT.Player("yt-music-player", {
        videoId,
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, loop: 1, playlist: videoId, modestbranding: 1, rel: 0 },
        events: {
          onReady: () => setReady(true),
          onStateChange: (e: any) => setPlaying(e.data === 1 /* YT.PlayerState.PLAYING */),
        },
      });
    });
    return () => {
      cancelled = true;
      try { playerRef.current?.destroy?.(); } catch {}
    };
  }, []);

  const toggle = () => {
    setHint(false);
    const p = playerRef.current;
    if (!p) return;
    if (playing) p.pauseVideo();
    else {
      p.setVolume?.(55);
      p.playVideo();
    }
  };

  return (
    <>
      {/* player oculto */}
      <div className="yt-hidden"><div id="yt-music-player" /></div>

      <button className={`music-btn ${playing ? "on" : ""}`} onClick={toggle} disabled={!ready} title={playing ? "Pause music" : "Play music"}>
        {playing ? (
          <span className="eq" aria-hidden="true"><i /><i /><i /><i /></span>
        ) : (
          <span className="music-note" aria-hidden="true">♪</span>
        )}
      </button>
      {hint && ready && !playing && <span className="music-hint">tap to listen 🎵</span>}
    </>
  );
}
